/**
 * @fileoverview Assemble the final-review transcript from a session's round
 * artifacts — the input `gemini-review.mjs review <plan> <transcript>` reads.
 *
 * Why this module exists (field report, 2026-08-08): both `/audit-plan` Step 6
 * and `/audit-code` Step 7 are MANDATORY and both open with a bare
 * `gemini-review.mjs review … .audit/$SID-transcript.json`, but no earlier step
 * in either skill produced that file. Followed literally, the gate died with
 * `File not found`, and the operator hand-assembled a JSON shape inferred from
 * `references/gemini-gate.md` — i.e. the one MANDATORY gate in the chain was
 * blocked on undocumented, hand-rolled state.
 *
 * `audit-loop.mjs` (the automated orchestrator) had been building the transcript
 * inline all along. This module is that logic, lifted out so the orchestrator
 * and the skill-driven CLI (`scripts/build-audit-transcript.mjs`) produce the
 * SAME artifact — a second assembler would drift from the reviewer's contract
 * exactly the way a hand-rolled one already did.
 *
 * Pure — no I/O beyond the explicit `readRoundResult` reader — so the shape is
 * unit-testable without a filesystem.
 *
 * @module scripts/lib/audit/transcript
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseResultPath } from '../finalize-outcomes.mjs';

/**
 * Modes `gemini-review.mjs --mode` accepts. A plan transcript must carry NO
 * code files: the reviewer's own prompt keys "plan audit" off their absence
 * ("no code files, only plan text"), so a stray `code_files` entry flips the
 * gate into judging a not-yet-built plan as if it were shipped code.
 */
export const AUDIT_MODES = Object.freeze(['plan', 'code']);

const NOTE =
  'Transcript assembled from the session round results. code_files are re-read '
  + 'from the working tree by the reviewer, so they reflect post-fix state.';

/**
 * Infer the audit mode from a session id when `--mode` was not given.
 * The skills mint `SID=audit-plan-<epoch>` / `audit-code-<epoch>`, so the
 * prefix is authoritative in the documented flow. Anything else → null
 * (the caller decides; it must never silently guess `code` for a plan).
 *
 * @param {string|null|undefined} sid
 * @returns {'plan'|'code'|null}
 */
export function inferAuditMode(sid) {
  if (typeof sid !== 'string') return null;
  if (sid.startsWith('audit-plan-')) return 'plan';
  if (sid.startsWith('audit-code-')) return 'code';
  return null;
}

/**
 * Find a session's round-result artifacts in `dir`, ascending by round.
 * Keyed on the canonical `<sid>-r<N>-result.json` convention via the single
 * shared parser (`parseResultPath`) — no second regex for the naming rule.
 *
 * @param {{sid: string, dir?: string}} args
 * @returns {Array<{path: string, round: number}>}
 */
export function discoverRoundResults({ sid, dir = '.audit' }) {
  if (!sid) throw new TypeError('discoverRoundResults: sid is required');
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of entries) {
    const { sid: fileSid, round } = parseResultPath(name);
    if (fileSid !== sid || round === null) continue;
    out.push({ path: path.join(dir, name), round });
  }
  return out.sort((a, b) => a.round - b.round);
}

/**
 * Read + parse one round result, stamping the round number parsed from its
 * filename. A malformed artifact throws — a silently-skipped round would send
 * the final reviewer a transcript that looks complete and is not.
 *
 * @param {string} resultPath
 * @returns {object} the parsed result with `round` populated
 */
export function readRoundResult(resultPath) {
  const raw = fs.readFileSync(path.resolve(resultPath), 'utf-8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${resultPath}: not valid JSON (${err.message})`);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.findings)) {
    throw new Error(`${resultPath}: not an audit result (no "findings" array)`);
  }
  const { round } = parseResultPath(resultPath);
  return { round: parsed.round ?? round ?? null, ...parsed };
}

/**
 * Render adjudicated ledger entries as the `claude_resolutions` trail — how
 * each finding was ruled and what happened to it. Non-structural for the
 * reviewer, but it is the difference between "here are the findings" and
 * "here is the deliberation", and it is already on disk.
 *
 * Entries with no ruling yet (pending triage) are skipped rather than rendered
 * as resolved.
 *
 * @param {object|Array|null} ledger — ledger object, its `entries` array, or null
 * @returns {string[]}
 */
export function ledgerResolutions(ledger) {
  if (!ledger) return [];
  const entries = Array.isArray(ledger) ? ledger : Array.isArray(ledger.entries) ? ledger.entries : [];
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const outcome = e.adjudicationOutcome;
    if (!outcome || outcome === 'pending') continue;
    const id = e.latestFindingId || e.findingId || e.topicId || '(unknown)';
    const round = Number.isInteger(e.resolvedRound) ? `R${e.resolvedRound} ` : '';
    const state = e.remediationState ? `/${e.remediationState}` : '';
    const ruling = e.ruling ? ` (${e.ruling})` : '';
    const why = e.rulingRationale ? ` — ${e.rulingRationale}` : '';
    out.push(`${round}${id} [${e.severity || '?'}] ${outcome}${state}${ruling}${why}`);
  }
  return out;
}

/**
 * Build the transcript object.
 *
 * Structurally load-bearing for `runFinalReview()`: `code_files` (paths it
 * re-reads from the working tree) and `changed_files` (the scope filter that
 * suppresses out-of-scope new findings). Everything else is dumped verbatim
 * into the prompt, so extra keys are safe and missing ones are not.
 *
 * @param {object} args
 * @param {object[]} args.rounds — parsed round results, ascending
 * @param {'plan'|'code'} args.auditMode
 * @param {string[]} [args.changedFiles] — the `--changed` set from the R1 audit
 * @param {string[]|null} [args.codeFiles] — override; default = union over rounds
 * @param {object|Array|null} [args.ledger] — adjudication ledger for the resolutions trail
 * @param {string|null} [args.summary]
 * @returns {object}
 */
export function buildAuditTranscript({
  rounds, auditMode, changedFiles = [], codeFiles = null, ledger = null, summary = null,
}) {
  if (!Array.isArray(rounds) || rounds.length === 0) {
    throw new Error('buildAuditTranscript: at least one round result is required');
  }
  if (!AUDIT_MODES.includes(auditMode)) {
    throw new Error(`buildAuditTranscript: auditMode must be one of ${AUDIT_MODES.join('|')}`);
  }
  const isPlan = auditMode === 'plan';
  // A plan audit has no code under review. Forcing the lists empty (rather than
  // trusting the caller) keeps the reviewer's plan/code discriminator honest.
  const resolvedCodeFiles = isPlan
    ? []
    : codeFiles ?? [...new Set(rounds.flatMap(r => (Array.isArray(r.code_files) ? r.code_files : [])))];
  const resolvedChanged = isPlan ? [] : [...new Set(changedFiles.filter(Boolean))];

  const transcript = {
    audit_mode: auditMode,
    rounds,
    code_files: resolvedCodeFiles,
    changed_files: resolvedChanged,
    _note: NOTE,
  };
  const resolutions = ledgerResolutions(ledger);
  if (resolutions.length > 0) transcript.claude_resolutions = resolutions;
  if (summary) transcript.summary = summary;
  return transcript;
}
