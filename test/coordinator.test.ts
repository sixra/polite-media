import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv } from '../src/env.js';
import {
  configure,
  inspect,
  registerAll,
  pauseAll,
  register,
  resumeAll,
  unregister,
  resetForTests,
  unregisterAll,
} from '../src/coordinator.js';

/**
 * happy-dom ships an IntersectionObserver but nothing drives it: there is no
 * layout, so it never reports anything. This fake captures the callback so a
 * test can say "this element is now 60% visible" directly, which is the only way
 * to exercise the arbiter deterministically.
 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  observed = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit
  ) {
    FakeIntersectionObserver.instances.push(this);
  }

  observe(el: Element): void {
    this.observed.add(el);
  }

  unobserve(el: Element): void {
    this.observed.delete(el);
  }

  disconnect(): void {
    this.disconnected = true;
    this.observed.clear();
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  /** Drives the callback as the browser would. */
  report(pairs: Array<[Element, number]>): void {
    const records = pairs.map(([target, ratio]) => ({
      target,
      isIntersecting: ratio > 0,
      intersectionRatio: ratio,
    })) as unknown as IntersectionObserverEntry[];
    this.callback(records, this as unknown as IntersectionObserver);
  }
}

/**
 * The observer that decides playback, identified by its threshold ladder rather
 * than by construction order. Two others can exist: the prefetch observer, and
 * the throwaway `configure()` builds to make the platform parse a rootMargin.
 */
function currentObserver(): FakeIntersectionObserver {
  const last = newest((o) => Array.isArray(o.options?.threshold));
  if (!last) throw new Error('no playback IntersectionObserver was constructed');
  return last;
}

/** The prefetch observer, which exists only when a rootMargin asked for one. */
function prefetchObserver(): FakeIntersectionObserver | undefined {
  return newest((o) => o.options?.threshold === 0 && o.options.rootMargin !== undefined);
}

function newest(
  match: (observer: FakeIntersectionObserver) => boolean
): FakeIntersectionObserver | undefined {
  return [...FakeIntersectionObserver.instances].reverse().find(match);
}

interface Harness {
  video: HTMLVideoElement;
  container: HTMLElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  /** Simulates the element reporting a media error with the given MediaError code. */
  fail: (code: number) => void;
}

interface HarnessOptions {
  /** Authored `src`. Defaults to a plausible one so the video has something to play. */
  src?: string | null;
  sources?: Array<{ src: string; type?: string; media?: string }>;
  canPlayType?: (type: string) => string;
}

/**
 * happy-dom has no media pipeline, so playback is mocked. `paused` is driven off
 * the mocks rather than hard-coded, because reconcile() branches on it and a
 * constant would quietly make the resume path untestable.
 */
function makeHarness(options: HarnessOptions = {}): Harness {
  const { src = '/authored.mp4', sources = [], canPlayType = () => 'probably' } = options;

  const container = document.createElement('div');
  // The documented markup, not decoration: the coordinator warns when the box a
  // video sits in carries no data-polite-media, so a fixture without it would
  // both misrepresent real usage and warn through every test in this file.
  container.setAttribute('data-polite-media', '');
  const poster = document.createElement('img');
  const video = document.createElement('video');
  // As the documented markup has it, and as every demo does. Without it the
  // element reports preload 'auto' from the start, and any assertion about the
  // promotion that starts buffering would hold before the promotion happened.
  video.setAttribute('preload', 'none');
  if (src !== null) video.setAttribute('src', src);
  for (const spec of sources) {
    const source = document.createElement('source');
    source.setAttribute('src', spec.src);
    if (spec.type) source.setAttribute('type', spec.type);
    if (spec.media) source.setAttribute('media', spec.media);
    video.append(source);
  }
  container.append(poster, video);
  document.body.append(container);

  // `load()` resets the element back to HAVE_NOTHING. Modelling that matters:
  // with a constant readyState the reveal re-arms and fires synchronously, which
  // would hide the gap between sources and make the retraction untestable.
  let readyState = 2;
  video.load = vi.fn(() => {
    readyState = 0;
  }) as unknown as HTMLVideoElement['load'];
  video.canPlayType = ((type: string) => canPlayType(type)) as HTMLVideoElement['canPlayType'];

  let paused = true;
  const play = vi.fn(() => {
    paused = false;
    return Promise.resolve();
  });
  const pause = vi.fn(() => {
    paused = true;
  });

  video.play = play as unknown as HTMLVideoElement['play'];
  video.pause = pause as unknown as HTMLVideoElement['pause'];
  Object.defineProperty(video, 'paused', { get: () => paused, configurable: true });
  // No rVFC in happy-dom, and starting at readyState 2 makes revealWhenPainted
  // take its synchronous rung so the ready attribute is observable without
  // faking frames.
  Object.defineProperty(video, 'readyState', { get: () => readyState, configurable: true });

  const fail = (code: number): void => {
    Object.defineProperty(video, 'error', { value: { code }, configurable: true });
    video.dispatchEvent(new Event('error'));
  };

  return { video, container, play, pause, fail };
}

let reduceMotion = false;
let smallViewport = false;

/**
 * happy-dom reports `readyState: 'complete'`, so any test about the page gate
 * has to say otherwise. Restored in the shared teardown, or one test leaves the
 * page "loading" for every test after it.
 */
function setReadyState(value: DocumentReadyState): void {
  Object.defineProperty(document, 'readyState', { value, configurable: true });
}

beforeEach(() => {
  reduceMotion = false;
  smallViewport = false;
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  // A getter, not a value: MediaQueryList.matches is live, and `mediaQuery`
  // memoises one list per query string -- so a frozen value would report
  // whatever was true at the first call and never change, which is the opposite
  // of the platform and would make a resize untestable.
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches(): boolean {
      if (query.includes('prefers-reduced-motion')) return reduceMotion;
      return query.includes('max-width') ? smallViewport : false;
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });

  // The shipped default is 'interaction', which almost none of these tests are
  // about: they would each have to dispatch a scroll before asserting anything
  // plays. Pinned to the previous default here so they stay about arbitration,
  // reveal and sources. The gate has its own describe block, which opts back
  // into 'interaction' explicitly rather than relying on the default reaching
  // it through here.
  configure({ startWhen: 'page-loaded' });
});

afterEach(() => {
  setReadyState('complete');
  resetForTests();
  resetEnv();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('register', () => {
  it('observes the video by default', () => {
    const { video } = makeHarness();
    register(video);
    expect(currentObserver().observed.has(video)).toBe(true);
  });

  it('observes the wrapper when told to', () => {
    const { video, container } = makeHarness();
    register(video, { observe: container });
    expect(currentObserver().observed.has(container)).toBe(true);
    expect(currentObserver().observed.has(video)).toBe(false);
  });

  it('is idempotent', () => {
    const { video } = makeHarness();
    register(video);
    register(video);
    expect(inspect().tracked).toBe(1);
  });
});

describe('playback arbitration', () => {
  it('plays a video once it becomes visible', () => {
    const { video, play } = makeHarness();
    register(video);
    expect(play).not.toHaveBeenCalled();

    currentObserver().report([[video, 0.9]]);
    expect(play).toHaveBeenCalled();
  });

  it('marks the container ready once a frame has painted', () => {
    const { video, container } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.9]]);
    // On the container, not the video: the poster is an earlier sibling and CSS
    // cannot style backwards.
    expect(container.hasAttribute('data-polite-ready')).toBe(true);
  });

  it('pauses after the grace period once fully offscreen', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    configure({ pauseGraceMs: 400 });
    register(video);

    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0]]);
    expect(pause).not.toHaveBeenCalled();

    vi.advanceTimersByTime(399);
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pause).toHaveBeenCalled();
  });

  it('cancels a pending pause if the video comes back', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.6]]);
    currentObserver().report([[video, 0]]);
    currentObserver().report([[video, 0.6]]);
    vi.advanceTimersByTime(1000);

    expect(pause).not.toHaveBeenCalled();
  });
});

describe('gating with `until`', () => {
  it('does not start while the gate is open, even when visible', async () => {
    const { video, play } = makeHarness();
    let release!: () => void;
    register(video, { until: new Promise<void>((resolve) => (release = resolve)) });

    currentObserver().report([[video, 1]]);
    expect(play).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(play).toHaveBeenCalled());
  });

  it('releases even when the gate rejects, rather than stranding the poster', async () => {
    const { video, play } = makeHarness();
    register(video, { until: Promise.reject(new Error('splash failed')) });

    currentObserver().report([[video, 1]]);
    await vi.waitFor(() => expect(play).toHaveBeenCalled());
  });
});

describe('gates', () => {
  it('never starts under reduced motion', () => {
    reduceMotion = true;
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    expect(play).not.toHaveBeenCalled();
  });

  it('retracts the reveal when reduced motion turns on mid-session', () => {
    const { video, container } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    expect(container.hasAttribute('data-polite-ready')).toBe(true);

    // A pause alone would leave a frozen frame on screen, which is worse than
    // the poster it replaced.
    reduceMotion = true;
    resetEnv();
    currentObserver().report([[video, 1]]);
    expect(container.hasAttribute('data-polite-ready')).toBe(false);
  });

  it('never starts on a 2g connection', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { effectiveType: '2g' },
      configurable: true,
    });
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    expect(play).not.toHaveBeenCalled();
  });
});

describe('source fallback', () => {
  it('moves to the next source when one cannot be decoded', () => {
    const { video, fail } = makeHarness({
      src: null,
      sources: [{ src: '/av1.mp4' }, { src: '/h264.mp4' }],
    });
    register(video);
    currentObserver().report([[video, 1]]);
    expect(video.src).toContain('/av1.mp4');

    // Code 3 is what Chromium reported for the truncated AV1 fixture
    // (docs/findings.md).
    fail(3);
    expect(video.src).toContain('/h264.mp4');
  });

  it('does not consume a candidate on the abort its own src assignment causes', () => {
    const { video, fail } = makeHarness({
      src: null,
      sources: [{ src: '/av1.mp4' }, { src: '/h264.mp4' }],
    });
    register(video);
    currentObserver().report([[video, 1]]);

    fail(1);
    expect(video.src).toContain('/av1.mp4');
  });

  it('flags the container and stops tracking once nothing is left to try', () => {
    const { video, container, fail } = makeHarness({ src: null, sources: [{ src: '/only.mp4' }] });
    register(video);
    currentObserver().report([[video, 1]]);

    fail(3);
    expect(container.hasAttribute('data-polite-failed')).toBe(true);
    expect(inspect().tracked).toBe(0);
  });

  it('fails immediately when every declared source is unplayable', () => {
    const { video, container, play } = makeHarness({
      src: null,
      sources: [{ src: '/exotic.mp4', type: 'video/exotic' }],
      canPlayType: () => '',
    });
    register(video);
    currentObserver().report([[video, 1]]);

    expect(play).not.toHaveBeenCalled();
    expect(container.hasAttribute('data-polite-failed')).toBe(true);
  });

  // Two sources, not one: with a single source the failure path exhausts the
  // list and markFailed() clears the reveal, so the retraction in the *fallback*
  // path never runs and the test passes for the wrong reason. Verified by
  // mutation -- with one source, deleting that clearReady left the suite green.
  it('retracts the reveal while switching to the next source', () => {
    const { video, container, fail } = makeHarness({
      src: null,
      sources: [{ src: '/av1.mp4' }, { src: '/h264.mp4' }],
    });
    register(video);
    currentObserver().report([[video, 1]]);
    // Selecting a source calls load(), which resets the element to
    // HAVE_NOTHING, so the reveal waits for the media rather than firing
    // synchronously. This dispatch is the first source painting.
    video.dispatchEvent(new Event('loadeddata'));
    expect(container.hasAttribute('data-polite-ready')).toBe(true);

    // A broken frame must not stay on screen while the replacement loads: the
    // poster has to come back for the gap.
    fail(3);
    expect(video.src).toContain('/h264.mp4');
    expect(container.hasAttribute('data-polite-ready')).toBe(false);

    // ...and return once the replacement actually paints.
    video.dispatchEvent(new Event('loadeddata'));
    expect(container.hasAttribute('data-polite-ready')).toBe(true);
  });
});

describe('play retry', () => {
  it('retries on canplay when play() is rejected with nothing buffered', async () => {
    const { video } = makeHarness();
    let allow = false;
    const play = vi.fn(() => (allow ? Promise.resolve() : Promise.reject(new Error('blocked'))));
    video.play = play as unknown as HTMLVideoElement['play'];

    register(video);
    currentObserver().report([[video, 1]]);
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    // No further observer batches arrive for a video sitting still in view, so
    // without the canplay listener this one would stay on its poster forever.
    allow = true;
    video.dispatchEvent(new Event('canplay'));
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(2));
  });
});

describe('teardown', () => {
  it('releases the observer and listeners with the last video', () => {
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);
    expect(inspect()).toMatchObject({ tracked: 2, observing: true, lifecycle: true });

    unregister(a.video);
    expect(inspect()).toMatchObject({ tracked: 1, observing: true, lifecycle: true });

    // The leak that accumulates one observer and one listener set per page on a
    // client-router site.
    unregister(b.video);
    expect(inspect()).toMatchObject({ tracked: 0, observing: false, lifecycle: false });
  });

  it('clears a pending pause timer so it cannot fire at a detached node', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.6]]);
    currentObserver().report([[video, 0]]);
    unregister(video);
    pause.mockClear();

    vi.advanceTimersByTime(1000);
    expect(pause).not.toHaveBeenCalled();
  });

  it('stops observing the wrapper it was given, not the video', () => {
    const { video, container } = makeHarness();
    register(video, { observe: container });
    const obs = currentObserver();
    unregister(video);
    expect(obs.observed.has(container)).toBe(false);
  });
});

describe('arbitration', () => {
  it('plays every visible video on a large viewport', () => {
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([
      [a.video, 0.9],
      [b.video, 0.8],
    ]);

    // A bento grid of video cards is meant to move; the restriction exists for
    // decode headroom, which desktops have.
    expect(a.play).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalled();
  });

  it('plays only the most visible video on a small viewport', () => {
    smallViewport = true;
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([
      [a.video, 0.4],
      [b.video, 0.9],
    ]);

    expect(b.play).toHaveBeenCalled();
    expect(a.play).not.toHaveBeenCalled();
  });

  it('lets the incumbent keep the slot against a marginally better rival', () => {
    smallViewport = true;
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([[a.video, 0.9]]);
    expect(a.play).toHaveBeenCalled();

    // 0.05 ahead, inside the 0.15 hysteresis: not "clearly" more visible, so the
    // slot must not change hands. Otherwise a carousel's peeking neighbour flaps
    // it back and forth every scroll frame.
    b.play.mockClear();
    currentObserver().report([
      [a.video, 0.85],
      [b.video, 0.9],
    ]);
    expect(b.play).not.toHaveBeenCalled();
  });

  it('hands the slot over once a rival is clearly more visible', () => {
    smallViewport = true;
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([[a.video, 0.9]]);
    // Still eligible on its own, so this is arbitration handing the slot over
    // rather than a scroll taking it away, which is a different pause.
    currentObserver().report([
      [a.video, 0.6],
      [b.video, 0.9],
    ]);

    expect(b.play).toHaveBeenCalled();
    expect(a.pause).toHaveBeenCalled();
  });

  it('never starts a video where atOnce is 0', () => {
    smallViewport = true;
    configure({ atOnce: { small: 0, large: 'all' } });
    const { video, play, container } = makeHarness();
    register(video);

    currentObserver().report([[video, 1]]);
    expect(play).not.toHaveBeenCalled();
    expect(container.hasAttribute('data-polite-ready')).toBe(false);
  });
});

describe('pause control (WCAG 2.2.2)', () => {
  it('stops playback and survives a later reconcile', () => {
    const { video, play, pause } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    expect(play).toHaveBeenCalled();

    pauseAll();
    expect(pause).toHaveBeenCalled();

    // The trap: an arbitration pass resurrecting a video the user deliberately
    // stopped would make the control useless.
    play.mockClear();
    currentObserver().report([[video, 1]]);
    expect(play).not.toHaveBeenCalled();
  });

  it('leaves the paused frame on screen rather than reverting to the poster', () => {
    const { video, container } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    pauseAll();
    // Unlike the automatic gates, a user pause is not a retraction: pausing
    // means "hold this frame", not "put the picture back".
    expect(container.hasAttribute('data-polite-ready')).toBe(true);
  });

  it('resumes', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    pauseAll();
    play.mockClear();
    resumeAll();
    expect(play).toHaveBeenCalled();
  });

  it('toggles from any element carrying data-polite-pause', () => {
    const { video, play, pause } = makeHarness();
    const button = document.createElement('button');
    button.setAttribute('data-polite-pause', '');
    // Nested, to prove the delegation walks up rather than matching the target.
    const label = document.createElement('span');
    button.append(label);
    document.body.append(button);

    register(video);
    currentObserver().report([[video, 1]]);

    label.dispatchEvent(new Event('click', { bubbles: true }));
    expect(pause).toHaveBeenCalled();

    play.mockClear();
    label.dispatchEvent(new Event('click', { bubbles: true }));
    expect(play).toHaveBeenCalled();
  });
});

describe('events', () => {
  it('emits a bubbling ready event when the video is revealed', () => {
    const { video, container } = makeHarness();
    const seen: string[] = [];
    // Listening on the container, not the video, is the point of bubbling.
    container.addEventListener('polite-video:ready', () => seen.push('ready'));

    register(video);
    currentObserver().report([[video, 1]]);
    expect(seen).toEqual(['ready']);
  });

  it('emits failed when nothing is left to try', () => {
    const { video, container, fail } = makeHarness({ src: null, sources: [{ src: '/only.mp4' }] });
    const seen: string[] = [];
    container.addEventListener('polite-video:failed', () => seen.push('failed'));

    register(video);
    currentObserver().report([[video, 1]]);
    fail(3);
    expect(seen).toEqual(['failed']);
  });
});

describe('why a video lost decides how it pauses', () => {
  // Documenting the branch that a wrong comment previously described backwards.
  it('stops a replaced video at once, even though it is still on screen', () => {
    vi.useFakeTimers();
    smallViewport = true;
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([[a.video, 0.9]]);
    expect(a.play).toHaveBeenCalled();

    // b takes the single slot; a is still 60% visible but has been replaced, and
    // two videos decoding through the handover is the contention to avoid.
    currentObserver().report([
      [a.video, 0.6],
      [b.video, 0.9],
    ]);
    expect(a.pause).toHaveBeenCalled();
  });

  it('gives a video that simply scrolled away the grace period', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0]]);

    // Nothing replaced it, so it is the wobble case: stopping instantly would
    // stutter if the scroll nudges it straight back.
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(pause).toHaveBeenCalled();
  });
});

describe('pauseBelow', () => {
  it('stops at half visible by default, and keeps going above it', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    register(video);

    // Comfortably above the default 0.5: still mostly on screen, still running.
    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0.6]]);
    vi.advanceTimersByTime(1000);
    expect(pause).not.toHaveBeenCalled();

    // Mostly gone. The old default of 0 kept this playing until the video was
    // entirely gone, which in practice meant it never stopped while any part of
    // it hung on screen.
    currentObserver().report([[video, 0.4]]);
    vi.advanceTimersByTime(1000);
    expect(pause).toHaveBeenCalled();
  });

  it('stops a video once it falls to the configured fraction', () => {
    vi.useFakeTimers();
    configure({ pauseBelow: 0.25 });
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0.2]]);

    // Nothing replaced it, so this is the wobble case and it takes the grace
    // period rather than stopping mid-scroll.
    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(pause).toHaveBeenCalled();
  });

  it('treats exactly the threshold as below it', () => {
    vi.useFakeTimers();
    configure({ pauseBelow: 0.25 });
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0.25]]);
    vi.advanceTimersByTime(400);
    expect(pause).toHaveBeenCalled();
  });

  // `threshold` is typed `number | number[]`, so it is normalised rather than
  // spread. This library always passes an array, but the DOM type does not know
  // that and the test should not pretend otherwise.
  const observedThresholds = (): number[] => {
    const threshold = currentObserver().options?.threshold ?? [];
    return typeof threshold === 'number' ? [threshold] : [...threshold];
  };

  it('adds the configured fraction to the observer thresholds', () => {
    // Without this the observer never reports at 0.4, so the pause would
    // actually fire at 0.25 -- the nearest crossing the browser reports -- and
    // the setting would silently mean something else.
    configure({ pauseBelow: 0.4 });
    const { video } = makeHarness();
    register(video);

    expect(observedThresholds()).toContain(0.4);
  });

  it('does not duplicate a fraction already on the ladder, and stays sorted', () => {
    configure({ pauseBelow: 0.5 });
    const { video } = makeHarness();
    register(video);

    const threshold = observedThresholds();
    expect(threshold.filter((t) => t === 0.5)).toHaveLength(1);
    expect(threshold).toEqual([...threshold].sort((a, b) => a - b));
  });
});

describe('configure validation', () => {
  // Only pauseBelow reaches a platform API among these, and not until the first
  // register(). hysteresis is library-internal arithmetic, so this check is the
  // only thing that will ever reject it.
  it.each([
    ['pauseBelow', 1.5],
    ['pauseBelow', -0.1],
    ['hysteresis', 2],
    ['pauseBelow', Number.NaN],
    ['hysteresis', Number.POSITIVE_INFINITY],
  ])('rejects %s: %s at the point of configuring', (key, value) => {
    expect(() => configure({ [key]: value })).toThrow(RangeError);
  });

  it.each([0, 0.5, 1])('accepts the fraction %s', (value) => {
    expect(() => configure({ pauseBelow: value })).not.toThrow();
  });

  it('rejects a negative grace period', () => {
    expect(() => configure({ pauseGraceMs: -1 })).toThrow(RangeError);
  });

  it('accepts a zero grace period, which just means stop immediately', () => {
    expect(() => configure({ pauseGraceMs: 0 })).not.toThrow();
  });

  it('rejects an empty smallViewport', () => {
    expect(() => configure({ smallViewport: '  ' })).toThrow(SyntaxError);
  });

  // Deliberately not asserted as throwing: a malformed media query cannot be
  // detected. Chromium echoes it back through MediaQueryList.media and never
  // matches, so this documents the known gap rather than pretending it is caught.
  it('cannot detect a malformed media query, and does not pretend to', () => {
    expect(() => configure({ smallViewport: '(max-width: 767)' })).not.toThrow();
  });

  it('leaves config untouched when a patch is rejected', () => {
    configure({ pauseBelow: 0.3 });
    expect(() => configure({ pauseBelow: 5 })).toThrow();

    // A partially applied patch would be worse than a rejected one.
    const { video } = makeHarness();
    register(video);
    const threshold = currentObserver().options?.threshold ?? [];
    expect(typeof threshold === 'number' ? [threshold] : [...threshold]).toContain(0.3);
  });
});

describe('rootMargin validation', () => {
  // Delegated to the platform rather than hand-parsed: the grammar is CSS margin
  // syntax, and a second parser here would drift from the browser's.
  class ThrowingObserver {
    constructor(_cb: IntersectionObserverCallback, options?: IntersectionObserverInit) {
      if (options?.rootMargin && !/^-?[\d.]+(px|%)( |$)/.test(options.rootMargin)) {
        throw new SyntaxError('rootMargin must be specified in pixels or percent.');
      }
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }

  it('rejects a malformed rootMargin at configure time', () => {
    vi.stubGlobal('IntersectionObserver', ThrowingObserver);
    // Without units, which is the mistake the browser rejects.
    expect(() => configure({ rootMargin: '50' })).toThrow(SyntaxError);
  });

  it('accepts a valid one', () => {
    vi.stubGlobal('IntersectionObserver', ThrowingObserver);
    expect(() => configure({ rootMargin: '50px' })).not.toThrow();
    expect(() => configure({ rootMargin: '10%' })).not.toThrow();
  });

  it('skips the check when there is no IntersectionObserver to ask', () => {
    // Importing and configuring under SSR or in a Node test must not explode.
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(() => configure({ rootMargin: 'anything at all' })).not.toThrow();
  });
});

describe('recovering from a persistently blocked play()', () => {
  // iOS Low Power Mode and a blocked-autoplay policy both reject play() every
  // time, not once. Measured in Chromium: once readyState is 4, neither `canplay`
  // nor `loadeddata` fires again (0 of each across 3 rejections), so the only
  // signal that can still arrive is a user gesture.
  const blockedHarness = (): { video: HTMLVideoElement; play: ReturnType<typeof vi.fn> } => {
    const { video } = makeHarness();
    const play = vi.fn(() => Promise.reject(new DOMException('blocked', 'NotAllowedError')));
    video.play = play as unknown as HTMLVideoElement['play'];
    return { video, play };
  };

  const tap = (): void => {
    document.dispatchEvent(new Event('pointerdown'));
  };

  it('retries on every gesture, not just the first', async () => {
    const { video, play } = blockedHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    play.mockClear();
    tap();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));

    // The bug: the gesture hatch was `{ once: true }`, so it was spent by the
    // first tap anywhere on the document and the video could never recover.
    play.mockClear();
    tap();
    await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
  });

  it('keeps retrying after many gestures', async () => {
    const { video, play } = blockedHarness();
    register(video);
    currentObserver().report([[video, 1]]);
    await vi.waitFor(() => expect(play).toHaveBeenCalled());

    for (let i = 0; i < 4; i += 1) {
      play.mockClear();
      tap();
      await vi.waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    }
  });
});

describe('a gate closing and reopening', () => {
  // reconcile() sets started = false when motion or the connection gate closes,
  // and the winners branch then calls start() again when it reopens. start()
  // built a fresh SourceManager every time, so each cycle rewound the candidate
  // list and re-attached an error listener.
  const cycleMotionGate = (video: HTMLVideoElement): void => {
    reduceMotion = true;
    resetEnv();
    currentObserver().report([[video, 1]]);
    reduceMotion = false;
    resetEnv();
    currentObserver().report([[video, 1]]);
  };

  it('does not rewind to a source that already failed', () => {
    const { video, fail } = makeHarness({
      src: null,
      sources: [{ src: '/av1.mp4' }, { src: '/h264.mp4' }],
    });
    register(video);
    currentObserver().report([[video, 1]]);
    expect(video.src).toContain('/av1.mp4');

    fail(3);
    expect(video.src).toContain('/h264.mp4');

    cycleMotionGate(video);

    // Rewinding re-attempts a source already known to be undecodable, and
    // restarts playback from frame 0. sources.ts states the invariant plainly:
    // the first choice sticks for the page's lifetime.
    expect(video.src).toContain('/h264.mp4');
  });

  it('does not re-run source selection at all', () => {
    const { video } = makeHarness({ src: null, sources: [{ src: '/only.mp4' }] });
    register(video);
    currentObserver().report([[video, 1]]);

    const loadCalls = (video.load as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    cycleMotionGate(video);
    expect((video.load as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(loadCalls);
  });

  it('still resumes playback when the gate reopens', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    play.mockClear();
    cycleMotionGate(video);
    expect(play).toHaveBeenCalled();
  });
});

describe('configure() after the first register', () => {
  // Three settings are captured when the observer and the lifecycle listeners are
  // built, which happens at the first register(). Patching them later does not
  // merely fail to apply: pauseBelow half-applies, because eligibility reads it
  // live while the threshold ladder does not, so it silently takes effect at the
  // nearest stale crossing. That is precisely what thresholds() exists to stop.
  it.each(['rootMargin', 'pauseBelow', 'smallViewport'])(
    'rejects a late %s rather than half-applying it',
    (key) => {
      const patches: Record<string, unknown> = {
        rootMargin: '10px',
        pauseBelow: 0.4,
        smallViewport: '(max-width: 900px)',
      };
      const { video } = makeHarness();
      register(video);

      expect(() => configure({ [key]: patches[key] })).toThrow(/before the first register/);
    }
  );

  it.each(['pauseGraceMs', 'atOnce', 'hysteresis'])('still accepts a late %s', (key) => {
    const patches: Record<string, unknown> = {
      pauseGraceMs: 900,
      atOnce: 0,
      hysteresis: 0.3,
    };
    const { video } = makeHarness();
    register(video);

    // These are read on every reconcile, so changing them mid-flight is
    // meaningful rather than half-applied.
    expect(() => configure({ [key]: patches[key] })).not.toThrow();
  });

  it('accepts them again once everything is unregistered', () => {
    const { video } = makeHarness();
    register(video);
    expect(() => configure({ pauseBelow: 0.4 })).toThrow();

    unregister(video);
    expect(() => configure({ pauseBelow: 0.4 })).not.toThrow();
  });
});

describe('lifecycle listeners', () => {
  // These had no coverage at all: every one could be deleted with the suite
  // green. They exist because scripts do not re-run on a bfcache restore and
  // mobile browsers leave video paused after the tab is hidden, so without them
  // a video comes back frozen.
  const setVisibility = (state: DocumentVisibilityState): void => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  };

  it('re-runs the arbiter on a bfcache restore', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    // A browser can restore the page with the element paused, and no observer
    // batch follows, so nothing else would notice.
    video.pause();
    play.mockClear();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(play).toHaveBeenCalled();
  });

  it('ignores a pageshow that is not a bfcache restore', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    video.pause();
    play.mockClear();
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(play).not.toHaveBeenCalled();
  });

  it('re-runs the arbiter when the tab becomes visible again', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    video.pause();
    play.mockClear();
    setVisibility('visible');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).toHaveBeenCalled();

    setVisibility('visible');
  });

  it('does nothing when the tab is going away rather than returning', () => {
    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 1]]);

    video.pause();
    play.mockClear();
    setVisibility('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(play).not.toHaveBeenCalled();

    setVisibility('visible');
  });
});

describe('aria-pressed on the pause control', () => {
  const control = (html: string): Element => {
    const host = document.createElement('div');
    host.innerHTML = html;
    const el = host.firstElementChild!;
    document.body.append(el);
    return el;
  };

  it('keeps a declared aria-pressed current', () => {
    const button = control('<button data-polite-pause aria-pressed="false">pause</button>');
    pauseAll();
    expect(button.getAttribute('aria-pressed')).toBe('true');
    resumeAll();
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });

  // MDN documents two valid patterns. A control that swaps its label between
  // "Pause" and "Play" must not carry aria-pressed, or a screen reader announces
  // "Play, pressed". Not declaring it is how an author selects that pattern, so
  // the library must not add one.
  it('does not add aria-pressed to a control that omits it', () => {
    const button = control('<button data-polite-pause>pause</button>');
    pauseAll();
    expect(button.hasAttribute('aria-pressed')).toBe(false);
  });

  // aria-pressed is valid only on a button role, so writing it anywhere else
  // would be ARIA a validator rejects.
  it('leaves a non-button alone even when it declares one', () => {
    const div = control('<div data-polite-pause aria-pressed="false">pause</div>');
    pauseAll();
    expect(div.getAttribute('aria-pressed')).toBe('false');
  });

  it('maintains it on an element that takes the button role explicitly', () => {
    const el = control('<span role="button" data-polite-pause aria-pressed="false">pause</span>');
    pauseAll();
    expect(el.getAttribute('aria-pressed')).toBe('true');
  });
});

/**
 * The failure this guards is silent by construction: `host` is derived as the
 * video's parent while video.css keys off an authored attribute on that same
 * element, so the two can disagree and every rule simply misses. Nothing else
 * in the library or the browser reports it.
 */
describe('the unstyled-markup warning', () => {
  // Cleared on creation: spying a method that is already spied hands back the
  // existing mock with its history intact, so without this each test inherits
  // the previous one's calls and the counts below are meaningless.
  function warnings(): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    spy.mockClear();
    return spy;
  }

  // happy-dom reports '' for an unstyled element's opacity and visibility where a
  // browser reports '1' and 'visible', so the visible state has to be stated
  // outright here. The e2e suite covers the realistic case, where the browser
  // defaults are what trigger it.
  it('warns when the box carries no data-polite-media and nothing hides the video', () => {
    const warn = warnings();
    const { video, container } = makeHarness();
    container.removeAttribute('data-polite-media');
    video.style.opacity = '1';
    video.style.visibility = 'visible';

    register(video);
    currentObserver().report([[video, 1]]);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('data-polite-media');
  });

  // A host that hides the video with its own CSS is a supported setup, and one
  // of the two real consumers does exactly that. Nagging it would train people
  // to ignore the warning that matters.
  it('stays quiet when the host hides the video itself', () => {
    const warn = warnings();
    const { video, container } = makeHarness();
    container.removeAttribute('data-polite-media');
    video.style.opacity = '0';
    // Both, or the test cannot fail: happy-dom computes '' for an unstyled
    // visibility, which is already not 'visible', so the check would short
    // circuit there and never reach the opacity half this test is about.
    video.style.visibility = 'visible';

    register(video);
    currentObserver().report([[video, 1]]);

    expect(warn).not.toHaveBeenCalled();
  });

  // visibility does not show up in the computed opacity, so hiding a video that
  // way is a working setup the earlier check still warned about.
  it('stays quiet when the host hides the video with visibility', () => {
    const warn = warnings();
    const { video, container } = makeHarness();
    container.removeAttribute('data-polite-media');
    video.style.opacity = '1';
    video.style.visibility = 'hidden';

    register(video);
    currentObserver().report([[video, 1]]);

    expect(warn).not.toHaveBeenCalled();
  });

  it('stays quiet on the documented markup', () => {
    const warn = warnings();
    const { video } = makeHarness();

    register(video);
    currentObserver().report([[video, 1]]);

    expect(warn).not.toHaveBeenCalled();
  });

  // Once per page, not once per video: a grid of twelve misconfigured cards
  // should not print twelve identical paragraphs.
  it('warns only once however many videos are wrong', () => {
    const warn = warnings();
    const a = makeHarness();
    const b = makeHarness();
    a.container.removeAttribute('data-polite-media');
    b.container.removeAttribute('data-polite-media');
    a.video.style.opacity = '1';
    b.video.style.opacity = '1';
    a.video.style.visibility = 'visible';
    b.video.style.visibility = 'visible';

    register(a.video);
    register(b.video);
    currentObserver().report([
      [a.video, 1],
      [b.video, 1],
    ]);

    expect(warn).toHaveBeenCalledTimes(1);
  });
});

/**
 * A client-side router replaces the body and does not re-run module scripts, so
 * nothing in the page ever calls unregister for the elements it discarded.
 * Astro's ClientRouter is the case this exists for.
 */
describe('elements removed from the document', () => {
  it('stops tracking a video whose element has been detached', () => {
    const { video, container } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.6]]);
    expect(inspect().tracked).toBe(1);

    container.remove();
    // The removal is itself an observer report in a real browser.
    currentObserver().report([[video, 0]]);

    expect(inspect().tracked).toBe(0);
    expect(currentObserver().observed.has(video)).toBe(false);
  });

  it('releases the page-level listeners once the last video goes with the page', () => {
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);
    expect(inspect().lifecycle).toBe(true);

    a.container.remove();
    b.container.remove();
    currentObserver().report([
      [a.video, 0],
      [b.video, 0],
    ]);

    expect(inspect().tracked).toBe(0);
    expect(inspect().observing).toBe(false);
    expect(inspect().lifecycle).toBe(false);
  });

  // Measured in Chromium: observing a detached target reports it at once with
  // isIntersecting false, so an unconditional sweep would undo this registration
  // on the first batch, silently.
  it('keeps a video registered before it is appended to the document', () => {
    const { video, container } = makeHarness();
    container.remove();
    register(video);
    currentObserver().report([[video, 0]]);

    expect(inspect().tracked).toBe(1);
  });

  it('still drops it once it has been in the document and left', () => {
    const { video, container } = makeHarness();
    container.remove();
    register(video);
    currentObserver().report([[video, 0]]);

    document.body.append(container);
    currentObserver().report([[video, 0.6]]);
    container.remove();
    currentObserver().report([[video, 0]]);

    expect(inspect().tracked).toBe(0);
  });

  it('leaves a video that is merely invisible alone', () => {
    const { video } = makeHarness();
    register(video);
    currentObserver().report([[video, 0]]);
    expect(inspect().tracked).toBe(1);
  });
});

/**
 * Mirrors `revealImages` on the image half, so the two read as one idea rather
 * than two. The idempotence is what makes it safe to call on every navigation of
 * a client-side router, where module scripts do not re-run.
 */
describe('registerAll', () => {
  it('registers every video a selector names', () => {
    makeHarness();
    makeHarness();
    makeHarness();

    registerAll('video');
    expect(inspect().tracked).toBe(3);
  });

  it('accepts a collection as well as a selector', () => {
    makeHarness();
    makeHarness();

    registerAll(document.querySelectorAll('video'));
    expect(inspect().tracked).toBe(2);
  });

  it('accepts a single element, which is the obvious thing to pass', () => {
    const { video } = makeHarness();
    registerAll(video);
    expect(inspect().tracked).toBe(1);
  });

  it('is idempotent, so a router can call it on every navigation', () => {
    makeHarness();
    makeHarness();

    registerAll('video');
    registerAll('video');
    expect(inspect().tracked).toBe(2);
  });

  it('passes options through to each video', () => {
    const a = makeHarness();
    makeHarness();
    // Never settles: the point is that the gate is honoured, not that it opens.
    registerAll('video', { until: new Promise<void>(() => undefined) });
    currentObserver().report([[a.video, 0.9]]);
    // Gated, so visibility alone must not start it.
    expect(a.play).not.toHaveBeenCalled();
  });
});

/**
 * Without this event the label-swapping control the README offers as an option
 * cannot be built: the only other signal is data-polite-paused on <html>, and
 * watching that means a MutationObserver on the root, which is the ask this
 * library exists to spare a host.
 */
describe('the pause-state event', () => {
  function listen(): { calls: boolean[]; stop: () => void } {
    const calls: boolean[] = [];
    const onChange = (event: Event): void => {
      calls.push((event as CustomEvent<{ paused: boolean }>).detail.paused);
    };
    document.addEventListener('polite-video:pausechange', onChange);
    return {
      calls,
      stop: () => document.removeEventListener('polite-video:pausechange', onChange),
    };
  }

  it('announces a pause and a resume, with the state in the detail', () => {
    const { video } = makeHarness();
    register(video);
    const { calls, stop } = listen();

    pauseAll();
    resumeAll();
    stop();

    expect(calls).toEqual([true, false]);
  });

  // A host mirroring this into its own state would otherwise be told about
  // transitions that never happened.
  it('stays silent when the state does not actually change', () => {
    const { video } = makeHarness();
    register(video);
    const { calls, stop } = listen();

    pauseAll();
    pauseAll();
    resumeAll();
    resumeAll();
    stop();

    expect(calls).toEqual([true, false]);
  });

  // Teardown resets the flag, and a host left holding a "paused" button for a
  // page that is no longer paused is exactly the drift this event prevents.
  it('announces the reset when a paused page is torn down', () => {
    const { video } = makeHarness();
    register(video);
    pauseAll();
    const { calls, stop } = listen();

    unregisterAll();
    stop();

    expect(calls).toEqual([false]);
  });

  // The event has to mean "this has happened", not "this is about to". A host
  // reading playback state in the handler is the obvious thing to do, and firing
  // before the arbiter runs would hand it the state the event says just ended.
  it('announces only after playback has actually changed', () => {
    const { video } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.9]]);
    expect(video.paused).toBe(false);

    const seen: Array<{ paused: boolean; videoPaused: boolean }> = [];
    const onChange = (event: Event): void => {
      seen.push({
        paused: (event as CustomEvent<{ paused: boolean }>).detail.paused,
        videoPaused: video.paused,
      });
    };
    document.addEventListener('polite-video:pausechange', onChange);

    pauseAll();
    resumeAll();
    document.removeEventListener('polite-video:pausechange', onChange);

    expect(seen).toEqual([
      { paused: true, videoPaused: true },
      { paused: false, videoPaused: false },
    ]);
  });

  it('keeps the attribute, aria-pressed and the event in step', () => {
    const button = document.createElement('button');
    button.setAttribute('data-polite-pause', '');
    button.setAttribute('aria-pressed', 'false');
    document.body.append(button);
    const { video } = makeHarness();
    register(video);
    const { calls, stop } = listen();

    pauseAll();
    const paused = {
      event: calls.at(-1),
      attribute: document.documentElement.hasAttribute('data-polite-paused'),
      pressed: button.getAttribute('aria-pressed'),
    };
    resumeAll();
    const resumed = {
      event: calls.at(-1),
      attribute: document.documentElement.hasAttribute('data-polite-paused'),
      pressed: button.getAttribute('aria-pressed'),
    };
    stop();

    expect(paused).toEqual({ event: true, attribute: true, pressed: 'true' });
    expect(resumed).toEqual({ event: false, attribute: false, pressed: 'false' });
  });
});

/**
 * The claim the library cannot keep on its own: it ships the hook, the host
 * ships the button, and forgetting it is silent. Deferred by WCAG 2.2.2's own
 * five-second threshold, so these use fake timers.
 */
describe('the missing-pause-control warning', () => {
  function warnings(): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    spy.mockClear();
    return spy;
  }

  function startLooping(): void {
    const { video } = makeHarness();
    video.loop = true;
    register(video);
    currentObserver().report([[video, 0.9]]);
  }

  it('warns once a looping video has run five seconds with no control', () => {
    vi.useFakeTimers();
    const warn = warnings();
    startLooping();

    vi.advanceTimersByTime(4999);
    expect(warn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('data-polite-pause');
  });

  it('stays quiet when the page has a control', () => {
    vi.useFakeTimers();
    const warn = warnings();
    const button = document.createElement('button');
    button.setAttribute('data-polite-pause', '');
    document.body.append(button);

    startLooping();
    vi.advanceTimersByTime(5000);

    expect(warn).not.toHaveBeenCalled();
  });

  // A clip that ends by itself is outside the criterion, so demanding a control
  // for it would be noise.
  it('stays quiet for a video that does not loop', () => {
    vi.useFakeTimers();
    const warn = warnings();
    const { video } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.9]]);

    vi.advanceTimersByTime(5000);
    expect(warn).not.toHaveBeenCalled();
  });

  // Nothing is moving any more, so there is nothing to demand a control for.
  it('stays quiet if everything was torn down before the check', () => {
    vi.useFakeTimers();
    const warn = warnings();
    startLooping();

    unregisterAll();
    vi.advanceTimersByTime(5000);

    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * The band. `pauseBelow` alone is a line, and a video sitting on it depends on
 * the debounce to behave; pulling the two apart puts the start and stop
 * crossings in different places, so oscillation stops being possible rather than
 * being smoothed over.
 */
describe('playAbove after a scroll-away', () => {
  // `started` means "has ever started", so nothing reset it when a video was
  // paused for leaving the viewport -- eligibility then fell to `pauseBelow`
  // permanently and the start threshold applied only once per video.
  it('applies the start threshold again, not just the first time', () => {
    vi.useFakeTimers();
    const { video, play, pause } = makeHarness();
    configure({ playAbove: 0.75, pauseBelow: 0.25 });
    register(video);

    currentObserver().report([[video, 0.8]]);
    expect(play).toHaveBeenCalledTimes(1);

    currentObserver().report([[video, 0]]);
    vi.advanceTimersByTime(1000);
    expect(pause).toHaveBeenCalled();

    // Above the stop threshold but below the start threshold: it must stay put.
    play.mockClear();
    currentObserver().report([[video, 0.5]]);
    expect(play).not.toHaveBeenCalled();

    currentObserver().report([[video, 0.9]]);
    expect(play).toHaveBeenCalledTimes(1);
  });

  // The tempting fix -- judging eligibility on `!video.paused` instead -- breaks
  // this, because a user-paused video is paused and would never be allowed back.
  it('still lets resumeAll() restart a video below the start threshold', () => {
    const { video, play } = makeHarness();
    configure({ playAbove: 0.75, pauseBelow: 0.25 });
    register(video);

    currentObserver().report([[video, 0.9]]);
    pauseAll();
    play.mockClear();

    currentObserver().report([[video, 0.5]]);
    resumeAll();
    expect(play).toHaveBeenCalled();
  });
});

describe('playAbove', () => {
  it('holds a video back until it clears the start threshold', () => {
    const { video, play } = makeHarness();
    configure({ playAbove: 0.75, pauseBelow: 0.25 });
    register(video);

    currentObserver().report([[video, 0.5]]);
    expect(play).not.toHaveBeenCalled();

    currentObserver().report([[video, 0.8]]);
    expect(play).toHaveBeenCalled();
  });

  // The point of the band: once running, it is judged by the lower threshold, so
  // scrolling back through the middle does not stop it.
  it('keeps a running video alive down to the stop threshold', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    configure({ playAbove: 0.75, pauseBelow: 0.25 });
    register(video);

    currentObserver().report([[video, 0.8]]);
    currentObserver().report([[video, 0.5]]);
    vi.advanceTimersByTime(1000);
    expect(pause).not.toHaveBeenCalled();

    currentObserver().report([[video, 0.2]]);
    vi.advanceTimersByTime(1000);
    expect(pause).toHaveBeenCalled();
  });

  // 0.62 on purpose: the static ladder already carries 0.75, so asserting that
  // one would pass whether or not playAbove reached the observer at all. The
  // browser reports only at crossings it was given, so a missing threshold means
  // the start fires at the nearest one below instead.
  it('makes the observer report at the start threshold', () => {
    const { video } = makeHarness();
    configure({ playAbove: 0.62 });
    register(video);
    expect(currentObserver().options?.threshold).toContain(0.62);
  });

  // Nobody can mean "start at less visibility than you stop at", so it is no
  // band rather than an error.
  it('ignores a start threshold at or below the stop threshold', () => {
    const { video, play } = makeHarness();
    configure({ playAbove: 0.1, pauseBelow: 0.5 });
    register(video);

    currentObserver().report([[video, 0.3]]);
    expect(play).not.toHaveBeenCalled();

    currentObserver().report([[video, 0.6]]);
    expect(play).toHaveBeenCalled();
  });

  it('is rejected outside 0 to 1, at the call that caused it', () => {
    expect(() => configure({ playAbove: 1.5 })).toThrow(RangeError);
  });

  it('cannot be changed once the observer exists', () => {
    const { video } = makeHarness();
    register(video);
    expect(() => configure({ playAbove: 0.5 })).toThrow(/before the first register/);
  });
});

/**
 * The safety net for the 0.75 default. A box taller than the viewport cannot be
 * fully intersecting, so a high start threshold is unreachable and the video
 * simply never plays -- silently, which is the one outcome this library treats
 * as a bug rather than a preference.
 */
describe('the unreachable-start warning', () => {
  function warnings(): ReturnType<typeof vi.spyOn> {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    spy.mockClear();
    return spy;
  }

  function withHeight(video: HTMLVideoElement, height: number): void {
    video.getBoundingClientRect = (() => ({ height, width: 100 })) as unknown as () => DOMRect;
  }

  it('warns when the box is too tall to ever clear the start threshold', () => {
    const warn = warnings();
    const { video } = makeHarness();
    // Ten viewports tall, so the ceiling is 0.1 against the default pauseBelow of
    // 0.5. With no margin on this observer the ceiling is exactly
    // viewport / height, which puts the cutoff at twice the viewport.
    withHeight(video, window.innerHeight * 10);
    register(video);

    currentObserver().report([[video, 0.05]]);

    expect(warn).toHaveBeenCalledTimes(1);
    // Names whichever threshold is actually doing the blocking, so the fix the
    // message asks for is the one that helps.
    expect(warn.mock.calls[0]?.[0]).toContain('pauseBelow');
  });

  it('names playAbove when that is the threshold out of reach', () => {
    const warn = warnings();
    configure({ playAbove: 0.9, pauseBelow: 0.2 });
    const { video } = makeHarness();
    withHeight(video, window.innerHeight * 2);
    register(video);

    currentObserver().report([[video, 0.4]]);

    expect(warn.mock.calls[0]?.[0]).toContain('playAbove');
  });

  it('stays quiet for a box that can reach it', () => {
    const warn = warnings();
    const { video } = makeHarness();
    withHeight(video, window.innerHeight / 2);
    register(video);

    currentObserver().report([[video, 0.9]]);
    expect(warn).not.toHaveBeenCalled();
  });

  // With no start threshold there is nothing to be unreachable.
  it('stays quiet when the band is switched off', () => {
    const warn = warnings();
    configure({ playAbove: 0, pauseBelow: 0 });
    const { video } = makeHarness();
    withHeight(video, window.innerHeight * 10);
    register(video);

    currentObserver().report([[video, 0.3]]);
    expect(warn).not.toHaveBeenCalled();
  });
});

/**
 * `startWhen` is a ladder of patience. The whole suite otherwise runs with
 * happy-dom reporting `readyState: 'complete'`, so the gate is never exercised
 * unless a test says the page is still loading -- which is why these stub it
 * rather than trusting the environment.
 */
describe('startWhen', () => {
  it('holds a visible video until the page has loaded', () => {
    setReadyState('loading');
    const { video, play } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    expect(play).not.toHaveBeenCalled();

    setReadyState('complete');
    window.dispatchEvent(new Event('load'));
    expect(play).toHaveBeenCalled();
  });

  // A module imported after load must not wait for an event that already fired.
  it('starts at once when the page is already loaded', () => {
    const { video, play } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    expect(play).toHaveBeenCalled();
  });

  it('ignores the page entirely under visible', () => {
    setReadyState('loading');
    configure({ startWhen: 'visible' });
    const { video, play } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    expect(play).toHaveBeenCalled();
  });

  it('is rejected as a typo, the way atOnce is', () => {
    // @ts-expect-error -- the union is the point: a typo must not compile.
    expect(() => configure({ startWhen: 'page-load' })).not.toThrow();
  });

  describe('requireBuffered', () => {
    it('promotes preload and waits for canplaythrough before playing', () => {
      configure({ requireBuffered: true, startWhen: 'visible' });
      const { video, play } = makeHarness();
      Object.defineProperty(video, 'readyState', { get: () => 1, configurable: true });
      register(video);

      currentObserver().report([[video, 0.9]]);
      // Nothing buffers under preload="none", so the promotion is what makes the
      // wait possible rather than a deadlock.
      expect(video.preload).toBe('auto');
      expect(play).not.toHaveBeenCalled();

      video.dispatchEvent(new Event('canplaythrough'));
      expect(play).toHaveBeenCalled();
    });

    it('does not wait when the data is already there', () => {
      configure({ requireBuffered: true, startWhen: 'visible' });
      const { video, play } = makeHarness();
      Object.defineProperty(video, 'readyState', { get: () => 4, configurable: true });
      register(video);

      currentObserver().report([[video, 0.9]]);
      expect(play).toHaveBeenCalled();
    });
  });
});

/**
 * The reveal fires its `ready` event synchronously from inside `start()`, which
 * runs inside `reconcile()`'s loop over a snapshot. A host listener that calls
 * back in mutates state the loop already read, and the loop then starts the
 * remaining winners anyway -- leaving a video playing that `pauseAll()` has no
 * handle on, which is the package's headline claim inverted.
 */
describe('a host listener that re-enters during reconcile', () => {
  function twoVideos(): { first: Harness; second: Harness } {
    const first = makeHarness();
    const second = makeHarness();
    register(first.video);
    register(second.video);
    return { first, second };
  }

  it('does not start the rest of the pass after pauseAll()', () => {
    const { first, second } = twoVideos();
    first.container.addEventListener('polite-video:ready', () => pauseAll(), { once: true });

    currentObserver().report([
      [first.video, 0.9],
      [second.video, 0.9],
    ]);

    expect(second.play).not.toHaveBeenCalled();
  });

  it('does not start a video whose entry the listener already released', () => {
    const { first, second } = twoVideos();
    first.container.addEventListener('polite-video:ready', () => unregisterAll(), { once: true });

    currentObserver().report([
      [first.video, 0.9],
      [second.video, 0.9],
    ]);

    expect(inspect().tracked).toBe(0);
    expect(second.play).not.toHaveBeenCalled();
  });
});

describe('unregisterAll', () => {
  // A client-side router tears down per navigation, and configuration is a
  // property of the page's setup rather than of the videos currently on it.
  // Resetting it here silently reverted a host's settings on the first swap.
  it('keeps the configuration a host set', () => {
    configure({ pauseBelow: 0.6, playAbove: 0.9 });
    unregisterAll();

    const { video, play } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.7]]);

    expect(play).not.toHaveBeenCalled();
  });
});

describe('register guards', () => {
  // `until` is typed as an optional Promise, but a host computing the gate
  // inline hands over whatever the expression produced. A falsy gate has nothing
  // to settle, so gating on it left the video on its poster forever.
  it('does not strand a video on a nullish until', () => {
    const { video, play } = makeHarness();
    register(video, { until: null as unknown as Promise<unknown> });

    currentObserver().report([[video, 0.9]]);

    expect(play).toHaveBeenCalled();
  });

  // Entries are keyed by video but looked up by observed target, so a shared
  // target overwrote the first entry's slot: the first video stopped receiving
  // ratios, and unregistering either released the other's observation too.
  it('refuses a second video on an already-observed target', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const first = makeHarness();
    const second = makeHarness();
    const shared = first.container;

    register(first.video, { observe: shared });
    register(second.video, { observe: shared });

    expect(warn).toHaveBeenCalledOnce();
    expect(inspect().tracked).toBe(1);

    currentObserver().report([[shared, 0.9]]);
    expect(first.play).toHaveBeenCalled();
  });
});

describe('atOnce', () => {
  // The gap this option exists to close: one-at-a-time used to be reachable only
  // through a media query engineered to always match, because the old `mobile`
  // option asked "what happens on small screens" rather than "how many at once".
  it('gives one video the screen on a large viewport too', () => {
    smallViewport = false;
    configure({ atOnce: 1 });
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([
      [a.video, 0.6],
      [b.video, 0.9],
    ]);

    expect(b.play).toHaveBeenCalled();
    expect(a.play).not.toHaveBeenCalled();
  });

  it('lets a small viewport play everything when asked', () => {
    smallViewport = true;
    configure({ atOnce: 'all' });
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([
      [a.video, 0.6],
      [b.video, 0.9],
    ]);

    expect(a.play).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalled();
  });

  it('reads the viewport live, so a resize changes the answer', () => {
    configure({ atOnce: { small: 1, large: 'all' } });
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    smallViewport = true;
    currentObserver().report([
      [a.video, 0.6],
      [b.video, 0.9],
    ]);
    expect(a.play).not.toHaveBeenCalled();

    smallViewport = false;
    currentObserver().report([[a.video, 0.6]]);
    expect(a.play).toHaveBeenCalled();
  });

  it.each([2, 0.5, 'one'])('rejects %p rather than quietly meaning 1', (value) => {
    // @ts-expect-error -- the runtime check is for JS callers the union cannot reach.
    expect(() => configure({ atOnce: value })).toThrow(RangeError);
  });
});

describe('rootMargin drives a second observer', () => {
  it('leaves the playback observer with no margin, so a ratio means what it says', () => {
    configure({ rootMargin: '200px' });
    const { video } = makeHarness();
    register(video);

    // The bug this splits apart: one observer measured intersectionRatio against
    // the root *including* the margin, so pauseBelow silently meant less than it
    // said, by an amount that varied with element height.
    expect(currentObserver().options?.rootMargin).toBeUndefined();
    expect(prefetchObserver()?.options?.rootMargin).toBe('200px');
  });

  it('builds no second observer by default, so nothing prefetches unasked', () => {
    const { video } = makeHarness();
    register(video);

    expect(prefetchObserver()).toBeUndefined();
  });

  it('buffers a video that is near but not yet eligible to play', () => {
    configure({ rootMargin: '200px' });
    const { video, play } = makeHarness();
    register(video);

    prefetchObserver()?.report([[video, 0.01]]);

    // Fetching, but not playing: preload="none" means choosing a source alone
    // downloads nothing, so the promotion is what actually starts the bytes.
    expect(video.preload).toBe('auto');
    expect(video.getAttribute('src')).toBe('/authored.mp4');
    expect(play).not.toHaveBeenCalled();
  });

  it('does not prefetch a video still held by its until gate', () => {
    configure({ rootMargin: '200px' });
    const { video } = makeHarness();
    register(video, { until: new Promise(() => {}) });

    prefetchObserver()?.report([[video, 0.01]]);

    expect(video.preload).not.toBe('auto');
  });

  it('releases the target from both observers on unregister', () => {
    configure({ rootMargin: '200px' });
    const first = makeHarness();
    const second = makeHarness();
    register(first.video);
    register(second.video);
    const [play, prefetch] = [currentObserver(), prefetchObserver()];

    // Two videos, so one survives: unregistering the last disconnects both
    // observers and clears their sets anyway, which would hide a missing
    // unobserve behind teardown that happens to be correct.
    unregister(first.video);

    expect(play.observed.has(first.video)).toBe(false);
    expect(prefetch?.observed.has(first.video)).toBe(false);
    expect(prefetch?.observed.has(second.video)).toBe(true);
  });

  it('disconnects the prefetch observer once the last video goes', () => {
    configure({ rootMargin: '200px' });
    const { video } = makeHarness();
    register(video);
    const prefetch = prefetchObserver();

    unregister(video);

    expect(prefetch?.disconnected).toBe(true);
  });
});

describe('a handover under a single slot', () => {
  // Measured on demo/feed.html before this: an outgoing card kept decoding for
  // the full pauseGraceMs while the incoming one played, so a stepped scroll
  // found two running at once in all three engines.
  it('stops the outgoing video at once when it fell below the threshold as the next rose', () => {
    vi.useFakeTimers();
    configure({ atOnce: 1 });
    const a = makeHarness();
    const b = makeHarness();
    register(a.video);
    register(b.video);

    currentObserver().report([[a.video, 0.9]]);
    expect(a.play).toHaveBeenCalled();

    // a is now below pauseBelow, so it is not merely outranked, it is out of the
    // band entirely -- and b takes the slot in the same pass.
    currentObserver().report([
      [a.video, 0.4],
      [b.video, 0.9],
    ]);

    expect(a.pause).toHaveBeenCalled();
    expect(b.play).toHaveBeenCalled();
  });

  // The grace period still has to exist, or a video nudged past the boundary and
  // straight back stutters.
  it('still waits out the grace period when nothing replaced it', () => {
    vi.useFakeTimers();
    configure({ atOnce: 1 });
    const { video, pause } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    currentObserver().report([[video, 0.4]]);

    expect(pause).not.toHaveBeenCalled();
    vi.advanceTimersByTime(400);
    expect(pause).toHaveBeenCalled();
  });
});

describe("the 'interaction' gate", () => {
  const interact = (): void => {
    window.dispatchEvent(new Event('scroll'));
  };

  it('is the shipped default', () => {
    // Not inherited from the suite setup, which pins 'page-loaded': this asserts
    // what a consumer who configures nothing actually gets.
    resetForTests();
    const { video, play } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    expect(play).not.toHaveBeenCalled();

    interact();
    expect(play).toHaveBeenCalled();
  });

  it('waits for the page as well as the visitor', () => {
    resetForTests();
    setReadyState('loading');
    const { video, play } = makeHarness();
    register(video);

    currentObserver().report([[video, 0.9]]);
    // Interacting first is the ordering that matters: a visitor can scroll
    // before load, and starting then would be worse than 'page-loaded' rather
    // than better.
    interact();
    expect(play).not.toHaveBeenCalled();

    setReadyState('complete');
    window.dispatchEvent(new Event('load'));
    expect(play).toHaveBeenCalled();
  });

  it('lets one video hold out while the rest of the page does not', () => {
    configure({ startWhen: 'page-loaded' });
    const hero = makeHarness();
    const card = makeHarness();
    register(hero.video, { startWhen: 'interaction' });
    register(card.video);

    currentObserver().report([
      [hero.video, 0.9],
      [card.video, 0.9],
    ]);

    expect(card.play).toHaveBeenCalled();
    expect(hero.play).not.toHaveBeenCalled();

    interact();
    expect(hero.play).toHaveBeenCalled();
  });

  it('lets one video start early while the page holds out', () => {
    configure({ startWhen: 'interaction' });
    const { video, play } = makeHarness();
    register(video, { startWhen: 'page-loaded' });

    currentObserver().report([[video, 0.9]]);
    expect(play).toHaveBeenCalled();
  });
});
