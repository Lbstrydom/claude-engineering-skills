/**
 * @fileoverview Tier 1 unit tests for `resolveOrphanScopeRefs` — which git range
 * the orphan-introduced wave (Wave 1.5b) analyses.
 *
 * **The bug.** The call site hard-coded `{ baseRef: 'HEAD~1', headRef: 'HEAD' }`
 * directly beneath a comment that said *"For working-tree audits, headRef=null
 * routes through the resolver's working-tree mode"* — describing a capability
 * the code never reached. So during a normal `/audit-code` on a dirty tree the
 * wave analysed the PREVIOUS COMMIT instead of the uncommitted work being
 * audited, while every other wave scoped to `auditBaseCommit..worktree`. Four
 * findings, 2026-07-22 through 2026-08-12.
 *
 * **Why this is a function and not two literals.** The naive fix — always pass
 * `headRef: null` — is a REGRESSION, and the tests below are what caught it.
 * `resolveDiffScope`'s working-tree branch computes changed files as
 * `git diff --name-status HEAD` ∪ untracked, against literal `HEAD`, IGNORING
 * `baseRef` (diff-scope-resolver.mjs:644). On a CLEAN tree that set is empty, so
 * "audit my last commit" (base HEAD~1, clean tree — the `/cycle` workflow) would
 * have silently analysed nothing and reported a healthy zero. That is the
 * loud-correct-refusal-becomes-a-silent-pass trap, so the clean-tree case has
 * its own test asserting the range mode is PRESERVED — the direction the change
 * must not fire.
 *
 * The dirty/clean split is exactly why `auditBaseCommit` is dirty-aware upstream
 * (openai-audit.mjs: dirty → base at HEAD, clean → HEAD~1), which is what makes
 * `{base: auditBaseCommit, head: null}` and `{base: auditBaseCommit, head: HEAD}`
 * agree on the range in their respective cases.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
const lpa = await import('../scripts/lib/audit/legacy-production-audit.mjs');
const { resolveOrphanScopeRefs } = lpa.__testExports;

describe('resolveOrphanScopeRefs — the orphan wave analyses the range the audit is scoped to', () => {
  it('dirty tree → working-tree mode (headRef null), so uncommitted work is analysed', () => {
    const refs = resolveOrphanScopeRefs({ auditBaseCommit: 'abc123', workingTreeDirty: true });
    assert.equal(refs.headRef, null, 'a dirty tree is the case the wave was missing entirely');
    assert.equal(refs.baseRef, 'abc123');
  });

  // THE DIRECTION THE CHANGE MUST NOT FIRE. Without this, "always headRef:null"
  // passes the test above and silently breaks the clean-tree /cycle workflow,
  // because the resolver's working-tree branch diffs against literal HEAD and
  // would return an empty changed-file set.
  it('clean tree → range mode PRESERVED (headRef HEAD), never an empty working-tree diff', () => {
    const refs = resolveOrphanScopeRefs({ auditBaseCommit: 'abc123', workingTreeDirty: false });
    assert.equal(refs.headRef, 'HEAD',
      'a clean tree must keep base..HEAD — working-tree mode would diff HEAD against itself and find nothing');
    assert.equal(refs.baseRef, 'abc123');
  });

  it('honours the audit\'s resolved base rather than re-inferring one', () => {
    // AGENTS.md, "One range, one resolver": a consumer must not re-derive a base
    // from working-tree state. `auditBaseCommit` is already ancestry-validated
    // and snapshotted to a canonical OID upstream; the old literal 'HEAD~1'
    // discarded it, so `--base` was ignored by this wave alone.
    for (const dirty of [true, false]) {
      assert.equal(resolveOrphanScopeRefs({ auditBaseCommit: 'deadbeef', workingTreeDirty: dirty }).baseRef, 'deadbeef');
    }
  });

  it('no resolved base → the legacy HEAD~1 default, so non-CLI callers are unchanged', () => {
    // ctx defaults `auditBaseCommit` to null (tests, library callers). Keeping
    // the old literal here makes this change a no-op for them rather than
    // silently re-pointing their range at the working tree.
    assert.equal(resolveOrphanScopeRefs({ auditBaseCommit: null, workingTreeDirty: false }).baseRef, 'HEAD~1');
    assert.equal(resolveOrphanScopeRefs({ auditBaseCommit: undefined, workingTreeDirty: false }).baseRef, 'HEAD~1');
  });

  it('is total over the four input combinations — no undefined ref reaches the resolver', () => {
    for (const auditBaseCommit of [null, 'sha']) {
      for (const workingTreeDirty of [true, false]) {
        const refs = resolveOrphanScopeRefs({ auditBaseCommit, workingTreeDirty });
        assert.ok(typeof refs.baseRef === 'string' && refs.baseRef.length > 0, 'baseRef must always be a non-empty string');
        assert.ok(refs.headRef === null || refs.headRef === 'HEAD');
      }
    }
  });
});
