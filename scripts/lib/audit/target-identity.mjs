/**
 * @fileoverview The audit TARGET identity (`audited_sha` / `audited_tree`) and
 * the base sha a diff was taken against, factored out of `openai-audit.mjs` so
 * code-mode AND plan-mode runs capture it the same way
 * (docs/plans/own-model-telemetry-slice-1.md, gap 1: every NULL `audited_sha`
 * was a plan-mode run, which never called the capture).
 *
 * A failed capture is NOT fatal and is NOT guessed around: it yields nulls, so a
 * missing identity reads as missing rather than as a plausible wrong sha.
 *
 * @module scripts/lib/audit/target-identity
 */
import { execFileSync } from 'node:child_process';
import { gitWorktreeTree, gitCommitSha, isSafeGitRevision } from '../vcs.mjs';

/**
 * @param {string} [cwd]
 * @returns {{auditedTree: string|null, auditedSha: string|null, treeError: object|null}}
 */
export function captureTargetIdentity(cwd = process.cwd()) {
  const treeRes = gitWorktreeTree(cwd);
  const shaRes = gitCommitSha(cwd);
  return {
    auditedTree: treeRes.ok ? treeRes.tree : null,
    auditedSha: shaRes.ok ? shaRes.sha : null,
    // Why the tree is missing, for the caller to say so; null when it was captured.
    treeError: treeRes.ok ? null : (treeRes.error ?? { code: 'UNKNOWN' }),
  };
}

/**
 * Resolve a revision (the audit base: a sha, `HEAD~1`, a branch) to a full
 * commit sha, or null. Refuses anything `isSafeGitRevision` does not accept, so
 * a hostile ref name can never reach git as an option.
 *
 * @param {string} cwd
 * @param {string|null|undefined} rev
 * @returns {string|null}
 */
export function resolveRevisionSha(cwd, rev) {
  if (!rev || !isSafeGitRevision(rev)) return null;
  try {
    const sha = execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], {
      cwd, stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}
