# Findings

Measurements and citations behind the design. Anything asserted in the README should
trace back to an entry here.

## `playing` is unordered relative to the first presented frame

Measured 2026-08-08, headless Chromium via Playwright, local server, `preload="none"`,
`play()` called immediately. Fixtures are `scripts/make-fixtures.sh` output
(`testsrc2`, 1280x720, 30fps, 4s).

| codec | `playing` | first rVFC | delta |
| ----- | --------- | ---------- | ----- |
| H.264 | 104.3 ms  | 102.7 ms   | **-1.6 ms** (frame presented *first*) |
| AV1   | 23.0 ms   | 23.8 ms    | **+0.8 ms** (`playing` *first*) |

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

| source | outcome | `MediaError.code` |
| ------ | ------- | ----------------- |
| `sample-truncated-av1.mp4` | `error` after 17 ms | **3** `MEDIA_ERR_DECODE` — `PIPELINE_ERROR_DECODE: dav1d_send_data() failed with error -22` |
| `sample-av1.mp4` (intact)  | `loadeddata`, readyState 4 | — |
| a URL that does not exist  | `error` after 2 ms | **4** `MEDIA_ERR_SRC_NOT_SUPPORTED` |

In the same run, `canPlayType('video/mp4; codecs="av01.0.08M.08"')` returned
**`"probably"`** — for the very file that then failed at decode.

That is the documented limitation reproduced locally: MDN states `canPlayType`
"cannot guarantee that a media file will actually play, even when it returns
probably", because a browser "may report a codec as supported based on
declarations, fail to actually decode". It is the same shape as Safari on Apple
hardware without an AV1 decoder, which reports AV1 support the device cannot
deliver.

Hence the codec check only *orders* candidates and the `error` event *decides*.
And hence the fallback triggers on codes 3 and 4 only: code 1
(`MEDIA_ERR_ABORTED`) is what the element reports when its `src` is reassigned,
which this library does itself, so treating it as fatal would cascade through
every candidate on the first assignment. Code 2 (`MEDIA_ERR_NETWORK`) means the
connection failed, and another file will not fix that.

## Citations

- **LCP excludes `opacity: 0`.** "Elements with an opacity of 0, that are invisible to
  the user" are excluded, and "changes to an element's size or position don't generate
  new LCP candidates". <https://web.dev/articles/lcp>
  Also the reason image fade-in is out of scope: a faded-in image forfeits candidacy.
- **Video LCP uses "the poster image load time or first frame presentation time,
  whichever is earlier"** — same page. The poster is the LCP candidate, which is why
  only the video layer may start at `opacity: 0`.
- **AV1 needs a fallback.** Safari support "is limited to devices that feature a
  hardware decoder, meaning M3 MacBooks and later, iPhone 15 Pro, and iPhone 16 and
  later", so a current Safari on an older iPhone reports support it cannot deliver.
  <https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs>
  The library does not encode this as codec knowledge; it falls back on `error`.
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
