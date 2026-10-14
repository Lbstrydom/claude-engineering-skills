/**
 * @fileoverview The MEASURED inputs of doctor's operating-fit probes (docs/plans/adoption-fit-check.md section 2.2).
 *
 * Every input is a `Measured`: `{measured: true, value, source}` or `{measured: false, why, code?}`. There is no third
 * shape and no default: a reader that cannot answer says so and why, because an unasked question must never render as
 * an empty result (AGENTS.md). Inputs are LAZY getters, memoised per input, so a probe that needs no remote fact makes
 * no remote call, and every `gh` call goes through one budgeted `remote()`.
 *
 * Durations carry their identity (`workloadKind`, `timingBasis`, `origin`), so a CI workflow wall can never be read as
 * the local full suite, and a self-hosted CI wall is never attributed to this machine.
 *
 * All I/O is injectable (`deps`) so the layer is tested without a network, a home directory or a clock.
 *
 * This is shared-lib and imports NOTHING from fleet (shared-lib -> fleet is not a declared edge). The two inputs only
 * fleet's stores can answer arrive through `ctx.fleetEvidence`, handed in by `scripts/doctor.mjs` (see
 * `scripts/lib/fleet/operating-evidence.mjs`); without that provider they read unmeasured.
 *
 * @module scripts/lib/doctor/operating-inputs
 */
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import yaml from 'yaml';
import { readSuiteRunRecord, gitCommonDir, coreCount } from '../suite-run-record.mjs';

const DAY_MS = 86_400_000;

/** Evidence older than this is not evidence about the repo as it is now. */
export const FRESH_DAYS = 30;
export const REMOTE_PER_CALL_MS = 10_000;
export const REMOTE_TOTAL_MS = 20_000;
export const MAX_TEST_WORKFLOWS = 3;
export const MAX_RUNS_PER_WORKFLOW = 10;

/**
 * What the test tier looks for in a head's `scripts/run-tests.mjs`. Pinned to `TIER_PROTOCOL_MARKER`
 * (`scripts/lib/test-tier.mjs`) by a drift test rather than imported: that module is source-repo tooling, and this one
 * ships to consumers.
 */
export const TIER_MARKER = 'export const TIER_PROTOCOL';

// ── Runner classification (R2 M6, R3 M1) ────────────────────────────────────

/**
 * GitHub's documented STANDARD hosted runner labels (docs.github.com, "GitHub-hosted runners", read 2026-10-14). A
 * label outside this set is never assumed standard by prefix: `macos-14-large` is billed even on a public repository.
 * Add a label here only after reading it in that table.
 */
export const STANDARD_HOSTED_LABELS = Object.freeze(new Set([
  'ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04', 'ubuntu-24.04-arm', 'ubuntu-22.04-arm',
  'windows-latest', 'windows-2025', 'windows-2022', 'windows-11-arm',
  'macos-latest', 'macos-15', 'macos-14', 'macos-13',
]));
/** Documented concrete LARGER-runner labels (billed on public repositories too). */
export const LARGER_HOSTED_LABEL = /^(?:macos-(?:latest|13|14|15)-(?:large|xlarge)|(?:ubuntu|windows)-latest-\d+-cores?)$/;

/**
 * One label list out of any `runs-on` spelling, then one class.
 *   self-hosted    any normalised label is `self-hosted` (decisive even beside an expression or a group)
 *   standard-hosted exactly one label, in {@link STANDARD_HOSTED_LABELS}
 *   larger-hosted  exactly one label matching {@link LARGER_HOSTED_LABEL}
 *   unresolved     everything else: an expression, a group with no decisive label, a custom label, a multi-label set
 *
 * @param {unknown} runsOn scalar, array, or `{group, labels}` mapping
 * @returns {'self-hosted'|'standard-hosted'|'larger-hosted'|'unresolved'}
 */
export function classifyRunsOn(runsOn) {
  const labels = [];
  const take = (v) => {
    if (typeof v === 'string') labels.push(v.trim());
    else if (Array.isArray(v)) v.forEach(take);
  };
  const isMapping = Boolean(runsOn) && typeof runsOn === 'object' && !Array.isArray(runsOn);
  if (isMapping) take(runsOn.labels);
  else take(runsOn);
  const lower = labels.map((l) => l.toLowerCase());
  if (lower.includes('self-hosted')) return 'self-hosted';
  // A runner group changes what a familiar label means (a group can hold self-hosted runners of that label): without a
  // decisive label the class is unknown, never inferred from the label alone (audit R4 M2).
  if (isMapping && runsOn.group !== undefined && runsOn.group !== null) return 'unresolved';
  if (lower.length !== 1 || lower[0].includes('${{')) return 'unresolved';
  if (STANDARD_HOSTED_LABELS.has(lower[0])) return 'standard-hosted';
  if (LARGER_HOSTED_LABEL.test(lower[0])) return 'larger-hosted';
  return 'unresolved';
}

/**
 * Discovery evidence only (plan section 2.4): decides which workflows' walls get REPORTED and whether "the suite runs
 * in CI". It never produces a local or full-suite measurement.
 */
const TEST_COMMAND = new RegExp(
  '^(?:(?:sudo|time|env|nice)\\s+|timeout\\s+\\S+\\s+|[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*'
  + '(?:(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test\\b|node\\s+--test\\b'
  + '|(?:(?:npx|pnpm\\s+exec|pnpm\\s+dlx|yarn|bunx)\\s+)?(?:vitest|jest)\\b|(?:npx\\s+)?playwright\\s+test\\b)',
);
/**
 * Split a shell `run:` block into its commands: on newlines, `&&`, `||`, `;` and `|` that are OUTSIDE quotes, with an
 * unquoted `#` (at the start of a word) discarding the rest of its line. So `echo "note; npm test"` is ONE command
 * and `# docs; npm test` is none (audit R4 round 2, M2). Not a shell parser: no heredocs, `$(...)` or line
 * continuations; a command hidden in those is a miss, and the miss direction is stated in the ci-location detail.
 */
export function splitCommands(text) {
  const out = [];
  let cur = '';
  let quote = null;
  const flush = () => { if (cur.trim() !== '') out.push(cur.trim()); cur = ''; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') { cur += c + (text[i + 1] ?? ''); i += 1; continue; }
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '#' && (cur === '' || /\s$/.test(cur))) { while (i < text.length && text[i] !== '\n') i += 1; flush(); continue; }
    if (c === '\n' || c === ';') { flush(); continue; }
    if ((c === '&' || c === '|') && text[i + 1] === c) { flush(); i += 1; continue; }
    if (c === '|') { flush(); continue; }
    cur += c;
  }
  flush();
  return out;
}

/**
 * Command-aware, not a substring search (audit R4 M3): a command counts only when it STARTS with a known test runner
 * (after env assignments and wrappers like `timeout 10m`), in the commands `splitCommands` finds. `echo "npm test"`
 * and a `# npm test` comment therefore do not count. The cost is a miss on a wrapper this list does not know.
 */
export function runsTests(runText) {
  if (typeof runText !== 'string') return false;
  return splitCommands(runText).some((cmd) => TEST_COMMAND.test(cmd));
}

/**
 * @param {string} text a workflow file
 * @param {string} file its basename
 * @returns {Array<{file: string, id: string, runner: string, runsTests: boolean, opaque: boolean}>}
 * @throws on YAML that does not parse or has no `jobs` mapping (the caller records the file as failed)
 */
export function parseWorkflowJobs(text, file) {
  const doc = yaml.parse(text);
  const jobs = doc && typeof doc === 'object' ? doc.jobs : null;
  if (!jobs || typeof jobs !== 'object' || Array.isArray(jobs)) throw new Error('no jobs mapping');
  return Object.entries(jobs).map(([id, job]) => {
    const j = job && typeof job === 'object' ? job : {};
    // A reusable-workflow call (`uses:`) has no runs-on of its own: unresolved, never guessed.
    const reusable = typeof j.uses === 'string';
    const runner = reusable ? 'unresolved' : classifyRunsOn(j['runs-on']);
    const steps = Array.isArray(j.steps) ? j.steps : [];
    // `opaque`: the job's steps live in another workflow we did not read, so whether it runs tests is UNKNOWN, not false
    // (audit R4 H2/M1/M4).
    return { file, id, runner, runsTests: reusable ? false : steps.some((s) => s && runsTests(s.run)), opaque: reusable };
  });
}

/** The census with its COVERAGE: a conclusion over it is only as strong as `complete` (R1 H3). */
export function censusOf(parsed, failed) {
  const zero = () => ({ standardHosted: 0, largerHosted: 0, selfHosted: 0, unresolved: 0 });
  const jobs = zero(); const testJobs = zero();
  const key = { 'standard-hosted': 'standardHosted', 'larger-hosted': 'largerHosted', 'self-hosted': 'selfHosted', unresolved: 'unresolved' };
  const testWorkflows = new Map();
  let opaqueJobs = 0;
  for (const j of parsed.flat()) {
    jobs[key[j.runner]] += 1;
    if (j.opaque) opaqueJobs += 1;
    if (j.runsTests) {
      testJobs[key[j.runner]] += 1;
      const w = testWorkflows.get(j.file) ?? { file: j.file, testJobs: 0, runners: new Set() };
      w.testJobs += 1; w.runners.add(j.runner);
      testWorkflows.set(j.file, w);
    }
  }
  const testTotal = testJobs.standardHosted + testJobs.largerHosted + testJobs.selfHosted + testJobs.unresolved;
  return {
    files: { inspected: parsed.length, failed },
    jobs, testJobs, testTotal, opaqueJobs,
    testWorkflows: [...testWorkflows.values()].map((w) => ({ ...w, runners: [...w.runners] })).sort((a, b) => b.testJobs - a.testJobs || a.file.localeCompare(b.file)),
    // Complete only when nothing could hide a test job: every file read, no unresolved runner on a test job, and no
    // reusable-workflow call whose steps were never inspected.
    complete: failed.length === 0 && testJobs.unresolved === 0 && opaqueJobs === 0,
  };
}

// ── Pure helpers ────────────────────────────────────────────────────────────

/** Median `updatedAt - startedAt` of runs started within {@link FRESH_DAYS}; null when none qualify. */
export function medianRunMs(runs, now) {
  const durations = [];
  for (const r of runs) {
    const a = Date.parse(r?.startedAt); const b = Date.parse(r?.updatedAt);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    if (now.getTime() - a > FRESH_DAYS * DAY_MS) continue;
    durations.push(b - a);
  }
  if (durations.length === 0) return null;
  durations.sort((x, y) => x - y);
  const mid = durations.length >> 1;
  return { ms: durations.length % 2 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2), runs: durations.length };
}

/**
 * Is the test tier really there? Both halves or neither (R1 M3): a parseable heavy list AND the runner that honours it.
 * Absent is a MEASURED state; present-but-unverifiable is not.
 */
export function tierCapability(root, fsImpl = fs) {
  const listFile = path.join(root, '.test-tiers.json');
  let text;
  try { text = fsImpl.readFileSync(listFile, 'utf8'); } catch (err) {
    if (err?.code === 'ENOENT') return { measured: true, value: { state: 'absent' }, source: 'no .test-tiers.json (the test tier is source-repo tooling, not synced)' };
    return { measured: false, why: `.test-tiers.json present but unreadable (${err?.code ?? 'error'})` };
  }
  let list;
  try { list = JSON.parse(text); } catch { return { measured: false, why: '.test-tiers.json present but not JSON' }; }
  if (list?.version !== 1 || !Array.isArray(list.heavy) || list.heavy.length === 0
    || !list.heavy.every((e) => e && typeof e === 'object' && typeof e.file === 'string' && e.file !== '')) {
    return { measured: false, why: '.test-tiers.json present but not a version-1 heavy list of file entries' };
  }
  let runner;
  try { runner = fsImpl.readFileSync(path.join(root, 'scripts', 'run-tests.mjs'), 'utf8'); } catch {
    return { measured: false, why: '.test-tiers.json present but scripts/run-tests.mjs is not readable, so the tiered path cannot be verified' };
  }
  if (!runner.includes(TIER_MARKER)) return { measured: false, why: `.test-tiers.json present but scripts/run-tests.mjs lacks the tier protocol (${TIER_MARKER})` };
  return { measured: true, value: { state: 'present', heavyFiles: list.heavy.length }, source: '.test-tiers.json + scripts/run-tests.mjs tier protocol' };
}

// ── The budgeted remote ─────────────────────────────────────────────────────

/**
 * Every `gh` call goes through here. Per call a timeout clamped to the remaining total budget (so the last call cannot
 * overrun it); the first environment-level failure (gh missing, unauthenticated, offline, timed out) marks gh
 * unavailable and every later call returns that same reason WITHOUT calling again.
 *
 * @param {(cmd: string, args: string[], opts?: object) => string} exec
 * @returns {(args: string[]) => {ok: true, stdout: string} | {ok: false, why: string}}
 */
export function createRemote(exec, { perCallMs = REMOTE_PER_CALL_MS, totalMs = REMOTE_TOTAL_MS, clock = () => performance.now() } = {}) {
  const t0 = clock();
  let dead = null;
  return (args) => {
    if (dead) return { ok: false, why: dead };
    const left = totalMs - (clock() - t0);
    if (left <= 0) {
      dead = `remote budget of ${Math.round(totalMs / 1000)} s spent`;
      return { ok: false, why: dead };
    }
    try {
      const stdout = exec('gh', args, { timeout: Math.max(1, Math.floor(Math.min(perCallMs, left))), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, stdout: String(stdout) };
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err).trim().split(/\r?\n/)[0].slice(0, 160);
      const why = err?.code === 'ENOENT' ? 'gh is not installed' : err?.code === 'ETIMEDOUT' ? `gh timed out (${args.slice(0, 2).join(' ')})` : `gh failed (${msg})`;
      if (err?.code === 'ENOENT' || err?.code === 'ETIMEDOUT' || /auth|login|could not resolve|connect|network|rate limit/i.test(msg)) dead = why;
      return { ok: false, why };
    }
  };
}

// ── The inputs ──────────────────────────────────────────────────────────────

const cache = new WeakMap();
const un = (why, code) => (code ? { measured: false, why, code } : { measured: false, why });

/**
 * Lazy, independently memoised measured inputs for one doctor run.
 *
 * @param {{subjectRoot: string, exec: Function, fs?: object}} ctx
 * @param {object} [deps] test seams: now, cores, commonDir, remote, listWorkflows, readWorkflow
 */
export function operatingInputs(ctx, deps = {}) {
  if (!deps.fresh && cache.has(ctx)) return cache.get(ctx);
  const now = deps.now ?? (() => new Date());
  const fsImpl = deps.fs ?? ctx.fs ?? fs;
  const root = ctx.subjectRoot;
  const memo = new Map();
  const once = (key, fn) => () => { if (!memo.has(key)) memo.set(key, fn()); return memo.get(key); };
  let remoteFn = deps.remote ?? null;
  const remote = (args) => { remoteFn ??= createRemote(ctx.exec); return remoteFn(args); };
  // The record has ONE writer, this repo's scripts/run-tests.mjs. A repo without it (every consumer) can never have
  // one, so "run the suite once with scripts/run-tests.mjs" would be a remedy that does not exist there.
  const hasWriter = once('hasWriter', () => { try { return fsImpl.existsSync(path.join(root, 'scripts', 'run-tests.mjs')); } catch { return false; } });
  const withWriterNote = (m) => (m.measured || hasWriter() ? m : un(m.why.replace(/ \(run the suite once with scripts\/run-tests\.mjs\)/, ' (this repo has no scripts/run-tests.mjs, the only writer of one)')));
  const commonDir = once('commonDir', () => (deps.commonDir !== undefined ? deps.commonDir : gitCommonDir(root)));

  const sources = {
    cores: once('cores', () => ({ measured: true, value: deps.cores ?? coreCount(), source: 'os.availableParallelism' })),

    visibility: once('visibility', () => {
      const r = remote(['repo', 'view', '--json', 'visibility']);
      if (!r.ok) return un(r.why);
      try {
        const v = String(JSON.parse(r.stdout).visibility ?? '').toUpperCase();
        return ['PUBLIC', 'PRIVATE', 'INTERNAL'].includes(v)
          ? { measured: true, value: v, source: 'gh repo view' }
          : un(`gh repo view returned an unrecognised visibility (${JSON.stringify(v)})`);
      } catch { return un('gh repo view returned unparseable output'); }
    }),

    ciJobs: once('ciJobs', () => {
      const dir = path.join(root, '.github', 'workflows');
      let names;
      try { names = (deps.listWorkflows ? deps.listWorkflows(dir) : fsImpl.readdirSync(dir)).filter((n) => /\.ya?ml$/i.test(n)).sort(); } catch (err) {
        return err?.code === 'ENOENT'
          ? un('no .github/workflows directory', 'absent')
          : un(`.github/workflows unreadable (${err?.code ?? 'error'})`, 'unreadable');
      }
      const parsed = []; const failed = [];
      for (const n of names) {
        try { parsed.push(parseWorkflowJobs(deps.readWorkflow ? deps.readWorkflow(path.join(dir, n)) : fsImpl.readFileSync(path.join(dir, n), 'utf8'), n)); } catch (err) {
          failed.push({ file: n, why: String(err?.message ?? err).split(/\r?\n/)[0].slice(0, 120) });
        }
      }
      return { measured: true, value: censusOf(parsed, failed), source: `${names.length} workflow file(s) under .github/workflows` };
    }),

    ciTestWalls: once('ciTestWalls', () => {
      const jobs = sources.ciJobs();
      if (!jobs.measured) return un(`no CI census (${jobs.why})`);
      const targets = jobs.value.testWorkflows.slice(0, MAX_TEST_WORKFLOWS);
      if (targets.length === 0) return un('no workflow runs the test command');
      const out = []; const whys = [];
      for (const w of targets) {
        if (!/^[\w.-]+\.ya?ml$/i.test(w.file)) { whys.push(`${w.file}: unsafe workflow name`); continue; }
        const r = remote(['run', 'list', '--workflow', w.file, '--status', 'success', '--limit', String(MAX_RUNS_PER_WORKFLOW), '--json', 'startedAt,updatedAt']);
        if (!r.ok) { whys.push(`${w.file}: ${r.why}`); continue; }
        let runs;
        try { runs = JSON.parse(r.stdout); } catch { whys.push(`${w.file}: unparseable gh output`); continue; }
        const med = Array.isArray(runs) ? medianRunMs(runs, now()) : null;
        if (!med) { whys.push(`${w.file}: no successful run in ${FRESH_DAYS} d`); continue; }
        const origin = w.runners.includes('self-hosted') ? 'ci-self-hosted-unattributed' : w.runners.includes('unresolved') ? 'ci-unresolved' : 'ci-hosted';
        out.push({ workflow: w.file, ms: med.ms, runs: med.runs, workloadKind: 'ci-workflow', timingBasis: 'workflow-wall', origin });
      }
      return out.length > 0 ? { measured: true, value: out, source: 'gh run list' } : un(whys.join('; '));
    }),

    localSuiteWall: once('localSuiteWall', () => withWriterNote(readSuiteRunRecord(commonDir(), 'full', now()))),

    // The heavy job a push must fit is the FULL gate, so the full record wins when there is one; the branch tier is the
    // fallback, and its identity travels in `workloadKind` (audit R4 M5).
    localHeavyWall: once('localHeavyWall', () => {
      const a = sources.localSuiteWall();
      if (a.measured) return a;
      const b = withWriterNote(readSuiteRunRecord(commonDir(), 'branch', now()));
      return b.measured ? b : un(`${a.why}; ${b.why}`);
    }),

    peakSessions: once('peakSessions', () => (ctx.fleetEvidence
      ? ctx.fleetEvidence.peakSessions({ root, now: now() })
      : un('fleet evidence is not wired into this doctor run'))),

    leaseSharing: once('leaseSharing', () => (ctx.fleetEvidence
      ? ctx.fleetEvidence.leaseSharing({ root, commonDir: commonDir(), exec: ctx.exec, now: now() })
      : un('fleet evidence is not wired into this doctor run'))),

    slotWait: () => un('the lease records no request or acquire events and prunes windows 1 h after they end'),

    tierCapability: once('tierCapability', () => tierCapability(root, fsImpl)),
  };

  const inputs = {};
  for (const [k, fn] of Object.entries(sources)) Object.defineProperty(inputs, k, { enumerable: true, get: fn });
  if (!deps.fresh) cache.set(ctx, inputs);
  return inputs;
}
