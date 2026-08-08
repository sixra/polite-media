import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Standalone. The rule block is lifted from @sixra/devkit/eslint, which is being
 * retired, minus everything site-shaped: no Astro, no service worker, no
 * Cloudflare functions. None of those files exist in a browser library.
 *
 * Requires TypeScript 5.x. typescript-eslint peers on `>=4.8.4 <6.1.0`, and
 * TypeScript 7 moved the compiler API behind `./unstable/*` -- its main export is
 * two strings -- so the parser has nothing to work with there.
 */
export default defineConfig([
  globalIgnores([
    'dist/**',
    'node_modules/**',
    'demo/assets/**',
    'playwright-report/**',
    'test-results/**',
  ]),

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'warn',
        { allowExpressions: true, allowTypedFunctionExpressions: true },
      ],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],
    },
  },

  // The package is a browser library. Inert while every source file is .ts, since
  // typescript-eslint's recommended config turns `no-undef` off there and lets
  // TypeScript do that job. Kept because it becomes live the moment a plain .js
  // ships from src/, and costs nothing meanwhile.
  {
    files: ['src/**/*.{ts,js}'],
    languageOptions: { globals: globals.browser },
  },

  // Unit tests run in happy-dom, so both sets apply.
  {
    files: ['test/**/*.ts'],
    languageOptions: { globals: { ...globals.browser, ...globals.vitest } },
  },

  // Specs run in Node, but page.evaluate() bodies are browser code in the same file.
  {
    files: ['e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },

  {
    files: ['scripts/**/*.js', '*.config.{js,mjs,ts}'],
    languageOptions: { globals: globals.node },
  },

  // Ambient declaration files use import() type annotations by design: global
  // augmentation blocks cannot use top-level type imports.
  {
    files: ['**/*.d.ts'],
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },

  // Plain JavaScript cannot carry TS annotations.
  {
    files: ['**/*.{js,mjs}'],
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
]);
