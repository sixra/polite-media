// @vitest-environment node

import { describe, expect, it } from 'vitest';

/**
 * The regression test for the rule that no module in this package may touch a
 * browser global at module scope.
 *
 * This is not hypothetical. A consumer component this package replaced hoisted
 * `const isMobile = matchMedia('(max-width: 767px)')` to module scope, which is
 * correct inside an Astro component script and fatal in a published package:
 * any SSR render, prerender or Node test that imports it throws
 * "matchMedia is not defined" at import time, before a single function is called.
 * It would also contradict the `sideEffects` declaration.
 */
describe('importing in Node without a DOM', () => {
  it.each([
    ['video', () => import('../src/video.js')],
    ['image', () => import('../src/image.js')],
    ['warm', () => import('../src/warm.js')],
  ])('does not throw for %s', async (_entry, load) => {
    expect(typeof window).toBe('undefined');
    await expect(load()).resolves.toBeDefined();
  });

  it('exposes its API without having evaluated any browser global', async () => {
    const mod = await import('../src/video.js');
    expect(typeof mod.register).toBe('function');
    expect(typeof mod.configure).toBe('function');
  });
});

/**
 * Every name an entry point exports is permanent once published, and RELEASING.md
 * counts removing one as breaking. Pinning the lists here makes an accidental
 * export fail a test rather than reach a release: `warm.ts` shipped `resetWarmed`,
 * a test hook, purely because that file had no barrel to hide it behind.
 */
describe('public export surface', () => {
  it.each([
    [
      () => import('../src/video.js'),
      [
        'POLITE_VIDEO_FAILED',
        'POLITE_VIDEO_PAUSECHANGE',
        'POLITE_VIDEO_READY',
        'configure',
        'pauseAll',
        'register',
        'registerAll',
        'resumeAll',
        'unregister',
        'unregisterAll',
      ],
    ],
    [() => import('../src/image.js'), ['POLITE_IMAGE_READY', 'revealImages']],
    [() => import('../src/warm.js'), ['warm', 'warmOnIntent']],
  ])('exports exactly its documented names', async (load, expected) => {
    expect(Object.keys(await load()).sort()).toEqual(expected);
  });
});
