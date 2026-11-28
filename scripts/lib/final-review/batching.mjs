/**
 * @fileoverview `gemini-review.mjs review --batch`: a diff too large for one
 * envelope is reviewed as DISJOINT batches, one reviewer call each, and the
 * results are folded into ONE verdict.
 *
 * WHY (measured 2026-11-15, ai-organiser `/cycle --autonomous`): a large diff
 * got `Code: PARTIAL` from a single envelope, and the operator had to split it
 * by hand into 8 groups following `round-cap-and-structural-card.md`
 * §PARTIAL final-gate coverage. That procedure's completeness check (forward,
 * backward, pairwise disjoint, all from the diff) was prose for an agent to
 * carry out, and the doc records the time it was carried out wrong: a changed
 * file sat in no batch. Here it is code.
 *
 * Nothing about HOW a batch is reviewed is new. Each batch is the caller's own
 * transcript with `changed_files` narrowed, and it goes through the same review
 * path (envelope, tiered render, coverage gate, scope filter, disposition). The
 * packing budget is the renderer's own `FULL_CODE_MAX_CHARS`, a file costing at
 * most the per-file cap the renderer gives a changed file, so a batch is sized
 * to what one envelope can actually show. Each batch's coverage is still
 * MEASURED by the review rather than assumed from the packing.
 *
 * The fold re-runs `computeGateDisposition` over the combined result, so the
 * combined disposition is derived exactly as a single review's is: one blocked
 * batch blocks the whole review, and a batch with zero coverage still downgrades.
 *
 * @module scripts/lib/final-review/batching
 */

import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { CHANGED_FILE_MAX_PER_FILE, FULL_CODE_MAX_CHARS } from './code-render.mjs';
import { COVERAGE_STATES } from './code-coverage.mjs';

const defaultSizeOf = (p) => { try { return statSync(p).size; } catch { return 0; } };

/**
 * Path IDENTITY for planning and the completeness check: the path EXACTLY as git reported it. Not `normalizePath`, whose
 * lowercasing is a Windows matching key: on a case-sensitive checkout `A.mjs` and `a.mjs` are two changed files, and
 * folding them would drop one from every batch while the check, using the same fold, still reported the partition whole.
 * Separators are not folded either: git emits `/`, and on POSIX a backslash is a legal filename character.
 */
const pathKey = (p) => p;

/**
 * Pack the changed files into disjoint batches, in diff order (first fit).
 * A file costs `min(size, perFileCap)`. A file bigger than the cap is rendered
 * as hunk windows anyway, so its cost is bounded. One file never splits.
 *
 * @param {string[]} changedFiles
 * @param {{sizeOf?: (p: string) => number, budget?: number, perFileCap?: number}} [opts]
 * @returns {string[][]}
 */
export function planDisjointBatches(changedFiles, { sizeOf = defaultSizeOf, budget = FULL_CODE_MAX_CHARS, perFileCap = CHANGED_FILE_MAX_PER_FILE } = {}) {
  const seen = new Set();
  const files = (Array.isArray(changedFiles) ? changedFiles : [])
    .filter((p) => typeof p === 'string' && p.length > 0)
    .filter((p) => { const k = pathKey(p); if (seen.has(k)) return false; seen.add(k); return true; });
  const batches = [];
  for (const file of files) {
    // No `| 0`: it wraps a size over 2 GiB to a negative number, which would then be charged nothing.
    const size = Number(sizeOf(file));
    const cost = Math.min(Number.isFinite(size) && size > 0 ? size : 0, perFileCap);
    const open = batches.find((b) => b.used + cost <= budget);
    if (open) { open.files.push(file); open.used += cost; } else batches.push({ files: [file], used: cost });
  }
  return batches.map((b) => b.files);
}

/**
 * The completeness check from `round-cap-and-structural-card.md`, mechanically:
 * forward (every changed file in a batch), backward (every batch member is a
 * changed file) and pairwise disjoint. Paths compare by `pathKey` (case kept).
 *
 * @param {string[][]} batches
 * @param {string[]} changedFiles - the diff's file set
 * @returns {{ok: boolean, missing: string[], extra: string[], duplicated: string[]}}
 */
export function checkBatchCompleteness(batches, changedFiles) {
  const changed = new Map((changedFiles || []).map((p) => [pathKey(p), p]));
  const counts = new Map();
  const extra = [];
  for (const batch of batches || []) {
    for (const p of batch) {
      const k = pathKey(p);
      counts.set(k, (counts.get(k) || 0) + 1);
      if (!changed.has(k)) extra.push(p);
    }
  }
  const missing = [...changed].filter(([k]) => !counts.has(k)).map(([, p]) => p);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([k]) => changed.get(k) ?? k);
  return { ok: missing.length === 0 && extra.length === 0 && duplicated.length === 0, missing, extra, duplicated };
}

/**
 * Plan the batches for a transcript. Returns null when batching does not apply
 * (not JSON, no declared `changed_files`, or everything fits one envelope), so
 * the caller runs the ordinary single review unchanged.
 * Throws when the plan fails its own completeness check (a planner bug must stop
 * the run, never review a subset under a FULL claim).
 *
 * @param {string} transcriptContent
 * @param {object} [opts] - forwarded to planDisjointBatches
 * @returns {null | {batches: string[][], transcripts: string[]}}
 */
export function planTranscriptBatches(transcriptContent, opts = {}) {
  let transcript;
  try { transcript = JSON.parse(transcriptContent); } catch { return null; }
  const changed = Array.isArray(transcript?.changed_files) ? transcript.changed_files : [];
  if (changed.length === 0) return null;
  const batches = planDisjointBatches(changed, opts);
  const check = checkBatchCompleteness(batches, changed);
  if (!check.ok) {
    throw new Error(`[final-review] batch plan is incomplete: missing ${check.missing.join(', ') || 'none'}; `
      + `extra ${check.extra.join(', ') || 'none'}; duplicated ${check.duplicated.join(', ') || 'none'}`);
  }
  if (batches.length <= 1) return null;
  return {
    batches,
    transcripts: batches.map((files) => JSON.stringify({ ...transcript, changed_files: files })),
  };
}

const VERDICT_RANK = ['APPROVE', 'CONCERNS', 'CONCERNS_REMAINING', 'REJECT'];
const COHERENCE_RANK = ['Strong', 'Adequate', 'Weak'];
// An UNRANKED value outranks every known one, so a batch's malformed verdict survives the fold and the gate blocks on it.
const rankOf = (rank, v) => (rank.includes(v) ? rank.indexOf(v) : Infinity);
const worst = (rank, values) => values.reduce((w, v) => (rankOf(rank, v) > rankOf(rank, w) ? v : w), values[0]);
const sumOrNull = (vals) => (vals.some((v) => v === null || v === undefined) ? null : vals.reduce((a, b) => a + b, 0));

/**
 * Fold per-batch code coverage: the WEAKEST state wins and the gaps concatenate. A batch whose every file was a confirmed
 * deletion measured nothing and carries no state (it reads `unknown` alone); it would otherwise sink a fully-shown change
 * to `unknown`. Every batch deletion-only ⇒ `unknown`, as a single review reports it.
 */
export function mergeBatchCoverage(coverages) {
  const covs = coverages.filter(Boolean);
  if (covs.length !== coverages.length || covs.length === 0) return { state: 'unknown', reason: 'a batch reported no coverage record', batches: coverages.length };
  const cat = (k) => covs.flatMap((c) => (Array.isArray(c[k]) ? c[k] : []));
  const deletionOnly = (c) => c.changedRequested > 0 && Array.isArray(c.changedDeleted) && c.changedDeleted.length === c.changedRequested;
  const measured = covs.filter((c) => !deletionOnly(c));
  return {
    state: measured.length === 0 ? 'unknown'
      : measured.map((c) => c.state).reduce((w, s) => (COVERAGE_STATES.indexOf(s) < COVERAGE_STATES.indexOf(w) ? s : w), 'full'),
    batches: covs.length,
    changedRequested: covs.reduce((a, c) => a + (c.changedRequested || 0), 0),
    changedLinesUnread: sumOrNull(covs.map((c) => c.changedLinesUnread)),
    changedLinesUnmeasuredFiles: covs.reduce((a, c) => a + (c.changedLinesUnmeasuredFiles || 0), 0),
    changedFull: cat('changedFull'),
    changedHeadCut: cat('changedHeadCut'),
    changedMissing: cat('changedMissing'),
    changedDeleted: cat('changedDeleted'),
    changedUnread: cat('changedUnread'),
    changedUnmeasured: cat('changedUnmeasured'),
    changedNotReceived: cat('changedNotReceived'),
  };
}

/**
 * Fold the per-batch results into one result. The caller stamps the gate
 * disposition on it afterwards (`stampGateDisposition`), so it is computed the
 * same way as for any single review.
 *
 * @param {{files: string[], result: object}[]} parts
 * @param {string} provider - for the finding-id prefix, as addSemanticIds uses
 * @returns {object}
 */
export function foldBatchResults(parts, provider) {
  const results = parts.map((p) => p.result);
  const label = (i) => `batch ${i + 1}/${parts.length}`;
  const prefix = provider === 'gemini' ? 'G' : 'C';
  const newFindings = results.flatMap((r, i) => (Array.isArray(r.new_findings) ? r.new_findings : []).map((f) => ({ ...f, _batch: i + 1 })));
  newFindings.forEach((f, i) => { f.id = `${prefix}${i + 1}`; });
  // Every batch sees the WHOLE deliberation, so two batches can flag the same dismissal: keep one per original id, highest severity.
  const sevRank = ['LOW', 'MEDIUM', 'HIGH'];
  const dismissed = new Map();
  for (const d of results.flatMap((r) => (Array.isArray(r.wrongly_dismissed) ? r.wrongly_dismissed : []))) {
    const key = d?.original_finding_id ?? JSON.stringify(d);
    const prev = dismissed.get(key);
    if (!prev || sevRank.indexOf(d?.recommended_severity) > sevRank.indexOf(prev?.recommended_severity)) dismissed.set(key, d);
  }
  const malformed = results.some((r) => !Array.isArray(r.new_findings) || !Array.isArray(r.wrongly_dismissed));
  const dq = results.map((r) => r.deliberation_quality || {});
  const notReceived = results.flatMap((r) => r._requiredSubjectsGate?.notReceived ?? []);
  return {
    verdict: worst(VERDICT_RANK, results.map((r) => r.verdict)),
    deliberation_quality: {
      claude_bias_detected: dq.some((d) => d.claude_bias_detected === true),
      gpt_false_positive_count: Math.max(0, ...dq.map((d) => Number(d.gpt_false_positive_count) || 0)),
      deliberation_was_fair: dq.every((d) => d.deliberation_was_fair === true),
      quality_summary: dq.map((d, i) => `[${label(i)}] ${d.quality_summary ?? ''}`).join('\n'),
    },
    // A malformed batch must still read as malformed after the fold (computeGateDisposition fails closed on a non-array).
    new_findings: malformed ? null : newFindings,
    wrongly_dismissed: malformed ? null : [...dismissed.values()],
    over_engineering_flags: [...new Set(results.flatMap((r) => r.over_engineering_flags ?? []))],
    architectural_coherence: worst(COHERENCE_RANK, results.map((r) => r.architectural_coherence).filter(Boolean)) ?? 'Adequate',
    overall_reasoning: results.map((r, i) => `[${label(i)}: ${parts[i].files.length} file(s), ${r.verdict}] ${r.overall_reasoning ?? ''}`).join('\n\n'),
    _envelope: { batched: true, codeCoverage: mergeBatchCoverage(results.map((r) => r._envelope?.codeCoverage ?? null)) },
    _coverageGate: { downgraded: results.some((r) => r._coverageGate?.downgraded === true) },
    ...(notReceived.length > 0 ? { _requiredSubjectsGate: { notReceived } } : {}),
    _batches: parts.map((p, i) => ({
      batch: i + 1,
      files: p.files,
      verdict: p.result.verdict,
      gateDisposition: p.result.gateDisposition ?? null,
      codeCoverageState: p.result._envelope?.codeCoverage?.state ?? 'unknown',
    })),
  };
}

/** Content fingerprint of a path: sha256 of its bytes, `absent` for a deleted file; any other read error throws. */
function defaultFingerprint(p) {
  try { return createHash('sha256').update(readFileSync(p)).digest('hex'); } catch (e) {
    // A deleted file has a stable fingerprint of its own. Any OTHER read failure means the bytes cannot be verified, and
    // an unverifiable file must stop the run rather than read as an unchanged one.
    if (e?.code === 'ENOENT') return 'absent';
    throw new Error(`[final-review] cannot fingerprint ${p} for the batched review (${e?.code ?? e?.message}) — no verdict recorded`);
  }
}

/** Sum two usage records key by key (numeric fields only; a non-numeric field keeps the first value seen). */
function addUsage(a, b) {
  const out = { ...(a || {}) };
  for (const [k, v] of Object.entries(b || {})) {
    out[k] = typeof v === 'number' ? (typeof out[k] === 'number' ? out[k] : 0) + v : (out[k] ?? v);
  }
  return out;
}

/**
 * Review every batch of a plan SEQUENTIALLY with the caller's own single-review
 * function, then fold. Sequential on purpose: the batches share one provider
 * quota, and running them in parallel is how a large diff turns into a burst of
 * 429s whose lost batches would then have to read as "unreviewed".
 *
 * @param {{batches: string[][], transcripts: string[]}} plan - planTranscriptBatches output
 * @param {(transcript: string) => Promise<{result: object, usage: object, latencyMs: number}>} reviewOne
 * @param {{provider: string, stamp: (result: object) => void, log?: (line: string) => void}} opts
 * @returns {Promise<{result: object, usage: object, latencyMs: number}>}
 */
export async function reviewBatches(plan, reviewOne, { provider, stamp, log = (l) => process.stderr.write(l), fingerprint = defaultFingerprint }) {
  // Every batch must judge the SAME bytes. The batches run minutes apart, so a working-tree edit between them would make
  // the fold a verdict on a tree that never existed. Fingerprint every planned file once, re-check after each batch, and
  // refuse (no verdict, no marker) on any drift. An edit inside one batch's own read window is the unbatched path's risk.
  const files = plan.batches.flat();
  const before = new Map(files.map((p) => [p, fingerprint(p)]));
  const parts = [];
  let usage = {};
  let latencyMs = 0;
  for (const [i, transcript] of plan.transcripts.entries()) {
    log(`  [final-review] batch ${i + 1}/${plan.batches.length}: ${plan.batches[i].length} changed file(s)\n`);
    const r = await reviewOne(transcript);
    stamp(r.result);
    log(`  [final-review] batch ${i + 1}/${plan.batches.length}: ${r.result.verdict} → ${r.result.gateDisposition}`
      + ` (coverage ${r.result._envelope?.codeCoverage?.state ?? 'unknown'})\n`);
    const moved = files.filter((p) => fingerprint(p) !== before.get(p));
    if (moved.length > 0) {
      throw new Error(`[final-review] the working tree changed during the batched review (after batch ${i + 1}/${plan.batches.length}): `
        + `${moved.join(', ')} — no verdict recorded; re-run the review on a stable tree`);
    }
    parts.push({ files: plan.batches[i], result: r.result });
    usage = addUsage(usage, r.usage);
    latencyMs += r.latencyMs || 0;
  }
  return { result: foldBatchResults(parts, provider), usage, latencyMs };
}
