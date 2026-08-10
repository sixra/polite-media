import { connectionAllowsMedia, mediaQuery, motionAllowed } from './env.js';
import {
  POLITE_PAUSE_CHANGE,
  POLITE_VIDEO_FAILED,
  POLITE_VIDEO_READY,
  type PolitePauseEventDetail,
  type PoliteVideoEventDetail,
} from './events.js';
import { revealWhenPainted } from './reveal.js';
import { isUnusable, manageSources, type SourceManager } from './sources.js';
import { resolveTargets, type Target } from './targets.js';

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
  /**
   * How far outside the viewport a video may start preparing.
   *
   * Defaults to `'0px'`, which is what makes every other threshold here honest:
   * `intersectionRatio` is measured against the root *including* this margin, so
   * any non-zero value inflates it. Measured on a 368px card with the old 50px
   * default, 25% on screen reported 0.39 and `pauseBelow: 0.25` actually stopped
   * the video at about 10% visible. The error also scales with element height,
   * so the same setting meant different things per video.
   *
   * Set it if you would rather a video be loading before it arrives, and read
   * the other thresholds as fractions of the expanded box when you do.
   */
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
  /**
   * Visible fraction, 0 to 1, a video must exceed before it may *start*.
   *
   * Together with {@link ConfigureOptions.pauseBelow} this is a band rather than
   * a line: start once mostly on screen, keep running until mostly gone. The gap
   * between the two is what makes a video sitting near the boundary stable, so
   * `pauseGraceMs` is left covering scroll wobble rather than doing the work.
   *
   * Defaults to 0, which collapses the band back to a single threshold and is
   * the behaviour with no surprises: anything visible plays. A value at or below
   * `pauseBelow` is simply no band rather than an error, since starting at a
   * lower visibility than you stop at is not a thing anyone can mean.
   *
   * **A tall video may never reach a high value.** `intersectionRatio` is a
   * fraction of the *element*, so a box taller than the viewport cannot be fully
   * intersecting. Measured in Chromium at a 953px viewport with the default
   * 50px margin: 1.5x viewport height peaks at 0.736 and 3x at 0.368, so a
   * `playAbove` of 0.75 would leave both of those permanently stopped. Keep it
   * comfortably under `(viewport + 2 x rootMargin) / tallest video`.
   */
  playAbove?: number;
  /**
   * How patient a video is about starting. Each rung is strictly more patient
   * than the last.
   *
   * - `'visible'` starts fetching the moment the video is on screen. Module
   *   scripts are deferred, so on a real page that lands inside the tail of the
   *   page's own loading and competes with it.
   * - `'page-loaded'` waits for `window`'s `load` event first. The default,
   *   because the poster is already on screen so nothing is missing while it
   *   waits, and it costs the page nothing.
   * - `'buffered'` additionally holds playback until the video can play through
   *   without stalling. For a thin connection, where the alternative is a video
   *   that plays while it is still arriving.
   *
   * `until` composes with this rather than replacing it: that is a gate for one
   * video (a splash, a consent dialog), this is a policy for all of them, and a
   * video waits for both.
   */
  startWhen?: 'visible' | 'page-loaded' | 'buffered';
}

/**
 * Every field resolved. Internal: a caller never has to supply all six, which is
 * what {@link ConfigureOptions} is for.
 */
type ResolvedConfig = Required<ConfigureOptions>;

const defaults: ResolvedConfig = {
  rootMargin: '0px',
  pauseGraceMs: 400,
  smallViewport: '(max-width: 767px)',
  mobile: 'arbitrate',
  hysteresis: 0.15,
  pauseBelow: 0.25,
  playAbove: 0,
  startWhen: 'page-loaded',
};

let config: ResolvedConfig = { ...defaults };

/**
 * Whether the page has finished loading.
 *
 * Read from `readyState` rather than latched by the `load` listener, because a
 * module imported *after* load -- a late script, or a client-side navigation --
 * would otherwise wait forever for an event that has already fired. The listener
 * exists only to re-run the arbiter when the moment arrives.
 */
function pageLoaded(): boolean {
  return document.readyState === 'complete';
}

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
/**
 * `HTMLMediaElement.HAVE_ENOUGH_DATA`. Inlined for the same reason reveal.ts
 * inlines its own: this module never touches `HTMLMediaElement`, which does not
 * exist in Node, and `test/node-import.test.ts` holds that line.
 */
const HAVE_ENOUGH_DATA = 4;

const CONSTRUCTION_TIME_KEYS = ['rootMargin', 'pauseBelow', 'playAbove', 'smallViewport'] as const;

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
  for (const key of ['pauseBelow', 'hysteresis', 'playAbove'] as const) {
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
   * This element has been in the document at least once.
   *
   * Gates the disconnected sweep, which means "the page discarded this" -- and an
   * element never in the page cannot have been discarded. Measured in Chromium:
   * observing a detached target reports it immediately with isIntersecting false,
   * so without this, registering a video before appending it is silently undone
   * on the very first batch.
   */
  seenConnected: boolean;
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
  /** Holding for `canplaythrough` under `startWhen: 'buffered'`. */
  awaitingBuffer?: boolean;
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
  const ladder = [0, 0.1, 0.25, 0.5, 0.75, 1, config.pauseBelow, config.playAbove];
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
 * A video taller than the viewport can never be fully intersecting, because
 * `intersectionRatio` is a fraction of the *element*. So a `playAbove` it cannot
 * reach means it never starts, and nothing else would ever say so -- the poster
 * simply stays. Measured in Chromium at a 953px viewport with a 50px margin,
 * 1.5x viewport height peaks at 0.736 and 3x at 0.368 (docs/findings.md).
 *
 * Checked against the ceiling rather than the observed ratio, so it fires on the
 * first report instead of waiting for a scroll that can never help.
 */
function warnIfStartUnreachable(entry: Entry): void {
  if (warnedUnreachable) return;

  const startAt = Math.max(config.playAbove, config.pauseBelow);
  if (startAt === 0) return;

  const height = entry.target.getBoundingClientRect().height;
  if (height === 0) return;

  // The root is the viewport grown by rootMargin on both edges. Parsed loosely:
  // a single length covers the shipped default and anything else only makes this
  // estimate conservative, which is the safe direction for a warning.
  const margin = Number.parseFloat(config.rootMargin) || 0;
  const ceiling = Math.min(1, (window.innerHeight + margin * 2) / height);
  if (ceiling > startAt) return;

  warnedUnreachable = true;
  console.warn(
    `polite-media: this video is too tall to reach playAbove (${startAt}); its highest ` +
      `possible visible fraction is about ${ceiling.toFixed(2)}, so it will never start. ` +
      'Lower playAbove, or make the box shorter than the viewport.',
    entry.video
  );
}

let warnedUnreachable = false;

let pauseControlChecked = false;

/**
 * The package's headline claim is that it never autoplays without a way to stop
 * it, and that is the one part it cannot deliver alone: the hook ships, the
 * button is the host's. Forgetting it is otherwise silent, which is how a real
 * project ended up with seven looping videos and no control.
 *
 * Deferred by WCAG 2.2.2's own five seconds -- the criterion only applies to
 * motion running longer than that -- which doubles as time for a control
 * rendered by script to arrive. Only looping video is asked about, since a short
 * clip that ends on its own is outside the criterion.
 */
function warnIfNoPauseControl(video: HTMLVideoElement): void {
  if (pauseControlChecked || !video.loop) return;
  pauseControlChecked = true;

  setTimeout(() => {
    // Nothing is moving any more, so there is nothing to demand a control for.
    if (entries.size === 0) return;
    if (document.querySelector('[data-polite-pause]')) return;

    console.warn(
      'polite-media: a looping video is playing with no way to stop it, which WCAG 2.2.2 ' +
        'requires. Add data-polite-pause to a <button>, or drive pauseAll() from your own control.'
    );
  }, 5000);
}

let warnedNothingToReveal = false;

/**
 * The one misconfiguration that is otherwise undetectable.
 *
 * `host` is derived as the video's parent, while video.css keys off
 * `data-polite-media` authored on that same element. Nothing forces the two to
 * agree, so putting the attribute one level too high leaves every rule
 * unmatched: the video is visible from the start, the poster never hides, and
 * the library looks installed while doing nothing at all.
 *
 * Checked here rather than at registration because stylesheets have certainly
 * applied by the time a video starts. The visual test is what separates a genuine
 * mistake from a host driving the reveal from its own CSS, which is supported and
 * must not be nagged -- and it covers visibility as well as opacity, because
 * hiding a video either way is a working setup and only one of them shows up in
 * the computed opacity. A warning that fires on correct code costs more than it
 * saves: it teaches people to ignore the one that matters.
 */
function warnIfNothingToReveal(entry: Entry): void {
  if (warnedNothingToReveal) return;
  if (entry.host.hasAttribute('data-polite-media')) return;

  const style = getComputedStyle(entry.video);
  if (style.opacity !== '1' || style.visibility !== 'visible') return;

  warnedNothingToReveal = true;
  console.warn(
    "polite-media: no data-polite-media on this video's parent, so revealing it does " +
      'nothing. Put the attribute there, or hide the video with your own CSS.',
    entry.video
  );
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
  // Held while the buffer fills under `startWhen: 'buffered'`. Guarded here
  // rather than at the call sites, because reconcile()'s resume path and both
  // retry rungs would otherwise start playback while it is still arriving.
  if (entry.awaitingBuffer) return;

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
    warnIfNothingToReveal(entry);
    warnIfNoPauseControl(entry.video);
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

  // `preload="none"` is what keeps the poster alone on first paint, but it also
  // means the browser buffers nothing until playback is asked for -- so waiting
  // for `canplaythrough` without promoting `preload` first would wait forever.
  // Measured: all three engines begin fetching on the promotion alone and reach
  // `canplaythrough` (docs/findings.md).
  if (
    config.startWhen === 'buffered' &&
    !entry.awaitingBuffer &&
    entry.video.readyState < HAVE_ENOUGH_DATA
  ) {
    entry.awaitingBuffer = true;
    entry.video.preload = 'auto';
    entry.video.addEventListener(
      'canplaythrough',
      () => {
        entry.awaitingBuffer = false;
        reconcile();
      },
      { once: true, signal: entry.listeners.signal }
    );
  }

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
  // A client-side router swaps the whole body and does not re-run module
  // scripts, so nothing calls unregister for the elements it discarded. Left
  // alone they sit in a strong Map keeping detached nodes alive, with the
  // observer still watching elements that can never intersect again. Removing a
  // target is itself reported, so this runs on the batch that caused it.
  for (const entry of [...entries.values()]) {
    if (entry.video.isConnected) entry.seenConnected = true;
    else if (entry.seenConnected) unregister(entry.video);
  }

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

  // Eligible to play at all, as a band rather than a line: a stopped video has
  // to clear `playAbove` to start, while a running one only has to stay above
  // `pauseBelow`. With the defaults equal this is one threshold and behaves
  // exactly as before; pull them apart and a video near the boundary can no
  // longer oscillate, because the two crossings are in different places.
  const startAt = Math.max(config.playAbove, config.pauseBelow);
  // Nothing may start before the page has finished loading unless the host has
  // asked for the eager rung. Checked here rather than at registration because
  // `load` arrives later and has to re-run the arbiter.
  const waitingForPage = config.startWhen !== 'visible' && !pageLoaded();

  const eligible = [...entries.values()].filter((e) => {
    if (e.gated || waitingForPage) return false;
    if (!e.started && e.ratio > 0) warnIfStartUnreachable(e);
    return e.ratio > (e.started ? config.pauseBelow : startAt);
  });
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

  if (!pageLoaded()) {
    window.addEventListener('load', () => reconcile(), { once: true, signal });
  }

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
    seenConnected: video.isConnected,
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

/** Anything that names one or more videos. See {@link Target}. */
export type VideoTarget = Target<HTMLVideoElement>;

/**
 * Registers every video a target names, so the common case is one line and
 * matches `revealImages` on the image side rather than being a second idea.
 *
 * `observe` is deliberately not accepted. Each observed element maps to exactly
 * one entry, so handing the same wrapper to several videos would silently
 * discard all but the last. Anything needing it, or a different gate per video,
 * goes through {@link register} one at a time.
 *
 * Idempotent, because `register` is: safe to call on every navigation of a
 * client-side router, where module scripts do not re-run.
 */
export function registerAll(
  target: VideoTarget,
  options: Omit<RegisterOptions, 'observe'> = {}
): void {
  for (const video of resolveTargets(target)) register(video, options);
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
/**
 * The only place `userPaused` changes, so the attribute, `aria-pressed` and the
 * event cannot drift apart. Returns early when nothing actually changed: calling
 * `pauseAll()` twice is idempotent, and announcing a transition that did not
 * happen would make a host's own state wrong.
 */
function setPaused(paused: boolean): void {
  if (userPaused === paused) return;
  userPaused = paused;

  if (paused) document.documentElement.setAttribute('data-polite-paused', '');
  else document.documentElement.removeAttribute('data-polite-paused');

  reflectPaused();
  reconcile();

  // Announced last, once the videos have actually stopped or restarted. Firing
  // before `reconcile()` would hand a listener reading `video.paused` the state
  // the event says has just ended.
  document.dispatchEvent(
    new CustomEvent<PolitePauseEventDetail>(POLITE_PAUSE_CHANGE, { detail: { paused } })
  );
}

export function pauseAll(): void {
  setPaused(true);
}

/** Lets playback resume, undoing {@link pauseAll}. */
export function resumeAll(): void {
  setPaused(false);
}

/** Drops all state. For tests, and for a host tearing down the whole page. */
export function unregisterAll(): void {
  for (const video of [...entries.keys()]) unregister(video);
  setPaused(false);
  config = { ...defaults };
  warnedNothingToReveal = false;
  warnedUnreachable = false;
  pauseControlChecked = false;
}

/** Internal view for tests. Not exported from the package entry point. */
export function inspect(): { tracked: number; observing: boolean; lifecycle: boolean } {
  return { tracked: entries.size, observing: observer !== null, lifecycle: lifecycle !== null };
}
