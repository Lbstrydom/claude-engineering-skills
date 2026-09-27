/**
 * @fileoverview `setup-postgres.mjs --check-drift --live` — the live key
 * constraint/index check (lib/db/constraint-drift.mjs).
 *
 * The incident: a consumer store lost `bandit_arms_unique` out-of-band, every
 * audit logged a 42P10 lost write, and `--check-drift` read clean because it
 * compares only the migrations LEDGER. These tests pin both directions:
 * a missing expected object is reported with its repair SQL, and an extra
 * consumer-owned object is NOT an error. Fixtures are sliced from the committed
 * `tests/fixtures/expected-schema.json` — the same manifest the CLI reads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import {
  assessConstraintDrift, checkLiveConstraints, renderConstraintDrift, quoteIdent,
  LIVE_CONSTRAINT_CATEGORIES, vacuousInventoryReason,
} from '../scripts/lib/db/constraint-drift.mjs';
import { SHARED_CATALOG_QUERIES } from '../scripts/lib/db/live-catalog.mjs';
import { _internals } from '../scripts/setup-postgres.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'expected-schema.json');
const EXPECTED = JSON.parse(fs.readFileSync(FIXTURE, 'utf-8'));

const clone = (v) => JSON.parse(JSON.stringify(v));
const liveFrom = (catalog) => ({ schema: 'public', constraints: clone(catalog.constraints), indexes: clone(catalog.indexes) });
const withoutBanditUnique = (catalog) => {
  const live = liveFrom(catalog);
  live.constraints = live.constraints.filter((r) => r.constraint_name !== 'bandit_arms_unique');
  live.indexes = live.indexes.filter((r) => r.indexname !== 'bandit_arms_unique');
  return live;
};

describe('assessConstraintDrift — the fixture itself carries the incident object', () => {
  it('positive control: bandit_arms_unique is in the committed manifest', () => {
    // Without this the "missing" test below could pass against a manifest that
    // never declared the constraint, having checked nothing.
    assert.ok(EXPECTED.constraints.some((r) => r.constraint_name === 'bandit_arms_unique' && r.constraint_type === 'UNIQUE'));
  });
});

describe('assessConstraintDrift — classification', () => {
  it('negative control: an identical live catalog is clean', () => {
    const r = assessConstraintDrift(EXPECTED, liveFrom(EXPECTED));
    assert.equal(r.measured, true);
    assert.equal(r.hasDrift, false);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.altered, []);
    assert.deepEqual(r.extra, []);
    assert.deepEqual(r.repairs, []);
  });

  it('reproduces the incident: a dropped UNIQUE constraint is MISSING, with the exact repair SQL', () => {
    const r = assessConstraintDrift(EXPECTED, withoutBanditUnique(EXPECTED));
    assert.equal(r.hasDrift, true);
    const c = r.missing.find((f) => f.category === 'constraints');
    assert.equal(c.name, 'bandit_arms_unique');
    assert.equal(c.table, 'bandit_arms');
    assert.equal(c.repair,
      'ALTER TABLE public.bandit_arms ADD CONSTRAINT bandit_arms_unique UNIQUE (pass_name, variant_id, context_bucket);');
    // The backing index is reported but NOT given its own repair: restoring the
    // constraint recreates it, and a second CREATE INDEX would fail.
    const i = r.missing.find((f) => f.category === 'indexes');
    assert.equal(i.name, 'bandit_arms_unique');
    assert.equal(i.repair, null);
    assert.equal(i.restoredBy, 'constraint');
    assert.deepEqual(r.repairs, [c.repair]);
  });

  it('an extra consumer-owned constraint/index is NOT an error', () => {
    const live = liveFrom(EXPECTED);
    live.constraints.push({ table_name: 'consumer_things', constraint_name: 'consumer_things_uq', constraint_type: 'UNIQUE', definition: 'UNIQUE (a)' });
    live.indexes.push({ tablename: 'consumer_things', indexname: 'consumer_things_uq', indexdef: 'CREATE UNIQUE INDEX consumer_things_uq ON public.consumer_things USING btree (a)' });
    const r = assessConstraintDrift(EXPECTED, live);
    assert.equal(r.hasDrift, false);
    assert.equal(r.extra.length, 2);
    assert.deepEqual(r.repairs, []);
  });

  it('an out-of-band REPLACEMENT (same name, wider columns) is ALTERED, with drop+add in ONE transaction', () => {
    const live = liveFrom(EXPECTED);
    const row = live.constraints.find((c) => c.constraint_name === 'bandit_arms_unique');
    row.definition = 'UNIQUE (pass_name, variant_id, context_bucket, user_id)';
    const r = assessConstraintDrift(EXPECTED, live);
    assert.equal(r.hasDrift, true);
    assert.equal(r.missing.length, 0);
    assert.equal(r.altered.length, 1);
    // Wrapped: a recreate that fails (e.g. duplicate rows under the UNIQUE)
    // must roll the DROP back, never leave the original constraint gone.
    assert.equal(r.altered[0].repair,
      'BEGIN; ALTER TABLE public.bandit_arms DROP CONSTRAINT bandit_arms_unique; '
      + 'ALTER TABLE public.bandit_arms ADD CONSTRAINT bandit_arms_unique UNIQUE (pass_name, variant_id, context_bucket); COMMIT;');
    assert.match(r.altered[0].live, /user_id/);
  });

  it('an ALTERED plain index gets DROP + CREATE in ONE transaction', () => {
    const live = liveFrom(EXPECTED);
    const row = live.indexes.find((i) => i.indexname === 'idx_bandit_arms_pass');
    row.indexdef = 'CREATE INDEX idx_bandit_arms_pass ON public.bandit_arms USING btree (pass_name)';
    const r = assessConstraintDrift(EXPECTED, live);
    assert.deepEqual(r.repairs, ['BEGIN; DROP INDEX public.idx_bandit_arms_pass; '
      + 'CREATE INDEX idx_bandit_arms_pass ON public.bandit_arms USING btree (pass_name, user_id); COMMIT;']);
  });

  it('negative control: a MISSING object repair is a bare ADD/CREATE — no DROP, no transaction wrapper', () => {
    const live = withoutBanditUnique(EXPECTED);
    live.indexes = live.indexes.filter((r) => r.indexname !== 'idx_bandit_arms_pass');
    const r = assessConstraintDrift(EXPECTED, live);
    assert.equal(r.repairs.length, 2, 'vacuous-pass guard: one constraint + one index repair to inspect');
    for (const sql of r.repairs) {
      assert.doesNotMatch(sql, /\bDROP\b/);
      assert.doesNotMatch(sql, /\bBEGIN\b|\bCOMMIT\b/);
    }
  });

  it('a missing plain index gets its CREATE INDEX from the expected indexdef', () => {
    const live = liveFrom(EXPECTED);
    live.indexes = live.indexes.filter((r) => r.indexname !== 'idx_bandit_arms_pass');
    const r = assessConstraintDrift(EXPECTED, live);
    assert.deepEqual(r.repairs, ['CREATE INDEX idx_bandit_arms_pass ON public.bandit_arms USING btree (pass_name, user_id);']);
  });

  it('FOREIGN KEY / CHECK differences are out of scope (hosted vs self-hosted differ legitimately)', () => {
    const live = liveFrom(EXPECTED);
    live.constraints = live.constraints.filter((r) => r.constraint_type !== 'FOREIGN KEY' && r.constraint_type !== 'CHECK');
    assert.equal(assessConstraintDrift(EXPECTED, live).hasDrift, false);
  });

  it('classifies EVERY missing row, not the first five diffSchemas samples', () => {
    const live = liveFrom(EXPECTED);
    live.indexes = [];
    const r = assessConstraintDrift(EXPECTED, live);
    assert.equal(r.missing.filter((f) => f.category === 'indexes').length, EXPECTED.indexes.length);
  });

  it('quoteIdent quotes only names that need it', () => {
    assert.equal(quoteIdent('bandit_arms'), 'bandit_arms');
    assert.equal(quoteIdent('Weird"Name'), '"Weird""Name"');
  });
});

describe('assessConstraintDrift — a VACUOUS expected inventory is UNMEASURED, never clean', () => {
  const vacuousCases = {
    'empty constraints and indexes': { constraints: [], indexes: [] },
    'empty constraints only': { constraints: [], indexes: clone(EXPECTED.indexes) },
    'empty indexes only': { constraints: clone(EXPECTED.constraints), indexes: [] },
    'constraints present but none PRIMARY KEY/UNIQUE': {
      constraints: EXPECTED.constraints.filter((r) => r.constraint_type === 'FOREIGN KEY'),
      indexes: clone(EXPECTED.indexes),
    },
    'sections absent': {},
  };
  for (const [label, manifest] of Object.entries(vacuousCases)) {
    it(`${label} → measured:false with a reason, not a clean pass`, () => {
      // Every live object would otherwise land in `extra` (never a failure)
      // and the check would read clean having compared nothing.
      const r = assessConstraintDrift({ schema: 'public', ...manifest }, liveFrom(EXPECTED));
      assert.equal(r.measured, false);
      assert.equal(r.hasDrift, false);
      assert.match(r.reason, /vacuous inventory/);
      assert.match(renderConstraintDrift(r).join('\n'), /NOT MEASURED.*not a clean result/);
    });
  }

  it('negative control: the real manifest is NOT vacuous', () => {
    assert.equal(vacuousInventoryReason(EXPECTED), null);
    assert.equal(assessConstraintDrift(EXPECTED, liveFrom(EXPECTED)).measured, true);
  });

  it('checkLiveConstraints refuses a vacuous manifest before touching the pool', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuous-manifest-'));
    const file = path.join(dir, 'expected-schema.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'public', constraints: [], indexes: [] }));
    let captured = false;
    const r = await checkLiveConstraints({
      pool: {}, expectedSchemaPath: file, fs,
      capture: async () => { captured = true; return liveFrom(EXPECTED); },
    });
    assert.equal(r.measured, false);
    assert.equal(captured, false);
  });

  it('runCheckDrift --live with a vacuous manifest → exit 4, same path as an absent one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vacuous-manifest-'));
    const file = path.join(dir, 'expected-schema.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 'public', constraints: [], indexes: [] }));
    const r = await _internals.runCheckDrift(stubPool(), {
      format: 'json', migrationsDir: emptyMigrationsDir(), stdout: sink(), stderr: sink(),
      live: true, expectedSchemaPath: file, capture: async () => liveFrom(EXPECTED),
    });
    assert.equal(r.exitCode, 4);
    assert.equal(r.liveConstraints.measured, false);
  });
});

describe('SHARED_CATALOG_QUERIES.constraints — joins on TABLE identity, not name alone', () => {
  // A constraint name is unique per table, not per schema (two tables may each
  // own a CHECK named `valid_status`); a name+schema join cross-multiplies them.
  // The behavioural proof needs a real Postgres; this pins the join shape so it
  // cannot silently regress to name-only.
  const sql = SHARED_CATALOG_QUERIES.constraints.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ');
  it('joins pg_constraint.conrelid to the table table_constraints names', () => {
    assert.match(sql, /JOIN pg_class rel ON rel\.oid = c\.conrelid AND rel\.relname = tc\.table_name/);
  });
  it('negative control: the name + schema join is still present (the table join adds to it)', () => {
    assert.match(sql, /JOIN pg_constraint c ON c\.conname = tc\.constraint_name/);
    assert.match(sql, /n\.nspname = tc\.constraint_schema/);
  });
});

describe('checkLiveConstraints — an absent manifest is UNMEASURED, never clean', () => {
  it('reports measured:false with the reason and never touches the pool', async () => {
    let captured = false;
    const r = await checkLiveConstraints({
      pool: {}, expectedSchemaPath: path.join(os.tmpdir(), 'no-such-expected-schema.json'),
      capture: async () => { captured = true; return {}; }, fs,
    });
    assert.equal(r.measured, false);
    assert.equal(r.hasDrift, false);
    assert.match(r.reason, /not found/);
    assert.equal(captured, false);
    assert.match(renderConstraintDrift(r).join('\n'), /NOT MEASURED.*not a clean result/);
  });

  it('asks the capture for constraints + indexes only', async () => {
    let only;
    await checkLiveConstraints({
      pool: {}, expectedSchemaPath: FIXTURE, fs,
      capture: async (_p, opts) => { only = opts.only; return liveFrom(EXPECTED); },
    });
    assert.deepEqual([...only], [...LIVE_CONSTRAINT_CATEGORIES]);
  });
});

// ── CLI wiring: runCheckDrift with live:true, stubbed pool + capture ──────────

function stubPool() {
  return {
    async query(text) {
      if (text.includes(`to_regclass('public.audit_loop_migrations')`)) return { rows: [{ t: 'audit_loop_migrations' }] };
      if (text.includes('SELECT filename, sha256 FROM audit_loop_migrations')) return { rows: [] };
      throw new Error(`stubPool: unexpected query: ${text.slice(0, 80)}`);
    },
  };
}
function sink() {
  const chunks = [];
  const s = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });
  s.text = () => chunks.join('');
  return s;
}
const emptyMigrationsDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'live-drift-'));

describe('runCheckDrift --live — exit codes and envelope', () => {
  const { runCheckDrift, parseArgs } = _internals;

  it('clean ledger + missing constraint → exit 1, liveConstraints in the JSON envelope', async () => {
    const stdout = sink();
    const r = await runCheckDrift(stubPool(), {
      format: 'json', migrationsDir: emptyMigrationsDir(), stdout, stderr: sink(),
      live: true, expectedSchemaPath: FIXTURE, capture: async () => withoutBanditUnique(EXPECTED),
    });
    assert.equal(r.exitCode, 1);
    const doc = JSON.parse(stdout.text());
    assert.equal(doc.hasDrift, true);
    assert.equal(doc.drift.unapplied.length, 0, 'the ledger half is clean — the live half is what found it');
    assert.ok(doc.liveConstraints.repairs.some((s) => s.includes('bandit_arms_unique')));
  });

  it('clean ledger + clean live → exit 0; human report says the ledger is clean', async () => {
    const stderr = sink();
    const r = await runCheckDrift(stubPool(), {
      format: 'human', migrationsDir: emptyMigrationsDir(), stdout: sink(), stderr,
      live: true, expectedSchemaPath: FIXTURE, capture: async () => liveFrom(EXPECTED),
    });
    assert.equal(r.exitCode, 0);
    assert.match(stderr.text(), /no drift/);
    assert.match(stderr.text(), /Live constraint\/index check/);
  });

  it('--live without a manifest → exit 4 (unmeasured), not 0', async () => {
    const r = await runCheckDrift(stubPool(), {
      format: 'json', migrationsDir: emptyMigrationsDir(), stdout: sink(), stderr: sink(),
      live: true, expectedSchemaPath: path.join(os.tmpdir(), 'absent-expected.json'),
      capture: async () => { throw new Error('must not capture'); },
    });
    assert.equal(r.exitCode, 4);
    assert.equal(r.liveConstraints.measured, false);
  });

  it('without --live the envelope is unchanged (no liveConstraints key)', async () => {
    const r = await runCheckDrift(stubPool(), {
      format: 'json', migrationsDir: emptyMigrationsDir(), stdout: sink(), stderr: sink(),
      capture: async () => { throw new Error('must not capture'); },
    });
    assert.equal(r.exitCode, 0);
    assert.equal('liveConstraints' in r, false);
  });

  it('parseArgs accepts --live with --check-drift', () => {
    assert.equal(parseArgs(['--check-drift', '--live']).live, true);
    assert.equal(parseArgs(['--check-drift']).live, false);
  });
});
