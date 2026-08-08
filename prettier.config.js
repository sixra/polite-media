/**
 * Lifted verbatim from @sixra/devkit/prettier. Its two `overrides` entries target
 * *.astro and *.svelte, neither of which exists here, so they are dropped rather
 * than carried as decoration.
 */
export default {
  singleQuote: true,
  semi: true,
  printWidth: 100,
  tabWidth: 2,
  trailingComma: 'es5',
};
