/**
 * Deviation 1 (T1-only re-freeze): the signed record, its digest binding, the explicit calibration bridge, the freeze-time git precheck and the
 * T2 limitation carried into the score output. Controls: every mismatch the bridge must refuse is refused, and the happy path is accepted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDeviation, DEVIATION_1_SHA256 } from '../scripts/lib/audit/pilot-deviation.mjs';
import { canonicalSha256 } from '../scripts/lib/audit/pilot-novelty-audit.mjs';
import { assertAmendment, gitPrecheck, scorePilot } from '../scripts/lib/audit/step-back-pilot-cli.mjs';

const DEV = path.resolve('docs/experiments/seeded-bench/deviation-1-t1-only.json');
const AMENDMENT = path.resolve('docs/experiments/seeded-bench/amendment-2-novelty-audit.json');
const dev = JSON.parse(fs.readFileSync(DEV, 'utf8'));
const ds = { datasetHash: dev.bridge.toDatasetHash, scope: 'T1-only', deviation: 'deviation-1' };
const cal = { datasetHash: dev.bridge.fromDatasetHash, labels: 260 };
// The committed digest binds the REAL calibration report (outside the repo); tests bind a stand-in report through an injected digest.
const devFor = (report, patch = {}) => { const d = { ...dev, ...patch, bridge: { ...dev.bridge, fromReportSha256: canonicalSha256(report), ...(patch.bridge || {}) } }; return { d, text: JSON.stringify(d), digest: canonicalSha256(d) }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dev-'));
const RM = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

test('the signed deviation validates for exactly its two dataset hashes and carries the signature and the reporting requirement', () => {
  const own = devFor(cal);
  const d = readDeviation(DEV, { dataset: ds, calibration: cal, readText: () => own.text, digest: own.digest });
  assert.equal(d.signature.signedWords, 'T1-only pilot - yes proceed - I approve'); assert.match(d.signature.condition, /before any pilot data/);
  assert.match(d.reportingRequirement, /T1 decision only/); assert.equal(canonicalSha256(dev), DEVIATION_1_SHA256, 'the committed file is the approved content');
});

test('the bridge refuses every mismatch: wrong dataset, wrong calibration, a non-T1 dataset, a changed epoch, a tampered file', () => {
  const own = devFor(cal);
  const bad = (over, opts) => assert.throws(() => readDeviation(DEV, { dataset: ds, calibration: cal, readText: () => own.text, digest: own.digest, ...opts }), over);
  bad(/fromReportSha256/, { calibration: { ...cal, labels: 261 } }); // same dataset, DIFFERENT report content
  bad(/different dataset/, { dataset: { ...ds, datasetHash: 'x' } });
  bad(/not the one this deviation bridges/, { calibration: { datasetHash: 'y' } });
  bad(/not the T1-only freeze/, { dataset: { ...ds, scope: undefined } });
  const t = (patch) => ({ readText: () => JSON.stringify({ ...dev, ...patch }) });
  bad(/epoch/, t({ epoch: 'seeded-bench-v1' }));
  bad(/signature incomplete/, t({ signature: { ...dev.signature, signedWords: '' } }));
  bad(/digest does not match/, t({ bridge: { ...dev.bridge, seed: 'other' } }));
});

test('novelty accepts the old calibration report only through the bridge (and the same-dataset report without one)', () => {
  const dir = tmp();
  try {
    const calPath = path.join(dir, 'c.json');
    const rep = { decision: 'inconclusive', spentUsd: 2.2, datasetHash: dev.bridge.fromDatasetHash, judges: { opus: { stamp: { m: 1 } }, pro: { stamp: { m: 1 } } } };
    fs.writeFileSync(calPath, JSON.stringify(rep));
    assert.throws(() => assertAmendment({ amendmentPath: AMENDMENT, calibrationPath: calPath, dataset: ds }), /--deviation/);
    const own = devFor(rep); const devPath = path.join(dir, 'dev.json'); fs.writeFileSync(devPath, own.text);
    assert.doesNotThrow(() => assertAmendment({ amendmentPath: AMENDMENT, calibrationPath: calPath, deviationPath: devPath, deviationDigest: own.digest, dataset: ds }));
    assert.throws(() => assertAmendment({ amendmentPath: AMENDMENT, calibrationPath: calPath, deviationPath: devPath, deviationDigest: own.digest, dataset: { ...ds, datasetHash: 'z' } }), /different dataset/);
    fs.writeFileSync(calPath, JSON.stringify({ ...rep, datasetHash: ds.datasetHash }));
    assert.doesNotThrow(() => assertAmendment({ amendmentPath: AMENDMENT, calibrationPath: calPath, dataset: ds }), 'a report of the new dataset itself needs no bridge');
  } finally { RM(dir); }
});

test('gitPrecheck: a plan file absent from the tree, or a code point with no diff base, is unrecoverable at freeze', () => {
  const repo = { localPath: '/r' };
  const point = { mode: 'plan', treeSha: 'abc', planFile: 'docs/plans/p.md' };
  assert.equal(gitPrecheck({ repo, point }, { git: () => 'blob' }).ok, true);
  const gone = Object.assign(new Error('missing'), { status: 128 });
  assert.match(gitPrecheck({ repo, point }, { git: () => { throw gone; } }).reason, /plan file absent/);
  assert.match(gitPrecheck({ repo, point }, { git: () => 'tree' }).reason, /tree, not a file/, 'a DIRECTORY at the plan path is not a plan file');
  assert.throws(() => gitPrecheck({ repo, point }, { git: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } }), /freeze cannot decide/, 'a git failure is a freeze failure, never a quietly excluded point');
  assert.match(gitPrecheck({ repo: {}, point }, { git: () => '' }).reason, /no local clone/);
  const code = { ...point, mode: 'code', firstSha: null };
  assert.equal(gitPrecheck({ repo, point: code }, { git: (cwd, args) => (args[0] === 'cat-file' ? 'blob' : null) }).ok, false, 'no merge-base and no first sha: no diff base');
});

test('the T2 limitation travels with the score output', () => {
  const scope = { scope: 'T1-only', excludedTriggers: { T2: 'x' }, deviation: 'deviation-1' };
  const key = { items: {}, audit: { hidden: 0, sampled: 0, byArm: {}, all: true, sample: 80, upperBoundMax: 0.15, confidence: 0.95 } };
  const r = scorePilot({ rows: [], novelty: { byFinding: {}, incomplete: false }, key, labelsById: new Map(), plannedPairs: 32, scope });
  assert.deepEqual(r.scope, scope);
});
