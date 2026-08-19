import { defineConfig, devices } from '@playwright/test';

// The e2e suite drives the real app through `node server.js`. It lives outside
// `tests/` because `tests/run-tests.cjs` auto-runs every *.test.js there under
// `node --test`, which cannot execute Playwright specs.
const PORT = Number(process.env.E2E_PORT) || 8123;

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
    },
  ],
  webServer: {
    command: `node server.js`,
    env: { PORT: String(PORT) },
    url: `http://127.0.0.1:${PORT}/index.html`,
    reuseExistingServer: !process.env.CI,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
