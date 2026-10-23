/**
 * @fileoverview One bounded, visible step of the consumer pre-push hook (scripts/install-prepush-hook.mjs).
 *
 * WHY (storyline, 2026-10-18 .. 10-23): the hook's draft-plan audit ran with its output redirected to a temp file and no clock, so a
 * slow audit printed NOTHING for 15 minutes, looked exactly like a hang, and workers answered it with `AUDIT_PREPUSH_DISABLE=1` on
 * most pushes - the gate was effectively off. A gate that hangs gets bypassed, so each step now has a wall-clock budget, says that
 * it is still running, and on expiry REFUSES the push (exit 124) naming the step, the time spent and who holds the machine's heavy
 * slot. Failing open here would be the same defect as the hang: a skipped gate reads as a pass.
 *
 * The step is killed as a process TREE (`runChild`): the audit starts `sh.exe` and node children, and signalling the launcher alone
 * leaves them running on the shared machine.
 *
 * @module scripts/lib/prepush-step
 */
import { runChild } from './fleet/lease-spawn.mjs';
import { machineDir, readLease } from './fleet/lease-model.mjs';
import { summarise } from './fleet/lease.mjs';

/** The exit status of a step that outlived its budget. The hook reads exactly this value as "refuse the push". */
export const STEP_TIMEOUT_EXIT = 124;

/** The exit of a step stopped from outside (SIGINT's conventional 128 + 2). */
export const INTERRUPTED_EXIT = 130;
const SIGNUM = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGKILL: 9, SIGTERM: 15 });
const hhmm = (iso) => new Date(iso).toTimeString().slice(0, 5);
const secs = (ms) => Math.round(ms / 1000);

/**
 * Who holds the machine's heavy slot, as one line for a refusal message. Read-only, and never throws: a lease that cannot be read is
 * said to be unknown, not free.
 * @param {{env?: NodeJS.ProcessEnv, now?: Date, read?: typeof readLease, dir?: string}} [opts]
 * @returns {string}
 */
export function describeLeaseHolder({ env = process.env, now = new Date(), read = readLease, dir } = {}) {
  try {
    const s = summarise(read(dir ?? machineDir(env)), now);
    if (!s.measured) return `machine lease unreadable (${s.reason})`;
    const h = s.holder;
    if (!h || s.heavy.state === 'free') return 'machine lease: free';
    const who = `${h.holder} (${h.repo})`;
    return s.heavy.state === 'held'
      ? `machine lease: held by ${who} for ${h.kind} until ${hhmm(h.expiresAt)}`
      : `machine lease: expired slot of ${who} (${s.heavy.verdict})`;
  } catch (e) {
    return `machine lease unknown (${e.message})`;
  }
}

/** The refusal printed when a step outlives its budget. Names the step, the time spent and the lease holder. */
export function timeoutRefusal({ step, elapsedMs, budgetMs, lease }) {
  return [
    `✗  [prepush-hook] step '${step}' exceeded its ${secs(budgetMs)}s budget (ran ${secs(elapsedMs)}s) - push BLOCKED.`,
    `   ${lease}`,
    `   A gate that cannot finish is not a pass. Raise the budget (AUDIT_PREPUSH_AUDIT_BUDGET_SEC / AUDIT_PREPUSH_STEP_BUDGET_SEC),`,
    `   or bypass this one push on purpose: git push --no-verify.`,
  ].join('\n');
}

/**
 * Run `cmd args...` with a wall-clock budget and a heartbeat on `log`. Never resolves a timeout as success.
 * @param {object} o
 * @param {string} o.step - name used in every line
 * @param {string} o.cmd
 * @param {string[]} [o.args]
 * @param {number} o.budgetMs
 * @param {number} [o.progressMs=30000] - heartbeat interval; 0 disables it
 * @param {any} [o.stdio='inherit'] - e.g. ['ignore', fd, fd] to send the step's output to a file
 * @param {AbortSignal} [o.signal] - a stop request: the step's tree is stopped and the result is `interrupted`
 * @param {(line: string) => void} [o.log]
 * @param {() => number} [o.clock]
 * @param {typeof runChild} [o.run]
 * @param {typeof setInterval} [o.every]
 * @param {typeof clearInterval} [o.stopEvery]
 * @param {() => string} [o.leaseText]
 * @returns {Promise<{code: number, timedOut: boolean, elapsedMs: number, interrupted?: boolean, signal?: string}>}
 */
export async function runStep({
  step, cmd, args = [], budgetMs, progressMs = 30_000, stdio = 'inherit', signal, log = () => {}, clock = Date.now, run = runChild,
  every = setInterval, stopEvery = clearInterval, leaseText = describeLeaseHolder,
}) {
  const t0 = clock();
  const beat = progressMs > 0
    ? every(() => log(`[prepush-hook] ${step}: still running (${secs(clock() - t0)}s of ${secs(budgetMs)}s)`), progressMs)
    : null;
  beat?.unref?.();
  let r;
  try { r = await run({ cmd, args, timeoutMs: budgetMs, stdio, ...(signal ? { signal } : {}) }); } finally { if (beat) stopEvery(beat); }
  const elapsedMs = clock() - t0;
  if (r.timedOut) {
    log(timeoutRefusal({ step, elapsedMs, budgetMs, lease: leaseText() }));
    return { code: STEP_TIMEOUT_EXIT, timedOut: true, elapsedMs };
  }
  if (r.stopped && !r.timedOut) {
    log(`✗  [prepush-hook] step '${step}' was interrupted after ${secs(elapsedMs)}s - push BLOCKED.`);
    return { code: INTERRUPTED_EXIT, timedOut: false, interrupted: true, elapsedMs };
  }
  if (r.spawnError) {
    log(`✗  [prepush-hook] step '${step}' could not start: ${r.spawnError} - push BLOCKED.`);
    return { code: 1, timedOut: false, elapsedMs };
  }
  // A signal death has no exit code: it is a failure, never a pass (see toShellExitCode) - and it keeps WHICH signal, as 128 + its number.
  if (r.code === null || r.code === undefined) {
    return { code: r.signal ? 128 + (SIGNUM[r.signal] ?? 15) : 1, timedOut: false, elapsedMs, ...(r.signal ? { signal: r.signal } : {}) };
  }
  return { code: r.code, timedOut: false, elapsedMs };
}
