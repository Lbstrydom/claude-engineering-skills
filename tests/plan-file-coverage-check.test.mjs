/**
 * @fileoverview Tier 1 — `plan-file-coverage-check.mjs`'s close-out coverage
 * checker. Phase 0 deliverable per `comparison-tooling-consolidation.md`,
 * post-gate fixes H3 (derive the requirements-extraction set from the diff,
 * never hand-type it) and H6 (scope coverage to the phases actually
 * completed, so an independently-shippable partial release does not get
 * refused by a checker demanding every phase's files).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { parsePhaseFiles, resolveScope, checkCoverage } from '../scripts/plan-file-coverage-check.mjs';

const FIXTURE_PLAN = `# Plan: Fixture

## 6b. Implementation Phases

- **Phase 0 — Setup.** Some prose mentioning \`Files:\` as a concept before the
  real sentence, to prove the parser is not fooled by an earlier decoy.
  Files: \`a.mjs\` (create), \`b.mjs\` (create).
- **Phase 1 — Core.** Files: \`c.mjs\` (create), \`a.mjs\` (modify).
- **Phase 2 — Branch-conditional.** Files: \`d.mjs\` (unconditional),
  \`e.mjs\` \`[branch: outcome=yes]\` (only if the verdict is yes).
- **Phase 3 — Dotted-property decoy.** Files: \`f.mjs\` (modify — fixes a bug
  where \`resolved.arms\` was read instead of \`resolved.scope.arms\`, and
  \`obj.prop\` was silently \`undefined\`).
- **Phase 4 — Decoy token before a branch tag.** Files: \`g.mjs\`
  (unconditional), some prose mentioning \`noise.thing\` \`[branch:
  outcome=yes]\` (the branch tag follows a REJECTED decoy token — it must
  not be misattached to g.mjs, the nearest ACCEPTED path before it).
- **Close-out — the executable list.** This bullet is NOT a phase and must
  not swallow Phase 2's boundary. It also mentions \`Files:\` again, as a
  decoy — the tool it references is fixture-only. Files: \`tool.mjs\` (create).
`;

describe('parsePhaseFiles', () => {
  it('an earlier decoy "Files:" mention does not shadow the real sentence', () => {
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    assert.deepEqual(pf.get('0').map((e) => e.path).sort(), ['a.mjs', 'b.mjs']);
  });

  it('a phase boundary stops at ANY top-level bullet, not only "Phase" bullets', () => {
    // Regression: the last phase's bulletText used to extend through
    // "Close-out", so its own decoy "Files:" mention won via lastIndexOf.
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const phase2 = pf.get('2').map((e) => e.path).sort();
    assert.deepEqual(phase2, ['d.mjs', 'e.mjs'], 'must not include tool.mjs from Close-out');
  });

  it('captures a `[branch: key=value]` qualifier and attaches it to the preceding path only', () => {
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const phase2 = pf.get('2');
    assert.equal(phase2.find((e) => e.path === 'd.mjs').branch, null);
    assert.deepEqual(phase2.find((e) => e.path === 'e.mjs').branch, { key: 'outcome', value: 'yes' });
  });

  it('a backtick-quoted property-access expression in the Files: sentence\'s own prose is not mistaken for a path', () => {
    // Regression (found authoring this plan's own Phase 2/3 bullets, twice):
    // `resolved.arms` and `obj.prop` have a dot but are not paths. The old
    // "contains a dot" heuristic swept them in as phantom "missing" files.
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const phase3 = pf.get('3').map((e) => e.path).sort();
    assert.deepEqual(phase3, ['f.mjs'], 'resolved.arms / obj.prop must not appear as phantom paths');
  });

  it('a branch tag following a REJECTED decoy token does not misattach to an earlier unconditional path', () => {
    // Regression (round-4 finding M11): the old code updated `lastEnd` for
    // EVERY backtick token seen, including rejected ones (`noise.thing`
    // here has a dot but no `/` or recognised extension, so it's rejected
    // as a path). That let a decoy sitting between g.mjs and the branch tag
    // "absorb" the gap check, silently attaching the tag to g.mjs even
    // though the tag is nowhere near it. `lastAcceptedEnd` fixes this by
    // tracking only the end position of the last ACCEPTED path.
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const phase4 = pf.get('4');
    assert.equal(phase4.length, 1, 'noise.thing must not be swept in as a phantom path');
    assert.equal(phase4.find((e) => e.path === 'g.mjs').branch, null, 'g.mjs is unconditional — the branch tag belongs to no accepted path here');
  });

  it('a file may legitimately appear in more than one phase (extended later)', () => {
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    assert.ok(pf.get('0').some((e) => e.path === 'a.mjs'));
    assert.ok(pf.get('1').some((e) => e.path === 'a.mjs'), 'Phase 1 legitimately touches a.mjs again');
  });

  it('refuses a plan with no Implementation Phases section', () => {
    assert.throws(() => parsePhaseFiles('# no such section'), /no "Implementation Phases" heading/);
  });
});

describe('resolveScope', () => {
  const pf = parsePhaseFiles(FIXTURE_PLAN);

  it('an unknown phase id is reported, not silently ignored', () => {
    const { unknownPhases } = resolveScope(pf, ['99']);
    assert.deepEqual(unknownPhases, ['99']);
  });

  it('a branch-qualified file is required ONLY when --branch matches', () => {
    const withBranch = resolveScope(pf, ['2'], { key: 'outcome', value: 'yes' });
    assert.ok(withBranch.requiredFiles.has('e.mjs'));
    const withoutBranch = resolveScope(pf, ['2'], null);
    assert.ok(!withoutBranch.requiredFiles.has('e.mjs'), 'the branch not taken must never be required');
    assert.ok(withoutBranch.requiredFiles.has('d.mjs'), 'the unconditional file is required regardless');
  });

  it('a partial phase list requires only those phases\' files — the independently-shippable-cluster case', () => {
    const { requiredFiles } = resolveScope(pf, ['0']);
    assert.deepEqual([...requiredFiles].sort(), ['a.mjs', 'b.mjs']);
  });
});

describe('checkCoverage', () => {
  it('passes when the diff exactly matches the required set', () => {
    const r = checkCoverage({ diffFiles: ['a.mjs', 'b.mjs'], requiredFiles: new Set(['a.mjs', 'b.mjs']) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.missing, []);
    assert.deepEqual(r.unexpected, []);
  });

  it('fails on a missing required file', () => {
    const r = checkCoverage({ diffFiles: ['a.mjs'], requiredFiles: new Set(['a.mjs', 'b.mjs']) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.missing, ['b.mjs']);
  });

  it('fails on an unexpected (out-of-scope) file in the diff', () => {
    const r = checkCoverage({ diffFiles: ['a.mjs', 'z.mjs'], requiredFiles: new Set(['a.mjs']) });
    assert.equal(r.ok, false);
    assert.deepEqual(r.unexpected, ['z.mjs']);
  });
});

// ── The two required scenarios named in the plan's own H6 fix ──────────────

describe('an A-only release cannot be certified as a full-plan close-out, and vice versa', () => {
  it('a partial diff passes against its own partial --phases scope', () => {
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const { requiredFiles } = resolveScope(pf, ['0']);
    const r = checkCoverage({ diffFiles: ['a.mjs', 'b.mjs'], requiredFiles });
    assert.equal(r.ok, true);
  });

  it('the SAME partial diff FAILS when claimed as full-plan completion', () => {
    const pf = parsePhaseFiles(FIXTURE_PLAN);
    const { requiredFiles } = resolveScope(pf, ['0', '1', '2']);
    const r = checkCoverage({ diffFiles: ['a.mjs', 'b.mjs'], requiredFiles });
    assert.equal(r.ok, false, 'a partial diff must not pass as a full-scope close-out');
    assert.ok(r.missing.length > 0);
  });
});

// ── CLI contract (post-gate fix, H7) ────────────────────────────────────────

describe('plan-file-coverage-check.mjs CLI contract', () => {
  it('--selfcheck-relocation prints OK and exits 0', () => {
    const out = execFileSync('node', ['scripts/plan-file-coverage-check.mjs', '--selfcheck-relocation'], { encoding: 'utf-8' });
    assert.equal(out.trim(), 'OK');
  });

  it('an unknown flag refuses via assertKnownFlags, non-zero exit', () => {
    assert.throws(() => execFileSync(
      'node', ['scripts/plan-file-coverage-check.mjs', '--bogus-flag', 'x'],
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ), (err) => {
      assert.ok(err.status !== 0);
      assert.match(String(err.stderr), /unknown flag/);
      return true;
    });
  });

  // emit({ok:false}) sets a non-zero exit code (cli-io.mjs), so execFileSync
  // THROWS for these cases — the JSON envelope is still on stdout, attached
  // to the thrown error, not on a clean return.
  function runExpectingFailure(args) {
    try {
      execFileSync('node', ['scripts/plan-file-coverage-check.mjs', ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.fail('expected a non-zero exit');
    } catch (err) {
      assert.ok(err.status !== 0, 'expected emit({ok:false}) to set a non-zero exit code');
      return JSON.parse(err.stdout);
    }
  }

  it('a missing --plan fails with a named reason, not a stack trace', () => {
    const parsed = runExpectingFailure(['--phases', '0', '--diff', 'x']);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--plan/);
  });

  it('an invalid --branch value (no "=") fails with a named reason', () => {
    const parsed = runExpectingFailure([
      '--plan', 'docs/plans/comparison-tooling-consolidation.md',
      '--phases', '0', '--diff', 'x', '--branch', 'not-a-kv-pair',
    ]);
    assert.equal(parsed.ok, false);
    assert.match(parsed.error, /--branch/);
  });

  it('a detected coverage mismatch against the REAL plan: an A-only release passes, claiming full completion fails', () => {
    const diff = [
      'scripts/plan-file-coverage-check.mjs', 'tests/plan-file-coverage-check.test.mjs',
      'docs/plans/comparison-tooling-consolidation.md', 'scripts/lib/bakeoff/scope.mjs',
      'scripts/bakeoff-collect.mjs', 'tests/final-review-bakeoff.test.mjs',
      'tests/bakeoff-arms.test.mjs', 'tests/bakeoff-summary.test.mjs',
      'tests/bakeoff-per-arm-retry.test.mjs', 'tests/cross-model-buckets.test.mjs',
    ].join('\n');

    const passOut = execFileSync(
      'node', ['scripts/plan-file-coverage-check.mjs',
        '--plan', 'docs/plans/comparison-tooling-consolidation.md',
        '--phases', '0,1', '--diff', diff],
      { encoding: 'utf-8' },
    );
    assert.equal(JSON.parse(passOut).ok, true, 'the A-only release must pass against its own scope');

    const failParsed = runExpectingFailure([
      '--plan', 'docs/plans/comparison-tooling-consolidation.md',
      '--phases', '0,1,1′,2,3,4,5,6,7', '--branch', 'd7d=unify', '--diff', diff,
    ]);
    assert.equal(failParsed.ok, false, 'the same partial diff must not certify full-plan completion');
  });
});
