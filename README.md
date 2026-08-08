# polite-media

Background video and images that behave themselves. No dependencies, no framework.

Two independent halves, imported separately, because they share almost nothing.
Bundled, minified and gzipped, which is what `pnpm size` enforces:

|                      | JavaScript | stylesheet | total      |
| -------------------- | ---------- | ---------- | ---------- |
| `polite-media/video` | 2,538 B    | 196 B      | **2.7 KB** |
| `polite-media/image` | 478 B      | 144 B      | **622 B**  |

An image-only page never pays for the video coordinator.

It doesn't flash, doesn't hog the decoder, doesn't eat data on a metered
connection, doesn't ignore reduced motion, and doesn't autoplay without giving
anyone a way to stop it.

```html
<div class="your-own-box" data-polite-media>
  <img src="poster.avif" alt="" />
  <video muted loop playsinline preload="none">
    <source src="hero.mp4" type="video/mp4" />
  </video>
</div>
```

```js
import { register } from 'polite-media/video';
import 'polite-media/video.css';

const box = document.querySelector('[data-polite-media]');
register(box.querySelector('video'), { observe: box });
```

Images are the other half, and a separate import:

```html
<div class="card">
  <!-- needs its own background-color -->
  <img src="photo.avif" alt="" loading="lazy" data-polite-reveal />
</div>
```

```js
import { revealImages } from 'polite-media/image';
import 'polite-media/image.css';

revealImages('.card img');
```

## Why it exists

Every bug it fixes is one you can't see in development.

**`playing` is not when the picture appears.** The usual advice is to swap the
poster for the video on the `playing` event. Measured on one machine in one run,
H.264 presented its first frame **1.6 ms before** `playing` fired, while AV1
presented **0.8 ms after**. It isn't early — it's _unordered_. Reveal on it and
you either flash (poster gone, nothing painted) or linger (poster held over a
frame that already painted), depending on the codec, so no delay tunes it away.
`requestVideoFrameCallback` is specified in terms of a frame reaching the
compositor, so it's right by definition.

**`canPlayType` lies.** In this repo's own fixtures, Chromium answered
`"probably"` for an AV1 file and then failed at `dav1d_send_data()`. That's the
documented behaviour, not a quirk: MDN says it "cannot guarantee that a media
file will actually play, even when it returns probably". It's the same shape as
Safari on Apple hardware without an AV1 decoder, which reports AV1 support the
device can't deliver — so codec checks only _order_ the candidates here, and the
`error` event decides.

**Absence of `navigator.connection` means allow, not block.** Safari and Firefox
never expose the Network Information API and Brave disables it as a
fingerprinting surface. Read absence as "block" and you silently kill video for
most of the web — and every test on Chrome still passes.

**Video comes back frozen after a back-navigation.** Scripts don't re-run on a
bfcache restore, and mobile browsers pause video while the tab is hidden and
leave it paused on return.

Measurements and citations: [`docs/findings.md`](docs/findings.md).

## What it does

- Reveals on a genuinely presented frame, never on `playing`.
- Plays only what's on screen; stops what isn't.
- One video at a time on small viewports (configurable), or none at all.
- Falls through to the next `<source>` when one can't be decoded.
- Honours `prefers-reduced-motion` and Save-Data, live.
- Recovers from bfcache restores, tab refocus and blocked autoplay.
- Ships a pause control hook for [WCAG 2.2.2][wcag].
- Emits `polite-video:ready` and `polite-video:failed`.

## What it deliberately doesn't do

**It never sets a width, height or aspect ratio.** It owns _when_ media appears;
your CSS owns _where_. That's the whole reason it drops into an existing design
at any video size — and it would be undone by one dimension declaration.

It's also not an image pipeline (no srcset or poster generation — that's a build
step), not a lazy-loader for images (`loading="lazy"` is native), not a player,
not a lightbox, and not a scroll-animation library.

**Images are opt-in per image, not per container.** `data-polite-reveal` goes on
the `<img>`. That placement is load-bearing: a container-wide rule hides every
image inside it, including ones the library then declines to fade, leaving them
invisible rather than merely unfaded.

**Eager images are revealed instantly rather than faded.** LCP excludes elements
at `opacity: 0` and revealing one doesn't restore its candidacy, so an
above-the-fold image is shown at its first paint. Pass `{ allowEager: true }` to
fade it anyway, which is a legitimate choice when a grid would otherwise cut from
its backdrop to the photo on whatever frame the decode lands.

**An image needs a backdrop.** Video degrades to its poster; a lone image
degrades to nothing, so its container must carry a visible `background-color`.

## API

```js
// polite-media/video
register(video, { until, observe }); // manage a video
unregister(video); //                   stop managing it, release everything
unregisterAll(); //                     tear down the whole page
configure({ ... }); //                  before the first register, or it throws
pauseAll(); resumeAll(); //             WCAG 2.2.2 control

// polite-media/image
const stop = revealImages(target, { allowEager }); // reveal on decode
stop(); //                                            cancel anything pending
```

Types: `ConfigureOptions`, `RegisterOptions`, `RevealImagesOptions`, `ImageTarget`,
`PoliteVideoEventDetail`, `PoliteImageEventDetail`. Event names ship as constants
(`POLITE_VIDEO_READY`, `POLITE_VIDEO_FAILED`, `POLITE_IMAGE_READY`) because a
mistyped event string still compiles against lib.dom's `type: string` overload.

There is no root import. Use `polite-media/video` or `polite-media/image`; the
resolution error for the bare package name does not name them.

| option          | default                |                                                          |
| --------------- | ---------------------- | -------------------------------------------------------- |
| `rootMargin`    | `'50px'`               | how far outside the viewport to start preparing          |
| `pauseGraceMs`  | `400`                  | anti-flicker debounce at the viewport edge               |
| `smallViewport` | `'(max-width: 767px)'` | which viewports are "small"                              |
| `mobile`        | `'arbitrate'`          | `'arbitrate'` (one at a time) or `'poster'` (never play) |
| `hysteresis`    | `0.15`                 | how much more visible a rival must be to take the slot   |
| `pauseBelow`    | `0`                    | visible fraction at or below which a video stops         |

`register(video, { until: promise })` holds a video back until the promise
settles — for a splash screen or a consent dialog. A hero at scroll-top is
reported visible in the observer's very first batch, so without this it starts
before whatever the page is waiting on has finished.

`register(video, { observe: box })` observes a wrapper instead of the video, for
when the video is `inset: 0` inside the element that carries the layout.

`configure()` throws if `rootMargin`, `pauseBelow` or `smallViewport` is patched
while videos are registered. Those three are read when the observer and the
lifecycle listeners are built, so a late change does not merely fail to apply:
`pauseBelow` half-applies, because eligibility reads it live while the threshold
ladder does not. The other three take effect on the next pass.

Only `mobile` is constrained by the type system, as a `'arbitrate' | 'poster'`
union. TypeScript cannot express "a number between 0 and 1", so `pauseBelow`,
`hysteresis` and `pauseGraceMs` are range-checked by `configure()` instead, which
throws at the call that caused the mistake rather than later inside the observer.

One gap worth knowing about: **a malformed `smallViewport` cannot be detected.**
An invalid media query does not throw and does not normalise to anything
recognisable -- Chromium echoes the text straight back and simply never matches.
So `smallViewport: '(max-width: 767)'`, missing its unit, means arbitration
silently never engages and phones behave like desktops. Check that value by eye.

`pauseBelow` defaults to `0`, meaning a video plays while any part of it is on
screen and stops only once it is entirely gone. A video still visible but frozen
reads as broken rather than considerate, so raising it trades that for decode
time. Note the fraction is measured against the viewport **expanded by
`rootMargin`**: with the defaults, a video keeps playing until it is fully 50px
past the edge. Whatever you set is also added to the observer's threshold list,
because the browser only reports at crossings it was told about.

A `<button>` carrying `data-polite-pause` toggles playback. You supply it and its
styling; this ships no markup and no CSS for it.

It must be a real `<button>`. The binding is a delegated `click`, and browsers
only synthesise that from Enter and Space for a native button — a
`div[role="button"][tabindex="0"]` answers a mouse and ignores a keyboard, which
is a WCAG 2.1.1 failure.

If you also put `aria-pressed="false"` on it, the library keeps that current so
the control announces its state. It is maintained rather than added, because
`aria-pressed` suits a button whose label stays constant; if yours swaps between
"Pause" and "Play" instead, leave the attribute off and the library won't touch
it — a screen reader announcing "Play, pressed" is worse than either.

## Markup contract

1. Poster and video share one box, arranged by your CSS.
2. `data-polite-media` goes on that box **in your markup**, not from script. A
   `<video preload="none">` paints an empty box, so if the hidden state only
   arrived once JS ran, a page whose bundle failed would stack that over the
   poster. Authored, the safe state is the default.
3. The poster should be the video's **frame 0**, which is what makes the
   dissolve invisible rather than a visible transition between two pictures.
4. Poster and video are direct children of the box.
5. The video carries `tabindex="-1" aria-hidden="true"`. It is decorative — the
   poster's `alt` carries any meaning — and without this it lands in the tab
   order: measured in Firefox, twelve background videos sat ahead of the pause
   button, so a keyboard user reached it on the thirteenth Tab.

Attributes set on the box: `data-polite-ready`, `data-polite-failed`. On
`<html>`: `data-polite-paused`. Those are the public CSS API; override the fade
with `--polite-fade`.

## Status

Framework-agnostic by construction, proven on Astro. It takes no framework
dependency and uses only standard DOM, but everything so far has been tested
against Astro projects and headless Chromium — treat other combinations as
unexercised rather than unsupported.

## Development

```sh
pnpm install
pnpm fixtures     # ffmpeg-generated synthetic media, nothing third-party
pnpm build
pnpm test         # unit
pnpm test:e2e     # real browser, real media
```

MIT.

[wcag]: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
