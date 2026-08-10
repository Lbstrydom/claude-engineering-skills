/**
 * @fileoverview Provider-neutral connection diagnostics.
 *
 * THE DEFECT THESE LOCK. The audit store has been provider-neutral since the M4
 * postgres-parity migration — one `AUDIT_DB_URL` through `pg`, any Postgres 13+,
 * with the sole vendor branch being a narrow refusal of the Supabase transaction
 * pooler. But `initLearningStore`'s probe reported EVERY failure as
 * `[learning] Supabase connection failed`, so a consumer whose plain local
 * Postgres was simply not running read that, concluded the runtime was
 * Supabase-coupled, and wrote an eight-section proposal to make it vendor-neutral.
 *
 * The architecture needed nothing. One string did. What it genuinely lacked was
 * the ability to say WHICH database it meant and WHY the connection failed —
 * which is what turns "point it at any Postgres you like" from a claim into
 * something a user can actually act on when it doesn't work first time.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dbIdentity, classifyDbConnectionError } from '../scripts/lib/db/client.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('dbIdentity — names the database without leaking the password', () => {
  it('renders host:port/database', () => {
    assert.equal(
      dbIdentity('postgresql://audit:hunter2@db.example.com:5433/audit_loop'),
      'db.example.com:5433/audit_loop');
  });

  it('NEVER includes credentials, for any userinfo shape', () => {
    // The whole reason this renderer is used for operator output rather than a
    // regex-masked DSN: it reads three fields and never touches userinfo, so
    // there is no mask to get wrong. A password containing `@` or `:` — which
    // is exactly what defeats a naive mask — cannot survive it.
    for (const dsn of [
      'postgresql://audit:hunter2@localhost:5432/audit_loop',
      'postgresql://audit:p%40ss%3Aword@localhost:5432/audit_loop',
      'postgresql://audit@localhost:5432/audit_loop',
      'postgresql://audit:@localhost:5432/audit_loop',
    ]) {
      const out = dbIdentity(dsn);
      assert.ok(out, `should parse: ${dsn}`);
      for (const secret of ['hunter2', 'p@ss:word', 'p%40ss', 'audit:']) {
        assert.ok(!out.includes(secret), `leaked "${secret}" from ${dsn} → ${out}`);
      }
    }
  });

  it('defaults the port and canonicalises loopback, so one server reads as one name', () => {
    assert.equal(dbIdentity('postgresql://u:p@localhost/audit_loop'), 'localhost:5432/audit_loop');
    assert.equal(dbIdentity('postgresql://u:p@127.0.0.1:5432/audit_loop'), 'localhost:5432/audit_loop');
  });

  it('returns null rather than throwing on an unparseable DSN', () => {
    // The caller substitutes a generic phrase. A diagnostic path must never be
    // the thing that crashes — it only ever runs when something is already wrong.
    assert.equal(dbIdentity('not a dsn'), null);
    assert.equal(dbIdentity(''), null);
  });
});

describe('classifyDbConnectionError — the three new-provider onboarding failures', () => {
  const cases = [
    // Wrong host / nothing running. The consumer's actual situation: Docker
    // was stopped, so nothing answered on the configured port.
    ['ECONNREFUSED', {}, 'unreachable', /start the server/i],
    ['ENOTFOUND', {}, 'unreachable', /correct AUDIT_DB_URL/],
    ['ETIMEDOUT', {}, 'unreachable', /listening/],
    // TLS — the most common failure when SWITCHING providers, because the
    // default mode is strict `require` and both a managed pooler's internal CA
    // and a self-signed self-hosted cert fail it.
    ['SELF_SIGNED_CERT_IN_CHAIN', {}, 'tls-rejected', /AUDIT_DB_SSL_MODE/],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', {}, 'tls-rejected', /no-verify/],
    [undefined, { message: 'self-signed certificate in certificate chain' }, 'tls-rejected', /AUDIT_DB_SSL_MODE/],
    // Credentials.
    ['28P01', {}, 'auth-failed', /credentials/],
    ['28000', {}, 'auth-failed', /credentials/],
    // Right server, wrong/absent database or schema — the bootstrap step.
    ['3D000', {}, 'database-missing', /--migrate/],
    ['42P01', {}, 'schema-missing', /--migrate/],
  ];

  for (const [code, extra, expectedCause, hintRe] of cases) {
    it(`${code ?? 'message-only'} → ${expectedCause}`, () => {
      const { cause, hint } = classifyDbConnectionError({ code, ...extra });
      assert.equal(cause, expectedCause);
      assert.match(hint, hintRe);
    });
  }

  it('42P01 and 3D000 are NOT reported as unreachable — the DSN is right', () => {
    // The distinction that matters most for onboarding: "your address is wrong"
    // and "your address is right, you just haven't run --migrate" have opposite
    // remedies, and collapsing them sends the user to rewrite a correct DSN.
    for (const code of ['42P01', '3D000']) {
      assert.notEqual(classifyDbConnectionError({ code }).cause, 'unreachable');
      assert.match(classifyDbConnectionError({ code }).hint, /migrate/);
    }
  });

  it('an unknown error degrades to the code plus a pointer, never a wrong remedy', () => {
    const { cause, hint } = classifyDbConnectionError({ code: '57P03', message: 'starting up' });
    assert.equal(cause, '57P03');
    assert.match(hint, /postgres-parity/);
    // Guessing a remedy for an unrecognised failure is worse than admitting it:
    // the reader follows confident wrong advice instead of reading the error.
    assert.ok(!/AUDIT_DB_SSL_MODE|--migrate|credentials/.test(hint));
  });

  it('never throws on a malformed error object', () => {
    for (const bad of [null, undefined, {}, { code: 42 }, 'a string']) {
      assert.doesNotThrow(() => classifyDbConnectionError(bad));
    }
  });
});

describe('no user-facing path calls a generic Postgres endpoint "Supabase"', () => {
  // The regression guard for the actual report. Scoped to lines that REACH A
  // USER (stderr/stdout writes), because historical migration commentary
  // legitimately names the vendor and blanket-banning the word would either
  // fail forever or push people to delete accurate history.
  const files = ['scripts/lib/store/repo.mjs', 'scripts/check-rls.mjs'];

  for (const rel of files) {
    it(`${rel} does not name a vendor as the SUBJECT of a store failure`, () => {
      const src = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf-8');
      const emitted = src.split('\n').filter((l) => /process\.(stderr|stdout)\.write|console\./.test(l));
      assert.ok(emitted.length > 0, `no emitting lines found in ${rel} — this scan would pass vacuously`);
      for (const line of emitted) {
        assert.ok(!/Supabase (connection|store|database) /i.test(line),
          `names a vendor as the subject of a generic Postgres failure:\n  ${line.trim()}`);
      }
    });
  }

  it('emits no whitespace-only line when the driver error has no message', () => {
    // pg's aggregate ECONNREFUSED carries an EMPTY message (verified against a
    // dead endpoint). The old line was `...failed: ${err.message}`, so the
    // consumer's real experience was a vendor name followed by nothing at all —
    // which is the actual reason they could not diagnose a stopped container.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/store/repo.mjs'), 'utf-8');
    assert.match(src, /raw \? /,
      'the raw driver message must be conditional, or an empty one prints a blank line');
  });

  it('the probe message names the database and the cause', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts/lib/store/repo.mjs'), 'utf-8');
    // Pinned to the PROPERTY (names the technology, not a vendor), not to the
    // exact sentence — an assertion tied to wording fails on a phrasing
    // improvement and teaches you to stop improving the wording.
    assert.match(src, /\[learning\] Postgres store/, 'the failure must be described in vendor-neutral terms');
    assert.match(src, /dbIdentity\(/, 'it must say WHICH database, or the reader cannot tell');
    assert.match(src, /classifyDbConnectionError\(/, 'and WHY, or they cannot act on it');
  });
});
