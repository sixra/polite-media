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
  live and Save-Data on the next reconcile, recovers from bfcache restores and
  blocked autoplay, and ships a pause hook for [WCAG 2.2.2][wcag].
- `polite-media/image` — reveals an image once `decode()` resolves, rather than on
  `load`, which fires before the pixels exist.
- A failsafe so a marked image can never stay hidden. `image.css` hides anything
  carrying `data-polite-reveal`, which makes a missed selector, or a bundle that
  never arrives, cost the picture rather than the fade. The stylesheet reveals on
  a delay regardless, tunable with `--polite-failsafe` (default `5s`),
  and `revealImages()` names any image in that state on the console.

  Deliberately universal rather than cancelled for images the library manages. An
  earlier design marked those and set `animation: none`, which reverts the filled
  end state: measured in all three engines, an image the failsafe had already
  revealed jumped back to invisible the moment it was claimed.

- Optional stylesheets, `polite-media/video.css` and `polite-media/image.css`.
  Timing only: neither sets a width, height or aspect ratio.
- A console warning when a video's parent carries no `data-polite-media` and
  nothing else hides the video, because that misconfiguration is otherwise
  completely silent — the library looks installed while doing nothing.
- The pause control is marked with **`data-polite-pause-control`**, and its event
  constant is **`POLITE_VIDEO_PAUSECHANGE`**. The attribute names a control
  rather than reading like a command, and the constant now mirrors its own string
  the way `POLITE_VIDEO_READY` and `POLITE_VIDEO_FAILED` already did.
- `polite-video:pausechange` on `document`, with `detail: { paused: boolean }`.
  Without it the label-swapping pause control the README offers as an option
  could not be built: the only other signal is `data-polite-paused` on `<html>`,
  and watching that means a MutationObserver on the root for one boolean. Fires
  only on real transitions, including the reset inside `unregisterAll()`, so a
  host mirroring the state is never left holding a stale button.
- A console warning when a looping video has been playing for five seconds and
  the page has no `[data-polite-pause-control]` control. WCAG 2.2.2's own threshold, so a
  clip that ends by itself is never flagged. The package promises never to
  autoplay without a way to stop it, and that is the half it cannot keep alone.
- `startWhen`, deciding how patient a video is about starting: `'visible'`,
  `'page-loaded'`, or `'interaction'` (the default). A genuine ladder, each rung
  waiting for everything the one before it did.

  `'interaction'` waits for the visitor's first pointer, key or scroll, which is
  exactly the signal on which the browser stops updating Largest Contentful
  Paint. A video revealed afterwards can never become the LCP element, and an
  audit that never interacts never starts it. Measured on a production hero: 89
  and LCP 3.7s with the video counted, 100 and 1.4s without. The cost is a
  visitor who never interacts seeing a still, which is why it is one line to opt
  out of.

  Overridable per video at `register()`, because usually only the hero can be the
  LCP element and holding a below-fold grid to the same rule buys nothing.

- `requireBuffered` holds playback until the video can play through without
  stalling, for thin connections. Its own option rather than a fourth `startWhen`
  value: as one it competed with `'interaction'`, so "wait for the visitor, and
  also wait for the buffer" could not be said at all.
- `atOnce` decides how many videos may run: `0`, `1`, `'all'`, or an object
  splitting the answer by viewport. Defaults to `{ small: 1, large: 'all' }`,
  because phones have far less decode headroom than desktops: three concurrent
  H.264 streams while compositing drops frames badly on real hardware. A grid of
  cards whose content is the video still needs to move, so the answer is one at a
  time rather than none.
- `rootMargin` drives its own IntersectionObserver, separate from the one that
  decides playback. `intersectionRatio` is measured against the root including
  any margin, so keeping the playback observer free of one means a fraction is
  always the true visible fraction, and `rootMargin` means only "start buffering
  this far out". Defaults to `'0px'`: fetching video nobody scrolls to is the
  opposite of the point.
- `pauseBelow` defaults to `0.5`: a video runs while it is the thing you are
  looking at, and stops once less than half of it remains on screen. This caps
  how tall a managed video can be, since the ratio ceiling is
  `viewport / height`: past twice the viewport a video can never reach `0.5`,
  and the too-tall warning says so.
- An outgoing video stops the moment another video takes its slot, rather than
  serving out `pauseGraceMs` first: measured on `demo/feed.html`, serving out the
  grace period left both videos decoding through every handover, in all three
  engines. The grace period still covers the case it exists for, a video nudged
  past the boundary with nothing replacing it.
- `playAbove`, an optional start threshold that pairs with `pauseBelow` to make a
  band: clear the first to start, drop below the second to stop. Defaults to `0`,
  which is a single line at `pauseBelow`. Pull them apart when a video parked near
  the boundary needs to be stable by construction rather than by debounce.
- `<source media>` is a preference rather than an exclusion. When no source
  claims the current viewport, every decodable one becomes a candidate and
  document order decides, instead of the video having nothing to play.

  Two queries meant to partition the viewport often do not quite meet:
  `(max-width: 50rem)` beside `(min-width: 50.001rem)` leaves 0.016px matching
  neither at a 16px root. Both consumer projects had a pair of this shape. The
  alternative was a
  markup rule every consumer has to remember, so the library absorbs it and warns
  once when the fallback actually engages, since the file it picks may be meant
  for a different screen.

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
