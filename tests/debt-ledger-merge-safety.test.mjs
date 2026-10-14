/**
 * @fileoverview Merge-level acceptance test (docs/plans/debt-ledger-merge-safety.md
 * §5 M2 — the plan's causal narrative about a real git-merge duplicating
 * topicId entries was asserted, not exercised, until this file).
 *
 * The property under test is NOT "the merge always succeeds cleanly" — it's
 * "the merge never silently corrupts", which allows exactly two outcomes and
 * forbids a third:
 *   (a) clean merge  — correct entry count, correct content, zero duplicates
 *   (b) loud conflict — a human resolves it, same as any other git conflict
 *   (c) FORBIDDEN — clean exit but duplicated/dropped/wrong-side content
 *
 * Isolated from debt-ledger.test.mjs because it spawns real git subprocesses
 * against throwaway repos (heavier setup/teardown than that suite's
 * in-memory-fixture tests).
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

import { writeDebtEntries, serializeLedgerForDisk } from '../scripts/lib/debt-ledger.mjs';
import { findDuplicateTopicIds } from '../scripts/lib/debt-review-helpers.mjs';
import { gitFixtureEnv } from './helpers/fixtures.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debt-merge-safety-'));
});
afterEach(() => {
  try { fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* ignore */ }
});

function makeEntry(topicId, overrides = {}) {
  return {
    source: 'debt',
    topicId,
    semanticHash: `hash-${topicId}`,
    severity: 'MEDIUM',
    category: 'test',
    section: 'src/x.js:1',
    detailSnapshot: 'details',
    affectedFiles: ['src/x.js'],
    affectedPrinciples: [],
    pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-04-05T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: 'a sufficiently long rationale string for testing',
    contentAliases: [],
    sensitive: false,
    ...overrides,
  };
}

// git identity pre-configured so an operational failure (missing commit
// identity) can never masquerade as outcome (b) — round-3 plan-audit M3.
// env: gitFixtureEnv() strips inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
// (final-gate G2) — without it, running this suite inside a git-hook context
// (e.g. the pre-push sandbox) could make these spawned git commands target
// the HOST repo instead of the throwaway temp dir. Reusing this repo's own
// existing helper (tests/helpers/fixtures.mjs), not a second implementation.
function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', env: gitFixtureEnv() });
}

// Round-1 audit M4: setup commands (init/config/add/checkout) were run for
// side effect only, with no exit-code check — a silent setup failure would
// have surfaced later as a confusing, unrelated assertion failure deep in a
// scenario instead of a clear "setup step X failed" error at the source.
function gitOk(args, cwd, label) {
  const r = git(args, cwd);
  assert.equal(r.status, 0, `${label} failed (git ${args.join(' ')}): ${r.stderr}`);
  return r;
}

function initRepo(dir) {
  gitOk(['init', '-q', '-b', 'main'], dir, 'git init');
  gitOk(['config', 'user.name', 'Test'], dir, 'git config user.name');
  gitOk(['config', 'user.email', 'test@example.com'], dir, 'git config user.email');
  // A global commit.gpgsign=true would make every commit below fail for an
  // unrelated reason (no signing key in this throwaway repo) — same class of
  // environment leak as the sanitized GIT_* env vars above, and this repo's
  // own tests/helpers/fixtures.mjs::gitInit already disables it for exactly
  // this reason.
  gitOk(['config', 'commit.gpgsign', 'false'], dir, 'git config commit.gpgsign');
}

function writeAndCommit(dir, filePath, text, message) {
  fs.writeFileSync(filePath, text, 'utf-8');
  gitOk(['add', '.'], dir, `git add before "${message}"`);
  gitOk(['commit', '-q', '-m', message], dir, `commit "${message}"`);
}

/**
 * Run one two-branch merge scenario. `serialize(entries)` controls the format
 * under test — `serializeLedgerForDisk({version:1,entries})` for the fix, or
 * old-style `JSON.stringify({version:1,entries}, null, 2)+'\n'` for the
 * control. Branches diverge from the same base commit (X and Y each branch
 * from `main`, never from each other) and are merged Y-into-X.
 *
 * @returns {{cleanMerge: boolean, conflict: boolean, mergedText: string|null}}
 */
function runMergeScenario(serialize, baseEntries, branchXEntries, branchYEntries) {
  const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-'));
  const filePath = path.join(dir, 'tech-debt.json');
  initRepo(dir);
  writeAndCommit(dir, filePath, serialize(baseEntries), 'base');

  gitOk(['checkout', '-q', '-b', 'x'], dir, 'checkout -b x');
  writeAndCommit(dir, filePath, serialize(branchXEntries), 'x edits');

  gitOk(['checkout', '-q', 'main'], dir, 'checkout main');
  gitOk(['checkout', '-q', '-b', 'y'], dir, 'checkout -b y');
  writeAndCommit(dir, filePath, serialize(branchYEntries), 'y edits');

  gitOk(['checkout', '-q', 'x'], dir, 'checkout x');
  const merge = git(['merge', '--no-edit', 'y'], dir);

  if (merge.status === 0) {
    return { cleanMerge: true, conflict: false, mergedText: fs.readFileSync(filePath, 'utf-8') };
  }

  // Outcome (b) is confirmed by exit 1 COMBINED WITH git status --porcelain
  // showing an unmerged path — not exit code alone (round-3 plan-audit M3: a
  // non-zero exit can also mean an unrelated operational failure, which the
  // pre-configured git identity above already rules out for THIS repo, but
  // the porcelain check is the precise, standard signal regardless).
  const status = git(['status', '--porcelain'], dir);
  const hasUnmergedPath = /^(UU|AA|DU|UD) /m.test(status.stdout);
  if (merge.status === 1 && hasUnmergedPath) {
    git(['merge', '--abort'], dir); // cleanup so afterEach's rmSync has no locked git state
    return { cleanMerge: false, conflict: true, mergedText: null };
  }

  // Neither a clean merge nor a recognizable content conflict — the harness
  // itself is broken (bad ref, unrelated git error). Fail loudly rather than
  // reading this as either passing outcome.
  assert.fail(
    `merge harness produced neither a clean merge nor a detectable conflict `
    + `(exit ${merge.status}, stderr: ${merge.stderr})`,
  );
  return null;
}

const compactSerialize = (entries) => serializeLedgerForDisk({ version: 1, entries });
const oldFormatSerialize = (entries) => `${JSON.stringify({ version: 1, entries }, null, 2)}\n`;

describe('debt-ledger merge safety — real git-merge acceptance test', () => {
  describe('Scenario 1 — two branches each edit a DIFFERENT existing entry (mirrors the incident\'s 8 resolved/untouched pairs)', () => {
    // 20 entries, edits far apart (index 2 and 15) — unambiguously outside
    // git's default 3-line diff context in the one-line-per-entry format, so
    // this scenario deterministically clean-merges rather than risking a
    // borderline conflict from picking edits too close together.
    const base = Array.from({ length: 20 }, (_, i) => makeEntry(`topic-${String(i).padStart(2, '0')}`));

    test('new compact format: clean merge, correct count, both edits present, zero duplicates', () => {
      const branchX = base.map((e) => (e.topicId === 'topic-02' ? { ...e, severity: 'HIGH' } : e));
      const branchY = base.map((e) => (e.topicId === 'topic-15' ? { ...e, severity: 'HIGH' } : e));

      const result = runMergeScenario(compactSerialize, base, branchX, branchY);
      assert.equal(result.cleanMerge, true, 'expected a clean merge for far-apart single-field edits');

      const merged = JSON.parse(result.mergedText);
      assert.equal(merged.entries.length, 20, 'no entry silently dropped');
      assert.equal(findDuplicateTopicIds(merged.entries).length, 0);
      const e2 = merged.entries.find((e) => e.topicId === 'topic-02');
      const e15 = merged.entries.find((e) => e.topicId === 'topic-15');
      assert.equal(e2.severity, 'HIGH', "branch X's edit must survive the merge");
      assert.equal(e15.severity, 'HIGH', "branch Y's edit must survive the merge");
    });

    test('old multi-line format: outcome logged, not asserted (git diff3 behavior on repetitive text is not perfectly deterministic)', () => {
      const branchX = base.map((e) => (e.topicId === 'topic-02' ? { ...e, severity: 'HIGH' } : e));
      const branchY = base.map((e) => (e.topicId === 'topic-15' ? { ...e, severity: 'HIGH' } : e));
      const result = runMergeScenario(oldFormatSerialize, base, branchX, branchY);
      if (result.cleanMerge) {
        const merged = JSON.parse(result.mergedText);
        const dups = findDuplicateTopicIds(merged.entries);
        process.stderr.write(
          `  [merge-safety control] old format, Scenario 1: clean merge, `
          + `${merged.entries.length} entries, ${dups.length} duplicate(s)\n`,
        );
      } else {
        process.stderr.write('  [merge-safety control] old format, Scenario 1: conflict\n');
      }
    });
  });

  describe('Scenario 2 — two branches each ADD a new entry with lexicographically adjacent topicIds (mirrors the 14 byte-identical-duplicate pairs)', () => {
    const base = Array.from({ length: 10 }, (_, i) => makeEntry(`topic-${String(i).padStart(2, '0')}`));
    // Both sort strictly between topic-05 and topic-06 — deliberately adjacent
    // to each other, stressing the near-identical-block condition.
    const newEntryX = makeEntry('topic-050');
    const newEntryY = makeEntry('topic-051');

    test('new compact format: never outcome (c) — either a clean, correct merge or a loud conflict, never silent corruption', () => {
      const branchX = [...base, newEntryX];
      const branchY = [...base, newEntryY];
      const result = runMergeScenario(compactSerialize, base, branchX, branchY);

      if (result.cleanMerge) {
        const merged = JSON.parse(result.mergedText);
        assert.equal(merged.entries.length, 12, 'both new entries present, none dropped');
        assert.equal(findDuplicateTopicIds(merged.entries).length, 0);
        assert.ok(merged.entries.some((e) => e.topicId === 'topic-050'), "branch X's new entry must survive");
        assert.ok(merged.entries.some((e) => e.topicId === 'topic-051'), "branch Y's new entry must survive");
      } else {
        assert.equal(result.conflict, true, 'a non-clean merge must be a detected conflict, never neither');
      }
    });

    test('old multi-line format: outcome logged, not asserted', () => {
      const branchX = [...base, newEntryX];
      const branchY = [...base, newEntryY];
      const result = runMergeScenario(oldFormatSerialize, base, branchX, branchY);
      if (result.cleanMerge) {
        const merged = JSON.parse(result.mergedText);
        const dups = findDuplicateTopicIds(merged.entries);
        process.stderr.write(
          `  [merge-safety control] old format, Scenario 2: clean merge, `
          + `${merged.entries.length} entries, ${dups.length} duplicate(s)\n`,
        );
      } else {
        process.stderr.write('  [merge-safety control] old format, Scenario 2: conflict\n');
      }
    });
  });

  test('sanity: writeDebtEntries on a TRACKED legacy file writes no lastUpdated, so far-apart inserts merge cleanly', async () => {
    // The production writer keeps writing a committed, not-yet-migrated legacy
    // file (docs/plans/debt-ledger-per-entry-files.md §2.4 rule 3). It used to
    // stamp a fresh top-level `lastUpdated` on every call, so ANY two branches
    // that recorded debt conflicted on that one line — verified live, every
    // time (upstream report d338aa8a, conflict source 1). With the field gone,
    // inserts that land in different places of the sorted array merge cleanly.
    // (Same-gap inserts still conflict in this form — that is what per-entry
    // storage fixes; tests/debt-ledger-per-entry-merge.test.mjs pins both.)
    const dir = fs.mkdtempSync(path.join(tmpDir, 'repo-prod-'));
    const filePath = path.join(dir, 'tech-debt.json');
    initRepo(dir);
    writeAndCommit(dir, filePath, serializeLedgerForDisk({
      version: 1, lastUpdated: '2026-01-01T00:00:00.000Z',
      entries: Array.from({ length: 5 }, (_, i) => makeEntry(`topic-${i}`)),
    }), 'base');

    gitOk(['checkout', '-q', '-b', 'x'], dir, 'checkout -b x');
    const rx = await writeDebtEntries([makeEntry('aaa-x-new')], { ledgerPath: filePath });
    assert.deepEqual(rx.rejected, []);
    assert.ok(!fs.existsSync(path.join(dir, 'tech-debt')), 'a tracked legacy ledger is not auto-migrated');
    assert.ok(!fs.readFileSync(filePath, 'utf-8').includes('lastUpdated'), 'a pre-existing lastUpdated is stripped on rewrite');
    gitOk(['add', '.'], dir, 'git add x');
    gitOk(['commit', '-q', '-m', 'x adds an entry'], dir, 'commit x');

    gitOk(['checkout', '-q', 'main'], dir, 'checkout main');
    gitOk(['checkout', '-q', '-b', 'y'], dir, 'checkout -b y');
    await writeDebtEntries([makeEntry('zzz-y-new')], { ledgerPath: filePath });
    gitOk(['add', '.'], dir, 'git add y');
    gitOk(['commit', '-q', '-m', 'y adds an entry'], dir, 'commit y');

    gitOk(['checkout', '-q', 'x'], dir, 'checkout x');
    const merge = git(['merge', '--no-edit', 'y'], dir);
    assert.equal(merge.status, 0, `expected a clean merge now that no lastUpdated line exists: ${merge.stdout}${merge.stderr}`);
    const parsedEntries = JSON.parse(fs.readFileSync(filePath, 'utf-8')).entries;
    assert.equal(parsedEntries.length, 7, 'no entry silently dropped');
    assert.ok(parsedEntries.some((e) => e.topicId === 'aaa-x-new') && parsedEntries.some((e) => e.topicId === 'zzz-y-new'));
    assert.equal(findDuplicateTopicIds(parsedEntries).length, 0);
  });
});
