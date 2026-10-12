#!/usr/bin/env node
/**
 * @fileoverview Replay CLI — counterfactual evaluation of a candidate
 * policy against historical learning_decisions.  Used to validate v2
 * promotion candidates per master plan §5 promotion gates.
 *
 *   node scripts/learning/replay.mjs pass_selection
 *     [--policy FILE]            default: built-in historical baseline
 *     [--baseline FILE]          default: historical-choice baseline
 *     [--since 30d]              default: 30d (e.g. 7d, 14d, 90d)
 *     [--repo-id UUID]           filter by repo UUID (audit_repos.id)
 *     [--repo UUID]              alias for --repo-id (NOT a name lookup)
 *     [--format json|markdown]   default: json
 *   Decision types: pass_selection, convergence_predict, arch_memory_band.
 *   Both `--name value` and `--name=value` are read; every flag above takes a value.
 *
 * CLI output contract (per master plan §6):
 *   - stdout: JSON by default (the comparison-result object)
 *   - --format markdown: switches stdout to a comparison table
 *   - stderr: progress logs (cloud read pages, sample sizes, etc.)
 *   - a FAILURE is an `{ok:false, error}` envelope on stdout AND exit 1 — a
 *     non-zero exit with empty stdout was the old behaviour for every refusal.
 *   - `sampleSize: 0` is NOT "no difference": the store may be off or unreadable,
 *     or nothing matched. A stderr WARNING (and a markdown block) says so, and the
 *     JSON envelope carries `measured: false` (`measured: true` for a non-empty
 *     sample) — still `ok: true`, exit 0: an empty sample is unmeasured, never a
 *     refusal and never a zero (decision 2026-10-12).
 *
 * Plan: docs/plans/adaptive-learning-phase-3-replay.md §2 (replay CLI)
 *
 * @module scripts/learning/replay
 */
import '../lib/load-env.mjs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, emit, finishAndExit } from '../lib/cli-io.mjs';
import { pathToFileURL } from 'node:url';

import {
  replay,
  passSelectionReward,
  convergencePredictReward,
  archMemoryBandReward,
  historicalBaseline,
} from '../lib/learning/replay.mjs';

const DEFAULT_REWARDS = {
  pass_selection:      passSelectionReward,
  convergence_predict: convergencePredictReward,
  arch_memory_band:    archMemoryBandReward,
};

// ── Duration parsing ──────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)(ms|s|m|h|d|w)?$/i;
const DURATION_MULTIPLIERS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseDuration(input, fallbackMs) {
  if (!input) return fallbackMs;
  const m = DURATION_RE.exec(String(input).trim());
  if (!m) return fallbackMs;
  const num = parseInt(m[1], 10);
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = DURATION_MULTIPLIERS[unit];
  if (!mult) return fallbackMs;
  return num * mult;
}

// ── Markdown rendering ────────────────────────────────────────────────────

/**
 * What an EMPTY sample means, or null when the sample is not empty.
 *
 * `sampleSize: 0` arrives from three different causes that the library
 * deliberately does not tell apart (its `ok:true` contract is pinned): the cloud
 * store is off or unreadable (a swallowed read error), the window/repo filter
 * matches nothing, or nothing of this type was ever recorded. All three print an
 * all-zero delta, which reads as "the candidate matches the baseline" — the
 * opposite of "nothing was compared". Ledger af81be85.
 *
 * @param {{sampleSize?: number}|null|undefined} result
 * @returns {string|null}
 */
export function emptySampleNotice(result) {
  if (!result || result.sampleSize !== 0) return null;
  return 'sampleSize is 0 — no decisions were compared, so the zero delta is NOT evidence '
    + 'that the candidate matches the baseline. Possible causes: the cloud store is off or '
    + 'unreadable (look for a "[learning] ... error" line on stderr), the window or repo '
    + 'filter matches nothing, or none of this type have been recorded yet.';
}

export function renderMarkdownReport(result) {
  const notice = emptySampleNotice(result);
  const lines = [
    `# Replay report — \`${result.decisionType}\``,
    '',
    `- Sample size: **${result.sampleSize}** decisions`,
    `- Window:      \`${(result.sinceMs / (24 * 60 * 60 * 1000)).toFixed(1)}d\``,
    '',
    ...(notice ? [`> **Warning — empty sample.** ${notice}`, ''] : []),
    '## Reward distributions',
    '',
    '| Policy    | mean   | p50    | p90    | total   |',
    '|-----------|--------|--------|--------|---------|',
    `| baseline  | ${fmtNum(result.baselineDist.mean)} | ${fmtNum(result.baselineDist.p50)} | ${fmtNum(result.baselineDist.p90)} | ${fmtNum(result.baselineDist.total)} |`,
    `| candidate | ${fmtNum(result.candidateDist.mean)} | ${fmtNum(result.candidateDist.p50)} | ${fmtNum(result.candidateDist.p90)} | ${fmtNum(result.candidateDist.total)} |`,
    '',
    '## Delta',
    '',
    `- mean delta: **${fmtNum(result.deltaSummary.meanDelta)}**`,
    `- candidate-better: **${(result.deltaSummary.candidateBetterPct * 100).toFixed(1)}%** of decisions`,
    `- ties: ${result.deltaSummary.ties}`,
    '',
    '_Promotion gate (master plan §5)_: pass_selection ≤5% recall loss vs all-pass; convergence_predict ≤2% false-stop rate; arch_memory_band ≥10% precision lift on reuse band.',
  ];
  return lines.join('\n');
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return 'NaN';
  return Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// ── Policy loader ─────────────────────────────────────────────────────────

async function loadPolicy(modulePath, fallback) {
  if (!modulePath) return fallback;
  // Resolve relative to cwd; convert to file:// URL for cross-platform import.
  const abs = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  // Selected by the SAME predicate that validates: `mod.default || mod.policy`
  // returned a truthy non-function default over a valid named policy, so the
  // "validated" value was not callable. `default` keeps precedence when both
  // are functions (the long-standing order).
  const fn = [mod.default, mod.policy].find((candidate) => typeof candidate === 'function');
  if (!fn) {
    throw new Error(`Policy module ${modulePath} must export default OR named 'policy' as a function`);
  }
  return fn;
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

/**
 * Every flag here takes a VALUE, so the token after it is not a positional.
 *
 * Declared rather than inferred, because the alternative — "anything not
 * starting with `--`" — silently swallowed the flag's value: measured
 * 2026-08-12, `replay --repo owner/repo pass_selection` took `owner/repo` as
 * the decision type and failed with "no built-in rewardFn for
 * decision_type='owner/repo'", which reads as a bad decision type rather than a
 * misparsed argument. Found by the consolidated Gemini gate, confirmed by
 * executing it.
 */
const VALUED_FLAGS = new Set(['policy', 'baseline', 'since', 'repo', 'repo-id', 'format']);

/** Accepted flags — refused rather than ignored (assertKnownFlags at the entry). */
const KNOWN_FLAGS = [...VALUED_FLAGS].map((f) => `--${f}`).concat(['--help', '--selfcheck-relocation']);

/**
 * This CLI's own grammar, for the one consumer that must agree with it: the
 * cross-skill registry entry `learning-replay`. The registry is static data and
 * must not import this module (cold start does not scale with command count, and
 * it would add a cross-skill-bridge → scripts edge), so the two inventories are
 * pinned against each other by tests/learning-replay.test.mjs instead.
 */
export const REPLAY_GRAMMAR = Object.freeze({
  decisionTypes: Object.freeze(Object.keys(DEFAULT_REWARDS)),
  valuedFlags: Object.freeze([...VALUED_FLAGS]),
});

/**
 * Tokenise argv ONCE, for positionals and options alike.
 *
 * `replayPositionals` understood `--name=value` while the option reader (`optVal`)
 * did not — two readers of one argv disagreeing about its grammar, so `--since=7d`
 * passed the flag allowlist, was skipped by the positional scan, and was then
 * silently absent from the options (ledger af81be85, executed 2026-10-03: ran
 * with the 30d default; `--format=markdown` printed JSON; `--repo=UUID` was
 * ignored and widened the scope to every repo). Validated-vs-consumed drift: one
 * function owns the grammar now.
 *
 *  - `--name=value` carries its own value (everything after the FIRST `=`).
 *  - `--name value` takes the next token ONLY if it exists and does not start
 *    with `--`; otherwise the option is recorded with an EMPTY value, which
 *    `validateReplayOptions` refuses. So `--policy --since 7d` never reads
 *    `--since` as a module path.
 *  - Only VALUED_FLAGS are options; any other `--x` consumes nothing, so a
 *    value-less flag cannot eat a positional.
 *  - Last occurrence wins, across both spellings.
 *  - The POSIX `--` terminator ends option parsing (matching assertKnownFlags,
 *    `argOption` and the dispatcher's flagRegion): everything after it is a
 *    positional, so a post-terminator `--policy=x.mjs` cannot reach `import()`.
 *
 * @param {string[]} args
 * @returns {{positionals: string[], opts: Record<string, string>}}
 */
export function parseReplayArgs(args) {
  const positionals = [];
  const opts = {};
  let terminated = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (terminated) { positionals.push(a); continue; }
    if (a === '--') { terminated = true; continue; }
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (!VALUED_FLAGS.has(name)) continue;
    if (eq >= 0) { opts[name] = a.slice(eq + 1); continue; }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) { opts[name] = next; i += 1; } else opts[name] = '';
  }
  return { positionals, opts };
}

/** Positionals only — kept for its existing callers/tests; a view over the one tokenizer. */
export function replayPositionals(args) {
  return parseReplayArgs(args).positionals;
}

// `learning_decisions.repo_id` is `uuid REFERENCES audit_repos(id)`
// (supabase/migrations/20260508120000_adaptive_learning_v1.sql). A non-UUID
// reaches Postgres as 22P02, which readDecisionsPaginated swallows into an empty
// page — so `--repo owner/repo` printed `ok:true sampleSize:0`, exit 0: a false
// zero. Refused here instead. (A private copy: the repo has four others, and a
// shared home is outside this change — recorded as debt.)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FORMATS = ['json', 'markdown'];
const DEFAULT_SINCE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Everything checkable WITHOUT a policy import or a store read. Runs first, so a
 * bad invocation fails before any IO — and as a RETURNED `{ok:false}` the entry
 * point can write (it used to import `--policy` before even checking the type).
 *
 * @param {{positionals: string[], opts: Record<string, string>}} parsed
 * @returns {{ok:false, error:string}|{ok:true, request:object}}
 */
function validateReplayOptions({ positionals, opts }) {
  const fail = (error) => ({ ok: false, error });
  if (positionals.length > 1) {
    return fail(`expected exactly one decision type, got ${positionals.length}: ${positionals.join(' ')}`);
  }
  for (const [name, v] of Object.entries(opts)) {
    if (v === '') return fail(`--${name} requires a value (write --${name}=VALUE if the value starts with --)`);
  }
  const decisionType = positionals[0];
  // hasOwn, not `DEFAULT_REWARDS[decisionType]`: `constructor` is a function.
  if (!Object.hasOwn(DEFAULT_REWARDS, decisionType)) {
    return fail(`no built-in rewardFn for decision_type='${decisionType}' (supported: ${Object.keys(DEFAULT_REWARDS).join(', ')})`);
  }
  // Audit-fix Phase 3 R1 H4: accept BOTH --repo-id (canonical, UUID) and
  // --repo (alias).  The flag was advertised in the docstring but only
  // --repo-id was wired — fix the inconsistency at the CLI surface.
  // The two spellings are ONE filter: if both are given and disagree, silently preferring one
  // would measure a repo the operator may not have meant. Repeating the same value is fine.
  if (opts['repo-id'] && opts.repo && String(opts['repo-id']).toLowerCase() !== String(opts.repo).toLowerCase()) {
    return fail(`--repo and --repo-id are the same filter but disagree ("${opts.repo}" vs "${opts['repo-id']}"); pass one.`);
  }
  const repoId = opts['repo-id'] || opts.repo || null;
  if (repoId !== null && !UUID_RE.test(repoId)) {
    return fail(`--repo/--repo-id must be an audit_repos UUID, got "${repoId}". This is NOT a name or owner/repo lookup.`);
  }
  let sinceMs = DEFAULT_SINCE_MS;
  if (opts.since !== undefined) {
    // `null` fallback: parseDuration's default is to answer with the fallback for
    // anything it cannot parse, which here would silently become the 30d window.
    sinceMs = parseDuration(opts.since, null);
    if (sinceMs === null) {
      return fail(`--since "${opts.since}" is not a duration (a whole number plus ms, s, m, h, d or w, e.g. 7d)`);
    }
  }
  const format = opts.format ?? 'json';
  if (!FORMATS.includes(format)) {
    return fail(`--format "${format}" must be one of: ${FORMATS.join(', ')}`);
  }
  return {
    ok: true,
    request: {
      decisionType,
      rewardFn: DEFAULT_REWARDS[decisionType],
      repoId,
      sinceMs,
      format,
      policyPath: opts.policy ?? null,
      baselinePath: opts.baseline ?? null,
    },
  };
}

/** Load one policy module; a failure is RETURNED (with its stack on stderr), never thrown. */
async function loadPolicyOrFail(flag, modulePath, fallback) {
  try {
    return { policy: await loadPolicy(modulePath, fallback) };
  } catch (err) {
    process.stderr.write(`${err?.stack || err}\n`);
    return { failure: { ok: false, error: `policy-load-failed: --${flag} ${modulePath}: ${err?.message || err}` } };
  }
}

/**
 * @param {string[]} args argv after the script name
 * @param {{replayFn?: typeof replay}} [deps] test seam: the store-reading engine
 * @returns {Promise<object>} the replay result, or `{ok:false, error}`. A FAILURE
 *   is returned, never written here: the isMain tail emits it for the direct CLI
 *   and `learningReplayCmd` emits it for the dispatcher — writing it in this
 *   function too would put two JSON values on one stdout.
 */
export async function runReplayCli(args, { replayFn = replay } = {}) {
  const parsed = parseReplayArgs(args);
  if (parsed.positionals.length === 0) {
    process.stderr.write(`Usage: replay ${Object.keys(DEFAULT_REWARDS).join('|')} [--policy FILE] [--baseline FILE] [--since 30d] [--repo-id UUID] [--format json|markdown]\n`);
    return { ok: false, error: 'missing-decision-type' };
  }
  const validated = validateReplayOptions(parsed);
  if (!validated.ok) return validated;
  const { decisionType, rewardFn, repoId, sinceMs, format, policyPath, baselinePath } = validated.request;

  // Load candidate + baseline.  When no candidate is provided, fall back
  // to the historical baseline (so the run effectively replays "what we
  // already shipped") — useful for sanity-checking the rewardFn.
  const candidate = await loadPolicyOrFail('policy', policyPath, historicalBaseline);
  if (candidate.failure) return candidate.failure;
  const baseline = await loadPolicyOrFail('baseline', baselinePath, historicalBaseline);
  if (baseline.failure) return baseline.failure;

  process.stderr.write(`[replay] decisionType=${decisionType} sinceMs=${sinceMs} repoId=${repoId || 'all'}\n`);

  let result;
  try {
    result = await replayFn({
      decisionType,
      sinceMs,
      candidatePolicy: candidate.policy,
      baselinePolicy: baseline.policy,
      rewardFn,
      repoId,
    });
  } catch (err) {
    // A throwing candidate policy propagates out of replay() (only the reward fn
    // is wrapped), as does its input validation.
    process.stderr.write(`${err?.stack || err}\n`);
    return { ok: false, error: `replay-failed: ${err?.message || err}` };
  }
  if (result && result.ok === false) return result;

  const notice = emptySampleNotice(result);
  if (notice) process.stderr.write(`[replay] WARNING: ${notice}\n`);
  // `measured` rides the stdout envelope so a caller reading only stdout or the
  // exit code cannot mistake an empty sample for a clean zero. Fails closed: a
  // missing or non-numeric sampleSize is not a measurement either.
  const envelope = { ...result, measured: Number.isFinite(result?.sampleSize) && result.sampleSize > 0 };
  if (format === 'markdown') {
    process.stdout.write(renderMarkdownReport(envelope) + '\n');
  } else {
    process.stdout.write(JSON.stringify(envelope) + '\n');
  }
  return envelope;
}

if (isMain) {
  // Flag validation was ABSENT, which is what made the positional misparse
  // reachable in the first place: an unknown valued flag (`--nope value`)
  // could not be refused, so its value fell through as the decision type.
  // Adding the guard closes the class; VALUED_FLAGS only has to be right for
  // flags that survive it. (Consolidated Gemini gate, round 2.)
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'learning/replay' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}
`); process.exit(2); }
    throw err;
  }
  const result = await runReplayCli(process.argv.slice(2));
  // A failure is WRITTEN, not just exited on: `replay.mjs bogus_type` used to exit
  // 1 with an empty stdout (ledger b445b4ba). `emit` writes the envelope and, via
  // the ok:false ⇒ non-zero coupling, sets exit 1; `finishAndExit` then drains
  // stdout before exiting — a bare `process.exit()` after a stdout write
  // truncates a piped report on Windows.
  if (result.ok === false) emit(result);
  await finishAndExit(process.exitCode ?? 0);
}
