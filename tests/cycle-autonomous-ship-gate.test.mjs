/**
 * @fileoverview `/cycle --autonomous` stops before anything leaves the machine
 * unless `--ship` is passed.
 *
 * ai-organiser, 2026-11-15: an autonomous run whose brief said "do not push"
 * pushed and opened PR #111, and a side session it started opened #112. `/ship`
 * itself was already uninvocable (`disable-model-invocation`), but nothing in the
 * skill stopped the agent from running `git push` / `gh pr create` directly, and
 * Step 7 even opened with "A pushed PR: …" as if pushing were routine.
 *
 * /cycle is an orchestrator with no exit code, so the contract is the PROSE the
 * model follows. This pins it in the canonical skill and the generated copy.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const CANONICAL = 'skills/cycle/SKILL.md';
const GENERATED = '.claude/skills/cycle/SKILL.md';
const read = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
const step7 = (s) => {
  const start = s.indexOf('## Step 7');
  assert.ok(start !== -1, 'Step 7 heading missing');
  return s.slice(start, s.indexOf('\n## ', start + 1));
};

for (const file of [CANONICAL, GENERATED]) {
  describe(`${file}: autonomous mode never pushes or publishes without --ship`, () => {
    const s = read(file);

    test('--ship is a documented flag, and the autonomous usage line says it stops before ship', () => {
      assert.match(s, /Usage: \/cycle --autonomous <plan-file> --ship\b/);
      assert.match(s, /^- `--ship` — with `--autonomous`/m);
      assert.match(s, /Usage: \/cycle --autonomous <plan-file> {4}— .*no push, PR or side session/);
    });

    test('Step 7 forbids push, PR creation and side sessions by name when --ship is absent', () => {
      const body = step7(s);
      // The three actions must sit INSIDE the prohibition sentence, not merely somewhere in Step 7.
      assert.match(body, /Without `--ship`, nothing is pushed or published\*\*: no `git push`, `gh pr create` or side session/);
      // ...and the handoff still ends the step in BOTH cases, so --ship never reads as "shipping is now autonomous".
      assert.match(body, /always ends in a \*\*blocked handoff\*\* \(after the push \+ PR when `--ship`\)/);
      assert.match(body, /With `--ship`\*\*: push the branch, open ONE PR, never merge/);
    });

    test('Step 7 no longer treats a pushed PR as the routine case', () => {
      assert.doesNotMatch(step7(s), /^> A pushed PR:/m);
    });

    test('Step 3C keeps a RESIDENT instruction to settle every unchangedDeclared path (not only a link)', () => {
      const loop = s.slice(s.indexOf('### Loop (autonomous)'), s.indexOf('### Step 3C.1'));
      assert.match(loop, /`unchangedDeclared` path: over-declared or a MISSED edit\? Settle it before the cluster is done/);
    });

    test('the hard rules carry it, so it survives a reader who skips Step 7', () => {
      const rules = s.slice(s.indexOf('## Hard rules'));
      assert.match(rules, /`--autonomous` never pushes or publishes without `--ship`/);
    });
  });
}
