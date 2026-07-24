/**
 * @fileoverview EOL-invariant migration hashing (WS-A).
 *
 * The ledger hash is a TAMPER guard ("was this committed migration edited
 * after it was applied?"). Hashing raw bytes accidentally made it a
 * CHECKOUT-MODE guard too, so a clean LF clone false-aborted on a migration
 * applied from a CRLF tree. These tests pin the narrow fix: CRLF folding is
 * invisible to the hash, and NOTHING else is.
 *
 * The byte-preservation cases are the load-bearing half — a canonicalizer that
 * over-normalizes (decoding to a string, folding lone CR, stripping a BOM)
 * would silently widen the tamper guard into a normalizer and let real edits
 * through.
 *
 * Plan: docs/plans/debt-burndown-workstreams.md §3 WS-A.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeMigrationBytes,
  hashCanonicalMigrationBytes,
  hashRawBytes,
  legacyCrlfBytes,
  checkAdoptScope,
  checkMigrationsSchemaPairing,
} from '../scripts/setup-postgres.mjs';
// cli-io.mjs's `sha(buf, len=12)` defaults to a 12-char truncation for
// content-identity display use; this file needs the FULL digest for
// hash-equality assertions, so every call site below passes `64`
// (SHA-256's full hex length) explicitly rather than duplicating the
// hashing logic in a local wrapper.
import { sha } from '../scripts/lib/cli-io.mjs';

describe('canonicalizeMigrationBytes — folds CRLF and nothing else', () => {
  it('CRLF and LF forms of the same content hash identically', () => {
    const lf = Buffer.from('CREATE TABLE t (id int);\nALTER TABLE t ADD c int;\n', 'utf-8');
    const crlf = Buffer.from('CREATE TABLE t (id int);\r\nALTER TABLE t ADD c int;\r\n', 'utf-8');
    assert.equal(hashCanonicalMigrationBytes(crlf), hashCanonicalMigrationBytes(lf));
  });

  it('is a no-op for an already-LF file (existing ledger rows stay valid)', () => {
    const lf = Buffer.from('SELECT 1;\n', 'utf-8');
    assert.deepEqual(canonicalizeMigrationBytes(lf), lf);
    assert.equal(hashCanonicalMigrationBytes(lf), sha(lf, 64));
  });

  it('preserves a LONE CR (not part of CRLF) byte-exactly', () => {
    // A bare 0x0D is content, not a line ending we fold. Folding it would
    // change bytes the tamper guard is supposed to notice.
    const input = Buffer.from([0x41, 0x0d, 0x42, 0x0d, 0x0a, 0x43]); // A CR B CRLF C
    const out = canonicalizeMigrationBytes(input);
    assert.deepEqual(out, Buffer.from([0x41, 0x0d, 0x42, 0x0a, 0x43]));
  });

  it('preserves a trailing lone CR at end-of-buffer', () => {
    const input = Buffer.from([0x41, 0x0d]);
    assert.deepEqual(canonicalizeMigrationBytes(input), input);
  });

  it('preserves a UTF-8 BOM', () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const input = Buffer.concat([bom, Buffer.from('SELECT 1;\r\n', 'utf-8')]);
    const out = canonicalizeMigrationBytes(input);
    assert.deepEqual(out.subarray(0, 3), bom);
    assert.deepEqual(out, Buffer.concat([bom, Buffer.from('SELECT 1;\n', 'utf-8')]));
  });

  it('preserves UTF-8 multibyte sequences', () => {
    const input = Buffer.from('-- café ünïcode ✓ 日本語\r\nSELECT 1;\n', 'utf-8');
    const expected = Buffer.from('-- café ünïcode ✓ 日本語\nSELECT 1;\n', 'utf-8');
    assert.deepEqual(canonicalizeMigrationBytes(input), expected);
  });

  it('preserves NON-UTF-8 bytes (never decodes to a string)', () => {
    // 0x80,0xFE,0xFF are invalid UTF-8. A decode-then-replace implementation
    // would rewrite them to U+FFFD and change the hash of untouched content.
    const input = Buffer.from([0x80, 0xfe, 0x0d, 0x0a, 0xff, 0x00, 0x41]);
    const out = canonicalizeMigrationBytes(input);
    assert.deepEqual(out, Buffer.from([0x80, 0xfe, 0x0a, 0xff, 0x00, 0x41]));
  });

  it('handles mixed endings deterministically', () => {
    const mixed = Buffer.from('a\r\nb\nc\r\n', 'utf-8');
    assert.deepEqual(canonicalizeMigrationBytes(mixed), Buffer.from('a\nb\nc\n', 'utf-8'));
  });

  it('does not mutate its input', () => {
    const input = Buffer.from('a\r\nb\n', 'utf-8');
    const copy = Buffer.from(input);
    canonicalizeMigrationBytes(input);
    assert.deepEqual(input, copy);
  });

  it('handles an empty buffer', () => {
    assert.deepEqual(canonicalizeMigrationBytes(Buffer.alloc(0)), Buffer.alloc(0));
  });
});

describe('the tamper guard stays strict', () => {
  it('a real content edit still changes the canonical hash', () => {
    const a = Buffer.from('SELECT 1;\n', 'utf-8');
    const b = Buffer.from('SELECT 2;\n', 'utf-8');
    assert.notEqual(hashCanonicalMigrationBytes(a), hashCanonicalMigrationBytes(b));
  });

  it('an edit that only ADDS a line is detected', () => {
    const a = Buffer.from('SELECT 1;\n', 'utf-8');
    const b = Buffer.from('SELECT 1;\nDROP TABLE users;\n', 'utf-8');
    assert.notEqual(hashCanonicalMigrationBytes(a), hashCanonicalMigrationBytes(b));
  });

  it('whitespace-only edits other than CRLF are still detected', () => {
    const a = Buffer.from('SELECT 1;\n', 'utf-8');
    const b = Buffer.from('SELECT  1;\n', 'utf-8');
    assert.notEqual(hashCanonicalMigrationBytes(a), hashCanonicalMigrationBytes(b));
  });
});

describe('legacyCrlfBytes + hashRawBytes — eol-legacy classification', () => {
  it('reconstructs the historical CRLF hash of an LF-checkout file', () => {
    // The scenario: applied from a CRLF tree (ledger holds the raw CRLF hash),
    // now checked out as LF. Classification must recognise it.
    const lfOnDisk = Buffer.from('CREATE TABLE t (id int);\nSELECT 1;\n', 'utf-8');
    const historicalCrlf = Buffer.from('CREATE TABLE t (id int);\r\nSELECT 1;\r\n', 'utf-8');
    const ledgerSha = sha(historicalCrlf, 64);          // what was recorded in 2026-07
    assert.equal(hashRawBytes(legacyCrlfBytes(lfOnDisk)), ledgerSha);
  });

  it('the two primitives are NOT interchangeable (the R3-H1 bug)', () => {
    // Passing reconstructed CRLF bytes through the CANONICAL hash returns the
    // canonical LF hash — so a classifier written that way could never match a
    // legacy row. This test pins the distinction that bug turned on.
    const lf = Buffer.from('SELECT 1;\n', 'utf-8');
    const legacy = legacyCrlfBytes(lf);
    assert.equal(hashCanonicalMigrationBytes(legacy), hashCanonicalMigrationBytes(lf));
    assert.notEqual(hashRawBytes(legacy), hashCanonicalMigrationBytes(lf));
  });

  it('is idempotent on already-CRLF input (never produces CRCRLF)', () => {
    const crlf = Buffer.from('a\r\nb\r\n', 'utf-8');
    assert.deepEqual(legacyCrlfBytes(crlf), crlf);
  });

  it('expands every LF, including in mixed-ending content', () => {
    const mixed = Buffer.from('a\r\nb\nc', 'utf-8');
    assert.deepEqual(legacyCrlfBytes(mixed), Buffer.from('a\r\nb\r\nc', 'utf-8'));
  });

  it('a MIXED-ending historical file cannot masquerade as eol-legacy', () => {
    // Deliberately fail-closed: legacyCrlfBytes reconstructs exactly ONE
    // representation (all-CRLF). A historical mixed-ending file hashes to
    // something else, so it classifies as shaMismatch → manual investigation,
    // never auto-repair.
    const onDisk = Buffer.from('a\nb\nc\n', 'utf-8');
    const historicalMixed = Buffer.from('a\r\nb\nc\r\n', 'utf-8');
    assert.notEqual(hashRawBytes(legacyCrlfBytes(onDisk)), sha(historicalMixed, 64));
  });

  it('a legacy-CRLF hash of DIFFERENT content is not classified eol-legacy', () => {
    // Tampering that happens to arrive via a CRLF tree is still tampering.
    const onDisk = Buffer.from('SELECT 1;\n', 'utf-8');
    const otherCrlf = Buffer.from('DROP TABLE users;\r\n', 'utf-8');
    assert.notEqual(hashRawBytes(legacyCrlfBytes(onDisk)), sha(otherCrlf, 64));
  });

  it('preserves a lone CR through the round trip', () => {
    const input = Buffer.from([0x41, 0x0d, 0x42, 0x0a]);       // A CR B LF
    assert.deepEqual(legacyCrlfBytes(input), Buffer.from([0x41, 0x0d, 0x42, 0x0d, 0x0a]));
  });
});

// ── CLI mode exclusivity ───────────────────────────────────────────────────
//
// Every mode flag used to assign `args.mode`, so the LAST one silently won:
// `--migrate --adopt` ran adopt, `--adopt --migrate` replayed migrations —
// materially different persistence behaviour chosen by argument order.
// Adding `--repair-eol` (a ledger WRITER) to that set is what made the
// footgun reachable with a mutating mode on either side.
//
// Subprocess-driven because parseArgs owns process.exit; it bails before any
// DB connection, so these stay hermetic.

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'setup-postgres.mjs');
const run = (...flags) => spawnSync(process.execPath, [CLI, ...flags], { encoding: 'utf-8' });

describe('setup-postgres CLI — mode flags are mutually exclusive', () => {
  for (const combo of [
    ['--migrate', '--adopt'],
    ['--adopt', '--migrate'],
    ['--repair-eol', '--migrate'],
    ['--check-drift', '--repair-eol'],
    ['--ensure-local', '--adopt'],
  ]) {
    it(`rejects ${combo.join(' ')} (order must never decide the mode)`, () => {
      const r = run(...combo);
      assert.equal(r.status, 2, `expected exit 2, got ${r.status}`);
      assert.match(r.stderr, /mutually exclusive/);
      // Both offending flags named, so the operator sees what conflicted.
      for (const f of combo) assert.ok(r.stderr.includes(f), `stderr should name ${f}`);
    });
  }

  it('accepts a single mode (the guard is not over-broad)', () => {
    // --check-drift with no AUDIT_DB_URL exits 0 (cloud-disabled), proving the
    // flag parsed rather than tripping the exclusivity guard.
    const r = spawnSync(process.execPath, [CLI, '--check-drift'], {
      encoding: 'utf-8',
      env: { ...process.env, AUDIT_DB_URL: '', AUDIT_POSTGRES_URL: '', SUPABASE_AUDIT_URL: '' },
    });
    assert.notEqual(r.status, 2, 'a single mode flag must not be rejected');
    assert.doesNotMatch(r.stderr, /mutually exclusive/);
  });

  it('a repeated SAME flag is not a conflict', () => {
    const r = run('--check-drift', '--check-drift');
    assert.doesNotMatch(r.stderr, /mutually exclusive/);
  });

  it('rejects --adopt-only without --adopt (item 7 — sast-sandbox-backlog-hardening.md)', () => {
    const r = run('--adopt-only', 'foo.sql', '--migrate');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--adopt-only only makes sense with --adopt/);
  });

  it('accepts --adopt-only paired with --adopt (the pairing guard itself never fires)', () => {
    // --preflight-only stops right after parseArgs + preflight(), before
    // runAdopt ever touches the ledger/schema — avoids depending on real DB
    // connectivity, which the ambient ~/.audit-loop.env config can silently
    // reintroduce even when this process's own env vars are blanked. This
    // test only proves the flag combination itself isn't rejected by the
    // --adopt-only/--adopt pairing guard, not that a full adopt succeeds.
    const r = run('--adopt', '--adopt-only', 'foo.sql', '--preflight-only');
    assert.doesNotMatch(r.stderr, /--adopt-only only makes sense with --adopt/);
  });

  it('rejects --adopt-only immediately followed by another flag, instead of silently swallowing it as the value (round-2 audit M1)', () => {
    // Before the fix, `--adopt --adopt-only --dry-run` recorded ['--dry-run']
    // as the intended migration set AND silently dropped --dry-run itself —
    // one bug, two silent-corruption symptoms.
    const r = run('--adopt', '--adopt-only', '--dry-run');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--adopt-only requires a value/);
    assert.match(r.stderr, /--dry-run/, 'the offending flag should be named in the error');
  });

  it('rejects --adopt-only with no following argument at all', () => {
    const r = run('--adopt', '--adopt-only');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--adopt-only requires a value/);
  });

  it('still accepts a genuine comma-separated migration list', () => {
    const r = run('--adopt', '--adopt-only', 'a.sql,b.sql', '--preflight-only');
    assert.doesNotMatch(r.stderr, /--adopt-only requires a value/);
  });
});

describe('checkAdoptScope — item 7 exact-unledgered-set preflight (sast-sandbox-backlog-hardening.md)', () => {
  it('adoptOnly===null preserves today\'s whole-DB-seed behaviour (no scoping requested)', () => {
    assert.deepEqual(checkAdoptScope(['a.sql', 'b.sql'], null), { ok: true });
  });

  it('an empty unledgered set is always ok, regardless of adoptOnly', () => {
    assert.deepEqual(checkAdoptScope([], ['a.sql']), { ok: true });
  });

  it('the unledgered set exactly matching adoptOnly passes', () => {
    assert.deepEqual(checkAdoptScope(['a.sql', 'b.sql'], ['a.sql', 'b.sql']), { ok: true });
  });

  it('an unledgered set that is a SUBSET of adoptOnly passes (not every named file has to actually be unledgered)', () => {
    assert.deepEqual(checkAdoptScope(['a.sql'], ['a.sql', 'b.sql']), { ok: true });
  });

  it('an unledgered file OUTSIDE adoptOnly fails, naming exactly the offending file(s)', () => {
    const result = checkAdoptScope(['a.sql', 'unexpected.sql'], ['a.sql']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.outside, ['unexpected.sql']);
  });

  it('a completely disjoint unledgered set fails, naming all of it', () => {
    const result = checkAdoptScope(['x.sql', 'y.sql'], ['a.sql']);
    assert.equal(result.ok, false);
    assert.deepEqual(result.outside, ['x.sql', 'y.sql']);
  });

  it('adoptOnly as an empty array behaves like a real (empty) allowlist — any unledgered file fails', () => {
    const result = checkAdoptScope(['a.sql'], []);
    assert.equal(result.ok, false);
    assert.deepEqual(result.outside, ['a.sql']);
  });
});

describe('checkMigrationsSchemaPairing — Gemini final-review H3 (sast-sandbox-backlog-hardening.md)', () => {
  it('both private → ok (normal fully-synced consumer)', () => {
    assert.deepEqual(checkMigrationsSchemaPairing(true, true), { ok: true });
  });

  it('both legacy → ok (source repo, or pre-sync consumer)', () => {
    assert.deepEqual(checkMigrationsSchemaPairing(false, false), { ok: true });
  });

  it('migrations private but schema legacy → fails (partial sync: schema manifest not yet synced)', () => {
    const result = checkMigrationsSchemaPairing(true, false);
    assert.equal(result.ok, false);
    assert.equal(result.migrationsIsPrivate, true);
    assert.equal(result.schemaIsPrivate, false);
  });

  it('migrations legacy but schema private → fails (partial sync: migrations not yet synced)', () => {
    const result = checkMigrationsSchemaPairing(false, true);
    assert.equal(result.ok, false);
    assert.equal(result.migrationsIsPrivate, false);
    assert.equal(result.schemaIsPrivate, true);
  });
});
