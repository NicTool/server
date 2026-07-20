import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const r = (p) => fileURLToPath(new URL(p, import.meta.url))

// The web/ dir is the front-end source. `vite build` bundles two ES modules
// into html/dist/, which the server serves statically:
//   nictool-web.js — Lit web components (loaded by configure.html)
//   app.js         — the main UI (loaded by index.html; RR bundled in)
// `vite` (dev server) serves web/index.html as a component playground and is
// what Playwright drives in the component e2e suite.
export default defineConfig({
  root: r('./web'),
  build: {
    outDir: r('./html/dist'),
    emptyOutDir: true,
    lib: {
      entry: {
        'nictool-web': r('./web/src/main.js'),
        app: r('./web/src/app.js'),
      },
      formats: ['es'],
      fileName: (format, entryName) => `${entryName}.js`,
    },
  },
})
