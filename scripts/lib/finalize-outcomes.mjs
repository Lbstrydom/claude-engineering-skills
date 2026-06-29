/**
 * @fileoverview Shared, single-source finalize for code-audit triage outcomes.
 *
 * Closes the data-loop gap deterministically: the orchestrator (openai-audit.mjs)
 * finalizes the PRIOR round's outcomes at the start of each R2+ invocation — the
 * invocation the agent already makes for R2+ suppression — so a standalone
 * `/audit-code` labels its findings without an agent-discretionary bash step.
 *
 * This is the ONE choke point shared by the orchestrator, `write-code-outcomes.mjs`
 * (manual/cloud-off-CI fallback), and `cross-skill.mjs finalize-outcomes` (/cycle).
 * Composes `recordTriageOutcomes` (cloud + marker-guarded local) + the
 * needs-triage reconciliation, so all three call sites produce identical state.
 *
 * Plan: docs/plans/deterministic-outcome-capture.md (orchestrator-only, v2).
 *
 * @module scripts/lib/finalize-outcomes
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { recordTriageOutcomes } from './outcome-sync.mjs';
import { semanticId } from './findings.mjs';
import { markRunFindingsNeedsTriage } from './store/runs-findings.mjs';

// Permissive schemas: assert only the shape finalize needs, `.passthrough()` so
// underscore annotations (`_cloudRunId`, `_outcomeCapture`, …) never break load.
const ResultSchema = z.object({ findings: z.array(z.any()) }).passthrough();
const LedgerSchema = z.object({ entries: z.array(z.any()) }).passthrough();

// Canonical `…-r<N>-result.json` filename pattern — the single regex for the
// naming convention, reused by both helpers below (no second parser elsewhere).
const RESULT_PATH_RE = /^(.*)-r(\d+)-result\.json$/;

/**
 * Parse a code-audit `--out`/`--result` path into its identity components
 * `{ sid, round }` via the single canonical regex — the authoritative source
 * for BOTH the session id and the round a result file belongs to. Used by the
 * manual CLI to derive a stable idempotency identity (and to reconcile the
 * round against `--round`/`result.round`). Non-matching path → `{null, null}`.
 *
 * @param {string|null} outPath
 * @returns {{ sid: string|null, round: number|null }}
 */
export function parseResultPath(outPath) {
  if (!outPath) return { sid: null, round: null };
  const m = path.basename(outPath).match(RESULT_PATH_RE);
  if (!m) return { sid: null, round: null };
  return { sid: m[1], round: Number.parseInt(m[2], 10) };
}

/**
 * Map a code-audit `--out` path to its prior-round result + the session id.
 * The SINGLE source of truth for the `…-r<N>-result.json` naming convention
 * (cited verbatim in skills/audit-code/SKILL.md). Fail-soft: a non-matching
 * stem, round < 2, or a filename whose embedded round disagrees with the
 * `round` argument all yield `priorResultPath: null` (orchestrator → loud WARN).
 *
 * @param {{ outPath?: string|null, round?: number }} args
 * @returns {{ priorResultPath: string|null, sid: string|null, priorRound: number|null }}
 */
export function resolveAuditArtifacts({ outPath, round } = {}) {
  const NONE = { priorResultPath: null, sid: null, priorRound: null };
  if (!outPath || !Number.isInteger(round) || round < 2) return NONE;
  // Delegate to the single path parser (one regex, one parse). A non-matching
  // stem, or a filename round disagreeing with the round argument (drifted
  // artifact identity vs runtime params), is a loud no-op upstream.
  const { sid, round: fileRound } = parseResultPath(outPath);
  if (!sid || fileRound !== round) return NONE;
  const priorRound = round - 1;
  const priorResultPath = path.join(path.dirname(outPath), `${sid}-r${priorRound}-result.json`);
  return { priorResultPath, sid, priorRound };
}

/**
 * Load + validate a result + ledger pair from disk. Tolerates a bare-array
 * ledger (wraps as `{ entries }`). Throws on a malformed result/ledger shape.
 *
 * @param {{ resultPath: string, ledgerPath: string }} args
 * @returns {{ result: object, ledger: object }}
 */
export function loadAuditInputs({ resultPath, ledgerPath }) {
  const result = ResultSchema.parse(JSON.parse(fs.readFileSync(path.resolve(resultPath), 'utf-8')));
  const ledgerRaw = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf-8'));
  const ledger = LedgerSchema.parse(Array.isArray(ledgerRaw) ? { entries: ledgerRaw } : ledgerRaw);
  return { result, ledger };
}

/**
 * Finalize one round's triage outcomes. Cloud is the transactionally-idempotent
 * SSoT (recordAdjudicationEvent = scoped delete+insert in withTx); the local
 * `.audit/outcomes.jsonl` append is marker-guarded by `key = _cloudRunId ?? sid`.
 *
 * @param {{ result: object, ledger: object, round: number, store: object|null, sid?: string|null }} args
 * @returns {Promise<{ round: number, labelled: number, total: number, cloudOk: boolean, skippedLocal: boolean, needsTriage: number }>}
 */
export async function finalizeRoundOutcomes({ result, ledger, round, store, sid = null }) {
  const findings = Array.isArray(result?.findings) ? result.findings : [];
  const cloudRunId = result?._cloudRunId || null;
  const idempotencyKey = (cloudRunId || sid) ? `${cloudRunId || sid}:${round}` : null;

  const { enriched, cloudOk, localSkipped } = await recordTriageOutcomes(
    store, cloudRunId, findings, ledger, { round, idempotencyKey },
  );

  // Reconciliation: findings the ledger never ruled on stay `pending` — flag
  // them needs_triage (cloud only, non-destructive) so a truncated ledger can't
  // silently dark-drop a finding. Mirrors cross-skill finalize-outcomes.
  let needsTriage = 0;
  if (store && cloudRunId) {
    const pendingFps = enriched
      .filter(f => f.adjudicationOutcome === 'pending')
      .map(f => f._hash || semanticId(f))
      .filter(Boolean);
    if (pendingFps.length > 0) {
      try {
        const res = await markRunFindingsNeedsTriage(cloudRunId, pendingFps);
        needsTriage = res?.updated ?? 0;
      } catch (err) {
        process.stderr.write(`  [finalize] needs-triage reconcile failed: ${err.message}\n`);
      }
    }
  }

  const labelled = enriched.filter(f => f.adjudicationOutcome !== 'pending').length;
  return {
    round,
    labelled,
    total: findings.length,
    cloudOk,
    skippedLocal: Boolean(localSkipped),
    needsTriage,
    enriched,
  };
}
