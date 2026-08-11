/**
 * @fileoverview Tier-1 (deterministic-seam) regression for the `--scope diff`
 * base resolution in openai-audit.mjs.
 *
 * Origin: ai-organiser audit over-capture — a blind `HEAD~1` default re-pulled
 * an already-shipped+audited commit into scope (33/34 findings out-of-scope).
 * The fix was a dirty-aware default; this file pins that decision table so it
 * cannot silently regress to the over-capturing behaviour.
 *
 * MIGRATED (worktree-identity-guards, Phase 4): the decision moved out of
 * `openai-audit.mjs::resolveDiffBase` — which returned a bare ref STRING and
 * passed an explicit `--base` through unvalidated — into
 * `lib/worktree-identity.mjs::resolveRangeSnapshot`, which resolves both ends to
 * OIDs and validates ancestry. The regression guard moved WITH it rather than
 * being deleted alongside the function: the over-capture this pins is a property
 * of the DECISION, not of where the decision lives.
 *
 * The git subprocess is still not exercised here — the runner is injected, so
 * these assert the pure decision only. Real-git behaviour (ancestry refusal,
 * the `..`-form under-scope) is covered by tests/audit-base-ancestry.test.mjs.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveRangeSnapshot } from '../scripts/lib/worktree-identity.mjs';

const HEAD_SHA = 'h'.repeat(40);
const PARENT_SHA = 'p'.repeat(40);
const BASE_SHA = 'b'.repeat(40);

/** Injected runner: joined-argv → spawnSync-shaped result. */
function runner(map) {
  return (args) => map[args.join(' ')] ?? { status: 1, stdout: '', stderr: '' };
}
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });

const BASE_RUNNER = {
  'rev-parse --verify --quiet HEAD^{commit}': ok(`${HEAD_SHA}\n`),
  [`rev-parse --verify --quiet ${HEAD_SHA}^^{commit}`]: ok(`${PARENT_SHA}\n`),
};

describe('--scope diff base resolution — dirty-aware, now OID-snapshotted', () => {
  it('explicit --base wins over the dirty-aware default, regardless of dirty state', () => {
    const run = runner({
      ...BASE_RUNNER,
      'rev-parse --verify --quiet topic^{commit}': ok(`${BASE_SHA}\n`),
      [`merge-base --is-ancestor ${BASE_SHA} ${HEAD_SHA}`]: ok(''),
    });
    for (const dirty of [true, false]) {
      const r = resolveRangeSnapshot({ explicitBase: 'topic', workingTreeDirty: dirty, run });
      assert.equal(r.ok, true);
      assert.equal(r.baseSha, BASE_SHA, 'the explicit base must win in both dirty states');
    }
  });

  it('dirty working tree → base IS head (audit uncommitted work only)', () => {
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: true, run: runner(BASE_RUNNER) });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, HEAD_SHA);
    assert.equal(r.relation, 'identical');
  });

  // THE over-capture regression: a clean tree means "audit my last commit", so
  // the base is the PARENT. A dirty tree must NOT resolve here, or an
  // already-shipped, already-audited commit is dragged back into scope.
  it('clean working tree → base is the parent commit (HEAD~1 semantics)', () => {
    const r = resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: false, run: runner(BASE_RUNNER) });
    assert.equal(r.ok, true);
    assert.equal(r.baseSha, PARENT_SHA);
    assert.equal(r.relation, 'ancestor');
  });

  it('the inferred base is derived from the RESOLVED head, not a second textual HEAD', () => {
    const calls = [];
    const run = (args) => { calls.push(args.join(' ')); return runner(BASE_RUNNER)(args); };
    resolveRangeSnapshot({ explicitBase: null, workingTreeDirty: false, run });
    assert.equal(calls[0], 'rev-parse --verify --quiet HEAD^{commit}', 'HEAD is resolved first');
    assert.ok(calls[1].includes(HEAD_SHA), 'the parent lookup keys off the resolved sha, so the pair is a snapshot');
  });

  // New in Phase 4: the string-returning resolver could not express these.
  it('an unresolvable explicit base fails hard — never demotes to the default', () => {
    const run = runner({ ...BASE_RUNNER, 'rev-parse --verify --quiet nope^{commit}': { status: 1, stdout: '', stderr: '' } });
    const r = resolveRangeSnapshot({ explicitBase: 'nope', workingTreeDirty: true, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'unresolvable-explicit');
  });

  it('a non-ancestor explicit base is refused', () => {
    const run = runner({
      ...BASE_RUNNER,
      'rev-parse --verify --quiet other^{commit}': ok(`${BASE_SHA}\n`),
      [`merge-base --is-ancestor ${BASE_SHA} ${HEAD_SHA}`]: { status: 1, stdout: '', stderr: '' },
    });
    const r = resolveRangeSnapshot({ explicitBase: 'other', workingTreeDirty: false, run });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not-an-ancestor');
  });
});
