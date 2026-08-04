/**
 * Tests for scripts/lib/skill-description-lint.mjs.
 *
 * Two lints over the SKILL.md description — the surface that decides whether a
 * skill is ever selected:
 *   1. the 1024-char Copilot budget (AGENTS.md claimed skills:check enforced
 *      it; on 2026-08-04 three skills were over and it exited 0)
 *   2. literal trigger-phrase collisions between skills
 *
 * The suite deliberately pins the LIMITS as well as the behaviour: the
 * collision check is exact-match only, and a test asserts it does NOT fire on
 * merely-similar phrasing, so a future "improvement" to fuzzy matching has to
 * confront that decision rather than slide past it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  extractDescription, extractTriggerPhrases, normalisePhrase,
  findTriggerCollisions, checkDescriptionBudget, DESCRIPTION_MAX_CHARS,
} from '../scripts/lib/skill-description-lint.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

function skillMd({ name = 'demo', description }) {
  return `---\nname: ${name}\ndescription: |\n${description
    .split('\n').map((l) => `  ${l}`).join('\n')}\n---\n\n# Body\n\ntext\n`;
}

describe('extractDescription', () => {
  it('strips the block-scalar indent — counting raw lines over-reports', () => {
    const md = skillMd({ description: 'abc\ndef' });
    // Raw frontmatter lines are "  abc" / "  def" = 10 chars; the parsed
    // scalar is "abc\ndef" = 7. Over-reporting by 2/line is exactly the error
    // that made a naive inline regex unusable for a budget check.
    assert.equal(extractDescription(md), 'abc\ndef');
    assert.equal(extractDescription(md).length, 7);
  });

  it('stops at the next top-level frontmatter key', () => {
    const md = '---\nname: x\ndescription: |\n  one\n  two\ndisable-model-invocation: true\n---\n\nbody\n';
    assert.equal(extractDescription(md), 'one\ntwo');
  });

  it('returns null when there is no block description', () => {
    assert.equal(extractDescription('---\nname: x\n---\n\nbody\n'), null);
    assert.equal(extractDescription('no frontmatter at all'), null);
  });
});

describe('checkDescriptionBudget', () => {
  it('flags a description over the budget and reports the overage order', () => {
    const { over, missing } = checkDescriptionBudget({
      big: skillMd({ description: 'x'.repeat(DESCRIPTION_MAX_CHARS + 100) }),
      bigger: skillMd({ description: 'y'.repeat(DESCRIPTION_MAX_CHARS + 200) }),
      fine: skillMd({ description: 'short' }),
    });
    assert.deepEqual(over.map((o) => o.skill), ['bigger', 'big'], 'sorted worst-first');
    assert.deepEqual(missing, []);
  });

  it('is inclusive at the boundary — exactly the max is allowed', () => {
    const { over } = checkDescriptionBudget({
      edge: skillMd({ description: 'z'.repeat(DESCRIPTION_MAX_CHARS) }),
    });
    assert.deepEqual(over, []);
  });

  it('reports an unparseable description rather than passing it', () => {
    const { missing } = checkDescriptionBudget({ broken: '---\nname: broken\n---\n' });
    assert.deepEqual(missing, ['broken']);
  });
});

describe('extractTriggerPhrases', () => {
  it('separates "no triggers declared" from "declared but nothing parsed"', () => {
    assert.deepEqual(extractTriggerPhrases(skillMd({ description: 'no triggers here' })), {
      declared: false, phrases: [],
    });
    // Declared, but the quotes are curly so nothing parses — a parser
    // regression must be visible, not read as a clean zero.
    const curly = skillMd({ description: 'Triggers on: “foo”.\nUsage: /x' });
    assert.deepEqual(extractTriggerPhrases(curly), { declared: true, phrases: [] });
  });

  it('stops the run at Usage: so usage examples are not read as triggers', () => {
    const md = skillMd({ description: 'Triggers on: "alpha", "beta".\nUsage: /x "gamma"' });
    assert.deepEqual(extractTriggerPhrases(md).phrases, ['alpha', 'beta']);
  });
});

describe('normalisePhrase', () => {
  it('folds case and whitespace', () => {
    assert.equal(normalisePhrase('  Audit  The   Plan '), 'audit the plan');
  });

  it('does NOT strip punctuation — /audit-plan and audit-plan are distinct claims', () => {
    assert.notEqual(normalisePhrase('/audit-plan'), normalisePhrase('audit-plan'));
  });
});

describe('findTriggerCollisions', () => {
  it('reports a phrase claimed by two skills, with both names', () => {
    const { collisions } = findTriggerCollisions({
      a: skillMd({ description: 'Triggers on: "verify the plan", "audit the plan".\nUsage: /a' }),
      b: skillMd({ description: 'Triggers on: "verify the plan", "lock the fix".\nUsage: /b' }),
    });
    assert.deepEqual(collisions, [{ phrase: 'verify the plan', skills: ['a', 'b'] }]);
  });

  it('matches across case and spacing differences', () => {
    const { collisions } = findTriggerCollisions({
      a: skillMd({ description: 'Triggers on: "Ship It".\nUsage: /a' }),
      b: skillMd({ description: 'Triggers on: "ship  it".\nUsage: /b' }),
    });
    assert.equal(collisions.length, 1);
  });

  it('does NOT fire on merely-similar phrasing — exact-match is the documented limit', () => {
    // The /investigate-vs-/explain collision that motivated this check shares
    // no literal phrase. Pinned so a future move to fuzzy matching is a
    // deliberate decision (measured and rejected: 47 noise pairs at
    // Jaccard >= 0.5), not an accident.
    const { collisions } = findTriggerCollisions({
      a: skillMd({ description: 'Triggers on: "when did we actually".\nUsage: /a' }),
      b: skillMd({ description: 'Triggers on: "did we already solve this".\nUsage: /b' }),
    });
    assert.deepEqual(collisions, []);
  });

  it('a phrase used once by one skill is not a collision', () => {
    const { collisions, counts } = findTriggerCollisions({
      a: skillMd({ description: 'Triggers on: "alpha", "alpha".\nUsage: /a' }),
    });
    assert.deepEqual(collisions, [], 'self-duplication within one skill is not a cross-skill clash');
    assert.equal(counts.a, 2);
  });

  it('surfaces declared-but-empty skills so the check cannot pass vacuously', () => {
    const { emptyDeclared } = findTriggerCollisions({
      ok: skillMd({ description: 'Triggers on: "alpha".\nUsage: /ok' }),
      broken: skillMd({ description: 'Triggers on: none at all.\nUsage: /broken' }),
    });
    assert.deepEqual(emptyDeclared, ['broken']);
  });
});

describe('the real skills/ tree', () => {
  const skillsRoot = path.join(REPO_ROOT, 'skills');
  const names = fs.readdirSync(skillsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(skillsRoot, n, 'SKILL.md')));
  const byName = Object.fromEntries(
    names.map((n) => [n, fs.readFileSync(path.join(skillsRoot, n, 'SKILL.md'), 'utf-8')]),
  );

  it('every shipped description is within the Copilot budget', () => {
    const { over, missing } = checkDescriptionBudget(byName);
    assert.deepEqual(over, [], 'an over-length description is silently rejected by Copilot');
    assert.deepEqual(missing, [], 'description is required by the same contract');
  });

  it('no two shipped skills advertise the same trigger phrase', () => {
    const { collisions, emptyDeclared, counts } = findTriggerCollisions(byName);
    assert.deepEqual(collisions, []);
    assert.deepEqual(emptyDeclared, []);
    // Capture honesty: if the parser ever stops finding phrases, the two
    // assertions above pass having compared nothing. Assert real work happened.
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    assert.ok(total > 50, `expected a substantial phrase corpus, parsed ${total}`);
  });
});
