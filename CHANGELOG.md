# Changelog

Notable changes, newest first. Versions follow [semver](https://semver.org); while
this is `0.x`, a minor bump may still break things and will say so here.

## 0.1.0

First release.

### Added

- `polite-media/video` — reveals a background video on its first genuinely
  presented frame via `requestVideoFrameCallback`, plays only what is on screen,
  arbitrates to one video at a time on small viewports, falls through the
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

### Notes for the first adopters

- **The video fade defaults to `0s`, a cut.** A crossfade blends a frozen poster
  against a frame the video has already moved past, so it ghosts even when the
  poster is an exact frame-0 match. Measured in
  [`docs/findings.md`](docs/findings.md). Images keep a `350ms` default, where
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
