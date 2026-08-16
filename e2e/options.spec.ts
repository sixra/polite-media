import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The three options that shipped with unit tests and nothing else: `until`,
 * `requireBuffered` and `playAbove`. happy-dom implements no media playback, so
 * until now none of them had ever been exercised in a browser, and one of them
 * (`until`) is what one of the projects this came out of uses to hold a hero
 * behind a splash screen.
 *
 * Each page here sets `startWhen: 'page-loaded'` deliberately. The shipped
 * 'interaction' default would hold playback on its own, so every assertion below
 * would pass with the option under test deleted, which is the exact way two
 * tests in this suite have already managed to assert nothing.
 */

test.describe('until', () => {
  test('holds a visible hero, and its fetch, until the promise settles', async ({ page }) => {
    await page.goto('/demo/until.html');
    await page.waitForFunction(() => typeof window.__playing === 'function');
    // Long enough that page load, the observer's first batch and a reconcile
    // have all been and gone. The hero is at scroll top and fully visible, so
    // this is precisely when an ungated video would already be running.
    await page.waitForTimeout(600);

    expect(await page.evaluate(() => window.__playing())).toBe(false);

    /*
     * `preload` and readyState rather than counting requests. A gated entry
     * returns from prefetch() before the promotion, so "still none" is the
     * library's own evidence that no bytes were asked for.
     *
     * Counting page requests was tried first and is not usable here: WebKit
     * reported zero .mp4 requests through Playwright even after the video was
     * demonstrably playing, which would have made the "nothing fetched yet"
     * assertion vacuously true on that engine.
     */
    expect(await page.evaluate(() => window.__preload())).toBe('none');
    expect(await page.evaluate(() => document.querySelector('video')!.readyState)).toBe(0);

    await page.click('#dismiss');

    await expect.poll(() => page.evaluate(() => window.__playing())).toBe(true);

    /*
     * The mirror of readyState 0 above: data only arrived once the gate opened.
     *
     * Polled, not read once. `paused` flips to false the instant play() is
     * called, well before a single byte lands, so the line above proves intent
     * rather than playback. That gap is the same one that makes `playing` an
     * unreliable reveal signal and rVFC the right one.
     *
     * Not asserted as preload becoming 'auto' either, which was tried and is
     * wrong: that promotion belongs to prefetch() and to requireBuffered, and a
     * video that simply starts playing never needs it.
     */
    await expect
      .poll(() => page.evaluate(() => document.querySelector('video')!.readyState))
      .toBeGreaterThan(0);
  });
});

test.describe('requireBuffered', () => {
  /*
   * Asserted as event order, which is the only thing this option decides.
   *
   * Two more obvious tests were written first and both prove nothing. `preload`
   * reaching 'auto' is not it: prefetch() at coordinator.ts:834 promotes any
   * nearby video whether or not the option is set. And "held bytes mean no
   * playback" is not it either, since starving a video of data stops it with the
   * option off as well.
   *
   * What only requireBuffered does is refuse to play until canplaythrough. With
   * it off, play() is called as soon as the video is on screen and the browser
   * begins at HAVE_FUTURE_DATA, one readyState below.
   */
  test('will not start until canplaythrough, not merely until it can start', async ({ page }) => {
    // Holding the bytes first widens the gap between the two readyStates so the
    // ordering is decided by the library rather than by how fast localhost is.
    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/sample-h264.mp4', async (route) => {
      await held;
      await route.continue();
    });

    await page.goto('/demo/buffered.html');
    await page.waitForFunction(() => typeof window.__playing === 'function');
    await page.waitForTimeout(400);

    expect(await page.evaluate(() => window.__playing())).toBe(false);

    release();
    await expect.poll(() => page.evaluate(() => window.__playing())).toBe(true);
    expect(await page.evaluate(() => window.__order[0])).toBe('canplaythrough');
  });
});

test.describe('the playAbove and pauseBelow band', () => {
  /** Scroll so `target` of the box shows, then confirm it actually landed there. */
  async function scrollTo(page: Page, target: number): Promise<void> {
    await page.evaluate((t) => window.__scrollToRatio(t), target);
    await expect.poll(() => page.evaluate(() => window.__visibleRatio())).toBeCloseTo(target, 1);
    // One reconcile is driven by the observer, which reports asynchronously.
    await page.waitForTimeout(400);
  }

  test('needs playAbove to start, but only pauseBelow to keep going', async ({ page }) => {
    await page.goto('/demo/band.html');
    await page.waitForFunction(() => typeof window.__scrollToRatio === 'function');

    // 40% is between the two thresholds, which is the only place the band shows:
    // over pauseBelow, under playAbove. Coming up from below, a stopped video has
    // not cleared playAbove, so it stays stopped.
    await scrollTo(page, 0.4);
    expect(await page.evaluate(() => window.__playing())).toBe(false);

    // 70% clears playAbove.
    await scrollTo(page, 0.7);
    expect(await page.evaluate(() => window.__playing())).toBe(true);

    // Back to the same 40%, and now the answer is the opposite one. This is the
    // band: the crossing that starts it and the crossing that stops it are in
    // different places, so a video parked here cannot oscillate.
    await scrollTo(page, 0.4);
    expect(await page.evaluate(() => window.__playing())).toBe(true);

    // Below pauseBelow it finally stops.
    await scrollTo(page, 0.2);
    await expect.poll(() => page.evaluate(() => window.__playing())).toBe(false);
  });

  test('warns about nothing, because the box can reach the threshold', async ({ page }) => {
    // The library warns when a box is too tall for its highest possible visible
    // fraction to clear playAbove. Silence is the assertion that this demo is
    // sized honestly rather than accidentally demonstrating the warning.
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });

    await page.goto('/demo/band.html');
    await page.waitForFunction(() => typeof window.__scrollToRatio === 'function');
    await page.waitForTimeout(500);

    expect(warnings).toHaveLength(0);
  });
});
