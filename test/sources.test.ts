import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetEnv } from '../src/env.js';
import { isUnusable, manageSources } from '../src/sources.js';

interface Built {
  video: HTMLVideoElement;
  load: ReturnType<typeof vi.fn>;
}

/**
 * `canPlayType` is stubbed per-test rather than left to happy-dom, because the
 * whole point of this module is that the answer is untrustworthy: the tests need
 * to say "the browser claims yes" independently of whether it is true.
 */
function build(
  sources: Array<{ src: string; type?: string; media?: string }>,
  canPlay: (type: string) => string = () => 'probably',
  attrs: { src?: string } = {}
): Built {
  const video = document.createElement('video');
  if (attrs.src) video.setAttribute('src', attrs.src);

  for (const spec of sources) {
    const source = document.createElement('source');
    source.setAttribute('src', spec.src);
    if (spec.type) source.setAttribute('type', spec.type);
    if (spec.media) source.setAttribute('media', spec.media);
    video.append(source);
  }

  const load = vi.fn();
  video.load = load as unknown as HTMLVideoElement['load'];
  video.canPlayType = ((type: string) => canPlay(type)) as HTMLVideoElement['canPlayType'];
  document.body.append(video);
  return { video, load };
}

beforeEach(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    matches: query === '(min-width: 768px)',
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
});

afterEach(() => {
  resetEnv();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('isUnusable', () => {
  it('is false for no error at all', () => {
    expect(isUnusable(null)).toBe(false);
  });

  // The trap: assigning `src` aborts the in-flight load and reports code 1.
  // Treating that as fatal would burn every candidate on the first assignment.
  it('is false for MEDIA_ERR_ABORTED, which our own src assignment causes', () => {
    expect(isUnusable({ code: 1 } as MediaError)).toBe(false);
  });

  it('is false for MEDIA_ERR_NETWORK -- another file will not fix the connection', () => {
    expect(isUnusable({ code: 2 } as MediaError)).toBe(false);
  });

  it.each([3, 4])('is true for code %i, where the file itself is unusable', (code) => {
    expect(isUnusable({ code } as MediaError)).toBe(true);
  });
});

describe('manageSources', () => {
  it('loads the first candidate in author order', () => {
    const { video, load } = build([{ src: '/a.mp4' }, { src: '/b.mp4' }]);
    expect(manageSources(video).select()).toBe(true);
    expect(video.src).toContain('/a.mp4');
    // Assigning src alone does not restart resource selection on an element
    // that already loaded.
    expect(load).toHaveBeenCalled();
  });

  it('drops candidates whose media query does not match the viewport', () => {
    const { video } = build([
      { src: '/mobile.mp4', media: '(max-width: 767px)' },
      { src: '/desktop.mp4', media: '(min-width: 768px)' },
    ]);
    manageSources(video).select();
    expect(video.src).toContain('/desktop.mp4');
  });

  it('drops candidates the browser flatly cannot play', () => {
    const { video } = build(
      [
        { src: '/exotic.mp4', type: 'video/exotic' },
        { src: '/safe.mp4', type: 'video/mp4' },
      ],
      (type) => (type === 'video/mp4' ? 'probably' : '')
    );
    manageSources(video).select();
    expect(video.src).toContain('/safe.mp4');
  });

  it('keeps "maybe" candidates, since maybe is what browsers usually say', () => {
    const { video } = build([{ src: '/a.mp4', type: 'video/mp4' }], () => 'maybe');
    expect(manageSources(video).select()).toBe(true);
    expect(video.src).toContain('/a.mp4');
  });

  it('advances to the next candidate and reports exhaustion', () => {
    const { video } = build([{ src: '/a.mp4' }, { src: '/b.mp4' }]);
    const manager = manageSources(video);

    manager.select();
    expect(manager.advance()).toBe(true);
    expect(video.src).toContain('/b.mp4');
    expect(manager.advance()).toBe(false);
  });

  it('ignores sources belonging to a nested media element', () => {
    const { video } = build([{ src: '/mine.mp4' }]);
    const nested = document.createElement('video');
    const stray = document.createElement('source');
    stray.setAttribute('src', '/not-mine.mp4');
    nested.append(stray);
    video.append(nested);

    manageSources(video).select();
    expect(video.src).toContain('/mine.mp4');
  });

  describe('a video authored with a plain src and no <source> children', () => {
    it('is left exactly as it was', () => {
      const { video, load } = build([], () => 'probably', { src: '/authored.mp4' });
      expect(manageSources(video).select()).toBe(true);
      expect(load).not.toHaveBeenCalled();
      expect(video.getAttribute('src')).toBe('/authored.mp4');
    });

    it('has nothing to fall back to', () => {
      const { video } = build([], () => 'probably', { src: '/authored.mp4' });
      expect(manageSources(video).advance()).toBe(false);
    });
  });

  it('reports failure when every candidate was filtered out', () => {
    const { video } = build([{ src: '/a.mp4', type: 'video/exotic' }], () => '');
    expect(manageSources(video).select()).toBe(false);
  });
});

describe('repeated select()', () => {
  it('keeps reporting failure when nothing was ever playable', () => {
    const { video } = build([{ src: '/a.mp4', type: 'video/exotic' }], () => '');
    const manager = manageSources(video);
    expect(manager.select()).toBe(false);
    // The first call advanced the index, so a bare `index >= 0 -> true` here
    // would claim success for a video that never loaded anything.
    expect(manager.select()).toBe(false);
  });

  it('is idempotent once a candidate is loaded', () => {
    const { video, load } = build([{ src: '/a.mp4' }]);
    const manager = manageSources(video);
    expect(manager.select()).toBe(true);
    expect(manager.select()).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores a source whose src attribute is present but empty', () => {
    const { video } = build([{ src: '' }, { src: '/real.mp4' }]);
    expect(manageSources(video).select()).toBe(true);
    expect(video.src).toContain('/real.mp4');
  });
});
