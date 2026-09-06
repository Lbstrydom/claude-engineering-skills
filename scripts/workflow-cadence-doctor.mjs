#!/usr/bin/env node
/**
 * @fileoverview `cadence:doctor` — did the scheduled workflows this repo relies
 * on actually run, and did they actually pass?
 *
 * Promoted from a consumer repo's `check-drift-cadence.mjs`, which asked the
 * question for one hardcoded workflow (`architectural-drift.yml`) with
 * architectural-drift-specific prose. The logic was right; the scope was one
 * repo's. This is the same instrument with the workflow, the triggering event
 * and the staleness budget lifted out into a per-repo watch list, so every
 * consumer inherits it.
 *
 * # Why this exists
 *
 * A cron that does not fire produces no run, no failure and no notification --
 * it produces nothing, which looks exactly like a quiet week. Worse, a run
 * queued for a self-hosted runner that never comes online is CANCELLED after 24
 * hours, and a cancelled run is easy to scroll past.
 *
 * So a cadence cannot be trusted by having been CONFIGURED; it has to be
 * OBSERVED. This asks GitHub when each watched workflow last completed
 * successfully, and is meant to run somewhere frequently read -- a push-
 * triggered workflow, or the local weekly-maintenance replica.
 *
 * # Why the event filter is the whole point of the promotion
 *
 * The original queried `?per_page=20&status=completed` with no event filter,
 * which conflates every trigger a workflow has. Measured 2026-09-06 against the
 * consumer repo whose nightly had been red for four consecutive days:
 *
 *   ALL events      | runs:20 successes:11 | OK        | last successful ... 0.1 days ago
 *   event=schedule  | runs:4  successes:0  | NEVER-RAN | ...
 *
 * Eleven successful push runs drowned four failed scheduled ones, and the
 * watcher reported healthy for the entire outage. The nightly it was watching
 * existed *because* the two costliest defects on that pipeline were host-level
 * and silent; the early-warning signal was itself silently broken and nothing
 * said so, because a red scheduled run looks identical whether the host is sick
 * or the workflow never asked it anything. A watcher that cannot distinguish
 * "the scheduled run is failing" from "pushes are fine" cannot see that class of
 * defect at all. Hence `event` on every watch entry.
 *
 * # Why it asks GitHub rather than the thing the workflow was supposed to do
 *
 * The honest check for any given workflow is its own output (a snapshot's age, a
 * smoke test's last green). That is per-workflow, needs that workflow's
 * credentials, and does not generalise -- which is exactly why the original was
 * repo-local. The workflow-run timestamp is the available proxy and it answers
 * the question actually being asked: did the thing run, and did it pass. It does
 * NOT prove the workflow's *effect* is fresh.
 *
 * # Advisory, deliberately -- preserved from the original
 *
 * The default exit is 0 on every verdict. A cron that missed its slot is a
 * reason to tell someone, not a reason to block an unrelated push: a gate that
 * red-lights every push because a cron slipped on a workstation is the
 * cried-wolf shape that earns `--no-verify`, and the bundle has spent real
 * effort avoiding it.
 *
 * `--strict` exists solely because `maintenance-checks.mjs`'s `runCheck` keys a
 * check's status on the SPAWNED PROCESS'S EXIT CODE. Registering an
 * always-exit-0 doctor there would report `ok` forever -- a watcher
 * manufacturing false calm inside the registry, which is the defect this file
 * exists to detect, one level up. `--strict` is opt-in, is never used by a
 * push-time caller, and does not change any verdict.
 *
 * # Silence means one thing only -- preserved from the original
 *
 * Every non-OK outcome warns, INCLUDING this tool's own API call failing
 * (`undetermined`) and its own watch list being absent while the repo has crons
 * (`unconfigured`). A checker that goes quiet when it cannot tell reproduces the
 * defect it exists to detect. Silence here means "every watched workflow had a
 * recent successful run", and nothing else.
 *
 * # The vacuity guard
 *
 * `never-ran` has two causes that read identically: the workflow genuinely never
 * succeeded, and the query matched nothing at all (wrong filename, an `event`
 * that workflow never fires on, a workflow not yet on the default branch). The
 * second is a broken instrument wearing a real finding's clothes. Every verdict
 * therefore carries `runsExamined` and a `vacuous` flag, and the message says
 * which case it is -- so neither a reader nor a test can mistake one for the
 * other.
 *
 * Usage:
 *   node scripts/workflow-cadence-doctor.mjs
 *   node scripts/workflow-cadence-doctor.mjs --repo owner/name
 *   node scripts/workflow-cadence-doctor.mjs --config .workflow-cadence.json
 *   node scripts/workflow-cadence-doctor.mjs --workflow ci.yml --event schedule --max-age-days 2
 *   node scripts/workflow-cadence-doctor.mjs --json
 *   node scripts/workflow-cadence-doctor.mjs --strict     # exit 1 when the rollup is not ok
 *
 * Watch list (`.workflow-cadence.json` at the repo root, committed):
 *   {
 *     "watch": [
 *       { "workflow": "phase-gates.yml", "event": "schedule", "maxAgeDays": 2 },
 *       { "workflow": "live-smoke.yml",  "event": "schedule", "maxAgeDays": 2 }
 *     ]
 *   }
 *
 * Exit codes:
 *   0  reported (advisory default -- verdicts are payload, not failure)
 *   1  --strict was passed and the rollup is not `ok`
 *   2  usage error (unknown flag, unresolvable repo, malformed watch list)
 *
 * @module scripts/workflow-cadence-doctor
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  assertKnownFlags, ArgvError, emit, argOption, hasFlag, finishAndExit,
} from './lib/cli-io.mjs';
import { parseOriginRepo } from './lib/branch-protection.mjs';
import { findRepoRootFromScript } from './lib/assert-repo-root.mjs';

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

const KNOWN_FLAGS = [
  '--repo', '--config', '--workflow', '--event', '--max-age-days',
  '--json', '--strict', '--selfcheck-relocation',
];

/** Default staleness budget. A weekly cron gets ~1.5 cycles before complaining;
 *  a nightly should set `maxAgeDays` explicitly (2 is the usual choice). */
export const DEFAULT_MAX_AGE_DAYS = 10;

/** Where a repo declares what it wants watched. Committed, not generated. */
export const WATCH_CONFIG_BASENAME = '.workflow-cadence.json';

/** @typedef {'ok'|'stale'|'never-ran'|'undetermined'} CadenceStatus */
/** @typedef {'ok'|'stale'|'never-ran'|'undetermined'|'unconfigured'|'nothing-to-watch'} RollupStatus */

/**
 * Worst-first. `rollupStatus` picks the max, and `render` warns on anything but
 * the two tail entries. `undetermined` outranks a real finding deliberately: not
 * knowing is worse than a known-bad, because a known-bad is at least measured.
 */
const SEVERITY = ['undetermined', 'never-ran', 'stale', 'unconfigured', 'ok', 'nothing-to-watch'];

/** Human name for one watch entry, used in every message it produces. */
export function watchLabel(watch) {
  if (watch.label) return watch.label;
  return watch.event ? `${watch.workflow}@${watch.event}` : `${watch.workflow} (any event)`;
}

/**
 * Decide the cadence verdict for ONE watch from the runs GitHub reported.
 *
 * Pure, so the interesting cases are testable without a network: the API call is
 * the caller's job.
 *
 * @param {{
 *   runs: Array<{conclusion: string, updated_at: string}>|null,
 *   now: Date,
 *   maxAgeDays?: number,
 *   error?: string|null,
 *   notFound?: boolean,
 *   label?: string,
 * }} input
 * @returns {{status: CadenceStatus, ageDays: number|null, runsExamined: number,
 *            vacuous: boolean, message: string}}
 */
export function assessCadence({
  runs, now, maxAgeDays = DEFAULT_MAX_AGE_DAYS, error = null, notFound = false,
  label = 'the watched workflow',
}) {
  if (error || runs === null) {
    return {
      status: 'undetermined',
      ageDays: null,
      runsExamined: 0,
      vacuous: false,
      message: `could not determine when ${label} last ran (${error || 'no data'}). `
        + 'This is NOT a pass -- the cadence is unverified until this resolves.',
    };
  }

  const runsExamined = runs.length;

  // A 404 is the never-ran case with a KNOWN cause. Reporting it as a bare
  // zero-run result would put it in the vacuous bucket below, where the reader
  // is told to go and check the name they in fact got right.
  if (notFound) {
    return {
      status: 'never-ran',
      ageDays: null,
      runsExamined: 0,
      vacuous: false,
      message: `${label} is not registered on the default branch (GitHub returned 404 for the `
        + 'workflow). It has never run because it does not exist there yet -- merge it, then '
        + 'dispatch it once to establish the baseline.',
    };
  }

  const successes = runs
    .filter((r) => r && r.conclusion === 'success' && r.updated_at)
    .map((r) => new Date(r.updated_at))
    .filter((d) => Number.isFinite(d.getTime()))
    .sort((a, b) => b - a);

  if (successes.length === 0) {
    // THE VACUITY GUARD. Zero examined runs and zero successful runs are the
    // same verdict from opposite causes: one is a finding, the other is a query
    // that matched nothing. Merging them is how a broken watcher reads as a
    // working one, so they get different prose and a machine-readable flag.
    if (runsExamined === 0) {
      return {
        status: 'never-ran',
        ageDays: null,
        runsExamined: 0,
        vacuous: true,
        message: `GitHub returned NO completed runs at all for ${label}, so nothing was actually `
          + 'examined. That is either a workflow which has genuinely never run, or a query that '
          + 'matches nothing -- check the workflow filename and the `event` in the watch entry '
          + 'before treating this as a finding.',
      };
    }
    return {
      status: 'never-ran',
      ageDays: null,
      runsExamined,
      vacuous: false,
      message: `${label} has NEVER completed successfully: ${runsExamined} completed run(s) were `
        + 'examined and not one succeeded. Whatever this workflow is the early-warning signal '
        + 'for, it is not warning about anything.',
    };
  }

  const ageDays = (now.getTime() - successes[0].getTime()) / 86_400_000;
  if (ageDays > maxAgeDays) {
    return {
      status: 'stale',
      ageDays,
      runsExamined,
      vacuous: false,
      message: `the last successful run of ${label} was ${ageDays.toFixed(1)} days ago, over the `
        + `${maxAgeDays}-day budget. The schedule may not be firing -- check whether the runner `
        + 'was offline (a run queued for an absent self-hosted runner is cancelled after 24h).',
    };
  }

  return {
    status: 'ok',
    ageDays,
    runsExamined,
    vacuous: false,
    message: `last successful run of ${label} ${ageDays.toFixed(1)} days ago`,
  };
}

/**
 * Fetch recent runs of a workflow, optionally narrowed to one triggering event.
 *
 * Returns `{runs: null, error}` rather than throwing, so a network or auth
 * failure becomes an `undetermined` warning instead of an exception a
 * `continue-on-error` step would swallow silently.
 *
 * `event` is the promotion's whole point (see the module header) and is passed
 * through verbatim: GitHub's own `event=` filter names the trigger, and letting
 * a caller narrow to `schedule` is what makes a failing nightly visible behind
 * a wall of green pushes.
 *
 * @param {{repo: string, workflow: string, event?: string|null, token: string,
 *          perPage?: number, fetchImpl?: typeof fetch}} opts
 * @returns {Promise<{runs: Array<object>|null, error: string|null, notFound: boolean}>}
 */
export async function fetchWorkflowRuns({
  repo, workflow, event = null, token, perPage = 30, fetchImpl = fetch,
}) {
  const params = new URLSearchParams({ per_page: String(perPage), status: 'completed' });
  if (event) params.set('event', event);
  const url = `https://api.github.com/repos/${repo}/actions/workflows/`
    + `${encodeURIComponent(workflow)}/runs?${params}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (res.status === 404) return { runs: [], error: null, notFound: true };
    if (!res.ok) return { runs: null, error: `GitHub API returned ${res.status}`, notFound: false };
    const body = await res.json();
    return {
      runs: Array.isArray(body.workflow_runs) ? body.workflow_runs : [],
      error: null,
      notFound: false,
    };
  } catch (err) {
    return { runs: null, error: err instanceof Error ? err.message : String(err), notFound: false };
  }
}

/**
 * Normalise one raw watch entry, or throw if it cannot be trusted.
 *
 * Malformed input ABORTS rather than being skipped, for the reason
 * `.sync-overrides.json` states: a config the tool silently drops half of is a
 * config whose author believes it is in force. Here that would mean a watch the
 * operator wrote and nobody ever evaluated -- silence, from the one file that
 * exists to prevent silence.
 *
 * @param {unknown} raw
 * @param {number} index
 */
function normaliseWatch(raw, index) {
  const where = `${WATCH_CONFIG_BASENAME} watch[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgvError(`${where} must be an object, got ${JSON.stringify(raw)}.`);
  }
  const { workflow, event = null, maxAgeDays = DEFAULT_MAX_AGE_DAYS, label = null } = raw;
  if (typeof workflow !== 'string' || workflow.trim() === '') {
    throw new ArgvError(`${where}.workflow is required and must be a non-empty filename `
      + '(e.g. "phase-gates.yml").');
  }
  if (event !== null && (typeof event !== 'string' || event.trim() === '')) {
    throw new ArgvError(`${where}.event must be a GitHub trigger name (e.g. "schedule") or be omitted.`);
  }
  if (typeof maxAgeDays !== 'number' || !Number.isFinite(maxAgeDays) || maxAgeDays <= 0) {
    throw new ArgvError(`${where}.maxAgeDays must be a positive number of days, got ${JSON.stringify(maxAgeDays)}.`);
  }
  if (label !== null && typeof label !== 'string') {
    throw new ArgvError(`${where}.label must be a string or be omitted.`);
  }
  return { workflow: workflow.trim(), event: event && event.trim(), maxAgeDays, label };
}

/**
 * Read + validate the repo's watch list.
 *
 * @param {string} configPath
 * @returns {{watches: Array<object>|null, present: boolean}}
 * @throws {ArgvError} on a present-but-unreadable or present-but-invalid file
 */
export function loadWatchList(configPath) {
  if (!fs.existsSync(configPath)) return { watches: null, present: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    throw new ArgvError(`${configPath} is present but is not valid JSON (${err.message}). `
      + 'Refusing to run: a watch list that silently fails to load is indistinguishable from '
      + 'having no crons to watch, which is exactly the silence this tool exists to prevent.');
  }
  const raw = parsed && parsed.watch;
  if (!Array.isArray(raw)) {
    throw new ArgvError(`${configPath} must contain a "watch" array. See the module header for the shape.`);
  }
  return { watches: raw.map(normaliseWatch), present: true };
}

/**
 * Which workflow files in this repo declare a schedule trigger?
 *
 * Used for ONE binary question -- "would silence be honest here?" -- and never
 * to build the watch list itself. That is why a text scan is adequate rather
 * than a YAML parse: GitHub's schema requires a literal `cron:` key under
 * `on.schedule`, so a file carrying both `schedule:` and `cron:` is
 * overwhelmingly a scheduled workflow. The imprecision is one-directional in
 * the safe sense: a false positive suggests a watch entry a human then reads,
 * while a false negative would need a scheduled workflow with no `cron:` in it,
 * which GitHub will not accept. (A YAML parse would also add a `yaml` import to
 * a script that ships into consumers whose package.json we do not control.)
 *
 * @param {string} repoRoot
 * @returns {string[]} workflow filenames, sorted
 */
export function discoverScheduledWorkflows(repoRoot) {
  const dir = path.join(repoRoot, '.github', 'workflows');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return []; // no .github/workflows at all -- genuinely nothing to watch
  }
  return entries
    .filter((f) => /\.ya?ml$/i.test(f))
    .filter((f) => {
      let text;
      try { text = fs.readFileSync(path.join(dir, f), 'utf-8'); } catch { return false; }
      return /^\s*schedule:/m.test(text) && /^\s*-?\s*cron:/m.test(text);
    })
    .sort();
}

/** Worst status across the per-watch verdicts. */
export function rollupStatus(statuses) {
  if (statuses.length === 0) return 'nothing-to-watch';
  let worst = SEVERITY.length - 1;
  for (const s of statuses) {
    const i = SEVERITY.indexOf(s);
    if (i !== -1 && i < worst) worst = i;
  }
  return SEVERITY[worst];
}

/** Does this rollup deserve someone's attention? */
export function isWarning(status) {
  return status !== 'ok' && status !== 'nothing-to-watch';
}

/**
 * The `unconfigured` verdict: this repo has cron-triggered workflows and no
 * watch list, so nothing was checked. It warns rather than passing quietly for
 * the reason the whole module exists -- and it carries the JSON to paste, so
 * the remedy rides along with the complaint instead of living in a doc the
 * reader has to go and find.
 *
 * @param {string[]} scheduled
 */
export function unconfiguredVerdict(scheduled) {
  const suggestion = JSON.stringify(
    { watch: scheduled.map((workflow) => ({ workflow, event: 'schedule', maxAgeDays: 2 })) },
    null, 2,
  );
  return {
    status: 'unconfigured',
    ageDays: null,
    runsExamined: 0,
    vacuous: false,
    message: `this repo has ${scheduled.length} cron-triggered workflow(s) (${scheduled.join(', ')}) `
      + `and no ${WATCH_CONFIG_BASENAME}, so NOTHING was checked. A scheduled workflow that stops `
      + `firing -- or starts failing -- produces no notification. Create ${WATCH_CONFIG_BASENAME} `
      + `with:\n${suggestion}`,
  };
}

/**
 * Render for a human or for the Actions log.
 *
 * The `::warning::` annotation form is emitted only under `GITHUB_ACTIONS`,
 * where it surfaces in the run summary; elsewhere it is line noise that buries
 * the message it is supposed to highlight.
 *
 * @param {{status: RollupStatus, watches: Array<{label: string, verdict: object}>}} report
 * @param {{actions?: boolean}} [opts]
 */
export function render(report, { actions = false } = {}) {
  const lines = [];
  if (report.watches.length === 0 && report.status === 'nothing-to-watch') {
    return 'workflow-cadence-doctor: no cron-triggered workflows in this repo -- nothing to watch.\n';
  }
  for (const { label, verdict } of report.watches) {
    if (verdict.status === 'ok') {
      lines.push(`workflow-cadence-doctor: ${verdict.message}`);
    } else if (actions) {
      lines.push(`::warning title=Workflow cadence (${label})::${verdict.message}`);
    } else {
      lines.push(`WARNING [${label}] ${verdict.message}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Resolve `owner/name`: explicit flag, then Actions env, then the git remote. */
export function resolveRepoSlug({ explicit = null, env = process.env, cwd = process.cwd() } = {}) {
  if (explicit) return explicit;
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseOriginRepo(url)?.slug ?? null;
  } catch {
    return null;
  }
}

/**
 * Evaluate every watch. Extracted from `main` so a test can drive the whole
 * multi-watch path with an injected fetch and a frozen clock.
 *
 * @param {{watches: Array<object>, repo: string, token: string, now: Date,
 *          fetchImpl?: typeof fetch}} input
 */
export async function assessWatchList({ watches, repo, token, now, fetchImpl = fetch }) {
  const results = [];
  for (const watch of watches) {
    const label = watchLabel(watch);
    const { runs, error, notFound } = await fetchWorkflowRuns({
      repo, workflow: watch.workflow, event: watch.event, token, fetchImpl,
    });
    results.push({
      label,
      workflow: watch.workflow,
      event: watch.event ?? null,
      maxAgeDays: watch.maxAgeDays,
      verdict: assessCadence({ runs, now, maxAgeDays: watch.maxAgeDays, error, notFound, label }),
    });
  }
  return { status: rollupStatus(results.map((r) => r.verdict.status)), watches: results };
}

export async function main(argv = process.argv, env = process.env, out = process.stdout) {
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'workflow-cadence-doctor' });

  const repoRoot = findRepoRootFromScript(import.meta.url);
  const json = hasFlag('json');
  const strict = hasFlag('strict');
  const actions = Boolean(env.GITHUB_ACTIONS);

  // An inline `--workflow` is a one-off probe and REPLACES the file, rather than
  // being merged into it: a caller asking about one workflow wants an answer
  // about that workflow, not a report in which it is buried.
  const inlineWorkflow = argOption('workflow');
  let watches = null;
  let source = 'none';
  if (inlineWorkflow) {
    watches = [normaliseWatch({
      workflow: inlineWorkflow,
      event: argOption('event'),
      maxAgeDays: argOption('max-age-days')
        ? Number(argOption('max-age-days'))
        : DEFAULT_MAX_AGE_DAYS,
    }, 0)];
    source = 'argv';
  } else {
    const configPath = argOption('config')
      ? path.resolve(argOption('config'))
      : path.join(repoRoot, WATCH_CONFIG_BASENAME);
    const loaded = loadWatchList(configPath);
    if (loaded.present) { watches = loaded.watches; source = configPath; }
  }

  // No watch list. Silence is honest ONLY if there is nothing to be silent
  // about; a repo with crons and no watch list gets told so.
  if (watches === null) {
    const scheduled = discoverScheduledWorkflows(repoRoot);
    const report = scheduled.length === 0
      ? { status: 'nothing-to-watch', watches: [], source }
      : {
        status: 'unconfigured',
        watches: [{ label: WATCH_CONFIG_BASENAME, workflow: null, event: null, maxAgeDays: null, verdict: unconfiguredVerdict(scheduled) }],
        source,
        scheduledWorkflows: scheduled,
      };
    if (json) emit({ ok: true, ...report });
    else out.write(render(report, { actions }));
    return strict && isWarning(report.status) ? 1 : 0;
  }

  const repo = resolveRepoSlug({ explicit: argOption('repo'), env, cwd: repoRoot });
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;

  // A missing repo or token is UNDETERMINED, never a pass: the tool could not
  // look, and saying nothing would be the failure mode it exists to catch.
  if (!repo || !token) {
    const error = !repo
      ? 'could not resolve owner/name (pass --repo, or set GITHUB_REPOSITORY)'
      : 'no GITHUB_TOKEN or GH_TOKEN available';
    const report = {
      status: 'undetermined',
      source,
      watches: watches.map((w) => ({
        label: watchLabel(w),
        workflow: w.workflow,
        event: w.event ?? null,
        maxAgeDays: w.maxAgeDays,
        verdict: assessCadence({ runs: null, now: new Date(), maxAgeDays: w.maxAgeDays, error, label: watchLabel(w) }),
      })),
    };
    if (json) emit({ ok: true, ...report });
    else out.write(render(report, { actions }));
    return strict ? 1 : 0;
  }

  const report = await assessWatchList({ watches, repo, token, now: new Date() });
  const payload = { ...report, source, repo };
  // `ok` reports whether the DOCTOR ran, not whether the repo is healthy --
  // `emit` couples `ok:false` to a non-zero exit, and this tool is advisory by
  // default. The verdict lives in `status`.
  if (json) emit({ ok: true, ...payload });
  else out.write(render(payload, { actions }));
  return strict && isWarning(report.status) ? 1 : 0;
}

// Compare the RESOLVED file, never a path suffix. The source instrument matched
// `endsWith('scripts/check-drift-cadence.mjs')`, which is true in this repo and
// FALSE at the consumer path `scripts/.claude-skills/workflow-cadence-doctor.mjs`
// -- so the promoted copy ran nothing, printed nothing and exited 0 in every
// consumer: a watcher shipped as a silent no-op, which is the exact defect it
// exists to detect. `--selfcheck-relocation` cannot catch this (its handler sits
// above this line and returns before it), so the guard against it is
// `runs under a scripts/.claude-skills/ layout` in this module's test file.
const isDirectRun = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  try {
    await finishAndExit(await main());
  } catch (e) {
    if (e instanceof ArgvError || e?.code === 'ARGV_ERROR') {
      process.stderr.write(`error: ${e.message}\n`);
      await finishAndExit(2);
    } else {
      throw e;
    }
  }
}
