/**
 * @fileoverview `runUnderLease`: the ONE implementation of "take the machine's heavy slot, run a job, give it back"
 * (plan docs/plans/fleet-lease-turns-and-journal.md D7). `fleet lease run -- <cmd>` and `sync:pr` both call it, because two
 * incidents had a single cause - a caller getting the protocol wrong: a wrapper that ignored a REFUSED acquire and ran the
 * command anyway (2026-10-14 12:30Z), and a `timeout` wrapper that SIGTERMed the push it was protecting (2026-10-15 00:13Z).
 *
 *  1. acquire EXCLUSIVELY (a second run under the same identity is refused, never rotated), recording the runner's own pid -
 *     valid here, unlike the one-shot CLI whose pid #243 refuses to record, because the runner lives until the job ends;
 *  2. refused -> wait in the queue, bounded (`waitMin`), polling with jitter; the job NEVER runs after a refusal. The wait is a
 *     RUNNER on the repo's waiter entry (its pid, its priority): a stop signal during it, or its launcher dying (a killed train
 *     script), withdraws it and ends the run without the job - a waiter nobody is waiting on must not start a job for nobody
 *     (consumer report 2026-11-27; plan docs/plans/fleet-lease-orphan-waiters-and-priority.md D3);
 *  3. granted -> `await job({token, attach, signal})`;
 *  4. release on every CATCHABLE exit (returns, throws, SIGINT/SIGTERM/SIGHUP/SIGBREAK) with the token, as a plain release, a
 *     release that yields the turn (`endTurn`), or the atomic release-to-CI-window when the job may have reached a remote.
 *
 * SIGKILL and power loss cannot be caught: the lease expires and the recorded pid decides takeover (#243 D4). While the job
 * runs, a HEARTBEAT (`decideHeartbeat`, every `heartbeatMs`) renews the lease up to the run's ceiling (`ceilingMin`, else
 * `LIMITS.heartbeatMaxMs`), so a long run never reads EXPIRED (consumer report 2026-11-15: a live 2-hour suite read expired and
 * was nearly forced). Each beat records the job's process-TREE CPU; a tree idle for `LIMITS.treeIdleMs` stops renewing, so the
 * lease expires and a person can judge it. Nothing here, or anywhere, takes a slot from a live holder automatically.
 *
 * Every effect is injected (clock, sleep, probe, signals, transact, exit) so the protocol is tested without processes.
 *
 * @module scripts/lib/fleet/lease-run
 */
import {
  LIMITS, decideAcquire, decideAttach, decideHeartbeat, decideRelease, decideReleaseToCiWindow, decideWithdrawRunner, defaultProbe, transactLease, turnKeptText,
} from './lease.mjs';
import { launcherChain, processTreeActivity, readProcessTableAsync } from './lease-cpu.mjs';
import { isPidAlive } from '../file-lock.mjs';

/** Interval timers for the heartbeat, unref'd so a beat can never keep the process alive after its job. */
export const realTimers = {
  every(ms, fn) { const t = setInterval(fn, ms); t.unref?.(); return t; },
  cancel(t) { clearInterval(t); },
};

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
const RETRYABLE = new Set(['held', 'window', 'turn', 'expired-pid-alive', 'priority']);

/**
 * Has the process that launched this runner gone? The chain (parent and up to two further ancestors, `launcherChain`) is read
 * ONCE, lazily, at the first check - a run granted at once never reads the process table - and a link whose parent was already
 * gone at that read is a launcher gone. A failed read degrades to the parent alone, said once through `log`. On POSIX a
 * changed `process.ppid` (reparented) also means the parent is gone. A check that cannot be made keeps the run waiting (the
 * safe direction: the queue's own expiry still bounds it) and is said, never silent (audit R1 H9). Never throws.
 *
 * A pid alone cannot tell a dead launcher from a new process that reused its pid (Windows recycles them quickly), so every
 * `recheckMs` the table is read again and a link whose start time moved by more than `startToleranceMs`, or that is missing, is
 * gone (audit R2 H4). A tolerance, not equality: `ps` gives elapsed time, so a POSIX start is the read clock minus it and
 * wobbles by a second between reads (audit R3 H2); Windows reports the creation time itself, so there it must match exactly
 * (audit R4 H3). A row or start time the re-read does not have is UNKNOWN, not reused: only a different valid time proves
 * another process (audit R4 H4).
 * Between re-reads the cheap `isAlive` probe answers. One table read per 5 minutes of waiting, not one per poll.
 * @returns {{gone: () => Promise<string|null>}} why it is gone, or null while it lives or cannot be told
 */
export function launcherWatch({ pid = process.pid, ppid = () => process.ppid, readTable = readProcessTableAsync, isAlive = isPidAlive, platform = process.platform, log = () => {}, clock = Date.now, recheckMs = 5 * 60_000, startToleranceMs = platform === 'win32' ? 0 : 3_000 } = {}) {
  const ppid0 = ppid();
  let chain = null;
  let starts = new Map(); // pid -> startedAt at the first read (null when the table did not say)
  let brokenAtRead = null;
  let readAt = 0;
  let said = false;
  const sayOnce = (m) => { if (!said) { said = true; log(m); } };
  return {
    async gone() {
      try {
        if (chain === null) {
          const rows = await readTable();
          readAt = clock();
          const c = rows ? launcherChain(rows, pid) : { chain: [], broken: null };
          if (!rows) sayOnce(`the process table could not be read; only the parent (pid ${ppid0}) is watched for this wait`);
          brokenAtRead = c.broken;
          chain = c.chain.length ? c.chain : (ppid0 > 0 ? [ppid0] : []);
          starts = new Map(chain.map((p) => [p, rows?.find((r) => r.pid === p)?.startedAt ?? null]));
        }
        if (brokenAtRead !== null) return `the process that launched pid ${brokenAtRead} was already gone`;
        if (platform !== 'win32' && ppid() !== ppid0) return `its parent (pid ${ppid0}) exited`;
        const dead = chain.find((p) => !isAlive(p));
        if (dead !== undefined) return `the process that launched it (pid ${dead}) is gone`;
        if (clock() - readAt >= recheckMs && [...starts.values()].some((s) => s !== null)) {
          readAt = clock();
          const rows = await readTable();
          if (rows) {
            const byPid = new Map(rows.map((r) => [r.pid, r]));
            const moved = (a, b) => Number.isFinite(Date.parse(b)) && Math.abs(Date.parse(a) - Date.parse(b)) > startToleranceMs;
            const reused = chain.find((p) => starts.get(p) !== null && moved(starts.get(p), byPid.get(p)?.startedAt));
            if (reused !== undefined) return `the process that launched it (pid ${reused}) is gone; that pid now belongs to another process`;
          }
        }
        return null;
      } catch (e) {
        sayOnce(`could not check whether the launcher is alive (${e?.message ?? e}); waiting on regardless`);
        return null;
      }
    },
  };
}

/** The default sleep: a timer that an abort clears, so a stopped wait leaves nothing holding the process open (audit R1 H6). */
export const cancellableSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) { resolve(); return; }
  const done = () => { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); };
  const t = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

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
 * @param {'normal'|'high'} [opts.priority] - order among this repo's OWN waiting runs (a train is `high`); default normal
 * @param {{gone: () => Promise<string|null>}|null} [opts.launcher] - asked each poll; gone ends the wait (`code: 'orphaned'`)
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
    sleep = cancellableSleep, forceExit = (code) => process.exit(code),
    heartbeatMs = LIMITS.heartbeatMs, ceilingMin, cpuOf = (p) => processTreeActivity(p), timers = realTimers, onGranted = null,
    priority, launcher = null,
  } = opts;
  const startedAt = now().getTime();
  const deadline = startedAt + Math.max(0, waitMin) * 60_000;
  const req = { identity, repo, kind, forMin, pid, exclusive: true, ...(note !== undefined ? { note } : {}), ...(priority !== undefined ? { priority } : {}) };

  // Stop signals are handled from the FIRST moment (D3): while waiting, a stop ends the wait and the job never starts; once
  // granted, it aborts the job. A second one forces the exit in either phase. Installed before the wait, removed after the release.
  const abort = new AbortController();
  let signalled = null;
  const removeSignals = signals.install((sig) => {
    if (signalled) { forceExit(exitCodeForSignal(signalled)); return; }
    signalled = sig;
    abort.abort();
  });
  const stopped = new Promise((r) => { abort.signal.addEventListener('abort', r, { once: true }); });
  /** The wait ends without the job: this runner leaves the queue (`keepPlace`: the repo stays queued, as a refused acquire does). */
  const giveUp = (res, keepPlace) => {
    const w = runDecision(transact, dir, (lease) => decideWithdrawRunner(lease, { identity, repo, pid }, now(), probe, { keepPlace }));
    if (w.status !== 'decided') log(`could not leave the queue (${w.reason}); the entry is reaped once this process has exited`);
    removeSignals();
    return { ...res, waitedMs: now().getTime() - startedAt };
  };

  // 1-2. Acquire, waiting in the queue when allowed. The job does not run unless this loop ends in a grant.
  let grant;
  for (let attempt = 0; ; attempt += 1) {
    // Checked before EVERY re-acquire, not only after a refusal: a launcher that died during the sleep must not be granted the
    // slot that freed meanwhile (audit R1 H4/H7/H8).
    // Raced against a stop: a slow process-table read never delays the withdrawal a stop signal asks for (audit R2 H6).
    const gone = attempt > 0 && launcher ? await Promise.race([launcher.gone(), stopped.then(() => null)]) : null;
    if (gone) return giveUp({ ran: false, outcome: 'not-granted', code: 'orphaned', reason: `stopped waiting: ${gone}, so nothing is waiting for this job`, orphaned: gone, queued: false }, false);
    if (signalled) return giveUp({ ran: false, outcome: 'not-granted', code: 'stopped', reason: `stopped by ${signalled} while waiting for the slot`, signalled, queued: false }, false);
    const out = runDecision(transact, dir, (lease) => decideAcquire(lease, req, now(), probe));
    // After a refusal registered this runner, an error still withdraws it (keeping the repo's place): a library caller such as
    // sync:pr lives on, so its pid would read alive and hold a stale runner for runnerStaleMs (audit R3 M2).
    if (out.status === 'error') {
      const res = { ran: false, outcome: 'lease-error', reason: out.reason };
      if (attempt > 0) return giveUp(res, true);
      removeSignals();
      return { ...res, waitedMs: now().getTime() - startedAt };
    }
    const d = out.decision;
    if (d.ok) { grant = d; break; }
    if (d.code === 'bad-request') { removeSignals(); return { ran: false, outcome: 'bad-request', reason: d.reason }; }
    const left = deadline - now().getTime();
    if (!RETRYABLE.has(d.code) || left <= 0) {
      return giveUp({ ran: false, outcome: 'not-granted', code: d.code, reason: d.reason, queued: d.queued === true }, true);
    }
    const wait = Math.min(left, Math.max(1, Math.round(pollMs * (1 + (random() * 2 - 1) * jitter))));
    log(`waiting in the queue (${d.code}); next try in ${Math.round(wait / 1000)}s`);
    await Promise.race([sleep(wait, abort.signal), stopped]);
  }
  const token = grant.heavy.token;
  if (grant.capped) log(`CAPPED: granted ${grant.capped.grantedMin} of the requested ${grant.capped.requestedMin} minutes - the turn ends at ${grant.capped.turnEndsAt.slice(11, 16)}Z and ${grant.capped.waiting} is waiting; the slot is released for them then unless this job is still running`);

  // 3. Run. Signals abort the job's AbortSignal; the job stops itself, and we release afterwards.
  let childPid = null;
  const attach = async (pid0) => {
    const out = runDecision(transact, dir, (lease) => decideAttach(lease, { identity, pid: pid0, token }, now(), probe));
    const okAttach = out.status === 'decided' && out.decision.ok === true;
    if (okAttach) childPid = pid0;
    return okAttach;
  };
  // Heartbeat: renew while the job's process tree is alive and not idle, up to the ceiling, so a long run never reads EXPIRED.
  const ceilingAt = new Date(now().getTime() + (ceilingMin ? ceilingMin * 60_000 : LIMITS.heartbeatMaxMs));
  let beating = heartbeatMs > 0;
  let stoppedSaid = false;
  let failing = false; // one line per streak of failed beats, not one a minute
  // Every outcome is handled, and nothing escapes the timer callback (audit R1 H5/H6): a refused beat (released, forced, another
  // holder) stops beating; an error (lock contention, an unreadable lease, a throw) is said once and retried on the next tick —
  // the lease simply is not renewed meanwhile, which is the safe direction. The job itself is never affected.
  let inFlight = false; // a slow table read never stacks a second beat behind it
  const beat = async () => {
    if (!beating || inFlight) return;
    inFlight = true;
    try {
      const act = await cpuOf(childPid ?? pid);
      if (!beating) return; // the job ended while the table was being read
      const activity = typeof act === 'number' ? { cpuMs: act } : act ?? {};
      const out = runDecision(transact, dir, (lease) => decideHeartbeat(lease, { identity, token, cpuMs: activity.cpuMs, procs: activity.procs }, now(), { ceilingAt }));
      if (out.status !== 'decided') { if (!failing) log(`heartbeat not recorded (${out.reason}); retrying each minute`); failing = true; return; }
      if (!out.decision.ok) { beating = false; log(`heartbeat stopped: ${out.decision.reason}`); return; }
      if (failing) log('heartbeat recorded again');
      failing = false;
      if (!out.decision.renewing && !stoppedSaid) { stoppedSaid = true; log(`the job's process tree has used no CPU for ${Math.round(LIMITS.treeIdleMs / 60_000)} minutes: the lease is no longer renewed and will expire (it may be blocked on I/O or a lock); the job keeps running`); }
    } catch (e) {
      if (!failing) log(`heartbeat failed (${e?.message ?? e}); retrying each minute`);
      failing = true;
    } finally { inFlight = false; }
  };
  const timer = heartbeatMs > 0 ? timers.every(heartbeatMs, beat) : null;
  let result; let threw = false; let thrown;
  try {
    // Granted, the job not yet started: the caller's last look before it runs (the CPU-saturation warning, item 6). It runs
    // INSIDE the protected lifecycle — signals are installed and the release below follows it — and is never fatal.
    if (onGranted) { try { await onGranted(grant); } catch { /* a warning that cannot be computed is no reason not to run */ } }
    // A stop signal during it: the job never starts, and the slot is released below like any other stop.
    result = signalled ? {} : await job({ token, attach, signal: abort.signal });
  } catch (e) { threw = true; thrown = e; }
  beating = false;
  if (timer) timers.cancel(timer);

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
