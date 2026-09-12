# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org); while
this is `0.x`, a minor bump may still break things and will say so here.

## 0.5.0 (2026-09-12)

### Breaking

- **`data-polite-media` no longer has to be the video's direct parent.** The library writes its
  state to the nearest `[data-polite-media]` ancestor, and `video.css` and `layer.css` match the
  video as a descendant of the box rather than a child. The poster rules are unchanged: a poster is
  still a direct child, so a logo deeper in the box is still left alone. One box holds one video, and
  boxes must not nest, because the box's ready state reveals every video inside it. If your CSS
  extended `[data-polite-media] > video`, drop the `>`.

- **`image.css` hides only lazy images.** An eager image may be the LCP element, and a deferred
  module cannot reveal it before first paint, so the stylesheet now leaves `loading="eager"` (and
  images with no `loading`) alone. To fade one anyway, write `data-polite-reveal="eager"` on it.
  `revealImages()`'s `allowEager` option is ignored and warns, because the opt-in has to be where
  the stylesheet can see it.

### Added

- **`registerAll()` and `revealImages()` take no argument** and default to
  `'[data-polite-media] video'` and `'img[data-polite-reveal]'`, which is what both known consumers
  had written out.

- **`polite-video:blocked`, and `data-polite-blocked` on the box**, while the browser refuses
  `play()` until a gesture. The retry was already there; what was missing was any way for a host to
  know it was waiting, so a play affordance could not be shown. Fires once per refusal, not on every
  retried attempt, and the attribute is removed once playback starts.

### Fixed

- **A pause was lost from `<html>` on a client-side navigation.** A router such as Astro's
  `<ClientRouter />` replaces the root element's attributes with the next document's, and the pause
  state was only written on the first registration of a page load. The videos stayed paused, but
  `data-polite-paused` and a declared `aria-pressed` said otherwise. Both are now re-asserted on
  every `register()`.

- **`polite-video:ready` fired again each time a video scrolled back into view.** The frame was
  still on screen, so nothing had been revealed. It now fires once per reveal; a retraction (reduced
  motion, Save-Data, a source fallback) still announces the re-reveal.

### Documentation

- The README now lists all four places the library changes an element you authored: `preload`
  (twice), `muted`, and `src` plus `load()` when a `<source>` list is resolved.

## 0.4.3 (2026-09-06)

### Fixed

- **An image below the fold arrived without its fade.** The stylesheet's failsafe reveals a marked
  image after `--polite-failsafe` (default `5s`) whatever JavaScript does, and it was firing on
  images `revealImages()` had already claimed. A lazy image that had not loaded yet reached
  `opacity: 1` while still in flight, so when the picture finally arrived there was nothing left to
  fade. Measured on a live page: eleven images revealed that way five seconds in, none of them
  loaded.

  The library now marks an image it owns with `data-polite-managed` and the stylesheet stands down
  for those. A claimed image is safe without the failsafe because the module always resolves one, on
  `decode()` and failing that on `load` or `error`; if a teardown gives up on a claim, the mark is
  removed and the stylesheet takes the image back.

### Added

- **`data-polite-managed` on an `<img>`**, for as long as `revealImages()` owns its reveal. Part of
  the public CSS API like the other attributes the library writes.

## 0.4.2 (2026-09-06)

### Fixed

- **Videos stayed paused after a back-navigation** that restored the page from the back/forward
  cache, until they were scrolled out of view and back in. Playback eligibility is decided from the
  intersection ratio last recorded for each video, and a restore reconciled against a reading taken
  before the page was frozen. Where that reading was "nothing intersects", nothing was eligible and
  nothing played. Each target is now re-observed on a persisted `pageshow`, which is what makes the
  observer report where things actually are.

  Reported in Safari on two sites, with scrolling as the workaround.

## 0.4.1 (2026-09-06)

### Fixed

- **A lazy image stayed blank in Firefox** until the failsafe revealed it five seconds later,
  unfaded. The failsafe animation applied to every marked image, and an animation outranks normal
  declarations in the cascade whatever their specificity, so it decided `opacity` and
  `img[data-polite-reveal][data-polite-ready]` could not. It is now scoped to images that have not
  been revealed yet.

  Eager images were never affected, because they are marked ready inside the same task that applies
  the stylesheet. That is why the existing test passed in every engine: it covered the eager half,
  and asserted the attribute rather than what the pixels did.

## 0.4.0 (2026-09-05)

### Added

- **`data-polite-active` on `<html>`, for as long as any video is registered.**
  Gives CSS a way to show a pause control only on pages that have a video,
  without writing an attribute of your own:

  ```css
  [data-polite-pause-control] {
    display: none;
  }
  [data-polite-active] [data-polite-pause-control] {
    display: inline-flex;
  }
  ```

- **A warning when a second `register()` call's options are discarded.** The
  first registration stands, so a later call cannot change a gate or a policy.
  Quiet when the options match, which is what a client-side router re-running
  the same call on a surviving element does.

- **A warning when `image.css` is not loaded** on a page that marks images with
  `data-polite-reveal`. The attribute has no effect without the stylesheet.

- **The demos are published**, alongside a new landing page:
  <https://sixra.github.io/polite-media/>. Demo pages now reference the build
  and each other relatively, so they work under a path prefix as well as at a
  root.

### Documentation

- How to compose an animation of your own with `data-polite-ready`, including
  the failsafe to pair with it, and how a skipped `content-visibility: auto`
  subtree affects the timing.

- The attribute table covers `data-polite-active`, and the status section says
  where the library is in use.

## 0.3.1 (2026-09-02)

Documentation only. `src/` is identical to 0.3.0; this republishes so the npm
page carries the rewritten README.

## 0.3.0 (2026-09-02)

### Changed

- **Breaking: `playAbove`, `hysteresis` and `pauseGraceMs` are no longer
  options.** All three tuned the same thing, oscillation, and none was a policy a
  caller has a view on. `playAbove` is gone outright; it shipped disabled at `0`.
  The other two keep working at their previous defaults as constants: a video
  leaving the viewport still waits 400ms before stopping, and an incumbent still
  holds the single slot until a rival is 15% more visible. Nine options become
  six.

- **`resetWarmed` is no longer exported from `polite-media/warm`.** It clears the
  dedup record for a test and had no caller outside the suite; the entry point is
  a barrel now, the way `polite-media/video` already was. No published version
  ever carried it.

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
