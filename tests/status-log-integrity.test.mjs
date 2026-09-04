/**
 * @fileoverview Cluster E / Phase 12 — the session-log conservation law.
 *
 * The headline case is a replay of PR #87: `status.md` overwritten with a
 * single entry, 19,257 lines gone, merged to `main` through a full check run
 * because nothing measured the file. That replay must FAIL here.
 *
 * The subtler cases matter as much, because each is a way a guard can look
 * right and protect nothing:
 *   - counting instead of identity (delete N, invent N, total unchanged);
 *   - digesting the heading instead of the entry (gut the body, heading kept);
 *   - banning appends (which would block ordinary work — and this repo's own
 *     /ship appends a backlog line to the entry it just wrote);
 *   - trusting the manifest that vouches for the archives (delete an archive
 *     AND its record together, and every other law still passes).
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A9, §9.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { splitEntries, checkConservation, monthOf } from '../scripts/lib/status-log-integrity.mjs';

const HEADER = '# Project Status Log\n\n';
const e = (date, body) => `## ${date} — work\n\n${body}\n\n---\n`;

const LOG = HEADER + e('2026-09-03', 'newest') + e('2026-08-02', 'middle') + e('2026-07-01', 'oldest');

const digestsOf = (text) => splitEntries(text).entries.map((x) => x.digest);

describe('splitEntries', () => {
  test('splits on ## headings and keeps the full span', () => {
    const { preamble, entries } = splitEntries(LOG);
    assert.match(preamble, /# Project Status Log/);
    assert.equal(entries.length, 3);
    assert.equal(entries[0].date, '2026-09-03');
    assert.match(entries[0].body, /newest/, 'the body travels with the heading');
  });

  test('the month comes verbatim from the heading — no Date parsing, no timezone', () => {
    assert.equal(monthOf(splitEntries(LOG).entries[2]), '2026-07');
  });

  test('an UNDATED heading is still an entry (protected), just not datable', () => {
    const { entries } = splitEntries(`${HEADER}## Some untitled section\n\nbody\n`);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].date, null);
    assert.equal(monthOf(entries[0]), null, 'the rotation refuses to move it; the guard still protects it');
  });

  test('CRLF does not read as a rewrite', () => {
    assert.deepEqual(digestsOf(LOG), digestsOf(LOG.replace(/\n/g, '\r\n')));
  });
});

describe('checkConservation — PR #87', () => {
  test('REPLAY: overwriting the log with one entry FAILS', () => {
    const truncated = HEADER + e('2026-09-04', 'the only entry now');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: truncated, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false);
    assert.equal(r.violations.filter((v) => v.kind === 'entry-vanished').length, 3,
      'all three prior entries vanished — this is the 19,257-line loss, in miniature');
  });

  test('COUNTING WOULD NOT CATCH IT: same entry count, different entries, still fails', () => {
    const swapped = HEADER + e('2026-09-04', 'a') + e('2026-09-05', 'b') + e('2026-09-06', 'c');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: swapped, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false, 'three in, three out — a count check passes, identity does not');
  });

  test('HEADING-ONLY DIGESTS WOULD NOT CATCH IT: body gutted under a kept heading fails', () => {
    const gutted = HEADER + e('2026-09-03', 'newest') + e('2026-08-02', '') + e('2026-07-01', 'oldest');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: gutted, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'entry-rewritten'));
  });
});

describe('checkConservation — appending is ordinary work', () => {
  test('APPENDING to the newest entry PASSES', () => {
    // /ship itself does this: Step 2 writes the entry, Step 2b appends a
    // Backlog line. A naive "no digest may disappear" rule would ban it.
    const appended = LOG.replace('## 2026-09-03 — work\n\nnewest\n',
      '## 2026-09-03 — work\n\nnewest\nBacklog 2026-09-04T09:14Z: Q1 26c/25p\n');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: appended, archives: {}, manifest: null },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });

  test('a NON-append rewrite of a retained entry fails', () => {
    const rewritten = LOG.replace('newest', 'something else entirely');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: rewritten, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false);
  });

  test('adding a brand-new entry at the top passes', () => {
    const grown = HEADER + e('2026-09-04', 'brand new') + LOG.slice(HEADER.length);
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: grown, archives: {}, manifest: null },
    );
    assert.equal(r.ok, true);
  });
});

describe('checkConservation — rotation', () => {
  const july = splitEntries(LOG).entries.find((x) => x.date === '2026-07-01');
  const rotatedRoot = HEADER + e('2026-09-03', 'newest') + e('2026-08-02', 'middle');
  const archives = { 'docs/status/2026-07.md': july.body };
  const manifest = {
    archives: { '2026-07': { path: 'docs/status/2026-07.md', entryDigests: [july.digest] } },
  };

  test('a correct rotation PASSES — content moved, not lost', () => {
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: rotatedRoot, archives, manifest },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });

  test('re-running on the rotation commit still passes — the property a runtime flag could not give', () => {
    const r = checkConservation(
      { root: rotatedRoot, archives, manifest },
      { root: rotatedRoot, archives, manifest },
    );
    assert.equal(r.ok, true);
  });

  test('rotation that DROPS an entry instead of archiving it fails', () => {
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: rotatedRoot, archives: {}, manifest: { archives: {} } },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'entry-vanished'));
  });

  test('a TAMPERED archive (digest mismatch) fails', () => {
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: rotatedRoot, archives: { 'docs/status/2026-07.md': july.body + '\nsneaky edit\n' }, manifest },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'archive-digest-mismatch'));
  });

  test('THE MANIFEST BYPASS: deleting an archive AND its record together fails', () => {
    // Every other law passes here — the root is unreduced, and every REMAINING
    // archive matches every REMAINING record. Only manifest monotonicity catches it.
    const r = checkConservation(
      { root: rotatedRoot, archives, manifest },
      { root: rotatedRoot, archives: {}, manifest: { archives: {} } },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'manifest-shrank'),
      'the voucher must itself be vouched for');
  });

  test('the manifest may GROW as months rotate', () => {
    const aug = splitEntries(LOG).entries.find((x) => x.date === '2026-08-02');
    const more = {
      archives: {
        ...manifest.archives,
        '2026-08': { path: 'docs/status/2026-08.md', entryDigests: [aug.digest] },
      },
    };
    const r = checkConservation(
      { root: rotatedRoot, archives, manifest },
      {
        root: HEADER + e('2026-09-03', 'newest'),
        archives: { ...archives, 'docs/status/2026-08.md': aug.body },
        manifest: more,
      },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });

  test('a manifest record with no archive file on disk fails', () => {
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      { root: rotatedRoot, archives: {}, manifest },
    );
    assert.ok(r.violations.some((v) => v.kind === 'archive-missing'));
  });
});

describe('the CLI fails closed — a vacuous pass is the bug this guard exists to prevent', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const CLI = path.join(REPO, 'scripts', 'check-status-log-integrity.mjs');

  const run = (args) => {
    try {
      execFileSync(process.execPath, [CLI, ...args], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
      return 0;
    } catch (err) { return err.status; }
  };

  test('an UNRESOLVABLE base exits 2, never 0', () => {
    // Found by testing this gate: a bogus base made every `git show` miss, so
    // the previous state came back empty, there was nothing to conserve, and it
    // printed "conserved". A guard that cannot see its baseline protects
    // nothing — and in CI shallow clones, where merges land, that is the
    // DEFAULT. Assert the exit code, because exit 0 here is the whole defect.
    assert.equal(run(['--base', 'no-such-ref-anywhere']), 2);
  });

  test('a resolvable base exits 0 on an unchanged log', () => {
    assert.equal(run(['--base', 'HEAD']), 0);
  });
});

// Gate contract: scripts/gate-contracts/status-integrity-gate.json declares the
// executable gate `status-integrity-rejects-a-truncated-log`, whose poison pill
// overlays a single-entry status.md — a replay of PR #87 — and requires the gate
// to report `entry-vanished` rather than exiting 0.
