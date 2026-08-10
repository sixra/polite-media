# polite-media

Background video and images that behave themselves. No dependencies, no framework.

Two independent halves, imported separately, because they share almost nothing.
Bundled, minified and gzipped, which is what `pnpm size` enforces:

|                      | JavaScript | stylesheet | total      |
| -------------------- | ---------- | ---------- | ---------- |
| `polite-media/video` | 3,241 B    | 194 B      | **3.4 KB** |
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

## The attributes

Six in total, and they fall into three groups. The distinction that catches
people is the middle column: two of the ones you write are live on their own, and
one is inert until you call something.

| attribute            | goes on                     | live on its own?                                         |
| -------------------- | --------------------------- | -------------------------------------------------------- |
| `data-polite-media`  | the box around poster+video | **yes**, for the CSS. The video still needs `register()` |
| `data-polite-reveal` | the `<img>`                 | **no** — without `revealImages()` the image stays hidden |
| `data-polite-pause`  | your `<button>`             | **yes** — no call, anywhere on the page                  |
| `data-polite-ready`  | the box, or the image       | written by the library                                   |
| `data-polite-failed` | the box                     | written by the library                                   |
| `data-polite-paused` | `<html>`                    | written by the library                                   |

`data-polite-reveal` is the one to be careful with, and it is the reason this
table exists: `image.css` hides a marked image immediately, so marking one you
never pass to `revealImages()` leaves it invisible rather than merely unfaded.
Mark an image only when something is going to reveal it.

The bottom three are yours to style against and never to write yourself.

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
- Emits `polite-video:ready`, `polite-video:failed` and `polite-video:pausechange`.

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
pauseAll(); resumeAll(); //             WCAG 2.2.2 control, emits pausechange

// polite-media/image
const stop = revealImages(target, { allowEager }); // reveal on decode
stop(); //                                            cancel anything pending
```

Types: `ConfigureOptions`, `RegisterOptions`, `RevealImagesOptions`, `VideoTarget`, `ImageTarget`,
`PoliteVideoEventDetail`, `PoliteImageEventDetail`, `PolitePauseEventDetail`. Event
names ship as constants (`POLITE_VIDEO_READY`, `POLITE_VIDEO_FAILED`,
`POLITE_IMAGE_READY`, `POLITE_PAUSE_CHANGE`) because a mistyped event string still
compiles against lib.dom's `type: string` overload.

`polite-video:pausechange` is the odd one out: a user pause is page-wide rather
than about one video, so it is dispatched on `document` with
`detail: { paused: boolean }` and does not bubble from any element.

There is no root import. Use `polite-media/video` or `polite-media/image`; the
resolution error for the bare package name does not name them.

| option          | default                |                                                          |
| --------------- | ---------------------- | -------------------------------------------------------- |
| `rootMargin`    | `'0px'`                | how far outside the viewport to start preparing          |
| `pauseGraceMs`  | `400`                  | anti-flicker debounce at the viewport edge               |
| `smallViewport` | `'(max-width: 767px)'` | which viewports are "small"                              |
| `mobile`        | `'arbitrate'`          | `'arbitrate'` (one at a time) or `'poster'` (never play) |
| `hysteresis`    | `0.15`                 | how much more visible a rival must be to take the slot   |
| `pauseBelow`    | `0.25`                 | visible fraction at or below which a video stops         |
| `playAbove`     | `0`                    | visible fraction a video must clear before it starts     |

`register(video, { until: promise })` holds a video back until the promise
settles — for a splash screen, a consent dialog, or protecting your LCP. A hero
at scroll-top is reported visible in the observer's very first batch, so without
this it starts before whatever the page is waiting on has finished.

The LCP case is the one worth spelling out. If your poster is the LCP element,
gate the video on the poster having loaded, and its fetch can no longer compete
with the resource the metric is measuring:

```js
register(video, {
  until: new Promise((done) => {
    const poster = document.querySelector('img.hero-poster');
    if (!poster || poster.complete) done();
    else poster.addEventListener('load', () => done(), { once: true });
  }),
});
```

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

`playAbove` and `pauseBelow` are a band rather than a line. A stopped video has
to clear `playAbove` to start; a running one keeps going until it drops to
`pauseBelow`. Because the two crossings are in different places, a video parked near the
boundary cannot oscillate — `pauseGraceMs` is left covering scroll wobble instead
of doing this job.

**`pauseBelow` ships at `0.25`**, and `playAbove` at `0`, which is a single line
rather than a band: a video runs while more than a quarter of it is on screen and
stops once less is. The earlier default of `0` meant "stop only when entirely
gone", which in practice meant a video hanging on by a sliver never stopped at
all.

```js
configure({ pauseBelow: 0 }); //                  play while any part shows
configure({ playAbove: 0.75, pauseBelow: 0.25 }); // a band, for extra stability
```

A `playAbove` at or below `pauseBelow` is simply no band rather than an error.

**A tall video may never reach a high `playAbove`.** `intersectionRatio` is a
fraction of the _element_, so a box taller than the viewport can never be fully
intersecting. Measured in Chromium at a 953px viewport with the default 50px
margin:

| element height | highest ratio it reaches |
| -------------- | ------------------------ |
| 1x viewport    | 1.0                      |
| 1.5x viewport  | 0.736                    |
| 3x viewport    | 0.368                    |

This is the main reason the start threshold ships at `0` and the stop threshold
at `0.25` rather than something higher: a quarter is out of reach only past about
four viewports, where `0.75` fails at one and a half. **The library warns on the
console when it detects a threshold a box can never reach**, rather than leaving
you to wonder why a video never plays.

`pauseBelow` defaults to `0.25`: a video keeps running while more than a quarter
of it is on screen. Set it to `0` to play while any part shows at all, at the
cost of a video that never stops while a sliver of it hangs on. These fractions are measured against the viewport **plus `rootMargin`**, which is
why that now defaults to `'0px'`: at the old `'50px'` a 368px card reported 0.39
when 25% was on screen, so `pauseBelow: 0.25` really stopped it at about 10%, and
the error scaled with element height. At zero margin the reported fraction is the
visible fraction. Set a margin if you would rather a video be loading before it
arrives, and read these numbers as fractions of the expanded box when you do.
Whatever you set is also added to the observer's threshold list, because the
browser only reports at crossings it was told about.

A `<button>` carrying `data-polite-pause` toggles playback. You supply it and its
styling; this ships no markup and no CSS for it. Put it anywhere on the page --
the listener is delegated on `document`, so it does not have to live near the
video, and several controls stay in step with each other automatically.

**If you forget it, the console says so.** Five seconds after a looping video
starts -- WCAG 2.2.2's own threshold, so a short clip that ends by itself is
never asked about -- the library checks for a control and warns if there is none.
It is the one part of "never autoplays without a way to stop it" that the library
cannot keep on its own. If you drive `pauseAll()` from your own UI instead, put
`data-polite-pause` on that control too: it costs nothing, silences the warning,
and gets you `aria-pressed` maintenance for free.

It must be a real `<button>`. The binding is a delegated `click`, and browsers
only synthesise that from Enter and Space for a native button — a
`div[role="button"][tabindex="0"]` answers a mouse and ignores a keyboard, which
is a WCAG 2.1.1 failure.

There are two ways to convey the state, and you pick one:

**A constant label plus `aria-pressed="false"`.** Declare the attribute and the
library keeps it current. Maintained rather than added, because `aria-pressed`
suits a button whose label does not change.

**A label that swaps between "Pause" and "Play".** Leave `aria-pressed` off
entirely — a screen reader announcing "Play, pressed" is worse than either half —
and listen for the state instead:

```js
import { POLITE_PAUSE_CHANGE } from 'polite-media/video';

document.addEventListener(POLITE_PAUSE_CHANGE, (event) => {
  control.textContent = event.detail.paused ? 'Play' : 'Pause';
});
```

For an **icon** rather than a label, you need no JavaScript at all: the state is
on the root element, so CSS can do it, and the icon cannot drift from what the
video is actually doing.

```css
.icon-play,
[data-polite-paused] .icon-pause {
  display: none;
}
[data-polite-paused] .icon-play {
  display: inline-block;
}
```

That pairs with `aria-pressed` and a constant accessible name, since an icon is
not a label.

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
4. Poster and video are direct children of the box. The box may hold anything
   else it likes -- a scrim, a caption, a pause control -- and those are left
   alone. But **every** direct-child `img` or `picture` is treated as the poster
   and hidden on reveal, so a logo or badge belongs deeper, not beside the video.
5. If you use several `<source>` elements, the **last one carries no `media`
   attribute**. Narrow queries above it, unconditional fallback at the bottom:
   pairing `(max-width: 50rem)` with `(min-width: 50.001rem)` looks exhaustive
   and is not, and a fractional viewport that matches neither leaves the video
   with nothing to play. The first matching source wins, so ordering does the
   rest.
6. The video carries `tabindex="-1" aria-hidden="true"`. It is decorative — the
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
