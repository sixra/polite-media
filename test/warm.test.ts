import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv } from '../src/env.js';
import { resetWarmed, warm, warmOnIntent } from '../src/warming.js';

/**
 * happy-dom implements no image loading, so what the browser *selects* is
 * asserted in e2e/warm.spec.ts against all three engines. What is testable here
 * is everything that happens before the browser is involved: the save-data gate,
 * dedup, refusing empty input, and the intent binding.
 *
 * Counting created <img> elements rather than network requests, for that reason.
 * It is the observable that survives in this environment, and it fails for the
 * right reason: an image that was never built was never warmed.
 */
function imagesCreated(): number {
  return created.filter((tag) => tag === 'img').length;
}

let created: string[] = [];

function stubConnection(value: unknown): void {
  Object.defineProperty(navigator, 'connection', { value, configurable: true, writable: true });
}

beforeEach(() => {
  created = [];
  const real = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, ...rest: unknown[]) => {
    created.push(tag);
    return real(tag, ...(rest as []));
  });
});

afterEach(() => {
  // restoreAllMocks, not clearAllMocks: spying on an already-spied method returns
  // the existing mock complete with its call history, which has produced false
  // passes in this suite twice.
  vi.restoreAllMocks();
  resetWarmed();
  resetEnv();
  stubConnection(undefined);
});

describe('warm', () => {
  it('builds an image for the candidates it is given', () => {
    warm({ sources: [{ type: 'image/avif', srcset: 'hero.avif 800w' }], src: 'hero.jpg' });
    expect(imagesCreated()).toBe(1);
    expect(created).toContain('source');
  });

  it('warms a bare src, which is the no-variants case', () => {
    warm({ src: 'hero.jpg' });
    expect(imagesCreated()).toBe(1);
  });

  it('skips entirely when Save-Data is on', () => {
    stubConnection({ effectiveType: '4g', saveData: true });
    warm({ src: 'hero.jpg' });
    // Asserting no image exists, rather than that a predicate returned false:
    // the bytes are the thing being saved.
    expect(imagesCreated()).toBe(0);
  });

  it('warms the same candidates only once', () => {
    warm({ srcset: 'hero.avif 800w', sizes: '100vw' });
    warm({ srcset: 'hero.avif 800w', sizes: '100vw' });
    expect(imagesCreated()).toBe(1);
  });

  it('treats a different sizes as a different warm', () => {
    // sizes changes which variant the browser picks, so two calls that differ
    // only there are two distinct images, not a repeat.
    warm({ srcset: 'hero.avif 480w, hero-800.avif 800w', sizes: '100vw' });
    warm({ srcset: 'hero.avif 480w, hero-800.avif 800w', sizes: '400px' });
    expect(imagesCreated()).toBe(2);
  });

  it('warns and warms nothing when given no candidates', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warm({});
    expect(warned).toHaveBeenCalledOnce();
    expect(imagesCreated()).toBe(0);
  });

  it('does not let an empty call poison a later real one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    warm({});
    warm({ src: 'hero.jpg' });
    expect(imagesCreated()).toBe(1);
  });
});

describe('warmOnIntent', () => {
  function link(): HTMLAnchorElement {
    const anchor = document.createElement('a');
    anchor.className = 'card';
    document.body.append(anchor);
    return anchor;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('warms what the resolver names, on intent', () => {
    const anchor = link();
    const stop = warmOnIntent('.card', () => ({ src: 'hero.jpg' }));

    anchor.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(imagesCreated()).toBe(1);
    stop();
  });

  it('ignores intent toward anything else', () => {
    const other = document.createElement('div');
    document.body.append(other);
    const stop = warmOnIntent('.card', () => ({ src: 'hero.jpg' }));

    other.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(imagesCreated()).toBe(0);
    stop();
  });

  it('warms nothing when the resolver declines', () => {
    const anchor = link();
    const stop = warmOnIntent('.card', () => null);

    anchor.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(imagesCreated()).toBe(0);
    stop();
  });

  it.each(['pointerover', 'focusin', 'touchstart'])('treats %s as intent', (type) => {
    const anchor = link();
    const stop = warmOnIntent('.card', () => ({ src: 'hero.jpg' }));

    anchor.dispatchEvent(new Event(type, { bubbles: true }));

    expect(imagesCreated()).toBe(1);
    stop();
  });

  it('stops listening after teardown', () => {
    // The reason teardown exists: listeners delegated on `document` survive a
    // ClientRouter swap, so re-binding per navigation stacks duplicates.
    const anchor = link();
    const stop = warmOnIntent('.card', () => ({ src: 'hero.jpg' }));
    stop();

    anchor.dispatchEvent(new Event('pointerover', { bubbles: true }));

    expect(imagesCreated()).toBe(0);
  });
});
