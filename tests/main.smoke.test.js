// Smoke checks for the no-build-step contract (R4.1, R4.3).
//
// These tests inspect the repo on disk: they ensure no bundler config files
// exist and that index.html declares an importmap targeting only the
// allow-listed origins (esm.sh, jsdelivr, or relative ./vendor/).

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = process.cwd();

describe('Repository smoke checks (R4.1 / R4.3)', () => {
  it('contains no bundler config files (R4.1)', () => {
    const banned = [
      'webpack.config.js',
      'webpack.config.ts',
      'vite.config.js',
      'vite.config.ts',
      'rollup.config.js',
      'rollup.config.mjs',
      'tsconfig.json',
    ];
    for (const name of banned) {
      const p = path.join(REPO_ROOT, name);
      expect(
        fs.existsSync(p),
        `Repository should not contain ${name} — it would imply a bundler.`,
      ).toBe(false);
    }
  });

  it('index.html declares an importmap with no bundle script (R4.3)', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
    expect(html).toMatch(/<script\s+type="importmap">/);

    // Importmap targets must be on the allow-list (esm.sh / cdn.jsdelivr.net
    // / relative ./vendor/). We require AT LEAST ONE such target; we do NOT
    // forbid others appearing inside the file (e.g. comments) — but every
    // import URL inside the importmap must be on the allow-list.
    const importmapMatch = html.match(
      /<script\s+type="importmap">([\s\S]*?)<\/script>/,
    );
    expect(importmapMatch, 'importmap block must be present').not.toBeNull();
    const importmapBody = importmapMatch[1];
    const urlMatches = [...importmapBody.matchAll(/"((?:https?:\/\/|\.\.?\/)[^"\s]+)"/g)];
    expect(urlMatches.length, 'importmap should declare at least one import target').toBeGreaterThan(0);
    for (const m of urlMatches) {
      const url = m[1];
      const isAllowed =
        url.startsWith('https://esm.sh/') ||
        url.startsWith('https://cdn.jsdelivr.net/') ||
        url.startsWith('./vendor/') ||
        url.startsWith('../vendor/');
      expect(
        isAllowed,
        `importmap target ${url} is not on the allow-list (esm.sh / jsdelivr / ./vendor/)`,
      ).toBe(true);
    }
  });

  it('does not include a Webpack/Vite/Rollup runtime entry script tag', () => {
    const html = fs.readFileSync(path.join(REPO_ROOT, 'index.html'), 'utf-8');
    // The only <script> tags in index.html should be the importmap and the
    // top-level module loading ./src/main.js. No bundled assets.
    expect(html).not.toMatch(/dist\/bundle/);
    expect(html).not.toMatch(/\.bundle\.js/);
  });
});
