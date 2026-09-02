# polite-media

Background video, image reveals and next-page image warming. No dependencies, no framework.

Three independent entry points, imported separately, because they share almost
nothing. Bundled, minified and gzipped, which is what `pnpm size` enforces:

|                      | JavaScript | stylesheet | total      |
| -------------------- | ---------- | ---------- | ---------- |
| `polite-media/video` | 3,926 B    | 194 B      | **4.1 KB** |
| `polite-media/image` | 630 B      | 202 B      | **830 B**  |
| `polite-media/warm`  | 615 B      | none       | **615 B**  |

`polite-media/layer.css` is a third, optional stylesheet: **137 B** for the
standard poster-over-video stack. An image-only page never pays for the video
coordinator.

It doesn't flash, doesn't hog the decoder, doesn't eat data on a metered
connection, doesn't ignore reduced motion, and doesn't autoplay without giving
anyone a way to stop it.

```sh
npm install polite-media
```

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
<button type="button" data-polite-pause-control aria-pressed="false">Pause background video</button>
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

## Recipes

Each is a demo page in this repo that the end-to-end suite drives, so the markup
is known to work rather than merely plausible.

### A hero video behind a title

Load the poster eagerly; it is the Largest Contentful Paint element. Nothing
needs configuring, since the video fetches once the page has loaded and never
competes with the page's own bytes.

If Lighthouse scores matter to you, add `{ startWhen: 'interaction' }`. The video
then waits for the visitor's first scroll, tap or keypress, which keeps it out of
the LCP measurement entirely.

```html
<div class="hero" data-polite-media>
  <img src="poster.avif" alt="" fetchpriority="high" decoding="async" />
  <video muted loop playsinline preload="none" tabindex="-1" aria-hidden="true">
    <source src="hero.mp4" type="video/mp4" />
  </video>
</div>

<button type="button" data-polite-pause-control aria-pressed="false">Pause background video</button>
```

```js
import { register } from 'polite-media/video';
import 'polite-media/video.css';
import 'polite-media/layer.css'; // optional: stacks poster over video so you needn't

register(document.querySelector('.hero video'));
```

### A grid or feed of videos

Cap how many decode at once, and give the observer the card rather than the
video, which is what you want when the video is `inset: 0` inside it.

```js
import { configure, register } from 'polite-media/video';
import 'polite-media/video.css';

configure({ atOnce: 1, prefetchMargin: '200px' });

for (const card of document.querySelectorAll('.card')) {
  register(card.querySelector('video'), { observe: card });
}
```

`atOnce: 1` plays one video at a time everywhere; the default is one on small
viewports and all of them elsewhere. `prefetchMargin` starts buffering the next
one before it arrives.

### Images that appear when they are actually decoded

`load` fires before the pixels exist, so fading on it can hitch. This waits for
`decode()`. The container needs its own `background-color`.

```js
import { revealImages } from 'polite-media/image';
import 'polite-media/image.css';

revealImages('.card img');
```

### Warming the next page's hero

Document prefetchers fetch the HTML and stop, so the image inside it is
discovered only once that document parses. This fetches it on hover, focus or
touch.

```js
import { warmOnIntent } from 'polite-media/warm';

warmOnIntent('a[data-hero]', (link) => ({
  sources: [{ type: 'image/avif', srcset: link.dataset.hero }],
  src: '/fallback.jpg',
  sizes: '(min-width: 50rem) 800px, 100vw',
}));
```

## The attributes

Six in total. The distinction that catches people is the middle column: two of
the ones you write are live on their own, and one is inert until you call
something.

| attribute                   | goes on                     | live on its own?                                          |
| --------------------------- | --------------------------- | --------------------------------------------------------- |
| `data-polite-media`         | the box around poster+video | **yes**, for the CSS. The video still needs `register()`  |
| `data-polite-reveal`        | the `<img>`                 | **no**, without `revealImages()` it reveals late, unfaded |
| `data-polite-pause-control` | your `<button>`             | **yes**, no call anywhere on the page                     |
| `data-polite-ready`         | the box, or the image       | written by the library                                    |
| `data-polite-failed`        | the box                     | written by the library                                    |
| `data-polite-paused`        | `<html>`                    | written by the library                                    |

`data-polite-reveal` is the one to be careful with. `image.css` hides a marked
image immediately, so marking one you never pass to `revealImages()` leaves it
hidden until the failsafe shows it, five seconds later and without a fade. The
console names any image in that state, so widen the selector or drop the
attribute.

The bottom three are yours to style against and never to write yourself. They are
the public CSS API, along with `--polite-fade` and `--polite-failsafe`.

## Markup contract

1. Poster and video share one box, arranged by your CSS.
2. `data-polite-media` goes on that box **in your markup**, not from script. A
   `<video preload="none">` paints an empty box, so if the hidden state only
   arrived once JS ran, a page whose bundle failed would stack that over the
   poster. Authored, the safe state is the default.

   That box must be the video's **direct parent**. This is the one rule with a
   silent failure mode: the library writes `data-polite-ready` to
   `video.parentElement`, while the stylesheet matches
   `[data-polite-media][data-polite-ready] > video`. Put the attribute a level
   too high and the two never meet, every rule misses, and the video is visible
   from the start with no error anywhere. The library warns on the console when
   it can detect this.

3. The poster is ideally the video's **frame 0**, which is what makes the handoff
   invisible, but only together with cutting rather than fading. See
   [The fade](#the-fade).
4. Poster and video are direct children of the box. The box may hold anything
   else it likes, a scrim, a caption, a pause control, and those are left alone.
   But **every** direct-child `img` or `picture` is treated as the poster and
   hidden on reveal, so a logo or badge belongs deeper, not beside the video.
5. Order several `<source>` elements narrowest first: the first one that claims
   the viewport wins. **You do not need an unconditional fallback.** Two queries
   meant to partition the viewport often do not quite meet, and
   `(max-width: 50rem)` beside `(min-width: 50.001rem)` leaves 0.016px matching
   neither at a 16px root. So `media` is treated as a preference: when no source
   claims the current viewport, every decodable one is a candidate and document
   order decides. The console says so once when it happens, because the file it
   picks may be meant for a different screen.

   The trade is that `media` cannot mean "and otherwise play nothing".
   `atOnce: { small: 0 }` says that properly.

6. The video carries `tabindex="-1" aria-hidden="true"`. It is decorative, and
   without this it lands in the tab order: measured in Firefox, twelve background
   videos sat ahead of the pause button, so a keyboard user reached it on the
   thirteenth Tab.

## API

```js
// polite-media/video
register(video, { until, observe, startWhen }); // manage a video
registerAll(target, { until, startWhen }); //      manage everything a selector names
unregister(video); //                              stop managing it, release everything
unregisterAll(); //                                tear down the whole page
configure({ ... }); //                             before the first register, or it throws
pauseAll(); resumeAll(); //                        WCAG 2.2.2 control, emits pausechange

// polite-media/image
const stop = revealImages(target, { allowEager }); // reveal on decode
stop(); //                                            cancel anything pending

// polite-media/warm
warm(options); //                    warm one image
const off = warmOnIntent(sel, fn); // warm on hover, focus or touch
```

There is no root import. Use `polite-media/video`, `polite-media/image` or
`polite-media/warm`; the resolution error for the bare package name does not name
them.

Types: `ConfigureOptions`, `RegisterOptions`, `RevealImagesOptions`,
`WarmOptions`, `WarmSource`, `VideoTarget`, `ImageTarget`, `AtOnce`,
`PoliteVideoEventDetail`, `PoliteImageEventDetail`, `PolitePauseEventDetail`.
Event names ship as constants
(`POLITE_VIDEO_READY`, `POLITE_VIDEO_FAILED`, `POLITE_IMAGE_READY`,
`POLITE_VIDEO_PAUSECHANGE`), because a mistyped event string still compiles
against lib.dom's `type: string` overload.

`polite-video:pausechange` is the odd one out: a user pause is page-wide rather
than about one video, so it is dispatched on `document` with
`detail: { paused: boolean }` and does not bubble from any element.

### Options

Six, answering three questions. Nothing needs setting; the defaults were measured
rather than guessed.

**How visible must it be?**

| option       | default | reach for it when                                                |
| ------------ | ------- | ---------------------------------------------------------------- |
| `pauseBelow` | `0.5`   | a video should run longer, or stop sooner, than "half on screen" |

**How many may run?**

| option          | default                      | reach for it when                                          |
| --------------- | ---------------------------- | ---------------------------------------------------------- |
| `atOnce`        | `{ small: 1, large: 'all' }` | a feed wants one at a time everywhere, or phones want none |
| `smallViewport` | `'(max-width: 767px)'`       | your breakpoint is not ours                                |

**When may it begin?**

| option            | default         | reach for it when                                                             |
| ----------------- | --------------- | ----------------------------------------------------------------------------- |
| `startWhen`       | `'page-loaded'` | you want the video out of the LCP measurement, and accept it waiting          |
| `requireBuffered` | `false`         | your visitors are on connections where video plays while it is still arriving |
| `prefetchMargin`  | `'0px'`         | the next card should be buffered before it arrives                            |

Two numbers that shape playback are deliberately not options. A video leaving the
viewport waits 400ms before stopping, so a jittery scroll cannot stutter it, and
an incumbent holding the single slot keeps it until a rival is 15% more visible,
so a carousel's peeking neighbour cannot flap it back and forth. Both are
tolerances rather than policies anyone has a view on, and a value picked without
watching a real carousel does not fail loudly, it just reintroduces the flapping.

`configure()` throws if `prefetchMargin`, `pauseBelow` or `smallViewport` is
patched while videos are registered. Those three are read when the observer and
the lifecycle listeners are built, so a late change does not merely fail to
apply: `pauseBelow` half-applies, because eligibility reads it live while the
threshold ladder does not. `atOnce`, `startWhen` and `requireBuffered` take
effect on the next pass.

`pauseBelow` is range-checked by `configure()`, since TypeScript cannot express
"a number between 0 and 1", and `atOnce` is checked at runtime for JavaScript
callers: a `2` would otherwise fall through to the single-slot branch and quietly
mean `1`.

**A malformed `smallViewport` cannot be detected.** An invalid media query does
not throw and does not normalise to anything recognisable; Chromium echoes the
text straight back and never matches. So `smallViewport: '(max-width: 767)'`,
missing its unit, means arbitration silently never engages and phones behave like
desktops. Check that value by eye.

### Per-video gates

`register(video, { until: promise })` holds a video back until the promise
settles: for a splash screen, a consent dialog, or protecting your LCP. A hero at
scroll-top is reported visible in the observer's very first batch, so without
this it starts before whatever the page is waiting on has finished.

```js
// If the poster is your LCP element, gate the video on it having loaded.
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

`registerAll(target)` takes the same shapes `revealImages` does (a selector, an
element, or any collection) and registers each. It does not accept `observe`:
each observed element maps to exactly one video, and `register` refuses a second
video on a target it already watches, with a warning.

### `startWhen`

A genuine ladder: each rung waits for everything the one before it did, then
something more.

| value           | waits for                              |
| --------------- | -------------------------------------- |
| `'visible'`     | nothing but being on screen            |
| `'page-loaded'` | + `window`'s `load` event. **Default** |
| `'interaction'` | + the first pointer, key or scroll     |

`'page-loaded'` is the default because a deferred module script otherwise fetches
inside the tail of page load: measured on a demo with one resource held back,
`'visible'` began the video at 106ms against a `load` at 1560ms, taking 1.45
seconds of bandwidth the page still needed.

**`'interaction'` is the one setting with a real trade-off.** The browser stops
updating Largest Contentful Paint on "a tap, scroll, or keypress"
([web.dev][lcp]), so a video revealed after that signal can never become the LCP
element, and a synthetic audit, which never interacts, never starts it at all.
The cost is yours to weigh: a visitor who lands and never scrolls or taps sees a
still. On a phone that is usually a second, since any flick counts; on a desktop
it can last as long as they read without moving. Below the fold it barely matters
either way, since scrolling is the interaction.

**Override it per video** when one video is special, which is usually the hero:

```js
// The grid autoplays on the default; only the LCP candidate holds back.
register(hero, { startWhen: 'interaction' });
```

`requireBuffered` is the separate axis: it holds playback until the video can
play through without stalling. It raises `preload` to `'auto'` when it prepares,
which is necessary because `preload="none"` means the browser buffers nothing
until playback is requested, so waiting for `canplaythrough` without the
promotion would wait forever. All three engines honour the promotion. If the
buffer never fills, the poster stays, the same outcome as reduced motion or
Save-Data. It is deliberately not a fourth `startWhen` value; as one it competed
with `'interaction'`, so "wait for the visitor, and also wait for the buffer"
could not be expressed at all.

Two consequences. A page whose `load` never fires never starts its videos, and
`requireBuffered` is one of two places the library changes markup you authored:
`prefetch()` also promotes `preload` to `'auto'` for any video within a
configured `prefetchMargin`. `until` composes with all of it, and a video waits
for every gate that applies to it.

### `pauseBelow`

Ships at `0.5`: a video runs while more than half of it is on screen and stops
once less is. Set it to `0` to play while any part shows at all, which in
practice means a video hanging on by a sliver never stops.

**A tall video may never reach a high `pauseBelow`.** `intersectionRatio` is a
fraction of the _element_, so a box taller than the viewport can never be fully
intersecting. Measured in Chromium at a 953px viewport, on the observer that
decides playback:

| element height | highest ratio it reaches |
| -------------- | ------------------------ |
| 1x viewport    | 1.0                      |
| 1.5x viewport  | 0.667                    |
| 3x viewport    | 0.333                    |

The ceiling is `viewport / height`, which is why it ships at `0.5`: that is out
of reach only past twice the viewport, where `0.75` already fails at one and a
half. **The library warns when it detects a threshold a box can never reach.**
Whatever you set is also added to the observer's threshold list, because the
browser only reports at crossings it was told about.

### The pause control

A `<button>` carrying `data-polite-pause-control` toggles playback. You supply it
and its styling; this ships no markup and no CSS for it. The listener is
delegated on `document`, so it can live anywhere, and several controls stay in
step automatically.

It must be a real `<button>`. The binding is a delegated `click`, and browsers
only synthesise that from Enter and Space for a native button; a
`div[role="button"][tabindex="0"]` answers a mouse and ignores a keyboard, which
is a WCAG 2.1.1 failure.

**A pause follows the visitor to the next page**, kept in `sessionStorage`, so on
a multi-page site the motion stays stopped as they click through and a declared
`aria-pressed` comes back in the right state. `sessionStorage` rather than
`localStorage` deliberately, so it lasts the visit rather than silently outliving
it by weeks. Where storage is denied, which throws rather than returning nothing,
the pause still applies to the current page and simply does not carry.

**If you forget the control, the console says so.** Five seconds after a looping
video starts, WCAG 2.2.2's own threshold, so a short clip that ends by itself is
never asked about. If you drive `pauseAll()` from your own UI instead, put
`data-polite-pause-control` on that control too: it silences the warning and gets
you `aria-pressed` maintenance for free.

There are two ways to convey the state, and you pick one. **A constant label plus
`aria-pressed="false"`**: declare the attribute and the library keeps it current.
Or **a label that swaps between "Pause" and "Play"**: leave `aria-pressed` off
entirely, since a screen reader announcing "Play, pressed" is worse than either
half, and listen for the state instead.

```js
import { POLITE_VIDEO_PAUSECHANGE } from 'polite-media/video';

document.addEventListener(POLITE_VIDEO_PAUSECHANGE, (event) => {
  control.textContent = event.detail.paused ? 'Play' : 'Pause';
});
```

For an **icon** you need no JavaScript at all, since the state is on the root
element, so the icon cannot drift from what the video is doing. That pairs with
`aria-pressed` and a constant accessible name, since an icon is not a label.

```css
.icon-play,
[data-polite-paused] .icon-pause {
  display: none;
}
[data-polite-paused] .icon-play {
  display: inline-block;
}
```

## The fade

One custom property controls it, read by both stylesheets: `--polite-fade`.
**Video defaults to `0s`, a cut. Images default to `350ms`.**

They differ because they solve different problems. An image fades in over a
backdrop with nothing else moving, so the fade only covers the flicker of an
async decode landing. A video is a second picture that keeps changing.

The trap is assuming a frame-0 poster makes a video fade free. It does not,
because the video does not wait for the fade: playback starts at the reveal, so
the poster stays frozen on frame 0 while the video underneath advances, and the
crossfade blends a still against a frame that has moved on. Measured on a real
hero, SSIM against the video's own frame 0:

| elapsed | similarity to frame 0 |
| ------- | --------------------- |
| 250ms   | 0.72                  |
| 400ms   | 0.69                  |
| 1s      | 0.64                  |

Its poster matched frame 0 at 0.994, so the poster was never the problem. At the
old `400ms` default the layers were already ~31% apart, and at 1s you see a clear
double exposure of a moving scene.

**That measurement does not transfer to an art-directed poster.** The ghost it
describes is a double exposure of one scene slightly advanced, which is what you
get when the two layers are nearly the same picture. Blend two genuinely
different pictures and you get an ordinary dissolve.

| poster                          | at `0s`, the default              | with a fade                        |
| ------------------------------- | --------------------------------- | ---------------------------------- |
| the video's frame 0             | seamless, nothing visibly happens | ghosts, and worse the longer it is |
| a different, art-directed image | a visible jump                    | an ordinary crossfade              |

The default cuts because the library cannot tell which you have, and guessing
wrong on a frame-0 poster is the worse failure. **Turn it on for the videos that
want it**, one container at a time; `--polite-fade` is an ordinary custom
property, so it inherits. `demo/art-directed.html` shows both side by side.

```css
/* this hero dissolves; every other video on the page still cuts */
.hero[data-polite-media] {
  --polite-fade: 600ms;
}
```

**A hard cut is safe here**, which is not true of background-video code in
general. The reveal fires from `requestVideoFrameCallback`, so a frame has
already reached the compositor before the swap. Code that reveals on `playing`
needs a fade to cover the window where nothing has painted yet; this doesn't.

Two things that surprise people:

- **Both halves share the token.** Setting it on `:root` changes video and images
  together. Scope it to a selector to split them.
- **An invalid value computes to `0s`, not to the stylesheet's default.**
  `--polite-fade: 0` is invalid, since CSS `<time>` requires a unit, and so is any
  typo. Measured in Chromium: both give an instant swap, because a substitution
  that is invalid at computed-value time falls back to the property's initial
  value, and the `var()` fallback only applies when the property is undefined.
  Harmless on video, which cuts anyway; on images it silently removes the 350ms
  fade.

Reduced motion overrides you either way: the stylesheet sets `transition: none`
there, so a fade you asked for never runs for someone who asked not to see one.

## Warming the next page's image

`polite-media/warm` fetches the image the _next_ page will show, while the
visitor is still deciding to go there. Every document prefetcher stops at the
HTML: Astro's `data-astro-prefetch`, Next's `<Link>` and quicklink all fetch the
document, and the hero inside it is discovered only once that document parses.

```js
import { warmOnIntent } from 'polite-media/warm';

// One listener for a whole grid, delegated on the document.
warmOnIntent('a[data-hero]', (link) => ({
  sources: [{ type: 'image/avif', srcset: link.dataset.hero }],
  src: '/fallback.jpg',
  sizes: '(min-width: 50rem) 800px, 100vw',
}));
```

**Nothing in this package parses a media query**, which is the point: the
candidates are assembled as a detached `<picture>` and the browser picks, running
the same algorithm it will run on the destination. Hand-rolling that selection
drifts the moment `sizes` changes in one place and not the other.

`warm(options)` warms one image directly, for navigation that isn't a link.
`warmOnIntent` returns a teardown; call it if you re-bind per navigation, since
listeners on `document` survive a `<ClientRouter />` swap.

**Why not a `<link>` hint.** `imagesrcset` and `imagesizes` do responsive
selection, but only for `rel="preload"` with `as="image"`, and preload is for
resources "[your page will need very soon][preload]" rather than the next page's.
`prefetch` has the right timing and ignores those attributes. A preload link
injected on hover does select correctly in all three engines, measured, so it is
a real alternative; what it costs is a Chromium console warning on every warmed
image, because the resource is by definition never used by the page that
preloaded it. Going the other way, to `prefetch`, is worse: Safari doesn't
support `<link rel="prefetch">` and Firefox aborts it with `NS_BINDING_ABORTED`
without an explicit cache header. A detached image both selects and fetches, so
none of it applies.

**Skipped on Save-Data and 2g**, since nobody asked for these bytes yet. Deduped,
so repeated hovering warms once. Fetched at `fetchpriority="low"`.

**When you don't need this.** If your audience is Chromium and you already use
Speculation Rules `prerender`, that loads the whole destination including its
images and does strictly more. It is [not Baseline][prerender] and covers neither
Safari nor Firefox, which is the gap this fills.

## Client-side routers

If your pages are replaced without a reload (Astro's `<ClientRouter />`, or any
SPA router), **registration has to be re-run on every navigation**. Astro's docs
are explicit that ["bundled module scripts … are only ever executed once. After
initial execution they will be ignored, even if the script exists on the new page
after a transition"][astro-scripts], while the swap "completely replaces" the
body.

```js
import { registerAll } from 'polite-media/video';

document.addEventListener('astro:page-load', () => registerAll('[data-polite-media] video'));
```

`registerAll()` is idempotent, so a video that survived the swap is not
registered twice. Videos that did not survive need no cleanup: the coordinator
drops any entry whose element has left the document on its next pass.

## What it does

- Reveals on a genuinely presented frame, never on `playing`.
- Plays only what's on screen; stops what isn't.
- Caps how many videos run at once, on any viewport, not just small ones.
- Falls through to the next `<source>` when one can't be decoded.
- Honours `prefers-reduced-motion` live, and Save-Data on the next reconcile.
- Recovers from bfcache restores, tab refocus and blocked autoplay.
- Ships a pause control hook for [WCAG 2.2.2][wcag].
- Emits `polite-video:ready`, `polite-video:failed` and `polite-video:pausechange`.

## What it deliberately doesn't do

**It never sets a width, height or aspect ratio.** It owns _when_ media appears;
your CSS owns _where_. That is why it drops into an existing design at any video
size, and it would be undone by one dimension declaration.

It's also not an image pipeline (no srcset or poster generation: that's a build
step), not a lazy-loader for images (`loading="lazy"` is native), not a player,
not a lightbox, and not a scroll-animation library. `polite-media/warm` warms
candidates you already build, and generates none.

**Images are opt-in per image, not per container.** A container-wide rule hides
every image inside it, including ones the library then declines to fade, so each
one waits out the failsafe instead of fading.

**Eager images are revealed instantly rather than faded.** LCP excludes elements
at `opacity: 0` and revealing one doesn't restore its candidacy. Pass
`{ allowEager: true }` to fade anyway.

**An image needs a backdrop.** Video degrades to its poster; a lone image
degrades to nothing, so its container must carry a visible `background-color`.

**Images are only hidden where scripting can reveal them.** `image.css` puts the
hiding rule behind `@media (scripting: enabled)`, Baseline since December 2023,
so with scripting off the photos arrive unfaded instead of never arriving. And
because no media query can see a bundle that fails while scripting is on, the
stylesheet reveals any marked image after `--polite-failsafe` (default `5s`)
regardless. A missed selector or a dead bundle costs you the fade, not the
picture. The failsafe applies to every marked image, including managed ones,
because an earlier design that exempted them could send an already-revealed image
back to hidden.

## Why it exists

Every bug it fixes is one you can't see in development.

**`playing` is not when the picture appears.** The usual advice is to swap the
poster for the video on the `playing` event. Measured on one machine in one run,
H.264 presented its first frame **1.6 ms before** `playing` fired, while AV1
presented **0.8 ms after**. It isn't early, it's _unordered_, so no delay tunes
it away. `requestVideoFrameCallback` is specified in terms of a frame reaching
the compositor, so it's right by definition.

**`canPlayType` lies.** In this repo's own fixtures, Chromium answered
`"probably"` for `sample-truncated-av1.mp4` and then failed with
`PIPELINE_ERROR_DECODE: dav1d_send_data() failed with error -22`. That is the bar
the specification sets, not a quirk: the [HTML Standard][html-canplaytype] says
the method returns `"probably"` only "if the user agent is confident that the
type represents a media resource that it can render". Confidence is not a
guarantee, so codec checks only _order_ the candidates here and the `error` event
decides.

**Absence of `navigator.connection` means allow, not block.** Safari and Firefox
never expose the Network Information API and Brave disables it as a
fingerprinting surface. Read absence as "block" and you silently kill video for
most of the web, while every test on Chrome still passes.

**Video comes back frozen after a back-navigation.** Scripts don't re-run on a
bfcache restore, and mobile browsers pause video while the tab is hidden and
leave it paused on return.

## Status

Framework-agnostic by construction: no framework dependency, standard DOM only,
developed against Astro projects.

**Tested on Chromium, Firefox and WebKit**, all three driven by Playwright
against real media on every change, alongside 211 unit tests. Other engines are
unexercised rather than unsupported.

**iOS Safari is outside the matrix**, and Playwright's WebKit does not stand in
for it. The path that rests on it is the retry after a refused `play()`, which
rejects with `NotAllowedError`; the library follows MDN's documented remedy of
surfacing a control and waiting for a gesture.

**`0.x`**, so a minor bump may still change behaviour; `CHANGELOG.md` says when
it does. Nothing runs it in production so far.

Contributing, and how to run the suite: [CONTRIBUTING.md](CONTRIBUTING.md). MIT.

[astro-scripts]: https://docs.astro.build/en/guides/view-transitions/#script-re-execution
[html-canplaytype]: https://html.spec.whatwg.org/multipage/media.html
[prerender]: https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API
[lcp]: https://web.dev/articles/lcp
[preload]: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Attributes/rel/preload
[wcag]: https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html
