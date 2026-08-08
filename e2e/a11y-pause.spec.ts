import { expect, test } from '@playwright/test';

/**
 * WCAG 2.2.2 for this library, asserted directly, because axe cannot see any of
 * it: its only rules tagged `wcag222` are `blink` and `marquee`.
 *
 * The criterion applies to content that moves automatically, runs longer than
 * five seconds, and sits alongside other content. A looping background video
 * behind readable page content is all three, and honouring
 * `prefers-reduced-motion` does not satisfy it -- the W3C understanding document
 * does not list it as a sufficient technique.
 */

const videoPages = [
  '/demo/hero.html',
  '/demo/bento.html',
  '/demo/sizes.html',
  '/demo/fallback.html',
];

for (const path of videoPages) {
  test(`${path} offers a pause mechanism`, async ({ page }) => {
    await page.goto(path);
    // Three of these four shipped without one, on the pages whose job is to
    // demonstrate the library's compliance.
    await expect(page.locator('[data-polite-pause]')).toHaveCount(1);
  });
}

test.describe('the pause control', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/demo/bento.html');
    await page.evaluate(() => document.getElementById('grid')!.scrollIntoView());
    await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);
  });

  test('is a native button, which is what makes it keyboard-operable', async ({ page }) => {
    // Not cosmetic. The library binds a delegated `click`, and a browser only
    // synthesises that from Enter and Space for a native button: a
    // div[role="button"][tabindex="0"] answers a mouse and ignores a keyboard.
    await expect(page.locator('[data-polite-pause]')).toHaveJSProperty('tagName', 'BUTTON');
  });

  test('has an accessible name', async ({ page }) => {
    await expect(page.locator('[data-polite-pause]')).toHaveAccessibleName(/pause/i);
  });

  test('is reachable by Tab, not buried behind the media', async ({ page, browserName }) => {
    // WebKit puts nothing in the tab order by default: macOS gates that behind
    // "Press Tab to highlight each item on a webpage", and a page cannot
    // override a user's system preference. Measured: eight Tab presses in
    // Playwright's WebKit leave activeElement on BODY throughout, for every
    // element on the page, so this asserts nothing there. Operability once
    // focused is covered by the Enter and Space tests, which do run in WebKit.
    test.skip(browserName === 'webkit', 'WebKit tab order follows a macOS system preference');

    for (let i = 0; i < 30; i += 1) {
      await page.keyboard.press('Tab');
      const onControl = await page.evaluate(
        () => document.activeElement?.hasAttribute('data-polite-pause') ?? false
      );
      // Two presses in practice. Before the decorative videos were given
      // tabindex="-1", Firefox put all twelve of them ahead of this button.
      if (onControl) return;
    }
    throw new Error('the pause control was not reachable within 30 Tab presses');
  });

  // Asserted on video.paused, not on an attribute: "stops playback" is the claim,
  // and an attribute could be set while the media kept running.
  for (const key of ['Enter', ' ']) {
    test(`${key === ' ' ? 'Space' : key} genuinely stops and restarts playback`, async ({
      page,
    }) => {
      await page.locator('[data-polite-pause]').focus();
      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(0);

      await page.keyboard.press(key);
      await expect.poll(() => page.evaluate(() => window.__playingCount())).toBe(1);
    });
  }

  test('announces its state to assistive technology', async ({ page }) => {
    // Without this the control stops playback and nothing changes in the
    // accessibility tree, so a screen reader user gets no confirmation.
    const control = page.locator('[data-polite-pause]');
    await expect(control).toHaveAttribute('aria-pressed', 'false');

    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'true');

    await control.click();
    await expect(control).toHaveAttribute('aria-pressed', 'false');
  });
});
