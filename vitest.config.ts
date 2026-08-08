import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // happy-dom gives us matchMedia, IntersectionObserver stubs and an element
    // tree. It does not implement media playback or requestVideoFrameCallback,
    // so anything touching a real frame is asserted in the Playwright suite.
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
  },
});
