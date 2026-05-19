/**
 * @fileoverview Asset loader — the single I/O boundary for the dashboard's
 * CSS/JS. Keeps `render.mjs` a pure function (it receives `assets` as a
 * parameter rather than reading disk). See docs/plans/local-dashboard.md §4.
 *
 * @module scripts/lib/dashboard/load-assets
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ASSET_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'assets');

/**
 * Read the dashboard CSS + JS from disk.
 * @returns {{css: string, js: string}}
 */
export function loadAssets() {
  try {
    return {
      css: fs.readFileSync(path.join(ASSET_DIR, 'dashboard.css'), 'utf-8'),
      js: fs.readFileSync(path.join(ASSET_DIR, 'dashboard.js'), 'utf-8'),
    };
  } catch (err) {
    // The single I/O boundary for assets — give callers dashboard-level
    // context instead of a bare Node errno.
    throw new Error(`dashboard: could not load bundled assets from ${ASSET_DIR} — ${err.message}`);
  }
}
