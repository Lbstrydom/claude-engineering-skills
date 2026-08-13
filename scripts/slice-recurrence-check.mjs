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
 * silent fallback (see docs/runbooks/local-maintenance-checks.md §"Why
 * opportunistic"). So the verdict carries a DENOMINATOR, and a window with no
 * qualifying runs reports `unknown`, never green.
 *
 * **The instrument has a hard zero baseline, which is what makes it trustworthy.**
 * Measured 2026-08-13, before the fix shipped: `audit_pass_stats` held 400
 * `duplication` rows and 379 `adjacency` rows, and **not one of the 779 had a
 * non-zero `input_tokens`** — because both waves built their pass result with a
 * hard-coded `usage: { input_tokens: 0, … }`. Over the same period the passes
 * that were already EXTRACTED into functions recorded tokens on most runs
 * (architecture 218/400, quickfix 356/400, sustainability 364/400). The check
 * is therefore seen-to-fail by construction: run it against pre-fix history and
 * it returns zero. Any non-zero afterwards is unambiguous evidence the fix is
 * live in the code that produced the row.
 *
 * **Retirement predicate (this file is DISPOSABLE — please honour it).** Delete
 * this script, its `CHECKS` entry in `maintenance-checks.mjs`, its row in
 * `tests/maintenance-checks.test.mjs`'s inventory, and its runbook row **as soon
 * as it has reported a verdict other than `unknown` once** and that verdict is
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
import 'dotenv/config';
import { assertKnownFlags } from './lib/cli-io.mjs';

const CLI = 'slice-recurrence-check';

/** The commit that shipped slice 1. Findings/pass-runs are counted AFTER it. */
const FIX_SHA = 'a7db0baf0203581e85904c34d17165fa4548d2dd';
/** The fix landed 2026-08-13; the window opens the moment it did. */
const WINDOW_START_ISO = '2026-08-13';
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
      reason: `no duplication/adjacency pass ran since ${WINDOW_START_ISO} — the window measured nothing`,
      action: 'Do NOT read this as "the cluster stopped". Run /audit-code on this repo, then re-run this check.',
    };
  }
  if (passRunsWithTokens === 0) {
    return {
      verdict: 'unknown',
      reason: `${passRuns} pass run(s) since ${WINDOW_START_ISO}, but none recorded bouncer tokens`,
      action: 'Ambiguous by construction: either no run had eligible candidates (legitimate — the bouncer '
        + 'only fires when there are some), or the fix is not reaching the store. Verify before trusting a '
        + 'green elsewhere: a non-zero here is the positive control for the whole measurement.',
    };
  }
  if (newFindings > 0) {
    return {
      verdict: 'recurring',
      reason: `${newFindings} new usage-accounting finding(s) on legacy-production-audit.mjs since ${WINDOW_START_ISO}`,
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

async function measure() {
  const { getPool } = await import('./lib/db/client.mjs');
  const pool = await getPool();

  const runs = await pool.query(
    `SELECT count(*)::int AS pass_runs,
            count(*) FILTER (WHERE coalesce(input_tokens, 0) > 0)::int AS with_tokens
       FROM audit_pass_stats
      WHERE pass_name = ANY($1) AND created_at >= $2::date`,
    [SLICE_PASSES, WINDOW_START_ISO],
  );

  // Deliberately broad: the cluster spelled itself a dozen different ways
  // ("Incorrect usage/cost telemetry", "Usage-accounting data loss",
  // "Incomplete telemetry aggregation"), so matching on one category label
  // would under-count and read as a false green.
  const findings = await pool.query(
    `SELECT count(*)::int AS n
       FROM audit_findings
      WHERE primary_file ILIKE '%legacy-production-audit%'
        AND created_at >= $1::date
        AND coalesce(adjudication_outcome, '') <> 'dismissed'
        AND (category ILIKE '%usage%' OR category ILIKE '%telemetry%' OR category ILIKE '%cost%'
             OR detail_snapshot ILIKE '%usage%token%' OR detail_snapshot ILIKE '%hard-coded zero%')`,
    [WINDOW_START_ISO],
  );

  return {
    passRuns: runs.rows[0].pass_runs,
    passRunsWithTokens: runs.rows[0].with_tokens,
    newFindings: findings.rows[0].n,
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

  if (!process.env.AUDIT_DB_URL) {
    process.stderr.write(`  [slice-verdict] AUDIT_DB_URL unset — cannot measure; this is 'unknown', not 'stopped'\n`);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'unknown', reason: 'no AUDIT_DB_URL' })}\n`);
    return;
  }

  let m;
  try {
    m = await measure();
  } catch (err) {
    // Fail loud but non-blocking: a broken instrument must never read as green.
    process.stderr.write(`  [slice-verdict] measurement failed (${err.message}) — verdict is 'unknown'\n`);
    if (asJson) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'unknown', reason: err.message })}\n`);
    return;
  }

  const v = decideVerdict(m);
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...v, ...m, fixSha: FIX_SHA, windowStart: WINDOW_START_ISO })}\n`);
    return;
  }

  process.stderr.write(
    `\n  ── Slice 1 recurrence verdict (${FIX_SHA.slice(0, 8)}, window from ${WINDOW_START_ISO}) ──\n`
    + `  baseline before the fix: 0 of 779 duplication/adjacency pass rows carried tokens\n`
    + `  since:  ${m.passRuns} pass run(s), ${m.passRunsWithTokens} with real bouncer tokens, `
    + `${m.newFindings} new usage-accounting finding(s)\n`
    + `  VERDICT: ${v.verdict.toUpperCase()} — ${v.reason}\n`
    + `  → ${v.action}\n`
    + `  Once this reports anything other than 'unknown': record it in the slice log of\n`
    + `  docs/plans/audit-backlog-triage-hardening.md, then DELETE this check (see its header).\n\n`,
  );
}

await main();
