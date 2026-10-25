#!/usr/bin/env node
/**
 * @fileoverview Before/after census for the own-model telemetry gaps
 * (docs/research/own-model-roadmap-2026-10.md §2.1; plan
 * docs/plans/own-model-telemetry-slice-1.md). Read-only: every query is a SELECT
 * over the active store, so it is safe against production.
 *
 * Each gap reports `populated / population` — the denominator is part of the
 * claim (a bare count of populated rows says nothing about coverage).
 *
 * Usage: node scripts/own-model-telemetry-census.mjs [--json]
 * @module scripts/own-model-telemetry-census
 */

import './lib/load-env.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { finishAndExit, assertKnownFlags } from './lib/cli-io.mjs';

/**
 * One row per gap. `sql` returns a single row `{populated, population}`.
 * Column-existence is probed first (`needs`), so a store that has not been
 * migrated yet reports `unmigrated` instead of a 42703 that reads as zero.
 */
export const CENSUS_GAPS = [
  { id: 'g1-audited-sha', label: 'audit_runs.audited_sha', needs: [['audit_runs', 'audited_sha']],
    sql: 'SELECT count(audited_sha)::int AS populated, count(*)::int AS population FROM audit_runs' },
  { id: 'g1-diff-ref', label: 'audit_runs.diff_ref (code scope=diff runs)', needs: [['audit_runs', 'diff_ref']],
    sql: "SELECT count(diff_ref)::int AS populated, count(*)::int AS population FROM audit_runs WHERE mode = 'code' AND scope_mode = 'diff'" },
  { id: 'g1-diff-base', label: 'audit_runs.diff_base_sha (code scope=diff runs)', needs: [['audit_runs', 'diff_base_sha']],
    sql: "SELECT count(diff_base_sha)::int AS populated, count(*)::int AS population FROM audit_runs WHERE mode = 'code' AND scope_mode = 'diff'" },
  { id: 'g2-adjudicator-kind', label: 'finding_adjudication_events.adjudicator_kind', needs: [['finding_adjudication_events', 'adjudicator_kind']],
    sql: 'SELECT count(adjudicator_kind)::int AS populated, count(*)::int AS population FROM finding_adjudication_events' },
  { id: 'g2-adjudicator-model', label: 'finding_adjudication_events.adjudicator_model', needs: [['finding_adjudication_events', 'adjudicator_model']],
    sql: 'SELECT count(adjudicator_model)::int AS populated, count(*)::int AS population FROM finding_adjudication_events' },
  { id: 'g3-dismiss-reason', label: 'dismiss_reason (dismissed + auto_dismissed)', needs: [['audit_findings', 'dismiss_reason']],
    sql: `SELECT count(dismiss_reason)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE user_action IN ('dismissed','auto_dismissed')` },
  { id: 'g3-dismiss-reason-class', label: 'dismiss_reason_class (dismissed + auto_dismissed)', needs: [['audit_findings', 'dismiss_reason_class']],
    sql: `SELECT count(dismiss_reason_class)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE user_action IN ('dismissed','auto_dismissed')` },
  { id: 'g3b-dismissed-by-outcome', label: 'dismiss_reason_class (adjudication_outcome=dismissed, no user_action label)', needs: [['audit_findings', 'dismiss_reason_class']],
    sql: `SELECT count(dismiss_reason_class)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE adjudication_outcome = 'dismissed'` },
  { id: 'g4-fix-commit-sha', label: 'fix_commit_sha (remediation fixed/verified)', needs: [['audit_findings', 'fix_commit_sha']],
    sql: `SELECT count(fix_commit_sha)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE remediation_state IN ('fixed','verified')` },
  { id: 'g4-fixed-before-adjudication', label: 'fixed_before_adjudication (decided where fixed)', needs: [['audit_findings', 'fixed_before_adjudication']],
    sql: `SELECT count(fixed_before_adjudication)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE remediation_state IN ('fixed','verified')` },
  { id: 'g5-stage1-prediction', label: 'learning_decisions stage1_prediction rows', needs: [['learning_decisions', 'decision_type']],
    sql: `SELECT count(*) FILTER (WHERE decision_type = 'stage1_prediction')::int AS populated,
                (SELECT count(*)::int FROM audit_findings) AS population
            FROM learning_decisions` },
  { id: 'g6-training-eligible', label: 'audit_repos.training_eligible (explicit)', needs: [['audit_repos', 'training_eligible']],
    sql: 'SELECT count(training_eligible)::int AS populated, count(*)::int AS population FROM audit_repos' },
  { id: 'g7-time-to-resolution', label: 'time_to_resolution_ms (decided findings)', needs: [['audit_findings', 'time_to_resolution_ms']],
    sql: `SELECT count(time_to_resolution_ms)::int AS populated, count(*)::int AS population
            FROM audit_findings WHERE decided_at IS NOT NULL` },
];

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); return 0; }
  assertKnownFlags(process.argv, ['--json'], { cli: 'own-model-telemetry-census' });
  const { many } = await import('./lib/db/query.mjs');
  const { closePool } = await import('./lib/db/client.mjs');
  const rows = [];
  try {
    for (const gap of CENSUS_GAPS) {
      let state;
      const missing = [];
      for (const [t, c] of gap.needs) {
        const r = await many(
          'SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2 AND table_schema = current_schema()', [t, c]);
        if (r.length === 0) missing.push(`${t}.${c}`);
      }
      if (missing.length) state = { id: gap.id, label: gap.label, unmigrated: missing };
      else {
        const [r] = await many(gap.sql);
        state = { id: gap.id, label: gap.label, populated: r.populated, population: r.population };
      }
      rows.push(state);
    }
  } finally { await closePool(); }
  if (process.argv.includes('--json')) { process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`); }
  else {
    for (const r of rows) {
      console.log(r.unmigrated
        ? `${r.id.padEnd(30)} UNMIGRATED (${r.unmigrated.join(', ')})`
        : `${r.id.padEnd(30)} ${String(r.populated).padStart(6)} / ${String(r.population).padEnd(6)} ${r.label}`);
    }
  }
  return 0;
}

if (isInvokedAsScript(import.meta.url)) {
  main().then((code) => finishAndExit(code), (err) => {
    process.stderr.write(`census: ${err.message}\n`);
    return finishAndExit(1);
  });
}
