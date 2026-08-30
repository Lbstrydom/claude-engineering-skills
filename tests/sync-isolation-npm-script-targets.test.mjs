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
    // The manifest must ESTABLISH that `openai-audit.mjs` is ours, because
    // "stale" means an UPSTREAM file left at its pre-isolation path — and only
    // the consumer's own manifest can say which tails upstream owns. This
    // fixture used to assert staleness while declaring nothing but a SKILL.md,
    // so it was really testing the prefix, which is the thing that turned out
    // to be wrong (see the consumer-owned case below).
    manifest.files[`${TOOL_DIR}/openai-audit.mjs`] = 'sha-not-read-by-gate5';

    const res = gate5(root, manifest);
    assert.equal(res.pass, false);
    assert.equal(res.details.stale.length, 1);
    assert.deepEqual(res.details.unresolved, []);
  });

  it('does NOT call a CONSUMER-OWNED script stale just because it lives under scripts/', () => {
    // Measured in `storyline` 2026-08-30: gate 5 flagged `ux:driver` →
    // `node scripts/ux/ux-driver.mjs`, a file that EXISTS and is the consumer's
    // own (zero occurrences in its manifest). The refs reach the gate because
    // the consumer's `<!-- repo-electron-target -->` adapter block, carried in
    // four SKILL.md it has declared as overrides, deliberately points the
    // browser lenses at its own Electron driver. The gate was telling a
    // consumer its own working scripts were stale upstream paths, on the
    // strength of a path prefix — and gate 3 had had the ownership test all
    // along.
    const manifest = consumer('ux:driver', 'node scripts/ux/ux-driver.mjs');
    write('scripts/ux/ux-driver.mjs', '// the consumer\'s own driver\n');

    const res = gate5(root, manifest);
    assert.equal(res.pass, true, 'a consumer-owned script is not a stale upstream path');
    assert.deepEqual(res.details.consumerOwned, [{
      npmScript: 'ux:driver',
      body: 'node scripts/ux/ux-driver.mjs',
      target: 'scripts/ux/ux-driver.mjs',
    }], 'and it is REPORTED — a pass that silently ignored its subjects is vacuous');
  });

  it('ownership comes from the MANIFEST, not from the file existing', () => {
    // The two must not be conflated. An upstream tail left at the legacy path
    // is stale whether or not the file is there; a consumer tail is not stale
    // either way. Same body, same disk state, opposite verdicts — decided
    // solely by what the manifest claims.
    const owned = consumer('audit', 'node scripts/openai-audit.mjs');
    owned.files[`${TOOL_DIR}/openai-audit.mjs`] = 'x';
    write('scripts/openai-audit.mjs', '// present on disk\n');
    assert.equal(gate5(root, owned).pass, false, 'upstream tail at the legacy path is stale');

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-npmtarget-b-'));
    const theirs = consumer('audit', 'node scripts/openai-audit.mjs');
    write('scripts/openai-audit.mjs', '// present on disk\n');
    assert.equal(gate5(root, theirs).pass, true, 'an undeclared tail is the consumer\'s own');
  });

  it('ignores an `npm run X` the consumer never wired', () => {
    const skillRel = '.claude/skills/ship/SKILL.md';
    write(skillRel, 'Run `npm run context:check`.\n');
    write('package.json', JSON.stringify({ scripts: {} }, null, 2));

    assert.equal(gate5(root, { files: { [skillRel]: 'x' } }).pass, true);
  });
});
