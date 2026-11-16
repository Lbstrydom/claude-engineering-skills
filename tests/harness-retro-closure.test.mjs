/**
 * Harness retro — enforce/reject closure: preflight writes nothing on bad input,
 * every step is idempotent so a re-run finishes an interrupted one (plan §2 c13).
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDecision, preflightDecision } from '../scripts/lib/friction/retro/closure.mjs';
import { readRegistry } from '../scripts/lib/friction/retro/registry.mjs';
import { retirementStatus } from '../scripts/lib/friction/retro/memory-tripwires.mjs';

const A = 'aaaaaaaaaaaaaaaa'; const B = 'bbbbbbbbbbbbbbbb';
const scan = {
  scanId: '20261116T120000Z-abcdef', fingerprintVersion: 1,
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
  fs.writeFileSync(path.join(mem, 'MEMORY.md'), '- [Hook](feedback_hook.md) — relative hook paths\n- [Other](feedback_other.md)\n');
  fs.writeFileSync(path.join(mem, 'feedback_hook.md'), '---\nname: feedback_hook\ndescription: d\nmetadata:\n  type: feedback\n---\nbody\n');
  fs.writeFileSync(path.join(mem, 'feedback_other.md'), '---\nname: feedback_other\ndescription: d\nmetadata:\n  type: feedback\n---\nbody\n');
});
const args = (over = {}) => ({
  decision: 'enforced', identity: 'tripwire:feedback_hook', scan, test: 'tests/hook.test.mjs', layer: 'gate',
  summary: 'hook commands resolve from the project dir', repoRoot: repo, memoryDir: mem, ...over,
});
const snapshot = () => [fs.existsSync(path.join(repo, '.harness-retro', 'decisions.json')), fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8')];

describe('preflight', () => {
  it('writes NOTHING when any input is bad', async () => {
    const before = snapshot();
    for (const bad of [{ test: 'tests/missing.test.mjs' }, { layer: 'vibes' }, { summary: 'see C:\\Users\\bob' }, { identity: 'fingerprint:cccccccccccccccc' }]) {
      const r = await closeDecision(args(bad));
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
    assert.deepEqual(snapshot(), before);
  });
  it('a tripwire identity resolves its evidence and implies its memory', () => {
    const p = preflightDecision(args());
    assert.ok(p.ok, JSON.stringify(p.problems));
    assert.deepEqual(p.decision.evidenceFingerprints, [A, B]);
    assert.equal(p.decision.memory, 'feedback_hook');
  });
});

describe('closeDecision', () => {
  it('enforce: registry entry, frontmatter mark, index retirement — and a re-run is a no-op', async () => {
    const r = await closeDecision(args());
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.equal(readRegistry(repo).decisions[0].identity, 'tripwire:feedback_hook');
    assert.ok(!fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8').includes('(feedback_hook.md)'));
    assert.ok(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8').includes('(feedback_other.md)'));
    assert.deepEqual(retirementStatus(mem), []);
    const again = await closeDecision(args());
    assert.equal(again.steps.registry.appended, false);
    assert.equal(again.steps.frontmatter.changed, false);
    assert.equal(readRegistry(repo).decisions.length, 1);
  });

  it('an interruption after the registry step is finished by a re-run', async () => {
    // simulate: registry written, process died before the memory steps
    const { appendDecision } = await import('../scripts/lib/friction/retro/registry.mjs');
    await appendDecision(repo, preflightDecision(args()).decision);
    const r = await closeDecision(args());
    assert.ok(r.ok);
    assert.equal(r.steps.registry.appended, false);
    assert.equal(r.steps.frontmatter.changed, true);
    assert.deepEqual(retirementStatus(mem), []);
  });

  it('reject: a registry entry only; memory untouched', async () => {
    const before = fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8');
    const r = await closeDecision(args({ decision: 'rejected', identity: `fingerprint:${A}`, test: undefined, layer: undefined, summary: 'judged not worth a check' }));
    assert.ok(r.ok, JSON.stringify(r.problems));
    assert.equal(readRegistry(repo).decisions[0].decision, 'rejected');
    assert.equal(fs.readFileSync(path.join(mem, 'MEMORY.md'), 'utf8'), before);
  });

  it('a friction-typed memory is closed through the existing frictionLink seam', async () => {
    fs.writeFileSync(path.join(mem, 'feedback_hook.md'), '---\nname: feedback_hook\ndescription: d\nmetadata:\n  type: friction\n---\nbody\n');
    const calls = [];
    const r = await closeDecision(args(), { link: async (a) => { calls.push(a); return { ok: true }; } });
    assert.ok(r.ok);
    assert.deepEqual(calls, [{ memory: 'feedback_hook', kind: 'test', ref: 'tests/hook.test.mjs', repoRoot: repo }]);
  });
});
