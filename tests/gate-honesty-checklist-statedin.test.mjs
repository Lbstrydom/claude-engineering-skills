/**
 * @fileoverview `statedIn` may cite a diff-triggered checklist entry (`.audit-loop/checklist.json#<id>`), verification-lessons
 * plan Phase 5. The closed source-authority policy gains exactly one spelling, and the per-gate check reads `stated` from the
 * ENTRY's `check` text. Each refusal below is a defect class this check exists to catch, seen failing on its own fixture.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateCliGateContract, validateGateContract, isApprovedStatedInSource, checklistRefId } from '../scripts/lib/gate-honesty/schema.mjs';

// Every temp dir this file makes is removed when it finishes.
const TMP_DIRS = [];
function mkTmp(prefix) { const d = fs.mkdtempSync(prefix); TMP_DIRS.push(d); return d; }
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });


// The contract file every fixture entry names in its gateContract: the validator now REQUIRES the file (no suffix fallback).
const FILE = 'scripts/gate-contracts/demo-gate.json';
const STATED = 'An exit that stdout can reach must drain first';

function fixture({ entries, statedIn = '.audit-loop/checklist.json#drain-first', stated = STATED, writeChecklist = true }) {
  const root = mkTmp(path.join(os.tmpdir(), 'gh-checklist-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(root, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'impl.mjs'), '// impl\n');
  fs.writeFileSync(path.join(root, 'tests', 'impl.test.mjs'), '// gate id: drain-gate-demo\n');
  if (writeChecklist) {
    fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(root, '.audit-loop', 'checklist.json'), JSON.stringify({ version: 1, entries }));
  }
  const contract = {
    version: 1, gate: 'demo:gate', guards: 'x',
    gates: [{
      id: 'drain-gate-demo', kind: 'executable', statedIn, stated, implementation: 'scripts/impl.mjs', tests: ['tests/impl.test.mjs'],
      proof: 'process', oracle: 'poison-pill',
      poisonPill: { isolation: 'tmpdir', argv: ['x.mjs'], mutate: { 'scripts/impl.mjs': { path: 'a', value: 1 } }, expectStderr: 'boom', why: 'demo' },
    }],
  };
  return { root, contract };
}

const goodEntry = (over = {}) => ({
  id: 'drain-first', trigger: { paths: ['scripts/**'] }, check: `Exit through finishAndExit. ${STATED}.`, incident: 'i',
  control: { path: 'scripts/x.mjs', text: 'process.exit(1)' }, gateContract: 'scripts/gate-contracts/demo-gate.json#drain-gate-demo', stated: STATED, ...over,
});

test('the policy admits exactly one new spelling: a well-formed checklist reference', () => {
  assert.equal(checklistRefId('.audit-loop/checklist.json#drain-first'), 'drain-first');
  assert.equal(isApprovedStatedInSource('.audit-loop/checklist.json#drain-first', 'ship'), true);
  for (const bad of ['.audit-loop/checklist.json', '.audit-loop/checklist.json#', '.audit-loop/checklist.json#Bad_Id', '../.audit-loop/checklist.json#x', 'docs/checklist.json#x', 'AGENTS.md#x', '.audit-loop/checklist.json#a#b']) {
    assert.equal(isApprovedStatedInSource(bad, 'ship'), false, bad);
  }
});

test('a bound entry carrying the sentence verbatim in its check is accepted (CLI gate and skill contracts alike)', () => {
  const { root, contract } = fixture({ entries: [goodEntry()] });
  assert.deepEqual(validateCliGateContract(contract, root, { file: FILE }), { ok: true, contract: validateCliGateContract(contract, root, { file: FILE }).contract });
  const skill = { version: 1, skill: 'demo', gates: contract.gates };
  assert.equal(validateGateContract(skill, root, { file: FILE }).ok, true);
});

test('the sentence missing from the entry\'s check is drift, and says so', () => {
  const { root, contract } = fixture({ entries: [goodEntry({ check: 'Exit through finishAndExit.' })] });
  const r = validateCliGateContract(contract, root, { file: FILE });
  assert.equal(r.ok, false);
  // The entry's own strict schema refuses a `stated` its `check` does not carry, before the per-gate comparison is even reached.
  assert.match(r.errors.join(' '), /must occur verbatim in `check`|not found verbatim in the entry's check text/);
});

test('an id that does not exist, a missing file, and a malformed file are each their own error', () => {
  const noId = fixture({ entries: [goodEntry({ id: 'other', gateContract: 'a.json#drain-gate-demo' })] });
  assert.match(validateCliGateContract(noId.contract, noId.root, { file: FILE }).errors.join(' '), /no checklist entry with id "drain-first"/);
  const noFile = fixture({ entries: [], writeChecklist: false });
  assert.match(validateCliGateContract(noFile.contract, noFile.root, { file: FILE }).errors.join(' '), /does not exist/);
  const broken = fixture({ entries: [] });
  fs.writeFileSync(path.join(broken.root, '.audit-loop', 'checklist.json'), '{ nope');
  assert.match(validateCliGateContract(broken.contract, broken.root, { file: FILE }).errors.join(' '), /not readable JSON/);
});

test('an entry that is not bound back to THIS gate, or declares a different stated, is refused', () => {
  const unbound = fixture({ entries: [goodEntry({ gateContract: 'scripts/gate-contracts/demo-gate.json#some-other-gate' })] });
  assert.match(validateCliGateContract(unbound.contract, unbound.root, { file: FILE }).errors.join(' '), /not bound back to this gate/);
  const other = fixture({ entries: [goodEntry({ stated: 'a different sentence', check: `${STATED}. a different sentence` })] });
  assert.match(validateCliGateContract(other.contract, other.root, { file: FILE }).errors.join(' '), /declares a different `stated`/);
});

test('a CRLF checklist does not read as drift (same canonicalisation as every other stated source)', () => {
  const { root, contract } = fixture({ entries: [goodEntry({ check: `line one\r\n${STATED}.` })] });
  assert.equal(validateCliGateContract(contract, root, { file: FILE }).ok, true);
});

test('AGENTS.md remains legal, and the old unrelated sources remain illegal', () => {
  const { root, contract } = fixture({ entries: [goodEntry()], statedIn: 'docs/plans/x.md' });
  assert.equal(validateCliGateContract(contract, root, { file: FILE }).ok, false);
  assert.equal(isApprovedStatedInSource('AGENTS.md', 'ship'), true);
});
