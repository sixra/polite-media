# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org); while
this is `0.x`, a minor bump may still break things and will say so here.

## Unreleased

### Changed

- **Breaking: `playAbove`, `hysteresis` and `pauseGraceMs` are no longer
  options.** All three tuned the same thing, oscillation, and none was a policy a
  caller has a view on. `playAbove` is gone outright; it shipped disabled at `0`.
  The other two keep working at their previous defaults as constants: a video
  leaving the viewport still waits 400ms before stopping, and an incumbent still
  holds the single slot until a rival is 15% more visible. Nine options become
  six.

### Fixed

- **A pause now survives a navigation.** It is kept in `sessionStorage`, so on a
  multi-page site the motion stays stopped as the visitor clicks through. It was
  a module-level flag, which died with the document, so someone who stopped the
  motion was asked to stop it again on every page.

## 0.2.0 (2026-08-11)

### Changed

- **Breaking: `startWhen` now defaults to `'page-loaded'`, was `'interaction'`.**
  A video plays on its own once `window`'s `load` event has fired, rather than
  waiting for the visitor's first pointer, key or scroll. The old default meant a
  visitor who read a desktop page without scrolling saw a still poster for as
  long as they stayed. The cost is that a hero is once again a Largest Contentful
  Paint candidate; set `startWhen: 'interaction'`, per video or globally, to take
  that back.

### Added

- `polite-media/warm`, a third entry point. Fetches the image the next page will
  show while the visitor is still deciding to go there, since document
  prefetchers fetch the HTML and stop.
- `warm(options)` warms one image; `warmOnIntent(selector, resolve)` does it on
  hover, focus or touch, delegated on the document, and returns a teardown.
- Candidates are given as `sources`, `srcset`, `src` and `sizes`, mirroring
  `<picture>`.

### Notes

- **Nothing in the package parses `sizes`.** The candidates are assembled as a
  detached `<picture>` and the browser selects, so warming cannot disagree with
  what the destination renders.
- No `<link>` hint is injected. A detached image both selects and fetches, which
  avoids `rel="prefetch"` being unsupported in Safari and aborted in Firefox
  without a cache header.
- Skipped on Save-Data and 2g, deduped per candidate set, and fetched at
  `fetchpriority="low"`.
- The image entry point is untouched. The only video change is the `startWhen`
  default above.

## 0.1.0 (2026-08-11)

First release.

### Added

- `polite-media/video`. Reveals a background video on its first genuinely
  presented frame via `requestVideoFrameCallback`, plays only what is on screen,
  limits how many run at once, falls through the `<source>` list when a codec
  cannot be decoded, honours `prefers-reduced-motion` and Save-Data, recovers
  from bfcache restores and refused autoplay, and ships a pause hook for
  [WCAG 2.2.2][wcag].
- `polite-media/image`. Reveals an image once `decode()` resolves, rather than on
  `load`, which fires before the pixels exist.
- Three optional stylesheets. `video.css` and `image.css` handle timing and set no
  geometry; `layer.css` handles the standard poster-over-video stacking.
- `configure()` options: `startWhen`, `requireBuffered`, `atOnce`,
  `smallViewport`, `hysteresis`, `pauseBelow`, `playAbove`, `pauseGraceMs` and
  `prefetchMargin`. The README explains what each does and when to reach for it.
- Per-video options at `register()`: `until`, `observe` and `startWhen`.
- `registerAll()`, `unregister()`, `unregisterAll()`, `pauseAll()`, `resumeAll()`.
- Events `polite-video:ready`, `polite-video:failed`, `polite-video:pausechange`
  and `polite-image:ready`, with exported name constants.
- A reveal failsafe, so a marked image can never stay hidden if nothing reveals
  it. Tunable with `--polite-failsafe`, default `5s`.
- Console warnings for the misconfigurations that are otherwise silent: markup
  that gives the reveal nothing to act on, a looping video with no pause control,
  a video too tall to reach its start threshold, an image nothing manages, and a
  `<source>` list that no viewport claims.

### Defaults worth knowing

- **`startWhen: 'interaction'`.** Video fetches once `window`'s `load` event has
  fired and plays once the visitor's first pointer, key or scroll follows, which
  keeps it out of Largest Contentful Paint entirely. (Changed in 0.2.0.)
- **`--polite-fade: 0s` for video, a cut.** Images default to `350ms`. Scope the
  property to one container to give that video its own fade.
- **`atOnce: { small: 1, large: 'all' }`.** One video at a time on small
  viewports, all of them elsewhere.
- **`pauseBelow: 0.5`.** A video stops once less than half of it is on screen.
  This caps how tall a managed video can be at about twice the viewport.

### Notes

- The box carrying `data-polite-media` must be the video's **direct parent**.
- Client-side routers need `register()` re-run per navigation.
- ESM only, for browsers. There is no CommonJS entry point.

[wcag]: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
