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
  test('reveals only once a frame has painted, and hides the poster behind it', async ({ page }) => {
    await page.goto('/demo/hero.html');

    await expect
      .poll(() => page.evaluate(() => document.getElementById('hero')!.hasAttribute('data-polite-ready')))
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

  test('emits a bubbling ready event a host can listen for', async ({ page }) => {
    await page.goto('/demo/hero.html');
    await expect.poll(() => page.evaluate(() => window.__marks.ready !== null)).toBe(true);
  });
});

test.describe('source fallback', () => {
  // The library's reason to exist: canPlayType answers "probably" for the
  // truncated AV1, the decode then fails, and the next source takes over. Same
  // shape as Safari on Apple hardware without an AV1 decoder.
  test('falls through a source the browser claimed it could play', async ({ page }) => {
    await page.goto('/demo/fallback.html');

    await expect.poll(() => page.evaluate(() => window.__state().recoversSrc)).toBe(
      'sample-h264.mp4'
    );
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

  test('reveals eager images immediately instead of fading them', async ({ page }) => {
    await page.goto('/demo/images.html');
    // LCP excludes elements at opacity 0 and revealing one does not restore its
    // candidacy, so an eager image is shown at once rather than faded in.
    await expect.poll(() => page.evaluate(() => window.__readyCount('#eager'))).toBe(4);
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
