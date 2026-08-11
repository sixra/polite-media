/**
 * @module
 * Everything for background video. Imported on its own so an image-only page
 * never pays for the IntersectionObserver, source selection or arbitration.
 *
 * The export list is deliberately small. Every name here is permanent once
 * published, and adding one later is not a breaking change while removing one
 * is -- so anything without a caller that can be named stays internal. The
 * environment gates and the reveal primitive are used by this package and are
 * not part of its interface.
 */
export {
  configure,
  pauseAll,
  register,
  registerAll,
  resumeAll,
  unregister,
  unregisterAll,
} from './coordinator.js';
export type { AtOnce, ConfigureOptions, RegisterOptions, VideoTarget } from './coordinator.js';

// Loaded for its `declare global` block as much as for the constants: the
// ElementEventMap and DocumentEventMap augmentation only reaches a consumer if
// this module is part of their program.
export {
  POLITE_VIDEO_PAUSECHANGE,
  POLITE_VIDEO_FAILED,
  POLITE_VIDEO_READY,
  type PolitePauseEventDetail,
  type PoliteVideoEventDetail,
} from './events.js';
