#!/usr/bin/env node
/**
 * @fileoverview One-shot verdict check for god-module decomposition slice 1
 * (`a7db0baf`, 2026-08-13): did extracting the duplication + adjacency waves
 * out of `runLegacyProductionAudit` actually stop the usage-accounting finding
 * cluster recurring on that file?
 *
 * **Why this exists as a check rather than a calendar reminder.** A bare date
 * reminder cannot tell "the cluster stopped" apart from "nobody audited this
 * file for four weeks" — and this repo has already been burned by exactly that
 * reading: a tiered-recall shadow window read "met" while every run was a
 * silent fallback (docs/runbooks/local-maintenance-checks.md §"Why
 * opportunistic"). So the verdict carries a DENOMINATOR, and a window with no
 * qualifying runs reports `unknown`, never green.
 *
 * **The instrument has a hard zero baseline, which is what makes it trustworthy.**
 * Measured 2026-08-13, scoped to THIS repo and to rows created BEFORE the fix
 * commit: `audit_pass_stats` held 307 `duplication` and 286 `adjacency` rows,
 * and **0 of those 593 had a non-zero `input_tokens`** — because both waves
 * built their pass result with a hard-coded `usage: { input_tokens: 0, … }`.
 * Over the same period the passes already EXTRACTED into functions recorded
 * tokens on most runs (architecture 218/400, quickfix 356/400, sustainability
 * 364/400). Reproduce with the query in `measure()` and `created_at <
 * WINDOW_START_ISO`. So the check is seen-to-fail by construction: run it
 * against pre-fix history and it returns zero. Any non-zero afterwards is
 * unambiguous evidence the fix is live in the code that produced the row.
 *
 * > An earlier revision of this docblock said "0 of 779". That count was
 * > UNSCOPED — it summed both repos in the store and included post-fix rows.
 * > The conclusion (zero) was unchanged, but the denominator was wrong, which
 * > is why the figure now carries the scope it was measured under.
 *
 * **Every query is repo-scoped, and that is load-bearing, not hygiene.** The
 * store is shared across repos: at the time of writing it held 607 of these
 * pass rows for this repo and **184 for `wine-cellar-app`, a CONSUMER that
 * receives this very fix by sync**. An unscoped denominator would therefore
 * count a consumer's post-sync runs as evidence about this repo and report a
 * believable false `stopped`. Scoping fails CLOSED: if repo identity cannot be
 * resolved, the verdict is `unknown`, never green.
 *
 * **Retirement predicate (this file is DISPOSABLE — please honour it).** Delete
 * this script, its `CHECKS` entry in `maintenance-checks.mjs`, its key in
 * `tests/maintenance-checks.test.mjs`'s inventory,
 * `tests/slice-recurrence-check.test.mjs`, and its runbook row **as soon as it
 * has reported a verdict other than `unknown` once** and that verdict is
 * recorded in the slice log of
 * `docs/plans/audit-backlog-triage-hardening.md`. It answers one question about
 * one commit; a permanent weekly check for a settled question is exactly the
 * kind of apparatus this repo tells itself not to accumulate.
 *
 * Silent no-op before DUE_ISO, so adding it costs nothing until it is due.
 * `--force` runs it early (how it was tested).
 *
 * Usage:
 *   node scripts/slice-recurrence-check.mjs           — verdict, or silence if not yet due
 *   node scripts/slice-recurrence-check.mjs --force    — ignore the due date
 *   node scripts/slice-recurrence-check.mjs --json     — machine-readable envelope
 */
import { pathToFileURL } from 'node:url';
// The repo's ONE env loader (config.mjs calls the same function at module load).
// A bare `import 'dotenv/config'` here would read only the cwd `.env` and miss
// the per-user shared `~/.audit-loop.env`, so this check alone would conclude
// "no AUDIT_DB_URL" on a machine where every other check resolves the DSN fine.
import { loadSharedEnv } from './lib/load-shared-env.mjs';
import { assertKnownFlags } from './lib/cli-io.mjs';

loadSharedEnv();

const CLI = 'slice-recurrence-check';

/** The commit that shipped slice 1. */
const FIX_SHA = 'a7db0baf0203581e85904c34d17165fa4548d2dd';
/**
 * `FIX_SHA`'s own commit timestamp, not a date. Date granularity would have
 * counted findings raised EARLIER on 2026-08-13 — before the fix landed at
 * 14:09 — as post-fix evidence, which is the wrong causal direction for the
 * only question this check exists to answer.
 */
const WINDOW_START_ISO = '2026-08-13T14:09:26+02:00';
/** ~4 weeks later — the trigger god-module-and-layering-debt.md §10 sets. */
const DUE_ISO = '2026-09-10';
/** The two waves slice 1 extracted. Their pass rows are the denominator. */
const SLICE_PASSES = ['duplication', 'adjacency'];

/**
 * Decide the verdict from the three measured counts.
 *
 * Pure and exported so the ordering is unit-testable without a database — the
 * ordering is the whole contract: both `unknown` arms are checked BEFORE the
 * green arm, so a dormant window can never fall through to "stopped".
 *
 * @param {{passRuns:number, passRunsWithTokens:number, newFindings:number}} m
 * @returns {{verdict:'unknown'|'recurring'|'stopped', reason:string, action:string}}
 */
export function decideVerdict({ passRuns, passRunsWithTokens, newFindings }) {
  if (passRuns === 0) {
    return {
      verdict: 'unknown',
      reason: 'no duplication/adjacency pass ran in this repo since the fix — the window measured nothing',
      action: 'Do NOT read this as "the cluster stopped". Run /audit-code on this repo, then re-run this check.',
    };
  }
  if (passRunsWithTokens === 0) {
    return {
      verdict: 'unknown',
      reason: `${passRuns} pass run(s) since the fix, but none recorded bouncer tokens`,
      action: 'Ambiguous by construction: either no run had eligible candidates (legitimate — the bouncer '
        + 'only fires when there are some), or the fix is not reaching the store. Verify before trusting a '
        + 'green elsewhere: a non-zero here is the positive control for the whole measurement.',
    };
  }
  if (newFindings > 0) {
    return {
      verdict: 'recurring',
      reason: `${newFindings} new usage-accounting finding(s) on legacy-production-audit.mjs since the fix`,
      action: 'Slice 1\'s diagnosis was WRONG. Do not reuse the inline-vs-extracted reasoning for slice 2 — '
        + 'read the new findings first; they are evidence against it.',
    };
  }
  return {
    verdict: 'stopped',
    reason: `${passRunsWithTokens}/${passRuns} pass run(s) recorded real bouncer tokens and 0 new `
      + 'usage-accounting findings were raised',
    action: 'Slice 1\'s diagnosis HELD. Slice 2 is warranted — start from the concern boundary list in '
      + 'docs/plans/audit-backlog-triage-hardening.md item 5, NOT from a fresh derivation.',
  };
}

/**
 * @returns {Promise<{ok:true, m:object} | {ok:false, reason:string}>}
 *   `ok:false` is an INSTRUMENT failure (cannot measure), distinct from a
 *   measured-but-inconclusive `unknown` verdict. main() exits non-zero on the
 *   former only.
 */
async function measure() {
  const { resolveRepoForStoreResult } = await import('./lib/store/repo.mjs');
  const repo = await resolveRepoForStoreResult({});
  // Fail CLOSED. Without an identity every count would silently span every repo
  // in the shared store, including consumers running this same synced fix.
  if (repo.kind !== 'resolved') {
    return { ok: false, reason: `repo identity ${repo.kind}${repo.error ? `: ${repo.error}` : ''} — refusing to measure unscoped` };
  }

  const { getPool } = await import('./lib/db/client.mjs');
  const pool = await getPool();

  const runs = await pool.query(
    `SELECT count(*)::int AS pass_runs,
            count(*) FILTER (WHERE coalesce(ps.input_tokens, 0) > 0)::int AS with_tokens
       FROM audit_pass_stats ps
       JOIN audit_runs r ON r.id = ps.run_id
      WHERE ps.pass_name = ANY($1)
        AND r.repo_id = $2
        AND ps.created_at >= $3::timestamptz`,
    [SLICE_PASSES, repo.repoRowId, WINDOW_START_ISO],
  );

  // Deliberately BROAD text matching: the cluster spelled itself a dozen ways
  // ("Incorrect usage/cost telemetry", "Usage-accounting data loss",
  // "Incomplete telemetry aggregation"), so matching one category label would
  // under-count and read as a false green. Over-matching biases toward
  // `recurring`, which is the CONSERVATIVE direction — it tells you the
  // diagnosis may be wrong and to go read the findings, which is cheap. A
  // precision miss here costs a read; a recall miss costs a false green.
  const findings = await pool.query(
    `SELECT count(*)::int AS n
       FROM audit_findings f
       JOIN audit_runs r ON r.id = f.run_id
      WHERE f.primary_file ILIKE '%legacy-production-audit%'
        AND r.repo_id = $1
        AND f.created_at >= $2::timestamptz
        AND coalesce(f.adjudication_outcome, '') <> 'dismissed'
        -- OPEN recurrence only. A finding raised and then FIXED is the loop
        -- working, not the class recurring; counting it would make the verdict
        -- monotonically worse forever and guarantee a "recurring" reading for
        -- any repo that audits itself. Same predicate as the open-tail count
        -- this check's slice log quotes, so the two agree.
        AND coalesce(f.remediation_state, '') NOT IN ('fixed', 'verified')
        AND (f.category ILIKE '%usage%' OR f.category ILIKE '%telemetry%' OR f.category ILIKE '%cost%'
             OR f.detail_snapshot ILIKE '%usage%token%' OR f.detail_snapshot ILIKE '%hard-coded zero%')`,
    [repo.repoRowId, WINDOW_START_ISO],
  );

  return {
    ok: true,
    m: {
      repo: repo.name,
      passRuns: runs.rows[0].pass_runs,
      passRunsWithTokens: runs.rows[0].with_tokens,
      newFindings: findings.rows[0].n,
    },
  };
}

async function main() {
  assertKnownFlags(process.argv, ['--force', '--json', '--help'], { cli: CLI });
  const force = process.argv.includes('--force');
  const asJson = process.argv.includes('--json');

  const today = new Date().toISOString().slice(0, 10);
  if (!force && today < DUE_ISO) {
    // Silent, exit 0 — the whole point of a dated one-shot is that it costs
    // nothing on every push until it is due.
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: true, status: 'not-due', dueOn: DUE_ISO })}\n`);
    return;
  }

  let outcome;
  try {
    outcome = await measure();
  } catch (err) {
    outcome = { ok: false, reason: err.message };
  }

  if (!outcome.ok) {
    // A broken instrument is a FAILURE, not an `unknown` verdict: `unknown`
    // means "measured, inconclusive". Exit non-zero so automation cannot read a
    // measurement that never happened as a clean run. (Safe in the maintenance
    // runner: the check declares AUDIT_DB_URL in requiredEnv, so a machine with
    // no DSN SKIPS it rather than reaching this branch.)
    process.stderr.write(`  [slice-verdict] cannot measure — ${outcome.reason}\n`);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, verdict: null, reason: outcome.reason })}\n`);
    process.exitCode = 1;
    return;
  }

  const m = outcome.m;
  const v = decideVerdict(m);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...v, ...m, fixSha: FIX_SHA, windowStart: WINDOW_START_ISO })}\n`);
    return;
  }

  process.stderr.write(
    `\n  ── Slice 1 recurrence verdict (${FIX_SHA.slice(0, 8)}, ${m.repo}, window from ${WINDOW_START_ISO}) ──\n`
    + `  baseline before the fix: 0 of 593 duplication/adjacency pass rows carried tokens (this repo)\n`
    + `  since:  ${m.passRuns} pass run(s), ${m.passRunsWithTokens} with real bouncer tokens, `
    + `${m.newFindings} new usage-accounting finding(s)\n`
    + `  VERDICT: ${v.verdict.toUpperCase()} — ${v.reason}\n`
    + `  → ${v.action}\n`
    + `  Once this reports anything other than 'unknown': record it in the slice log of\n`
    + `  docs/plans/audit-backlog-triage-hardening.md, then DELETE this check (see its header).\n\n`,
  );
}

// Only run as a CLI. `tests/slice-recurrence-check.test.mjs` imports
// `decideVerdict`, and an unguarded `await main()` would execute the whole
// database measurement on import — silently harmless today only because the
// due-date short-circuit fires first, and a live bug the moment it stops.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) await main();
