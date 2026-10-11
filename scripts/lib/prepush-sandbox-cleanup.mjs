/**
 * @fileoverview Directory removal + stale-husk sweep for the pre-push sandbox.
 *
 * WHY THIS EXISTS (measured 2026-08-01): 21 `ces-prepush-*` husks accumulated
 * in %TEMP% over three days — one per push — each containing exactly one
 * surviving entry, `node_modules`. The cause is NOT a swallowed error, which
 * was the intuitive reading. It is that
 *
 *     git worktree remove --force <sandbox>
 *
 * EXITS 0 while leaving the directory standing, whenever the worktree contains
 * an entry git declines to delete. `provisionNodeModules()` puts exactly such
 * an entry there on every single run (a `node_modules` junction, or a real
 * installed tree). Reproduced directly: git deregisters the worktree, deletes
 * the tracked files, returns exit status 0, and the directory remains with
 * `node_modules` inside.
 *
 * So the runner's fallback `rmSync` was never reached — it lived in the `catch`
 * of a call that always succeeded. The leak was invisible because the ONLY
 * thing that ever looked was git's own exit code.
 *
 * THE RULE THIS ENCODES, which is the repo's own doctrine turned on its own
 * tooling: a success signal from a subprocess is not evidence of the
 * postcondition. `stat` is. Every function here reports what it OBSERVED on
 * disk afterwards, never what an exit code claimed.
 *
 * Sweeping is the companion: single-run cleanup cannot be made total on
 * Windows (a `SIGKILL`, a held handle, a lost race with an AV scanner all
 * defeat it), so a later run removes what an earlier one could not. Failure to
 * clean temp is machine state, never repo state — it warns, and must never
 * block a push.
 *
 * @module scripts/lib/prepush-sandbox-cleanup
 */
import fs from 'node:fs';
import path from 'node:path';

/** Directory-name prefix used by scripts/prepush-check.mjs for its sandbox. */
export const SANDBOX_PREFIX = 'ces-prepush-';

/**
 * The file `scripts/prepush-check.mjs` writes into a sandbox it PRESERVES as
 * evidence (a failed `npm ci`). Its presence means "this husk is deliberately
 * kept": the owner process exited NORMALLY, so a dead owner pid says nothing
 * about abandonment and only the age rule may sweep it. The runner and the
 * sweeper share this one name — a second spelling is how one of them would stop
 * seeing the other's evidence.
 */
export const PRESERVED_EVIDENCE_FILE = '.prepush-npm-ci.log';

/**
 * How old a husk must be before a later run will sweep it REGARDLESS of who
 * owns it.
 *
 * The only thing this threshold has to clear is a CONCURRENT push's live
 * sandbox — two sessions share this repo's working tree, so a second push can
 * legitimately have a fresh sandbox on disk while this one starts. `npm run
 * check` is a minutes-long job, so six hours is orders of magnitude of
 * headroom, while still self-healing within a day rather than at the point the
 * temp volume fills. Age is a sufficient discriminator here precisely because
 * a live sandbox is always young.
 *
 * Age is the FLOOR, not the only rule: a husk whose owner process is provably
 * dead is swept at once (see {@link surveySandboxes}). Age remains the sole
 * rule whenever ownership cannot be established — a live, unknown or
 * evidence-preserving owner — because there a wrong "abandoned" is the
 * expensive error and a late sweep is only disk space.
 */
export const STALE_SANDBOX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The pid of the process that created a sandbox: the digits after the LAST `-`
 * in `ces-prepush-<sha8>-<pid>` (the runner names it with `process.pid`).
 *
 * @param {string} name - a directory name, not a path
 * @returns {number|null} null when the name carries no usable pid. `0` and
 *   negative values are refused: `process.kill(0, …)` addresses a whole process
 *   GROUP, which is not an owner.
 */
export function sandboxOwnerPid(name) {
  const m = /-(\d+)$/.exec(name);
  if (!m) return null;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Is a process with this pid running right now?
 *
 *   'dead'    - ESRCH: no such process. The only answer that licenses a sweep.
 *   'alive'   - it exists (EPERM counts: it exists, we just may not signal it).
 *   'unknown' - anything else; liveness could not be established.
 *
 * Signal 0 performs the existence check without delivering anything, on POSIX
 * and on Windows alike (libuv opens the process and reads its exit code).
 *
 * PID REUSE can only turn a dead owner into an 'alive' reading, never the
 * reverse, so it fails SAFE: that husk simply falls back to the age rule. It is
 * deliberately not chased with a process-start-time probe (a platform-specific
 * spawn per husk) — that would buy a faster sweep of a rare case, not safety.
 *
 * @param {number} pid
 * @returns {'alive'|'dead'|'unknown'}
 */
export function probePidAlive(pid) {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    if (error?.code === 'ESRCH') return 'dead';
    if (error?.code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

/**
 * Remove a directory and report whether it is ACTUALLY gone afterwards.
 *
 * Never throws: callers are cleanup paths that must not convert a temp-file
 * problem into a failed push.
 *
 * The post-removal `existsSync` is the whole point of this function, not
 * belt-and-braces. Its contract is the postcondition ("the path is gone"), not
 * the absence of a throw — which is the exact distinction the `git worktree
 * remove` bug in the module header turns on.
 *
 * @param {string} dir
 * @returns {{removed: boolean, error?: Error}}
 */
export function removeSandboxDir(dir) {
  if (!fs.existsSync(dir)) return { removed: true };
  try {
    // Windows holds handles briefly after a process exits; retry per the
    // repo-wide rmSync hardening contract (tests/rmsync-retry-guard.test.mjs
    // — a static lint over call-site SYNTAX, not this claim).
    //
    // rmSync does not follow the node_modules junction into the main
    // checkout's real tree — behaviourally verified against the exact shape
    // provisionNodeModules() creates, junction + git-worktree-remove fallback
    // included, in tests/prepush-sandbox-cleanup.test.mjs. A field incident
    // (2026-08-19) still reported the main checkout's node_modules emptied
    // during a run this call could not reproduce even against that fixture —
    // see prepush-check.mjs's postcondition guard (mainModulesForGuard) for
    // the belt-and-braces check that turns any future recurrence, from
    // whatever the actual mechanism turns out to be, into a loud failure
    // instead of a silent one.
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch (error) {
    return { removed: false, error };
  }
  if (fs.existsSync(dir)) {
    return { removed: false, error: new Error('rmSync reported success but the path is still present') };
  }
  return { removed: true };
}

/**
 * List sandbox husks in `tmpDir` certainly abandoned: older than the age
 * threshold, or owned by a process that is provably dead.
 *
 * @param {string} tmpDir
 * @param {object} [opts] - forwarded to {@link surveySandboxes}
 * @returns {string[]} absolute paths
 */
export function findStaleSandboxes(tmpDir, opts = {}) {
  return surveySandboxes(tmpDir, opts).stale;
}

/**
 * Why a husk was left alone. `owner-alive` is the safety property (a concurrent
 * push's sandbox); the rest are the cases where abandonment cannot be proved, so
 * only the age rule applies.
 */
export const RETAINED_REASONS = Object.freeze([
  'owner-alive', 'owner-unknown', 'evidence-preserved', 'no-owner-pid',
]);

/**
 * Split the sandbox husks in `tmpDir` into those to sweep and those deliberately
 * left alone.
 *
 * A husk is swept when EITHER
 *   - it is at least `maxAgeMs` old (the original rule, unchanged), OR
 *   - its owner process is provably dead (`ownerDead`): a push killed with
 *     SIGKILL / `taskkill /F` / TaskStop / a closed terminal runs no handler, so
 *     its sandbox outlives it with the worktree still REGISTERED. Measured
 *     2026-10-11: two pushes stopped mid-gate left `ces-prepush-a4d6ea00-77848`
 *     and `…-fc2be6f7-82364`, which `git worktree list` kept showing — and the
 *     fleet scan counted — until a human removed them, because both were far
 *     younger than the six-hour age rule.
 *
 * A husk is NEVER swept early when the owner is alive (a concurrent push), when
 * liveness cannot be established, when the name carries no pid, or when it holds
 * {@link PRESERVED_EVIDENCE_FILE} (kept on purpose by a process that exited
 * normally, so its dead pid is not abandonment). Those fall back to age alone.
 *
 * `young` exists because SILENCE IS AMBIGUOUS (2026-08-30). The runner logged a
 * line only when it swept something, so "swept nothing because %TEMP% is clean"
 * and "swept nothing because every husk is younger than the six-hour threshold"
 * printed identically. A failing push with three husks on disk and no sweep line
 * read as a broken sweeper; measured afterwards, the oldest was 3h old and the
 * sweep had been exactly right. An unasked question must never render as an
 * empty result — so each retained husk carries WHY it was kept.
 *
 * @param {string} tmpDir
 * @param {object} [opts]
 * @param {number} [opts.now] - injectable clock, so the age rule is testable
 * @param {number} [opts.maxAgeMs]
 * @param {string} [opts.prefix]
 * @param {(pid: number) => 'alive'|'dead'|'unknown'} [opts.probeOwner] - injectable liveness probe
 * @returns {{stale: string[], ownerDead: string[],
 *   young: Array<{dir: string, ageMs: number, retained: string}>}}
 *   `ownerDead` is the subset of `stale` that is swept for its dead owner rather
 *   than its age.
 */
export function surveySandboxes(tmpDir, opts = {}) {
  const {
    now = Date.now(),
    maxAgeMs = STALE_SANDBOX_AGE_MS,
    prefix = SANDBOX_PREFIX,
    probeOwner = probePidAlive,
  } = opts;

  let entries;
  try {
    entries = fs.readdirSync(tmpDir, { withFileTypes: true });
  } catch {
    return { stale: [], ownerDead: [], young: [] }; // unreadable temp dir is not this gate's problem
  }

  const stale = [];
  const ownerDead = [];
  const young = [];
  for (const entry of entries) {
    // Prefix-scoped on purpose: %TEMP% is shared with every other tool on the
    // machine, and with this repo's own test fixtures (ces-db-test-*,
    // ces-arch-gate-*) which have different owners and lifetimes.
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const abs = path.join(tmpDir, entry.name);
    try {
      const ageMs = now - fs.statSync(abs).mtimeMs;
      if (ageMs >= maxAgeMs) { stale.push(abs); continue; }

      const retained = retentionReason(abs, entry.name, probeOwner);
      if (retained === null) { stale.push(abs); ownerDead.push(abs); } else young.push({ dir: abs, ageMs, retained });
    } catch {
      // Vanished or unstattable between readdir and stat — nothing to do.
    }
  }
  return { stale, ownerDead, young };
}

/**
 * Why a not-yet-aged husk must be kept, or `null` when its owner is provably
 * dead and nothing marks it as deliberately preserved.
 * @returns {string|null} one of {@link RETAINED_REASONS}, or null (sweep it)
 */
function retentionReason(abs, name, probeOwner) {
  if (fs.existsSync(path.join(abs, PRESERVED_EVIDENCE_FILE))) return 'evidence-preserved';
  const pid = sandboxOwnerPid(name);
  if (pid === null) return 'no-owner-pid';
  let state;
  try { state = probeOwner(pid); } catch { state = 'unknown'; } // a probe that throws proved nothing
  if (state === 'dead') return null;
  return state === 'alive' ? 'owner-alive' : 'owner-unknown';
}

/**
 * Remove every stale husk in `tmpDir`. Never throws.
 *
 * @param {string} tmpDir
 * @param {object} [opts] - forwarded to surveySandboxes
 * @returns {{swept: string[], sweptDeadOwner: string[], failed: string[],
 *   young: Array<{dir: string, ageMs: number, retained: string}>}}
 *   `young` is what was seen and deliberately NOT swept — see
 *   {@link surveySandboxes} for why reporting it matters. `sweptDeadOwner` is the
 *   subset of `swept` removed because its owner process was dead, not its age.
 */
export function sweepStaleSandboxes(tmpDir, opts = {}) {
  const { stale, ownerDead, young } = surveySandboxes(tmpDir, opts);
  const swept = [];
  const sweptDeadOwner = [];
  const failed = [];
  for (const dir of stale) {
    if (!removeSandboxDir(dir).removed) failed.push(dir);
    else {
      swept.push(dir);
      if (ownerDead.includes(dir)) sweptDeadOwner.push(dir);
    }
  }
  return { swept, sweptDeadOwner, failed, young };
}
