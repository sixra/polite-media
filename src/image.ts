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
   * @deprecated Ignored since 0.5, and warns. image.css no longer hides an eager
   * image at all, so the opt-in has to be in the markup where the stylesheet can
   * see it: `data-polite-reveal="eager"` on the image.
   */
  allowEager?: boolean;
}

const READY = 'data-polite-ready';
/** Written while this module owns an image's reveal, so image.css can stand down. */
const MANAGED = 'data-polite-managed';

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
    warnIfUnstyled();
  }, 1000);
}

let warnedNoStylesheet = false;
let warnedAllowEager = false;

/**
 * image.css is the only thing that hides a marked image. Without it `data-polite-reveal` is inert:
 * the image is never hidden, so it never fades and everything this module does is invisible.
 *
 * Bundlers make that easy to get wrong in one direction. A production build usually bundles every
 * component's CSS site-wide, so a stylesheet imported anywhere covers everywhere, while a dev
 * server serves it per component and does not. The result is a fade that works in a build and is
 * missing in dev, on exactly the pages that do not render whichever component happened to import
 * it.
 *
 * Measured on a throwaway element rather than on a real one, which is not a detail. Reading
 * computed style off an image the library is mid-way through revealing forces a style flush before
 * `data-polite-ready` lands, and Firefox then holds the failsafe animation's pre-delay value and
 * leaves the image at `opacity: 0` for five seconds. A diagnostic must not be able to change what
 * the page does.
 */
function warnIfUnstyled(): void {
  if (warnedNoStylesheet) return;

  // Attached, because computed style against a stylesheet needs the element in the document, and
  // removed in this same task so nothing paints it and no scan above ever sees it.
  const probe = document.createElement('img');
  probe.setAttribute('data-polite-reveal', '');
  // The stylesheet hides only lazy images, so an eager probe would read as unstyled everywhere.
  probe.setAttribute('loading', 'lazy');
  document.body.appendChild(probe);
  const opacity = getComputedStyle(probe).opacity;
  probe.remove();

  // Only an explicit '1' is evidence of absence. An environment that reports '' knows nothing about
  // the cascade -- happy-dom does, and does not implement `@media (scripting: enabled)` either --
  // and a warning nobody can act on is worse than a missing one.
  if (opacity !== '1') return;

  warnedNoStylesheet = true;
  console.warn(
    'polite-media: image.css is not in effect, so data-polite-reveal does nothing and marked ' +
      "images will not fade. Import 'polite-media/image.css' from wherever the attribute is emitted."
  );
}

/**
 * Reveals each matching image once it has decoded. With no target it takes every
 * marked image on the page.
 *
 * Returns a function that stops any reveals still pending, for a client-side
 * router tearing the page down before the images resolved.
 */
export function revealImages(
  target: ImageTarget = 'img[data-polite-reveal]',
  options: RevealImagesOptions = {}
): () => void {
  const controller = new AbortController();
  const { signal } = controller;

  if (options.allowEager && !warnedAllowEager) {
    warnedAllowEager = true;
    console.warn(
      'polite-media: allowEager is ignored. To fade an eager image, put ' +
        'data-polite-reveal="eager" on it, where the stylesheet can see the choice.'
    );
  }

  scheduleUnmanagedCheck();

  const claimed: HTMLImageElement[] = [];

  for (const image of resolveTargets(target)) {
    managed.add(image);
    // Tells the stylesheet to leave this one alone. The failsafe there is for images nothing
    // reveals, and firing it on one this module owns is worse than not firing it at all: opacity
    // reaches 1 while the picture is still in flight, so when it arrives there is no fade left to
    // run. Measured on a real page, eleven below-the-fold images were revealed that way five
    // seconds in, none of them loaded.
    image.setAttribute(MANAGED, '');
    claimed.push(image);
    // An eager image is never hidden by image.css, because LCP excludes elements at
    // opacity 0 and a deferred module cannot reveal one before first paint. So it
    // is marked ready at once, unless the markup opted it into the fade with the
    // same value the stylesheet keys on.
    //
    // Tested against 'lazy' rather than for 'eager' deliberately. Engines
    // disagree on what an absent or invalid attribute reports: MDN documents
    // only 'eager' and 'lazy', while happy-dom returns 'auto'. Only "lazy" has
    // one agreed spelling, so asking whether it is lazy is answerable
    // everywhere, and everything else correctly falls into the eager branch.
    const optedIn = image.getAttribute('data-polite-reveal') === 'eager';
    if (!optedIn && image.loading !== 'lazy') {
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

  // Hands anything still unrevealed back to the stylesheet. A router tearing the page down before
  // the images resolved would otherwise leave them owned by a module that has stopped listening,
  // and with the failsafe suppressed that is hidden forever rather than merely unfaded.
  return () => {
    controller.abort();
    for (const image of claimed) {
      if (!image.hasAttribute(READY)) image.removeAttribute(MANAGED);
    }
  };
}

// Re-exported so `polite-media/image` carries the ElementEventMap and
// DocumentEventMap augmentation too: it only reaches a consumer whose program
// includes the module that declares it.
export { POLITE_IMAGE_READY, type PoliteImageEventDetail } from './events.js';
