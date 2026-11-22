/**
 * @fileoverview Positive controls for CES's own checklist (verification-lessons plan, section 2.5, Phase 5).
 *
 * A checklist entry whose trigger silently stopped matching reads as "nothing to check", the failure that is invisible by
 * construction. So every entry carries a CONTROL (a path plus a synthetic added line) that must fire it, and a NEGATIVE path
 * (carrying a neutral line) that must not. The control is run through the REAL path (a unified-diff file through
 * `matchChecklist`), not through the pure helper, so the test and the audit share one input.
 *
 * Also pins the other half of the gate-contract migration: every contract that cites `.audit-loop/checklist.json#<id>` has an
 * entry bound back to it, and no entry claims a contract that does not cite it.
 */
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadChecklist } from '../scripts/lib/checklist/schema.mjs';
import { matchChecklist } from '../scripts/lib/checklist/match.mjs';
import { checklistRefId } from '../scripts/lib/gate-honesty/schema.mjs';

// Every temp dir this file makes is removed when it finishes.
const TMP_DIRS = [];
function mkTmp(prefix) { const d = fs.mkdtempSync(prefix); TMP_DIRS.push(d); return d; }
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });


const REPO = path.resolve(import.meta.dirname, '..');
const NEUTRAL = 'const x = 1;';
const loaded = loadChecklist({ repoRoot: REPO });

/** Fire a one-line added diff at `filePath` through the real matcher. */
function fireOn(entry, filePath, text) {
  const dir = mkTmp(path.join(os.tmpdir(), 'checklist-control-'));
  const patch = path.join(dir, 'c.patch');
  fs.writeFileSync(patch, `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -0,0 +1 @@\n+${text}\n`);
  const r = matchChecklist({ entries: [entry], diffPath: patch, purpose: 'control', cwd: dir, logPath: path.join(dir, 'fires.jsonl'), runId: 'control' });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.fired.length === 1;
}

const controlFires = (e) => fireOn(e, e.control.path, e.control.text);
const negativeStaysSilent = (e) => !fireOn(e, e.control.negativePath, NEUTRAL);

test('the checklist file is present, valid, and non-empty (CES dogfoods its own tool)', () => {
  assert.equal(loaded.ok, true, loaded.error);
  assert.equal(loaded.absent, false);
  assert.ok(loaded.entries.length > 0);
});

describe('every entry\'s control fires it and its negative stays silent', () => {
  for (const e of loaded.entries ?? []) {
    test(e.id, () => {
      assert.equal(controlFires(e), true, `control for ${e.id} did not fire: ${e.control.path} :: ${e.control.text}`);
      assert.ok(e.control.negativePath, `${e.id} declares no negativePath: a control with no negative cannot tell a trigger from a match-everything glob`);
      assert.equal(negativeStaysSilent(e), true, `${e.id} fired on its negative path ${e.control.negativePath}`);
    });
  }
});

test('the instrument is seen to fail: a broken control and a match-everything trigger are both caught', () => {
  const real = loaded.entries[0];
  const broken = { ...real, control: { ...real.control, path: 'no/such/place.txt', text: 'nothing here' }, trigger: { paths: ['only/this/**'] } };
  assert.equal(controlFires(broken), false, 'a control that does not match its trigger must read as a failure');
  const greedy = { ...real, trigger: { paths: ['**'] } };
  assert.equal(negativeStaysSilent(greedy), false, 'a trigger that matches everything must fail its negative');
});

describe('pilot: each gate-backed entry mirrors its contract, and the contract still protects the sentence in AGENTS.md', () => {
  // While the pilot runs, the sentence lives in BOTH places. Its gate contract keeps statedIn AGENTS.md (moving it would
  // un-protect a sentence AGENTS.md still carries: a loosening). The contract repoints to the checklist only when the
  // sentence leaves AGENTS.md, in the same commit (docs/research/checklist-pilot-2026-11.md, Decision).
  const agents = fs.readFileSync(path.join(REPO, 'AGENTS.md'), 'utf8');
  const backed = loaded.entries.filter((x) => x.gateContract);

  test('EVERY AGENTS.md-stated gate except the one kernel gate has exactly one entry naming it back (no silent drop)', () => {
    const KERNEL = new Set([
      'size-ratchet-rejects-growth-past-the-baseline', // inventory: kernel - its trigger is a file attribute
      'checklist-gen-check-detects-a-hand-edit',      // the checklist's OWN freshness gate (added with it), not an inventoried tripwire
    ]);
    const files = [
      ...fs.readdirSync(path.join(REPO, 'scripts', 'gate-contracts')).filter((f) => f.endsWith('.json') && !f.startsWith('_')).map((f) => `scripts/gate-contracts/${f}`),
      ...fs.readdirSync(path.join(REPO, 'skills')).map((d) => `skills/${d}/gate-contract.json`).filter((f) => fs.existsSync(path.join(REPO, f))),
    ];
    const expected = [];
    for (const file of files) {
      for (const g of JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')).gates ?? []) {
        if (g.statedIn === 'AGENTS.md' && !KERNEL.has(g.id)) expected.push(`${file}#${g.id}`);
      }
    }
    assert.ok(expected.length >= 26, `census found only ${expected.length} AGENTS.md-stated gates`);
    for (const ref of expected) {
      const n = backed.filter((e) => e.gateContract === ref).length;
      assert.equal(n, 1, `${ref}: ${n} checklist entries name this gate (expected exactly 1)`);
    }
    assert.equal(backed.length, expected.length, 'an entry names a gate outside the census');
  });

  test('every gate-backed entry names a real gate whose stated sentence it carries verbatim, and the gate still cites AGENTS.md', () => {
    for (const e of backed) {
      const [file, gateId] = e.gateContract.split('#');
      const gate = (JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')).gates ?? []).find((g) => g.id === gateId);
      assert.ok(gate, `${e.id}: ${e.gateContract} names no such gate`);
      assert.equal(e.stated, gate.stated, `${e.id}: stated drifted from its contract`);
      assert.ok(e.check.includes(gate.stated), `${e.id}: check does not carry the stated sentence`);
      assert.equal(gate.statedIn, 'AGENTS.md', `${e.id}: the contract must keep protecting the AGENTS.md sentence during the pilot`);
      assert.ok(agents.includes(gate.stated), `${e.id}: the sentence is no longer in AGENTS.md`);
    }
  });
});

test('every commit an incident cites exists (skipped on a shallow clone)', (t) => {
  const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let shallow;
  try { shallow = git('rev-parse', '--is-shallow-repository') === 'true'; } catch { t.skip('not a git checkout'); return; }
  if (shallow) { t.skip('shallow clone: history is not available'); return; }
  for (const e of loaded.entries) {
    // `debt 3627c83a` is a ledger id, not a commit.
    const text = e.incident.replace(/debt [0-9a-f]{8}/g, '');
    for (const sha of text.match(/\b[0-9a-f]{8}\b/g) ?? []) {
      assert.doesNotThrow(() => git('cat-file', '-e', `${sha}^{commit}`), `${e.id} cites ${sha}, which is not a commit here`);
    }
  }
});
