/**
 * @fileoverview Phase 5 — cheap-triager validation session tooling for the
 * tiered-recall audit pipeline. Runs a candidate cheap model (GLM / Gemini
 * Flash / Haiku) as triager over the existing 2,314-row blind-adjudication
 * experiment sheet, then builds a CONTRARIAN STRATIFIED worksheet: rows
 * where the candidate disagrees with the two-judge consensus, unioned with
 * every known-defect-linked row, every HIGH dismissal, every (best-effort
 * retrofit-labeled) omission-type dismissal, plus a random tail.
 *
 * Plan: docs/plans/tiered-recall-audit-pipeline.md Phase 5 (gates Phase 7's
 * Stage 1 model choice via the freshness-checked manifest this module emits).
 *
 * **Purity boundary** (Tier-1 unit-test doctrine, mirrors evidence-triage.mjs):
 * parsing, consensus, stratification, and the validation manifold are all
 * PURE — no I/O, no LLM calls, no `Date.now()`. Only `runCandidateTriage` and
 * the CLI `main()` touch the network/filesystem, and both take injectable
 * adapters so orchestration is testable without a live model call.
 *
 * **Human-grading boundary (load-bearing — do not bypass)**: this module
 * builds the worksheet and the candidate's OWN triage verdicts (a real, cheap
 * model call — legitimate to run). It does NOT fabricate the human-graded
 * ground truth `computeValidationManifest` needs (`falseDismissalRate` is
 * only meaningful once a human has graded the sampled worksheet rows). The
 * CLI's `main()` stops after writing the worksheet; producing the final
 * `cheap-triager-validation.json` manifest is a separate, explicit step run
 * AFTER a human grading session, never invoked automatically.
 *
 * @module scripts/lib/solo-control/cheap-triager-validate
 */

import crypto from 'node:crypto';
import { LABEL_FACTORS } from './scoring.mjs';

// ── CSV parsing (no shared parser exists in this codebase — see Phase 5
// research; the two existing inline parsers in solo-control-audit.mjs don't
// handle escaped `""` quotes, and this dataset's `detail`/`proof` columns
// carry both embedded commas AND quotes, so a correct RFC4180-style parser
// is written here rather than reused) ──────────────────────────────────────

const CSV_COLUMNS = ['blind_id', 'commit', 'severity', 'category', 'file', 'detail', 'label', 'proof', 'cluster', 'matches', 'pattern'];

/** Parse one CSV record (may span multiple physical lines if a field is
 * quoted and contains embedded newlines) starting at `text[start]`. Returns
 * `{fields, nextIndex, unterminatedQuote, malformedQuote}` — `nextIndex`
 * points just past the record's terminating newline (or `text.length` at
 * EOF). `unterminatedQuote` is `true` when EOF was reached while still
 * inside a quoted field (audit fix H5/M8 — the original version silently
 * absorbed the rest of the file into one field instead of surfacing the
 * malformed record). `malformedQuote` is `true` when a `"` appears AFTER a
 * field has already started accumulating unquoted content (audit fix M5,
 * round 2 — a stray mid-field quote like `abc"def` previously flipped into
 * quote-mode silently, deleting the quote character and merging what should
 * be a rejected record into a plausible-looking field; RFC4180 requires a
 * field be either fully quoted or fully unquoted, so `"` is only legal at
 * the very start of a field). */
function parseCsvRecord(text, start) {
  const fields = [];
  let field = '';
  let inQuotes = false;
  let i = start;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } // escaped quote
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') {
      if (field !== '') return { fields, nextIndex: i, unterminatedQuote: false, malformedQuote: true };
      inQuotes = true;
      continue;
    }
    if (c === ',') { fields.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { fields.push(field); return { fields, nextIndex: i + 1, unterminatedQuote: false, malformedQuote: false }; }
    field += c;
  }
  fields.push(field);
  return { fields, nextIndex: i, unterminatedQuote: inQuotes, malformedQuote: false };
}

/**
 * Parse a full blind-adjudication CSV (header + data rows) into row objects
 * keyed by `CSV_COLUMNS`. Skips a trailing blank line at EOF.
 *
 * Fails loud (audit fix H4/M7) rather than silently accepting drift: the
 * header row must match `CSV_COLUMNS` exactly (name AND order) — a reordered
 * or renamed spreadsheet export would otherwise map fields positionally into
 * the wrong semantic column with no signal anything went wrong. Also fails
 * loud on: a record left unterminated inside a quoted field at EOF (audit fix
 * H5/M8); a stray mid-field quote (audit fix M5, round 2); and — every DATA
 * row's field count not matching `CSV_COLUMNS.length` (audit fix H2, round 2
 * — the original version filled a short row's missing trailing columns with
 * `''` and silently dropped a long row's extra columns, either of which lets
 * a single unquoted stray comma or a truncated export shift every subsequent
 * column into the wrong semantic field with no signal anything went wrong).
 *
 * @param {string} csvText
 * @returns {Array<Record<string,string>>}
 * @throws {Error} if the header row doesn't match CSV_COLUMNS, a record's
 *   quoted field is never closed before EOF, a stray mid-field quote is
 *   found, or a data row's field count doesn't match CSV_COLUMNS.length
 */
export function parseBlindCsv(csvText) {
  if (!csvText) return [];
  const rows = [];
  let idx = 0;
  let isHeader = true;
  let rowNum = 0;
  while (idx < csvText.length) {
    const { fields, nextIndex, unterminatedQuote, malformedQuote } = parseCsvRecord(csvText, idx);
    idx = nextIndex;
    if (fields.length === 1 && fields[0] === '' && !malformedQuote) continue; // blank line
    if (unterminatedQuote) {
      throw new Error(`parseBlindCsv: unterminated quoted field at char offset ${idx} — malformed CSV`);
    }
    if (malformedQuote) {
      throw new Error(`parseBlindCsv: stray quote mid-field at char offset ${idx} (row ${rowNum}) — malformed CSV`);
    }
    rowNum++;
    if (isHeader) {
      isHeader = false;
      const mismatch = fields.length !== CSV_COLUMNS.length || fields.some((f, i) => f !== CSV_COLUMNS[i]);
      if (mismatch) {
        throw new Error(`parseBlindCsv: header mismatch — expected [${CSV_COLUMNS.join(',')}], got [${fields.join(',')}]`);
      }
      continue;
    }
    if (fields.length !== CSV_COLUMNS.length) {
      throw new Error(`parseBlindCsv: row ${rowNum} has ${fields.length} fields, expected ${CSV_COLUMNS.length} — malformed CSV`);
    }
    const row = {};
    CSV_COLUMNS.forEach((col, i) => { row[col] = fields[i]; });
    rows.push(row);
  }
  return rows;
}

// ── Two-judge consensus ─────────────────────────────────────────────────

/** `proven`/`actionable` (LABEL_FACTORS > 0) → 'valid'; `plausible`/`false` →
 * 'dismissed'; anything NOT a recognized key of `LABEL_FACTORS` (unknown,
 * misspelled, whitespace-padded) → `null` (audit fix H3 — the original
 * version computed `LABEL_FACTORS[label] > 0`, so an unrecognized label
 * silently evaluated `undefined > 0 === false` and was misclassified as a
 * confident 'dismissed' verdict rather than flagged as bad data). */
function labelTier(label) {
  if (!Object.prototype.hasOwnProperty.call(LABEL_FACTORS, label)) return null;
  return LABEL_FACTORS[label] > 0 ? 'valid' : 'dismissed';
}

/**
 * Join the two independently-graded sheets (Claude Fable-5 + GPT-5.5) by
 * `blind_id` into a per-row consensus tier. No prior code in this repo
 * reconciles these two files — this is the first joiner (Phase 5 research).
 *
 * Fails loud on a duplicate `blind_id` in EITHER sheet (audit fix M3, round 1
 * + H3, round 2 — the round-1 fix only guarded `gptRows`; the original
 * `new Map(gptRows.map(...))` pattern's silent-last-write-wins failure mode
 * applied equally to `claudeRows` via `consensus.set(cRow.blind_id, ...)`,
 * which the round-1 fix left unguarded). A row with an unrecognized label on
 * either side (`labelTier` returns `null`) is excluded from consensus, same
 * as a missing GPT row — never defaulted into a tier, but now also reported
 * via a stderr warning (audit fix M4, round 2 — silently `continue`-ing bad
 * human-grading data with no caller-visible signal made it invisible that
 * the sheet itself needs a corrected label, not just a skip).
 *
 * @param {Array<Record<string,string>>} claudeRows
 * @param {Array<Record<string,string>>} gptRows
 * @returns {Map<string, {claudeTier: 'valid'|'dismissed', gptTier: 'valid'|'dismissed', consensusTier: 'valid'|'dismissed'|'no-consensus'}>}
 * @throws {Error} if either sheet contains a duplicate `blind_id`
 */
export function computeTwoJudgeConsensus(claudeRows, gptRows) {
  const dedupe = (rows, sheetName) => {
    const byBlindId = new Map();
    for (const r of rows) {
      if (byBlindId.has(r.blind_id)) {
        throw new Error(`computeTwoJudgeConsensus: duplicate blind_id "${r.blind_id}" in ${sheetName}-graded sheet — refusing to silently pick one`);
      }
      byBlindId.set(r.blind_id, r);
    }
    return byBlindId;
  };
  const claudeByBlindId = dedupe(claudeRows, 'Claude');
  const gptByBlindId = dedupe(gptRows, 'GPT');

  const consensus = new Map();
  for (const [blindId, cRow] of claudeByBlindId) {
    const gRow = gptByBlindId.get(blindId);
    if (!gRow) continue; // no GPT grading yet for this row — excluded, not defaulted
    const claudeTier = labelTier(cRow.label);
    const gptTier = labelTier(gRow.label);
    if (claudeTier === null || gptTier === null) {
      process.stderr.write(`  [cheap-triager-validate] Skipping ${blindId}: unrecognized label (claude="${cRow.label}", gpt="${gRow.label}")\n`);
      continue; // unrecognized label on either side — excluded, not defaulted
    }
    consensus.set(blindId, {
      claudeTier, gptTier,
      consensusTier: claudeTier === gptTier ? claudeTier : 'no-consensus',
    });
  }
  return consensus;
}

// ── Best-effort omission retrofit (the dataset predates evidenceType —
// see Phase 5 research; this is a heuristic signal, not ground truth) ─────

const OMISSION_SIGNAL = /\b(missing|does not|doesn'?t|lacks?|no\s+\w+\s+check|not\s+(invalidat|validat|check|verif|revert|rollback|clean\s*up)|never\s+(invalidat|check|verif)|fails?\s+to)\b/i;

/**
 * Best-effort retrofit label for `evidenceType` from free-text `category` +
 * `detail` — this dataset predates the `evidenceType` schema field (Phase
 * 1/2), so there is no ground truth here; this heuristic is a SAMPLING
 * signal only (widen the omission-dismissal stratum), never treated as an
 * authoritative label.
 *
 * Binary by design (audit fix M4 — a prior draft of this JSDoc claimed an
 * `'unknown'` return value the implementation never produced): absence of an
 * omission signal is treated as `'commission'`, the majority class in this
 * dataset, not as a separate "no signal" state — this function is a
 * SAMPLING weight, not a classifier with a confidence threshold, so a
 * three-way split would imply a precision this heuristic doesn't have.
 *
 * @param {{category?: string, detail?: string}} row
 * @returns {'omission'|'commission'}
 */
export function retrofitEvidenceType(row) {
  const text = `${row.category || ''} ${row.detail || ''}`;
  return OMISSION_SIGNAL.test(text) ? 'omission' : 'commission';
}

// ── Seeded sampling (reuses the same mulberry32 generator family as
// stratified-sample.mjs / audit-shadow.mjs, for cross-module reproducibility) ─

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffleCopy(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Contrarian stratified worksheet ─────────────────────────────────────

/**
 * Build the contrarian stratified worksheet — the union of:
 *   (a) contrarian    — candidate's tier disagrees with the two-judge consensusTier
 *                        (rows with consensusTier 'no-consensus' are excluded from
 *                        this stratum — there is no consensus to disagree with)
 *   (b) known-defect  — row's `matches` column cites a known-defect id (the CSV's
 *                        `matches` column already carries the precomputed KD hint;
 *                        see Phase 5 research — re-matching via matchesKnownDefect
 *                        would silently fail here since its commit-equality check
 *                        expects a full sha and this sheet's `commit` is truncated)
 *   (c) high-dismissal — severity HIGH and consensusTier 'dismissed'
 *   (d) omission-dismissal — retrofitEvidenceType === 'omission' and consensusTier 'dismissed'
 *   (e) random-tail   — a seeded random sample of everything else, up to `tailSize`
 *
 * Every row appears in the worksheet at most once (first-matching-stratum wins,
 * in the (a)-(e) order above) — `strata[].count` reports the row count landed in
 * each bucket AFTER dedup, so the counts partition the worksheet exactly.
 *
 * @param {Array<Record<string,string>>} rows - parsed blind-adjudication rows
 * @param {Map<string,{consensusTier:string}>} consensusByBlindId
 * @param {Map<string,'valid'|'dismissed'>} candidateTierByBlindId - candidate triager's own verdict per row
 * @param {{tailSize?: number, seed: number}} opts
 * @returns {{worksheetRows: Array<object>, strata: Array<{name:string, count:number}>}}
 */
export function buildContrarianStratifiedWorksheet(rows, consensusByBlindId, candidateTierByBlindId, { tailSize = 100, seed }) {
  const seen = new Set();
  const strataBuckets = { contrarian: [], 'known-defect': [], 'high-dismissal': [], 'omission-dismissal': [] };
  const remainder = [];

  for (const row of rows) {
    const consensus = consensusByBlindId.get(row.blind_id);
    const candidateTier = candidateTierByBlindId.get(row.blind_id);
    const consensusTier = consensus?.consensusTier;

    if (candidateTier && consensusTier && consensusTier !== 'no-consensus' && candidateTier !== consensusTier) {
      strataBuckets.contrarian.push(row);
    } else if (row.matches && /^KD-\d+/.test(row.matches)) {
      strataBuckets['known-defect'].push(row);
    } else if (String(row.severity).toUpperCase() === 'HIGH' && consensusTier === 'dismissed') {
      strataBuckets['high-dismissal'].push(row);
    } else if (retrofitEvidenceType(row) === 'omission' && consensusTier === 'dismissed') {
      strataBuckets['omission-dismissal'].push(row);
    } else {
      remainder.push(row);
    }
  }

  const worksheetRows = [];
  const strata = [];
  for (const name of ['contrarian', 'known-defect', 'high-dismissal', 'omission-dismissal']) {
    const bucket = strataBuckets[name];
    let count = 0;
    for (const row of bucket) {
      if (seen.has(row.blind_id)) continue;
      seen.add(row.blind_id);
      worksheetRows.push({ ...row, stratum: name });
      count++;
    }
    strata.push({ name, count });
  }

  const rng = mulberry32(seed >>> 0);
  const tailPicked = seededShuffleCopy(remainder, rng).slice(0, Math.max(0, tailSize));
  let tailCount = 0;
  for (const row of tailPicked) {
    if (seen.has(row.blind_id)) continue;
    seen.add(row.blind_id);
    worksheetRows.push({ ...row, stratum: 'random-tail' });
    tailCount++;
  }
  strata.push({ name: 'random-tail', count: tailCount });

  return { worksheetRows, strata };
}

// ── Validation manifest (requires human-graded worksheet input — see the
// module-level "Human-grading boundary" note; never called with fabricated data) ──

/** Wilson score interval for a binomial proportion — no shared CI helper
 * exists for a plain (non-inverse-probability-weighted) proportion in this
 * codebase (scoring.mjs's `bootstrapCI` is Horvitz-Thompson-specific and not
 * exported); this is the standard closed-form alternative to a bootstrap
 * when there's no sampling-weight correction to make. */
export function wilsonScoreInterval(successes, total, z = 1.96) {
  if (!(total > 0)) return [null, null];
  const p = successes / total;
  const denom = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return [+Math.max(0, (center - margin) / denom).toFixed(4), +Math.min(1, (center + margin) / denom).toFixed(4)];
}

/**
 * Assemble the final `cheap-triager-validation.json` manifest per the plan's
 * §Phase-5 machine-readable-manifest spec. `gradedStrata` must carry a HUMAN
 * verdict per row (`humanFalseDismissal: boolean`) — this function does not
 * fabricate that input; it is a pure aggregator over already-graded data.
 *
 * @param {Array<{name: string, gradedRows: Array<{humanFalseDismissal: boolean}>}>} gradedStrata
 * @param {{candidateModel: string, datasetHash: string, generatedAt: string,
 *   thresholds?: {highOrOmissionMaxFalseDismissalRate?: number, overallMaxFalseDismissalRate?: number}}} opts
 */
export function computeValidationManifest(gradedStrata, { candidateModel, datasetHash, generatedAt, thresholds = {} } = {}) {
  const resolvedThresholds = {
    highOrOmissionMaxFalseDismissalRate: thresholds.highOrOmissionMaxFalseDismissalRate ?? 0.05,
    overallMaxFalseDismissalRate: thresholds.overallMaxFalseDismissalRate ?? 0.10,
  };
  const strata = gradedStrata.map((s) => {
    const total = s.gradedRows.length;
    const falseCount = s.gradedRows.filter((r) => r.humanFalseDismissal).length;
    const falseDismissalRate = total > 0 ? +(falseCount / total).toFixed(4) : null;
    const ci95 = wilsonScoreInterval(falseCount, total);
    return { name: s.name, count: total, falseDismissalRate, ci95 };
  });

  const loadBearing = strata.filter((s) => s.name === 'high-dismissal' || s.name === 'omission-dismissal');
  const allGraded = gradedStrata.flatMap((s) => s.gradedRows);
  const overallFalseRate = allGraded.length > 0 ? allGraded.filter((r) => r.humanFalseDismissal).length / allGraded.length : null;

  const loadBearingOk = loadBearing.every((s) => s.falseDismissalRate == null || s.falseDismissalRate <= resolvedThresholds.highOrOmissionMaxFalseDismissalRate);
  const overallOk = overallFalseRate == null || overallFalseRate <= resolvedThresholds.overallMaxFalseDismissalRate;

  return {
    datasetHash, candidateModel, strata,
    thresholds: resolvedThresholds,
    passed: loadBearingOk && overallOk,
    generatedAt,
  };
}

/** Render the human-readable companion doc FROM the manifest (never the
 * primary artifact — see plan §Phase-5 generated-artifact-policy note). */
export function renderValidationMarkdown(manifest) {
  const lines = [
    '# Cheap-Triager Validation',
    '',
    `- Candidate model: \`${manifest.candidateModel}\``,
    `- Dataset hash: \`${manifest.datasetHash}\``,
    `- Generated: ${manifest.generatedAt}`,
    `- **Result: ${manifest.passed ? 'PASSED' : 'FAILED'}**`,
    '',
    '| Stratum | Count | False-dismissal rate | 95% CI |',
    '|---|---|---|---|',
  ];
  for (const s of manifest.strata) {
    const rate = s.falseDismissalRate == null ? 'n/a' : `${(s.falseDismissalRate * 100).toFixed(1)}%`;
    const ci = s.ci95[0] == null ? 'n/a' : `[${(s.ci95[0] * 100).toFixed(1)}%, ${(s.ci95[1] * 100).toFixed(1)}%]`;
    lines.push(`| ${s.name} | ${s.count} | ${rate} | ${ci} |`);
  }
  lines.push('', `Thresholds: HIGH/omission ≤ ${(manifest.thresholds.highOrOmissionMaxFalseDismissalRate * 100).toFixed(0)}%, overall ≤ ${(manifest.thresholds.overallMaxFalseDismissalRate * 100).toFixed(0)}%.`);
  return lines.join('\n');
}

// ── Dataset hash (freshness check consumed by Phase 7) ─────────────────

/** sha256 over the blind-adjudication CSV + blind-map JSON content — Phase 7
 * compares this against a freshly-computed hash before trusting `passed`. */
export function computeDatasetHash(claudeCsvText, blindMapText) {
  return crypto.createHash('sha256').update(claudeCsvText).update(blindMapText).digest('hex');
}

// ── Candidate triage orchestration (I/O — injectable adapter, no live call
// in tests; mirrors evidence-triage.mjs's adapters pattern) ────────────────

/**
 * Run the candidate cheap model as triager over every row, via an injected
 * `callAdapter` (production wraps `ossStructuredCall`/`createAnthropicClient`
 * per the `AUDIT_DISCOVERY_MODEL`-style config; tests inject a stub). Returns
 * a `blind_id -> 'valid'|'dismissed'` map — never throws on a single-row
 * failure; a failed row is simply omitted (absent from the map), so it can
 * never contribute a false contrarian/consensus signal.
 *
 * @param {Array<Record<string,string>>} rows
 * @param {{callAdapter: (row: Record<string,string>) => Promise<'valid'|'dismissed'|null>}} adapters
 * @returns {Promise<Map<string,'valid'|'dismissed'>>}
 */
export async function runCandidateTriage(rows, { callAdapter }) {
  const result = new Map();
  for (const row of rows) {
    let verdict;
    try {
      verdict = await callAdapter(row);
    } catch {
      verdict = null;
    }
    if (verdict === 'valid' || verdict === 'dismissed') result.set(row.blind_id, verdict);
  }
  return result;
}
