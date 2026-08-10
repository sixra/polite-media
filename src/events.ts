/**
 * The events both halves dispatch, and the typing that makes them usable.
 *
 * Three pieces, because no one of them is sufficient on its own:
 *
 * - The **constants**, because a mistyped event name still compiles. lib.dom
 *   declares a fallback `addEventListener(type: string, ...)` overload, so
 *   `'polite-video:redy'` type-checks happily however the maps are augmented.
 * - The **detail**, because these events bubble by design and the useful
 *   listener sits on a container, which makes `event.target` the wrong element
 *   or a bare `EventTarget` needing a cast.
 * - The **augmentation**, so a listener gets `CustomEvent<Detail>` rather than
 *   `Event`.
 *
 * `ElementEventMap` and `DocumentEventMap` are the two that have to be patched,
 * and not the more obvious `HTMLElementEventMap`. lib.dom declares
 * `HTMLElementEventMap extends ElementEventMap`, so augmenting the base reaches
 * `HTMLElement`, `HTMLMediaElement` and `HTMLVideoElement` through inheritance,
 * while augmenting the derived one reaches none of its ancestors. `document` is
 * a separate branch entirely -- `DocumentEventMap extends
 * GlobalEventHandlersEventMap` -- so it needs its own entry.
 */

/** Dispatched on the video once a frame has genuinely painted. Bubbles. */
export const POLITE_VIDEO_READY = 'polite-video:ready';

/** Dispatched on the video when no source could be decoded. Bubbles. */
export const POLITE_VIDEO_FAILED = 'polite-video:failed';

/** Dispatched on the image once it has decoded. Bubbles. */
export const POLITE_IMAGE_READY = 'polite-image:ready';

/**
 * Dispatched on `document` when the user pauses or resumes everything.
 *
 * The odd one out, and deliberately: a user pause is page-wide rather than about
 * one video, so there is no element to dispatch it at and nothing for it to
 * bubble through. Only `DocumentEventMap` is augmented for it.
 *
 * It exists because the alternative for a host is watching `data-polite-paused`
 * on `<html>` with a MutationObserver, which is the same unreasonable ask this
 * library avoids by maintaining `aria-pressed` itself. Without it, the
 * label-swapping control the README offers as an option cannot be built.
 */
export const POLITE_PAUSE_CHANGE = 'polite-video:pausechange';

export interface PoliteVideoEventDetail {
  /**
   * The managed video. Saves casting `event.target`, which is the container
   * rather than the video whenever the listener is on an ancestor.
   */
  video: HTMLVideoElement;
}

export interface PoliteImageEventDetail {
  /** The managed image, for the same reason. */
  image: HTMLImageElement;
}

export interface PolitePauseEventDetail {
  /** True once the user has paused everything, false once they resume. */
  paused: boolean;
}

declare global {
  interface ElementEventMap {
    'polite-video:ready': CustomEvent<PoliteVideoEventDetail>;
    'polite-video:failed': CustomEvent<PoliteVideoEventDetail>;
    'polite-image:ready': CustomEvent<PoliteImageEventDetail>;
  }

  interface DocumentEventMap {
    'polite-video:ready': CustomEvent<PoliteVideoEventDetail>;
    'polite-video:failed': CustomEvent<PoliteVideoEventDetail>;
    'polite-image:ready': CustomEvent<PoliteImageEventDetail>;
    'polite-video:pausechange': CustomEvent<PolitePauseEventDetail>;
  }
}
