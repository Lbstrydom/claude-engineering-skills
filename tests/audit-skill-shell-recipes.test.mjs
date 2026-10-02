/**
 * @fileoverview Locks three shell recipes in the /audit-code and /audit-plan
 * SKILL.md files that an agent copies and runs. Each was accepted as an audit
 * finding against the prose; nothing type-checks a SKILL.md, so a recipe that
 * contradicts its own surrounding prose stays wrong until someone runs it.
 *
 *   1. Round 2+ diff base. The prose says dirty tree -> HEAD, clean tree ->
 *      HEAD~1, but the block ran an unconditional `BASE=HEAD`, so on a clean
 *      tree the Round 2+ patch was empty and the round reviewed nothing
 *      (fixed a6b035b3).
 *   2. `PLAN_FILE=docs/plans/*.md`. A shell assignment never expands a glob, so
 *      `"$PLAN_FILE"` handed the CLI the literal pattern.
 *   3. `SID=audit-plan-$(date +%s)`. Second resolution: two invocations in the
 *      same second mint the same SID, and the SID names the result, stderr and
 *      ledger files, so concurrent sessions overwrite each other's ledger.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { markdownFiles } from './helpers/fixtures.mjs';

const execFileAsync = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(REPO, 'skills');
const SID_SKILLS = ['audit-code', 'audit-plan'];

/** Every line inside a ```bash fence, across all authoritative skill markdown. */
function bashFenceLines() {
  const out = [];
  for (const file of markdownFiles(SKILLS)) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    let inBash = false;
    fs.readFileSync(file, 'utf-8').split(/\r?\n/).forEach((line, i) => {
      if (/^\s*```/.test(line)) { inBash = !inBash && /^\s*```bash\b/.test(line); return; }
      if (inBash) out.push({ rel, line: i + 1, text: line });
    });
  }
  return out;
}

describe('audit skill shell recipes', () => {
  test('every audit-code/audit-plan BASE= diff-base assignment is dirty-aware, never an unconditional HEAD', () => {
    // Scoped to the audit skills, whose base must MATCH openai-audit.mjs's own
    // dirty-aware --scope diff resolution. /ship's merge-base is a different,
    // deliberate contract (the whole branch), not this one.
    const assigns = bashFenceLines().filter((l) => /^skills\/audit-(code|plan)\//.test(l.rel)
      && /\bBASE=/.test(l.text) && !/^\s*#/.test(l.text));
    // Vacuous-pass guard: the Round 2+ recipe this pins must still exist.
    assert.ok(assigns.some((l) => l.rel === 'skills/audit-code/SKILL.md'),
      'no BASE= assignment left in skills/audit-code/SKILL.md - re-point this test rather than deleting it');
    for (const l of assigns) {
      assert.match(l.text, /BASE=\$\(\[ -n "\$\(git status --porcelain\)" \] && echo HEAD \|\| echo HEAD~1\)/,
        `${l.rel}:${l.line} sets a diff base that ignores tree state - a clean tree must diff against HEAD~1: ${l.text.trim()}`);
    }
  });

  test('PLAN_FILE is never assigned a glob - an assignment does not expand it', () => {
    const lines = bashFenceLines();
    // Vacuous-pass guard: the invocations still read $PLAN_FILE.
    assert.ok(lines.some((l) => l.text.includes('"$PLAN_FILE"')), 'no recipe reads "$PLAN_FILE" any more');
    const globbed = lines.filter((l) => /^\s*PLAN_FILE=\S*[*?[]/.test(l.text));
    assert.deepEqual(globbed.map((l) => `${l.rel}:${l.line}`), [],
      'PLAN_FILE assigned a glob: "$PLAN_FILE" passes the literal pattern to the CLI');
  });

  test('CHANGED/FILES lists are explicit paths - openai-audit splits --changed on commas, never expands a glob', () => {
    // Same class as PLAN_FILE above: `CHANGED="scripts/*.mjs,…"` reached the
    // CLI as the literal pattern, so the R2+ impact set matched no file.
    const lines = bashFenceLines();
    assert.ok(lines.some((l) => l.text.includes('--changed "$CHANGED"')), 'no recipe passes --changed "$CHANGED" any more');
    const globbed = lines.filter((l) => /^\s*(CHANGED|FILES)=\S*[*?[]/.test(l.text));
    assert.deepEqual(globbed.map((l) => `${l.rel}:${l.line}`), [],
      'CHANGED/FILES assigned a glob: the CLI receives the literal pattern');
  });

  for (const skill of SID_SKILLS) {
    test(`${skill}: two concurrent SID mints never collide`, async () => {
      const src = fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf-8');
      const m = src.match(new RegExp('`SID=(' + skill + '-[^`]+)`'));
      assert.ok(m, `skills/${skill}/SKILL.md no longer mints SID=${skill}-... - re-point this test`);
      const mint = () => execFileAsync('bash', ['-c', `echo ${m[1]}`], { cwd: REPO })
        .then((r) => r.stdout.trim());
      const [a, b] = await Promise.all([mint(), mint()]);
      assert.ok(a.startsWith(`${skill}-`) && b.startsWith(`${skill}-`),
        `the prefix is load-bearing (build-audit-transcript infers mode from it): ${a} / ${b}`);
      assert.notEqual(a, b, `concurrent invocations minted the same SID ${a} - they would share result and ledger files`);
    });
  }
});
