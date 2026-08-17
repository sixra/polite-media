import { expect, test } from '@playwright/test';

/**
 * The two options that shipped with unit tests and nothing else: `until` and
 * `requireBuffered`. happy-dom implements no media playback, so until now neither
 * had ever been exercised in a browser, and `until` is what one of the projects
 * this came out of uses to hold a hero behind a splash screen.
 *
 * Neither page configures `startWhen`. On the shipped 'page-loaded' default
 * nothing else is holding playback, so whatever these tests observe is the option
 * under test and not a gate standing in for it. Each assertion below was checked
 * by deleting its option and watching the test go red.
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
