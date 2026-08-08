// Everything for background video. Imported on its own so an image-only page
// never pays for the IntersectionObserver, source selection or arbitration.
export { connectionAllowsMedia, motionAllowed } from './env.js';
export { revealWhenPainted } from './reveal.js';
export {
  configure,
  pauseAll,
  register,
  resumeAll,
  unregister,
  unregisterAll,
} from './coordinator.js';
export type { Config, RegisterOptions } from './coordinator.js';
