# Findings

Measurements and citations behind the design. Anything asserted in the README should
trace back to an entry here.

## `playing` is unordered relative to the first presented frame

Measured 2026-08-08, headless Chromium via Playwright, local server, `preload="none"`,
`play()` called immediately. Fixtures are `scripts/make-fixtures.sh` output
(`testsrc2`, 1280x720, 30fps, 4s).

| codec | `playing` | first rVFC | delta                                 |
| ----- | --------- | ---------- | ------------------------------------- |
| H.264 | 104.3 ms  | 102.7 ms   | **-1.6 ms** (frame presented _first_) |
| AV1   | 23.0 ms   | 23.8 ms    | **+0.8 ms** (`playing` _first_)       |

Same machine, same page, same run. The ordering flips with the codec.

This is the justification for the library's core primitive, and it is stronger than
the usual claim. The common framing is "`playing` fires too early". The measurement
says `playing` is not merely early, it is **unordered**: reveal on it and you either

- flash — the poster is removed before any frame has painted, or
- linger — the frame painted already and the poster was held over it.

Which one you get depends on the codec, so neither can be tuned away with a delay.
`requestVideoFrameCallback` is the only signal defined in terms of a frame actually
reaching the compositor, so it is correct by definition rather than by timing luck.

Both runs reported `mediaTime: 0` and `presentedFrames: 1` for the first callback,
which confirms the first presented frame is frame 0. That is what makes a frame-0
poster dissolve invisible, and why `scripts/make-fixtures.sh` extracts the poster with
`select=eq(n\,0)` rather than at an arbitrary timestamp.

**Caveat:** this is the fast path — local server, warm cache, hardware H.264. The slow
network case, where the gap should widen, is not measured here. The conclusion does
not depend on it: unordered is unordered.

## rVFC fires in headless Chromium

Same run. `hasRvfc: true`, `rvfcFired: true`, no compositor flags needed.

This was flagged as a project risk: had rVFC silently never fired headless, every test
asserting the reveal would have been vacuously green. It does fire, so the e2e suite
can rely on it and needs neither headed CI, `--use-gl=swiftshader`, nor a canvas
`captureStream()` stand-in. Re-check if CI ever moves off Chromium.

## `canPlayType` says "probably" about a file it cannot decode

Measured 2026-08-08, headless Chromium, same fixtures.

| source                     | outcome                    | `MediaError.code`                                                                           |
| -------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `sample-truncated-av1.mp4` | `error` after 17 ms        | **3** `MEDIA_ERR_DECODE` — `PIPELINE_ERROR_DECODE: dav1d_send_data() failed with error -22` |
| `sample-av1.mp4` (intact)  | `loadeddata`, readyState 4 | —                                                                                           |
| a URL that does not exist  | `error` after 2 ms         | **4** `MEDIA_ERR_SRC_NOT_SUPPORTED`                                                         |

In the same run, `canPlayType('video/mp4; codecs="av01.0.08M.08"')` returned
**`"probably"`** — for the very file that then failed at decode.

That is the documented limitation reproduced locally: MDN states `canPlayType`
"cannot guarantee that a media file will actually play, even when it returns
probably", because a browser "may report a codec as supported based on
declarations, fail to actually decode". It is the same shape as Safari on Apple
hardware without an AV1 decoder, which reports AV1 support the device cannot
deliver.

Hence the codec check only _orders_ candidates and the `error` event _decides_.
And hence the fallback triggers on codes 3 and 4 only: code 1
(`MEDIA_ERR_ABORTED`) is what the element reports when its `src` is reassigned,
which this library does itself, so treating it as fatal would cascade through
every candidate on the first assignment. Code 2 (`MEDIA_ERR_NETWORK`) means the
connection failed, and another file will not fix that.

## Citations

- **LCP excludes `opacity: 0`.** "Elements with an opacity of 0, that are invisible to
  the user" are excluded, and "changes to an element's size or position don't generate
  new LCP candidates". <https://web.dev/articles/lcp>
  Also why an eager image is revealed instantly rather than faded: a lazy image
  was never a candidate, so fading it costs nothing, while fading an eager one
  forfeits the metric. `allowEager` makes that a decision instead of an accident.
- **Video LCP uses "the poster image load time or first frame presentation time,
  whichever is earlier"** — same page. The poster is the LCP candidate, which is why
  only the video layer may start at `opacity: 0`.
- **AV1 needs a fallback.** Safari support "is limited to devices that feature a
  hardware decoder, meaning M3 MacBooks and later, iPhone 15 Pro, and iPhone 16 and
  later".
  <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs>
  The library does not encode this as codec knowledge; it falls back on `error`.

  **Untested inference, recorded as such.** An earlier version of this entry added
  "so a current Safari on an older iPhone reports support it cannot deliver". That
  does not follow from the quote and is contradicted where it was measurable:
  Playwright's WebKit on an M2 Pro, which is below the M3 threshold above, answers
  `""` for `av01.0.08M.08` -- honest about not supporting AV1 rather than claiming
  it. Safari proper on an iPhone remains untested in both directions. The fallback
  design does not rest on it: Chromium and Firefox both produce `MEDIA_ERR_DECODE`
  on the truncated fixture, which is what the tests exercise.

- **Strip audio from muted video.** FFmpeg `-an` "reduces the size of the video file,
  even if the audio stream already present is silent".
  <https://web.dev/learn/performance/video-performance>
- **`<video loading="lazy">` is not Baseline.** Chromium only; Firefox and WebKit
  implementations were under review. Feature-detect, keep the JS path.
  <https://caniuse.com/loading-lazy-media>
- **WCAG 2.2.2** applies to moving content that starts automatically, lasts over five
  seconds, and is presented in parallel with other content — which a decorative looping
  background video is. `prefers-reduced-motion` is not listed as satisfying it.
  <https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html>
- **rVFC baseline.** Newly available as of October 2024, so the
  `readyState`/`loadeddata` fallback is load-bearing, not decoration.
  <https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback>

## Cross-browser, measured

Playwright 1.62.1 against Chromium 151, Firefox 153 and WebKit 26.5, on an M2 Pro.

- **`requestVideoFrameCallback` is present in all three.** The `readyState` and
  `loadeddata` rungs therefore never engage in normal operation on any engine this
  suite can drive. They remain correct for pre-October-2024 browsers, but their
  only coverage is the unit tests against a hand-written fake, and that should not
  be mistaken for end-to-end proof.
- **Only Chromium has `navigator.connection`.** Firefox and WebKit expose nothing,
  which makes them the only engines that exercise the Save-Data gate's fail-open
  polarity -- the exact case a Chromium-only suite passes while broken.
- **WebKit filters the AV1 fixture before assigning it**, because `canPlayType`
  answers `""` there, so the source-fallback path is never entered and those two
  tests pass without exercising it. The library degrades correctly (poster kept,
  `data-polite-failed` set), but the mechanism is covered by Chromium and Firefox
  only.
- **Firefox puts `<video>` in the tab order** even with no `controls`. Measured on
  the grid demo: Tab reached a link, then twelve videos, and the pause control
  came thirteenth. Hence `tabindex="-1"` plus `aria-hidden="true"` in the markup
  contract; afterwards the control is reached on the second Tab.
- **WebKit puts nothing in the tab order** by default: macOS gates that behind
  "Press Tab to highlight each item on a webpage". Eight presses leave
  `activeElement` on `BODY` for every element on the page, so tab-reachability is
  asserted on the other two engines only.

## `totalVideoFrames` is not a portable oracle for "a frame has painted"

Measured at the moment `polite-video:ready` fires on the hero demo, same run as
the matrix above.

| engine       | `totalVideoFrames` at reveal | `readyState` | frames shortly after |
| ------------ | ---------------------------- | ------------ | -------------------- |
| Chromium 151 | 4                            | 4            | 7                    |
| WebKit 26.5  | 1                            | 4            | 12                   |
| Firefox 153  | **0**                        | 4            | 2                    |

Frames are flowing in Firefox -- the counter reads 2 moments later -- so this is
update timing, not an absent frame. MDN defines the property as "the number of
frames the element _would have presented_ had no problems occurred", which is the
right concept; when an engine increments it is not specified tightly enough to
assert on.

The consequence for testing: there is no independent cross-engine oracle for the
library's central claim. `requestVideoFrameCallback` _is_ the presentation signal
by definition, so any check written against it is necessarily weaker than it. The
e2e suite therefore asserts the weaker guarantee that does hold everywhere -- the
reveal never lands while `readyState` is below `HAVE_CURRENT_DATA` -- and the
strong claim rests on the API's contract plus the ordering measurement above.
