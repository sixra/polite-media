import { build } from 'esbuild';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as imageEntry from '../src/image.js';
import type * as videoEntry from '../src/video.js';
import type * as warmEntry from '../src/warm.js';

/**
 * The entry points as a consumer's bundler hands them to the browser. With no config, esbuild
 * defines `process.env.NODE_ENV` as "production" when every minify option is on and as
 * "development" otherwise (https://esbuild.github.io/api/#platform), so `minify` picks the build.
 */
async function bundle(entry: string, minify: boolean): Promise<string> {
  const result = await build({
    entryPoints: [`src/${entry}.ts`],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    minify,
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return output.text;
}

/** Imported from a data URL, so each bundle is a module of its own with its own once-per-page state. */
async function load<Entry>(entry: string, minify: boolean): Promise<Entry> {
  const code = await bundle(entry, minify);
  return (await import(
    /* @vite-ignore */ `data:text/javascript,${encodeURIComponent(code)}`
  )) as Entry;
}

/** A registered video with `aria-hidden` but no `tabindex="-1"`, so it sits in the tab order. */
function videoInTabOrder(): HTMLVideoElement {
  const box = document.createElement('div');
  box.setAttribute('data-polite-media', '');
  const video = document.createElement('video');
  video.setAttribute('preload', 'none');
  video.setAttribute('aria-hidden', 'true');
  box.append(document.createElement('img'), video);
  document.body.append(box);
  return video;
}

/** One mistake per entry point that warns at once, so a test needs no timers. */
const mistakes: [string, (minify: boolean) => Promise<void>][] = [
  [
    'a video in the tab order',
    async (minify) => {
      const { register, unregisterAll } = await load<typeof videoEntry>('video', minify);
      register(videoInTabOrder());
      unregisterAll();
    },
  ],
  [
    'the ignored allowEager option',
    async (minify) => {
      const { revealImages } = await load<typeof imageEntry>('image', minify);
      revealImages('img', { allowEager: true })();
    },
  ],
  [
    'a warm() call with nothing to warm',
    async (minify) => {
      const { warm } = await load<typeof warmEntry>('warm', minify);
      warm({});
    },
  ],
];

/**
 * The text before each "polite-media: " message that is not a thrown error. configure() throws
 * errors with the same prefix, and a production build keeps those.
 */
function warningTexts(code: string): string[] {
  return code
    .split('polite-media: ')
    .slice(0, -1)
    .filter((before) => !/Error\(\s*["'`]$/.test(before));
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe('the developer warnings', () => {
  it.each(['video', 'image', 'warm'])(
    'leave no warning text and no console.warn call in a minified bundle of %s',
    async (entry) => {
      const development = await bundle(entry, false);
      expect(warningTexts(development)).not.toEqual([]);
      expect(development).toContain('console.warn(');

      const production = await bundle(entry, true);
      expect(warningTexts(production)).toEqual([]);
      expect(production).not.toContain('console.warn');
    }
  );

  it.each(mistakes)('warn from an unminified bundle about %s', async (_mistake, make) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await make(false);

    expect(warn).toHaveBeenCalledOnce();
  });

  it.each(mistakes)('stay silent in a minified bundle about %s', async (_mistake, make) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await make(true);

    expect(warn).not.toHaveBeenCalled();
  });
});
