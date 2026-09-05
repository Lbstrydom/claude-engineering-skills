/**
 * @fileoverview Tier-1 pins for the pre-spend schema-realization refusal.
 *
 * The defect (measured 2026-09-05, this repo): a store one migration behind the working
 * tree rejects the `audit_runs` INSERT, so `recordRunStart` returns null, no gate-evidence
 * marker is written, and the commit reads `AI-Gate: not-run` — indistinguishable from an
 * audit nobody ran. Two multi-round audits converged at `PASS`, exited 0, and lost their
 * provenance that way. The decision is split out of `openai-audit.mjs`'s `main()`
 * precisely so it can be asserted here without spawning a process and without a store.
 *
 * The branch that matters most is the one that must NOT fire: every fail-open answer
 * (`cloud-off`, `no-ledger`, `unmeasurable`, …) arrives as `behind:false`, and refusing on
 * any of them would block every offline audit — the cried-wolf shape that earns a bypass.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  decideSchemaPrecondition, describeSchemaBehind, assertStoreSchemaRealized,
  SCHEMA_BEHIND_OVERRIDE_ENV,
} from '../scripts/lib/audit/schema-precondition.mjs';

const BEHIND = {
  behind: true,
  missing: ['20260905120000_a.sql', '20260906120000_b.sql'],
  dir: '/repo/supabase/migrations',
  db: '192.168.1.176/audit_loop',
  command: 'node scripts/setup-postgres.mjs --migrate',
};

describe('decideSchemaPrecondition — refusing before the first LLM call', () => {
  test('a definite set difference REFUSES, and the message is actionable on its own', () => {
    const d = decideSchemaPrecondition({ realization: BEHIND, override: false });
    assert.equal(d.proceed, false);
    assert.equal(d.reason, 'schema-behind');
    assert.match(d.message, /AI-Gate: not-run/, 'name the trailer the operator would otherwise get');
    assert.match(d.message, /node scripts\/setup-postgres\.mjs --migrate/, 'quote the remedy verbatim');
    assert.match(d.message, /192\.168\.1\.176\/audit_loop/, 'name WHICH database — a printed --migrate applies DDL');
    assert.match(d.message, /supabase\/migrations/, 'and WHICH directory it was compared against');
    assert.match(d.message, new RegExp(SCHEMA_BEHIND_OVERRIDE_ENV), 'a blocking gate must name its own escape hatch');
    assert.ok(d.message.endsWith('\n'));
  });

  test('the override PROCEEDS but still states what the choice costs', () => {
    const d = decideSchemaPrecondition({ realization: BEHIND, override: true });
    assert.equal(d.proceed, true);
    assert.equal(d.reason, 'override', 'an overridden run must not be reported as a clean one');
    assert.match(d.message, /WARNING/);
    assert.match(d.message, /AI-Gate: not-run/, 'proceeding is a choice, not an absolution');
  });

  // ── The direction this must NOT fire ────────────────────────────────────
  test('every fail-open answer PROCEEDS silently — and keeps its own reason', () => {
    // Fail-open is the oracle's contract, but `realized` and "we could not look" must stay
    // distinguishable: collapsing them is the false green the whole module exists to remove.
    for (const reason of ['cloud-off', 'no-migrations-dir', 'bundle-unreadable', 'no-ledger', 'unmeasurable', 'realized']) {
      const d = decideSchemaPrecondition({ realization: { behind: false, reason }, override: false });
      assert.equal(d.proceed, true, `${reason} must never block an audit`);
      assert.equal(d.message, '', `${reason} must print nothing — a warning on every offline audit is one nobody reads`);
      assert.equal(d.reason, reason, `${reason} must survive to the caller, not be flattened to "realized"`);
    }
  });

  test('a missing/garbled realization proceeds rather than throwing inside main()', () => {
    // This runs before the audit; a crash here would be worse than the bug it prevents.
    assert.equal(decideSchemaPrecondition({ realization: undefined, override: false }).proceed, true);
    assert.equal(decideSchemaPrecondition({ realization: {}, override: true }).proceed, true);
  });
});

describe('describeSchemaBehind — naming both sides of the comparison', () => {
  test('lists filenames, caps the list, and says how many were elided', () => {
    const many = describeSchemaBehind({
      missing: ['a.sql', 'b.sql', 'c.sql', 'd.sql', 'e.sql'], dir: '/d', db: 'h/db',
    });
    assert.match(many, /a\.sql, b\.sql, c\.sql, \+2 more/);
    assert.match(many, /5 migration\(s\)/, 'the count must not be inferable only from the truncated list');
  });

  test('an unnameable database degrades to "the database", never to a bare hostname guess', () => {
    assert.match(describeSchemaBehind({ missing: ['a.sql'], dir: '/d', db: null }), /^the database is behind/);
  });
});

describe('assertStoreSchemaRealized — env + cwd wiring', () => {
  test('the override is read from the EXPORTED name, so the doc and the code cannot drift', async () => {
    const check = async () => BEHIND;
    const on = await assertStoreSchemaRealized({ check, env: { [SCHEMA_BEHIND_OVERRIDE_ENV]: '1' } });
    assert.equal(on.proceed, true);
    const off = await assertStoreSchemaRealized({ check, env: {} });
    assert.equal(off.proceed, false);
    // Only the literal '1' opts out — a truthy-string check would make `=0` an override.
    const zero = await assertStoreSchemaRealized({ check, env: { [SCHEMA_BEHIND_OVERRIDE_ENV]: '0' } });
    assert.equal(zero.proceed, false, 'AUDIT_ALLOW_SCHEMA_BEHIND=0 must NOT disable the gate');
  });

  test('the cwd reaches the oracle — a wrong root resolves no migrations dir and passes vacuously', async () => {
    let seen = null;
    await assertStoreSchemaRealized({
      cwd: '/some/repo', env: {}, check: async (cwd) => { seen = cwd; return { behind: false, reason: 'realized' }; },
    });
    assert.equal(seen, '/some/repo');
  });
});
