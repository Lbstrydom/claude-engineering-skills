/**
 * @fileoverview Refuse a sync that would move a consumer BACKWARDS.
 *
 * ## The incident (2026-09-07)
 *
 * A fix delivered to all three consumers at 08:45 was overwritten at 10:48 by a
 * session pushing from a tree that predated it; all three went silently back to
 * the broken code. That push never landed — `origin/main` did not move — but the
 * damage did, and nothing anywhere reported it.
 *
 * Two properties combine. The sync runs from `.githooks/pre-push` against
 * `$REPO_ROOT`, the PUSHING WORKTREE's own tree; and git fires a pre-push hook
 * BEFORE the remote accepts anything. So a push that is rejected, abandoned, or
 * merely made from a stale worktree rewrites every consumer from whatever tree
 * that session happens to hold. One operator running several agent sessions
 * against one checkout is the ordinary case here, not an edge case — the same
 * premise `sync-receipt.mjs`'s own v2 header already had to correct.
 *
 * It was undetectable after the fact by construction: a receipt records what a
 * sync DID, never whether it should have, so each consumer logged the rollback
 * as an ordinary successful sync.
 *
 * ## Why this lives here and not in sync-to-repos.mjs
 *
 * The oracle and the refusal wording are cohesive, and `sync-to-repos.mjs` is
 * already over the file-size ratchet's limit — a file that size may not grow
 * (AGENTS.md). Extracting keeps the CLI's share to the call and the decision
 * directly testable without a subprocess.
 *
 * The pure predicate itself is `detectSourceRollback` in `sync-receipt.mjs`: it
 * is a question about the receipt's own contents, and it belongs beside the
 * other readers of that shape.
 *
 * @module scripts/lib/sync-rollback-guard
 */

import { spawnSync } from 'node:child_process';
import { detectSourceRollback } from './sync-receipt.mjs';

/**
 * Build an `(ancestor, descendant) => 'yes'|'no'|'unknown'` oracle over one
 * checkout.
 *
 * The three-valued answer is the whole point, and it is the trap
 * `lib/worktree-identity.mjs` documents: `git merge-base --is-ancestor` reports
 * a NEGATIVE answer with exit 1, and an execution failure ALSO exits non-zero.
 * Only a clean exit-1 with empty stderr is an answer; everything else is
 * `unknown`, which `detectSourceRollback` treats as "not a rollback" so a git
 * problem can never block a legitimate delivery.
 *
 * A sha the consumer recorded on another machine simply is not in this
 * checkout — `rev-parse` fails, and `unknown` is the honest reply rather than a
 * fabricated `no`.
 *
 * No `env:` override: `scrubAmbientGitEnv()` has already deleted
 * GIT_DIR/GIT_WORK_TREE from this process by the time any caller reaches here,
 * so inheriting `process.env` resolves from `cwd` as intended.
 *
 * @param {string} sourceRoot
 * @returns {(ancestor: string, descendant: string) => 'yes'|'no'|'unknown'}
 */
export function createGitAncestry(sourceRoot) {
  const run = (args) => spawnSync('git', args, {
    cwd: sourceRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  return (ancestor, descendant) => {
    for (const sha of [ancestor, descendant]) {
      const seen = run(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
      if (seen.error || seen.status !== 0) return 'unknown';
    }
    const res = run(['merge-base', '--is-ancestor', ancestor, descendant]);
    if (res.error) return 'unknown';
    if (res.status === 0) return 'yes';
    if (res.status === 1 && !(res.stderr || '').trim()) return 'no';
    return 'unknown';
  };
}

/**
 * PURE. Turn a `detectSourceRollback` hit into the operator-facing decision.
 *
 * ABORTS by default rather than warning, unlike the `detectOwnershipRegression`
 * precedent it sits beside in the sync: that one is advisory because it merely
 * EXPLAINS a state the collision guard already refuses, whereas this is the only
 * thing between a stale tree and the consumer's disk, and the incident's
 * defining property was that it ran clean. It does not block the push — the hook
 * treats a non-zero sync as non-blocking by design, because consumer repos are
 * other-machine state.
 *
 * @param {null | {recordedSha: string, incomingSha: string, recordedAt: string|null}} rollback
 * @param {{repoName: string, allowRollback: boolean, colors?: object}} ctx
 * @returns {{abort: boolean, lines: string[]}} — `lines` is empty when there is
 *   nothing to say, so a caller never prints a blank advisory.
 */
export function planRollbackResponse(rollback, { repoName, allowRollback, colors = {} }) {
  if (!rollback) return { abort: false, lines: [] };
  const { R = '', Y = '', D = '', X = '' } = colors;
  const from = rollback.incomingSha.slice(0, 12);
  const has = rollback.recordedSha.slice(0, 12);
  if (allowRollback) {
    return {
      abort: false,
      lines: [`  ${Y}rollback ALLOWED${X} ${D}(--allow-rollback): ${repoName} goes back to ${from} from ${has}${X}`],
    };
  }
  return {
    abort: true,
    lines: [
      `  ${R}ABORT${X}  this sync would roll ${repoName} BACKWARDS; refusing to write:`,
      `    ${R}source ${from} is an ANCESTOR of ${has}${X}`
        + `${rollback.recordedAt ? ` ${D}(delivered ${rollback.recordedAt})${X}` : ''}`,
      `    ${D}This checkout is behind what ${repoName} already has. Sync from a current`,
      `    checkout instead — or, to ship the older bundle deliberately, re-run with`,
      `    --allow-rollback.${X}`,
    ],
  };
}

/**
 * Would this sync move the consumer BACKWARDS, judged against EVERY durable record
 * of what it last received (debt ad2fd650d8bd)?
 *
 * There are two: the receipt's latest entry, and the consumer manifest's source
 * commit. The manifest is written BEFORE the receipt, so a failed receipt write
 * still leaves the manifest stamp — the guard is not blind to a delivery just
 * because its receipt line was lost. Each stamp is compared by commit ANCESTRY
 * (`detectSourceRollback`), never by wall-clock `generatedAt`, which is not an
 * ordering across hosts or clock adjustments. A rollback is reported if EITHER
 * stamp shows the incoming source is behind it; an unresolvable commit keeps the
 * detector's own fail-open answer, so a git problem can never block a delivery.
 *
 * @param {Array<object|null>} stamps  receipt entries or `manifestStamp(...)` shapes
 * @param {string|null} incomingSha
 * @param {(a: string, d: string) => 'yes'|'no'|'unknown'} ancestry
 * @returns {null | {recordedSha: string, incomingSha: string, recordedAt: string|null}}
 */
export function rollbackAgainstStamps(stamps, incomingSha, ancestry) {
  for (const stamp of stamps) {
    const hit = detectSourceRollback(stamp, incomingSha, ancestry);
    if (hit) return hit;
  }
  return null;
}

/** The consumer manifest's last-delivery stamp, shaped like a receipt entry. */
export function manifestStamp(manifest) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.commitSha !== 'string') return null;
  return { source: { commitSha: manifest.commitSha }, syncedAt: typeof manifest.generatedAt === 'string' ? manifest.generatedAt : null };
}
