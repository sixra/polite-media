# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org); while
this is `0.x`, a minor bump may still break things and will say so here.

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

- **`startWhen: 'interaction'`.** Video waits for the visitor's first pointer, key
  or scroll, which keeps it out of Largest Contentful Paint. Set `'page-loaded'`
  for autoplay on arrival.
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
