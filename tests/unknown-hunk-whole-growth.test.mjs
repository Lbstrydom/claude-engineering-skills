/**
 * @fileoverview An over-budget file in a round with NO diff evidence grows whole into the pass's leftover budget
 * instead of staying head-cut at `maxPerFile` — so a mid-size file (a 11k-char git hook script) reads FULL, while a
 * file no pass can afford whole still reads PARTIAL.
 *
 * Field case (wine-cellar-app 440a03a15): `.githooks/pre-push.local`, 11,199 chars, model-only, R1 without `--diff`.
 * Every pass cut it at its `maxPerFile` (best 8,000 in backend) though backend's 80,000-char budget had room for it,
 * and the ledger read it `head-cut` / PARTIAL. The cut was never class-specific: any language over `maxPerFile`
 * without hunks was head-cut; the JS file in the same run read FULL only because it was 4,757 chars.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { readFilesAsContextDetailed } from '../scripts/lib/audit-scope.mjs';
import { readFilesAsAnnotatedContextDetailed } from '../scripts/lib/diff-annotation.mjs';
import { startCoverage, buildCoverageReport, makeCoverageInput } from '../scripts/lib/audit/file-coverage.mjs';
import { shortCoverageFiles } from '../scripts/lib/coverage-format.mjs';
import { mkdtemp } from './helpers/fixtures.mjs';

const HOOK = '.githooks/pre-push.local';

/** A shell hook of about `chars` characters, every line naming its own number. */
function hookText(chars) {
  const lines = ['#!/bin/sh', 'set -eu'];
  for (let i = 3; lines.join('\n').length < chars; i++) lines.push(`echo "line ${String(i).padStart(4, '0')}: checking ${'x'.repeat(40)}"`);
  return lines.join('\n') + '\n';
}

function inTempDir(t, files) {
  const dir = mkdtemp('unknown-hunk-growth-');
  const prev = process.cwd();
  t.after(() => { process.chdir(prev); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
  process.chdir(dir);
}

/**
 * Run the field round's four passes through the measured seam and build the ledger. The field round named its files
 * explicitly (no VCS change record, no `--diff`), so the hunk map is not applicable — the case this covers. (A
 * `--scope diff` round already reads such a file as wholly changed and grows its window: hunk-evidence.mjs.)
 */
function auditRound() {
  const diffMap = null;
  const { recorder, renderFor } = startCoverage({
    getDiffMap: () => diffMap, plain: readFilesAsContextDetailed, annotated: readFilesAsAnnotatedContextDetailed,
    setChunkingObserver: () => {}, coverageChanged: null, changedFiles: [HOOK],
  });
  const budgets = { structure: [2000, 30000], backend: [8000, 80000], sustainability: [4000, 60000], quickfix: [4000, 60000] };
  const contexts = {};
  for (const [pass, [maxPerFile, maxTotal]] of Object.entries(budgets)) {
    contexts[pass] = renderFor(pass, [HOOK], { maxPerFile, maxTotal });
    recorder.markPass(pass, true);
  }
  const input = makeCoverageInput({
    recorder, coverageChanged: null, changedFiles: [HOOK], fileFilter: null,
    coverageExcluded: null, diffMap, toolCapability: {}, noTools: true,
  });
  const cov = buildCoverageReport(input);
  return { cov, contexts, file: cov.files.find((f) => f.path === HOOK) };
}

describe('over-budget file, no diff evidence: grow whole into leftover budget', () => {
  test('an 11k-char shell hook reads FULL (backend renders it whole)', (t) => {
    const text = hookText(11_199);
    inTempDir(t, { [HOOK]: text });
    const { cov, contexts, file } = auditRound();
    assert.equal(file.class, 'model-only');
    assert.equal(file.read.state, 'full');
    assert.equal(file.read.byPass.backend.headCut, false, 'backend had 80,000 chars of budget: the whole file fits');
    assert.ok(contexts.backend.includes(text.trimEnd().split('\n').at(-1)), 'the LAST line reached the backend pass');
    assert.ok(!contexts.backend.includes('[TRUNCATED'), 'no head-cut marker');
    for (const [pass, v] of Object.entries(file.read.byPass)) assert.equal(v.headCut, false, `${pass}: every budget here holds 11k whole`);
    assert.equal(shortCoverageFiles(cov).length, 0, 'nothing is short');
  });

  test('a file over every pass budget still reads PARTIAL — head-cut, never clean', (t) => {
    const text = hookText(90_000);   // > backend's 80,000 maxTotal: no pass can afford it whole
    inTempDir(t, { [HOOK]: text });
    const { cov, contexts, file } = auditRound();
    assert.equal(file.read.state, 'head-cut');
    assert.equal(file.read.bestCharsRendered, 8000);
    assert.equal(file.changedLinesUnread, null, 'unmeasurable, never a clean 0');
    assert.ok(contexts.backend.includes('[TRUNCATED'));
    assert.deepEqual(shortCoverageFiles(cov).map((f) => f.path), [HOOK]);
  });

  test('growth never omits another file: bases are placed first', (t) => {
    const big = hookText(11_199);
    const small = 'echo small\n';
    inTempDir(t, { [HOOK]: big, 'b.sh': small });
    const tight = readFilesAsContextDetailed([HOOK, 'b.sh'], { maxPerFile: 8000, maxTotal: 9000, growUnknownWhole: true });
    assert.deepEqual(tight.stats.full, ['b.sh']);
    assert.equal(tight.stats.headTruncated[0].path, HOOK, 'no room to grow: the head cut stays');
    assert.deepEqual(tight.stats.budgetOmitted, []);
  });

  test('negative control: without the option the reader head-cuts exactly as before', (t) => {
    inTempDir(t, { [HOOK]: hookText(11_199) });
    const before = readFilesAsContextDetailed([HOOK], { maxPerFile: 8000, maxTotal: 80000 });
    assert.equal(before.stats.headTruncated[0].charsRendered, 8000);
    assert.deepEqual(before.stats.full, []);
  });

  test('with diff evidence the hunk window governs, not whole-file growth', (t) => {
    const text = hookText(11_199);
    inTempDir(t, { [HOOK]: text });
    const known = readFilesAsContextDetailed([HOOK], {
      maxPerFile: 8000, maxTotal: 80000, growUnknownWhole: true, hunksFor: () => [{ startLine: 5, lineCount: 1 }],
    });
    assert.equal(known.stats.headTruncated[0].windowed, true, 'known hunks: the window (and its own growth rule) applies');
  });
});
