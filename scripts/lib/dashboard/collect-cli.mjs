/**
 * @fileoverview CLI source collector for the local dashboard. Joins
 * `package.json` `scripts:` (the source of truth for what's runnable)
 * against `scripts/.cli-catalog.json` (the metadata sidecar — description,
 * category, related skill).
 *
 * Missing catalog entries surface as `uncatalogued: true`. That's
 * intentional friction — every new npm script either gets a catalog
 * entry, or shows up in the UI with a "no description" nudge. Better
 * than silently omitting it.
 *
 * Pure: no network, no LLM. Filesystem reads only.
 *
 * @module scripts/lib/dashboard/collect-cli
 */
import fs from 'node:fs';
import path from 'node:path';

const CATALOG_REL  = 'scripts/.cli-catalog.json';
const PACKAGE_REL  = 'package.json';

const VALID_CATEGORIES = new Set([
  'audit', 'diagnostic', 'sync', 'skills', 'arch', 'security',
  'learning', 'plans', 'dashboard', 'hooks', 'parity', 'test', 'other',
]);

/**
 * Collect the CLI catalog for the dashboard.
 *
 * @param {string} [root] — defaults to process.cwd()
 * @returns {{entries: CliEntry[], status: SourceStatus}}
 *
 * @typedef {object} CliEntry
 * @property {string} name           — e.g. 'audit:code'
 * @property {string} command        — the `node …` invocation from package.json
 * @property {string} description    — from sidecar; '' when uncatalogued
 * @property {string} category       — one of VALID_CATEGORIES
 * @property {string|null} relatedSkill — e.g. 'audit-code'; null if none
 * @property {string|null} outputs   — file the script writes (informational)
 * @property {boolean} uncatalogued  — true when package.json has it but sidecar doesn't
 *
 * @typedef {object} SourceStatus
 * @property {'ok'|'missing-optional'|'invalid'|'unexpected-error'} status
 * @property {string} detail
 */
export function collectCli(root = process.cwd()) {
  const pkgPath = path.join(root, PACKAGE_REL);
  if (!fs.existsSync(pkgPath)) {
    return { entries: [], status: { status: 'missing-optional', detail: 'package.json not found' } };
  }
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')); }
  catch (err) {
    return { entries: [], status: { status: 'unexpected-error', detail: `package.json parse error: ${err.message}` } };
  }
  const scripts = pkg.scripts || {};
  const scriptNames = Object.keys(scripts);
  if (scriptNames.length === 0) {
    return { entries: [], status: { status: 'missing-optional', detail: 'no npm scripts defined' } };
  }

  let catalog = { entries: {} };
  const catalogPath = path.join(root, CATALOG_REL);
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf-8'));
    } catch (err) {
      return {
        entries: [],
        status: { status: 'unexpected-error', detail: `.cli-catalog.json parse error: ${err.message}` },
      };
    }
  }
  // The sidecar may be entirely absent — that's fine, every entry just falls
  // back to `uncatalogued`. The source status reflects that.
  const catalogEntries = catalog.entries || {};

  const entries = scriptNames.map((name) => {
    const meta = catalogEntries[name];
    const uncatalogued = !meta;
    const category = meta?.category && VALID_CATEGORIES.has(meta.category)
      ? meta.category
      : 'other';
    return {
      name,
      command: scripts[name] || '',
      description: meta?.description || '',
      category,
      relatedSkill: meta?.relatedSkill || null,
      outputs: meta?.outputs || null,
      uncatalogued,
    };
  });
  // Stable sort: category alphabetical, then name alphabetical within each
  // category. The renderer groups by category, so this also fixes group order.
  entries.sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const uncatalogedCount = entries.filter((e) => e.uncatalogued).length;
  const status = uncatalogedCount === 0
    ? { status: 'ok', detail: '' }
    : { status: 'ok', detail: `${uncatalogedCount} script(s) without a catalog entry — add to scripts/.cli-catalog.json` };

  return { entries, status };
}

/**
 * Group entries by category, preserving sort order within each group.
 * @param {CliEntry[]} entries
 * @returns {Record<string, CliEntry[]>}
 */
export function groupByCategory(entries) {
  const out = {};
  for (const e of entries) {
    if (!out[e.category]) out[e.category] = [];
    out[e.category].push(e);
  }
  return out;
}

/**
 * Audit the catalog vs package.json — useful for a `skills:check`-style gate.
 * @param {string} [root]
 * @returns {{missing: string[], orphaned: string[]}}
 *   - missing: package.json scripts with no catalog entry (uncatalogued)
 *   - orphaned: catalog entries pointing at scripts that no longer exist
 */
export function auditCatalogCoverage(root = process.cwd()) {
  const pkgPath = path.join(root, PACKAGE_REL);
  const catPath = path.join(root, CATALOG_REL);
  if (!fs.existsSync(pkgPath) || !fs.existsSync(catPath)) {
    return { missing: [], orphaned: [] };
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
  const cat = JSON.parse(fs.readFileSync(catPath, 'utf-8'));
  const scriptNames = new Set(Object.keys(pkg.scripts || {}));
  const catalogNames = new Set(Object.keys(cat.entries || {}));
  return {
    missing:  [...scriptNames].filter((n) => !catalogNames.has(n)).sort(),
    orphaned: [...catalogNames].filter((n) => !scriptNames.has(n)).sort(),
  };
}
