/**
 * @module
 * Warming a destination page's image before the visitor gets there. Imported on
 * its own, so a page that only warms never pays for the video coordinator.
 *
 * A barrel for the same reason `video.ts` is one: this file is what the `./warm`
 * subpath resolves to, so every name it exports is public and permanent once
 * published. `resetWarmed` clears the dedup record for a test and has no caller
 * outside the suite, so it stays in `warming.ts` where tests reach it directly.
 */
export { warm, warmOnIntent } from './warming.js';
export type { WarmOptions, WarmSource } from './warming.js';
