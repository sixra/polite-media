/**
 * The library's core primitive: fire once a frame has genuinely reached the
 * compositor.
 *
 * The obvious signal, the `playing` event, is wrong -- and measurably wrong in
 * both directions rather than merely early. On one machine in one run
 * (docs/findings.md) H.264 presented its first frame 1.6 ms *before* `playing`,
 * while AV1 presented 0.8 ms *after*. So revealing on `playing` either flashes
 * (poster removed before anything painted) or lingers (poster held over a frame
 * that already painted), and which one you get depends on the codec, so no delay
 * can tune it away.
 *
 * `requestVideoFrameCallback` is specified in terms of a frame being sent to the
 * compositor, making it correct by definition rather than by timing.
 */

/**
 * `HTMLMediaElement.HAVE_CURRENT_DATA`. Inlined rather than read off the global
 * so this module never touches `HTMLMediaElement`, which does not exist in Node.
 */
const HAVE_CURRENT_DATA = 2;

/**
 * Calls `onPainted` once, when a frame is on screen.
 *
 * Returns a cancel function. Cancelling matters: a video can be unregistered
 * (scrolled out of view, a router navigation) before its first frame ever
 * arrives, and a reveal firing afterwards would un-hide a layer whose element is
 * already gone.
 *
 * Cancellation does two things on the two rungs that can still be pending. The
 * `done` flag is the correctness guarantee, so `cancel()` means "will not fire"
 * however the underlying mechanism behaves; the platform call beside it
 * (`cancelVideoFrameCallback`, `removeEventListener`) is resource release. They
 * overlap on the `loadeddata` rung, where removing the listener would be enough
 * on its own -- the price of `cancel()` meaning one thing rather than three
 * subtly different things. On the `readyState` rung there is nothing to cancel:
 * it has already fired synchronously by the time the caller holds the function.
 */
export function revealWhenPainted(video: HTMLVideoElement, onPainted: () => void): () => void {
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    onPainted();
  };

  // lib.dom declares requestVideoFrameCallback as always present, but it is only
  // Baseline as of October 2024, so the types are more optimistic than reality
  // and the runtime check is doing real work on older browsers.
  if (typeof video.requestVideoFrameCallback === 'function') {
    const handle = video.requestVideoFrameCallback(fire);
    return () => {
      done = true;
      video.cancelVideoFrameCallback(handle);
    };
  }

  // Both fallbacks are strictly weaker signals. HAVE_CURRENT_DATA means "data
  // exists for the current playback position", which is a decode-side fact and
  // says nothing about whether pixels have been presented. Accepted only because
  // the alternative on these browsers is no reveal at all.
  if (video.readyState >= HAVE_CURRENT_DATA) {
    fire();
    return () => {
      done = true;
    };
  }

  video.addEventListener('loadeddata', fire, { once: true });
  return () => {
    done = true;
    video.removeEventListener('loadeddata', fire);
  };
}
