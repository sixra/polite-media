import { describe, expect, it, vi } from 'vitest';
import { revealWhenPainted } from '../src/reveal.js';

/**
 * Metadata the browser hands the rVFC callback. Built out in full rather than
 * cast, so it stays honest about the shape real callers receive. `mediaTime: 0`
 * and `presentedFrames: 1` are the values actually observed for a first frame in
 * the Playwright spike.
 */
const FIRST_FRAME: VideoFrameCallbackMetadata = {
  expectedDisplayTime: 0,
  presentationTime: 0,
  mediaTime: 0,
  presentedFrames: 1,
  width: 1280,
  height: 720,
};

/**
 * happy-dom has no media pipeline, so `readyState` is faked and rVFC is attached
 * by hand -- happy-dom's HTMLVideoElement does not implement it, which is what
 * lets the same helper exercise the fallback rungs by simply not attaching it.
 * Real frame timing is asserted in the Playwright suite; what is under test here
 * is only which rung of the chain gets chosen.
 */
function makeVideo(opts: { rvfc?: boolean; readyState?: number } = {}): {
  video: HTMLVideoElement;
  fireFrame: () => void;
  cancelled: number[];
} {
  const video = document.createElement('video');
  Object.defineProperty(video, 'readyState', {
    value: opts.readyState ?? 0,
    configurable: true,
  });

  let pending: VideoFrameRequestCallback | null = null;
  const cancelled: number[] = [];

  if (opts.rvfc) {
    video.requestVideoFrameCallback = (cb) => {
      pending = cb;
      return 1;
    };
    // Deliberately records the handle without disarming `pending`, so
    // `fireFrame()` still invokes the callback after a cancel. A fake that
    // nulled `pending` here would make the cancellation tests pass on the fake's
    // own behaviour rather than the implementation's -- verified by mutation:
    // with the disarming fake, deleting `done = true` from cancel left the suite
    // green.
    video.cancelVideoFrameCallback = (handle) => {
      cancelled.push(handle);
    };
  }

  return { video, fireFrame: () => pending?.(0, FIRST_FRAME), cancelled };
}

describe('revealWhenPainted', () => {
  it('prefers rVFC and waits for a presented frame', () => {
    const { video, fireFrame } = makeVideo({ rvfc: true, readyState: 4 });
    const onPainted = vi.fn();

    revealWhenPainted(video, onPainted);
    // readyState is already 4; a lesser implementation would fire here. Waiting
    // for the frame is the entire point.
    expect(onPainted).not.toHaveBeenCalled();

    fireFrame();
    expect(onPainted).toHaveBeenCalledOnce();
  });

  it('falls back to readyState when rVFC is unavailable', () => {
    const { video } = makeVideo({ readyState: 2 });
    const onPainted = vi.fn();

    revealWhenPainted(video, onPainted);
    expect(onPainted).toHaveBeenCalledOnce();
  });

  it('falls back to loadeddata when nothing is buffered yet', () => {
    const { video } = makeVideo({ readyState: 0 });
    const onPainted = vi.fn();

    revealWhenPainted(video, onPainted);
    expect(onPainted).not.toHaveBeenCalled();

    video.dispatchEvent(new Event('loadeddata'));
    expect(onPainted).toHaveBeenCalledOnce();
  });

  // Outcome-level: asserts that *something* prevents a second call, without
  // claiming which. Both `{ once: true }` and the `done` flag independently
  // suffice here, so this stays green if either is removed alone.
  it('never fires twice on repeated loadeddata', () => {
    const { video } = makeVideo({ readyState: 0 });
    const onPainted = vi.fn();

    revealWhenPainted(video, onPainted);
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('loadeddata'));
    expect(onPainted).toHaveBeenCalledOnce();
  });

  // A video can be unregistered before its first frame ever arrives (scrolled
  // away, router navigation). A reveal firing then would un-hide a layer whose
  // element is already gone.
  it('cancel stops a pending rVFC reveal', () => {
    const { video, fireFrame, cancelled } = makeVideo({ rvfc: true });
    const onPainted = vi.fn();

    const cancel = revealWhenPainted(video, onPainted);
    cancel();
    fireFrame();

    expect(onPainted).not.toHaveBeenCalled();
    expect(cancelled).toEqual([1]);
  });

  it('cancel stops a pending loadeddata reveal', () => {
    const { video } = makeVideo({ readyState: 0 });
    const onPainted = vi.fn();

    const cancel = revealWhenPainted(video, onPainted);
    cancel();
    video.dispatchEvent(new Event('loadeddata'));

    expect(onPainted).not.toHaveBeenCalled();
  });
});
