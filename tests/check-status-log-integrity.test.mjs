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

import {
  test, describe, before, after,
} from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
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

  test('--base HEAD on a CLEAN tree is REFUSED — nothing to compare', () => {
    // The working tree of this checkout is clean during a test run, so `prev`
    // and `curr` really are identical here and the refusal is correct. This is
    // the direction the gate must NEVER stop firing in: exit 0 would be a
    // green having compared nothing, which AGENTS.md's sandbox-honesty rule
    // forbids and which is this gate's entire reason for existing.
    assert.equal(run(['--base', 'HEAD']), 2);
  });

  test('the empty-range refusal keeps its VERDICT, not just its exit code', () => {
    // Asserting `bad-base` rather than the prose survives a rewording while
    // still failing if a later edit turns the refusal into a skip.
    let out = '';
    try {
      execFileSync(process.execPath, [CLI, '--base', 'HEAD', '--json'], { cwd: REPO, encoding: 'utf8', stdio: 'pipe' });
      assert.fail('--base HEAD on a clean tree must not exit 0');
    } catch (err) {
      assert.equal(err.status, 2);
      out = `${err.stdout ?? ''}`;
    }
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
    assert.equal(parsed.ok, false);
    assert.equal(parsed.verdict, 'bad-base', 'the verdict string is part of the contract');
  });

  test('a real range reports that it did NOT compare only the working tree', () => {
    // The honesty half of the 2026-11-13 fix: a run that saw a span of commits
    // and a run that saw only the working tree must be distinguishable in the
    // envelope, or a green gets read as covering more than it did.
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
      .trim().split(' ').slice(1);
    const out = execFileSync(process.execPath, [CLI, '--base', parents[parents.length - 1], '--json'], { cwd: REPO, encoding: 'utf8' });
    const parsed = JSON.parse(out.trim().split('\n').filter(Boolean).pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.emptyRange, false);
    assert.equal(parsed.comparedWorkingTreeOnly, false);
  });

  test('a real ancestor exits 0 on a conserved log', () => {
    // On a MERGE commit (a branch that merged main) the meaningful base is the merged-in side, the
    // one a push range would use; HEAD~1 is the branch's own pre-merge tip, against which the merge
    // legitimately brings in whatever main gained. Otherwise the plain parent.
    const parents = execFileSync('git', ['rev-list', '--parents', '-n', '1', 'HEAD'], { cwd: REPO, encoding: 'utf8' })
      .trim().split(' ').slice(1);
    assert.equal(run(['--base', parents[parents.length - 1]]), 0);
  });
});

// Gate contract: scripts/gate-contracts/status-integrity-gate.json declares the
// executable gate `status-integrity-rejects-a-truncated-log`, whose poison pill
// overlays a single-entry status.md — a replay of PR #87 — and requires the gate
// to report `entry-vanished` rather than exiting 0.

describe('conservation is ONE-TO-ONE (R1 audit H6/H12)', () => {
  // Duplicate headings are explicitly legal — two entries may share a date. A
  // Set of digests plus a first-wins Map of headings let ONE survivor satisfy
  // SEVERAL prior entries, so deleting a duplicate passed. Each match must
  // consume its counterpart.
  const dupA = `## 2026-08-02 — work\n\nfirst of the day\n\n---\n`;
  const dupB = `## 2026-08-02 — work\n\nsecond of the day\n\n---\n`;
  const twoOnOneDay = HEADER + dupA + dupB;

  test('deleting ONE of two same-heading entries FAILS', () => {
    const r = checkConservation(
      { root: twoOnOneDay, archives: {}, manifest: null },
      { root: HEADER + dupA, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false, 'the surviving duplicate must not cover for the deleted one');
  });

  test('keeping BOTH same-heading entries passes', () => {
    const r = checkConservation(
      { root: twoOnOneDay, archives: {}, manifest: null },
      { root: twoOnOneDay, archives: {}, manifest: null },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });

  test('two BYTE-IDENTICAL entries: deleting one still fails', () => {
    // The hardest case — identical digests, so a plain Set cannot tell them apart.
    const identical = HEADER + dupA + dupA;
    const r = checkConservation(
      { root: identical, archives: {}, manifest: null },
      { root: HEADER + dupA, archives: {}, manifest: null },
    );
    assert.equal(r.ok, false, 'a digest multiset, not a set — one survivor cannot satisfy two');
  });
});

describe('every archive is vouched for (R1 audit M15)', () => {
  test('an archive file with NO manifest record fails', () => {
    const july = splitEntries(LOG).entries.find((x) => x.date === '2026-07-01');
    const rotatedRoot = HEADER + e('2026-09-03', 'newest') + e('2026-08-02', 'middle');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      {
        root: rotatedRoot,
        archives: { 'docs/status/2026-07.md': july.body, 'docs/status/2026-06.md': '## 2026-06-01 — smuggled\n\nx\n' },
        manifest: { archives: { '2026-07': { path: 'docs/status/2026-07.md', entryDigests: [july.digest] } } },
      },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'archive-unrecorded'),
      'Law 4 walks manifest->disk; without the reverse an unvouched archive slips in');
  });

  test('docs/status/README.md is the index, not an unvouched archive', () => {
    const july = splitEntries(LOG).entries.find((x) => x.date === '2026-07-01');
    const rotatedRoot = HEADER + e('2026-09-03', 'newest') + e('2026-08-02', 'middle');
    const r = checkConservation(
      { root: LOG, archives: {}, manifest: null },
      {
        root: rotatedRoot,
        archives: { 'docs/status/2026-07.md': july.body, 'docs/status/README.md': '# index\n' },
        manifest: { archives: { '2026-07': { path: 'docs/status/2026-07.md', entryDigests: [july.digest] } } },
      },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });
});

describe('R2 audit — the laws that had gaps', () => {
  test('H2/H7: duplicate ARCHIVED entries are multiset-conserved too', () => {
    // Law 1 was made multiplicity-aware first; Law 2 kept a Map<digest,path>,
    // so two byte-identical archived entries collapsed to one record and
    // deleting one still passed. The two loops keep separate bookkeeping,
    // which is why fixing one did not fix the other.
    const july = `## 2026-07-01 — work\n\noldest\n\n---\n`;
    const twice = july + july;
    const manifest = { archives: { '2026-07': { path: 'docs/status/2026-07.md', entryDigests: [] } } };
    const r = checkConservation(
      { root: HEADER, archives: { 'docs/status/2026-07.md': twice }, manifest },
      { root: HEADER, archives: { 'docs/status/2026-07.md': july }, manifest },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'archive-mutated'),
      'one surviving archived entry must not cover for two');
  });

  test('H3: the root PREAMBLE is conserved — it was outside every law', () => {
    // Everything else keys on `## ` headings, so the `# Project Status Log`
    // title and any standing note above the first entry could be deleted freely.
    const withNote = '# Project Status Log\n\nA standing note nobody may drop.\n\n';
    const r = checkConservation(
      { root: withNote + e('2026-09-03', 'x'), archives: {}, manifest: null },
      { root: HEADER + e('2026-09-03', 'x'), archives: {}, manifest: null },
    );
    assert.equal(r.ok, false);
    assert.ok(r.violations.some((v) => v.kind === 'preamble-lost'));
  });

  test('H3 the other way: the preamble may GROW', () => {
    const r = checkConservation(
      { root: HEADER + e('2026-09-03', 'x'), archives: {}, manifest: null },
      { root: '# Project Status Log\n\nnew note\n\n' + e('2026-09-03', 'x'), archives: {}, manifest: null },
    );
    assert.equal(r.ok, true, r.violations.map((v) => v.detail).join('; '));
  });
});

/**
 * AN EMPTY COMMIT RANGE IS NOT AN EMPTY COMPARISON (fixed 2026-11-13).
 *
 * The gate used to refuse on the proxy `base == HEAD`. But `curr` is the
 * WORKING TREE, so an empty commit range can still carry a delta — and PR #87's
 * defect class (a partial Read then a whole-file Write) is a working-tree
 * event. On 6 of 17 live worktrees the gate was therefore refusing to look.
 *
 * These run against a DISPOSABLE repo, because the fix's whole subject is a
 * dirty working tree and this checkout is shared with other sessions: dirtying
 * `status.md` here would race them. The fixture copies the gate's own transitive
 * import closure, computed from the source, so adding an import does not
 * silently leave the fixture broken.
 *
 * Measurement: docs/research/status-integrity-gate-base-measurement-2026-11-13.md
 */
describe('an empty commit range is not an empty comparison', () => {
  const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ENTRY = 'scripts/check-status-log-integrity.mjs';

  /** Every relative import reachable from the gate — static `from '...'` AND dynamic `import('...')`. */
  const importClosure = () => {
    const seen = new Set();
    const queue = [ENTRY];
    while (queue.length) {
      const rel = queue.shift();
      if (seen.has(rel)) continue;
      seen.add(rel);
      const src = fs.readFileSync(path.join(REPO, rel), 'utf-8');
      for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*)'(\.[^']+)'/g)) {
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1]));
        if (fs.existsSync(path.join(REPO, next))) queue.push(next);
      }
    }
    return [...seen];
  };

  const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  /**
   * A throwaway repo with a pushed main, so the resolver's base == HEAD.
   *
   * `perEntry` adds the marker + one entry record, reproducing THIS repo's
   * current layout, and leaves HEAD on a fresh branch with no upstream — the
   * exact shape a `/ship` is in when `guards:preflight` runs: branch cut at the
   * default-branch tip, new status entry on disk, nothing committed yet.
   */
  const makeFixture = ({ perEntry = false } = {}) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'status-integrity-empty-range-'));
    const remote = path.join(root, 'remote.git');
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', remote], { stdio: 'ignore' });
    git(work, ['init', '-q']);
    // Point hooksPath at nothing: this machine sets core.hooksPath globally, and
    // a fixture must not run the real repo's hooks.
    git(work, ['config', 'core.hooksPath', path.join(root, 'no-hooks')]);
    git(work, ['config', 'user.email', 'fixture@example.invalid']);
    git(work, ['config', 'user.name', 'fixture']);
    git(work, ['config', 'commit.gpgsign', 'false']);
    for (const rel of importClosure()) {
      const dest = path.join(work, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), dest);
    }
    fs.writeFileSync(path.join(work, 'status.md'), LOG);
    if (perEntry) {
      const dir = path.join(work, 'docs', 'status', 'entries');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'README.md'), 'Marker: per-entry mode.\n');
      fs.writeFileSync(path.join(dir, '2026-11-02-100000-existing.md'), '## 2026-11-02 — existing entry\n\nbody\n');
    }
    git(work, ['add', '-A']);
    git(work, ['commit', '-q', '-m', 'fixture base']);
    git(work, ['branch', '-M', 'main']);
    git(work, ['remote', 'add', 'origin', remote]);
    git(work, ['push', '-q', '-u', 'origin', 'main']);
    if (perEntry) git(work, ['checkout', '-q', '-b', 'claude/fixture-ship']);
    return { root, work };
  };

  const runIn = (work, args = []) => {
    try {
      const stdout = execFileSync(process.execPath, [path.join(work, ENTRY), ...args], { cwd: work, encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stdout };
    } catch (err) { return { status: err.status, stdout: `${err.stdout ?? ''}` }; }
  };
  const envelope = (r) => JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop());

  let fixture;
  before(() => { fixture = makeFixture(); });
  after(() => {
    // The retry options are the repo-wide shape for Windows EPERM/EBUSY, where
    // a just-exited child can still hold a handle on the fixture's .git files.
    if (fixture) fs.rmSync(fixture.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const restore = (work) => git(work, ['checkout', '--', 'status.md']);

  test('CONTROL — the fixture really is in the collapsing state (base == HEAD)', () => {
    // Without this the tests below could all pass for the wrong reason: a
    // fixture with a non-empty range never exercises the fix at all.
    const { work } = fixture;
    assert.equal(git(work, ['rev-parse', 'HEAD']).trim(), git(work, ['rev-parse', '@{upstream}']).trim());
  });

  test('MUST NOT FIRE — empty range, CLEAN tree still FAILS CLOSED (exit 2)', () => {
    // The direction a gate loosened until it stops complaining would break.
    // Nothing differs, so there is genuinely nothing to compare, and reporting
    // "conserved" here is the vacuous green this gate exists to prevent.
    const r = runIn(fixture.work, ['--json']);
    assert.equal(r.status, 2);
    assert.equal(envelope(r).verdict, 'bad-base');
  });

  test('THE FIX — empty range, a TRUNCATION on disk is caught (exit 1, entry-vanished)', () => {
    // Before the fix this exited 2 having read nothing: the PR #87 class, at
    // the moment it happens, on a fully-pushed branch. Proven red by reverting.
    const { work } = fixture;
    try {
      fs.writeFileSync(path.join(work, 'status.md'), '# Project Status Log\n');
      const r = runIn(work, ['--json']);
      assert.equal(r.status, 1, 'a disk-only truncation must FAIL, not refuse');
      const env = envelope(r);
      assert.equal(env.ok, false);
      assert.ok(env.violations.some((v) => v.kind === 'entry-vanished'), 'and it is the PR #87 class');
      assert.equal(env.comparedWorkingTreeOnly, true, 'and it must say it saw only the working tree');
    } finally { restore(work); }
  });

  test('THE FIX, other way — empty range, a legal APPEND on disk PASSES', () => {
    // The gate must not simply fail whenever the tree is dirty: appending is
    // ordinary work (this repo's own /ship appends), and a gate that blocked it
    // would be a worse regression than the one being fixed.
    const { work } = fixture;
    try {
      fs.appendFileSync(path.join(work, 'status.md'), e('2026-09-04', 'appended'));
      const r = runIn(work, ['--json']);
      assert.equal(r.status, 0, r.stdout);
      assert.equal(envelope(r).comparedWorkingTreeOnly, true);
    } finally { restore(work); }
  });

  test('MUST NOT FIRE — a NON-empty range that leaves the log alone still passes', () => {
    // The regression this fix could plausibly have caused. Outside the empty
    // range, `prev == curr` is the ordinary "this push did not touch the log",
    // which is almost every push. Refusing there would block the whole repo.
    const { work } = fixture;
    fs.writeFileSync(path.join(work, 'unrelated.txt'), 'not the status log\n');
    git(work, ['add', 'unrelated.txt']);
    git(work, ['commit', '-q', '-m', 'unrelated change']);
    const r = runIn(work, ['--json']);
    assert.equal(r.status, 0, r.stdout);
    const env = envelope(r);
    assert.equal(env.emptyRange, false);
    assert.equal(env.comparedWorkingTreeOnly, false);
  });

  test('MUST NOT FIRE — an unresolvable base still fails closed in the fixture too', () => {
    assert.equal(runIn(fixture.work, ['--base', 'no-such-ref-anywhere', '--json']).status, 2);
  });

  /**
   * THE LIVE SHAPE, reported by a concurrent session on 2026-11-13 and
   * reproduced here. Shipping a docs-only commit, it saw the gate report
   * `INCOMPLETE: not measured: status:integrity:gate` from `guards:preflight`
   * on a fresh branch — and `--base origin/main` was refused too, because
   * `origin/main` IS HEAD at that moment. An explicit base does not help: the
   * gate is being asked before HEAD has moved past the branch point.
   *
   * That is not a rare state. It is every CES `/ship`: branch cut at the
   * default-branch tip, the new status entry written to disk, preflight run
   * BEFORE the commit. A gate exiting 2 is `EXIT_CANNOT_RUN`
   * (scripts/lib/guards-preflight.mjs), so preflight counted it unmeasured.
   *
   * After the fix the entry on disk IS the delta, so the gate measures — and
   * the three negative controls below prove that measurement is not vacuous.
   */
  describe('the live /ship shape: fresh branch, new entry on disk, nothing committed', () => {
    let ship;
    before(() => { ship = makeFixture({ perEntry: true }); });
    after(() => {
      if (ship) fs.rmSync(ship.root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    });

    const NEW_ENTRY = 'docs/status/entries/2026-11-13-210000-docs-only.md';
    const addShipEntry = (work) => fs.writeFileSync(
      path.join(work, NEW_ENTRY), '## 2026-11-13 — docs-only ship\n\nbody\n',
    );

    test('CONTROL — no upstream, and merge-base(origin/main, HEAD) IS HEAD', () => {
      // The peer's step 2: an explicit --base origin/main cannot help either,
      // because origin/main is HEAD. Asserting it stops a later reader from
      // "fixing" this by passing a base.
      const { work } = ship;
      // `rev-parse --verify --quiet` EXITS 1 when there is no upstream, so the
      // throwing helper cannot express "absent" — that absence is the point.
      let upstream = 'present';
      try { upstream = git(work, ['rev-parse', '--verify', '--quiet', '@{upstream}']).trim(); } catch { upstream = ''; }
      assert.equal(upstream, '', 'a fresh branch has no tracking ref');
      assert.equal(
        git(work, ['rev-parse', git(work, ['merge-base', 'origin/main', 'HEAD']).trim()]).trim(),
        git(work, ['rev-parse', 'HEAD']).trim(),
      );
      assert.equal(runIn(work, ['--base', 'origin/main', '--json']).status, 2, 'clean tree: still nothing to compare');
    });

    test('THE FIX, live — the uncommitted ship entry IS the delta, so the gate MEASURES', () => {
      const { work } = ship;
      try {
        addShipEntry(work);
        const r = runIn(work, ['--json']);
        assert.equal(r.status, 0, r.stdout);
        const env = envelope(r);
        assert.equal(env.emptyRange, true);
        assert.equal(env.comparedWorkingTreeOnly, true, 'and it says it saw only the working tree');
      } finally { fs.rmSync(path.join(work, NEW_ENTRY), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    });

    for (const [label, breakIt] of [
      ['an existing entry record DELETED on disk', (work) => fs.rmSync(path.join(work, 'docs/status/entries/2026-11-02-100000-existing.md'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })],
      ['status.md TRUNCATED on disk', (work) => fs.writeFileSync(path.join(work, 'status.md'), HEADER)],
      ['the MARKER deleted on disk', (work) => fs.rmSync(path.join(work, 'docs/status/entries/README.md'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })],
    ]) {
      test(`NEGATIVE CONTROL, live — ${label} FAILS (exit 1), so the new measurement is not vacuous`, () => {
        const { work } = ship;
        try {
          addShipEntry(work);
          breakIt(work);
          const r = runIn(work, ['--json']);
          assert.equal(r.status, 1, r.stdout);
          assert.equal(envelope(r).ok, false);
        } finally {
          fs.rmSync(path.join(work, NEW_ENTRY), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
          git(work, ['checkout', '--', '.']);
        }
      });
    }
  });
});
