import { defineConfig } from '@playwright/test'

// Two front-end e2e surfaces, each with its own server:
//   components — Vite dev server serving the component playground (web/index.html)
//   app        — static server serving the built UI (html/ + html/dist/app.js)
// Network is mocked per-test where it matters.
export default defineConfig({
  testDir: './web/e2e',
  webServer: [
    {
      command: 'npx vite --port 5174 --strictPort',
      port: 5174,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'node web/e2e/serve-html.js 5175',
      port: 5175,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'components',
      testMatch: /dsn-status\.spec\.js/,
      use: { baseURL: 'http://localhost:5174' },
    },
    {
      name: 'app',
      testMatch: /app\.[^/]*\.spec\.js/,
      use: { baseURL: 'http://localhost:5175' },
    },
    {
      name: 'configurator',
      testMatch: /configure\.spec\.js/,
      use: { baseURL: 'http://localhost:5175' },
    },
  ],
})
