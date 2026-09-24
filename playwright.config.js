import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';
import { buildScratchPublicDir, SCRATCH_DATA_DIR, SCRATCH_DIR } from './tests-e2e/scratch-fixture.mjs';

// The e2e suite drives the real app through `node server.js`. It lives outside
// `tests/` because `tests/run-tests.cjs` auto-runs every *.test.js there under
// `node --test`, which cannot execute Playwright specs.
const PORT = Number(process.env.E2E_PORT) || 8123;
// A second server over a throwaway copy of the yard, for the specs that write.
// Built at config load so both servers have a document root before they start.
const SCRATCH_PORT = PORT + 1;
buildScratchPublicDir();

export default defineConfig({
  testDir: './tests-e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? 'line' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chrome',
      // Use the Chrome already installed on the machine so `npm install` does
      // not have to download a ~150MB bundled browser.
      use: { ...devices['Desktop Chrome'], channel: 'chrome' },
      testIgnore: /touch\.spec\.js/,
    },
    {
      // Phone-sized, touch-capable. Scoped to the touch spec alone: running the
      // whole suite twice would say nothing the desktop run has not already.
      name: 'mobile-chrome',
      use: { ...devices['Pixel 5'], channel: 'chrome' },
      testMatch: /touch\.spec\.js/,
    },
  ],
  webServer: [
    {
      command: `node server.js`,
      // DATA_DIR keeps app.db (opened at startup regardless of which specs
      // run against this server) inside a throwaway directory instead of the
      // real data/, even though this server's PUBLIC_DIR is the repo itself.
      env: { PORT: String(PORT), DATA_DIR: path.join(SCRATCH_DATA_DIR, 'main') },
      url: `http://127.0.0.1:${PORT}/index.html`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `node server.js`,
      // A second, independent throwaway app.db for the scratch server, so
      // the two servers never open the same SQLite file at once.
      env: {
        PORT: String(SCRATCH_PORT),
        PUBLIC_DIR: SCRATCH_DIR,
        DATA_DIR: path.join(SCRATCH_DATA_DIR, 'scratch'),
      },
      url: `http://127.0.0.1:${SCRATCH_PORT}/index.html`,
      reuseExistingServer: !process.env.CI,
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
});
