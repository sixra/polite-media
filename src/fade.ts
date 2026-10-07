/**
 * Warns, and returns true, when `--polite-fade` on an element is set to something that is not a CSS
 * time. Such a value computes to `0s` rather than to the stylesheet's fallback, so `0.6` silently
 * removes image.css's 350ms fade.
 *
 * Parsed by the browser rather than a pattern, which would reject a valid `calc(0.3s * 2)`. A bare
 * `0` passes: it gives the cut its author meant, and a warning on working code teaches people to
 * ignore the rest.
 */
export function warnIfFadeInvalid(element: Element): boolean {
  const value = getComputedStyle(element).getPropertyValue('--polite-fade').trim();
  if (value === '' || value === '0' || CSS.supports('transition-duration', value)) return false;

  console.warn(
    `polite-media: --polite-fade "${value}" is not a CSS time, so nothing fades. Give it a unit.`,
    element
  );
  return true;
}
