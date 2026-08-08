// @vitest-environment node

import { describe, expect, it } from 'vitest';

/**
 * The regression test for the rule that no module in this package may touch a
 * browser global at module scope.
 *
 * This is not hypothetical. Dental's MediaContainer.astro hoists
 * `const isMobile = matchMedia('(max-width: 767px)')` to module scope, which is
 * correct inside an Astro component script and fatal in a published package:
 * any SSR render, prerender or Node test that imports it throws
 * "matchMedia is not defined" at import time, before a single function is called.
 * It would also make `"sideEffects": false` untrue.
 */
describe('importing in Node without a DOM', () => {
  it('does not throw', async () => {
    expect(typeof window).toBe('undefined');
    await expect(import('../src/video.js')).resolves.toBeDefined();
  });

  it('exposes its API without having evaluated any browser global', async () => {
    const mod = await import('../src/video.js');
    expect(typeof mod.register).toBe('function');
    expect(typeof mod.configure).toBe('function');
  });
});
