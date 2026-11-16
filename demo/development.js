// The demos load dist/ unbundled, so nothing defines `process`. This makes them development builds,
// so the e2e suite sees the warnings. A classic script runs before the pages' module scripts.
globalThis.process ??= { env: { NODE_ENV: 'development' } };
