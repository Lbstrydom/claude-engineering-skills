/**
 * @fileoverview Ship-train impact tiers + train-due rule (docs/plans/ship-trains.md §2.5–§2.6).
 * Tier 1, pure.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNameStatusZ, changedPaths, classifyPrImpact, isTrainDue, isCodePath, TIERS, DUE_PR_COUNT,
} from '../scripts/lib/ship-train/impact.mjs';

const CLOSURE = new Set([
  'scripts/ship-commit.mjs',
  'scripts/lib/store/runs-findings.mjs',
  '.claude/skills/ship/SKILL.md',
  'tests/fixtures/expected-schema.json',
  'supabase/migrations/20260101000000_x.sql',
]);
const z = (...fields) => fields.join('\0') + '\0';

describe('parseNameStatusZ', () => {
  test('plain, delete, rename and copy records', () => {
    const got = parseNameStatusZ(z('M', 'a.mjs', 'D', 'b.md', 'R087', 'old/c.mjs', 'new/c.mjs', 'C100', 'd.md', 'e.md', 'A', 'f.json'));
    assert.deepEqual(got, [
      { status: 'M', path: 'a.mjs' },
      { status: 'D', path: 'b.md' },
      { status: 'R', path: 'new/c.mjs', oldPath: 'old/c.mjs' },
      { status: 'C', path: 'e.md', oldPath: 'd.md' },
      { status: 'A', path: 'f.json' },
    ]);
  });

  test('paths with a space and with a newline survive -z parsing exactly', () => {
    const got = parseNameStatusZ(z('M', 'docs/a b.md', 'A', 'docs/line\nbreak.md'));
    assert.deepEqual(got.map((c) => c.path), ['docs/a b.md', 'docs/line\nbreak.md']);
  });

  test('empty input is an empty list', () => {
    assert.deepEqual(parseNameStatusZ(''), []);
  });

  test('an unterminated final path throws: -z output ends every field with NUL (code R1 H4)', () => {
    assert.throws(() => parseNameStatusZ('M\0scripts/lib/db/query.m'), /NUL terminator/);
  });

  test('a truncated rename record throws rather than returning a short list', () => {
    assert.throws(() => parseNameStatusZ('R100\0only-old\0'), /truncated/);
  });

  test('a non-status field where a status is expected throws', () => {
    assert.throws(() => parseNameStatusZ('a.mjs\0M\0'), /status letter/);
  });
});

describe('changedPaths', () => {
  test('unions destinations and rename sources, de-duplicated, forward-slashed', () => {
    assert.deepEqual(
      changedPaths([{ status: 'R', path: 'x/new.mjs', oldPath: 'x\\old.mjs' }, { status: 'M', path: 'x/new.mjs' }]).sort(),
      ['x/new.mjs', 'x/old.mjs'],
    );
  });
});

describe('classifyPrImpact', () => {
  const cls = (changes) => classifyPrImpact({ changes, closure: CLOSURE });

  test('a closure hit is urgent, and beats code and docs in the same PR', () => {
    const r = cls([{ status: 'M', path: 'scripts/ship-commit.mjs' }, { status: 'M', path: 'scripts/internal.mjs' }, { status: 'M', path: 'docs/a.md' }]);
    assert.equal(r.tier, 'urgent');
    assert.deepEqual(r.closurePaths, ['scripts/ship-commit.mjs']);
    assert.deepEqual(r.reasons, ['reaches-consumers:1']);
  });

  test('a tests/fixtures file that IS in the closure is urgent, not a test ride-along', () => {
    assert.equal(cls([{ status: 'M', path: 'tests/fixtures/expected-schema.json' }]).tier, 'urgent');
  });

  test('code outside the closure is standard', () => {
    const r = cls([{ status: 'M', path: 'scripts/sync-to-repos.mjs' }]);
    assert.equal(r.tier, 'standard');
    assert.deepEqual(r.reasons, ['repo-internal-code:1']);
  });

  test('docs, markdown, tests and config only are a ride-along', () => {
    const r = cls([
      { status: 'M', path: 'docs/plans/x.md' }, { status: 'A', path: 'tests/new.test.mjs' },
      { status: 'M', path: '.fleet.json' }, { status: 'M', path: 'README.md' },
    ]);
    assert.equal(r.tier, 'ride-along');
    assert.deepEqual(r.reasons, ['tests-docs-config-only']);
  });

  test('an empty change list is a ride-along flagged no-files', () => {
    assert.deepEqual(cls([]).reasons, ['no-files']);
  });

  test('a rename OUT of the closure is urgent (the old endpoint is evaluated)', () => {
    assert.equal(cls([{ status: 'R', path: 'docs/moved-away.md', oldPath: '.claude/skills/ship/SKILL.md' }]).tier, 'urgent');
  });

  test('a rename INTO the closure is urgent', () => {
    assert.equal(cls([{ status: 'R', path: 'scripts/lib/store/runs-findings.mjs', oldPath: 'docs/draft.md' }]).tier, 'urgent');
  });

  test('deleting a closure file is urgent', () => {
    assert.equal(cls([{ status: 'D', path: 'supabase/migrations/20260101000000_x.sql' }]).tier, 'urgent');
  });

  test('a rename from tests/ into scripts/ is not a ride-along', () => {
    assert.equal(cls([{ status: 'R', path: 'scripts/helper.mjs', oldPath: 'tests/helper.mjs' }]).tier, 'standard');
  });

  test('an extensionless hook the taxonomy cannot place counts as code (conservative)', () => {
    assert.equal(isCodePath('.githooks/pre-push'), true);
    assert.equal(cls([{ status: 'M', path: '.githooks/pre-push' }]).tier, 'standard');
  });

  test('closure must be a Set — an array would silently match nothing', () => {
    assert.throws(() => classifyPrImpact({ changes: [], closure: [...CLOSURE] }), /must be a Set/);
  });
});

describe('isTrainDue', () => {
  const pr = (tier) => ({ tier });

  test('any urgent PR makes a train due', () => {
    assert.deepEqual(isTrainDue({ prs: [pr('urgent')] }), { due: true, triggers: ['urgent:1'], missing: [] });
  });

  test(`${DUE_PR_COUNT} ship-ready PRs with a non-ride-along make a train due`, () => {
    const r = isTrainDue({ prs: [pr('standard'), pr('ride-along'), pr('ride-along')] });
    assert.equal(r.due, true);
    assert.deepEqual(r.triggers, ['count:3']);
  });

  test('end of day makes a train due when a non-ride-along is present', () => {
    assert.deepEqual(isTrainDue({ prs: [pr('standard')], endOfDay: true }).triggers, ['end-of-day']);
  });

  test('one standard PR alone is not due, and the refusal names the override', () => {
    const r = isTrainDue({ prs: [pr('standard')] });
    assert.equal(r.due, false);
    assert.match(r.missing[0], /--end-of-day/);
  });

  test('three ride-alongs are NOT due — never a train of their own', () => {
    const r = isTrainDue({ prs: [pr('ride-along'), pr('ride-along'), pr('ride-along')] });
    assert.equal(r.due, false);
    assert.match(r.missing[0], /only ride-alongs/);
  });

  test('end of day with only ride-alongs is still not due', () => {
    assert.equal(isTrainDue({ prs: [pr('ride-along')], endOfDay: true }).due, false);
  });

  test('an empty set is not due', () => {
    assert.deepEqual(isTrainDue({ prs: [] }).missing, ['no ship-ready PRs']);
  });

  test('the tier vocabulary is closed', () => {
    assert.deepEqual([...TIERS], ['urgent', 'standard', 'ride-along']);
  });
});
