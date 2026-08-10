# polite-media

Background video and images that behave themselves. No dependencies, no framework.

Two independent halves, imported separately, because they share almost nothing.
Bundled, minified and gzipped, which is what `pnpm size` enforces:

|                      | JavaScript | stylesheet | total      |
| -------------------- | ---------- | ---------- | ---------- |
| `polite-media/video` | 2,787 B    | 194 B      | **2.9 KB** |
| `polite-media/image` | 473 B      | 157 B      | **630 B**  |

An image-only page never pays for the video coordinator.

It doesn't flash, doesn't hog the decoder, doesn't eat data on a metered
connection, doesn't ignore reduced motion, and doesn't autoplay without giving
anyone a way to stop it.

```html
<!-- data-polite-media goes on the video's direct parent -->
<div class="your-own-box" data-polite-media>
  <img src="poster.avif" alt="" />
  <!-- decorative: the video is not in the tab order, the poster's alt carries any meaning -->
  <video muted loop playsinline preload="none" tabindex="-1" aria-hidden="true">
    <source src="hero.mp4" type="video/mp4" />
  </video>
</div>

<!-- looping video needs a way to stop it: WCAG 2.2.2. You style it; this ships no CSS -->
<button type="button" data-polite-pause aria-pressed="false">Pause background video</button>
```

```js
import { register } from 'polite-media/video';
import 'polite-media/video.css';

register(document.querySelector('[data-polite-media] video'));
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

**Images are only hidden where scripting can reveal them.** Because that degraded
state is nothing at all, `image.css` puts the hiding rule behind
`@media (scripting: enabled)`, Baseline since December 2023. With scripting off
the photos simply arrive unfaded instead of never arriving. No media query can
see a bundle that fails to load while scripting is on, so don't mark an image you
couldn't afford to lose if your JavaScript never turns up.

## API

```js
// polite-media/video
register(video, { until, observe }); // manage a video
registerAll(target, { until }); //      manage everything a selector names
unregister(video); //                   stop managing it, release everything
unregisterAll(); //                     tear down the whole page
configure({ ... }); //                  before the first register, or it throws
pauseAll(); resumeAll(); //             WCAG 2.2.2 control

// polite-media/image
const stop = revealImages(target, { allowEager }); // reveal on decode
stop(); //                                            cancel anything pending
```

Types: `ConfigureOptions`, `RegisterOptions`, `RevealImagesOptions`, `VideoTarget`, `ImageTarget`,
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

`registerAll(target)` takes the same shapes `revealImages` does — a selector, an
element, or any collection — and registers each. It does not accept `observe`:
each observed element maps to exactly one video, so sharing a wrapper between
several would silently discard all but the last. Reach for `register` when a
video needs its own gate or wrapper.

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

   That box must be the video's **direct parent**. This is the one rule with a
   silent failure mode, so it is worth stating twice: the library writes
   `data-polite-ready` to `video.parentElement`, while the stylesheet matches
   `[data-polite-media][data-polite-ready] > video`. Put the attribute a level
   too high and the two never meet, every rule misses, and the video is simply
   visible from the start with no error anywhere. The library warns on the
   console when it can detect this.

3. The poster is ideally the video's **frame 0**, which is what makes the
   handoff invisible. It buys less than it seems to on its own, though: what
   makes it invisible is frame 0 _plus_ cutting rather than fading, because the
   video advances while the poster does not. See [The fade](#the-fade).
4. Poster and video are direct children of the box.
5. The video carries `tabindex="-1" aria-hidden="true"`. It is decorative — the
   poster's `alt` carries any meaning — and without this it lands in the tab
   order: measured in Firefox, twelve background videos sat ahead of the pause
   button, so a keyboard user reached it on the thirteenth Tab.

Attributes set on the box: `data-polite-ready`, `data-polite-failed`. On
`<html>`: `data-polite-paused`. Those are the public CSS API, along with
`--polite-fade`.

## The fade

One custom property controls it, read by both stylesheets: `--polite-fade`.
**Video defaults to `0s`, a cut. Images default to `350ms`.**

They differ because they are solving different problems. An image fades in over
a backdrop with nothing else moving, so the fade only ever covers the flicker of
an async decode landing. A video is a second picture that keeps changing, and
that is where a fade turns against you.

The trap is assuming a frame-0 poster makes a video fade free. It does not,
because the video does not wait for the fade. Playback starts at the reveal, so
the poster stays frozen on frame 0 while the video underneath advances, and the
crossfade blends a still against a frame that has moved on. The longer the fade,
the further apart the two pictures are.

Measured on a real hero, SSIM against the video's own frame 0:

| elapsed | similarity to frame 0 |
| ------- | --------------------- |
| 250ms   | 0.72                  |
| 400ms   | 0.69                  |
| 1s      | 0.64                  |

Its poster matched frame 0 at 0.994, so the poster was never the problem. At the
old `400ms` default the layers were already ~31% apart, and at 1s you see a clear
double exposure of a moving scene. That reads as a rendering bug rather than a
styling choice, and lengthening the fade to smooth it makes it worse. Shipping
`0s` is why the default is now correct for a moving video instead of subtly wrong.

So the poster question decides something narrower, what the **cut** looks like,
not whether a fade is safe:

| poster                          | at `0s`                               |
| ------------------------------- | ------------------------------------- |
| the video's frame 0             | seamless, nothing visibly happens     |
| a different, art-directed image | a visible jump, still beating a ghost |

A still video is the one case where the fade is genuinely free.

**A hard cut is safe here**, which is not true of background-video code in
general. The reveal fires from `requestVideoFrameCallback`, so a frame has
already reached the compositor before the swap: there is always a real picture
to cut to. MDN puts the CSS half plainly, a `0s` duration means "no transition
will happen, that is the switch between the two states will be instantaneous".
Code that reveals on `playing` needs a fade to cover the window where nothing has
painted yet. This doesn't.

Two things that surprise people:

- **Both halves share the token.** Setting it on `:root` changes video and
  images together. Scope it to a selector to split them.
- **An invalid value computes to `0s`, not to the stylesheet's default.**
  `--polite-fade: 0` is invalid, since CSS `<time>` requires a unit, and so is
  any typo. Measured in Chromium: both give an instant swap, because a
  substitution that is invalid at computed-value time falls back to the
  property's initial value, and the `var()` fallback only applies when the
  property is undefined. Harmless on video, which cuts anyway; on images it
  silently removes the 350ms fade. A mistake here always fails toward a cut.

## Client-side routers

If your pages are replaced without a reload — Astro's `<ClientRouter />`, or any
SPA router — **registration has to be re-run on every navigation**, and that is
your job rather than the library's.

Astro's docs are explicit that ["bundled module scripts … are only ever executed
once. After initial execution they will be ignored, even if the script exists on
the new page after a transition"][astro-scripts], while the swap "completely
replaces" the body. So a `register()` call in a normal `<script>` runs on the
first page and never again, and every video on every later page stays a poster.

Re-register on the lifecycle event, which fires on the initial load too:

```js
import { registerAll } from 'polite-media/video';

document.addEventListener('astro:page-load', () => registerAll('[data-polite-media] video'));
```

`registerAll()` is idempotent, so a video that survived the swap is not
registered twice. Videos that did not survive need no cleanup: the coordinator drops any
entry whose element has left the document on its next pass, so the discarded
nodes are released rather than pinned by a strong reference.

## Status

Framework-agnostic by construction, proven on Astro. It takes no framework
dependency and uses only standard DOM, but everything so far has been tested
against Astro projects and headless Chromium — treat other combinations as
unexercised rather than unsupported.

Two gaps worth naming rather than implying coverage. **Real Safari and iOS have
never run this**: Playwright's WebKit is not iOS Safari, and Low Power Mode is
the most common autoplay blocker in the wild, so the gesture-retry path is the
least exercised code in the package. And **`<ClientRouter />` itself is untested**
— the disconnected-element cleanup above has unit coverage, but no test drives a
real Astro view transition.

[astro-scripts]: https://docs.astro.build/en/guides/view-transitions/#script-behavior-with-view-transitions

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
