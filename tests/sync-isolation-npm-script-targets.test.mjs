/**
 * @fileoverview Gate 5 — a package.json script may not invoke a
 * `scripts/.claude-skills/` file the bundle does not actually ship.
 *
 * THE BLIND SPOT THIS LOCKS (reported from a consumer 2026-08-11). Gate 5
 * reconciled `npm run X` references by checking the PREFIX of the invocation:
 * a `scripts/.claude-skills/` tail was treated as "already migrated" and
 * `continue`d past. But the prefix says where a tool WOULD live, not that any
 * CORE_ENTRY declares it. The adoption runbook's Step 7 explicitly invites the
 * consumer to rewrite their scripts to that path, so the guess is routine —
 * and an unverified guess is how `context:check` sat pointing at
 * `scripts/.claude-skills/check-context-drift.mjs` for a week while the file
 * was never in the bundle, with the verifier green throughout.
 *
 * Iterating refs and reading a path prefix can never represent an absent file.
 * Only stat'ing the target can, so that is the gate.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _internals } from '../scripts/lib/sync-isolation-verify.mjs';
import { LAYOUT_CONSTANTS } from '../scripts/lib/sync-path-map.mjs';

const { gate5 } = _internals;
const TOOL_DIR = LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR;

let root;
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-npmtarget-')); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/**
 * A consumer whose synced skill says `npm run <script>` and whose package.json
 * wires that script to `body`.
 */
function consumer(script, body) {
  const skillRel = '.claude/skills/ship/SKILL.md';
  write(skillRel, `Then run **\`npm run ${script}\`** — it enforces the topology.\n`);
  write('package.json', JSON.stringify({ scripts: { [script]: body } }, null, 2));
  return { files: { [skillRel]: 'sha-not-read-by-gate5' } };
}

describe('gate 5 — npm scripts must resolve to a shipped tool', () => {
  it('FAILS when the isolated target is absent (the reported bug)', () => {
    const manifest = consumer('context:check', `node ${TOOL_DIR}/check-context-drift.mjs --strict`);

    const res = gate5(root, manifest);
    assert.equal(res.pass, false, 'an invocation of a file that is not on disk must not pass');
    assert.deepEqual(res.details.unresolved, [{
      npmScript: 'context:check',
      body: `node ${TOOL_DIR}/check-context-drift.mjs --strict`,
      target: `${TOOL_DIR}/check-context-drift.mjs`,
    }]);
    assert.deepEqual(res.details.stale, [], 'an absent target is not the STALE-path finding');
  });

  it('PASSES once that same tool is shipped (not a gate that always fires)', () => {
    const manifest = consumer('context:check', `node ${TOOL_DIR}/check-context-drift.mjs --strict`);
    write(`${TOOL_DIR}/check-context-drift.mjs`, '// shipped\n');

    assert.equal(gate5(root, manifest).pass, true);
  });

  it('still reports a STALE non-isolated invocation (pre-existing behaviour)', () => {
    const manifest = consumer('audit', 'node scripts/openai-audit.mjs');

    const res = gate5(root, manifest);
    assert.equal(res.pass, false);
    assert.equal(res.details.stale.length, 1);
    assert.deepEqual(res.details.unresolved, []);
  });

  it('ignores an `npm run X` the consumer never wired', () => {
    const skillRel = '.claude/skills/ship/SKILL.md';
    write(skillRel, 'Run `npm run context:check`.\n');
    write('package.json', JSON.stringify({ scripts: {} }, null, 2));

    assert.equal(gate5(root, { files: { [skillRel]: 'x' } }).pass, true);
  });
});
