import { copyFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig } from 'vite';

const root = process.cwd();

// Standalone HTML pages served alongside the SPA shell. Listing them as
// build inputs puts them in dist so the netlify.toml SPA fallback (which is
// not forced) never shadows them.
const pages = {
  index: 'index.html',
  door: 'door.html',
  maintenance: 'maintenance.html',
  'request-seat': 'request-seat.html',
  'request-seat-index': 'request-seat/index.html',
  'seat-selection': 'seat-selection.html',
  studio: 'Studio/index.html',
  onboardingpassport: 'onboardingpassport/index.html',
};

// Root-level static files that are not referenced from any HTML input and
// therefore would not otherwise be emitted.
const staticFiles = ['robots.txt', 'sitemap.xml', 'og-image.png', 'favicon.ico'];

function copyRootStatic() {
  return {
    name: 'copy-root-static',
    closeBundle() {
      for (const file of staticFiles) {
        const src = resolve(root, file);
        if (existsSync(src)) copyFileSync(src, resolve(root, 'dist', file));
      }
    },
  };
}

export default defineConfig({
  plugins: [copyRootStatic()],
  build: {
    rollupOptions: {
      input: Object.fromEntries(
        Object.entries(pages)
          .filter(([, file]) => existsSync(resolve(root, file)))
          .map(([name, file]) => [name, resolve(root, file)]),
      ),
    },
  },
});
