/**
 * @module
 * Image reveal. Independent of the video module by design: an image needs no
 * IntersectionObserver, no source negotiation and no playback arbitration, and
 * it is not skipped on a metered connection the way video is -- you still have
 * to show the picture.
 *
 * The point is the same as the video module's, applied to a different signal:
 * reveal when pixels are ready, not when bytes arrived. `load` fires *before*
 * decode, so fading on it can start against an undecoded bitmap and hitch.
 * `HTMLImageElement.decode()` resolves when the image is actually paintable,
 * which is the image analogue of requestVideoFrameCallback.
 *
 * Reduced motion is handled entirely in image.css: the image still reveals, it
 * just does so instantly. No JS gate, because "show the picture without
 * animating" is a pure styling concern.
 */

import { POLITE_IMAGE_READY, type PoliteImageEventDetail } from './events.js';
import { resolveTargets, type Target } from './targets.js';

/** Anything that names one or more images. See {@link Target}. */
export type ImageTarget = Target<HTMLImageElement>;

export interface RevealImagesOptions {
  /**
   * Manage images that are not `loading="lazy"`.
   *
   * Off by default because LCP excludes elements at `opacity: 0`, and revealing
   * one does not restore its candidacy -- so fading an eager, above-the-fold
   * image can forfeit the metric it was meant to improve. A lazy image was never
   * an LCP candidate, so the default is risk-free.
   *
   * Turning this on is legitimate and sometimes right: an eager grid that would
   * otherwise cut from its backdrop to the photo on whatever frame the async
   * decode lands looks worse without a fade. It just has to be a decision rather
   * than an accident.
   */
  allowEager?: boolean;
}

const READY = 'data-polite-ready';

function markReady(image: HTMLImageElement): void {
  image.setAttribute(READY, '');
  image.dispatchEvent(
    new CustomEvent<PoliteImageEventDetail>(POLITE_IMAGE_READY, {
      bubbles: true,
      detail: { image },
    })
  );
}

/**
 * Every image this module has taken responsibility for.
 *
 * A WeakSet rather than an attribute: the stylesheet no longer needs to know
 * which images are managed, so writing it into the DOM would be state kept for
 * nobody. Weak so a released image is not pinned by the bookkeeping.
 */
const managed = new WeakSet<HTMLImageElement>();

let unmanagedCheck: ReturnType<typeof setTimeout> | undefined;

/**
 * The failsafe in image.css keeps a stray image from vanishing, but silently.
 * This is the half a developer can act on: it names the element and says which
 * of the two mistakes was made.
 *
 * Debounced rather than run per call, because several `revealImages()` calls
 * with different selectors are a normal way to set a page up and an image is
 * only stray once all of them have had their chance. Rescheduling also means a
 * client-side navigation gets its own check instead of one per page lifetime,
 * which a once-only flag would have given.
 */
function scheduleUnmanagedCheck(): void {
  clearTimeout(unmanagedCheck);
  unmanagedCheck = setTimeout(() => {
    for (const image of document.querySelectorAll<HTMLImageElement>('img[data-polite-reveal]')) {
      if (managed.has(image)) continue;
      console.warn(
        'polite-media: no revealImages() call manages this image, so the failsafe revealed ' +
          'it late and unfaded. Widen the selector, or drop data-polite-reveal.',
        image
      );
      return;
    }
  }, 1000);
}

/**
 * Reveals each matching image once it has decoded.
 *
 * Returns a function that stops any reveals still pending, for a client-side
 * router tearing the page down before the images resolved.
 */
export function revealImages(target: ImageTarget, options: RevealImagesOptions = {}): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  scheduleUnmanagedCheck();

  for (const image of resolveTargets(target)) {
    managed.add(image);
    // Eager images are revealed at once rather than skipped.
    //
    // Skipping looks like the cautious choice and is the opposite: image.css
    // has already hidden anything carrying data-polite-reveal, so declining to
    // manage it leaves it invisible permanently instead of merely unfaded.
    // Revealing immediately keeps the LCP candidate visible from its first
    // paint, which is the whole reason eager images are treated differently.
    //
    // Tested against 'lazy' rather than for 'eager' deliberately. Engines
    // disagree on what an absent or invalid attribute reports: MDN documents
    // only 'eager' and 'lazy', while happy-dom returns 'auto'. Only "lazy" has
    // one agreed spelling, so asking whether it is lazy is answerable
    // everywhere, and everything else correctly falls into the eager branch.
    if (!options.allowEager && image.loading !== 'lazy') {
      markReady(image);
      continue;
    }

    // A cached image is frequently already decoded before this module runs at
    // all -- these are deferred scripts. Revealing on the next frame rather than
    // synchronously lets the browser paint the hidden state first, so the
    // transition still runs instead of snapping.
    if (image.complete && image.naturalWidth > 0) {
      requestAnimationFrame(() => {
        if (!signal.aborted) markReady(image);
      });
      continue;
    }

    image
      .decode()
      .then(() => {
        if (!signal.aborted) markReady(image);
      })
      .catch(() => {
        // decode() rejects with EncodingError when `src` changes mid-flight,
        // which a responsive `srcset` genuinely does on resize, and on a real
        // decode failure. Either way the image must not be left hidden: `load`
        // is the weaker signal, and no reveal at all is worse than an early one.
        if (signal.aborted) return;
        if (image.complete) {
          markReady(image);
          return;
        }
        image.addEventListener('load', () => markReady(image), { once: true, signal });
        image.addEventListener('error', () => markReady(image), { once: true, signal });
      });
  }

  return () => controller.abort();
}

// Re-exported so `polite-media/image` carries the ElementEventMap and
// DocumentEventMap augmentation too: it only reaches a consumer whose program
// includes the module that declares it.
export { POLITE_IMAGE_READY, type PoliteImageEventDetail } from './events.js';
