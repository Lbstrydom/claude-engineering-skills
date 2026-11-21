/**
 * @fileoverview The lease side of retiring a repo's last live session (plan docs/plans/fleet-feedback-cluster2-claims-turns.md
 * D1): its turn - and, on merged evidence, its CI window - served work that is gone, so they end now instead of holding
 * other repos off the slot until they expire. One bounded lease transaction; the pure decision is `endTurnWorkGone`.
 *
 * The caller (`lifecycle.mjs` `afterRetire`) holds the registry lock, so no `claim` can register new work between its
 * "no live session left" count and this write. A failure here never un-retires anything and never throws: the result
 * says what happened, and re-running the same `fleet release` is the repair (`endTurnWorkGone` is idempotent).
 *
 * @module scripts/lib/fleet/lease-workgone
 */
import { gitCommonDir } from './git-facts.mjs';
import { renderCommand } from './shell-quote.mjs';
import { defaultProbe, machineDir, repoKeyOf, transactLease } from './lease.mjs';
import { endTurnWorkGone, settleQueue } from './lease-turns.mjs';

/** The lock wait: the registry lock is held across this call, so it is bounded well under the registry's own. */
const WORKGONE_LOCK_WAIT_MS = 2000;

/**
 * @param {{cwd: string, env: object, now: Date}} ctx
 * @param {{clearCi?: boolean}} [opts] clearCi: merged evidence says the repo's CI windows are moot
 * @returns {{lease: 'n/a'|'ended'|'cleared'|'cleared+ended'|'failed', reason?: string, turnEnded?: boolean, windowsCleared?: number}}
 */
export function endRepoWorkGone(ctx, { clearCi = false } = {}) {
  try {
    const common = gitCommonDir(ctx.cwd);
    if (!common.ok) return { lease: 'failed', reason: 'this checkout has no git common dir to attribute a lease to' };
    const repoKey = repoKeyOf(common.dir);
    const dir = machineDir(ctx.env);
    const probe = defaultProbe();
    const tx = transactLease(dir, (read) => {
      if (read.state === 'unreadable' || read.state === 'newer-version') return { value: { unusable: `the lease file is ${read.state}` } };
      const settled = settleQueue(read.lease, ctx.now, probe);
      const r = endTurnWorkGone(settled, repoKey, ctx.now, { clearCi }, 'fleet release');
      const next = r.lease === settled ? settled : settleQueue(r.lease, ctx.now, probe);
      return { value: { r }, ...(next !== read.lease ? { write: next } : {}) };
    }, { maxWaitMs: WORKGONE_LOCK_WAIT_MS });
    if (!tx.ok) return { lease: 'failed', reason: tx.reason };
    if (tx.value.unusable) return { lease: 'failed', reason: tx.value.unusable };
    const { turnEnded, windowsCleared, windowsKept } = tx.value.r;
    const lease = turnEnded ? (windowsCleared ? 'cleared+ended' : 'ended') : (windowsCleared ? 'cleared' : 'n/a');
    return { lease, turnEnded, windowsCleared, windowsKept };
  } catch (e) {
    return { lease: 'failed', reason: e.message };
  }
}

/** The one line a release prints about the lease step (null when there is nothing to say). */
export function workGoneLine(res, { cmd = 'fleet', id } = {}) {
  if (!res) return null;
  // A CI window left standing is said out loud (with why), even when the turn itself needed nothing: it still holds other repos off the slot.
  const kept = res.windowsKept ? ` ${res.windowsKept} running CI window(s) were left (${res.keptReason ?? 'no merged evidence'}); clear one with \`${cmd} lease announce --clear-window <id>\` if its CI is moot.` : '';
  if (res.lease === 'n/a') return kept ? `lease:${kept}` : null;
  if (res.lease === 'failed') return `warning: the lease was not updated (${res.reason}); the release stands and the turn still expires on its own — re-run \`${repairCommand(cmd, id)}\` to retry`;
  const did = [res.turnEnded ? 'ended this repo\'s turn' : null, res.windowsCleared ? `cleared ${res.windowsCleared} CI window(s) (the work merged)` : null].filter(Boolean).join(' and ');
  return `lease: ${did} (no live session of this repo is left).${kept}`;
}

/** The repair for a failed lease step: the same release, the id quoted as DATA (a branch name may hold shell metacharacters). */
export const repairCommand = (cmd, id) => `${cmd} ${renderCommand(['release', '--id', id])}`;
