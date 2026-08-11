import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';

/**
 * The premise the whole `warm` entry point rests on: a `<picture>` that was
 * never inserted into the document still runs the browser's own source
 * selection, and still fetches what it selects.
 *
 * If that holds, warming costs no selection code at all -- no media query is
 * parsed, no `w` descriptor is compared, no format support is guessed -- and it
 * cannot disagree with the destination page, because it is literally the same
 * algorithm. If it does not hold, the fallback is an off-screen container that
 * is rendered rather than detached, and only this file's setup changes.
 *
 * The HTML Standard supports the premise: selection replaces the candidate list
 * with "el's parent node's child elements" with no connectedness condition. That
 * is a spec reading, so it is asserted here in all three engines before any code
 * is written against it.
 */

const POSTER = '/demo/assets/sample-poster';

/**
 * Builds a detached <picture> and reports what the browser chose.
 *
 * Assembled parent-first, which reads as the obvious order and costs one
 * selection pass rather than two. It is not load-bearing: assigning `src` before
 * appending the <img> was measured to select correctly anyway, because inserting
 * an <img> into a <picture> re-runs selection on its own.
 */
async function choose(
  page: Page,
  spec: {
    sources?: { type: string; srcset: string }[];
    srcset?: string;
    src?: string;
    sizes?: string;
  }
): Promise<string> {
  return page.evaluate(async (spec) => {
    const picture = document.createElement('picture');
    for (const s of spec.sources ?? []) {
      const source = document.createElement('source');
      source.type = s.type;
      source.srcset = s.srcset;
      picture.append(source);
    }
    const img = document.createElement('img');
    picture.append(img);

    if (spec.sizes) img.sizes = spec.sizes;
    if (spec.srcset) img.srcset = spec.srcset;
    if (spec.src) img.src = spec.src;

    // Waiting on the element proves the second half of the premise: a detached
    // image does not merely *select*, it fetches. `error` resolves too, so a
    // genuine 404 fails on the assertion rather than by timing out here.
    await new Promise<void>((resolve) => {
      img.addEventListener('load', () => resolve(), { once: true });
      img.addEventListener('error', () => resolve(), { once: true });
    });
    return img.currentSrc;
  }, spec);
}

test.describe('a detached <picture> selects and fetches (the premise)', () => {
  test('consults its <source> children rather than the <img> src', async ({ page }) => {
    await page.goto('/demo/');

    // image/jpeg deliberately, not AVIF: every engine supports it, so this
    // isolates "was the <picture> consulted at all" from "is this format
    // supported here". A detached picture that is ignored falls through to the
    // img's own src, which is the failure this discriminates.
    const chosen = await choose(page, {
      sources: [{ type: 'image/jpeg', srcset: `${POSTER}.jpg?probe=source` }],
      src: `${POSTER}.jpg?probe=fallback`,
    });

    expect(chosen).toContain('probe=source');
  });

  test('skips a <source> whose type it cannot decode', async ({ page }) => {
    await page.goto('/demo/');

    // The inverse control. Without it the test above would also pass if the
    // browser blindly took the first <source> without checking `type` at all.
    const chosen = await choose(page, {
      sources: [{ type: 'image/x-not-a-real-format', srcset: `${POSTER}.jpg?probe=unsupported` }],
      src: `${POSTER}.jpg?probe=fallback`,
    });

    expect(chosen).toContain('probe=fallback');
  });

  test('picks the AVIF candidate over the JPEG fallback', async ({ page }) => {
    await page.goto('/demo/');

    const chosen = await choose(page, {
      sources: [{ type: 'image/avif', srcset: `${POSTER}.avif` }],
      src: `${POSTER}.jpg`,
    });

    expect(chosen).toContain('.avif');
  });

  test('honours sizes when choosing between w descriptors', async ({ page }) => {
    await page.goto('/demo/');

    // 100px against a 480w/800w pair: even at DPR 3 that needs 300px, so the
    // 480 wins in every engine. Left at the default `sizes` of 100vw it would
    // need the full viewport width and take the 800, which is what makes this
    // an assertion about `sizes` rather than about srcset parsing.
    const chosen = await choose(page, {
      srcset: `${POSTER}.jpg?v=480 480w, ${POSTER}.jpg?v=800 800w`,
      sizes: '100px',
    });

    expect(chosen).toContain('v=480');
  });

  test('fetches exactly the variant it selected, and nothing else, detached', async ({ page }) => {
    await page.goto('/demo/');

    const requested: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('sample-poster')) requested.push(request.url());
    });

    const chosen = await choose(page, {
      sources: [{ type: 'image/avif', srcset: `${POSTER}.avif?only=this` }],
      src: `${POSTER}.jpg?never=this`,
    });

    expect(chosen).toContain('only=this');
    expect(requested).toHaveLength(1);
    expect(requested[0]).toContain('only=this');
  });
});

/**
 * The shipped module against a real page, rather than the premise it rests on.
 * Driven through /dist, so these exercise the built artifact the way every other
 * spec in this suite does.
 */
test.describe('warmOnIntent', () => {
  /** Requests for the fixture image, in order, ignoring everything else. */
  function trackPosters(page: Page): string[] {
    const seen: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('sample-poster')) seen.push(request.url());
    });
    return seen;
  }

  test('warms nothing until the visitor shows intent', async ({ page }) => {
    const requested = trackPosters(page);
    await page.goto('/demo/warm.html');
    // Waiting for the module is what stops this passing vacuously: with nothing
    // loaded, no requests is trivially true.
    await page.waitForFunction(() => typeof window.__warmedUrls === 'function');

    // The page carries the candidates in its markup from the first byte. Warming
    // on load rather than on intent would spend the bytes on every visitor,
    // including the ones who never leave this page.
    expect(requested).toHaveLength(0);
    // Asserted twice through independent observers, since a missed request event
    // and an empty resource timeline are different mistakes.
    expect(await page.evaluate(() => window.__warmedUrls())).toHaveLength(0);
  });

  test('warms the AVIF variant this viewport would request, on hover', async ({ page }) => {
    const requested = trackPosters(page);
    await page.goto('/demo/warm.html');
    await page.setViewportSize({ width: 1200, height: 800 });

    await page.hover('[data-warm-avif]');
    await expect.poll(() => requested.length).toBe(1);

    // 1200px is past the 50rem branch of the demo's sizes, so the destination
    // would ask for the 800. Warming anything else would be a wasted fetch *and*
    // a second one on arrival, which is worse than not warming at all.
    expect(requested[0]).toContain('.avif');
    expect(requested[0]).toContain('v=800');
  });

  test('warms exactly what the destination would have chosen, on a narrow viewport', async ({
    page,
  }) => {
    // The contract, stated as an equality rather than as a hardcoded variant.
    //
    // Naming the expected file here was wrong and failed in WebKit: Desktop
    // Safari runs at DPR 2, so a 420px viewport genuinely needs the 800w while
    // the DPR-1 engines take the 480w. Both are *correct*, and pinning either
    // one asserts a device rather than the behaviour. Computing `420 * dpr` in
    // the test would be worse still, since re-implementing the selection rule is
    // the exact thing this feature exists to avoid.
    await page.setViewportSize({ width: 420, height: 800 });

    const requested = trackPosters(page);
    await page.goto('/demo/warm.html');
    await page.hover('[data-warm-avif]');
    await expect.poll(() => requested.length).toBe(1);

    await page.goto('/demo/warm-destination.html');
    const chosen = await page
      .locator('.hero img')
      .evaluate((img: HTMLImageElement) => img.currentSrc);

    expect(requested[0]).toBe(chosen);
  });

  /*
   * Dedup is asserted in test/warm.test.ts, not here, and deliberately so.
   *
   * The obvious e2e version -- hover twice, expect one request -- was written
   * first and is a no-op: with dedup deleted from the source it still passed,
   * because the second image resolves to the same URL and the browser serves it
   * from cache without touching the network. It defended the HTTP cache rather
   * than any code in this package. The unit test counts the images built, which
   * does go red when the guard is removed.
   */

  test('leaves links the resolver does not claim alone', async ({ page }) => {
    const requested = trackPosters(page);
    await page.goto('/demo/warm.html');

    await page.hover('[data-warm-plain]');
    await page.waitForTimeout(150);

    expect(requested).toHaveLength(0);
  });

  test('the warmed bytes are reused on arrival', async ({ page }) => {
    await page.goto('/demo/warm.html');
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.hover('[data-warm-avif]');
    await page.waitForTimeout(200);

    // The payoff, asserted rather than assumed: after navigating, the hero the
    // destination renders is the URL that was warmed, so the browser has it.
    await page.click('[data-warm-avif]');
    const hero = page.locator('.hero img');
    await expect(hero).toHaveJSProperty('complete', true);
    expect(await hero.evaluate((img: HTMLImageElement) => img.currentSrc)).toContain('v=800');
  });
});
