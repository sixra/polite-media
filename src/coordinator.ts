import { connectionAllowsMedia, mediaQuery, motionAllowed } from './env.js';
import { POLITE_VIDEO_FAILED, POLITE_VIDEO_READY, type PoliteVideoEventDetail } from './events.js';
import { revealWhenPainted } from './reveal.js';
import { isUnusable, manageSources, type SourceManager } from './sources.js';

/**
 * @module
 * The single arbiter of what plays. Nothing outside this module calls `play()`
 * or `pause()`, so "why is this video running" always has one answer.
 *
 * The `@module` tag matters: without it TypeScript attaches this preamble to the
 * first declaration below, and a consumer hovering that symbol gets a sentence
 * about internal call discipline instead of its own documentation.
 */

/**
 * Options for {@link configure}. Every field is optional; anything left out keeps
 * its default.
 *
 * All-optional deliberately. As a fully required interface this could not be used
 * for what a consumer naturally reaches for -- `const preset: ConfigureOptions =
 * { mobile: 'poster' }` -- and only the inline `configure({ ... })` form worked,
 * via contextual typing.
 */
export interface ConfigureOptions {
  /** How far outside the viewport a video may start preparing. */
  rootMargin?: string;
  /**
   * Anti-flicker debounce for a video wobbling at the viewport edge. Not a
   * window in which offscreen video is meant to keep decoding: leaving the
   * viewport should read as stopping immediately.
   */
  pauseGraceMs?: number;
  /**
   * Which viewports count as small. Configurable because 767px is one project's
   * breakpoint, not a fact about phones.
   */
  smallViewport?: string;
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
  mobile?: 'arbitrate' | 'poster';
  /**
   * How much more visible a rival must be before it takes the single slot.
   * Without it, a carousel's peeking neighbour flaps the slot back and forth.
   */
  hysteresis?: number;
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
  pauseBelow?: number;
}

/**
 * Every field resolved. Internal: a caller never has to supply all six, which is
 * what {@link ConfigureOptions} is for.
 */
type ResolvedConfig = Required<ConfigureOptions>;

const defaults: ResolvedConfig = {
  rootMargin: '50px',
  pauseGraceMs: 400,
  smallViewport: '(max-width: 767px)',
  mobile: 'arbitrate',
  hysteresis: 0.15,
  pauseBelow: 0,
};

let config: ResolvedConfig = { ...defaults };

/**
 * Settings captured when the observer and the lifecycle listeners are built, at
 * the first `register()`. Patching one later is rejected rather than ignored,
 * because "ignored" is not what actually happened:
 *
 * - `pauseBelow` half-applies. Eligibility reads it live while the threshold
 *   ladder was fixed at construction, so a late 0.4 takes effect at 0.25, the
 *   nearest crossing the observer still reports. That is the exact silent lie
 *   `thresholds()` exists to prevent, reached through a second door.
 * - `smallViewport` used to strand a listener. `mediaQuery` memoises by string,
 *   so detaching would resolve a different MediaQueryList than attaching did.
 * - `rootMargin` is genuinely inert, and is grouped here so the rule is one rule.
 */
const CONSTRUCTION_TIME_KEYS = ['rootMargin', 'pauseBelow', 'smallViewport'] as const;

/**
 * Call before the first `register`.
 *
 * Anything read on every reconcile -- `pauseGraceMs`, `mobile`, `hysteresis` --
 * can be changed at any time and takes effect on the next pass. The three keys
 * in {@link CONSTRUCTION_TIME_KEYS} cannot, and throw if patched while videos
 * are registered. Unregister everything first, or configure earlier.
 */
export function configure(patch: ConfigureOptions): void {
  validate(patch);

  if (observer !== null) {
    const late = CONSTRUCTION_TIME_KEYS.filter((key) => patch[key] !== undefined);
    if (late.length > 0) {
      throw new Error(
        `polite-media: ${late.join(', ')} must be configured before the first register(); ` +
          'they are read when the observer is built. Unregister everything first.'
      );
    }
  }

  config = { ...config, ...patch };
}

/**
 * Checked here because for two of the four the platform never complains at all.
 *
 * Only `pauseBelow` and `rootMargin` reach a platform API, through the threshold
 * ladder and the observer options. Chromium rejects both -- a RangeError outside
 * 0..1, a TypeError for NaN or Infinity, a SyntaxError for a malformed margin --
 * but not until the IntersectionObserver constructor runs at the first
 * `register()`, arbitrarily far from the `configure()` call responsible.
 *
 * `hysteresis` and `pauseGraceMs` never leave this module: one is arithmetic in
 * `pickWinners`, the other a `setTimeout` argument. Nothing would reject an
 * absurd value for either, so these checks are not relocating an error, they are
 * the only error there is.
 *
 * `smallViewport` is the one that cannot be checked. An invalid media query does
 * not throw and does not normalise to something recognisable: Chromium echoes
 * the malformed text straight back through `MediaQueryList.media` and simply
 * never matches. So `smallViewport: '(max-width: 767)'`, one missing unit, means
 * arbitration silently never engages and phones behave like desktops. Only the
 * obviously empty case is caught; the rest is a documentation problem.
 */
function validate(patch: ConfigureOptions): void {
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

  // rootMargin is handed to the platform to parse rather than checked by hand:
  // the accepted grammar is CSS margin syntax and reimplementing it here would
  // be a second, worse parser that drifts. Constructing a throwaway observer
  // raises the browser's own SyntaxError now, at the configure() call, instead
  // of at the first register().
  //
  // Skipped where IntersectionObserver does not exist, so that importing this
  // module and configuring it under SSR or in a Node test still works.
  if (patch.rootMargin !== undefined && typeof IntersectionObserver === 'function') {
    new IntersectionObserver(() => {}, { rootMargin: patch.rootMargin }).disconnect();
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
  /**
   * The one-time machinery -- source list and error listener -- has been built.
   *
   * Separate from `started` because the gates flip that one back and forth: a
   * reduced-motion or Save-Data close sets `started = false`, and reopening calls
   * `start()` again. Conflating the two rebuilt the candidate list on every
   * cycle, rewinding to a source already known to be undecodable and attaching a
   * second error listener each time.
   */
  prepared: boolean;
  /** Currently running. Flips whenever a gate opens or closes. */
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
/** Owns every page-level listener, so teardown is one abort rather than six removes. */
let lifecycle: AbortController | null = null;
/** True while a pending gesture listener is waiting to re-attempt a blocked play. */
let gestureArmed = false;

/**
 * Sticky, and checked on every reconcile rather than applied once. An
 * arbitration pass resurrecting a video the user deliberately stopped is the
 * easy bug here, and the one that would make the control useless.
 */
let userPaused = false;

/**
 * The two environment gates. Not every reason a video may be stopped -- the
 * `until` gate, `mobile: 'poster'`, `pauseBelow` and a user pause are decided in
 * reconcile() -- but the two that mean "not on this device, right now", and the
 * only two that retract an existing reveal back to the poster.
 */
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
 * Events, so a host can react without observing attributes or forking. Bubbling
 * because the useful listener is usually on a container, not on each video.
 */
function emit(entry: Entry, type: 'ready' | 'failed'): void {
  entry.video.dispatchEvent(
    new CustomEvent<PoliteVideoEventDetail>(
      type === 'ready' ? POLITE_VIDEO_READY : POLITE_VIDEO_FAILED,
      { bubbles: true, detail: { video: entry.video } }
    )
  );
}

/**
 * Reveal state goes on the container, not the `<video>`, because the poster is an
 * earlier sibling: an attribute on the video cannot style what precedes it, while
 * one on the shared box drives both layers with descendant selectors.
 */
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
 * Waits for the next user gesture, then re-runs the arbiter.
 *
 * This is the only rung that survives a *persistent* refusal. Measured in
 * Chromium: once `readyState` is 4, neither `canplay` nor `loadeddata` fires
 * again -- 0 of each across three rejections -- so a video sitting saturated and
 * stationary in view has no media event left to wake it, and produces no further
 * observer batches either.
 *
 * Re-armed per failure rather than bound once at startup. A single
 * `{ once: true }` listener is spent by the first tap anywhere on the document,
 * which is usually long before the video that needs it ever became eligible.
 */
function armGestureRetry(): void {
  if (gestureArmed || !lifecycle) return;
  gestureArmed = true;
  document.addEventListener(
    'pointerdown',
    () => {
      gestureArmed = false;
      reconcile();
    },
    { once: true, passive: true, signal: lifecycle.signal }
  );
}

/**
 * `play()` rejects for reasons that are recoverable rather than final: autoplay
 * blocked until a gesture, iOS Low Power Mode, or nothing buffered yet under
 * `preload="none"`.
 *
 * Two rungs, because they cover different failures. `canplay` covers the
 * not-yet-buffered case, where the element is below `HAVE_FUTURE_DATA` and will
 * announce reaching it. The gesture covers a blocked autoplay policy, where the
 * element is already saturated and will announce nothing further.
 *
 * `loadeddata` is deliberately absent: it was measured as dead in the same state
 * as `canplay`, so adding it would only look like defence in depth.
 */
function tryPlay(entry: Entry): void {
  // Autoplay is permitted for muted media without any prior user engagement; the
  // other routes MDN lists all require engagement this library cannot assume. So
  // muted is the only condition it can rely on. Set rather than trusted, which
  // also covers markup whose property was changed after parse.
  entry.video.muted = true;
  void entry.video.play().catch(() => {
    armGestureRetry();

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

  if (!entry.prepared) {
    entry.prepared = true;
    // Built here rather than at registration so `<source media>` is evaluated
    // against the viewport as it is when the video actually starts, which for a
    // lazy video can be long after the page loaded. Built once, because
    // reassigning `src` restarts playback from frame 0 and `sources.ts` states
    // the invariant that the first choice sticks for the page's lifetime.
    entry.sources = manageSources(entry.video);
    entry.video.addEventListener('error', () => onMediaError(entry), {
      signal: entry.listeners.signal,
    });

    if (!entry.sources.select()) {
      markFailed(entry);
      return;
    }
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

/**
 * One controller for every page-level listener, rather than six hand-mirrored
 * add/remove pairs.
 *
 * This is not only tidier, it removes a leak. `detachLifecycle` used to call
 * `mediaQuery(config.smallViewport)` a second time, and `mediaQuery` memoises by
 * query string -- so a `configure({ smallViewport })` between register and
 * unregister meant detaching from a *different* MediaQueryList and stranding the
 * listener on the original. Aborting cannot re-resolve the config, so the whole
 * failure mode stops existing rather than being remembered about.
 */
function attachLifecycle(): void {
  if (lifecycle) return;
  lifecycle = new AbortController();
  const { signal } = lifecycle;

  window.addEventListener('pageshow', onPageShow, { signal });
  document.addEventListener('visibilitychange', onVisibilityChange, { signal });
  document.addEventListener('click', onPauseControlClick, { signal });
  motionQuery().addEventListener('change', onReconcileEvent, { signal });
  // A viewport crossing the small/large boundary changes who is allowed to
  // play, so it has to re-run the arbiter just as scrolling does.
  mediaQuery(config.smallViewport).addEventListener('change', onReconcileEvent, { signal });
}

function detachLifecycle(): void {
  lifecycle?.abort();
  lifecycle = null;
  gestureArmed = false;
}

/**
 * Keeps `aria-pressed` current on any pause control that already declares it.
 *
 * Maintained rather than added, because MDN describes two valid patterns and
 * setting it unconditionally would break one of them: `aria-pressed` is for a
 * control whose label stays constant, while a control that swaps its label
 * between "Pause" and "Play" should not carry it at all -- a screen reader would
 * announce "Play, pressed". Declaring the attribute in markup is the author
 * saying which pattern they are in.
 *
 * Restricted to a button role because that is the only role `aria-pressed` is
 * valid on, so this cannot emit ARIA that a validator would reject.
 */
function reflectPaused(): void {
  for (const control of document.querySelectorAll('[data-polite-pause][aria-pressed]')) {
    if (control.matches('button, [role="button"]')) {
      control.setAttribute('aria-pressed', String(userPaused));
    }
  }
}

/**
 * Starts managing a video: reveals it on its first genuinely painted frame,
 * plays it only while it is visible, falls through its `<source>` list when one
 * cannot be decoded, and stops it when a gate closes.
 *
 * The video and its poster must already share a box carrying `data-polite-media`
 * in the authored markup, and the video should be `muted loop playsinline
 * preload="none"`. Calling this twice on the same element is a no-op.
 *
 * @param video the element to manage
 * @param options see {@link RegisterOptions}
 */
export function register(video: HTMLVideoElement, options: RegisterOptions = {}): void {
  if (entries.has(video)) return;

  const target = options.observe ?? video;
  const entry: Entry = {
    video,
    target,
    host: video.parentElement ?? video,
    ratio: 0,
    gated: options.until !== undefined,
    prepared: false,
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

/**
 * Stops managing a video and releases everything it owned: the observer entry,
 * any pending pause timer, its listeners, and the page-level listeners once it
 * was the last one. Safe to call for a video that was never registered.
 */
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
 * no CSS for it. A `<button>` carrying `data-polite-pause` toggles this.
 *
 * It has to be a real `<button>`. The binding is a delegated `click`, and a
 * browser only synthesises that from Enter and Space for a native button, so a
 * `div[role="button"][tabindex="0"]` responds to a mouse and not to a keyboard.
 */
export function pauseAll(): void {
  userPaused = true;
  document.documentElement.setAttribute('data-polite-paused', '');
  reflectPaused();
  reconcile();
}

/** Lets playback resume, undoing {@link pauseAll}. */
export function resumeAll(): void {
  userPaused = false;
  document.documentElement.removeAttribute('data-polite-paused');
  reflectPaused();
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
  return { tracked: entries.size, observing: observer !== null, lifecycle: lifecycle !== null };
}
