/**
 * @fileoverview CLASS guard: a snapshot read in `scripts/lib/store/arch/**` may
 * not scope by `refresh_id` (or by a bare `refresh_runs.id`) without also
 * binding the row to the repo that asked.
 *
 * WHY A GUARD AND NOT SIX FIXES. The instances closed on 2026-09-04 were found
 * by a throwaway census script. Six instances of one shape across three modules
 * is a shape that regrows: every one of them was individually reasonable,
 * because a `refresh_id` is a globally unique UUID and scoping by it alone
 * always returns the right rows for *somebody's* snapshot. Unique is not the
 * same as owned. Nothing in the type system, the schema, or a review of any
 * single query can see the difference — so the check has to be mechanical and
 * it has to run over the whole directory, not over a list someone maintains.
 *
 * IMPACT, not overstated: the store is single-tenant (one DSN, the password IS
 * the secret), so this is cross-REPO leakage inside one operator's store — a
 * correctness and attribution fault, not a security boundary. It matters most
 * where a foreign corpus silently reads as a local measurement: band
 * calibration (whose whole premise is "this repo's OWN embedding background")
 * and drift attribution.
 *
 * THE TRAP THIS ANALYSER HAD TO AVOID. A guard that walks SQL *string literals*
 * would have passed `listSymbolsForSnapshot` and `countSymbolsForSnapshot` —
 * the two that build their WHERE clause as `wheres.join(' AND ')`, so the
 * literal a scanner sees is a bare interpolation and contains no `refresh_id`
 * at all. A static scan defeated by interpolation does not report a blind spot;
 * it reports green. So the unit of analysis here is the FUNCTION BODY (SQL and
 * the JS that assembles it), never one template literal.
 *
 * The second trap is narrower and was live in this repo: `listSymbolsForSnapshot`
 * already SELECTed `si.repo_id` and handed it to callers — it simply never
 * filtered on it. "Does the body mention repo_id?" would therefore have waved
 * through the single worst instance. Binding evidence must be a FILTER
 * (`repo_id = $n`, `repo_id = ANY(...)`, or a `{repo_id: x}` predicate object),
 * never a projection.
 *
 * Related: tests/active-snapshot-pointer.test.mjs covers the decision half of
 * `getActiveSnapshot` — that a binding whose failure changes nothing is
 * decorative. This file covers the population: that the binding is there at all.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const ARCH_DIR = path.join(REPO_ROOT, 'scripts', 'lib', 'store', 'arch');
const POISON = path.join(REPO_ROOT, 'tests', 'fixtures', 'poison', 'arch-unbound-refresh-read.mjs.txt');

// ── Allowlist ───────────────────────────────────────────────────────────────
//
// Keyed `module::function`; a non-empty `reason` is REQUIRED and asserted, so
// an entry can never be added as a bare silencer. Entries are checked against
// the live tree below — a stale one FAILS rather than lingering as a hole.

const ALLOWLIST = {
  'coverage.mjs::copyForwardCoverage':
    'Binds by a DIFFERENT and stronger mechanism, deliberately: it is the one '
    + 'coverage operation taking TWO refresh ids, so it resolves BOTH against '
    + '`refresh_runs.repo_id` and compares them to each other, refusing on '
    + '`cross-repo-refresh-mismatch`. It rejects a caller-supplied repoId on '
    + 'purpose — a CLI-resolved id is not a tenant boundary — so the '
    + '`repo_id = $n` filter this analyser looks for is the wrong shape here, '
    + 'not a missing one. It feeds its resolved id to the (bound) '
    + '`getGraphCoverage`, so the delegated read is covered.',
};

// ── Analyser ────────────────────────────────────────────────────────────────

/** Split a module into top-level function bodies (name + source text). */
export function splitFunctions(src) {
  const decl = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/gm;
  const starts = [];
  let m;
  while ((m = decl.exec(src)) !== null) starts.push([m.index, m[1]]);
  return starts.map(([at, name], i) => ({
    name,
    body: src.slice(at, i + 1 < starts.length ? starts[i + 1][0] : src.length),
  }));
}

/** A read is snapshot-scoped if it filters on refresh_id, or on refresh_runs.id. */
function snapshotScopedRead(body) {
  if (!/\bSELECT\b/i.test(body)) return null;
  if (/\brefresh_id\s*=\s*\$\d+/.test(body) || /\brefresh_id\s*=\s*ANY\s*\(/.test(body)) {
    return 'refresh_id';
  }
  // `refresh_runs` keyed by its own primary key is the same question wearing a
  // different column name — it is how `getActiveSnapshot` and
  // `getFreshImportersOrNull` resolved a pointer without checking whose it was.
  if (/FROM\s+refresh_runs/i.test(body)
      && (/\bid\s*=\s*\$\d+/.test(body) || /\bid\s*=\s*ANY\s*\(/.test(body))) {
    return 'refresh_runs.id';
  }
  return null;
}

/** Binding evidence must be a FILTER on repo_id. A projection is not evidence. */
function hasRepoBinding(body) {
  return /\brepo_id\s*=\s*\$\d+/.test(body)
    || /\brepo_id\s*=\s*ANY\s*\(/.test(body)
    || /\brepo_id\s*:\s*[A-Za-z_$]/.test(body);   // updateWhere({...}, {repo_id: x})
}

/** @returns {{sites: Array<{key: string, file: string, fn: string, trigger: string, bound: boolean}>}} */
export function analyse(files) {
  const sites = [];
  for (const { file, src } of files) {
    for (const { name, body } of splitFunctions(src)) {
      const trigger = snapshotScopedRead(body);
      if (!trigger) continue;
      sites.push({ key: `${file}::${name}`, file, fn: name, trigger, bound: hasRepoBinding(body) });
    }
  }
  return { sites };
}

function readArchTree() {
  return fs.readdirSync(ARCH_DIR)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => ({ file: f, src: fs.readFileSync(path.join(ARCH_DIR, f), 'utf-8') }));
}

// ── The analyser must be able to go red ─────────────────────────────────────
//
// "A check is not trustworthy until seen to fail" (AGENTS.md §verification-
// discipline). These run against a fixture rather than the live tree, so the
// negative control survives the tree being correct.

describe('the binding analyser itself', () => {
  const poison = [{ file: 'poison.mjs', src: fs.readFileSync(POISON, 'utf-8') }];

  it('FLAGS a plain unbound refresh_id read', () => {
    const site = analyse(poison).sites.find((s) => s.fn === 'readsUnboundSnapshot');
    assert.ok(site, 'analyser did not even see the unbound read');
    assert.equal(site.bound, false);
  });

  it('FLAGS a read that PROJECTS repo_id but never filters on it', () => {
    // The single most important assertion in this file: this is the exact shape
    // `listSymbolsForSnapshot` had, and the shape a "mentions repo_id?" check
    // would call clean.
    const site = analyse(poison).sites.find((s) => s.fn === 'readsUnboundViaProjection');
    assert.ok(site, 'analyser did not see the projection-only read');
    assert.equal(site.bound, false, 'a projected repo_id was accepted as a binding');
  });

  it('does NOT flag a correctly bound read — the direction it must not fire', () => {
    const site = analyse(poison).sites.find((s) => s.fn === 'readsBound');
    assert.ok(site, 'analyser did not see the bound read');
    assert.equal(site.bound, true);
  });

  it('sees a read whose WHERE clause is BUILT, not written as one literal', () => {
    // Regression guard for the interpolation blind spot: `listSymbolsForSnapshot`
    // assembles its WHERE from an array join, so a literal-walking scanner finds
    // no `refresh_id` in any single template and reports a clean pass.
    const src = [
      'export async function dynamic({ refreshId }) {',
      "  const wheres = ['si.refresh_id = $1'];",
      '  const sql = `SELECT si.id FROM symbol_index si WHERE ${wheres.join(" AND ")}`;',
      '  return many(sql, [refreshId]);',
      '}',
    ].join('\n');
    const site = analyse([{ file: 'dyn.mjs', src }]).sites.find((s) => s.fn === 'dynamic');
    assert.ok(site, 'a built WHERE clause was invisible to the analyser');
    assert.equal(site.bound, false);
  });
});

// ── The live tree ───────────────────────────────────────────────────────────

describe('scripts/lib/store/arch/** — every snapshot read is repo-bound', () => {
  const { sites } = analyse(readArchTree());

  it('is not vacuous — the analyser actually found snapshot reads to judge', () => {
    // Without this, deleting the trigger regexes would make the suite pass by
    // examining nothing. 12 is a floor well under the count at the time of
    // writing (15), so it tracks "the analyser still works", not the roster.
    assert.ok(sites.length >= 12,
      `only ${sites.length} snapshot reads found — the analyser has probably stopped matching`);
  });

  it('has no unbound reads outside the allowlist', () => {
    const unbound = sites.filter((s) => !s.bound && !(s.key in ALLOWLIST));
    assert.deepEqual(unbound.map((s) => `${s.key} (scoped by ${s.trigger})`), [],
      'a snapshot read scopes by refresh_id without binding it to a repo — add '
      + 'the repo filter (or a JOIN through refresh_runs for a table with no '
      + 'repo_id of its own), never an allowlist entry to quiet this');
  });

  it('every allowlist entry names a function that still exists AND is still unbound', () => {
    // A stale entry is a hole: it silences a key nothing produces any more, and
    // would silently re-cover a future function that reuses the name.
    const byKey = new Map(sites.map((s) => [s.key, s]));
    for (const key of Object.keys(ALLOWLIST)) {
      const site = byKey.get(key);
      assert.ok(site, `allowlist entry ${key} matches no snapshot read — delete it`);
      assert.equal(site.bound, false,
        `allowlist entry ${key} is now bound by the ordinary mechanism — delete the exemption`);
    }
  });

  it('every allowlist entry carries a reason', () => {
    for (const [key, reason] of Object.entries(ALLOWLIST)) {
      assert.equal(typeof reason, 'string', `${key}: reason must be a string`);
      assert.ok(reason.trim().length >= 40, `${key}: reason is too thin to be a decision`);
    }
  });
});
