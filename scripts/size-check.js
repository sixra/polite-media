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
import { gzipSync } from 'node:zlib';

/**
 * Bytes, gzipped. Raise one only in the commit that earned it, so the diff shows
 * what the bytes bought.
 */
const budgets = {
  // The coordinator: two observers, source selection, the gates, the pause control, and the
  // once-per-page reports. Those reports are a sixth of it, and they ship to every visitor.
  'src/video.ts': 4300,
  // Reveal on decode, the mark that stands the stylesheet's failsafe down, and the two reports
  // that make a missing stylesheet or an unmanaged image findable.
  'src/image.ts': 980,
  // The detached <picture> that lets the browser pick the variant, the save-data gate, dedup and
  // the delegated intent binding. Almost all element plumbing, because the selection it replaces
  // is the browser's own.
  'src/warm.ts': 700,
  'src/video.css': 230,
  'src/image.css': 260,
  // Its own entry rather than part of video.css: folding it in would make the "imposes no
  // geometry" promise false for everyone instead of optional for anyone.
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

/* eslint-disable no-console -- the report is this script's output, not debug logging */
for (const [entry, budget] of Object.entries(budgets)) {
  const size = await measure(entry);
  const over = size > budget;
  const loose = !over && budget - size > budget * looseRatio;
  if (over || loose) failed = true;

  const status = over ? 'OVER ' : loose ? 'LOOSE' : 'ok   ';
  const headroom = budget - size;
  console.log(
    `${status} ${entry.padEnd(15)} ${String(size).padStart(5)} B gz   budget ${String(budget).padStart(5)}   headroom ${headroom > 0 ? '+' : ''}${headroom}`
  );
}

if (failed) {
  console.error(
    '\nA budget was exceeded, or has grown so loose it constrains nothing. Move it\n' +
      'in the commit that earned the move, saying in the message what changed.'
  );
  process.exit(1);
}
