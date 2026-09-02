/**
 * @module
 * Warming a destination page's image before the visitor gets there, so the click
 * lands on a picture that is already in the cache.
 *
 * Every document prefetcher fetches the HTML and stops: Astro's `data-astro-prefetch`,
 * Next's `<Link>`, quicklink. The image inside that HTML is discovered only after
 * the new document parses, which is exactly when it is too late to matter.
 *
 * The platform has the pieces but not in one place. `imagesrcset` and `imagesizes`
 * do responsive selection, but MDN scopes them to `rel="preload"` with `as="image"`
 * only, and scopes preload itself to resources "your page will need very soon". A
 * speculative navigation wants `prefetch` semantics, where those attributes do not
 * apply. So you can have the right selection or the right timing, not both, and
 * anyone who wants both ends up re-implementing the browser's own rules in JS:
 * parsing `sizes`, comparing `w` descriptors, guessing format support.
 *
 * This module does none of that. It builds the candidates as a detached
 * `<picture>` and lets the browser choose, which is measurably the same algorithm
 * the destination page will run (e2e/warm.spec.ts, all three engines). Nothing
 * here parses a media query, so nothing here can disagree with one.
 *
 * A detached `<img>` also *fetches* what it selects, so no `<link>` is injected at
 * all. That sidesteps the two documented failures of the link approach: Safari
 * does not support `<link rel="prefetch">`, and Firefox aborts it with
 * NS_BINDING_ABORTED when the response carries no explicit cache header.
 *
 * Not an image pipeline. It generates no URLs and knows no widths; it warms the
 * candidates you already build.
 */

import { connectionAllowsMedia } from './env.js';

/** One `<picture>` candidate: a format, and the variants available in it. */
export interface WarmSource {
  /** A MIME type such as `image/avif`. Omitted means "always a candidate". */
  type?: string;
  srcset: string;
}

export interface WarmOptions {
  /** Ordered, first supported wins, exactly as `<source>` children behave. */
  sources?: WarmSource[];
  srcset?: string;
  /** A single URL, for an image with no variants. */
  src?: string;
  /** Handed to the browser verbatim. Nothing in this package parses it. */
  sizes?: string;
}

const warmed = new Set<string>();

/**
 * Images with a fetch still in flight.
 *
 * A detached element is reachable from nothing once this function returns, and a
 * collected image would be an aborted fetch. Precautionary rather than a fix for
 * something observed: no engine was seen dropping one. It is cheap, and the bug
 * it forecloses would be silent and load dependent, which is the kind no test
 * here would catch.
 */
const inFlight = new Set<HTMLImageElement>();

/**
 * Deduped on what the caller asked for rather than on the URL the browser picks,
 * because the URL is not known until selection has already happened, and the
 * repeat this exists to stop is the same link hovered twice.
 */
function keyOf(options: WarmOptions): string {
  const sources = (options.sources ?? []).map((source) => `${source.type ?? ''}|${source.srcset}`);
  // Joined on NUL rather than a newline: a srcset spanning several lines is
  // ordinary formatting, and would otherwise let two different candidate sets
  // build the same key and silently drop the second warm.
  return [...sources, options.srcset ?? '', options.src ?? '', options.sizes ?? ''].join('\0');
}

/** Warms one image: selects the variant this browser would request, and fetches it. */
export function warm(options: WarmOptions): void {
  // Speculative bytes are the first thing to drop on a metered connection. Astro
  // downgrades to its `tap` strategy here rather than skipping; for an image
  // nobody has asked for yet, not spending them at all is the better trade.
  if (!connectionAllowsMedia()) return;

  const sources = options.sources ?? [];
  // Checked before anything is built, so an empty call allocates nothing, and
  // before `warmed` is touched, so it cannot make a later correct call a no-op.
  if (sources.length === 0 && !options.srcset && !options.src) {
    console.warn(
      'polite-media: warm() was given no src, srcset or sources, so nothing was warmed.'
    );
    return;
  }

  const key = keyOf(options);
  if (warmed.has(key)) return;

  const picture = document.createElement('picture');
  for (const source of sources) {
    const element = document.createElement('source');
    if (source.type) element.type = source.type;
    element.srcset = source.srcset;
    picture.append(element);
  }

  const img = document.createElement('img');
  picture.append(img);
  // The visitor has not asked for this image and may never ask. It must not
  // compete with the page they are actually looking at.
  img.fetchPriority = 'low';
  if (options.sizes) img.sizes = options.sizes;
  if (options.srcset) img.srcset = options.srcset;
  if (options.src) img.src = options.src;

  warmed.add(key);
  inFlight.add(img);
  const settled = (): void => void inFlight.delete(img);
  img.addEventListener('load', settled, { once: true });
  img.addEventListener('error', settled, { once: true });
}

/**
 * The events that mean "about to navigate". `pointerover` and `focusin` cover
 * Astro's documented `hover` strategy, "when you hover over or focus on the
 * link"; `touchstart` covers the touch case, where a hover never happens.
 */
const INTENT_EVENTS = ['pointerover', 'focusin', 'touchstart'] as const;

/**
 * Warms whatever `resolve` names when the visitor shows intent toward `selector`.
 *
 * Delegated on the document, so links added later are covered without rebinding
 * and one listener serves a whole grid. `resolve` returns the candidates rather
 * than the library inventing a `data-*` vocabulary for them: where an app keeps
 * its srcsets is the app's business.
 *
 * Returns a teardown. Listeners on `document` survive a `<ClientRouter />` swap,
 * so a caller that re-binds per navigation stacks duplicates without one.
 */
export function warmOnIntent(
  selector: string,
  resolve: (element: Element) => WarmOptions | null | undefined
): () => void {
  const onIntent = (event: Event): void => {
    const element = (event.target as Element | null)?.closest?.(selector);
    if (!element) return;
    const options = resolve(element);
    if (options) warm(options);
  };

  for (const type of INTENT_EVENTS) {
    document.addEventListener(type, onIntent, { passive: true });
  }
  return () => {
    for (const type of INTENT_EVENTS) document.removeEventListener(type, onIntent);
  };
}

/** Drops the dedup record so a test can warm the same thing twice. Not public API. */
export function resetWarmed(): void {
  warmed.clear();
  inFlight.clear();
}
