import { expect, test, type Page } from '@playwright/test';

/**
 * These assert against the built package in /dist, driving real media in a real
 * browser. The unit suite covers logic with mocks; anything depending on actual
 * decoding, painting or layout has to live here.
 *
 * Positive expectations poll until they hold, so the suite neither sleeps longer
 * than it must nor flakes on a slow machine. Negative ones ("never starts") are
 * the exception: absence cannot be polled for, so those settle briefly first and
 * say so.
 */

/** For negative assertions only, where there is no condition to poll on. */
const settle = (page: Page, ms = 800): Promise<void> => page.waitForTimeout(ms);

test.describe('hero', () => {
  test('reveals only once a frame has painted, and hides the poster behind it', async ({
    page,
  }) => {
    await page.goto('/demo/hero.html');

    await expect
      .poll(() =>
        page.evaluate(() => document.getElementById('hero')!.hasAttribute('data-polite-ready'))
      )
      .toBe(true);

    expect(
      await page.evaluate(() => !document.querySelector<HTMLVideoElement>('#hero video')!.paused)
    ).toBe(true);

    // `data-polite-ready` starts the crossfade rather than completing it, so both
    // of these are polled to their end state. Sampling either one at the moment
    // the attribute lands reads a value mid-transition -- opacity came back as
    // 0.31 here. The earlier version of this test only passed because a fixed
    // sleep skipped the whole fade.
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.querySelector('#hero video')!).opacity)
      )
      .toBe('1');

    // The poster outlasts the fade deliberately: `visibility` carries a
    // --polite-fade delay, so dropping it early would expose whatever sits
    // behind, mid-dissolve.
    await expect
      .poll(() =>
        page.evaluate(() => getComputedStyle(document.querySelector('#hero img')!).visibility)
      )
      .toBe('hidden');
  });

  /**
   * The shipped default is a cut, and this is what that has to mean: something
   * on screen on every single frame of the handoff.
   *
   * Safe for a reason specific to this library. The reveal fires from
   * requestVideoFrameCallback, so a frame has already reached the compositor
   * when the swap happens, and MDN defines a 0s transition-duration as "no
   * transition will happen, that is the switch between the two states will be
   * instantaneous". A library revealing on `playing` cannot make this trade,
   * because at that point it has nothing painted to cut to.
   *
   * Nothing is overridden here on purpose: the point is that a consumer who sets
   * no CSS at all gets this. The sibling test above polls to the end state, so
   * this is the only assertion about what happens *during* the swap.
   */
  test('the default swap leaves neither a gap nor a ghost', async ({ page }) => {
    await page.goto('/demo/hero.html');

    const trace = await page.evaluate(async () => {
      const box = document.getElementById('hero')!;
      const video = box.querySelector('video')!;
      const poster = box.querySelector('img')!;
      const frames: { opacity: number; posterVisible: boolean }[] = [];

      // Frame-capped rather than open-ended, so a reveal that never arrives
      // fails the assertions below instead of hanging the run.
      let afterReady = 0;
      for (let i = 0; i < 900 && afterReady < 5; i += 1) {
        frames.push({
          opacity: Number(getComputedStyle(video).opacity),
          posterVisible: getComputedStyle(poster).visibility !== 'hidden',
        });
        if (box.hasAttribute('data-polite-ready')) afterReady += 1;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      return {
        frames,
        duration: getComputedStyle(video).transitionDuration,
        revealed: afterReady > 0,
      };
    });

    // Guards the test itself, and pins the default: raise it and this fails here
    // rather than silently downgrading the two assertions below to nothing.
    expect(trace.duration).toBe('0s');
    expect(trace.revealed).toBe(true);

    // Never a gap: the poster is up, or the video is fully opaque over it.
    expect(trace.frames.filter((f) => !f.posterVisible && f.opacity !== 1)).toEqual([]);
    // Never a ghost: no frame catches the video part-way, which is the doubled
    // image that a fade between two different pictures produces.
    expect(trace.frames.filter((f) => f.opacity !== 0 && f.opacity !== 1)).toEqual([]);
  });

  test('emits a bubbling ready event a host can listen for', async ({ page }) => {
    await page.goto('/demo/hero.html');
    await expect.poll(() => page.evaluate(() => window.__marks.ready !== null)).toBe(true);
  });

  // Not expressed as "ready came after playing": those two are unordered by codec
  // (H.264 painted 1.6 ms before, AV1 0.8 ms after), so that
  // comparison would be flaky in exactly the way the measurement warns about.
  //
  // Nor on the frame counter, which was tried and does not survive contact with
  // other engines: at reveal it reads 4 in Chromium, 1 in WebKit and 0 in Firefox,
  // where frames are demonstrably flowing (2 a moment later). MDN defines
  // totalVideoFrames as frames the element "would have presented", so the concept
  // is right and the update timing is not portable.
  //
  // readyState turned out to be no better. This asserted HAVE_CURRENT_DATA and
  // failed reproducibly in Chromium under a full parallel run, reporting 1
  // (HAVE_METADATA) at reveal while passing whenever the test ran alone. So it
  // is a third proxy that lags the signal rather than bounding it, and asserting
  // it more strictly only buys a flaky suite.
  //
  // The honest floor is HAVE_METADATA: the reveal never lands on an element that
  // has not even resolved its stream. The strong claim is not testable from
  // outside -- rVFC is definitionally the presentation signal, so every available
  // oracle is weaker than the thing itself, and the guarantee rests on the API
  // contract plus the codec-ordering measurement noted earlier in this file.
  test('never reveals before the element has resolved its media', async ({ page }) => {
    await page.goto('/demo/hero.html');
    await expect.poll(() => page.evaluate(() => window.__marks.ready !== null)).toBe(true);

    const marks = await page.evaluate(() => window.__marks);
    expect(marks.readyStateAtReveal).toBeGreaterThanOrEqual(1);
  });
});

test.describe('source fallback', () => {
  // The library's reason to exist: canPlayType answers "probably" for the
  // truncated AV1, the decode then fails, and the next source takes over.
  test('falls through a source the browser claimed it could play', async ({ page }) => {
    await page.goto('/demo/fallback.html');

    await expect
      .poll(() => page.evaluate(() => window.__state().recoversSrc))
      .toBe('sample-h264.mp4');
    await expect.poll(() => page.evaluate(() => window.__state().recoversReady)).toBe(true);
  });

  test('keeps the poster and flags the container when nothing is decodable', async ({ page }) => {
    await page.goto('/demo/fallback.html');

    await expect.poll(() => page.evaluate(() => window.__state().exhaustsFailed)).toBe(true);
    expect(await page.evaluate(() => window.__events)).toContain('exhausts:failed');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('#exhausts img')!).visibility
      )
    ).toBe('visible');
  });
});

test.describe('arbitration', () => {
  test('plays one video at a time on a small viewport', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());

    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);
  });

  test('plays every visible video on a large viewport', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());

    // Greater than one is the meaningful claim: the exact count depends on how
    // many cards the viewport fits, but "more than the mobile slot" does not.
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBeGreaterThan(1);
  });

  test('stops everything once the grid is scrolled away', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBeGreaterThan(0);

    await page.evaluate(() => window.scrollTo(0, 0));
    // Offscreen decoding is the contention the arbiter exists to prevent.
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(0);
  });
});

test.describe('feed', () => {
  // A desktop viewport on purpose: one-at-a-time used to be reachable only by
  // declaring the viewport small, so a 1440px window is where the old option
  // could not express this at all.
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/demo/feed.html');
  });

  test('never plays two videos, however far it is scrolled', async ({ page }) => {
    // Stepped rather than card-by-card. Centring a card lands outside the zone
    // where two are both past half visible, so it leaves arbitration untested:
    // measured, a mutant with arbitration disabled still passed in two of three
    // engines when each card was centred.
    const counts: number[] = [];
    for (let step = 0; step < 24; step += 1) {
      await page.evaluate(() => window.scrollBy(0, 200));
      await page.waitForTimeout(120);
      counts.push(await page.evaluate(() => window.__playingCount()));
    }

    // Never two, and at some point one: a feed that quietly played nothing would
    // satisfy the first half on its own.
    expect(Math.max(...counts)).toBe(1);
  });

  test('buffers the next card before it is eligible to play', async ({ page }) => {
    await page.evaluate(() => {
      document.querySelector('[data-card="0"]')!.scrollIntoView({ block: 'center' });
    });
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);

    // More promoted than playing: the card below has been told to fetch while it
    // is still 200px out, which is the difference between arriving ready and
    // arriving as a poster.
    await expect.poll(() => page.evaluate(() => window.__preloadCount())).toBeGreaterThan(1);
  });
});

test.describe('pause control (WCAG 2.2.2)', () => {
  test('stops playback and stays stopped across arbitration passes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);

    await page.click('[data-polite-pause-control]');
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(0);
    expect(
      await page.evaluate(() => document.documentElement.hasAttribute('data-polite-paused'))
    ).toBe(true);

    // The trap: scrolling triggers a reconcile, which must not resurrect a video
    // the user deliberately stopped. Nothing to poll for here -- the assertion is
    // that a thing keeps *not* happening -- so this one settles first.
    await page.evaluate(() => window.scrollBy(0, 400));
    await settle(page);
    expect(await page.evaluate(() => window.__playingCount())).toBe(0);

    await page.click('[data-polite-pause-control]');
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);
  });
});

test.describe('the pause-state event', () => {
  /**
   * The label-swapping control the README offers as an alternative to
   * aria-pressed. It is only buildable because the library announces the change:
   * the other signal is an attribute on <html>, and watching that means a
   * MutationObserver on the root element for one boolean.
   *
   * /demo/sizes.html carries no aria-pressed on purpose, so this also proves the
   * library leaves that pattern's control alone.
   */
  test('drives a label swap, and leaves aria-pressed off that control', async ({ page }) => {
    await page.goto('/demo/sizes.html');
    const control = page.locator('[data-polite-pause-control]');

    await expect(control).toHaveText(/pause/i);
    await expect(control).not.toHaveAttribute('aria-pressed');

    await control.click();
    await expect(control).toHaveText(/play/i);
    // Counted here rather than through a demo helper: the label is not the
    // claim, stopping the videos is, and a label that swaps over still-playing
    // media would pass every other assertion in this test.
    await expect
      .poll(() =>
        page.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).length)
      )
      .toBe(0);

    await control.click();
    await expect(control).toHaveText(/pause/i);
    await expect(control).not.toHaveAttribute('aria-pressed');
  });
});

test.describe('startWhen', () => {
  /**
   * The whole point of the `'page-loaded'` default, asserted the way a page
   * performance tool would see it rather than through library internals: the
   * video's own resource-timing entry must begin after the page finished
   * loading. Module scripts are deferred, so without the gate the fetch lands
   * inside the tail of page load and competes with it.
   */
  test('does not fetch the video until the page has loaded', async ({ page }) => {
    // The demo loads in about 45ms, so on its own the video fetch lands after
    // `load` whatever the setting and the assertion below proves nothing --
    // verified by mutation, which it survived. Holding one of the page's own
    // resources back is what creates a window for the video to jump into.
    await page.route('**/sample-poster.avif', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await route.continue();
    });

    await page.goto('/demo/hero.html');
    await expect.poll(() => page.evaluate(() => window.__marks.ready !== null)).toBe(true);

    const timing = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const media = performance
        .getEntriesByType('resource')
        .filter((r) => /\.mp4$/.test(r.name)) as PerformanceResourceTiming[];
      return {
        loadEventEnd: nav.loadEventEnd,
        videoStart: media[0]?.startTime ?? null,
        videoCount: media.length,
      };
    });

    expect(timing.videoCount).toBeGreaterThan(0);
    expect(timing.loadEventEnd).toBeGreaterThan(0);
    expect(timing.videoStart).toBeGreaterThanOrEqual(timing.loadEventEnd);
  });
});

test.describe('reduced motion', () => {
  test('never starts a video and leaves the poster in place', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/demo/hero.html');
    // Negative assertion: settle long enough that a start would have happened.
    await settle(page);

    const state = await page.evaluate(() => ({
      ready: document.getElementById('hero')!.hasAttribute('data-polite-ready'),
      playing: !document.querySelector<HTMLVideoElement>('#hero video')!.paused,
      posterVisibility: getComputedStyle(document.querySelector('#hero img')!).visibility,
    }));

    expect(state.playing).toBe(false);
    expect(state.ready).toBe(false);
    expect(state.posterVisibility).toBe('visible');
  });
});

test.describe('contracts', () => {
  // Both reference projects run `default-src 'none'` with no style-src
  // 'unsafe-inline', which blocks style attributes outright. Asserted
  // mechanically because "we do not write inline styles" is exactly the kind of
  // promise that decays silently.
  for (const path of ['/demo/hero.html', '/demo/bento.html', '/demo/sizes.html']) {
    test(`writes no inline style attribute on ${path}`, async ({ page }) => {
      await page.goto(path);
      await settle(page);
      expect(await page.locator('[style]').count()).toBe(0);
    });
  }

  /**
   * The image half keeps a fade where video cuts, because a lone image has no
   * second moving picture to diverge from. Overriding it here also proves the
   * property is wired at all, which no test covers now that the video default
   * *is* the cut -- the two stylesheets build it from the identical `var()`.
   *
   * Deliberately one page: a second `goto` in the same test times out in Firefox
   * under a full parallel run, and the video default is pinned by the reveal
   * test above.
   */
  /**
   * The realistic form of the misconfiguration, which the unit suite cannot
   * reach: happy-dom reports '' for an unstyled opacity, so only a real browser
   * supplies the '1' default that makes the reveal provably a no-op.
   *
   * Stripping the attribute before the module runs reproduces putting it on the
   * wrong element, since either way the box the library writes to is not the box
   * the stylesheet reads.
   */
  test('warns when the markup gives the reveal nothing to act on', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });

    await page.addInitScript(() => {
      document.addEventListener('DOMContentLoaded', () =>
        document.getElementById('hero')?.removeAttribute('data-polite-media')
      );
    });
    await page.goto('/demo/hero.html');

    await expect
      .poll(() => warnings.filter((w) => w.includes('data-polite-media')))
      .not.toEqual([]);
  });

  // Every video demo, not just the hero: the warning is page-wide, so a demo that
  // drifted out of the markup contract would start warning and nothing would say
  // so if only one page were checked.
  for (const path of [
    '/demo/hero.html',
    '/demo/bento.html',
    '/demo/sizes.html',
    '/demo/fallback.html',
  ]) {
    test(`stays silent on ${path}, which is correctly marked up`, async ({ page }) => {
      const warnings: string[] = [];
      page.on('console', (message) => {
        if (message.type() === 'warning') warnings.push(message.text());
      });

      await page.goto(path);

      // The warning fires when a video first starts, so a page where nothing
      // started proves nothing. Measured on bento.html: at 800ms none of its
      // twelve boxes had begun, the grid sitting below the fold, so asserting
      // silence there was vacuous.
      //
      // Centred on the media rather than scrolled to the page bottom, because
      // `playAbove` now means partial visibility is not enough: at the bottom of
      // bento.html the grid is clipped and no card clears the threshold, where
      // centred all twelve reach 0.93 or better.
      await page.evaluate(() =>
        document.querySelector('[data-polite-media]')?.scrollIntoView({ block: 'center' })
      );
      // Polled on the ready attribute alone, which the library sets whatever the
      // markup says. Requiring data-polite-media here too would make a broken
      // page fail on this line instead of on the warning below, reporting the
      // precondition rather than the defect.
      await expect.poll(() => page.locator('[data-polite-ready]').count()).toBeGreaterThan(0);
      await settle(page);

      expect(warnings.filter((w) => w.includes('polite-media'))).toEqual([]);
    });
  }

  test('images keep a 350ms fade, and --polite-fade overrides it', async ({ page }) => {
    await page.goto('/demo/images.html');
    const image = '[data-polite-reveal]';

    expect(
      await page.evaluate(
        (sel) => getComputedStyle(document.querySelector(sel)!).transitionDuration,
        image
      )
    ).toBe('0.35s');

    expect(
      await page.evaluate((sel) => {
        document.documentElement.style.setProperty('--polite-fade', '250ms');
        return getComputedStyle(document.querySelector(sel)!).transitionDuration;
      }, image)
    ).toBe('0.25s');
  });

  test('imposes no geometry: identical markup renders at four different sizes', async ({
    page,
  }) => {
    await page.goto('/demo/sizes.html');
    await expect.poll(() => page.locator('#sizes .frame video').count()).toBe(4);

    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('#sizes .frame video')].map((v) => {
        const r = v.getBoundingClientRect();
        return `${Math.round(r.width)}x${Math.round(r.height)}`;
      })
    );

    // Four distinct shapes, all from page CSS alone. If the library ever started
    // setting a dimension, these would converge.
    expect(new Set(boxes).size).toBe(4);
    expect(boxes.every((b) => !b.startsWith('0x'))).toBe(true);
  });
});

test.describe('images without scripting', () => {
  // A hidden image degrades to nothing, unlike a video which degrades to its
  // poster, so the hiding rule is gated on `scripting: enabled`. Without that
  // gate every marked image stays invisible for good when JS is unavailable,
  // which is worse than never fading at all.
  //
  // /demo/no-js.html exists for this: every other demo builds its markup in
  // JavaScript, so with scripting off they contain no images to assert on. Note
  // page.evaluate cannot run here either, hence the locator assertions.
  test.use({ javaScriptEnabled: false });

  test('leaves marked images fully visible when scripting is off', async ({ page }) => {
    await page.goto('/demo/no-js.html');

    const images = page.locator('img[data-polite-reveal]');
    await expect(images).toHaveCount(2);
    for (const image of await images.all()) {
      await expect(image).toHaveCSS('opacity', '1');
    }
  });
});

test.describe('images', () => {
  test('reveals lazy images once decoded', async ({ page }) => {
    await page.goto('/demo/images.html');
    await expect.poll(() => page.evaluate(() => window.__readyCount('#lazy'))).toBe(4);
  });

  test('reveals eager images on the first tick, without waiting on decode', async ({ page }) => {
    await page.goto('/demo/images.html');
    // The count the page took synchronously, not one read after navigation:
    // by the time a test can evaluate, the decode path has usually finished too,
    // so a reading here passes whether the reveal was immediate or merely quick.
    // LCP excludes elements at opacity 0 and revealing one does not restore
    // candidacy, so an eager image has to be visible from its first paint.
    expect(await page.evaluate(() => window.__eagerReadyAtSetup)).toBe(4);
  });

  test('never leaves an eager image invisible', async ({ page }) => {
    await page.goto('/demo/images.html');
    await settle(page);
    // The bug this replaced: the guard skipped images that image.css had
    // already hidden, leaving them blank for good rather than merely unfaded.
    const opacity = await page.evaluate(
      () => getComputedStyle(document.querySelector('#eager img')!).opacity
    );
    expect(opacity).toBe('1');
  });
});

test.describe('reveal failsafe', () => {
  // The stylesheet reveals a marked image on a delay whatever JavaScript does,
  // so a missed selector or a bundle that never arrives costs the fade rather
  // than the picture. Before this, either left the image invisible permanently.
  test('reveals an image no revealImages() call manages', async ({ page }) => {
    await page.goto('/demo/reveal-failsafe.html');

    // Hidden at first, or the failsafe would be defeating the fade it exists
    // alongside rather than backstopping it.
    expect(await page.evaluate(() => window.__opacity('stray'))).toBe('0');

    await expect.poll(() => page.evaluate(() => window.__opacity('stray'))).toBe('1');
    // Revealed by CSS alone: the library never claimed it, so no ready attribute.
    expect(await page.evaluate(() => window.__isReady('stray'))).toBe(false);
  });

  test('still lets a managed image reveal normally, and reports the stray one', async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });

    await page.goto('/demo/reveal-failsafe.html');

    await expect.poll(() => page.evaluate(() => window.__isReady('managed'))).toBe(true);
    // Polled, not sampled: ready starts the 350ms fade rather than completing
    // it, and reading straight after the attribute lands catches it mid-way.
    await expect.poll(() => page.evaluate(() => window.__opacity('managed'))).toBe('1');

    await expect.poll(() => warnings.filter((text) => /revealImages/.test(text)).length).toBe(1);
  });
});

test.describe('the interaction default', () => {
  // demo/interaction.html configures nothing, so this is what a consumer gets
  // out of the box. Every other video demo opts into 'page-loaded' precisely
  // because this gate would otherwise be in the way of what they demonstrate,
  // which means this is the only place the shipped default is exercised.
  test('holds the video until the visitor does something, then starts it', async ({ page }) => {
    await page.goto('/demo/interaction.html');

    // Absence cannot be polled for, so settle first and say so.
    await settle(page);
    expect(await page.evaluate(() => window.__playing())).toBe(false);

    // A real key press rather than a synthesised event: the point is that a
    // genuine visitor action opens the gate.
    await page.keyboard.press('Shift');

    await expect.poll(() => page.evaluate(() => window.__playing())).toBe(true);
  });
});

/**
 * Outside the `feed` describe on purpose: this test navigates itself, and
 * inheriting a beforeEach that fully loads a second page first put a real video
 * fetch in flight on the server all three engines share.
 */
test.describe('rootMargin and the page gate', () => {
  test('still waits for page load before fetching, margin or not', async ({ page }) => {
    // rootMargin nearly defeated startWhen: prefetch fired on the observer's
    // first batch, so the fetch it triggers landed inside page load -- exactly
    // the contention the 'page-loaded' default was measured to avoid.
    //
    // Asserted as state while load is held open, not as request ordering. The
    // ordering version passed alone and failed in the parallel run, because all
    // three engines share one single-threaded server and the race is decided by
    // whoever gets served first.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // A poster, not the stylesheet: a render-blocking <link> in <head> also
    // blocks the module script that builds the feed, so nothing would exist to
    // observe. An image delays `load` and nothing else.
    await page.route('**/sample-poster.avif', async (route) => {
      await held;
      await route.continue();
    });

    await page.goto('/demo/feed.html', { waitUntil: 'commit' });
    // The observer has certainly reported by now, which is the moment the
    // unfixed version promoted preload and started fetching.
    await page.waitForFunction(() => document.querySelectorAll('#feed video').length === 6);
    expect(await page.evaluate(() => document.readyState)).not.toBe('complete');
    expect(await page.evaluate(() => window.__preloadCount())).toBe(0);

    release();
    // Waiting for `load` separately, so the released poster's download time is
    // not spent out of the poll's budget. Folded together, the poll's default 5s
    // had to cover a real image fetch from a server three engines are sharing,
    // and Firefox lost that race in roughly one full run in five while passing
    // alone every time. The promotion itself happens in the reconcile that
    // `load` triggers, so once loaded it is immediate.
    await page.waitForFunction(() => document.readyState === 'complete');
    await expect.poll(() => page.evaluate(() => window.__preloadCount())).toBeGreaterThan(0);
  });
});

/**
 * The inverse of the hero's "leaves neither a gap nor a ghost" test. That one
 * pins the shipped default by asserting no frame ever catches the video
 * part-way; this one pins that a host can opt out, by asserting some frame does.
 * Between them the behaviour is nailed in both directions.
 */
test.describe('a per-video --polite-fade', () => {
  test('crossfades the one container that asks, and cuts the one that does not', async ({
    page,
  }) => {
    await page.goto('/demo/art-directed.html');

    const trace = await page.evaluate(async () => {
      const seen = { faded: [] as number[], cut: [] as number[], posterDuringFade: true };

      for (let i = 0; i < 900; i += 1) {
        const faded = Number(window.__videoOpacity('faded'));
        seen.faded.push(faded);
        seen.cut.push(Number(window.__videoOpacity('cut')));
        // The poster must still be under the video while it dissolves, or the
        // fade would reveal whatever sits behind the box instead.
        if (faded > 0 && faded < 1 && !window.__posterVisible('faded')) {
          seen.posterDuringFade = false;
        }
        if (faded === 1 && seen.faded.some((o) => o > 0 && o < 1)) break;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }

      return {
        ...seen,
        fadedDuration: window.__fadeDuration('faded'),
        cutDuration: window.__fadeDuration('cut'),
      };
    });

    // Guards the test itself: if the demo stopped setting the property these
    // assertions would quietly become vacuous.
    expect(trace.fadedDuration).toBe('0.6s');
    expect(trace.cutDuration).toBe('0s');

    // The opt-in container dissolves: some frame is genuinely part-way.
    expect(trace.faded.filter((o) => o > 0 && o < 1).length).toBeGreaterThan(0);
    expect(trace.posterDuringFade).toBe(true);

    // Its neighbour, same page and same stylesheet, still cuts.
    expect(trace.cut.filter((o) => o > 0 && o < 1)).toEqual([]);
  });
});

/**
 * layer.css is the one stylesheet that touches layout, and it exists because two
 * consumers independently wrote the same five declarations rather than find them
 * in the docs. Both poster shapes are covered: the `<picture>` case needs its own
 * selector, since object-fit "Applies to: replaced elements" and a picture is a
 * container rather than one.
 */
test.describe('the stacking stylesheet', () => {
  for (const id of ['bare', 'picture']) {
    test(`makes both layers fill the box, poster as ${id}`, async ({ page }) => {
      await page.goto('/demo/layered.html');

      const fills = await page.evaluate((box) => window.__fills(box), id);

      expect(fills.poster).toBe(true);
      expect(fills.video).toBe(true);
      // Without this the poster letterboxes inside a box it is supposed to cover,
      // which is the failure the selector split exists to prevent.
      expect(fills.objectFit).toBe('cover');
    });
  }
});
