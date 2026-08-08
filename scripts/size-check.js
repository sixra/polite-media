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
 * what the bytes bought. Every size quoted in README.md must match this table.
 */
const budgets = {
  'src/video.ts': 2500,
  'src/image.ts': 500,
  'src/video.css': 230,
  'src/image.css': 170,
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

for (const [entry, budget] of Object.entries(budgets)) {
  const size = await measure(entry);
  const over = size > budget;
  const loose = !over && budget - size > budget * looseRatio;
  if (over) failed = true;

  const status = over ? 'OVER ' : loose ? 'LOOSE' : 'ok   ';
  const headroom = budget - size;
  console.log(
    `${status} ${entry.padEnd(15)} ${String(size).padStart(5)} B gz   budget ${String(budget).padStart(5)}   headroom ${headroom > 0 ? '+' : ''}${headroom}`
  );
}

if (failed) {
  console.error(
    '\nSize budget exceeded. Either shrink it, or raise the budget in this file\n' +
      'in the same commit and say in the message what the extra bytes bought.'
  );
  process.exit(1);
}
