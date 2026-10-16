/**
 * @fileoverview `runUnderLease`: the ONE implementation of "take the machine's heavy slot, run a job, give it back"
 * (plan docs/plans/fleet-lease-turns-and-journal.md D7). `fleet lease run -- <cmd>` and `sync:pr` both call it, because two
 * incidents had a single cause - a caller getting the protocol wrong: a wrapper that ignored a REFUSED acquire and ran the
 * command anyway (2026-10-14 12:30Z), and a `timeout` wrapper that SIGTERMed the push it was protecting (2026-10-15 00:13Z).
 *
 *  1. acquire EXCLUSIVELY (a second run under the same identity is refused, never rotated), recording the runner's own pid -
 *     valid here, unlike the one-shot CLI whose pid #243 refuses to record, because the runner lives until the job ends;
 *  2. refused -> wait in the queue, bounded (`waitMin`), polling with jitter; the job NEVER runs after a refusal;
 *  3. granted -> `await job({token, attach, signal})`;
 *  4. release on every CATCHABLE exit (returns, throws, SIGINT/SIGTERM/SIGHUP/SIGBREAK) with the token, as a plain release, a
 *     release that yields the turn (`endTurn`), or the atomic release-to-CI-window when the job may have reached a remote.
 *
 * SIGKILL and power loss cannot be caught: the lease expires and the recorded pid decides takeover (#243 D4). There is no
 * renewal heartbeat: a job running past `forMin` leaves an expired lease whose recorded pid is alive, which admission already
 * treats as held.
 *
 * Every effect is injected (clock, sleep, probe, signals, transact, exit) so the protocol is tested without processes.
 *
 * @module scripts/lib/fleet/lease-run
 */
import {
  decideAcquire, decideAttach, decideRelease, decideReleaseToCiWindow, defaultProbe, transactLease, turnKeptText,
} from './lease.mjs';

/** Signals that mean "stop": a terminal interrupt, a termination request, a hangup, and Ctrl+Break on Windows. */
export const STOP_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
const SIGNUM = Object.freeze({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 });
/** The conventional exit code for a process stopped by `sig`: 128 + its number. */
export const exitCodeForSignal = (sig) => 128 + (SIGNUM[sig] ?? 15);

/** The real signal registrar: install one handler on every stop signal the platform has; the returned function removes them. */
export const processSignals = {
  install(handler) {
    const wired = [];
    for (const sig of STOP_SIGNALS) {
      try { process.on(sig, handler); wired.push(sig); } catch { /* a signal this platform does not know */ }
    }
    return () => { for (const sig of wired) process.off(sig, handler); };
  },
};

/** Retrying can help for these refusals; `unverifiable` needs a person, so waiting would only hide it. */
const RETRYABLE = new Set(['held', 'window', 'turn', 'expired-pid-alive']);

/**
 * One read-decide-write on the lease. A refusal that carries a changed lease (a journal entry, a waiter, a settled expiry) is
 * persisted like any other decision.
 * @returns {{status: 'decided', decision: object} | {status: 'error', reason: string}}
 */
export function runDecision(transact, dir, decide) {
  let tx;
  try {
    tx = transact(dir, (read) => {
      if (read.state === 'unreadable' || read.state === 'newer-version') return { value: { unreadable: read } };
      const d = decide(read.lease);
      const write = d.ok ? d.lease : (d.lease && d.lease !== read.lease ? d.lease : undefined);
      return { value: { decision: d }, ...(write ? { write } : {}) };
    });
  } catch (e) {
    return { status: 'error', reason: `could not use the lease directory ${dir} (${e.code ?? ''} ${e.message})` };
  }
  if (!tx.ok) return { status: 'error', reason: 'could not take the lease lock (contention)' };
  if (tx.value.unreadable) return { status: 'error', reason: `the lease file is unreadable (${tx.value.unreadable.reason})` };
  return { status: 'decided', decision: tx.value.decision };
}

/**
 * @param {object} opts
 * @param {string} opts.dir - the machine lease directory
 * @param {{repoKey: string, holder: string}} opts.identity
 * @param {string} opts.repo - display label
 * @param {string} [opts.kind='gate']
 * @param {number} [opts.forMin=30]
 * @param {string} [opts.note]
 * @param {number} [opts.pid=process.pid] - recorded on the lease (the runner outlives the job)
 * @param {number} [opts.waitMin=0] - how long to wait in the queue (0 = do not wait)
 * @param {number} [opts.pollMs=30000]
 * @param {number} [opts.jitter=0.2] - +/- fraction applied to each poll
 * @param {boolean} [opts.endTurn=false] - yield the repo's turn on release
 * @param {number} [opts.releaseToCiWindow=0] - minutes; hand the slot to a CI window when the job may have reached a remote
 * @param {{repoKey: string, repo: string}} [opts.windowRepo] - who OWNS that window when it is not the releasing repo (sync:pr: the target)
 * @param {string} [opts.cmdName='fleet'] - how this CLI is spelled in a by-hand recovery message
 * @param {() => Date} [opts.now]
 * @param {(ms: number) => Promise<void>} [opts.sleep]
 * @param {() => number} [opts.random]
 * @param {object} [opts.probe]
 * @param {{install: (h: (sig: string) => void) => () => void}} [opts.signals]
 * @param {(code: number) => void} [opts.forceExit] - a SECOND signal while stopping
 * @param {typeof transactLease} [opts.transact]
 * @param {(line: string) => void} [opts.log]
 * @param {(ctx: {token: string, attach: (pid: number) => Promise<boolean>, signal: AbortSignal}) => Promise<any>} job
 * @returns {Promise<{ran: boolean, outcome: 'ran'|'not-granted'|'lease-error'|'bad-request', code?: string, reason?: string, queued?: boolean,
 *   result?: any, token?: string, signalled?: string, released?: {ok: boolean, mode?: 'plain'|'ci-window', window?: object, turnKept?: {reason: string, since: string}, reason?: string}, waitedMs?: number}>}
 */
export async function runUnderLease(opts, job) {
  const {
    dir, identity, repo, kind = 'gate', forMin = 30, note, pid = process.pid, waitMin = 0, pollMs = 30_000, jitter = 0.2,
    endTurn = false, releaseToCiWindow = 0, windowRepo, cmdName = 'fleet', now = () => new Date(), random = Math.random,
    probe = defaultProbe(), signals = processSignals, transact = transactLease, log = () => {},
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)), forceExit = (code) => process.exit(code),
  } = opts;
  const startedAt = now().getTime();
  const deadline = startedAt + Math.max(0, waitMin) * 60_000;
  const req = { identity, repo, kind, forMin, pid, exclusive: true, ...(note !== undefined ? { note } : {}) };

  // 1-2. Acquire, waiting in the queue when allowed. The job does not run unless this loop ends in a grant.
  let grant;
  for (;;) {
    const out = runDecision(transact, dir, (lease) => decideAcquire(lease, req, now(), probe));
    if (out.status === 'error') return { ran: false, outcome: 'lease-error', reason: out.reason, waitedMs: now().getTime() - startedAt };
    const d = out.decision;
    if (d.ok) { grant = d; break; }
    if (d.code === 'bad-request') return { ran: false, outcome: 'bad-request', reason: d.reason };
    const left = deadline - now().getTime();
    if (!RETRYABLE.has(d.code) || left <= 0) {
      return { ran: false, outcome: 'not-granted', code: d.code, reason: d.reason, queued: d.queued === true, waitedMs: now().getTime() - startedAt };
    }
    const wait = Math.min(left, Math.max(1, Math.round(pollMs * (1 + (random() * 2 - 1) * jitter))));
    log(`waiting in the queue (${d.code}); next try in ${Math.round(wait / 1000)}s`);
    await sleep(wait);
  }
  const token = grant.heavy.token;

  // 3. Run. Signals abort the job's AbortSignal; the job stops itself, and we release afterwards.
  const abort = new AbortController();
  let signalled = null;
  const removeSignals = signals.install((sig) => {
    if (signalled) { forceExit(exitCodeForSignal(signalled)); return; }
    signalled = sig;
    abort.abort();
  });
  const attach = async (childPid) => {
    const out = runDecision(transact, dir, (lease) => decideAttach(lease, { identity, pid: childPid, token }, now(), probe));
    return out.status === 'decided' && out.decision.ok === true;
  };
  let result; let threw = false; let thrown;
  try { result = await job({ token, attach, signal: abort.signal }); } catch (e) { threw = true; thrown = e; }

  // 4. Release on every catchable exit. A failed release never changes the job's outcome; it says how to finish by hand. The
  //    stop-signal handlers stay installed until the release has finished: a signal DURING the release must not skip it.
  const remote = threw ? thrown?.remoteReached : result?.remoteReached;
  const toWindow = releaseToCiWindow > 0 && remote !== 'no';
  let rel;
  try {
    rel = runDecision(transact, dir, (lease) => (toWindow
      ? decideReleaseToCiWindow(lease, { identity, repo, token, endTurn, ciWindowMin: releaseToCiWindow, note: 'PR CI after a push', ...(windowRepo ? { windowRepo } : {}) }, now(), probe)
      : decideRelease(lease, { identity, repo, token, endTurn }, now(), probe)));
  } finally { removeSignals(); }
  let released;
  if (rel.status === 'decided' && rel.decision.ok) {
    released = { ok: true, mode: toWindow && rel.decision.window ? 'ci-window' : 'plain', ...(rel.decision.window ? { window: rel.decision.window } : {}), ...(rel.decision.turnKept ? { turnKept: rel.decision.turnKept } : {}) };
    if (rel.decision.turnKept) log(turnKeptText(rel.decision.turnKept, repo, cmdName));
    if (rel.decision.windowRefused) log(`the slot was released but no CI window was recorded (${rel.decision.windowRefused}); announce it by hand: ${cmdName} lease announce --kind ci --until +${releaseToCiWindow}m`);
  } else {
    const reason = rel.status === 'error' ? rel.reason : rel.decision.reason;
    released = { ok: false, reason };
    log(`release FAILED (${reason}); the slot stays held until its lease expires. Free it by hand: ${cmdName} lease release --token ${token}`);
  }
  if (threw) throw thrown; // the ORIGINAL rejection value, whatever its truthiness (null, 0 and '' are rejections too)
  return { ran: true, outcome: 'ran', result, token, released, ...(signalled ? { signalled } : {}), waitedMs: now().getTime() - startedAt };
}
