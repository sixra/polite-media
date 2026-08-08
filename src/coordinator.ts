import { connectionAllowsMedia, mediaQuery, motionAllowed } from './env.js';
import { revealWhenPainted } from './reveal.js';
import { isUnusable, manageSources, type SourceManager } from './sources.js';

/**
 * The single arbiter of what plays. Nothing outside this module calls `play()`
 * or `pause()`, so "why is this video running" always has one answer.
 */

export interface Config {
  /** How far outside the viewport a video may start preparing. */
  rootMargin: string;
  /**
   * Anti-flicker debounce for a video wobbling at the viewport edge. Not a
   * window in which offscreen video is meant to keep decoding: leaving the
   * viewport should read as stopping immediately.
   */
  pauseGraceMs: number;
  /**
   * Which viewports count as small. Configurable because 767px is one project's
   * breakpoint, not a fact about phones.
   */
  smallViewport: string;
  /**
   * What a small viewport is allowed to do.
   *
   * `arbitrate` lets one video play at a time. Phones have far less decode
   * headroom than desktops -- three concurrent H.264 streams while compositing
   * drops frames badly on real hardware -- but a grid of cards whose content
   * *is* the video still needs to move.
   *
   * `poster` never starts a video there at all, spending nothing on data or
   * battery. No standards or platform source recommends either; the default is
   * `arbitrate` only because that is the one with device testing behind it.
   */
  mobile: 'arbitrate' | 'poster';
  /**
   * How much more visible a rival must be before it takes the single slot.
   * Without it, a carousel's peeking neighbour flaps the slot back and forth.
   */
  hysteresis: number;
  /**
   * Visible fraction, 0 to 1, at or below which a video stops.
   *
   * The default 0 means "only once it is entirely gone", which is the least
   * surprising rule: a video still on screen but frozen reads as broken, not as
   * considerate. Raise it to buy back decode time on a long page, at the cost of
   * stopping things the viewer can still see.
   *
   * Measured against the root *expanded by `rootMargin`*, verified in Chromium:
   * a 100px element 20px below the fold reports 0.30 at a 50px margin, not 0. So
   * with the defaults a video keeps playing until it is fully 50px past the
   * viewport edge.
   */
  pauseBelow: number;
}

const defaults: Config = {
  rootMargin: '50px',
  pauseGraceMs: 400,
  smallViewport: '(max-width: 767px)',
  mobile: 'arbitrate',
  hysteresis: 0.15,
  pauseBelow: 0,
};

let config: Config = { ...defaults };

/**
 * Call before the first `register`. `rootMargin` is read when the single
 * IntersectionObserver is constructed, which happens on first registration, so
 * changing it afterwards has no effect until every video is unregistered.
 */
export function configure(patch: Partial<Config>): void {
  validate(patch);
  config = { ...config, ...patch };
}

/**
 * Checked here rather than left to the platform, because of *where* the platform
 * complains. An out-of-range fraction or a malformed `rootMargin` does throw --
 * verified in Chromium, a RangeError and a SyntaxError respectively -- but only
 * inside the IntersectionObserver constructor, which this library builds at the
 * first `register()`. That puts a stack trace on library code, arbitrarily far
 * from the `configure()` call that actually caused it.
 *
 * `smallViewport` is the one that cannot be checked. An invalid media query does
 * not throw and does not normalise to something recognisable: Chromium echoes
 * the malformed text straight back through `MediaQueryList.media` and simply
 * never matches. So `smallViewport: '(max-width: 767)'`, one missing unit, means
 * arbitration silently never engages and phones behave like desktops. Only the
 * obviously empty case is caught; the rest is a documentation problem.
 */
function validate(patch: Partial<Config>): void {
  for (const key of ['pauseBelow', 'hysteresis'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError(`polite-media: ${key} must be a fraction between 0 and 1, got ${value}`);
    }
  }

  if (patch.pauseGraceMs !== undefined) {
    if (!Number.isFinite(patch.pauseGraceMs) || patch.pauseGraceMs < 0) {
      throw new RangeError(
        `polite-media: pauseGraceMs must be a non-negative number of milliseconds, got ${patch.pauseGraceMs}`
      );
    }
  }

  if (patch.smallViewport !== undefined && patch.smallViewport.trim() === '') {
    throw new SyntaxError('polite-media: smallViewport must be a media query, got an empty string');
  }
}

export interface RegisterOptions {
  /**
   * Hold this video out of the arbiter's reach until the promise settles. A hero
   * at scroll-top is reported visible in the observer's very first batch, so
   * without a gate it starts before whatever the page is waiting on (a splash
   * screen, a consent dialog) has finished.
   */
  until?: Promise<unknown>;
  /**
   * Element to observe instead of the video, for when the video is absolutely
   * positioned inside a wrapper that carries the real layout box.
   */
  observe?: Element;
}

interface Entry {
  video: HTMLVideoElement;
  target: Element;
  /** Element carrying reveal state, so CSS can drive poster and video together. */
  host: Element;
  /** How much of the target is visible; 0 when offscreen. */
  ratio: number;
  /** Held out of arbitration until `until` settles. */
  gated: boolean;
  /** Playback has been set up at least once; distinguishes "start" from "resume". */
  started: boolean;
  /** One pending play retry at a time, rather than a listener per rejection. */
  retryArmed: boolean;
  sources?: SourceManager;
  pauseTimer?: ReturnType<typeof setTimeout>;
  cancelReveal?: () => void;
  /** Removes every listener this entry owns, in one call. */
  listeners: AbortController;
}

/**
 * One record per video rather than parallel maps keyed by video. Teardown then
 * has exactly one place to forget, which is the failure mode that leaks timers
 * and observers on a client-router site.
 */
const entries = new Map<HTMLVideoElement, Entry>();
/** Reverse index for the observer callback, which reports targets, not videos. */
const byTarget = new Map<Element, Entry>();

let observer: IntersectionObserver | null = null;
let lifecycleAttached = false;

/**
 * Sticky, and checked on every reconcile rather than applied once. An
 * arbitration pass resurrecting a video the user deliberately stopped is the
 * easy bug here, and the one that would make the control useless.
 */
let userPaused = false;

/** Every reason a video may not start. The poster covers all of them. */
function videoAllowed(): boolean {
  return motionAllowed() && connectionAllowsMedia();
}

function getObserver(): IntersectionObserver {
  observer ??= new IntersectionObserver(
    (records) => {
      for (const record of records) {
        const entry = byTarget.get(record.target);
        if (entry) entry.ratio = record.isIntersecting ? record.intersectionRatio : 0;
      }
      reconcile();
    },
    { rootMargin: config.rootMargin, threshold: thresholds() }
  );
  return observer;
}

/**
 * Ratio thresholds rather than only the 0 boundary, so a turn can be handed from
 * one video to the next as they cross, not just when one fully leaves.
 *
 * `pauseBelow` has to be in this list. The observer reports *only* at threshold
 * crossings, so a pauseBelow of 0.4 with a fixed ladder would actually take
 * effect at 0.25, the nearest crossing the browser bothers to report, and the
 * setting would silently mean something other than what it says.
 */
function thresholds(): number[] {
  const ladder = [0, 0.1, 0.25, 0.5, 0.75, 1, config.pauseBelow];
  return [...new Set(ladder)].sort((a, b) => a - b);
}

function cancelPause(entry: Entry): void {
  if (entry.pauseTimer !== undefined) {
    clearTimeout(entry.pauseTimer);
    entry.pauseTimer = undefined;
  }
}

function pauseNow(entry: Entry): void {
  cancelPause(entry);
  entry.video.pause();
}

function pauseAfterGrace(entry: Entry): void {
  if (entry.pauseTimer !== undefined) return;
  entry.pauseTimer = setTimeout(() => {
    entry.pauseTimer = undefined;
    pauseNow(entry);
  }, config.pauseGraceMs);
}

/**
 * Reveal state lives on the container, not the `<video>`, because the poster is
 * an earlier sibling: an attribute on the video cannot style what precedes it,
 * while one on the shared box drives both layers with descendant selectors.
 */
/**
 * Events, so a host can react without observing attributes or forking. Bubbling
 * because the useful listener is usually on a container, not on each video.
 */
function emit(entry: Entry, type: 'ready' | 'failed'): void {
  entry.video.dispatchEvent(new CustomEvent(`polite-video:${type}`, { bubbles: true }));
}

function markReady(entry: Entry): void {
  entry.host.setAttribute('data-polite-ready', '');
  emit(entry, 'ready');
}

function clearReady(entry: Entry): void {
  entry.cancelReveal?.();
  entry.cancelReveal = undefined;
  entry.host.removeAttribute('data-polite-ready');
}

function armReveal(entry: Entry): void {
  entry.cancelReveal?.();
  entry.cancelReveal = revealWhenPainted(entry.video, () => markReady(entry));
}

/**
 * Nothing decodable is left. The poster stays and the host is told, rather than
 * leaving a permanently black box and no way to know about it.
 */
function markFailed(entry: Entry): void {
  clearReady(entry);
  entry.host.setAttribute('data-polite-failed', '');
  emit(entry, 'failed');
  unregister(entry.video);
}

/**
 * `play()` rejects for reasons that are recoverable rather than final: autoplay
 * blocked until a gesture, iOS Low Power Mode, or nothing buffered yet under
 * `preload="none"`. reconcile() re-attempts on every observer batch and on the
 * first pointerdown, which covers the first two. It cannot cover the third -- a
 * video sitting still in view produces no further batches -- so `canplay` is
 * the one listener that has to exist.
 */
function tryPlay(entry: Entry): void {
  // Autoplay is only ever permitted for muted media, and this library exists for
  // decorative background video. Setting it rather than trusting the attribute
  // also covers markup where the property was changed after parse.
  entry.video.muted = true;
  void entry.video.play().catch(() => {
    if (entry.retryArmed) return;
    entry.retryArmed = true;
    entry.video.addEventListener(
      'canplay',
      () => {
        entry.retryArmed = false;
        reconcile();
      },
      { once: true, signal: entry.listeners.signal }
    );
  });
}

function onMediaError(entry: Entry): void {
  // Only "this file is unusable" advances the list. See isUnusable: the abort
  // that our own src assignment triggers must not consume a candidate.
  if (!isUnusable(entry.video.error)) return;
  clearReady(entry);
  if (!entry.sources?.advance()) {
    markFailed(entry);
    return;
  }
  armReveal(entry);
  tryPlay(entry);
}

function start(entry: Entry): void {
  entry.started = true;
  // Built here rather than at registration so `<source media>` is evaluated
  // against the viewport as it is when the video actually starts, which for a
  // lazy video can be long after the page loaded.
  entry.sources = manageSources(entry.video);
  entry.video.addEventListener('error', () => onMediaError(entry), {
    signal: entry.listeners.signal,
  });

  if (!entry.sources.select()) {
    markFailed(entry);
    return;
  }

  armReveal(entry);
  tryPlay(entry);
}

/**
 * Which of the visible videos may actually run.
 *
 * On a large viewport, all of them: a bento grid of video cards is meant to
 * move. The restriction exists because phones have far less decode headroom.
 */
function pickWinners(candidates: Entry[]): Set<Entry> {
  if (!mediaQuery(config.smallViewport).matches) return new Set(candidates);
  if (config.mobile === 'poster') return new Set();
  if (candidates.length < 2) return new Set(candidates);

  const leader = candidates.reduce((best, entry) => (entry.ratio > best.ratio ? entry : best));
  // The incumbent keeps the slot unless a rival is *clearly* more visible, so a
  // carousel's peeking neighbour cannot flap it back and forth.
  const holder = candidates.find((entry) => entry.started && !entry.video.paused);
  const keepsSlot = holder && holder.ratio >= leader.ratio - config.hysteresis;

  return new Set([keepsSlot ? holder : leader]);
}

export function reconcile(): void {
  // Reduced motion or a metered connection retracts the reveal as well as
  // stopping playback. Pausing alone would leave a frozen frame on screen, which
  // is worse than the poster it replaced.
  if (!videoAllowed()) {
    for (const entry of entries.values()) {
      if (!entry.started) continue;
      pauseNow(entry);
      clearReady(entry);
      entry.started = false;
    }
    return;
  }

  // A user pause is deliberately *not* the same as a gate closing: the frame
  // they paused on stays visible, because that is what pausing means. Only the
  // automatic gates above retract the reveal back to the poster.
  if (userPaused) {
    for (const entry of entries.values()) if (entry.started) pauseNow(entry);
    return;
  }

  // Eligible to play at all. Anything at or below pauseBelow is out of the
  // running before arbitration even looks at it.
  const eligible = [...entries.values()].filter((e) => !e.gated && e.ratio > config.pauseBelow);
  const winners = pickWinners(eligible);
  const wasEligible = new Set(eligible);

  // Snapshot: start() can fail and unregister mid-loop, and mutating the map
  // being iterated is a trap even where the language permits it.
  for (const entry of [...entries.values()]) {
    if (winners.has(entry)) {
      cancelPause(entry);
      if (!entry.started) start(entry);
      else if (entry.video.paused) tryPlay(entry);
    } else if (entry.started) {
      // Which pause it gets turns on *why* it lost, not on how visible it is.
      //
      // Still eligible but not a winner means arbitration handed its turn to
      // another video, so it stops immediately: two videos decoding through a
      // handover is the exact contention arbitration exists to prevent.
      //
      // No longer eligible means it simply fell out of view, or below
      // pauseBelow, with nothing taking its place. That gets the grace period,
      // because it is the wobble case: a scroll nudges a video past the
      // boundary and straight back, and stopping instantly would stutter.
      if (wasEligible.has(entry)) pauseNow(entry);
      else pauseAfterGrace(entry);
    }
  }
}

/**
 * Re-ask the arbiter on the events that produce no observer batch of their own.
 * Without these a video comes back frozen: scripts do not re-run on a bfcache
 * restore, and mobile browsers pause video while the tab is hidden then leave it
 * paused on return. The one-shot pointerdown covers autoplay blocked until a
 * first gesture, and reduced-motion is watched so the gate is honoured the
 * moment it flips rather than at the next scroll.
 */
function onPageShow(event: PageTransitionEvent): void {
  if (event.persisted) reconcile();
}

function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') reconcile();
}

function onReconcileEvent(): void {
  reconcile();
}

function motionQuery(): MediaQueryList {
  return mediaQuery('(prefers-reduced-motion: reduce)');
}

/**
 * Delegated so the control can be added, removed or re-rendered at any time
 * without re-binding, and so the host owns the markup completely.
 */
function onPauseControlClick(event: Event): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (!target.closest('[data-polite-pause]')) return;
  if (userPaused) resumeAll();
  else pauseAll();
}

function attachLifecycle(): void {
  if (lifecycleAttached) return;
  lifecycleAttached = true;
  window.addEventListener('pageshow', onPageShow);
  document.addEventListener('visibilitychange', onVisibilityChange);
  document.addEventListener('pointerdown', onReconcileEvent, { once: true, passive: true });
  document.addEventListener('click', onPauseControlClick);
  motionQuery().addEventListener('change', onReconcileEvent);
  // A viewport crossing the small/large boundary changes who is allowed to
  // play, so it has to re-run the arbiter just as scrolling does.
  mediaQuery(config.smallViewport).addEventListener('change', onReconcileEvent);
}

function detachLifecycle(): void {
  if (!lifecycleAttached) return;
  lifecycleAttached = false;
  window.removeEventListener('pageshow', onPageShow);
  document.removeEventListener('visibilitychange', onVisibilityChange);
  document.removeEventListener('pointerdown', onReconcileEvent);
  document.removeEventListener('click', onPauseControlClick);
  motionQuery().removeEventListener('change', onReconcileEvent);
  mediaQuery(config.smallViewport).removeEventListener('change', onReconcileEvent);
}

export function register(video: HTMLVideoElement, options: RegisterOptions = {}): void {
  if (entries.has(video)) return;

  const target = options.observe ?? video;
  const entry: Entry = {
    video,
    target,
    host: video.parentElement ?? video,
    ratio: 0,
    gated: options.until !== undefined,
    started: false,
    retryArmed: false,
    listeners: new AbortController(),
  };

  entries.set(video, entry);
  byTarget.set(target, entry);
  attachLifecycle();
  getObserver().observe(target);

  if (options.until) {
    const release = (): void => {
      // It may have been unregistered while the gate was open.
      if (entries.get(video) !== entry) return;
      entry.gated = false;
      reconcile();
    };
    // Settled, not fulfilled: a rejected gate should still release the video
    // rather than strand it on its poster forever.
    //
    // `then(release, release)` rather than `finally(release)` because `finally`
    // forwards the rejection to the promise it returns, which nothing here
    // awaits -- so a host passing a gate that rejects would get an unhandled
    // rejection reported against a path this library documents as supported.
    void options.until.then(release, release);
  }
}

export function unregister(video: HTMLVideoElement): void {
  const entry = entries.get(video);
  if (!entry) return;

  cancelPause(entry);
  entry.cancelReveal?.();
  entry.listeners.abort();
  observer?.unobserve(entry.target);
  entries.delete(video);
  byTarget.delete(entry.target);

  // Releasing the observer and listeners on the last video is what stops a
  // client-router site accumulating one of each per page visited.
  if (entries.size === 0) {
    observer?.disconnect();
    observer = null;
    detachLifecycle();
  }
}

/**
 * Stops every managed video and keeps them stopped.
 *
 * WCAG 2.2.2 applies to content that moves automatically, runs for more than
 * five seconds, and sits alongside other content -- which a looping background
 * video does. Honouring `prefers-reduced-motion` is necessary but, per the W3C
 * understanding document, is not listed as satisfying the criterion, so a
 * mechanism the user can actually operate has to exist.
 *
 * The host supplies the button and its styling; the library ships no markup and
 * no CSS for it. Any element carrying `data-polite-pause` toggles this.
 */
export function pauseAll(): void {
  userPaused = true;
  document.documentElement.setAttribute('data-polite-paused', '');
  reconcile();
}

export function resumeAll(): void {
  userPaused = false;
  document.documentElement.removeAttribute('data-polite-paused');
  reconcile();
}

/** Drops all state. For tests, and for a host tearing down the whole page. */
export function unregisterAll(): void {
  for (const video of [...entries.keys()]) unregister(video);
  config = { ...defaults };
  userPaused = false;
  document.documentElement.removeAttribute('data-polite-paused');
}

/** Internal view for tests. Not exported from the package entry point. */
export function inspect(): { tracked: number; observing: boolean; lifecycle: boolean } {
  return { tracked: entries.size, observing: observer !== null, lifecycle: lifecycleAttached };
}
