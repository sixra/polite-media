import { afterEach, describe, expect, it, vi } from 'vitest';
import { revealImages } from '../src/image.js';

interface Built {
  container: HTMLElement;
  image: HTMLImageElement;
  settleDecode: () => void;
  rejectDecode: () => void;
}

/**
 * happy-dom has no decoder, so `decode()` is replaced with a promise the test
 * settles by hand. `complete` and `naturalWidth` are likewise faked: they are
 * the branch that decides whether a cached image reveals on the next frame or
 * waits, and a constant would make one of the two paths untestable.
 */
function build(
  opts: { loading?: 'lazy' | 'eager'; complete?: boolean; naturalWidth?: number } = {}
): Built {
  const container = document.createElement('div');
  container.setAttribute('data-polite-media', '');
  const image = document.createElement('img');
  image.setAttribute('loading', opts.loading ?? 'lazy');
  image.setAttribute('data-polite-reveal', '');
  container.append(image);
  document.body.append(container);

  Object.defineProperty(image, 'complete', { value: opts.complete ?? false, configurable: true });
  Object.defineProperty(image, 'naturalWidth', {
    value: opts.naturalWidth ?? (opts.complete ? 800 : 0),
    configurable: true,
  });

  let settle!: () => void;
  let reject!: () => void;
  const decoded = new Promise<void>((res, rej) => {
    settle = () => res();
    reject = () => rej(new DOMException('bad', 'EncodingError'));
  });
  image.decode = () => decoded;

  return { container, image, settleDecode: settle, rejectDecode: reject };
}

const ready = (image: HTMLImageElement): boolean => image.hasAttribute('data-polite-ready');

afterEach(() => {
  vi.unstubAllGlobals();
  // Both of these were missing, and both bit. Fake timers leak into later tests,
  // and `vi.spyOn` on an already-spied method hands back the *existing* mock
  // with its call history, so a second test asserting "never warned" was
  // inheriting the first test's warning. Each passed alone and failed together.
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('revealImages', () => {
  it('reveals once the image has decoded, not merely loaded', async () => {
    const { image, settleDecode } = build();
    revealImages('img');
    expect(ready(image)).toBe(false);

    // `load` fires before decode, so revealing on it can fade an undecoded
    // bitmap. Only decode() means the pixels are paintable.
    image.dispatchEvent(new Event('load'));
    expect(ready(image)).toBe(false);

    settleDecode();
    await vi.waitFor(() => expect(ready(image)).toBe(true));
  });

  it('reveals an already-decoded image on the next frame', async () => {
    const { image } = build({ complete: true, naturalWidth: 800 });
    revealImages('img');
    // Not synchronous: the browser needs one frame at the hidden state or the
    // transition snaps instead of running.
    expect(ready(image)).toBe(false);
    await vi.waitFor(() => expect(ready(image)).toBe(true));
  });

  // The rejection is handled in a `.catch()`, so its fallback listeners are not
  // attached until the microtask queue drains. Dispatching before that races the
  // handler and the event is simply missed -- which is what these two tests did
  // on their first run.
  const afterRejectionHandled = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, 0));

  it('still reveals when decode() rejects, rather than leaving it hidden', async () => {
    const { image, rejectDecode } = build();
    revealImages('img');

    // decode() rejects with EncodingError when a responsive srcset swaps src
    // mid-flight. No reveal at all would be worse than an early one.
    rejectDecode();
    await afterRejectionHandled();
    expect(ready(image)).toBe(false);

    image.dispatchEvent(new Event('load'));
    expect(ready(image)).toBe(true);
  });

  // The srcset case: `src` swaps mid-flight, decode() rejects on the old bitmap,
  // and the new one is already decoded by the time the rejection lands. Waiting
  // for a `load` that has been and gone would leave the image hidden for good.
  it('reveals at once when decode() rejects on an already-complete image', async () => {
    const { image, rejectDecode } = build({ complete: true, naturalWidth: 0 });
    revealImages('img');

    rejectDecode();
    await afterRejectionHandled();

    expect(ready(image)).toBe(true);
  });

  // A client-side router tears the page down between the rejection and its
  // handler, and reviving a detached image would fire ready for a node nobody
  // is watching.
  it('reveals nothing after the returned teardown ran', async () => {
    // naturalWidth 0 so it takes decode() rather than the cached fast path: this
    // is about the abort guard inside the rejection handler.
    const { image, rejectDecode } = build({ complete: true, naturalWidth: 0 });
    const stop = revealImages('img');

    stop();
    rejectDecode();
    await afterRejectionHandled();

    expect(ready(image)).toBe(false);
  });

  it('reveals even when the image fails to load entirely', async () => {
    const { image, rejectDecode } = build();
    revealImages('img');

    rejectDecode();
    await afterRejectionHandled();

    // A broken image should show its broken state, not an invisible box.
    image.dispatchEvent(new Event('error'));
    expect(ready(image)).toBe(true);
  });

  it('emits a bubbling ready event', async () => {
    const { container, image, settleDecode } = build();
    const seen: string[] = [];
    container.addEventListener('polite-image:ready', () => seen.push('ready'));

    revealImages('img');
    settleDecode();
    await vi.waitFor(() => expect(seen).toEqual(['ready']));
    expect(ready(image)).toBe(true);
  });

  it('accepts elements as well as a selector', async () => {
    const { image, settleDecode } = build();
    revealImages([image]);
    settleDecode();
    await vi.waitFor(() => expect(ready(image)).toBe(true));
  });
});

describe('the eager guard', () => {
  // LCP excludes elements at opacity 0, and revealing one does not restore its
  // candidacy. A lazy image was never a candidate; an eager one may well be.
  it('reveals eager images immediately rather than fading them', async () => {
    const { image } = build({ loading: 'eager' });
    revealImages('img');
    // Immediately, without waiting on decode: the point is that the LCP
    // candidate is visible from its first paint.
    expect(ready(image)).toBe(true);
  });

  it('never leaves an eager image hidden', async () => {
    // The bug this replaced: skipping an image that image.css had already
    // hidden left it invisible permanently instead of merely unfaded.
    const { image } = build({ loading: 'eager' });
    revealImages('img');
    await new Promise((r) => setTimeout(r, 20));
    expect(ready(image)).toBe(true);
  });

  it('manages them when explicitly allowed', async () => {
    const { image, settleDecode } = build({ loading: 'eager' });
    revealImages('img', { allowEager: true });
    settleDecode();
    await vi.waitFor(() => expect(ready(image)).toBe(true));
  });
});

describe('teardown', () => {
  it('cancels a pending reveal so it cannot fire at a detached node', async () => {
    const { image, settleDecode } = build();
    const stop = revealImages('img');

    stop();
    settleDecode();
    await new Promise((r) => setTimeout(r, 20));
    expect(ready(image)).toBe(false);
  });

  it('cancels a pending next-frame reveal too', async () => {
    const { image } = build({ complete: true, naturalWidth: 800 });
    const stop = revealImages('img');
    stop();
    await new Promise((r) => setTimeout(r, 20));
    expect(ready(image)).toBe(false);
  });
});

describe('the loading attribute, across engine disagreement', () => {
  // Engines report an absent or invalid `loading` differently: MDN documents
  // only 'eager' and 'lazy', happy-dom returns 'auto'. Comparing against 'lazy'
  // is the only test that answers the same way everywhere.
  it.each([
    ['absent', null],
    ['invalid', 'banana'],
    ['eager', 'eager'],
  ])('treats %s as not-lazy and reveals immediately', (_label, value) => {
    const { image } = build();
    if (value === null) image.removeAttribute('loading');
    else image.setAttribute('loading', value);

    revealImages([image]);
    expect(ready(image)).toBe(true);
  });

  it('still defers a lazy image to its decode', () => {
    const { image } = build({ loading: 'lazy' });
    revealImages([image]);
    expect(ready(image)).toBe(false);
  });
});

describe('the unmanaged-image warning', () => {
  function stray(): HTMLImageElement {
    const container = document.createElement('div');
    const image = document.createElement('img');
    image.setAttribute('data-polite-reveal', '');
    image.setAttribute('loading', 'lazy');
    container.append(image);
    document.body.append(container);
    return image;
  }

  it('names an image that carries the attribute but no call manages', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const orphan = stray();
    build();

    revealImages('img[loading="lazy"]:not([data-polite-reveal])');
    vi.advanceTimersByTime(1000);

    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[1]).toBe(orphan);
  });

  it('stays quiet when every marked image is managed', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stray();

    revealImages('img[data-polite-reveal]');
    vi.advanceTimersByTime(1000);

    expect(warn).not.toHaveBeenCalled();
  });

  it('warns once however many calls a page makes', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stray();

    revealImages('img#none-a');
    revealImages('img#none-b');
    revealImages('img#none-c');
    vi.advanceTimersByTime(1000);

    // Without the debounce each call schedules its own check and the same stray
    // image is reported three times.
    expect(warn).toHaveBeenCalledOnce();
  });

  // Several calls with different selectors is a normal way to set a page up, so
  // an image is only stray once all of them have had their chance.
  it('does not fire for an image a later call picks up', () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const image = stray();
    image.id = 'second';

    revealImages('img#nothing');
    revealImages('img#second');
    vi.advanceTimersByTime(1000);

    expect(warn).not.toHaveBeenCalled();
  });
});
