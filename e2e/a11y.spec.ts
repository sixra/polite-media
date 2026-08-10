import { AxeBuilder } from '@axe-core/playwright';
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
