/**
 * @fileoverview Shared test helper — bound and de-network a sync driven against
 * a scratch consumer repo.
 *
 * ## Why this exists
 *
 * Three suites drive the real `sync-to-repos.mjs` CLI at a temp repo, and each
 * had picked its own subprocess timeout by hand: 240s in
 * `sync-target-path.test.mjs`, 300s in the two `*-e2e` suites. The sync installs
 * the bundle's dependencies into the target as it goes, under caps of its own —
 * so the outer bound and the inner one were chosen independently, by different
 * authors, in different files, with nothing relating them.
 *
 * They duly went out of step. Measured 2026-09-04: the install's two phases
 * summed to exactly the 240s one of those suites allowed the whole subprocess,
 * so a slow network made the PARENT kill the child. `execFile` reports a kill as
 * `code: null`, so the symptom was a bare `null !== 0` — an assertion naming
 * neither the install nor the network, in a test about argument handling. The
 * other two suites sat one raised default away from the same failure, and
 * reached it the moment the caps were sized to the work they actually do.
 *
 * Two rules follow, and this module exists so all three suites get both:
 *
 *  1. **One bound, derived.** {@link syncBudgetMs} comes from
 *     `installTimeouts()` — the same oracle `ensureAuditDeps` bounds itself
 *     with. The parent can never again be the tighter of the two, whatever the
 *     defaults become.
 *
 *  2. **No install by default.** None of the three suites is ABOUT dependency
 *     installation — they are about the deployment layout, consumer divergence
 *     and outbound EOL. Paying a network round-trip per fixture bought them
 *     nothing: on the machine where this was measured the install exceeded any
 *     cap a test may reasonably impose, cold cache and warm alike. So
 *     {@link seedInstalledDeps} makes the fixture look like a consumer that
 *     already has its deps, and the sync finds nothing to install.
 *
 * `SYNC_TARGET_PATH_INSTALL_REQUIRED=1` opts back into the real install (the
 * AGENTS.md strictness-flag shape — a skipped path must be forceable). Under it
 * the budget widens to cover both install phases and nothing degrades.
 *
 * @module tests/helpers/consumer-fixture
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  installTimeouts, requiredDeps, OPTIONAL_DEPS, MAX_TIMEOUT_MS,
} from '../../scripts/lib/install/deps.mjs';

/** Opt back into a real, network-bound dependency install. */
export const INSTALL_REQUIRED = process.env.SYNC_TARGET_PATH_INSTALL_REQUIRED === '1';

/**
 * Install caps handed to the sync subprocess when an install can happen at all.
 * Below the production defaults on purpose — a test may not sit for ten minutes
 * waiting on a `playwright` tarball — and passed explicitly so the budget below
 * is derived from the same numbers the child is bounded by.
 */
export const INSTALL_ENV = {
  AUDIT_DEPS_INSTALL_TIMEOUT_MS: String(180_000),
  AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS: String(300_000),
};

/**
 * A copy-only sync's ceiling, when no package manager can run.
 *
 * A seeded sync of ~700 files measures 14–18s alone, but `node --test` runs
 * suites at CPU-count concurrency, so three sync suites can overlap each other
 * and everything else in the file set. Measured 2026-09-04, a 180s ceiling was
 * reached under exactly that contention — a kill that has nothing to say about
 * the sync and everything to say about how busy the machine was.
 */
export const COPY_ONLY_CEILING_MS = 600_000;

/** Room for the file-copy half of a sync that ALSO installs. */
const COPY_HEADROOM_MS = 120_000;

/**
 * How long the sync subprocess may take, for a GIVEN environment.
 *
 * Takes the env rather than reading a module constant, because the env is what
 * decides the child's caps. A module-level budget was a regression this file
 * shipped and the round-3 code audit caught (H1/M1, 2026-09-04): once
 * {@link syncExecOptions} let a caller override `AUDIT_DEPS_*`, a caller raising
 * the child's required cap to 900s still got the constant 600s parent timeout —
 * the parent tighter than the child, which is the exact bug this module exists
 * to prevent, reintroduced by the fix for a different finding.
 *
 * The invariant is now unconditional: whatever env a caller composes, the parent
 * budget covers both of the child's install phases plus copy headroom. It is
 * sized that way even when the fixture is seeded and no install can run —
 * costing nothing, and removing the coupling to WHY no install runs.
 *
 * Degenerate case, stated rather than hidden: `installTimeouts` clamps each
 * phase to Node's maximum timer delay, so two maximal caps sum past what any
 * `timeout` can express. At those values (~24 days per phase) the invariant
 * cannot hold, and the budget clamps to the same maximum the child's own caps
 * are clamped to.
 *
 * @param {Record<string, string|undefined>} env
 * @returns {number}
 */
export function syncBudgetForEnv(env) {
  const caps = installTimeouts({ env });
  const needed = Math.max(COPY_ONLY_CEILING_MS, caps.totalMs + COPY_HEADROOM_MS);
  // A silent Math.min(MAX_TIMEOUT_MS, needed) here is exactly the bug this
  // module exists to prevent, one level up: it would return a parent budget
  // BELOW what the child's own caps demand, and the round-4/round-5 audits
  // (M2, M1+M3 — 2026-09-04) kept re-raising it under different names because
  // "silently violate your own invariant" reads as a live defect no matter how
  // it is worded. There is no smaller-but-still-correct number to return —
  // Node's execFileSync cannot express a timeout past MAX_TIMEOUT_MS, so no
  // single parent deadline can cover child phases that sum past it. The honest
  // fix is not a bigger number; it is refusing to lie about the one we have.
  if (needed > MAX_TIMEOUT_MS) {
    throw new Error(
      `syncBudgetForEnv: install caps sum to ${caps.totalMs}ms; with copy headroom that `
      + `needs ${needed}ms, past Node's timer maximum (${MAX_TIMEOUT_MS}ms). No single parent `
      + `timeout can cover both child phases here — lower AUDIT_DEPS_INSTALL_TIMEOUT_MS / `
      + `AUDIT_DEPS_OPTIONAL_INSTALL_TIMEOUT_MS.`,
    );
  }
  return needed;
}

/** The budget for the default environment — what a caller passing no `env` gets. */
export const syncBudgetMs = syncBudgetForEnv({ ...process.env, ...INSTALL_ENV });

/** The line `ensureAuditDeps` prints when it finds nothing to do. */
export const DEPS_SATISFIED_MARKER = 'all audit-loop deps present';

/**
 * Make a scratch consumer look like one whose deps are already installed.
 *
 * Each dep gets a directory AND a minimal `package.json`, because that manifest
 * is what `findMissingDeps` actually probes for. An earlier version wrote bare
 * directories, which satisfied a weaker probe and so encoded — in a fixture —
 * the very "a directory is an install" assumption the round-1 code audit
 * flagged as wrong in production (H1/H4, 2026-09-04). Both were fixed together:
 * a fixture that can satisfy a check the real thing could not is not a fixture,
 * it is a hole. `seedSatisfiesProductionProbe` below is the binding that keeps
 * them together — if the probe tightens again, that test fails here first.
 *
 * Deliberately NOT a link to this repo's own `node_modules`: were the seed ever
 * incomplete, the package manager would install the remainder straight into the
 * SOURCE checkout's tree. A written-from-scratch tree cannot do that. It also
 * stays tiny — one small file per dep, against the tens of thousands a real
 * install adds to a fixture that runs `git add -A`.
 *
 * No-op under {@link INSTALL_REQUIRED}, which is what makes the flag meaningful.
 *
 * @param {string} repoRoot — the scratch consumer's root
 */
export function seedInstalledDeps(repoRoot) {
  if (INSTALL_REQUIRED) return;
  for (const dep of [...requiredDeps(), ...OPTIONAL_DEPS]) {
    const dir = path.join(repoRoot, 'node_modules', dep);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      `${JSON.stringify({ name: dep, version: '0.0.0-fixture' }, null, 2)}
`,
    );
  }
}

/**
 * `execFile` options every one of these suites needs: the derived budget, a
 * buffer big enough for a full sync report, and the install caps in the child's
 * environment.
 *
 * `timeout` is NOT part of the accepted shape — the JSDoc type says so
 * explicitly, rather than advertising the full `ExecFileOptions` and quietly
 * discarding the one field this module exists to own. A caller who passes one
 * anyway gets a thrown error naming why, the same "refuse to lie" pattern
 * {@link syncBudgetForEnv} already uses for its own unrepresentable case
 * (round-6 code audit M1, 2026-09-04 — the prior version's JSDoc claimed the
 * full `ExecFileOptions` shape while silently dropping `timeout`).
 *
 * @param {Omit<import('node:child_process').ExecFileOptions, 'timeout' | 'env'>} [extra]
 */
export function syncExecOptions({ env: callerEnv, timeout: callerTimeout, ...extra } = {}) {
  if (callerTimeout !== undefined) {
    throw new Error(
      'syncExecOptions: `timeout` is not a supported option — the budget is always '
      + 'derived from the composed env via syncBudgetForEnv. Pass `env` to influence it.',
    );
  }
  const env = { ...process.env, ...INSTALL_ENV, ...callerEnv };
  return {
    maxBuffer: 32 * 1024 * 1024,
    ...extra,
    // `env` and `timeout` are composed, never spread over — for the same reason
    // in both cases: `...extra` last let a caller silently override either one.
    // For `env` that dropped the install caps (round-2 M2). For `timeout` it is
    // worse: this whole module exists so the parent budget is DERIVED from the
    // caps, never hand-picked, and `{...extra}` after `timeout:` let any caller
    // hand back exactly the hand-picked number this module removes (round-5
    // M2, 2026-09-04 — `syncExecOptions({timeout:5})` returned `timeout:5`,
    // silently discarding the derived 600000ms). No call site needs a manual
    // override — `callerTimeout` is destructured out and discarded on purpose,
    // so passing one is a silent no-op rather than a silent win.
    env,
    timeout: syncBudgetForEnv(env),
  };
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYNC_CLI = path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs');
const execFileAsync = promisify(execFile);

/**
 * Run the real `sync-to-repos.mjs` CLI and normalise the outcome.
 *
 * One wrapper, because there were three: each sync suite owned its own copy of
 * "spawn the CLI, keep stdout/stderr, turn an execFile rejection into a result
 * object" — and they had already drifted. Two normalised `code` to 1 and exposed
 * a combined `out`, the third kept the raw code and separate streams, and none
 * recorded the timeout it actually ran under (round-4 code audit M4, with M1/M3
 * as the drift that DRY violation was hiding).
 *
 * `code` is left RAW: `null` on a kill, the real exit status otherwise.
 * Normalising it to 1 discards the one bit that says whether the CLI decided the
 * outcome or we did, and nothing asserts on the normalised value.
 *
 * `timeoutMs` is the budget THIS call ran under, carried on the result so
 * {@link whySyncFailed} can report the timeout that actually applied rather than
 * the module default — which is wrong for any caller that composed its own env.
 *
 * @param {string[]} argv — arguments after the CLI path
 * @param {import('node:child_process').ExecFileOptions} [opts]
 */
export async function runSyncCli(argv, opts = {}) {
  const execOpts = syncExecOptions({ cwd: REPO_ROOT, ...opts });
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [SYNC_CLI, ...argv], execOpts);
    return {
      code: 0, stdout, stderr, out: stdout + stderr,
      signal: null, killed: false, timeoutMs: execOpts.timeout,
    };
  } catch (err) {
    const stdout = err.stdout ?? '';
    const stderr = err.stderr ?? '';
    return {
      code: err.code, stdout, stderr, out: stdout + stderr,
      signal: err.signal ?? null,
      killed: err.killed === true || err.signal != null,
      timeoutMs: execOpts.timeout,
    };
  }
}

/**
 * Why a sync subprocess did not exit 0 — naming a KILL as a kill.
 *
 * `execFile` reports a timeout kill as `code: null`, so an assertion that prints
 * only the code says `null !== 0` and sends the next reader after a CLI bug that
 * is not there.
 *
 * The timeout it names is the one the call actually ran under (`r.timeoutMs`),
 * falling back to the module default only for a result carrying none. Quoting
 * the module constant while the call used a caller-composed budget points the
 * reader at the wrong number (round-4 code audit M1/M3).
 *
 * @param {{code: unknown, signal?: string|null, killed?: boolean, timeoutMs?: number, stdout?: string, stderr?: string, out?: string}} r
 */
export function whySyncFailed(r) {
  const text = r.out ?? `${r.stderr ?? ''}${r.stdout ?? ''}`;
  const tail = String(text).slice(-1500);
  const killed = r.killed === true || (r.code === null && r.signal != null);
  const budget = r.timeoutMs ?? syncBudgetMs;
  return killed
    ? `sync was KILLED after ${budget}ms (signal ${r.signal ?? 'SIGTERM'}) — `
      + `not a CLI exit code. Tail:\n${tail}`
    : `sync failed (exit ${r.code}): ${tail}`;
}
