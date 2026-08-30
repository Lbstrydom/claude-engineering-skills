/**
 * @fileoverview `--migrate` on a MANAGED Postgres, where the runtime role owns
 * nothing it does not need to.
 *
 * **The incident (2026-08-30).** A consumer's Azure store drifted 2 migrations
 * behind and nobody could apply them, because `setup-postgres --migrate` failed
 * before it reached a single migration. Three separate checks, all the same
 * mistake: each asked whether it COULD create something, never whether the
 * something already EXISTED.
 *
 *   1. preflight demanded CREATEROLE — with all three stub roles already present.
 *   2. `CREATE EXTENSION IF NOT EXISTS vector` in the compat bootstrap — 42501
 *      on Azure even though the extension IS installed, because the platform's
 *      allowlist hook fires ahead of the IF-NOT-EXISTS short-circuit.
 *   3. `CREATE TABLE IF NOT EXISTS audit_loop_migrations` — 42501 permission
 *      denied for schema public, on a database whose ledger had 131 rows in it.
 *
 * Plus a fourth, one layer up: the surface precondition demanded `auth.users`,
 * an object the migrations themselves drop once the early ones have run — so a
 * healthy long-lived store failed a check on the consequences of its own history.
 *
 * **The rule these pin: `IF NOT EXISTS` states an intent, it does not implement
 * one.** For several object types Postgres evaluates the privilege check before
 * the existence short-circuit, so the clause is not a substitute for probing.
 * Probe the state; act only on what is missing.
 *
 * The direction that matters most here is the one that must STILL fail: a
 * genuinely missing role on a genuinely unprivileged connection has to be
 * refused, or this "fix" becomes a late, partial failure halfway through a
 * migration run.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  STUB_ROLES, preflight, reportPreflight, pendingMigrationsNeedSurface,
} from '../scripts/setup-postgres.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/** A pool stand-in that answers the two preflight probes from a fixture. */
function fakePool({ createRole, superuser = false, roles, extensions }) {
  return {
    async query(sql, params) {
      if (/rolcreaterole/.test(sql)) {
        return { rows: [{ rolcreaterole: createRole, rolsuper: superuser }] };
      }
      if (/rolname = ANY/.test(sql)) {
        return { rows: roles.map((rolname) => ({ rolname })) };
      }
      if (/pg_extension/.test(sql)) {
        return { rows: extensions[params[0]] === 'present' ? [{ x: 1 }] : [] };
      }
      if (/pg_available_extensions/.test(sql)) {
        return { rows: extensions[params[0]] === 'missing' ? [] : [{ x: 1 }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
}

const ALL_PRESENT = { pgcrypto: 'present', pg_trgm: 'present', vector: 'present' };

describe('preflight — CREATEROLE is demanded only for roles that are MISSING', () => {
  it('the measured incident: no CREATEROLE, all stub roles present → PASSES strict', async () => {
    const p = await preflight(fakePool({ createRole: false, roles: [...STUB_ROLES], extensions: ALL_PRESENT }));
    assert.deepEqual(p.missingRoles, [], 'nothing is missing, so nothing needs creating');
    assert.equal(p.canCreateRole, false);
    assert.equal(reportPreflight(p, { strict: true }), true,
      'a managed store with every role already created must not be refused');
  });

  it('THE DIRECTION THAT MUST STILL FAIL: a missing role with no CREATEROLE is refused', async () => {
    // Without this, the fix would convert an immediate, named refusal into a
    // late partial failure part-way through the migration set — strictly worse
    // than the bug it replaces.
    const p = await preflight(fakePool({ createRole: false, roles: ['anon'], extensions: ALL_PRESENT }));
    assert.deepEqual(p.missingRoles, ['authenticated', 'service_role']);
    assert.equal(reportPreflight(p, { strict: true }), false);
  });

  it('a missing role WITH CREATEROLE passes — it can create what is absent', async () => {
    const p = await preflight(fakePool({ createRole: true, roles: [], extensions: ALL_PRESENT }));
    assert.deepEqual(p.missingRoles, [...STUB_ROLES]);
    assert.equal(reportPreflight(p, { strict: true }), true);
  });

  it('a genuinely uninstallable extension still fails, independently of roles', async () => {
    const p = await preflight(fakePool({
      createRole: true, roles: [...STUB_ROLES],
      extensions: { pgcrypto: 'present', pg_trgm: 'present', vector: 'missing' },
    }));
    assert.equal(reportPreflight(p, { strict: true }), false);
  });

  it('non-strict mode never refuses, whatever the state', async () => {
    const p = await preflight(fakePool({ createRole: false, roles: [], extensions: { pgcrypto: 'missing', pg_trgm: 'missing', vector: 'missing' } }));
    assert.equal(reportPreflight(p, { strict: false }), true);
  });
});

describe('compat-bootstrap — role creation is guarded on EXISTENCE, not on an exception', () => {
  const sql = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'db', 'compat-bootstrap.sql'), 'utf-8');

  for (const role of ['anon', 'authenticated', 'service_role']) {
    it(`${role} is created only when absent`, () => {
      const re = new RegExp(
        `IF NOT EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${role}'\\) THEN\\s*\\r?\\n\\s*CREATE ROLE ${role} NOLOGIN;`,
      );
      assert.match(sql, re,
        `CREATE ROLE ${role} must sit behind an existence check — Postgres raises `
        + 'insufficient_privilege (42501) BEFORE duplicate_object, so the EXCEPTION handler '
        + 'never catches the case this is written for');
    });
  }

  it('the duplicate_object handler is KEPT — it still covers the create/check race', () => {
    // Counted over EXECUTABLE lines only. The first cut matched the phrase in
    // this file's own explanatory comment and reported 4 — a check reading its
    // own prose as evidence about the code, which is the documentation-shaped
    // version of a vacuous pass.
    const handlers = sql
      .split(/\r?\n/)
      .filter((l) => !l.trim().startsWith('--'))
      .filter((l) => /EXCEPTION WHEN duplicate_object THEN/.test(l));
    assert.equal(handlers.length, 3, 'one per stub role');
  });
});

describe('ensureLedger — probes before it creates', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'setup-postgres.mjs'), 'utf-8');
  const body = src.slice(src.indexOf('async function ensureLedger'), src.indexOf('async function readLedger'));

  it('checks to_regclass before running the DDL', () => {
    assert.match(body, /to_regclass\('public\.audit_loop_migrations'\)/);
    assert.match(body, /if \(!exists\.rows\[0\]\?\.t\)/,
      'CREATE TABLE IF NOT EXISTS still needs CREATE on the schema — probe first');
  });

  it('enables RLS only when it is not already on', () => {
    assert.match(body, /relrowsecurity/,
      'a no-op ALTER TABLE is still an ownership check on a managed store');
  });
});

describe('pendingMigrationsNeedSurface — the precondition follows what is PENDING', () => {
  it('two schema-only migrations need no auth surface', async () => {
    // The exact pair the consumer's store was missing: two ALTER TABLEs that
    // reference neither auth.users, auth.uid(), a stub role, nor an extension.
    const needed = await pendingMigrationsNeedSurface([
      '20260830140000_remediation_verification_tracking.sql',
      '20260830160000_upstream_issue_annotation_event.sql',
    ]);
    assert.equal(needed, false,
      'demanding auth.users here is demanding an object the migrations themselves dropped');
  });

  it('an empty pending set needs nothing', async () => {
    assert.equal(await pendingMigrationsNeedSurface([]), false);
  });

  it('FAILS TOWARD STRICT: a migration touching the auth surface still requires it', async () => {
    // The historical early migrations are the reason the precondition exists at
    // all. If this ever stops firing, a fresh database goes back to failing
    // part-way through with a ledger that disagrees with the schema.
    const all = fs.readdirSync(path.join(REPO_ROOT, 'supabase', 'migrations')).filter((f) => f.endsWith('.sql'));
    const authy = all.filter((f) => /auth\.(users|uid)/i.test(
      fs.readFileSync(path.join(REPO_ROOT, 'supabase', 'migrations', f), 'utf-8'),
    ));
    assert.ok(authy.length > 0, 'precondition: this repo really does have auth-referencing migrations');
    assert.equal(await pendingMigrationsNeedSurface([authy[0]]), true);
  });
});
