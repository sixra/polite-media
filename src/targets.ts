/**
 * @module
 * How both halves name the elements they act on, so `revealImages('.card img')`
 * and `registerAll('[data-polite-media] video')` mean the same thing rather than
 * being two similar-looking ideas.
 */

/**
 * Anything that names one or more elements: a selector, a single element, or any
 * collection of them.
 *
 * `ArrayLike` is listed alongside `Iterable` deliberately. `NodeListOf` and
 * `HTMLCollectionOf` are iterable at runtime, but their `[Symbol.iterator]` lives
 * in `lib.dom.iterable`, so a consumer whose `lib` omits it cannot pass
 * `document.querySelectorAll('img')` to an `Iterable`-only parameter even though
 * it works. `ArrayLike` is structural and needs no `lib` support.
 */
export type Target<T extends Element> = string | T | ArrayLike<T> | Iterable<T>;

/** Resolves a {@link Target} to the elements it names. */
export function resolveTargets<T extends Element>(target: Target<T>): T[] {
  if (typeof target === 'string') return [...document.querySelectorAll<T>(target)];
  // A single element is the obvious thing to pass when you already hold one, and
  // it used to be rejected: `revealImages(myImg)` did not compile.
  if (target instanceof Element) return [target as T];
  return Array.from(target as ArrayLike<T>);
}
