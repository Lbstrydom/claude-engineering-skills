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
 * A second population: CLI entry points a skill tells you to run
 * (`node scripts/<x>.mjs` in `skills/<name>/SKILL.md` or its references) that
 * have NO npm alias. package.json alone made them invisible — `scripts/fleet.mjs`,
 * a whole skill's CLI, had zero mentions (persona-test 2026-10-06). The skill
 * text is the source because it is what sends a user to the command; the
 * catalog's `entryPoints` block holds their descriptions.
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
export function collectCli(root = process.cwd(), { entryPoints = true } = {}) {
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
  // Entry points are a second population; a failure to read the skills tree is
  // surfaced in the source status, never as "no entry points".
  let eps = [];
  let epError = null;
  if (entryPoints) {
    try { eps = collectSkillEntryPoints(root, scripts, catalogEntryPointsMeta(root)); } catch (err) { epError = `skill entry points not read: ${err.code ?? ''} ${err.message}`.trim(); }
  }
  if (scriptNames.length === 0 && eps.length === 0 && !epError) {
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
      kind: 'npm',
    };
  });
  entries.push(...eps);
  // Stable sort: category alphabetical, then name alphabetical within each
  // category. The renderer groups by category, so this also fixes group order.
  entries.sort((a, b) => {
    if (a.category !== b.category) return a.category < b.category ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });

  const uncatalogedCount = entries.filter((e) => e.uncatalogued).length;
  const details = [];
  if (uncatalogedCount) details.push(`${uncatalogedCount} script(s) without a catalog entry — add to scripts/.cli-catalog.json`);
  if (epError) details.push(epError);
  const status = { status: 'ok', detail: details.join('; ') };

  return { entries, status };
}

/** The catalog's entryPoints block; absent or unreadable catalog → {} (the npm path reports catalog faults). */
function catalogEntryPointsMeta(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, CATALOG_REL), 'utf-8')).entryPoints || {}; } catch { return {}; }
}

const ENTRY_RE = /\bnode\s+scripts\/([A-Za-z0-9._-]+\.mjs)\b/g;

/** `skills/<name>/SKILL.md` + `skills/<name>/references/*.md`, for every skill dir. */
/** readdir, where only "does not exist" means empty — any other failure propagates. */
function readdirIfPresent(dir, opts) {
  try { return fs.readdirSync(dir, opts); } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
}

function skillTextFiles(root) {
  const skillsDir = path.join(root, 'skills');
  const names = readdirIfPresent(skillsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
  const out = [];
  for (const name of names) {
    const dir = path.join(skillsDir, name);
    out.push({ skill: name, file: path.join(dir, 'SKILL.md') });
    const refs = readdirIfPresent(path.join(dir, 'references')).filter((f) => f.endsWith('.md')).sort();
    for (const r of refs) out.push({ skill: name, file: path.join(dir, 'references', r) });
  }
  return out;
}

/**
 * Top-level `scripts/*.mjs` a skill names as `node scripts/<x>.mjs`, that exist,
 * and that no npm script's command mentions. `relatedSkill` is the skill naming
 * it most often (ties → alphabetical), so it groups with the skill that uses it.
 *
 * @param {string} root
 * @param {Record<string,string>} scripts package.json scripts
 * @param {Record<string,{description?:string,category?:string,outputs?:string}>} meta catalog `entryPoints`
 * @returns {CliEntry[]}
 */
export function collectSkillEntryPoints(root, scripts, meta = {}) {
  const npmCommands = Object.values(scripts).join('\n');
  const mentions = new Map(); // rel → Map(skill → count)
  for (const { skill, file } of skillTextFiles(root)) {
    let text;
    try { text = fs.readFileSync(file, 'utf-8'); } catch (err) {
      if (err.code === 'ENOENT') continue; // a skill dir without a SKILL.md
      throw err;
    }
    for (const m of text.matchAll(ENTRY_RE)) {
      const rel = `scripts/${m[1]}`;
      if (!mentions.has(rel)) mentions.set(rel, new Map());
      const bySkill = mentions.get(rel);
      bySkill.set(skill, (bySkill.get(skill) || 0) + 1);
    }
  }
  const out = [];
  for (const [rel, bySkill] of mentions) {
    if (npmCommands.includes(rel) || !fs.existsSync(path.join(root, rel))) continue;
    const relatedSkill = [...bySkill].sort((a, b) => (b[1] - a[1]) || (a[0] < b[0] ? -1 : 1))[0][0];
    const m = meta[rel];
    out.push({
      name: rel,
      command: `node ${rel}`,
      description: m?.description || '',
      category: m?.category && VALID_CATEGORIES.has(m.category) ? m.category : 'skills',
      relatedSkill,
      outputs: m?.outputs || null,
      uncatalogued: !m,
      kind: 'entry-point',
    });
  }
  return out;
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
