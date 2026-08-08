// Removes the build output before a rebuild.
//
// tsc only writes, it never removes, so anything renamed or deleted in src
// lingers in dist and would be published. That is not hypothetical: the
// polite-video -> polite-media rename left a stale index.js and
// polite-video.css behind.
//
// Scoped deliberately: it resolves dist relative to this file and refuses
// anything else, so it can only ever touch this package's own build output.
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(packageRoot, 'dist');

if (dirname(dist) !== packageRoot) {
  throw new Error(`refusing to clean outside the package: ${dist}`);
}

rmSync(dist, { recursive: true, force: true });
