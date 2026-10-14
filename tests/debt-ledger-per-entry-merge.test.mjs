/**
 * @fileoverview The committed tech-debt ledger merges without conflicts — proven
 * on REAL `git merge`s, not on a model of one (docs/plans/debt-ledger-per-entry-files.md
 * §9; upstream report d338aa8a).
 *
 * Two branches each record debt through the production writer (`writeDebtEntries`),
 * then merge. The single-file ledger conflicted on every such merge in a consumer
 * running ~10 parallel sessions: once on the top-level `lastUpdated` every writer
 * bumped, and again whenever two branches inserted neighbouring topicIds into the
 * one sorted array. One file per entry makes new entries different PATHS, so no
 * merge engine can conflict on them.
 *
 * The same-entry cases are not "no conflict" — they are a DEFINED outcome (§2.3):
 * identical edits and edits to separate fields merge; edits to the same field
 * conflict loudly on that one small file and nowhere else.
 *
 * The legacy control keeps the red reproducible after the change: a tracked
 * legacy file (which writers keep writing until it is migrated, §2.4 rule 3)
 * still conflicts on the identical scenario, so this fixture demonstrably CAN
 * detect the defect — a green v2 result is not a blind instrument's green.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { readDebtLedger, writeDebtEntries, removeDebtEntry, serializeLedgerForDisk } from '../scripts/lib/debt-ledger.mjs';
import { gitFixtureEnv, gitInit, makeGitRunner, mkdtemp, rmrfBestEffort } from './helpers/fixtures.mjs';

let dir;
let git;
let ledgerPath;

function makeEntry(topicId, overrides = {}) {
  return {
    source: 'debt',
    topicId,
    semanticHash: `h-${topicId}`,
    severity: 'MEDIUM',
    category: 'test',
    section: `src/${topicId}.js:1`,
    detailSnapshot: `details for ${topicId}`,
    affectedFiles: [`src/${topicId}.js`],
    affectedPrinciples: [],
    pass: 'backend',
    deferredReason: 'out-of-scope',
    deferredAt: '2026-10-01T10:00:00.000Z',
    deferredRun: 'r1',
    deferredRationale: `a sufficiently long rationale string for ${topicId}`,
    contentAliases: [],
    sensitive: false,
    ...overrides,
  };
}

const baseIds = Array.from({ length: 50 }, (_, i) => `topic-${String(i).padStart(4, '0')}`);

/** Run `git merge` and classify the outcome by porcelain status, never by exit code alone. */
function merge(branch) {
  const r = spawnSync('git', ['merge', '--no-edit', branch], { cwd: dir, encoding: 'utf-8', env: gitFixtureEnv() });
  assert.ok(r.status === 0 || r.status === 1, `git merge failed operationally (exit ${r.status}): ${r.stderr}`);
  const unmerged = git(['status', '--porcelain'])
    .split('\n')
    .filter((l) => /^(UU|AA|DU|UD|AU|UA|DD) /.test(l))
    .map((l) => ({ code: l.slice(0, 2), path: l.slice(3).trim() }));
  return { status: r.status, unmerged };
}

function commitAll(message) {
  git(['add', '-A']);
  git(['commit', '-q', '-m', message]);
}

const read = () => readDebtLedger({ ledgerPath, events: [] });

/** The production writer — and a rejected entry fails the test rather than leaving a branch with nothing to merge. */
async function record(entries, opts) {
  const r = await writeDebtEntries(entries, opts);
  assert.deepEqual(r.rejected.map((x) => x.reason), [], 'every fixture entry is schema-valid');
  return r;
}

beforeEach(async () => {
  dir = mkdtemp('debt-per-entry-merge-');
  gitInit(dir);
  git = makeGitRunner(() => dir);
  git(['checkout', '-q', '-b', 'main']);
  ledgerPath = path.join(dir, '.audit', 'tech-debt.json');
});
afterEach(() => {
  rmrfBestEffort(dir);
});

async function seedBase() {
  await record(baseIds.map((id) => makeEntry(id)), { ledgerPath });
  commitAll('base ledger');
}

describe('per-entry ledger — new entries never conflict', () => {
  test('neighbouring new topicIds on two branches merge cleanly into an exact union', async () => {
    await seedBase();
    // All four new ids sort into the SAME gap (between topic-0010 and topic-0011),
    // interleaved across the branches — the #900 shape that conflicted on the
    // single sorted array.
    git(['checkout', '-q', '-b', 'ours']);
    await record([makeEntry('topic-0010a'), makeEntry('topic-0010c')], { ledgerPath });
    commitAll('ours: two debts');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([makeEntry('topic-0010b'), makeEntry('topic-0010d')], { ledgerPath });
    commitAll('theirs: two debts');

    git(['checkout', '-q', 'ours']);
    const out = merge('theirs');
    assert.equal(out.status, 0, `expected a clean merge, got unmerged: ${JSON.stringify(out.unmerged)}`);
    assert.deepEqual(out.unmerged, []);

    const ledger = read();
    assert.equal(ledger.available, true);
    assert.equal(ledger.entries.length, 54, 'base 50 + ours 2 + theirs 2 — an exact union');
    const ids = new Set(ledger.entries.map((e) => e.topicId));
    assert.equal(ids.size, 54, 'no duplicate topicIds');
    for (const id of ['topic-0010a', 'topic-0010b', 'topic-0010c', 'topic-0010d']) {
      const e = ledger.entries.find((x) => x.topicId === id);
      assert.ok(e, `${id} present`);
      assert.equal(e.detailSnapshot, `details for ${id}`, `${id} carries its own branch's content`);
    }
  });

  test('a removal on one branch and an unrelated addition on the other merge cleanly', async () => {
    await seedBase();
    git(['checkout', '-q', '-b', 'ours']);
    assert.equal(await removeDebtEntry('topic-0003', { ledgerPath }), true);
    commitAll('ours: resolve topic-0003');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([makeEntry('topic-0003a')], { ledgerPath });
    commitAll('theirs: add topic-0003a');

    git(['checkout', '-q', 'ours']);
    const out = merge('theirs');
    assert.equal(out.status, 0, JSON.stringify(out.unmerged));
    const ids = read().entries.map((e) => e.topicId);
    assert.ok(!ids.includes('topic-0003'), 'the removal survives the merge');
    assert.ok(ids.includes('topic-0003a'), 'the addition survives the merge');
    assert.equal(ids.length, 50);
  });

  test('ids differing only in letter case, added on two branches, merge cleanly and both read back', async () => {
    await seedBase();
    git(['checkout', '-q', '-b', 'ours']);
    await record([makeEntry('Abc1')], { ledgerPath });
    commitAll('ours: Abc1');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([makeEntry('abc1')], { ledgerPath });
    commitAll('theirs: abc1');

    git(['checkout', '-q', 'ours']);
    const out = merge('theirs');
    assert.equal(out.status, 0, JSON.stringify(out.unmerged));
    const ids = read().entries.map((e) => e.topicId);
    assert.ok(ids.includes('Abc1') && ids.includes('abc1'), `both case variants present: ${ids.filter((i) => /abc1/i.test(i))}`);
    const names = fs.readdirSync(path.join(dir, '.audit', 'tech-debt', 'entries'));
    const folded = names.map((n) => n.toLowerCase());
    assert.equal(new Set(folded).size, folded.length, 'no two entry filenames fold to the same name');
  });
});

describe('per-entry ledger — the same entry on two branches has a defined outcome', () => {
  async function branchEdits(oursEntry, theirsEntry) {
    await seedBase();
    git(['checkout', '-q', '-b', 'ours']);
    await record([oursEntry], { ledgerPath });
    commitAll('ours: update');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([theirsEntry], { ledgerPath });
    commitAll('theirs: update');
    git(['checkout', '-q', 'ours']);
    return merge('theirs');
  }

  test('identical updates merge cleanly', async () => {
    const edited = makeEntry('topic-0020', { deferredRationale: 'both branches re-recorded this with the same rationale' });
    const out = await branchEdits(edited, edited);
    assert.equal(out.status, 0, JSON.stringify(out.unmerged));
    assert.equal(read().entries.find((e) => e.topicId === 'topic-0020').deferredRationale, edited.deferredRationale);
  });

  test('updates to separate fields merge cleanly and keep both edits', async () => {
    const out = await branchEdits(
      makeEntry('topic-0020', { deferredRationale: 'ours rewrote the rationale for this entry' }),
      makeEntry('topic-0020', { contentAliases: ['a1b2c3d4'] }),
    );
    assert.equal(out.status, 0, JSON.stringify(out.unmerged));
    const e = read().entries.find((x) => x.topicId === 'topic-0020');
    assert.equal(e.deferredRationale, 'ours rewrote the rationale for this entry');
    assert.deepEqual(e.contentAliases, ['a1b2c3d4']);
  });

  test('updates to the same field conflict loudly on that one entry file, and nowhere else', async () => {
    const out = await branchEdits(
      makeEntry('topic-0020', { deferredRationale: 'ours says the rationale is this one' }),
      makeEntry('topic-0020', { deferredRationale: 'theirs says the rationale is that one' }),
    );
    assert.equal(out.status, 1);
    assert.deepEqual(out.unmerged, [{ code: 'UU', path: '.audit/tech-debt/entries/topic-0020.json' }]);
    // A leftover conflict marker is corruption, and corruption is loud.
    assert.throws(() => read(), /topic-0020/);
    git(['merge', '--abort']);
  });

  test('a removal against a modification conflicts on that one entry file', async () => {
    await seedBase();
    git(['checkout', '-q', '-b', 'ours']);
    assert.equal(await removeDebtEntry('topic-0020', { ledgerPath }), true);
    commitAll('ours: resolve');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([makeEntry('topic-0020', { deferredRationale: 'theirs is still deferring this one' })], { ledgerPath });
    commitAll('theirs: update');
    git(['checkout', '-q', 'ours']);
    const out = merge('theirs');
    assert.equal(out.status, 1);
    assert.equal(out.unmerged.length, 1);
    assert.equal(out.unmerged[0].path, '.audit/tech-debt/entries/topic-0020.json');
    git(['merge', '--abort']);
  });
});

describe('legacy control — the fixture can see the defect', () => {
  test('a tracked legacy single-file ledger still conflicts on neighbouring inserts', async () => {
    // Seed the LEGACY form and track it: writers keep writing it (minus
    // lastUpdated) until it is migrated deliberately (plan §2.4 rule 3).
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    fs.writeFileSync(ledgerPath, serializeLedgerForDisk({ version: 1, entries: baseIds.map((id) => makeEntry(id)) }));
    commitAll('base legacy ledger');

    git(['checkout', '-q', '-b', 'ours']);
    await record([makeEntry('topic-0010a'), makeEntry('topic-0010c')], { ledgerPath });
    commitAll('ours: two debts');
    git(['checkout', '-q', 'main']);
    git(['checkout', '-q', '-b', 'theirs']);
    await record([makeEntry('topic-0010b'), makeEntry('topic-0010d')], { ledgerPath });
    commitAll('theirs: two debts');

    assert.ok(fs.existsSync(ledgerPath), 'the tracked legacy file is still the storage');
    assert.ok(!fs.existsSync(path.join(dir, '.audit', 'tech-debt')), 'a tracked legacy ledger is never auto-migrated');
    git(['checkout', '-q', 'ours']);
    const out = merge('theirs');
    assert.equal(out.status, 1, 'the single sorted array conflicts on same-gap inserts');
    assert.deepEqual(out.unmerged, [{ code: 'UU', path: '.audit/tech-debt.json' }]);
    git(['merge', '--abort']);
  });
});
