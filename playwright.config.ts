import { defineConfig, devices } from '@playwright/test';

/**
 * The suite drives real media, so it needs a real browser. requestVideoFrameCallback
 * was confirmed to fire in headless Chromium with no compositor flags
 * (docs/findings.md), which is what lets these tests assert on genuinely
 * presented frames rather than on `playing`.
 *
 * Serving the repo root rather than demo/ so the pages can import the built
 * package from /dist -- the tests exercise the shipped artifact, not the source.
 *
 * All three engines, not just Chromium. Firefox and WebKit both lack
 * `navigator.connection`, so they are the only engines that exercise the
 * Save-Data gate's fail-open polarity -- the exact case a Chromium-only suite
 * would pass while broken.
 */
export default defineConfig({
  testDir: './e2e',
  // Serial: every spec drives real video decoding, and running a dozen media
  // pipelines at once is precisely the contention this library exists to avoid.
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:8788',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
  webServer: {
    command: 'python3 -m http.server 8788',
    url: 'http://localhost:8788/demo/',
    // Not unconditional: a stale server left running from another checkout will
    // be silently reused, and the suite then tests a tree that is not this one.
    // That has already happened once during review.
    reuseExistingServer: !process.env['CI'],
    // python3 -m http.server logs requests to stderr, not stdout, so silencing
    // only stdout leaves every request in the output.
    stdout: 'ignore',
    stderr: 'ignore',
  },
});
