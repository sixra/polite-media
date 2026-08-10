# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org); while
this is `0.x`, a minor bump may still break things and will say so here.

## 0.1.0

First release.

### Added

- `polite-media/video` — reveals a background video on its first genuinely
  presented frame via `requestVideoFrameCallback`, plays only what is on screen,
  arbitrates so only as many play at once as `atOnce` allows, falls through the
  `<source>` list when a codec cannot be decoded, honours `prefers-reduced-motion`
  and Save-Data live, recovers from bfcache restores and blocked autoplay, and
  ships a pause hook for [WCAG 2.2.2][wcag].
- `polite-media/image` — reveals an image once `decode()` resolves, rather than on
  `load`, which fires before the pixels exist.
- Optional stylesheets, `polite-media/video.css` and `polite-media/image.css`.
  Timing only: neither sets a width, height or aspect ratio.
- A console warning when a video's parent carries no `data-polite-media` and
  nothing else hides the video, because that misconfiguration is otherwise
  completely silent — the library looks installed while doing nothing.
- `polite-video:pausechange` on `document`, with `detail: { paused: boolean }`.
  Without it the label-swapping pause control the README offers as an option
  could not be built: the only other signal is `data-polite-paused` on `<html>`,
  and watching that means a MutationObserver on the root for one boolean. Fires
  only on real transitions, including the reset inside `unregisterAll()`, so a
  host mirroring the state is never left holding a stale button.

- A console warning when a looping video has been playing for five seconds and
  the page has no `[data-polite-pause]` control. WCAG 2.2.2's own threshold, so a
  clip that ends by itself is never flagged. The package promises never to
  autoplay without a way to stop it, and that is the half it cannot keep alone.

- `startWhen`, deciding how patient a video is about starting: `'visible'`,
  `'page-loaded'` (the default) or `'buffered'`. The default closes a window
  nothing covered — a deferred script's video fetch lands inside page load, and
  measured against a demo with one resource held back it took a 1.45 second head
  start on bandwidth the page still needed. `'buffered'` additionally waits for
  `canplaythrough`, for connections where a video would otherwise play while it
  is still arriving.
- `atOnce` decides how many videos may run: `0`, `1`, `'all'`, or an object
  splitting the answer by viewport. Defaults to `{ small: 1, large: 'all' }`,
  which is the behaviour the old `mobile` option gave. `mobile` is gone: paired
  with `smallViewport` it encoded "what happens on small screens" in two options
  and could not express "one at a time everywhere" at all, so a feed on a desktop
  needed a media query engineered to always match, which made the option name a
  lie.
- `rootMargin` drives a second IntersectionObserver of its own and no longer
  touches the thresholds. It had to, before: `intersectionRatio` is measured
  against the root including the margin, so a margin big enough to be useful for
  buffering silently rescaled `pauseBelow` and `playAbove`. On a 368px card at a
  50px margin, `pauseBelow: 0.25` stopped the video at about 10% visible, and the
  error scaled with element height. The observer that decides playback now keeps
  no margin, so a fraction is always the true visible fraction, and `rootMargin`
  means only "start buffering this far out". Still `'0px'` by default: fetching
  video nobody scrolls to is the opposite of the point.
- `pauseBelow` ships at `0.5` rather than `0`: a video runs while it is the thing
  you are looking at. At `0` it stopped only when entirely gone, so one hanging
  on by a sliver effectively never stopped. This caps how tall a managed video
  can be, since the ratio ceiling is `viewport / height`: past twice the viewport
  it can never reach `0.5`, and the too-tall warning says so.
- An outgoing video now stops the moment another takes its slot, instead of
  serving out `pauseGraceMs` first. Measured on `demo/feed.html`: every handover
  had both videos decoding for the full grace period, in all three engines. The
  grace period still covers the case it was written for, a video nudged past the
  boundary with nothing replacing it.
- `playAbove`, an optional start threshold that pairs with `pauseBelow` to make a
  band: clear the first to start, drop below the second to stop. Defaults to `0`,
  which is a single line at `pauseBelow`. Pull them apart when a video parked near
  the boundary needs to be stable by construction rather than by debounce.
- A console warning when a video is too tall to ever reach its start threshold.
  `intersectionRatio` is a fraction of the element, so a box taller than the
  viewport cannot be fully intersecting, and a threshold it cannot reach means it
  never plays, silently.

### Notes for the first adopters

- **The video fade defaults to `0s`, a cut.** A crossfade blends a frozen poster
  against a frame the video has already moved past, so it ghosts even when the
  poster is an exact frame-0 match. Measured in
  [`docs/findings.md`](https://github.com/sixra/polite-media/blob/main/docs/findings.md). Images keep a `350ms` default, where
  there is no second moving picture to diverge from.
- **The box carrying `data-polite-media` must be the video's direct parent.** The
  library writes to `video.parentElement` and the stylesheet reads
  `[data-polite-media][data-polite-ready] > video`.
- **Client-side routers need `register()` re-run per navigation.** Astro's
  `<ClientRouter />` does not re-execute bundled module scripts; see the README.
  Elements that leave the document are released automatically.
- **Untested on real Safari, iOS and `<ClientRouter />`.** Playwright's WebKit is
  not iOS Safari, and iOS Low Power Mode is the most common autoplay blocker in
  the wild, so the gesture-retry path is the least exercised code here.
- **ESM only, for browsers.** `require()` resolves to ESM and needs a dynamic
  import; there is no legacy `main`/`types` pair, so `attw` reports `node10`
  resolution failures by design. It also reports the two CSS subpaths as failing
  because it looks for type declarations and a stylesheet has none; `publint`,
  which understands CSS exports, is clean.

[wcag]: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
