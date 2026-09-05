/**
 * @fileoverview Schema-realization contract — Tier 1.
 *
 * The pure half of the runtime green-but-unrealized guard: does this database have the
 * migrations this bundle ships? The impure half (the `_exec` hook) is in
 * `write-path-fail-closed.test.mjs`.
 *
 * Plan: docs/plans/green-but-unrealized.md (Cluster A, Phase 1).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MIGRATION_DIR_BY_LAYOUT, resolveMigrationsDir, defaultRepoRoot, listBundledMigrations,
  findUnappliedMigrations, bundledDigest, assertSchemaRealized, ERR_SCHEMA_BEHIND,
  withMigrationContext, isMigrationContext, REALIZATION_TTL_MS,
  detectLayout, setupPostgresCommand, describeDatabase,  checkMigrationRealization,
} from '../scripts/lib/db/schema-realization.mjs';
import { LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';

function mkTmp(p) { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); }
function rmTmp(d) { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }

/** A pool stub: `queries` records what was asked, `impl` decides the answer. */
function stubPool(impl) {
  const queries = [];
  return {
    queries,
    async query(sql, params) { queries.push(sql); return impl(sql, params); },
  };
}
const LEDGER_PRESENT = (names) => (sql) =>
  /to_regclass/.test(sql)
    ? { rows: [{ t: 'audit_loop_migrations' }] }
    : { rows: names.map((filename) => ({ filename })) };

// ── The two real layouts ────────────────────────────────────────────────────

test('the hardcoded layout candidates match sync-path-map — a rename there fails HERE', () => {
  // These literals are duplicated rather than imported (sync-path-map is `install`-domain
  // and this module is on the DB write path). This test is what makes the duplication safe:
  // if the canonical constant moves, the copy stops matching and fails loudly instead of
  // resolving to nothing and reporting "no migrations dir" — a silent false green.
  const dest = LAYOUT_CONSTANTS.MIGRATIONS_DEST_PREFIX.replace(/\/$/, '');
  const src = LAYOUT_CONSTANTS.MIGRATIONS_SRC_PREFIX.replace(/\/$/, '');
  assert.equal(MIGRATION_DIR_BY_LAYOUT.source, src, `source layout must be ${src}`);
  assert.equal(MIGRATION_DIR_BY_LAYOUT.consumer, dest, `consumer layout must be ${dest}`);
});

test('each layout resolves ONLY its own directory — never the other one', () => {
  // The two directories are two different databases' schemas, so first-existing-wins is a
  // coin flip, not a fallback: in a consumer BOTH exist, and picking the app's
  // `supabase/migrations/` compared it against the audit-loop ledger and then printed a
  // `--migrate` that would apply the app's DDL to the shared audit store.
  const dir = mkTmp('ces-mig-');
  try {
    assert.equal(resolveMigrationsDir(dir, 'consumer'), null, 'absent ⇒ indeterminate');
    fs.mkdirSync(path.join(dir, '.audit-loop', 'migrations'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
    assert.equal(resolveMigrationsDir(dir, 'consumer'), path.join(dir, '.audit-loop', 'migrations'));
    assert.equal(resolveMigrationsDir(dir, 'source'), path.join(dir, 'supabase', 'migrations'));
  } finally { rmTmp(dir); }
});

test('resolveMigrationsDir works with NO argument — the way the write path calls it', () => {
  // Every other test passed an explicit dir, so the default-parameter expression was never
  // evaluated and `defaultRepoRoot` being undefined was a ReferenceError nobody could see.
  // `_exec` swallows it into fail-open, so the live symptom was a cloud write degrading
  // silently — a guard that stopped guarding while every test stayed green.
  const dir = resolveMigrationsDir();
  assert.equal(typeof dir, 'string', 'the source repo has supabase/migrations');
  assert.ok(fs.existsSync(dir));
});

test('defaultRepoRoot is anchored to the module, not to process.cwd()', () => {
  // A cwd-relative root answers "no migrations directory" from any subdirectory — which
  // this module treats as indeterminate, i.e. ALLOW.
  const before = process.cwd();
  try {
    process.chdir(os.tmpdir());
    assert.ok(fs.existsSync(path.join(defaultRepoRoot(), 'package.json')));
    assert.equal(typeof resolveMigrationsDir(), 'string');
  } finally { process.chdir(before); }
});

test('detectLayout keys on the tooling dir sync actually writes to', () => {
  // The layout probe is what makes the per-layout resolution above reachable in a consumer.
  // If CONSUMER_TOOLING_DIR is renamed and this literal is not, every consumer silently
  // reverts to source-layout answers — the same false green, one level up.
  assert.equal(detectLayout('/repo/scripts/lib/db/schema-realization.mjs'), 'source');
  assert.equal(
    detectLayout(`/repo/${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/lib/db/schema-realization.mjs`),
    'consumer',
  );
  // Windows separators: the write path runs here.
  assert.equal(
    detectLayout('C:\\repo\\scripts\\.claude-skills\\lib\\db\\schema-realization.mjs'),
    'consumer',
  );
});

test('defaultRepoRoot climbs one MORE level under the consumer layout', () => {
  // `scripts/lib/db/` here vs `scripts/.claude-skills/lib/db/` in a consumer. A fixed
  // three-up landed on `<consumer>/scripts`, where neither layout exists — so the runtime
  // write guard resolved null and allowed EVERY consumer write unchecked. Fail-open, so
  // nothing ever reported it: the guard was inert in exactly the repos it was written for.
  const source = defaultRepoRoot('source');
  const consumer = defaultRepoRoot('consumer');
  assert.equal(consumer, path.dirname(source), 'consumer root is one level above the source root');
});

test('the printed remediation names a path that exists in THAT layout', () => {
  // A consumer's runner is `scripts/.claude-skills/setup-postgres.mjs`; naming this repo's
  // path there reads as "the tool is broken", not "apply your migrations".
  assert.equal(setupPostgresCommand('source'), 'node scripts/setup-postgres.mjs --migrate');
  assert.equal(
    setupPostgresCommand('consumer'),
    `node ${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/setup-postgres.mjs --migrate`,
  );
});

test('describeDatabase names host/db and NEVER the credentials', () => {
  const pool = { options: { connectionString: 'postgresql://u:sup3rsecret@db.example.com:5432/postgres' } };
  const desc = describeDatabase(pool);
  assert.equal(desc, 'db.example.com/postgres');
  assert.ok(!desc.includes('sup3rsecret'), 'a DSN password must never reach a log line');
  assert.equal(describeDatabase({}), null);
  assert.equal(describeDatabase({ options: { connectionString: 'not a url' } }), null);
});

test('a behind-schema error names BOTH sides it compared', async () => {
  // The message is a remediation that applies DDL, so it is only safely followable if the
  // reader can see which directory was compared against which database. Unqualified "the
  // database" is what turned the consumer-layout bug from wrong into dangerous.
  await withMigrations(['001_a.sql'], async (dir) => {
    const pool = stubPool(LEDGER_PRESENT([]));
    pool.options = { connectionString: 'postgresql://u:p@db.example.com:5432/postgres' };
    await assert.rejects(
      () => assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} }),
      (err) => {
        assert.equal(err.code, ERR_SCHEMA_BEHIND);
        assert.match(err.message, /db\.example\.com\/postgres/, 'names the database read');
        assert.ok(err.message.includes(dir), 'names the directory compared');
        assert.match(err.message, /public\.audit_loop_migrations/, 'names the ledger');
        assert.ok(!err.message.includes(':p@'), 'no credentials');
        return true;
      },
    );
  });
});

// ── Pure set difference ─────────────────────────────────────────────────────

test('findUnappliedMigrations reports bundled-but-absent, by NAME not count', () => {
  const bundled = ['001_a.sql', '002_b.sql', '003_c.sql'];
  assert.deepEqual(findUnappliedMigrations(bundled, new Set(['001_a.sql'])), ['002_b.sql', '003_c.sql']);
  assert.deepEqual(findUnappliedMigrations(bundled, new Set(bundled)), []);
});

test('a count cannot substitute: same COUNT, different identities, still behind', () => {
  // The reason this is a set difference and not an epoch integer. Both sides have 2.
  const bundled = ['001_a.sql', '002_b.sql'];
  const applied = new Set(['001_a.sql', '999_other.sql']);
  assert.deepEqual(findUnappliedMigrations(bundled, applied), ['002_b.sql']);
});

test('a database AHEAD of this bundle is not reported — that is a legitimate state', () => {
  // A consumer on an older bundle sees ledger rows it has no file for. Not our business.
  assert.deepEqual(findUnappliedMigrations(['001_a.sql'], new Set(['001_a.sql', '002_b.sql'])), []);
});

test('bundledDigest changes when the bundle gains a migration', () => {
  // This is the cache-key component: without it a long-running process that gains a
  // migration mid-session keeps serving a stale "realized".
  assert.notEqual(bundledDigest(['a.sql']), bundledDigest(['a.sql', 'b.sql']));
  assert.equal(bundledDigest(['a.sql', 'b.sql']), bundledDigest(['a.sql', 'b.sql']));
});

// ── The assertion, and its deliberate failure direction ─────────────────────

// MUST be async and `await fn(dir)`. A synchronous `return fn(dir)` runs the `finally` the
// moment the promise is CREATED, deleting the fixture directory before the assertion reads
// it — the bundle then looks empty and every "behind" case silently passes as
// "no-migrations-dir". A test helper that races its own fixture is a false green.
async function withMigrations(names, fn) {
  const dir = mkTmp('ces-mig2-');
  try {
    for (const n of names) fs.writeFileSync(path.join(dir, n), '-- x\n');
    return await fn(dir);
  } finally { rmTmp(dir); }
}

test('behind ⇒ throws ERR_SCHEMA_BEHIND naming the missing files', async () => {
  await withMigrations(['001_a.sql', '002_b.sql'], async (dir) => {
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    await assert.rejects(
      () => assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} }),
      (err) => {
        assert.equal(err.code, ERR_SCHEMA_BEHIND);
        assert.deepEqual(err.missing, ['002_b.sql']);
        assert.match(err.message, /--migrate/, 'must name the remedy');
        return true;
      },
    );
  });
});

test('level ⇒ realized', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    const r = await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    assert.equal(r.realized, true);
    assert.equal(r.reason, 'verified');
  });
});

test('no ledger table ⇒ ALLOWS with a warning — pre-ledger DB is adopt territory', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    const warnings = [];
    const pool = stubPool(() => ({ rows: [{ t: null }] }));
    const r = await assertSchemaRealized({ pool, migrationsDir: dir, warn: (m) => warnings.push(m) });
    assert.equal(r.realized, true);
    assert.equal(r.reason, 'no-ledger');
    assert.match(warnings.join(' '), /--adopt/);
  });
});

test('an unreadable ledger ALLOWS and warns — refusing on unknown would be a self-inflicted outage', async () => {
  // The deliberate asymmetry: unknown SCHEMA blocks nothing and warns; unknown COVERAGE
  // claims nothing. Both refuse to lie; they differ in which silence is dangerous.
  await withMigrations(['001_a.sql'], async (dir) => {
    const warnings = [];
    const pool = stubPool(() => { throw new Error('permission denied for table audit_loop_migrations'); });
    const r = await assertSchemaRealized({ pool, migrationsDir: dir, warn: (m) => warnings.push(m) });
    assert.equal(r.realized, true);
    assert.equal(r.reason, 'ledger-unreadable');
    assert.match(warnings.join(' '), /permission denied/);
  });
});

test('no migrations directory ⇒ allowed, and never claimed as "zero missing"', async () => {
  const pool = stubPool(() => { throw new Error('must not be queried'); });
  const r = await assertSchemaRealized({ pool, migrationsDir: null, warn: () => {} });
  assert.equal(r.reason, 'no-migrations-dir');
  assert.equal(pool.queries.length, 0, 'must not touch the DB when there is nothing to compare');
});

// ── Cache semantics ─────────────────────────────────────────────────────────

test('a positive result is cached per pool — N calls, ONE ledger read', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    for (let i = 0; i < 5; i++) await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    const ledgerReads = pool.queries.filter((q) => /audit_loop_migrations/.test(q) && !/to_regclass/.test(q));
    assert.equal(ledgerReads.length, 1, 'an assertion that re-queries every write is an N+1');
  });
});

test('the cache does NOT leak across pools', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    const good = stubPool(LEDGER_PRESENT(['001_a.sql']));
    await assertSchemaRealized({ pool: good, migrationsDir: dir, warn: () => {} });
    // A DIFFERENT pool (different database) must be checked on its own merits.
    const behind = stubPool(LEDGER_PRESENT([]));
    await assert.rejects(() => assertSchemaRealized({ pool: behind, migrationsDir: dir, warn: () => {} }));
  });
});

test('the cache does NOT survive the bundle gaining a migration', async () => {
  const dir = mkTmp('ces-mig3-');
  try {
    fs.writeFileSync(path.join(dir, '001_a.sql'), '-- x\n');
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });

    // `git pull` mid-session adds a migration. A path-only cache key would keep saying
    // "realized" here — the exact stale-cache hazard the bundled digest closes.
    fs.writeFileSync(path.join(dir, '002_b.sql'), '-- x\n');
    await assert.rejects(
      () => assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} }),
      (err) => err.code === ERR_SCHEMA_BEHIND,
    );
  } finally { rmTmp(dir); }
});

test('an indeterminate result is NOT cached — the next call re-checks', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    let fail = true;
    const pool = stubPool((sql) => {
      if (fail) throw new Error('transient');
      return LEDGER_PRESENT(['001_a.sql'])(sql);
    });
    const first = await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    assert.equal(first.reason, 'ledger-unreadable');
    fail = false;   // the blip clears
    const second = await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    assert.equal(second.reason, 'verified', 'caching indeterminate would permit every later write');
  });
});

// ── Migration context ───────────────────────────────────────────────────────

test('withMigrationContext scopes the bypass, and does not leak out of it', async () => {
  assert.equal(isMigrationContext(), false);
  await withMigrationContext(async () => {
    assert.equal(isMigrationContext(), true);
  });
  assert.equal(isMigrationContext(), false, 'a global flag left set by a crash would disable the guard');
});

// ── Indeterminate is distinguishable from verified ──────────────────────────

test('allowed-but-unchecked reports verified:false — not the same claim as realized', async () => {
  // Conflating them would make an unchecked write indistinguishable from a checked one:
  // this plan's own failure mode, inside the fix for it.
  const pool = { async query() { throw new Error('boom'); } };
  await withMigrations(['001_a.sql'], async (dir) => {
    const r = await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    assert.equal(r.realized, true);
    assert.equal(r.verified, false, 'nothing was compared, so nothing may be claimed');
  });
});

test('a genuinely checked result reports verified:true', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    const r = await assertSchemaRealized({ pool, migrationsDir: dir, warn: () => {} });
    assert.equal(r.verified, true);
  });
});

test('an unreadable migrations DIRECTORY is unknown, not "no migrations"', async () => {
  // listBundledMigrations returns null (not []) on an I/O failure, so the caller cannot
  // report a realized schema having compared against an empty list.
  const { listBundledMigrations } = await import('../scripts/lib/db/schema-realization.mjs');
  assert.equal(listBundledMigrations('/definitely/not/a/real/dir/xyz'), null);
  assert.equal(listBundledMigrations(null), null);
});

test('a verified result expires — the key cannot see DATABASE-side change', async () => {
  await withMigrations(['001_a.sql'], async (dir) => {
    let t = 1_000_000;
    const pool = stubPool(LEDGER_PRESENT(['001_a.sql']));
    const opts = { pool, migrationsDir: dir, warn: () => {}, now: () => t };

    await assertSchemaRealized(opts);
    const before = pool.queries.length;
    await assertSchemaRealized(opts);
    assert.equal(pool.queries.length, before, 'within the TTL it must not re-query');

    t += REALIZATION_TTL_MS + 1;         // a rolled-back ledger or a restore is now possible
    await assertSchemaRealized(opts);
    assert.ok(pool.queries.length > before, 'past the TTL it must re-verify');
  });
});

// ── checkMigrationRealization — the read-only, fail-OPEN sibling ────────────
//
// Extracted from `ship-commit.mjs` on 2026-09-05. It was private there, so the OTHER
// caller that must not proceed against a behind store — `openai-audit.mjs` — had no way
// to ask, and discovered the block only after a converged multi-round audit had already
// lost its gate evidence and shipped `AI-Gate: not-run`. One oracle, two callers.

/** A repo root carrying a source-layout migrations dir with the given filenames. */
function mkRepoWithMigrations(names) {
  const root = mkTmp('ces-realization-');
  const dir = path.join(root, ...MIGRATION_DIR_BY_LAYOUT.source.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  for (const n of names) fs.writeFileSync(path.join(dir, n), '-- noop\n');
  return { root, dir };
}

test('a definite set difference is the ONLY thing that reports behind', async () => {
  const { root, dir } = mkRepoWithMigrations(['0001_a.sql', '0002_b.sql', '0003_c.sql']);
  try {
    const pool = stubPool(LEDGER_PRESENT(['0001_a.sql']));
    const r = await checkMigrationRealization(root, { getPool: async () => pool });
    assert.equal(r.behind, true);
    assert.deepEqual(r.missing, ['0002_b.sql', '0003_c.sql'], 'filenames, not a count — a count cannot establish identity');
    assert.equal(r.dir, dir, 'the compared directory must be nameable, or the printed --migrate is unfollowable');
    assert.equal(r.command, setupPostgresCommand());
    assert.equal(r.reason, undefined, '`reason` belongs to the behind:false shape only');
  } finally { rmTmp(root); }
});

test('every applied ⇒ realized, and a database AHEAD of the checkout is NOT behind', async () => {
  // The direction this must not fire. A consumer on an older bundle legitimately has
  // ledger rows with no bundled file; reporting that as behind would print a `--migrate`
  // for migrations that do not exist and refuse every audit in that repo.
  const { root } = mkRepoWithMigrations(['0001_a.sql']);
  try {
    const pool = stubPool(LEDGER_PRESENT(['0001_a.sql', '0002_shipped_later.sql']));
    assert.deepEqual(
      await checkMigrationRealization(root, { getPool: async () => pool }),
      { behind: false, reason: 'realized' },
    );
  } finally { rmTmp(root); }
});

test('every uncertainty fails OPEN, and each one says WHICH uncertainty it was', async () => {
  // A gate that fires on an unmeasurable condition gets bypassed, and then it protects
  // nothing. But `reason` must still distinguish "we looked and it was fine" (`realized`)
  // from "we could not look" — collapsing those is the false green this module exists for.
  const { root } = mkRepoWithMigrations(['0001_a.sql']);
  const empty = mkTmp('ces-realization-empty-');
  try {
    assert.deepEqual(
      await checkMigrationRealization(root, { getPool: async () => null }),
      { behind: false, reason: 'cloud-off' },
    );
    assert.deepEqual(
      await checkMigrationRealization(empty, { getPool: async () => stubPool(LEDGER_PRESENT([])) }),
      { behind: false, reason: 'no-migrations-dir' },
    );
    assert.deepEqual(
      await checkMigrationRealization(root, { getPool: async () => stubPool(() => ({ rows: [{ t: null }] })) }),
      { behind: false, reason: 'no-ledger' },
      'a pre-ledger database is --adopt territory, not a block',
    );
    assert.deepEqual(
      await checkMigrationRealization(root, { getPool: async () => { throw new Error('ECONNREFUSED'); } }),
      { behind: false, reason: 'unmeasurable' },
    );
  } finally { rmTmp(root); rmTmp(empty); }
});

test('WIRING PIN: both callers reach the SHARED oracle, neither re-derives it', async () => {
  // ship-commit had the only implementation, and it was private — which is why
  // openai-audit, the caller whose provenance the answer decides, spent a whole audit
  // before learning it. A second copy would let ship time and audit time disagree about
  // what "realized" means, and it is the AUDIT that pays for the disagreement.
  const read = (rel) => fs.readFileSync(path.join(import.meta.dirname, '..', rel), 'utf-8');
  const shipCommit = read('scripts/ship-commit.mjs');
  const precondition = read('scripts/lib/audit/schema-precondition.mjs');
  const audit = read('scripts/openai-audit.mjs');

  for (const [label, src] of [['ship-commit', shipCommit], ['schema-precondition', precondition]]) {
    assert.match(src, /checkMigrationRealization\b/, `${label} must consult the oracle`);
    assert.match(src, /schema-realization\.mjs/, `${label} must import it, not restate it`);
  }
  // The audit reaches it one hop away, through the module that owns the refusal prose.
  assert.match(audit, /assertStoreSchemaRealized\b/, 'openai-audit must run the precondition');
  assert.match(audit, /schema-precondition\.mjs/, 'openai-audit must import the precondition module');

  for (const [label, src] of [['ship-commit', shipCommit], ['openai-audit', audit]]) {
    assert.ok(
      !/async function checkMigrationRealization/.test(src),
      `${label} must not carry a private second implementation`,
    );
  }
});
