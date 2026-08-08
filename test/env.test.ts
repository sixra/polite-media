import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectionAllowsMedia, mediaQuery, motionAllowed, resetEnv } from '../src/env.js';

function stubConnection(value: unknown): void {
  Object.defineProperty(navigator, 'connection', {
    value,
    configurable: true,
    writable: true,
  });
}

function stubMatchMedia(matches: (query: string) => boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: matches(query),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

afterEach(() => {
  resetEnv();
  vi.unstubAllGlobals();
  stubConnection(undefined);
});

describe('connectionAllowsMedia', () => {
  // The polarity is the whole point of this test. Reading a missing API as
  // "block" would silently kill video in Safari, Firefox and Brave -- browsers
  // that never expose it -- and would pass every test written on Chrome.
  it('allows when the API is absent', () => {
    stubConnection(undefined);
    expect(connectionAllowsMedia()).toBe(true);
  });

  it('allows on a fast connection', () => {
    stubConnection({ effectiveType: '4g', saveData: false });
    expect(connectionAllowsMedia()).toBe(true);
  });

  it('blocks when Save-Data is on, even at 4g', () => {
    stubConnection({ effectiveType: '4g', saveData: true });
    expect(connectionAllowsMedia()).toBe(false);
  });

  it.each(['2g', 'slow-2g'])('blocks on %s', (effectiveType) => {
    stubConnection({ effectiveType, saveData: false });
    expect(connectionAllowsMedia()).toBe(false);
  });

  it('allows on 3g -- only 2g and slower are blocked', () => {
    stubConnection({ effectiveType: '3g', saveData: false });
    expect(connectionAllowsMedia()).toBe(true);
  });
});

describe('motionAllowed', () => {
  it('is false when reduced motion is requested', () => {
    stubMatchMedia((q) => q.includes('prefers-reduced-motion'));
    expect(motionAllowed()).toBe(false);
  });

  it('is true otherwise', () => {
    stubMatchMedia(() => false);
    expect(motionAllowed()).toBe(true);
  });
});

describe('mediaQuery', () => {
  it('memoises, so listeners attach to the object the predicates read', () => {
    stubMatchMedia(() => false);
    expect(mediaQuery('(min-width: 100px)')).toBe(mediaQuery('(min-width: 100px)'));
  });

  it('keeps distinct queries distinct', () => {
    stubMatchMedia(() => false);
    expect(mediaQuery('(min-width: 100px)')).not.toBe(mediaQuery('(min-width: 200px)'));
  });
});
