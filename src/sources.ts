import { mediaQuery } from './env.js';

/**
 * Picks which `<source>` a video actually loads, and moves on when one turns out
 * to be undecodable.
 *
 * Two problems, one mechanism.
 *
 * `<source media>` is evaluated once, during resource selection, and never
 * again -- in every engine, not just Safari. Verified in Chromium: after loading
 * at 1200px, resizing to 500px left `currentSrc` on the wide source even though
 * the narrow query then matched. The spec has no hook for it, since resource
 * selection only re-runs when `src` or the `<source>` children change. So a
 * source list alone cannot respond to a viewport that moved since parse.
 * Resolving the list here and assigning `video.src` directly sidesteps that
 * entirely: one assignment, no negotiation left to go stale.
 *
 * And `canPlayType` is only ever a claim. The HTML Standard sets the bar at the
 * user agent being "confident that the type represents a media resource that it
 * can render", and confidence is not a guarantee: in this project's own fixtures
 * (docs/findings.md) Chromium answered "probably" for AV1 and then failed at
 * `dav1d_send_data()`. So the codec check only drops the flat "no" answers;
 * among what survives, document order sets the try order and the `error` event
 * decides the outcome.
 *
 * Deliberately *not* re-selecting on resize. Reassigning `src` restarts
 * playback from frame 0, so a phone rotating mid-scroll would visibly rewind the
 * video. The first choice sticks for the page's lifetime.
 */

/** `MediaError.MEDIA_ERR_DECODE` and `MEDIA_ERR_SRC_NOT_SUPPORTED`. */
const MEDIA_ERR_DECODE = 3;
const MEDIA_ERR_SRC_NOT_SUPPORTED = 4;

/**
 * Whether an error means "this file is unusable, try another" as opposed to
 * "something happened to this attempt".
 *
 * Codes matter here. `MEDIA_ERR_ABORTED` (1) is what the element reports when
 * its `src` is reassigned -- which this module does itself -- so treating every
 * error as fatal would cascade through the whole candidate list on the first
 * assignment. `MEDIA_ERR_NETWORK` (2) means the fetch failed on a resource that
 * was previously fine; another candidate is unlikely to fare better on the same
 * connection, and burning the list would leave nothing to retry with.
 */
export function isUnusable(error: MediaError | null): boolean {
  if (!error) return false;
  return error.code === MEDIA_ERR_DECODE || error.code === MEDIA_ERR_SRC_NOT_SUPPORTED;
}

export interface SourceManager {
  /** Loads the best remaining candidate. False when none are left to try. */
  select(): boolean;
  /** Discards the current candidate and loads the next. False when exhausted. */
  advance(): boolean;
}

function candidatesFor(video: HTMLVideoElement): { declared: number; playable: string[] } {
  // `:scope >` so a <source> belonging to some nested media element is never
  // mistaken for this one's.
  const sources = [...video.querySelectorAll<HTMLSourceElement>(':scope > source')];

  const playable = sources
    .filter((source) => {
      // The attribute, not the property: `.src` resolves against the document
      // base, so `<source src="">` comes back as the page's own URL -- truthy,
      // and it would then be handed to the video as if it were a media file.
      if (!source.getAttribute('src')) return false;
      const media = source.getAttribute('media');
      // An unmatched media query removes the candidate entirely: it describes a
      // viewport this page is not in.
      if (media && !mediaQuery(media).matches) return false;
      // Empty string is the only definite "no" canPlayType offers. "maybe" is
      // kept, because "maybe" is what browsers say about most things.
      return !source.type || video.canPlayType(source.type) !== '';
    })
    .map((source) => source.src);

  return { declared: sources.length, playable };
}

export function manageSources(video: HTMLVideoElement): SourceManager {
  const { declared, playable: candidates } = candidatesFor(video);
  let index = -1;

  const load = (): boolean => {
    const next = candidates[index];
    if (next === undefined) return false;
    video.src = next;
    // Required: assigning `src` alone does not restart resource selection on an
    // element that has already loaded.
    video.load();
    return true;
  };

  return {
    select(): boolean {
      // "No <source> children at all" and "sources were declared but none
      // qualified" are different situations and must not share a branch. The
      // first is a video authored with a plain `src` -- somebody else's
      // arrangement, left exactly as it is. The second is a video with nothing
      // playable, which has to report failure so the poster stays and the host
      // is told.
      if (declared === 0) return Boolean(video.currentSrc || video.getAttribute('src'));
      // Re-checked rather than assumed: a first select() that found nothing
      // playable still advanced the index, so answering a later call with a bare
      // `true` would report success for a video that never loaded anything.
      if (index >= 0) return candidates[index] !== undefined;
      index = 0;
      return load();
    },
    advance(): boolean {
      index += 1;
      return load();
    },
  };
}
