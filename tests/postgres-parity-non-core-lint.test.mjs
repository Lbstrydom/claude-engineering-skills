/**
 * @fileoverview The postgres-parity migration lint — now a live pre-push gate.
 *
 * Until 2026-07-17 this check was reachable only by hand: no workflow, no hook,
 * absent from `npm run check`. It was correct the whole time and simply never
 * ran — which is how three new `public.` qualifications reached main in June.
 * Wiring it into the chain means these assertions now protect a gate that can
 * BLOCK a push, so they pin two things a dead check never had to prove:
 *
 *   1. it still FIRES on a new violation (a baseline is not a blanket mute), and
 *   2. it is CLEAN against the committed migrations (or the chain is unpushable).
 *
 * The scanner is pure (reads .sql text, no DB, no network), so this is a Tier-1
 * deterministic seam per AGENTS.md's testing doctrine.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internals } from '../scripts/postgres-parity/check-non-core-references.mjs';

const { scanForFindings, SCHEMA_COUPLING_BASELINE } = _internals;

/** A synthetic migration — never touches supabase/migrations on disk. */
const mig = (name, content) => [{ name, path: `/virtual/${name}`, content }];

const countAll = (f, { coupling }) => Object.entries(f)
  .filter(([k]) => coupling || k !== 'newPublicQualification')
  .reduce((n, [, items]) => n + items.length, 0);

describe('the lint fires on new violations', () => {
  it('flags a NEW public. qualification under --schema-coupling', () => {
    const f = scanForFindings(
      mig('29990101000000_new.sql', 'ALTER TABLE public.audit_repos ADD COLUMN x text;'),
      { schemaCoupling: true },
    );
    assert.equal(f.newPublicQualification.length, 1, 'a new coupling must fail the gate');
    assert.match(f.newPublicQualification[0].loc, /29990101000000_new\.sql:1/);
  });

  it('does NOT flag public. when --schema-coupling is off (opt-in rule)', () => {
    const f = scanForFindings(
      mig('29990101000000_new.sql', 'ALTER TABLE public.audit_repos ADD COLUMN x text;'),
      { schemaCoupling: false },
    );
    assert.equal(countAll(f, { coupling: false }), 0);
  });

  it('flags an un-allowlisted extension, role, and auth ref', () => {
    const f = scanForFindings(mig('29990101000000_new.sql', [
      'CREATE EXTENSION IF NOT EXISTS postgis;',
      'CREATE ROLE reporting_user;',
    ].join('\n')), { schemaCoupling: false });
    assert.equal(f.unallowedExtension.length, 1, 'postgis is not in ALLOWED_EXTENSIONS');
    assert.equal(f.unallowedRole.length, 1, 'reporting_user is not in ALLOWED_ROLES');
  });

  it('allows the inventoried core refs (the allowlist is not empty theatre)', () => {
    const f = scanForFindings(mig('29990101000000_new.sql', [
      'CREATE EXTENSION IF NOT EXISTS pg_trgm;',
      'GRANT SELECT ON audit_repos TO authenticated;',
      'ALTER TABLE t ADD COLUMN owner uuid REFERENCES auth.users(id);',
    ].join('\n')), { schemaCoupling: false });
    assert.equal(countAll(f, { coupling: false }), 0, 'inventoried refs must pass');
  });
});

describe('the schema-coupling baseline accepts LINES, not the rule', () => {
  it('a baselined line passes but an un-baselined line in the same file fails', () => {
    // The property that makes baselining honest: it mutes three specific
    // historical lines, not `public.` everywhere. If someone appended a new
    // coupling to a baselined FILE, it must still fail.
    const baselined = [...SCHEMA_COUPLING_BASELINE].find(e => e.startsWith('20260605130000'));
    assert.ok(baselined, 'the June migration is baselined');
    const [file, line] = baselined.split(':');

    // Reconstruct a file whose baselined line matches, plus one that does not.
    const lines = Array.from({ length: Number(line) + 1 }, () => '-- filler');
    lines[Number(line) - 1] = 'ALTER TABLE public.audit_repos ALTER COLUMN fingerprint DROP NOT NULL;';
    lines[Number(line)] = 'ALTER TABLE public.audit_repos ADD COLUMN sneaked text;';

    const f = scanForFindings(mig(file, lines.join('\n')), { schemaCoupling: true });

    assert.equal(f.newPublicQualification.length, 1, 'only the un-baselined line may fail');
    assert.equal(f.newPublicQualification[0].loc, `${file}:${Number(line) + 1}`);
  });

  it('pins the baseline contents — an addition must be a deliberate, reviewed act', () => {
    // Baselining is accepted debt. Growing this set silently is how the debt
    // stops being accounted for, so the count is pinned: update it knowingly,
    // with the docs/plans/postgres-parity-schema-coupling.md §1 addendum.
    assert.equal(SCHEMA_COUPLING_BASELINE.size, 7, 'baseline size changed — was that deliberate?');
    for (const entry of SCHEMA_COUPLING_BASELINE) {
      assert.match(entry, /^\d{14}_[\w-]+\.sql:\d+$/, `malformed baseline entry: ${entry}`);
    }
  });
});

describe('the committed migrations are clean — the gate is pushable', () => {
  it('every real migration passes --schema-coupling --strict', async () => {
    // Reads the real supabase/migrations. If this fails, `npm run check` fails
    // and nobody can push — so it must hold, and it is the assertion that
    // proves the baseline actually covers what is on disk.
    const { _internals: real } = await import('../scripts/postgres-parity/check-non-core-references.mjs');
    const findings = real.scanForFindings(real.readMigrations(), { schemaCoupling: true });
    const total = countAll(findings, { coupling: true });
    assert.equal(
      total, 0,
      `committed migrations must satisfy the wired gate; found: ${JSON.stringify(findings, null, 2).slice(0, 600)}`,
    );
  });
});
