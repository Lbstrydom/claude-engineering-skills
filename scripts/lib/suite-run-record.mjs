/**
 * @fileoverview The suite-run record: the ONE durable fact about how long this repo's test suite takes on this
 * machine. `scripts/run-tests.mjs` writes it after a green run; `doctor`'s operating probes read it
 * (docs/plans/adoption-fit-check.md section 2.3).
 *
 * Before this the wall time existed nowhere durable: the runner's timing report lives in an `os.tmpdir()` folder it
 * deletes, and the `test-tier/v1` summary line carries no timing. One writer and one reader live HERE, on both sides
 * of the seam, so the schema cannot drift between them.
 *
 * `wallMs` is the TEST STEP only, so it is a LOWER BOUND on what a push puts in the heavy slot (the gate's other steps
 * are extra). Consumers must decide in the sound direction only (plan section 2.5).
 *
 * Location: `<git-common-dir>/suite-runs/<kind>.json`, so the pre-push sandbox's throwaway worktree and every linked
 * worktree write to the one place doctor reads. Last writer wins per kind, which is what "latest" means.
 *
 * @module scripts/lib/suite-run-record
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { atomicWriteFileSync } from './file-io.mjs';

export const SUITE_RUN_SCHEMA = 'suite-run/v1';
/** `full` = the default set; `branch` = the default set minus a tier envelope's skipped heavy files. */
export const SUITE_RUN_KINDS = Object.freeze(['full', 'branch']);
/** A record older than this is not evidence about the machine as it is now. */
export const SUITE_RUN_MAX_AGE_DAYS = 30;
const DAY_MS = 86_400_000;
/** A record stamped further ahead than this was written under a wrong clock: it cannot be aged, so it is not evidence. */
export const SUITE_RUN_CLOCK_SKEW_MS = 5 * 60_000;

const RecordSchema = z.strictObject({
  schema: z.literal(SUITE_RUN_SCHEMA),
  kind: z.enum(SUITE_RUN_KINDS),
  wallMs: z.number().int().nonnegative(),
  files: z.number().int().nonnegative().nullable(),
  finishedAt: z.string().refine((s) => Number.isFinite(Date.parse(s)), 'an ISO timestamp'),
  head: z.string().nullable(),
  cores: z.number().int().positive(),
  platform: z.string().min(1),
});

/** @returns {string} the machine's usable core count (`availableParallelism` where the runtime has it). */
export function coreCount() {
  return typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
}

/**
 * Which kind of record a run earns, or null when it earns none. Pure.
 * A preflight and a caller-narrowed run are not the suite (whatever else is set); the tier run is the `branch` kind.
 *
 * @param {{preflight: boolean, tierSkip: unknown, userArgs: string[]}} run
 * @returns {'full'|'branch'|null}
 */
export function suiteRunKind({ preflight, tierSkip, userArgs }) {
  // Caller scope is judged before either kind: a narrowed run is neither the suite nor the tier, whatever else is set.
  if (preflight || userArgs.length > 0) return null;
  return tierSkip ? 'branch' : 'full';
}

export function suiteRunPath(commonDir, kind) {
  if (!SUITE_RUN_KINDS.includes(kind)) throw new Error(`suite-run kind must be one of ${SUITE_RUN_KINDS.join(', ')} (got ${JSON.stringify(kind)})`);
  return path.join(commonDir, 'suite-runs', `${kind}.json`);
}

/** The absolute git common dir of `cwd`, or null when `cwd` is not in a git work tree. */
export function gitCommonDir(cwd) {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000,
    }).replace(/\r?\n$/, '');
    return out || null;
  } catch {
    return null;
  }
}

function gitHead(cwd) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, timeout: 10_000,
    }).trim() || null;
  } catch {
    return null;
  }
}

/** Validate and write one record. Throws on an invalid record or an I/O failure; `recordSuiteRun` is the no-throw wrapper. */
export function writeSuiteRunRecord(commonDir, record) {
  const valid = RecordSchema.parse(record);
  const file = suiteRunPath(commonDir, valid.kind);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, `${JSON.stringify(valid, null, 2)}\n`);
  return file;
}

/**
 * Best-effort: record a finished run. Never throws and never touches the exit code: a failure is a returned note,
 * exactly like `TEST_TIMING_KEEP`. Writes only a GREEN run of a kind that is the suite.
 *
 * @param {{preflight: boolean, tierSkip: unknown, userArgs: string[], exitCode: number, wallMs: number,
 *          files?: number|null, cwd: string, write?: Function, now?: Date, commonDirOf?: Function}} run
 * @returns {{written: boolean, kind: string|null, note: string|null}}
 */
export function recordSuiteRun({ preflight, tierSkip, userArgs, exitCode, wallMs, files = null, cwd, write = writeSuiteRunRecord, now = new Date(), commonDirOf = gitCommonDir }) {
  try {
    const kind = suiteRunKind({ preflight, tierSkip, userArgs });
    if (kind === null || exitCode !== 0) return { written: false, kind, note: null };
    // An invalid duration is NOT clamped to a plausible zero: a zero would read as a measurement. The runner times with a
    // monotonic clock, so this is a contract breach worth a note, not a value to repair.
    if (!Number.isFinite(wallMs) || wallMs < 0) return { written: false, kind, note: `suite-run record: not written (invalid duration ${String(wallMs)})` };
    const commonDir = commonDirOf(cwd);
    if (!commonDir) return { written: false, kind, note: 'suite-run record: not written (no git common dir resolved)' };
    write(commonDir, {
      schema: SUITE_RUN_SCHEMA,
      kind,
      wallMs: Math.round(wallMs),
      files,
      finishedAt: now.toISOString(),
      head: gitHead(cwd),
      cores: coreCount(),
      platform: process.platform,
    });
    return { written: true, kind, note: null };
  } catch (err) {
    let why;
    try { why = err?.code ?? err?.message ?? 'error'; } catch { why = 'error'; }
    return { written: false, kind: null, note: `suite-run record: not written (${why})` };
  }
}

/**
 * Read one record as a measured input. A missing, unreadable, invalid or stale record is `measured:false` with the
 * reason: never a throw and never a zero.
 *
 * @returns {{measured: true, value: object, source: string}|{measured: false, why: string}}
 */
export function readSuiteRunRecord(commonDir, kind, now = new Date()) {
  if (!commonDir) return { measured: false, why: `no suite-run ${kind} record (no git common dir)` };
  const file = suiteRunPath(commonDir, kind);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (err) {
    return err?.code === 'ENOENT'
      ? { measured: false, why: `no suite-run ${kind} record (run the suite once with scripts/run-tests.mjs)` }
      : { measured: false, why: `suite-run ${kind} record unreadable (${err?.code ?? 'error'})` };
  }
  let parsed;
  try { parsed = RecordSchema.safeParse(JSON.parse(text)); } catch {
    return { measured: false, why: `suite-run ${kind} record unreadable (not JSON)` };
  }
  if (!parsed.success || parsed.data.kind !== kind) {
    return { measured: false, why: `suite-run ${kind} record invalid (${parsed.success ? 'kind mismatch' : parsed.error.issues[0]?.message ?? 'schema'})` };
  }
  const r = parsed.data;
  const ageMs = now.getTime() - Date.parse(r.finishedAt);
  if (ageMs < -SUITE_RUN_CLOCK_SKEW_MS) {
    return { measured: false, why: `suite-run ${kind} record is dated in the future (${r.finishedAt}; clock skew over ${SUITE_RUN_CLOCK_SKEW_MS / 60_000} min)` };
  }
  if (ageMs > SUITE_RUN_MAX_AGE_DAYS * DAY_MS) {
    return { measured: false, why: `suite-run ${kind} record older than ${SUITE_RUN_MAX_AGE_DAYS} d (${Math.floor(ageMs / DAY_MS)} d old)` };
  }
  return {
    measured: true,
    source: `suite-run ${kind} record (${r.finishedAt})`,
    value: {
      ms: r.wallMs,
      workloadKind: kind === 'full' ? 'full-suite' : 'branch-tier',
      timingBasis: 'test-step',
      origin: 'this-repo-local',
      finishedAt: r.finishedAt,
      ageMs,
      cores: r.cores,
      platform: r.platform,
      head: r.head,
      files: r.files,
    },
  };
}
