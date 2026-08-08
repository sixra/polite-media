import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv } from '../src/env.js';
import {
  configure,
  inspect,
  pauseAll,
  register,
  resumeAll,
  unregister,
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

  constructor(private readonly callback: IntersectionObserverCallback) {
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

function currentObserver(): FakeIntersectionObserver {
  const last = FakeIntersectionObserver.instances.at(-1);
  if (!last) throw new Error('no IntersectionObserver was constructed');
  return last;
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
  const poster = document.createElement('img');
  const video = document.createElement('video');
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

beforeEach(() => {
  reduceMotion = false;
  smallViewport = false;
  FakeIntersectionObserver.instances = [];
  vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query.includes('prefers-reduced-motion')
      ? reduceMotion
      : query.includes('max-width')
        ? smallViewport
        : false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
  Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
});

afterEach(() => {
  unregisterAll();
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

    currentObserver().report([[video, 0.6]]);
    expect(play).toHaveBeenCalled();
  });

  it('marks the container ready once a frame has painted', () => {
    const { video, container } = makeHarness();
    register(video);
    currentObserver().report([[video, 0.6]]);
    // On the container, not the video: the poster is an earlier sibling and CSS
    // cannot style backwards.
    expect(container.hasAttribute('data-polite-ready')).toBe(true);
  });

  it('pauses after the grace period once fully offscreen', () => {
    vi.useFakeTimers();
    const { video, pause } = makeHarness();
    configure({ pauseGraceMs: 400 });
    register(video);

    currentObserver().report([[video, 0.6]]);
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

    // Code 3 is what Chromium reported for the truncated AV1 fixture, and the
    // shape Apple hardware produces when canPlayType claims AV1 it cannot
    // decode (docs/findings.md).
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
    const { video, container } = makeHarness();
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
    expect(container).toBeTruthy();
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

describe('mobile arbitration', () => {
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
    currentObserver().report([
      [a.video, 0.3],
      [b.video, 0.9],
    ]);

    expect(b.play).toHaveBeenCalled();
    expect(a.pause).toHaveBeenCalled();
  });

  it('never starts a video on a small viewport in poster mode', () => {
    smallViewport = true;
    configure({ mobile: 'poster' });
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
