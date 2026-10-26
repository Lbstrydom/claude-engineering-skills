/**
 * @fileoverview Which `audit_runs` row a final review persists to when the
 * caller omitted `--run-id` — and when it must persist to none.
 *
 * Extracted from `scripts/gemini-review.mjs` (which keeps re-exporting the
 * public names — test-import contract). The history behind each rule lives on
 * the function that enforces it; in one line each:
 *   - omitting `--run-id` on a cloud-enabled review is a SILENT total loss of
 *     its persistence (101 consumer runs, 2026-07-26), so it warns;
 *   - the warning was not enough, so the id is recovered from the marker the
 *     AUDIT wrote (`.audit/last-audit-run.json`), needing no agent cooperation;
 *   - plan mode never writes that marker, so it never recovers (a plan review
 *     once landed on, and its DELETE wiped, an unrelated code audit's rows);
 *   - the marker is only evidence about the LAST audit on this disk, so it is
 *     accepted only when the transcript under review names the same run.
 *
 * A wrong row is worse than no row: it looks like real evidence, and
 * `recordFinalReviewFindings`'s run-scoped DELETE destroys the rightful
 * owner's findings as a side effect.
 *
 * @module scripts/lib/final-review/run-id-recovery
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RUN_ID_RE } from '../commit-trailers.mjs';
import { GATE_EVIDENCE_RELPATH } from '../audit/gate-evidence.mjs';

/**
 * Whether this invocation is the silent-persistence-loss shape: review mode,
 * cloud on, no `--run-id`. Pure (Tier 1).
 * @param {{mode: string, runId: string|null, cloudEnabled: boolean}} args
 * @returns {boolean}
 */
export function shouldWarnMissingRunId({ mode, runId, cloudEnabled }) {
  return mode === 'review' && !runId && cloudEnabled;
}

/**
 * Whether marker-based recovery may even be ATTEMPTED. Only `code`: the marker
 * is written by the code-audit path alone (`writeGateEvidence`), so a plan
 * review that recovered would attach to whatever CODE audit's marker happened
 * to still be fresh — found live 2026-07-27, with real data loss.
 * @param {{auditMode: string}} args
 * @returns {boolean}
 */
export function canAttemptRunIdRecovery({ auditMode }) {
  return auditMode === 'code';
}

export const MISSING_RUN_ID_WARNING =
  '  [gemini-review] WARNING: cloud is enabled but no --run-id was supplied. '
  + 'This review\'s verdict and findings will NOT be persisted to audit_runs — '
  + 'they exist only in this process\'s stdout/--out file. If this is unintentional, '
  + 're-invoke with --run-id <audit_runs.id> (read _cloudRunId from the audit --out JSON).\n';

/**
 * How stale a gate-evidence marker may be and still identify THIS review's run.
 * Six hours is far beyond the real Step-7 gap while refusing yesterday's marker.
 */
export const RUN_ID_MARKER_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * The run the TRANSCRIPT says it describes: the latest round's `_cloudRunId`
 * (each round result carries its own, and build-audit-transcript embeds the
 * rounds verbatim). Null when the transcript is not JSON or names none.
 * @param {string} transcriptContent
 * @returns {string|null}
 */
export function transcriptRunIdOf(transcriptContent) {
  let t;
  try { t = JSON.parse(transcriptContent); } catch { return null; } // markdown transcript: names no run
  const rounds = Array.isArray(t?.rounds) ? t.rounds : [];
  for (let i = rounds.length - 1; i >= 0; i--) {
    const id = rounds[i]?._cloudRunId;
    if (typeof id === 'string' && RUN_ID_RE.test(id)) return id;
  }
  return null;
}

/**
 * Recover the audit run id from the gate-evidence marker.
 *
 * Syntax and freshness say the marker is a real, recent audit — not that it is
 * THE audit this review is reviewing: any later audit on the same disk (another
 * session, another sid) overwrites it. So the marker is accepted only when the
 * supplied transcript names the same run (`transcriptRunId`); a transcript that
 * names no run cannot vouch for one (`unbound`), and one naming another run
 * proves the marker is someone else's (`transcript-mismatch`).
 *
 * Pure (marker content + clock + transcript id in, decision out) — every branch
 * testable without a filesystem.
 *
 * @param {{marker: unknown, nowMs: number, transcriptRunId: string|null, maxAgeMs?: number}} args
 * @returns {{runId: string|null, reason: 'recovered'|'no-marker'|'malformed'|'stale'|'unbound'|'transcript-mismatch'}}
 */
export function recoverRunIdFromMarker({ marker, nowMs, transcriptRunId, maxAgeMs = RUN_ID_MARKER_MAX_AGE_MS }) {
  if (!marker || typeof marker !== 'object') return { runId: null, reason: 'no-marker' };
  const { runId, ts } = /** @type {{runId?: unknown, ts?: unknown}} */ (marker);
  // Same shape gate the ship-commit readers apply, so a marker this accepts can
  // never be one they reject.
  if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return { runId: null, reason: 'malformed' };
  const tsMs = typeof ts === 'string' ? Date.parse(ts) : NaN;
  if (Number.isNaN(tsMs)) return { runId: null, reason: 'malformed' };
  if (nowMs - tsMs > maxAgeMs) return { runId: null, reason: 'stale' };
  if (!transcriptRunId) return { runId: null, reason: 'unbound' };
  if (transcriptRunId !== runId) return { runId: null, reason: 'transcript-mismatch' };
  return { runId, reason: 'recovered' };
}

/** Read + parse the gate-evidence marker. Absent or unreadable → null (reported as `no-marker`). */
function readGateEvidenceMarker(repoRoot) {
  try {
    const p = resolve(repoRoot, GATE_EVIDENCE_RELPATH);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return null; // unreadable/corrupt marker: recovery reports no-marker, the warning still fires
  }
}

/**
 * The run id a review persists to: `--run-id` when given; else, on a
 * cloud-enabled code review, the transcript-bound marker id; else null, with
 * the loud warning naming why recovery was unavailable.
 *
 * @param {{cliRunId: string|null, auditMode: string, cloudEnabled: boolean, transcriptContent: string, repoRoot: string, nowMs?: number, log?: (msg: string) => void}} args
 * @returns {string|null}
 */
export function resolveReviewRunId({
  cliRunId, auditMode, cloudEnabled, transcriptContent, repoRoot,
  nowMs = Date.now(), log = (msg) => process.stderr.write(msg),
}) {
  if (!shouldWarnMissingRunId({ mode: 'review', runId: cliRunId, cloudEnabled })) return cliRunId;
  const rec = canAttemptRunIdRecovery({ auditMode })
    ? recoverRunIdFromMarker({ marker: readGateEvidenceMarker(repoRoot), nowMs, transcriptRunId: transcriptRunIdOf(transcriptContent) })
    : { runId: null, reason: 'plan-mode-has-no-marker' };
  if (rec.runId) {
    log(`  [gemini-review] no --run-id supplied; recovered ${rec.runId} from ${GATE_EVIDENCE_RELPATH} `
      + '(written by this audit, and named by the transcript). Persisting to that run.\n');
    return rec.runId;
  }
  log(MISSING_RUN_ID_WARNING);
  log(`  [gemini-review] (marker fallback also unavailable: ${rec.reason})\n`);
  return null;
}
