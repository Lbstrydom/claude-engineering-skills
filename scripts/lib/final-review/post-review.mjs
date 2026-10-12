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
import { affectedFilesOf, primaryFileOf, structuredFilesOf, sectionLociOf, signatureOf } from '../finding-match.mjs';
import { isReleaseBlocking } from './round-gate.mjs';
import { listRepoFiles } from '../repo-inventory.mjs';
import { verifyExistenceFindings, isRefuted } from '../audit/finding-verification.mjs';
import { generateRepoProfile } from '../context.mjs';
import { getActiveRevisionId } from '../prompt-registry.mjs';
import { PromptBandit } from '../../bandit.mjs';
// The pure primitive ledger.mjs re-exports — imported from its home so this
// module does not pull ledger.mjs's env-reading module graph just to compare
// two strings (the reason text-similarity.mjs was extracted in the first place).
import { jaccardSimilarity } from '../text-similarity.mjs';

/**
 * The topic signature both post-review topic matchers compare on — `finding-match.mjs`'s
 * `signatureOf` (category + section + detail), the repo's one finding signature. The debt
 * stage builds ITS side of the comparison through the same function (`debtTopicSig`), which is
 * what makes the symmetry structural.
 */
function findingTopicSig(f) {
  return signatureOf(f);
}

/**
 * Best Jaccard match of `sig` among `candidates`. Both suppressions score with
 * the same `jaccardSimilarity`, so they cannot drift into different similarity
 * notions; each narrows its candidates by `suppressionLocusOf` first.
 */
function bestTopicMatch(sig, candidates, sigOf) {
  let match = null;
  let score = 0;
  for (const c of candidates) {
    const s = jaccardSimilarity(sig, sigOf(c));
    if (s > score) { score = s; match = c; }
  }
  return { match, score };
}

/**
 * The SAME-LOCUS key a suppression decision requires on top of topic
 * similarity: the files a finding is filed under (`structuredFilesOf` — the
 * precision key, not the recall union), or its `§`/decision-id loci when it
 * names no file (a plan-mode finding). Prose similarity alone suppressed
 * similarly-worded DISTINCT defects in different files (audit H5/H17): two
 * "swallows the parse error" findings in two modules read alike and are two bugs.
 */
function suppressionLocusOf(f) {
  const files = structuredFilesOf(f);
  return files.length > 0 ? files : sectionLociOf(f);
}

/** First locus key the two sides share, or null. Either side empty ⇒ null (fail OPEN: keep the finding). */
function sharedLocus(a, b) {
  const bs = new Set(b);
  return a.find((k) => bs.has(k)) ?? null;
}

/**
 * Round >= 2: drop new_findings whose topic matches a finding the PREVIOUS
 * final-review round already raised — those are settled (fixed, or accepted as
 * debt). A finding the reviewer marks `is_reopened: true` survives: the prompt
 * requires it to cite the changed line that reopened it. Deterministic backstop
 * to the prompt's "do not re-raise" instruction, which is otherwise the only
 * thing standing between a round-2 run and a fresh full review.
 *
 * 0.35 = `suppressReRaises`' threshold: both sides here are full
 * category+section+detail signatures, the symmetric case that value was tuned
 * for (the debt path's 0.30 compensates for an asymmetric, shorter signature).
 *
 * Two conditions beyond similarity, both from the 2026-09-27 code audit:
 * - **Same locus** (H5/H17): the finding and the prior must share a file (or,
 *   for file-less plan findings, a `§`/decision-id locus). Either side naming
 *   none ⇒ no suppression — an extra finding is the cheap error, a vanished
 *   distinct defect the expensive one.
 * - **Only a NON-blocking prior settles anything** (H6): a prior finding that
 *   was release-blocking is exactly what round 2 must re-check ("previous-round
 *   items marked BLOCKING that remain unresolved"). Suppressing its re-raise
 *   would turn an unfixed blocker into `approve_with_debt`. `isReleaseBlocking`
 *   fails closed, so a prior with a missing/invalid pair counts as blocking too.
 *
 * Every decision that matched on similarity is recorded: drops in
 * `_priorSuppressedFindings`, similarity matches that were KEPT (and why) in
 * `_priorRoundKept`, so a suppression is auditable after the fact.
 *
 * @param {object} result - mutated in place
 * @param {object[]} priorFindings - the previous round's new_findings
 * @returns {{suppressed: number}}
 */
export function applyPriorRoundSuppression(result, priorFindings, { threshold = 0.35 } = {}) {
  if (!Array.isArray(result?.new_findings) || !Array.isArray(priorFindings) || priorFindings.length === 0) {
    return { suppressed: 0 };
  }
  const priors = priorFindings.map((p) => ({ p, locus: suppressionLocusOf(p), blocking: isReleaseBlocking(p) }));
  const kept = [];
  const dropped = [];
  const keptMatches = [];
  for (const f of result.new_findings) {
    if (f.is_reopened === true) { kept.push(f); continue; }
    const sig = findingTopicSig(f);
    const locus = suppressionLocusOf(f);
    // Similarity-qualifying priors that share this finding's locus.
    const qualifying = priors
      .map((c) => ({ ...c, score: jaccardSimilarity(sig, findingTopicSig(c.p)), shared: sharedLocus(locus, c.locus) }))
      .filter((c) => c.score > threshold);
    const sameLocus = qualifying.filter((c) => c.shared);
    const decision = (c) => ({ id: f.id ?? null, category: f.category, matchedPriorId: c.p.id ?? null, score: Number(c.score.toFixed(2)), locus: c.shared });
    const blockingMatch = sameLocus.find((c) => c.blocking);
    if (blockingMatch) {
      kept.push(f);
      keptMatches.push({ ...decision(blockingMatch), reason: 'prior_release_blocking' });
      continue;
    }
    // The mirror of H6, on the CURRENT finding: a re-raise the reviewer NOW marks release-blocking
    // is never settled by a prior NON-blocking one — the judgement changed, and deleting it here
    // would turn `blocked` into `approve_with_debt`. The same invariant the debt stage enforces
    // (`applyDebtSuppression`): no suppression stage deletes a release blocker before the gate
    // reads it. `isReleaseBlocking` fails closed, so a missing/invalid pair is kept too.
    if (isReleaseBlocking(f)) {
      kept.push(f);
      const settledBy = sameLocus.reduce((a, c) => (a && a.score >= c.score ? a : c), null);
      if (settledBy) keptMatches.push({ ...decision(settledBy), reason: 'current_release_blocking' });
      continue;
    }
    const best = sameLocus.reduce((a, c) => (a && a.score >= c.score ? a : c), null);
    if (best) { dropped.push(decision(best)); continue; }
    kept.push(f);
    const bestOther = qualifying.reduce((a, c) => (a && a.score >= c.score ? a : c), null);
    if (bestOther) keptMatches.push({ ...decision(bestOther), reason: 'no_shared_locus' });
  }
  if (dropped.length > 0) {
    process.stderr.write(`  [final-review] Prior-round suppression: ${dropped.length}/${result.new_findings.length} new_findings re-raise a settled previous-round finding (dropped)\n`);
    for (const d of dropped.slice(0, 3)) process.stderr.write(`    [prior-settled] ~${d.matchedPriorId} score=${d.score} locus=${d.locus}\n`);
  }
  result.new_findings = kept;
  result._priorSuppressedCount = dropped.length;
  result._priorSuppressedFindings = dropped;
  result._priorRoundKept = keptMatches;
  return { suppressed: dropped.length };
}

// ── Debt re-suppression ─────────────────────────────────────────────────────
// The stage, its envelope reader and the prompt block share ONE normalised topic shape and ONE
// eligibility predicate (docs/plans/final-review-debt-suppression-revival.md §2.2b/§2.3b).

/** Topics the accessor returns — one bound for the stage AND the prompt block. */
export const MAX_DEBT_CONTEXT_TOPICS = 50;
/** Consumer-side cap on a topic's `detailSnapshot` (the persisted debt entry's own cap). */
export const MAX_DEBT_SNAPSHOT_CHARS = 600;
/** Characters of each topic's snapshot the PROMPT shows (display only — matching uses the whole). */
const DEBT_PROMPT_SNAPSHOT_CHARS = 200;
/**
 * `score > DEBT_MATCH_THRESHOLD` suppresses (strict, as it always was). 0.30 is the constant the
 * debt path already used; what changed is its MEANING — both sides are now the symmetric
 * category+section+detail signature, so it is no longer compensating for an asymmetric one.
 * Calibrated on the real debt ledger: all 10 same-file pairs above it are the same concern, none
 * of the 5 explicit different-defect negatives (<= 0.121) or the 3 distinct/arguable pairs
 * (<= 0.210) reaches it, and it catches near-restatements only (~26% of same-concern pairs) —
 * deliberately, since this stage's error is deleting a finding. Plan §2.2; the judged pairs are
 * pinned in tests/fixtures/debt-memory/calibration-pairs.json. Do not lower it to buy recall.
 */
const DEBT_MATCH_THRESHOLD = 0.3;

/** A debt topic as the symmetric signature sees it. */
function debtTopicSig(topic) {
  return signatureOf({ category: topic.category, section: topic.section, detail: topic.detailSnapshot });
}

/**
 * Can this debt topic be compared like for like? Only a topic carrying a `detailSnapshot` can —
 * every envelope written before the field existed cannot, and those degrade to INERT rather than
 * falling back to the asymmetric comparison. The ONE predicate for both the stage and the prompt
 * block: the prompt must not steer the reviewer on a topic the filter would never act on.
 */
export function isEligibleDebtTopic(topic) {
  return typeof topic?.detailSnapshot === 'string' && topic.detailSnapshot.trim() !== '';
}

/** `{topic}` for a usable entry, `{reason}` for one that cannot be normalised. */
function normaliseDebtTopic(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an object' };
  const str = (v) => (typeof v === 'string' ? v : '');
  const category = str(raw.category);
  const section = str(raw.section);
  const topicId = typeof raw.topicId === 'string' && raw.topicId !== ''
    ? raw.topicId
    : (category !== '' || section !== '' ? `${category}|${section}` : '');
  if (topicId === '') return { reason: 'no usable identity (topicId, category, section)' };
  const topic = {
    topicId, category, section,
    affectedFiles: Array.isArray(raw.affectedFiles) ? raw.affectedFiles.filter((f) => typeof f === 'string') : [],
    deferredReason: str(raw.deferredReason),
  };
  const snapshot = typeof raw.detailSnapshot === 'string' ? raw.detailSnapshot.trim().slice(0, MAX_DEBT_SNAPSHOT_CHARS) : '';
  if (snapshot !== '') topic.detailSnapshot = snapshot;
  return { topic };
}

/**
 * Every debt topic the audit rounds surfaced — the ONE reader of the `_debtMemory` envelope.
 *
 * Why this exists: `build-audit-transcript.mjs` nests each round's audit result under `rounds[]`,
 * so the envelope is at `rounds[i]._debtMemory`, never at top level. Both consumers read the top
 * level, so the stage and the "Pre-filtered Debt" prompt block saw nothing in all 65 real
 * transcripts checked (2026-10-03) and were dead for their whole history.
 *
 * Contract (plan §2.2b): an envelope is an incremental, session-scoped OBSERVATION, not a
 * current-state snapshot. Seed from the legacy top-level key as the OLDEST observation, then walk
 * `rounds[]` oldest to newest: upsert each normalised entry (the newer entry wins whole; only a
 * missing `detailSnapshot` is inherited from the older one), then delete that round's
 * `reopenedTopicIds` — the one event that un-settles a surfaced topic. The result is newest-first,
 * cut to `MAX_DEBT_CONTEXT_TOPICS`. Pure and deterministic.
 *
 * @param {object|null} transcript - the parsed transcript
 * @param {{onInvalid?: (reason: string, entry: unknown) => void}} [opts] - called per excluded entry
 * @returns {Array<{topicId: string, category: string, section: string, affectedFiles: string[],
 *   deferredReason: string, detailSnapshot?: string}>}
 */
export function debtSuppressionContextOf(transcript, { onInvalid } = {}) {
  const topics = new Map();
  const upsert = (raw) => {
    const n = normaliseDebtTopic(raw);
    if (!n.topic) { onInvalid?.(n.reason, raw); return; }
    const prev = topics.get(n.topic.topicId);
    if (prev) {
      topics.delete(n.topic.topicId); // re-insert at the newest end
      if (n.topic.detailSnapshot === undefined && prev.detailSnapshot !== undefined) n.topic.detailSnapshot = prev.detailSnapshot;
    }
    topics.set(n.topic.topicId, n.topic);
  };
  const contextOf = (envelope) => (Array.isArray(envelope?.suppressionContext) ? envelope.suppressionContext : []);
  for (const legacy of [transcript?._debtMemory, transcript?.debt_memory]) contextOf(legacy).forEach(upsert);
  for (const round of Array.isArray(transcript?.rounds) ? transcript.rounds : []) {
    contextOf(round?._debtMemory).forEach(upsert);
    const reopened = round?._debtMemory?.reopenedTopicIds;
    for (const id of Array.isArray(reopened) ? reopened : []) if (typeof id === 'string') topics.delete(id);
  }
  return [...topics.values()].reverse().slice(0, MAX_DEBT_CONTEXT_TOPICS);
}

/** Collapse all whitespace and cap — a display field must never span lines. */
const oneLine = (value, max) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The "Pre-filtered Debt" prompt block, from the accessor's canonical result. Eligible topics only
 * (so a legacy envelope renders NO block at all), each field on one line, and it states what is
 * NOT settled: a reviewer told "do not resurface" omits the finding BEFORE any deterministic
 * exemption can act, and fail-open code downstream cannot recover a finding the model never emitted.
 * `''` when there is nothing to say, so the caller's concatenation is unchanged.
 * @param {ReturnType<typeof debtSuppressionContextOf>} context
 * @returns {string}
 */
export function buildDebtPromptBlock(context) {
  const eligible = (Array.isArray(context) ? context : []).filter(isEligibleDebtTopic).slice(0, MAX_DEBT_CONTEXT_TOPICS);
  if (eligible.length === 0) return '';
  const lines = eligible.map((t) => {
    const reason = oneLine(t.deferredReason, 40);
    return `- [${oneLine(t.topicId, 80)}] ${oneLine(t.category, 120)} (${oneLine(t.section, 160)})${reason ? ` {${reason}}` : ''} — ${oneLine(t.detailSnapshot, DEBT_PROMPT_SNAPSHOT_CHARS)}`;
  });
  return [
    '## Pre-filtered Debt (settled concerns — do not re-report THESE concerns)',
    `The following ${eligible.length} concern(s) were matched against the repo's persistent debt ledger and`,
    'deliberately deferred by the operator; the pipeline already handled them. Do not re-report the same concern.',
    'These are NOT settled and must still be reported: a different defect at the same location; a regression',
    'or reopening that cites the changed line (set is_reopened: true); anything release-blocking; and any case',
    'you are unsure about.',
    '',
    ...lines,
    '',
  ].join('\n');
}

export async function applyDebtSuppression(result, transcriptContent) {
  let transcript;
  try {
    transcript = JSON.parse(transcriptContent);
  } catch {
    return; // not JSON: the one expected, quiet case — a markdown transcript carries no envelope
  }
  try {
    let malformed = 0;
    const context = debtSuppressionContextOf(transcript, { onInvalid: () => { malformed += 1; } });
    if (malformed > 0) {
      process.stderr.write(`  [final-review] Debt re-suppression: ${malformed} malformed debt topic ${malformed === 1 ? 'entry' : 'entries'} ignored\n`);
    }
    if (context.length === 0 || !Array.isArray(result?.new_findings)) return;
    // Fail OPEN on a topic with no detailSnapshot: it cannot be compared like for like, and a
    // silent skip would read as "nothing matched". Say so.
    const candidates = context.filter(isEligibleDebtTopic);
    if (candidates.length < context.length) {
      const n = context.length - candidates.length;
      process.stderr.write(`  [final-review] Debt re-suppression: ${n} of ${context.length} debt topic${context.length === 1 ? '' : 's'} carr${n === 1 ? 'ies' : 'y'} no detailSnapshot — not eligible (kept, fail-open)\n`);
    }
    if (candidates.length === 0) return;
    const before = result.new_findings.length;
    const kept = [];
    const debtSuppressed = [];
    // Same-locus requirement (audit H5/H17), applied ONLY to a debt entry that carries file info
    // (`affectedFiles`, or a file path in `section`): an entry without any has nothing to compare,
    // so similarity decides alone. Candidates whose files do not intersect the finding's are
    // excluded BEFORE the best match is chosen, so a same-worded debt topic in another module
    // cannot swallow the finding.
    for (const f of result.new_findings) {
      // Never settled by debt: a reopening (the prompt obliges the reviewer to cite the changed
      // line that reopened it) and anything release-blocking. This stage runs BEFORE
      // `stampGateDisposition`, so deleting a blocker here would turn `blocked` into
      // `approve_with_debt` — the H6 hazard `applyPriorRoundSuppression` guards the same way.
      // `isReleaseBlocking` fails closed, so a finding with no valid pair is kept too.
      if (f?.is_reopened === true || isReleaseBlocking(f)) { kept.push(f); continue; }
      const locus = suppressionLocusOf(f);
      const sameLocus = candidates.filter((d) => {
        const debtFiles = structuredFilesOf(d);
        return debtFiles.length === 0 || sharedLocus(locus, debtFiles) !== null;
      });
      const { match, score } = bestTopicMatch(findingTopicSig(f), sameLocus, debtTopicSig);
      if (match && score > DEBT_MATCH_THRESHOLD) {
        debtSuppressed.push({ finding: f, matchedTopic: match.topicId, score, file: sharedLocus(locus, structuredFilesOf(match)) });
      } else kept.push(f);
    }
    if (debtSuppressed.length === 0) return;
    // `result` is written in ONE block, after everything that can throw has run — including
    // building the replacement metadata, which reads fields of the findings — so no failure can
    // leave it half-updated.
    const suppressedMeta = debtSuppressed.map((s) => ({
      id: s.finding.id ?? null, category: s.finding.category, matchedTopicId: s.matchedTopic,
      score: Number(s.score.toFixed(2)), file: s.file,
    }));
    result.new_findings = kept;
    result._debtSuppressedCount = debtSuppressed.length;
    result._debtSuppressedFindings = suppressedMeta;
    process.stderr.write(`  [final-review] Debt re-suppression: ${debtSuppressed.length}/${before} new_findings matched pre-filtered debt\n`);
    for (const s of debtSuppressed.slice(0, 3)) {
      process.stderr.write(`    [debt-suppressed] ${s.matchedTopic.slice(0, 8)} score=${s.score.toFixed(2)}\n`);
    }
  } catch (err) {
    // The finding set is unchanged (nothing above mutates `result` before its single write), so
    // this is fail-open — but it must be LOUD: an empty catch rendered a broken stage as a quiet one.
    process.stderr.write(`  [final-review] Debt re-suppression NOT applied: ${err?.message ?? err}\n`);
  }
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
    // Every cited line reaches the existence gate, not only the first (final
    // review G2); the first stays the section's fromFile anchor.
    detail: [wd?.reason_claude_was_wrong || '', wd?.evidence_basis || '', ...cited.slice(1).map(String)].join('\n').trim(),
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
    const norm = (p) => String(p).trim().replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const inScope = new Set(changedFiles.map(norm));
    const before = result.new_findings.length;
    const kept = [];
    const scopeFiltered = [];
    for (const f of result.new_findings) {
      // Final-review findings carry no `file`/`location` field — reading those
      // made this filter a no-op for its whole life (final review 2026-09-27
      // G1). Use the shared structured-file extractor; a finding naming no file
      // stays (deliberation-level), and one naming ANY in-scope file stays.
      const files = structuredFilesOf(f).map(norm);
      if (files.length === 0) { kept.push(f); continue; }
      const inScopeFile = (file) => inScope.has(file) || [...inScope].some((s) => file.endsWith('/' + s) || s.endsWith('/' + file));
      if (files.some(inScopeFile)) kept.push(f);
      else scopeFiltered.push({ finding: f, file: files.join(', ') });
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
