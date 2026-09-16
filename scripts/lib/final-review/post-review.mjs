/**
 * @fileoverview The post-review findings pipeline — debt re-suppression, the
 * deterministic existence-claim gate, the post-review scope filter,
 * semantic-id assignment, and learning-store outcome recording.
 *
 * Pure relocation out of `scripts/gemini-review.mjs`
 * (`docs/plans/gemini-review-decomposition.md` Phase 4) — `gemini-review.mjs`
 * imports `applyExistenceGate`/`applyScopeFilter`/`recordNewFindings` back and
 * keeps re-exporting them at the top level (test-import contract — see the
 * plan's widened General rule); `applyDebtSuppression`/`addSemanticIds`/
 * `recordGeminiOutcomes` are imported back too (the first two were already
 * exported one-directionally for `shadow.mjs`'s benefit during Phase 3 — this
 * phase is where that export finally earns its keep, since `shadow.mjs` now
 * imports them from HERE instead; `recordGeminiOutcomes` was never a
 * top-level export, only reached via a direct call inside `main()`).
 *
 * **Domain: `audit-orchestration`, not `shared-lib`** — same reasoning as
 * `shadow.mjs` (see that module's fileoverview): this is `gemini-review.mjs`'s
 * own post-review pipeline, not a reusable shared-lib primitive, and its real
 * imports (`lib/audit/finding-verification.mjs`, `bandit.mjs`) cross into
 * `audit-orchestration` and `learning-store` respectively — added to
 * `.audit-loop/domain-map.json` proactively, before an audit round could
 * flag it (the shadow.mjs rule was reactive; this one applies the same
 * lesson up front).
 *
 * `shadow.mjs`'s `runShadowReview` calls `applyDebtSuppression`/
 * `applyScopeFilter`/`applyExistenceGate`/`addSemanticIds` from here —
 * a one-directional edge (this module needs nothing back from `shadow.mjs`),
 * and now that both are `audit-orchestration`, it is also no longer a
 * cross-domain edge. `gemini-review.mjs` also imports from here directly
 * (its own `runFinalReview`/`main()` call sites) — likewise one-directional
 * and same-domain.
 *
 * @module scripts/lib/final-review/post-review
 */
import { semanticId, appendOutcome, FalsePositiveTracker } from '../findings.mjs';
import { affectedFilesOf, primaryFileOf } from '../finding-match.mjs';
import { listRepoFiles } from '../repo-inventory.mjs';
import { verifyExistenceFindings, isRefuted } from '../audit/finding-verification.mjs';
import { generateRepoProfile } from '../context.mjs';
import { getActiveRevisionId } from '../prompt-registry.mjs';
import { PromptBandit } from '../../bandit.mjs';

export async function applyDebtSuppression(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const suppressionCtx = transcriptObj._debtMemory?.suppressionContext
      || transcriptObj.debt_memory?.suppressionContext
      || [];
    if (!Array.isArray(suppressionCtx) || suppressionCtx.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    const { jaccardSimilarity } = await import('../ledger.mjs');
    // Threshold 0.30 vs suppressReRaises' 0.35 — debt envelope signatures
    // (category+section) are shorter than new_findings (which include detail
    // text), so asymmetric lengths dilute Jaccard.
    const THRESHOLD = 0.3;
    const before = result.new_findings.length;
    const kept = [];
    const debtSuppressed = [];
    for (const f of result.new_findings) {
      const fSig = `${f.category} ${f.section} ${f.detail}`;
      let match = null;
      let bestScore = 0;
      for (const d of suppressionCtx) {
        const score = jaccardSimilarity(fSig, `${d.category} ${d.section}`);
        if (score > bestScore) { bestScore = score; match = d; }
      }
      if (match && bestScore > THRESHOLD) debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score: bestScore });
      else kept.push(f);
    }
    if (debtSuppressed.length === 0) return;
    process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
    for (const s of debtSuppressed.slice(0, 3)) {
      process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
    }
    result.new_findings = kept;
    result._debtSuppressedCount = debtSuppressed.length;
  } catch { /* transcript not JSON or no _debtMemory — skip */ }
}

/**
 * Project a `wrongly_dismissed` entry onto the `{category, section, detail}`
 * shape `classifyFinding` reads.
 *
 * **This projection is the whole point of the function** (validator-inert-by-
 * arguments). `WronglyDismissedSchema` shares NOT ONE field name with
 * `FindingBase` — its prose lives in `reason_claude_was_wrong`/`evidence_basis`
 * and its file references in `cited_lines`. Handing those entries to the gate
 * unprojected type-checks, runs, and classifies exactly zero of them, so the
 * gate would read clean on the path that needs it most: a re-asserted GPT
 * finding is where a false absence claim survives Claude's dismissal and comes
 * back as "you hallucinated the verification".
 *
 * `category` is left EMPTY on purpose — it is concatenated into the haystack
 * `classifyFinding` scans, so a synthetic label there could manufacture a
 * classification the model's own prose never made.
 */
function projectWronglyDismissed(wd) {
  const cited = Array.isArray(wd?.cited_lines) ? wd.cited_lines : [];
  return {
    category: '',
    // `auth.js:132` → `extractCitedEntity` splits on `:` for the fromFile anchor.
    section: cited.length > 0 ? String(cited[0]) : '',
    detail: `${wd?.reason_claude_was_wrong || ''}\n${wd?.evidence_basis || ''}`.trim(),
    // `mk()` defaults verdictSeverity to `finding.severity`; without this the
    // projected view has no severity at all and the annotation reads undefined.
    severity: wd?.recommended_severity,
  };
}

/**
 * Deterministic existence-claim gate for FINAL-REVIEW findings — the same
 * `verifyExistenceFindings` the GPT audit path runs at
 * `legacy-production-audit.mjs`, which the final reviewer never passed through.
 *
 * Why it belongs here too: a "file/module/symbol X does not exist" claim is
 * mechanically decidable against the repo inventory, and until this ran, a
 * false one from the final reviewer could only be answered by argument — the
 * operator re-deriving `git ls-files` by hand while the reviewer restated the
 * claim. The failure shape is a category error (treating "not in the
 * changed-files list" as "not in the repo"), which no amount of prose settles
 * and one set lookup does.
 *
 * Deliberately ANNOTATES rather than drops, mirroring the GPT path: `.verification`
 * rides on the finding and `isRefuted` decides what it means. The model's own
 * `verdict` is NOT recomputed here — mechanically flipping a REJECT is a
 * separate decision with its own failure modes, and a refuted finding that is
 * *named as refuted* in the report already ends the argument.
 *
 * @param {object} result - parsed GeminiFinalReviewSchema object, mutated in place
 * @param {object} [deps] - test seam
 * @returns {{checked:number, refuted:number}}
 */
export function applyExistenceGate(result, { listFiles = listRepoFiles } = {}) {
  const stats = { checked: 0, refuted: 0 };
  try {
    const inv = listFiles({ baseDir: process.cwd() });
    const ctx = { repoFiles: inv.files, inventoryComplete: inv.complete };

    // ── new_findings: already FindingBase-shaped, gate applies directly ──
    if (Array.isArray(result?.new_findings) && result.new_findings.length > 0) {
      stats.checked += result.new_findings.length;
      result.new_findings = verifyExistenceFindings(result.new_findings, ctx);
    }

    // ── wrongly_dismissed: needs the projection above to be adjudicable ──
    if (Array.isArray(result?.wrongly_dismissed) && result.wrongly_dismissed.length > 0) {
      stats.checked += result.wrongly_dismissed.length;
      const projected = verifyExistenceFindings(result.wrongly_dismissed.map(projectWronglyDismissed), ctx);
      // Map the verdict back onto the ORIGINAL entries — index-aligned because
      // verifyExistenceFindings is a `.map`, one output per input, order kept.
      result.wrongly_dismissed = result.wrongly_dismissed.map((wd, i) => (
        projected[i]?.verification ? { ...wd, verification: projected[i].verification } : wd
      ));
    }

    const refuted = [
      ...(result?.new_findings || []),
      ...(result?.wrongly_dismissed || []),
    ].filter(isRefuted);
    stats.refuted = refuted.length;

    if (refuted.length > 0) {
      // Name the entities, not just a count — the operator's next move is to
      // stop arguing about a specific path, so the path has to be on screen.
      process.stderr.write(
        `  [final-review] Existence gate: ${refuted.length}/${stats.checked} claim(s) REFUTED against the repo inventory\n`,
      );
      for (const f of refuted.slice(0, 5)) {
        const id = f.id || f.original_finding_id || '?';
        process.stderr.write(`    [refuted] ${id}: ${f.verification?.verificationReason || 'entity exists'}\n`);
      }
    }
    if (!inv.complete) {
      // Absence is not provable against a partial inventory — the gate degrades
      // to `requires_verification` internally, and saying so here stops the
      // operator reading a quiet run as a clean one.
      process.stderr.write('  [final-review] Existence gate: repo inventory INCOMPLETE — absence claims not adjudicable\n');
    }
  } catch (err) {
    // Non-blocking, like the GPT path's own try/catch: a gate failure must not
    // take down a review that otherwise succeeded.
    process.stderr.write(`  [final-review] Existence gate skipped: ${err.message}\n`);
  }
  result._existenceGate = stats;
  return stats;
}

export async function applyScopeFilter(result, transcriptContent) {
  try {
    const transcriptObj = JSON.parse(transcriptContent);
    const changedFiles = Array.isArray(transcriptObj.changed_files) ? transcriptObj.changed_files : [];
    if (changedFiles.length === 0) return;
    if (!Array.isArray(result.new_findings)) return;
    // Normalise paths for comparison: trim whitespace, strip leading ./.
    const inScope = new Set(changedFiles.map(f => f.trim().replace(/^\.\//, '')));
    const before = result.new_findings.length;
    const kept = [];
    const scopeFiltered = [];
    for (const f of result.new_findings) {
      const file = (f.file || f.location || '').trim().replace(/^\.\//, '');
      // Empty file → keep (deliberation-level finding, not file-specific).
      if (!file) { kept.push(f); continue; }
      const matched = inScope.has(file) || [...inScope].some(s => file === s || file.endsWith('/' + s) || s.endsWith('/' + file));
      if (matched) kept.push(f);
      else scopeFiltered.push({ finding: f, file });
    }
    if (scopeFiltered.length === 0) return;
    process.stderr.write(`  [final-review] Scope filter: ${scopeFiltered.length}/${before} new_findings cited out-of-scope files (dropped)\n`);
    for (const s of scopeFiltered.slice(0, 3)) {
      process.stderr.write(`    [scope-dropped] ${s.finding.id || '?'} → ${s.file}\n`);
    }
    result.new_findings = kept;
    result._scopeFilteredCount = scopeFiltered.length;
    result._scopeFilteredFindings = scopeFiltered.map(s => ({ id: s.finding.id, file: s.file, hash: s.finding._hash }));
  } catch { /* transcript not JSON or no changed_files — skip */ }
}

export function addSemanticIds(result, provider) {
  if (!result.new_findings) return;
  for (let i = 0; i < result.new_findings.length; i++) {
    const f = result.new_findings[i];
    f.id = `${provider === 'gemini' ? 'G' : 'C'}${i + 1}`;
    f._hash = semanticId(f);
    f._source = provider;
    // Stamp the MATCHING keys. Their absence is why cross-model bucketing was
    // reduced to an exact hash over model-authored prose (0/48 matches on real
    // data while 9/48 named the same file). `affectedFiles` is the set matching
    // uses; `_primaryFile` is the reporting key and may be null, which is
    // honest — a finding naming no file is unmatchable, not unique.
    f.affectedFiles = affectedFilesOf(f);
    f._primaryFile = primaryFileOf(f);
  }
}

export function recordNewFindings(result, fpTracker, repoFP, revId, modelId = 'gemini') {
  if (!Array.isArray(result.new_findings)) return;
  for (const f of result.new_findings) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: f.id,
      severity: f.severity,
      category: f.category,
      section: f.section,
      pass: 'gemini-new',
      model: modelId,
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: f._hash,
    });
    fpTracker.record(f, true, repoFP);
  }
}

function recordWronglyDismissed(result, revId, modelId = 'gemini') {
  if (!Array.isArray(result.wrongly_dismissed)) return;
  for (const w of result.wrongly_dismissed) {
    appendOutcome('.audit/outcomes.jsonl', {
      findingId: w.original_finding_id,
      severity: w.recommended_severity,
      category: `[wrongly-dismissed] ${w.original_finding_id}`,
      section: w.reason_claude_was_wrong?.slice(0, 120) || '',
      pass: 'gemini-wrongly-dismissed',
      model: modelId,
      accepted: null,
      gemini_reconfirmed: true,
      round: 0,
      promptVariant: revId,
      promptRevisionId: revId,
      semanticHash: semanticId({
        category: w.original_finding_id,
        section: w.reason_claude_was_wrong || '',
        detail: '',
      }),
    });
  }
}

export function recordGeminiOutcomes(result, modelId = 'gemini') {
  try {
    const repoProfile = generateRepoProfile();
    const repoFP = repoProfile?.repoFingerprint || null;
    const bandit = new PromptBandit();
    const fpTracker = new FalsePositiveTracker();
    const revId = getActiveRevisionId('gemini-review') || 'default';
    recordNewFindings(result, fpTracker, repoFP, revId, modelId);
    recordWronglyDismissed(result, revId, modelId);
    const VERDICT_REWARDS = { APPROVE: 0.8, CONCERNS: 0.5, CONCERNS_REMAINING: 0.35, REJECT: 0.2 };
    // A coverage-gated verdict is a mechanical post-condition, not a judgement
    // about the prompt — feeding it to the bandit would teach the wrong lesson
    // from a run the reviewer could not perform. Skip the verdict reward; the
    // finding-level outcomes above are recorded either way.
    if (!result._coverageGate?.downgraded) {
      const verdictReward = VERDICT_REWARDS[result.verdict] ?? 0.5;
      bandit.update('gemini-review', revId, verdictReward);
    }
    bandit.flush();
    fpTracker.flush?.();
    const newCount = result.new_findings?.length ?? 0;
    const wrongCount = result.wrongly_dismissed?.length ?? 0;
    if (newCount > 0 || wrongCount > 0) {
      process.stderr.write(`  [learning] Recorded ${newCount} new + ${wrongCount} wrongly-dismissed outcomes for gemini-review pass\n`);
    }
  } catch (learnErr) {
    process.stderr.write(`  [learning] ${learnErr.message?.slice(0, 100)}\n`);
  }
}
