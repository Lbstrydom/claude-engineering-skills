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
import crypto from 'node:crypto';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeMigrationBytes,
  hashCanonicalMigrationBytes,
  hashRawBytes,
  legacyCrlfBytes,
} from '../scripts/setup-postgres.mjs';

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

describe('canonicalizeMigrationBytes — folds CRLF and nothing else', () => {
  it('CRLF and LF forms of the same content hash identically', () => {
    const lf = Buffer.from('CREATE TABLE t (id int);\nALTER TABLE t ADD c int;\n', 'utf-8');
    const crlf = Buffer.from('CREATE TABLE t (id int);\r\nALTER TABLE t ADD c int;\r\n', 'utf-8');
    assert.equal(hashCanonicalMigrationBytes(crlf), hashCanonicalMigrationBytes(lf));
  });

  it('is a no-op for an already-LF file (existing ledger rows stay valid)', () => {
    const lf = Buffer.from('SELECT 1;\n', 'utf-8');
    assert.deepEqual(canonicalizeMigrationBytes(lf), lf);
    assert.equal(hashCanonicalMigrationBytes(lf), sha(lf));
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
    const ledgerSha = sha(historicalCrlf);          // what was recorded in 2026-07
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
    assert.notEqual(hashRawBytes(legacyCrlfBytes(onDisk)), sha(historicalMixed));
  });

  it('a legacy-CRLF hash of DIFFERENT content is not classified eol-legacy', () => {
    // Tampering that happens to arrive via a CRLF tree is still tampering.
    const onDisk = Buffer.from('SELECT 1;\n', 'utf-8');
    const otherCrlf = Buffer.from('DROP TABLE users;\r\n', 'utf-8');
    assert.notEqual(hashRawBytes(legacyCrlfBytes(onDisk)), sha(otherCrlf));
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
});
