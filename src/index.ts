// The public surface. Internals that tests reach for -- `mediaQuery`, `resetEnv`,
// `reconcile`, `inspect` -- are deliberately absent: tests import the modules
// directly, and anything exported here is permanent.
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
