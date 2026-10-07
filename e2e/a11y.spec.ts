import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The machine-detectable half: contrast, language, names, ARIA misuse, landmarks.
 *
 * It is only half. axe's rules tagged `wcag222` are `blink` and `marquee`, both
 * legacy elements, so an autoplaying `<video loop>` with no pause mechanism scans
 * completely clean here -- which is this library's entire subject. That is what
 * a11y-pause.spec.ts exists for, and why neither file is redundant.
 */
const pages = [
  '/demo/index.html',
  '/demo/hero.html',
  '/demo/bento.html',
  '/demo/sizes.html',
  '/demo/fallback.html',
  '/demo/images.html',
  '/demo/no-js.html',
  '/demo/rvfc-spike.html',
  '/demo/poster-alt.html',
];

for (const path of pages) {
  test(`no axe violations on ${path}`, async ({ page }, testInfo) => {
    await page.goto(path);
    // Scanned after the reveal settles: `data-polite-ready` changes opacity and
    // visibility, and contrast is computed against what is actually rendered.
    await page.waitForTimeout(1500);

    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22a', 'wcag22aa'])
      .analyze();

    await testInfo.attach('axe-violations', {
      body: JSON.stringify(results.violations, null, 2),
      contentType: 'application/json',
    });
    expect(
      results.violations.map((v: { id: string; nodes: unknown[] }) => `${v.id} (${v.nodes.length})`)
    ).toEqual([]);
  });
}

/**
 * Once the video is hidden from assistive technology, the poster's alt is what carries the meaning,
 * so it has to stay in the accessibility tree after the reveal. Waited for on computed opacity, not
 * with `toBeHidden()`: Playwright counts an element at opacity 0 as visible, so that never passes.
 */
test.describe('a revealed poster', () => {
  const name = 'Colour bars test pattern';

  /** The poster's opacity once no transition is running, so a fade cannot pass for its end. */
  const settledOpacity = (page: Page, id: string): Promise<string> =>
    page.evaluate((id) => {
      const poster = document.querySelector(`#${id} img`)!;
      return poster.getAnimations().length > 0 ? 'animating' : window.__posterOpacity(id);
    }, id);

  const revealed = async (page: Page, id: string): Promise<void> => {
    await expect(page.locator(`#${id}[data-polite-ready]`)).toHaveCount(1);
    await expect.poll(() => settledOpacity(page, id)).toBe('0');
  };

  test('keeps its text alternative', async ({ page }) => {
    await page.goto('/demo/poster-alt.html');
    await revealed(page, 'named');

    await expect(page.getByRole('img', { name })).toHaveCount(1);
  });

  // getByRole computes names in Playwright's own script, identically in every engine, so it proves
  // the CSS rather than what a browser exposes. Chromium's own tree is reachable over CDP; Firefox's
  // and WebKit's are not reachable through Playwright at all.
  test("is in Chromium's own accessibility tree", async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'reads the tree over CDP');
    await page.goto('/demo/poster-alt.html');
    await revealed(page, 'named');

    const cdp = await page.context().newCDPSession(page);
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    const images = nodes.filter((node) => !node.ignored && node.role?.value === 'image');

    expect(images.map((node) => node.name?.value)).toContain(name);
  });

  // image.css sets opacity 1 on a revealed image, and loaded after video.css it wins any tie.
  test('stays hidden when image.css revealed it and loaded later', async ({ page }) => {
    await page.goto('/demo/poster-alt.html');
    await expect(page.locator('#lazy img[data-polite-ready]')).toHaveCount(1);

    await revealed(page, 'lazy');
  });

  test('comes back when reduced motion retracts the reveal', async ({ page }) => {
    await page.goto('/demo/poster-alt.html');
    await revealed(page, 'named');

    await page.emulateMedia({ reducedMotion: 'reduce' });

    await expect.poll(() => settledOpacity(page, 'named')).toBe('1');
    await expect(page.getByRole('img', { name })).toHaveCount(1);
  });
});
