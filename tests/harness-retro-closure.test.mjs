/**
 * Harness retro — enforce/reject: preflight writes nothing on bad input; the
 * registry append and the friction-mirror link are idempotent (plan §2 c13).
 * v1 does not touch MEMORY.md (right-sizing gate, cut 3).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDecision, preflightDecision } from '../scripts/lib/friction/retro/closure.mjs';
import { readRegistry } from '../scripts/lib/friction/retro/registry.mjs';

const A = 'aaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbb';
const scan = {
  scanId: '20261116T120000000Z-abcdef', fingerprintVersion: 1,
  fingerprints: { [A]: { kind: 'hook_error', tool: 'UserPromptSubmit', label: 'x' }, [B]: { kind: 'tool_error', tool: 'Bash', label: 'y' } },
  candidates: [{ fingerprint: A }],
  tripwires: [{ identity: 'tripwire:feedback_hook', status: 'promotion-candidate', matchedFingerprints: [A, B] }],
  sessions: [{ sessionKey: 's1', counts: { [A]: 1, [B]: 1 } }, { sessionKey: 's2', counts: { [A]: 1 } }],
};

let repo; let mem;
beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-close-repo-'));
  mem = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-close-mem-'));
  fs.mkdirSync(path.join(repo, 'tests'));
  fs.writeFileSync(path.join(repo, 'tests', 'hook.test.mjs'), `it('${A} tripwire:feedback_hook', () => {});\n`);
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [Hook](feedback_hook.md) — relative hook paths\n');
  fs.writeFileSync(path.join(mem, 'feedback_hook.md'), '---\nname: feedback_hook\ndescription: d\nmetadata:\n  type: feedback\n---\nbody\n');
});
const args = (over = {}) => ({
  decision: 'enforced', identity: 'tripwire:feedback_hook', scan, test: 'tests/hook.test.mjs', layer: 'gate',
  summary: 'hook commands resolve from the project dir', repoRoot: repo, memoryDir: mem, ...over,
});
const registryExists = () => fs.existsSync(path.join(repo, '.harness-retro', 'decisions.json'));

describe('preflight', () => {
  // gate-contract: enforce-refuses-unscanned-identity (skills/harness-retro/gate-contract.json) — the
  // red direction is the cli-exit scenario; the green direction is 'enforce: one registry entry…' below.
  it('writes NOTHING when any input is bad', async () => {
    for (const bad of [{ test: 'tests/missing.test.mjs' }, { test: '.' }, { layer: 'vibes' }, { summary: 'see C:\\Users\\bob' }, { identity: 'fingerprint:cccccccccccccccc' }]) {
      const r = await closeDecision(args(bad));
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.equal(registryExists(), false);
  });
  it('a tripwire identity resolves its evidence fingerprints and records its memory name', () => {
    const p = preflightDecision(args());
    assert.ok(p.ok, JSON.stringify(p.problems));
    assert.deepEqual(p.decision.evidenceFingerprints, [A, B]);
    assert.equal(p.decision.memory, 'feedback_hook');
  });
});

describe('closeDecision', () => {
  it('enforce: one registry entry, idempotent on re-run, MEMORY.md untouched', async () => {
    const before = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
    const r = await closeDecision(args());
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.equal(readRegistry(repo).decisions[0].identity, 'tripwire:feedback_hook');
    assert.equal((await closeDecision(args())).steps.registry.appended, false);
    assert.equal(readRegistry(repo).decisions.length, 1);
    assert.equal(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8'), before);
  });

  it('reject: a registry entry with no test or layer', async () => {
    const r = await closeDecision(args({ decision: 'rejected', identity: `fingerprint:${A}`, test: undefined, layer: undefined, summary: 'judged not worth a check' }));
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.equal(readRegistry(repo).decisions[0].decision, 'rejected');
  });

  it('a friction-typed memory records the enforcement through the existing frictionLink seam (memory_friction reuse)', async () => {
    fs.writeFileSync(path.join(mem, 'feedback_hook.md'), '---\nname: feedback_hook\ndescription: d\nmetadata:\n  type: friction\n---\nbody\n');
    const calls = [];
    const r = await closeDecision(args(), { link: async (a) => { calls.push(a); return { ok: true }; } });
    assert.ok(r.ok);
    assert.deepEqual(calls, [{ memory: 'feedback_hook', kind: 'test', ref: 'tests/hook.test.mjs', repoRoot: repo }]);
  });

  it('a friction-typed memory without the link seam is refused before any write', async () => {
    fs.writeFileSync(path.join(mem, 'feedback_hook.md'), '---\nname: feedback_hook\ndescription: d\nmetadata:\n  type: friction\n---\nbody\n');
    assert.equal((await closeDecision(args())).ok, false);
    assert.equal(registryExists(), false);
  });
});
