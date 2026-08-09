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
  // (H.264 painted 1.6 ms before, AV1 0.8 ms after, docs/findings.md), so that
  // comparison would be flaky in exactly the way the measurement warns about.
  //
  // Nor on the frame counter, which was tried and does not survive contact with
  // other engines: at reveal it reads 4 in Chromium, 1 in WebKit and 0 in Firefox,
  // where frames are demonstrably flowing (2 a moment later). MDN defines
  // totalVideoFrames as frames the element "would have presented", so the concept
  // is right and the update timing is not portable.
  //
  // What is left is the guarantee that does hold everywhere: the reveal never
  // lands while the element still has nothing decodable. rVFC is definitionally
  // the presentation signal, and there is no independent oracle to check it
  // against -- any proxy is weaker than the thing itself.
  test('never reveals while the element has nothing decoded', async ({ page }) => {
    await page.goto('/demo/hero.html');
    await expect.poll(() => page.evaluate(() => window.__marks.ready !== null)).toBe(true);

    const marks = await page.evaluate(() => window.__marks);
    expect(marks.readyStateAtReveal).toBeGreaterThanOrEqual(2);
  });
});

test.describe('source fallback', () => {
  // The library's reason to exist: canPlayType answers "probably" for the
  // truncated AV1, the decode then fails, and the next source takes over. Same
  // shape as Safari on Apple hardware without an AV1 decoder.
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

test.describe('pause control (WCAG 2.2.2)', () => {
  test('stops playback and stays stopped across arbitration passes', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);

    await page.click('[data-polite-pause]');
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

    await page.click('[data-polite-pause]');
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);
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
   * The two defaults differ on purpose: video cuts because playback advances
   * past a frozen poster, an image has no second moving picture and fades to
   * cover its decode. Both read one property, so this also proves the knob is
   * wired -- no other test overrides it now that the default is the cut.
   */
  test('defaults to a 0s video fade and a 350ms image fade, both overridable', async ({ page }) => {
    await page.goto('/demo/hero.html');
    expect(
      await page.evaluate(
        () => getComputedStyle(document.querySelector('#hero video')!).transitionDuration
      )
    ).toBe('0s');

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

test.describe('images', () => {
  test('reveals lazy images once decoded', async ({ page }) => {
    await page.goto('/demo/images.html');
    await expect.poll(() => page.evaluate(() => window.__readyCount('#lazy'))).toBe(4);
  });

  test('reveals eager images on the first tick, without waiting on decode', async ({ page }) => {
    await page.goto('/demo/images.html');
    // Deliberately not polled. Polling to 4 is satisfied by the lazy path as
    // well, so it could not tell "immediately" from "eventually" -- which is the
    // whole claim. LCP excludes elements at opacity 0 and revealing one does not
    // restore candidacy, so an eager image has to be visible from its first paint.
    expect(await page.evaluate(() => window.__readyCount('#eager'))).toBe(4);
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
