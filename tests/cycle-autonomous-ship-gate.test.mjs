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
  describe(`${file}: autonomous mode is local-only without --ship`, () => {
    const s = read(file);

    test('--ship is a documented flag, and the autonomous usage line says it stops before ship', () => {
      assert.match(s, /Usage: \/cycle --autonomous <plan-file> --ship\b/);
      assert.match(s, /^- `--ship` — with `--autonomous`/m);
      assert.match(s, /Usage: \/cycle --autonomous <plan-file> {4}— .*no push, PR or side session/);
    });

    test('Step 7 forbids push, PR creation and side sessions by name when --ship is absent', () => {
      const body = step7(s);
      assert.match(body, /Without `--ship`, nothing leaves the machine/);
      for (const action of ['`git push`', '`gh pr create`', 'side session']) assert.ok(body.includes(action), `Step 7 must name ${action}`);
      assert.match(body, /With `--ship`\*\*: push the branch, open ONE PR, never merge/);
    });

    test('Step 7 no longer treats a pushed PR as the routine case', () => {
      assert.doesNotMatch(step7(s), /^> A pushed PR:/m);
    });

    test('the hard rules carry it, so it survives a reader who skips Step 7', () => {
      const rules = s.slice(s.indexOf('## Hard rules'));
      assert.match(rules, /`--autonomous` is local-only without `--ship`/);
    });
  });
}
