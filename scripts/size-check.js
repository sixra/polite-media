// Fails the build when a published entry point grows past its budget.
//
// Measures the bundled, minified entry rather than the files in dist/. dist/ is
// one unminified module per source file and nobody ships that; the number a
// consumer actually pays is the whole entry point after their bundler has been
// over it.
//
// gzip comes from node:zlib rather than the gzip(1) binary, because the CLI
// writes the source filename into the gzip header. `gzip -c video.js` and
// `gzip -c v.js` disagree by several bytes, so a budget measured that way would
// depend on what the file was called.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

/**
 * Bytes, gzipped. Raise one only in the commit that earned it, so the diff shows
 * what the bytes bought. Every size quoted in README.md must match this table.
 */
const budgets = {
  // Raised for: the unstyled-markup warning (~145 B), registerAll and shared
  // target resolution (~59 B), the missing-pause-control warning (~132 B), the
  // playAbove band with its unreachable-threshold warning (~230 B), and
  // startWhen (~144 B), which keeps the video fetch out of page load and can
  // hold playback until the buffer is ready. The first four bought reports on
  // things that were otherwise silent; this one is the first that is behaviour.
  // Raised again for five correctness fixes (~105 B), most of it the warning
  // refusing a second video on an already-observed target; the re-entrancy guard
  // in reconcile and clearing `started` on a scroll-away are a line each.
  // Then +253 B for the feed: a second IntersectionObserver so rootMargin can
  // buffer ahead without dilating the root that every threshold is measured
  // against, atOnce replacing the mobile-only switch, pausing an outgoing video
  // at once when another takes its slot, and holding the prefetch behind page
  // load so a margin cannot defeat startWhen.
  // Then +75 B for the startWhen work: an 'interaction' rung that is now the
  // default, a per-video override so a hero can hold out while a grid does not,
  // and requireBuffered split off as its own axis.
  // And +97 B to warn when every <source> carries a media attribute, which
  // leaves viewports with nothing to play. The markup contract already said the
  // last one must be unconditional; this is the rule checked rather than trusted.
  'src/video.ts': 4000,
  // image.ts 500 to 680 and image.css 170 to 220: a marked image that no
  // revealImages() call reaches used to stay invisible forever, and so did every
  // marked image on a page whose bundle failed. The stylesheet now reveals on a
  // delay (~32 B) and the module names the stray element on the console
  // (~157 B). The CSS half is the fix; the JS half is what makes it findable.
  'src/image.ts': 680,
  'src/video.css': 230,
  'src/image.css': 220,
  // The optional stacking stylesheet. Its own entry rather than part of
  // video.css: folding it in would make the "imposes no geometry" promise false
  // for everyone instead of optional for anyone.
  'src/layer.css': 160,
};

/**
 * Headroom past which a budget has stopped being a budget. A limit nothing ever
 * approaches does not constrain anything, and silently ratchets: shipping 40% of
 * your allowance means the number was picked, not earned.
 */
const looseRatio = 0.2;

async function measure(entry) {
  const result = await build({
    entryPoints: [entry],
    bundle: !entry.endsWith('.css'),
    format: entry.endsWith('.css') ? undefined : 'esm',
    target: 'es2022',
    minify: true,
    write: false,
  });
  const output = result.outputFiles[0];
  if (!output) throw new Error(`esbuild produced no output for ${entry}`);
  return gzipSync(output.contents, { level: 9 }).length;
}

let failed = false;
const measured = {};

/* eslint-disable no-console -- the report is this script's output, not debug logging */
for (const [entry, budget] of Object.entries(budgets)) {
  const size = await measure(entry);
  measured[entry] = size;
  const over = size > budget;
  const loose = !over && budget - size > budget * looseRatio;
  if (over) failed = true;

  const status = over ? 'OVER ' : loose ? 'LOOSE' : 'ok   ';
  const headroom = budget - size;
  console.log(
    `${status} ${entry.padEnd(15)} ${String(size).padStart(5)} B gz   budget ${String(budget).padStart(5)}   headroom ${headroom > 0 ? '+' : ''}${headroom}`
  );
}

/*
 * The README quotes these bytes, and "keep them in sync" as a comment is how the
 * old figures drifted 14% unnoticed in the first place. Checked rather than
 * asked for: every measured size must appear verbatim in the table.
 */
const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
for (const [entry, size] of Object.entries(measured)) {
  const printed = size.toLocaleString('en-US');
  // Anchored on the left: a plain substring test would let "2,478 B" satisfy the
  // check for "478 B", so a stale figure could pass on a collision with another
  // row -- the exact drift this is here to catch.
  if (!new RegExp(`(?<![\\d,])${printed} B`).test(readme)) {
    failed = true;
    console.error(`README does not quote ${printed} B for ${entry}`);
  }
}

if (failed) {
  console.error(
    '\nSize budget exceeded, or the README is out of date. Either shrink it, or\n' +
      'raise the budget and update the README table in the same commit, saying in\n' +
      'the message what the extra bytes bought.'
  );
  process.exit(1);
}
