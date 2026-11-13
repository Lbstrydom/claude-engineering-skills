/**
 * @fileoverview Which store views are TIME-WINDOWED, derived from the migrations.
 *
 * **Why it exists.** `unremediated_acceptances` is a 7–30 day window on
 * `audit_runs.created_at`; `unlocked_fixes` is a 14-day one. Two reads five weeks
 * apart therefore describe **disjoint cohorts**, and a fall between them is aging,
 * not work. Measured 2026-11-13: the two Q2 windows shared **0** rows and **110 of
 * the 116** rows reported on 2026-10-11 are still open and unremediated today; of
 * Q1's 95, **96** are still unlocked. Both figures reproduced exactly against the
 * live store — reproducing a figure cannot detect that the population under it
 * rotated. Investigation: `docs/plans/standing-queue-burndown.md` §7.
 *
 * **The classification is DERIVED, never hand-listed**, because the view at the
 * centre of that incident does not mention a clock at all:
 *
 * ```sql
 * CREATE OR REPLACE VIEW unremediated_acceptances AS
 *   SELECT * FROM unremediated_acceptances_all
 *    WHERE is_mature AND is_recent AND is_open_disposition;  -- now() lives in _all
 * ```
 *
 * So windowedness **propagates**: a view is windowed if its own body names a clock
 * function, or if it selects from a view that is. A literal-`now()` grep over the
 * migrations misses exactly the two views this module exists for.
 *
 * **Migrations are cumulative**, so the live definition of a view is the LAST
 * `CREATE OR REPLACE VIEW` for that name in timestamp order — never the first one
 * found. (AGENTS.md: read the live definition, not the migration that introduced it.)
 *
 * The committed `.windowed-views.json` is the declaration side: every derived
 * windowed view must be declared there with the window it carries and what a
 * caller may compare instead, or carry a reasoned exemption. `scripts/check-windowed-views.mjs`
 * is the gate.
 *
 * Plan: docs/plans/standing-queue-burndown.md §7.
 *
 * @module scripts/lib/store/windowed-views
 */

import fs from 'node:fs';
import path from 'node:path';

/** Repo-relative directory holding the cumulative SQL migrations. */
export const MIGRATIONS_DIR = 'supabase/migrations';

/** Repo-relative path of the committed declaration file. */
export const MANIFEST_PATH = '.windowed-views.json';

/**
 * Functions whose value depends on when the query runs. `now()` and
 * `current_date` are the two that appear in this store today; the rest are here so
 * a future migration cannot sidestep the gate by spelling the clock differently.
 */
export const CLOCK_FUNCTIONS = Object.freeze([
  'now', 'current_date', 'current_time', 'current_timestamp',
  'localtime', 'localtimestamp', 'clock_timestamp',
  'statement_timestamp', 'transaction_timestamp', 'timeofday',
]);

const CLOCK_RE = new RegExp(`\\b(?:${CLOCK_FUNCTIONS.join('|')})\\b`, 'i');

/**
 * Strip SQL comments, quoted literals and dollar-quoted bodies, replacing each
 * with a space so token boundaries survive.
 *
 * Done BEFORE any statement splitting: a `;` inside a function body or a `--`
 * comment would otherwise end a statement early, and the word `view` inside a
 * comment would otherwise be read as a definition (it was, in the throwaway probe
 * that preceded this module: three "views" named `is`, `only` and `can`).
 *
 * @param {string} sql
 * @returns {string}
 */
export function stripNonCode(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const two = sql.slice(i, i + 2);
    if (two === '--') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
      continue;
    }
    if (two === '/*') {
      // Postgres block comments nest.
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql.slice(j, j + 2) === '/*') { depth += 1; j += 2; continue; }
        if (sql.slice(j, j + 2) === '*/') { depth -= 1; j += 2; continue; }
        j += 1;
      }
      i = j;
      out += ' ';
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) { j += 2; continue; } // doubled quote escape
          j += 1;
          break;
        }
        j += 1;
      }
      // A double-quoted identifier is code: keep it (unquoted) so `"my view"` still parses.
      out += ch === '"' ? ` ${sql.slice(i + 1, Math.max(j - 1, i + 1))} ` : ' ';
      i = j;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tag) {
        const end = sql.indexOf(tag[0], i + tag[0].length);
        i = end === -1 ? sql.length : end + tag[0].length;
        out += ' ';
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

const normaliseName = (raw) => raw.trim().replace(/"/g, '').split('.').pop().toLowerCase();

/**
 * Every `CREATE [OR REPLACE] VIEW` statement in one already-stripped SQL text,
 * in file order, as `{ name, body }`.
 *
 * @param {string} stripped - output of {@link stripNonCode}
 * @returns {{name: string, body: string}[]}
 */
export function parseViewStatements(stripped) {
  const re = /\bcreate\s+(?:or\s+replace\s+)?(?:materialized\s+)?view\s+(?:if\s+not\s+exists\s+)?([A-Za-z0-9_."]+)/gi;
  const out = [];
  let m;
  while ((m = re.exec(stripped)) !== null) {
    // Statement ends at the first `;` at paren depth 0 — subqueries carry their own.
    let depth = 0;
    let j = re.lastIndex;
    for (; j < stripped.length; j += 1) {
      const c = stripped[j];
      if (c === '(') depth += 1;
      else if (c === ')') depth -= 1;
      else if (c === ';' && depth <= 0) break;
    }
    out.push({ name: normaliseName(m[1]), body: stripped.slice(re.lastIndex, j) });
    re.lastIndex = j;
  }
  return out;
}

/**
 * The LIVE definition of every view, resolved cumulatively across the migrations.
 *
 * Fails closed (throws) on an unreadable or empty migrations directory: a clean
 * checkout always has it, so "no migrations" is a broken run, never "no windowed
 * views".
 *
 * @param {string} repoRoot
 * @param {{dir?: string}} [opts]
 * @returns {Map<string, {name: string, body: string, file: string}>}
 */
export function collectViewDefinitions(repoRoot, { dir = MIGRATIONS_DIR } = {}) {
  const abs = path.join(repoRoot, dir);
  let files;
  try {
    files = fs.readdirSync(abs).filter((f) => f.toLowerCase().endsWith('.sql')).sort();
  } catch (err) {
    throw new Error(`cannot read migrations at ${dir}: ${err.message}`);
  }
  if (files.length === 0) throw new Error(`no .sql migrations under ${dir} — refusing to report "no windowed views" from an empty scan`);

  const defs = new Map();
  for (const file of files) {
    const stripped = stripNonCode(fs.readFileSync(path.join(abs, file), 'utf8'));
    for (const { name, body } of parseViewStatements(stripped)) {
      defs.set(name, { name, body, file: `${dir}/${file}` }); // later migration wins
    }
  }
  return defs;
}

/**
 * Classify each view as windowed or not, propagating windowedness through view
 * references to a fixpoint.
 *
 * @param {Map<string, {name: string, body: string, file: string}>} defs
 * @returns {Map<string, {name: string, file: string, windowed: boolean, reason: string|null, via: string|null}>}
 */
export function classifyWindowedViews(defs) {
  const out = new Map();
  for (const [name, d] of defs) {
    const clock = CLOCK_RE.test(d.body);
    out.set(name, {
      name,
      file: d.file,
      windowed: clock,
      reason: clock ? 'clock-function' : null,
      via: null,
    });
  }
  // Fixpoint: a view selecting from a windowed view inherits the window.
  const nameRes = new Map([...defs.keys()].map((n) => [n, new RegExp(`\\b${n}\\b`, 'i')]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, d] of defs) {
      const rec = out.get(name);
      if (rec.windowed) continue;
      for (const [other, re] of nameRes) {
        if (other === name || !out.get(other).windowed) continue;
        if (!re.test(d.body)) continue;
        rec.windowed = true;
        rec.reason = 'inherits';
        rec.via = other;
        changed = true;
        break;
      }
    }
  }
  return out;
}

/**
 * Read and validate the committed declaration file.
 *
 * @param {string} repoRoot
 * @param {{manifest?: string}} [opts]
 * @returns {{kind: 'ok', views: Record<string, object>, exemptions: Record<string, string>}
 *          |{kind: 'missing'}|{kind: 'invalid', reason: string}}
 */
export function readManifest(repoRoot, { manifest = MANIFEST_PATH } = {}) {
  const abs = path.join(repoRoot, manifest);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch {
    return { kind: 'missing' };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { kind: 'invalid', reason: `not valid JSON (${err.message})` };
  }
  if (!parsed || typeof parsed !== 'object') return { kind: 'invalid', reason: 'not an object' };
  const views = parsed.views;
  if (!views || typeof views !== 'object' || Array.isArray(views)) return { kind: 'invalid', reason: 'missing the "views" object' };
  for (const [name, entry] of Object.entries(views)) {
    if (!entry || typeof entry !== 'object') return { kind: 'invalid', reason: `views.${name} is not an object` };
    if (typeof entry.window !== 'string' || entry.window.trim() === '') {
      return { kind: 'invalid', reason: `views.${name}.window must state the window the view carries` };
    }
    if (typeof entry.comparable !== 'string' || entry.comparable.trim() === '') {
      return { kind: 'invalid', reason: `views.${name}.comparable must state what a caller may compare across time instead` };
    }
    if (entry.queues !== undefined && !Array.isArray(entry.queues)) {
      return { kind: 'invalid', reason: `views.${name}.queues must be an array when present` };
    }
  }
  const exemptions = parsed.exemptions ?? {};
  if (typeof exemptions !== 'object' || Array.isArray(exemptions)) return { kind: 'invalid', reason: '"exemptions" must be an object of name → reason' };
  for (const [name, reason] of Object.entries(exemptions)) {
    if (typeof reason !== 'string' || reason.trim() === '') return { kind: 'invalid', reason: `exemptions.${name} must carry a reason` };
  }
  return { kind: 'ok', views, exemptions };
}

/**
 * Drift between what the migrations say and what the manifest declares.
 *
 * Both directions fail, in the ratchet shape this repo already uses: an
 * **undeclared** windowed view is a figure nobody will know not to trend, and a
 * **stale** declaration is a claim about a view that is no longer windowed (or no
 * longer exists), which is just as misleading to a reader of the manifest.
 *
 * @param {Map<string, {windowed: boolean, reason: string|null, via: string|null, file: string}>} classified
 * @param {{views: Record<string, object>, exemptions: Record<string, string>}} manifest
 * @returns {{undeclared: object[], staleDeclared: object[], staleExempt: object[]}}
 */
export function diffAgainstManifest(classified, manifest) {
  const undeclared = [];
  const staleDeclared = [];
  const staleExempt = [];
  for (const [name, rec] of classified) {
    if (!rec.windowed) continue;
    if (name in manifest.views || name in manifest.exemptions) continue;
    undeclared.push({ name, reason: rec.reason, via: rec.via, file: rec.file });
  }
  for (const name of Object.keys(manifest.views)) {
    const rec = classified.get(name);
    if (!rec) { staleDeclared.push({ name, why: 'no such view in the migrations' }); continue; }
    if (!rec.windowed) staleDeclared.push({ name, why: 'the live definition no longer references a clock, directly or through another view' });
  }
  for (const name of Object.keys(manifest.exemptions)) {
    const rec = classified.get(name);
    if (!rec) { staleExempt.push({ name, why: 'no such view in the migrations' }); continue; }
    if (!rec.windowed) staleExempt.push({ name, why: 'the view is not windowed, so the exemption claims nothing' });
  }
  return { undeclared, staleDeclared, staleExempt };
}

/**
 * The declared standing-queue keys whose backing view is windowed.
 *
 * @param {{views: Record<string, {queues?: string[]}>}} manifest
 * @returns {Set<string>}
 */
export function windowedQueueKeys(manifest) {
  const keys = new Set();
  for (const entry of Object.values(manifest.views ?? {})) {
    for (const q of entry.queues ?? []) keys.add(q);
  }
  return keys;
}
