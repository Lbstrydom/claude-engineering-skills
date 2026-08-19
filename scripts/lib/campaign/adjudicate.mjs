/**
 * @fileoverview Worksheet-adjacent contract: the verdict schema/tool/prompt,
 * verdict normalisation, and cross-arm clustering (D2).
 *
 * Moved verbatim from `scripts/campaign.mjs` (plan: comparison-tooling-
 * consolidation.md, Phase 3). Per D2a: may import `campaign/cited-source.mjs`,
 * `lib/campaign/config.mjs`; must NOT import any `scripts/*.mjs` entry point
 * or `campaign/promote.mjs`. **The provider call itself stays in the CLI**
 * (`callAdjudicator` in `scripts/campaign.mjs`) — this module is pure.
 *
 * @module scripts/lib/campaign/adjudicate
 */
import { z } from 'zod';
import { matchFindings, affectedLociOf } from '../finding-match.mjs';

/**
 * `verified-true`/`verified-false` in the plan's prose map onto the pair
 * (`method: 'verified'`, `outcome: accepted|dismissed`) here — one axis for HOW
 * the verdict was reached, one for WHAT it was, rather than a four-value enum
 * that conflates them.
 *
 * The field is `outcome`, NOT `ruling`, and the distinction is load-bearing:
 * `finding_adjudication_events.ruling` is CHECK'd to
 * `(sustain, overrule, compromise)` — the GPT-vs-Gemini DELIBERATION ruling, a
 * different axis entirely. Writing an accept/dismiss verdict there is rejected
 * by the constraint, which is how the live suite caught this.
 */
export const AdjudicationVerdictSchema = z.object({
  worksheetRowId: z.string().min(1),
  method: z.enum(['verified', 'unverifiable']),
  outcome: z.enum(['accepted', 'dismissed', 'needs_triage']),
  evidence: z.object({
    path: z.string().nullable(),
    sha: z.string().nullable(),
    lineRange: z.string().nullable(),
    quotedSpan: z.string().nullable(),
    absenceReason: z.string().nullable(),
  }),
  confidence: z.number().min(0).max(1),
}).strict();

/** The tool the adjudicator is FORCED to call. No other tool is offered. */
export const ADJUDICATION_TOOL = Object.freeze({
  name: 'record_verdict',
  description: 'Record the verdict for exactly one finding.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['worksheetRowId', 'method', 'outcome', 'evidence', 'confidence'],
    properties: {
      worksheetRowId: { type: 'string' },
      method: { type: 'string', enum: ['verified', 'unverifiable'] },
      outcome: { type: 'string', enum: ['accepted', 'dismissed', 'needs_triage'] },
      evidence: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha', 'lineRange', 'quotedSpan', 'absenceReason'],
        properties: {
          path: { type: ['string', 'null'] },
          sha: { type: ['string', 'null'] },
          lineRange: { type: ['string', 'null'] },
          quotedSpan: { type: ['string', 'null'] },
          absenceReason: { type: ['string', 'null'] },
        },
      },
      confidence: { type: 'number' },
    },
  },
});

export const ADJUDICATION_SYSTEM_PROMPT = [
  'You VERIFY one code-audit finding against source you are shown. You do not judge whether it is worth fixing.',
  '',
  'Rules, in order of precedence:',
  '1. `method: "verified"` requires that you located the cited code in citedSources and can quote it.',
  '   Set outcome "accepted" when the described defect IS present at that revision, "dismissed" when it is not.',
  '1b. A cited source marked `kind: "plan-document"` is the PLAN the finding reviews, not application code.',
  '   Such a finding is a claim about the plan TEXT — a contradiction, an omission, an unstated assumption —',
  '   so verify it against that text exactly as you would against code, and quote the passage. Do not answer',
  '   "unverifiable" merely because the source is prose rather than code.',
  '1c. One file may appear as SEVERAL entries, each an excerpt of a different part of it',
  '   (`windowIndex` of `windowCount`, with its own line range). They are non-contiguous spans of the',
  '   same file, not different files and not a contradiction — a claim comparing two sections is',
  '   verified by reading both entries together.',
  '2. If a cited source is marked `truncated: true` and the defect is not visible in the span shown,',
  '   you MUST answer `method: "unverifiable"` with outcome "needs_triage". Never "dismissed".',
  '   A partial view is not evidence of absence, and a wrong dismissal penalises an arm for being right.',
  '3. If the claim cannot be settled against code at all (it is an opinion, a design preference, or the',
  '   sources do not cover it), answer `method: "unverifiable"` with outcome "needs_triage".',
  '4. `evidence` is mandatory. For "accepted": path, sha, lineRange, quotedSpan. For "dismissed": the same',
  '   plus absenceReason. Leave a field null only when it genuinely does not apply.',
  '5. `method` and `outcome` are separate fields but only THREE pairs are legal:',
  '   verified+accepted, verified+dismissed, unverifiable+needs_triage. "needs_triage" always means',
  '   "unverifiable" — a verdict cannot claim both that the claim was settled against code and that',
  '   nobody decided it. Any other pair is recorded as unverifiable/needs_triage regardless of what you meant.',
  '',
  'Model and provider names have been redacted from the finding text. Do not speculate about which model',
  'wrote it; that information is deliberately withheld and guessing corrupts the measurement.',
].join('\n');

/**
 * The `(method, outcome)` pair contract, as ONE biconditional:
 * **`outcome === 'needs_triage'` if and only if `method === 'unverifiable'`.**
 *
 * That is the three-way protocol of the runbook (§3) written as a predicate —
 * `verified`+`accepted`, `verified`+`dismissed`, `unverifiable`+`needs_triage`,
 * and nothing else — and it is the same rule Postgres enforces as
 * `fae_needs_triage_is_unverifiable_chk`. Stating it here rather than only in
 * the migration is what lets the PRODUCER refuse an incoherent pair instead of
 * discovering it as a constraint name from the driver.
 *
 * Both halves are load-bearing and they fail differently, which is why one
 * predicate covers both rather than a check on the `needs_triage` side alone:
 *
 * - `verified` + `needs_triage` is "I settled it against code and cannot
 *   decide", which is incoherent. The database REFUSES it, so the verdict is
 *   lost — noisily, but lost. Measured live on 2026-08-19 against
 *   `final-review-scoped-2026q3`.
 * - `unverifiable` + `accepted|dismissed` is "I could not settle it, and here
 *   is my decision". **No constraint rejects it**, so it lands in the store and
 *   is COUNTED as evidence for or against an arm — an unverified judgement
 *   wearing a verification's clothes, which is the exact failure the
 *   verify-don't-judge protocol exists to prevent. The silent half is the worse
 *   half.
 *
 * @returns {string|null} the reason the pair is illegal, or null when it is fine
 */
export function verdictPairError({ method, outcome }) {
  const undecided = outcome === 'needs_triage';
  const unsettled = method === 'unverifiable';
  if (undecided === unsettled) return null;
  return undecided
    ? `outcome "needs_triage" requires method "unverifiable" (got ${JSON.stringify(method)}) — `
      + 'an undecided verdict cannot also claim the claim was settled against code'
    : `method "unverifiable" requires outcome "needs_triage" (got ${JSON.stringify(outcome)}) — `
      + 'a verdict reached without settling the claim is not evidence and must route to a human';
}

/**
 * Force an incoherent pair onto the honest hand-off.
 *
 * The coercion is ALWAYS toward `unverifiable`/`needs_triage`, never toward
 * `verified`: the two inputs disagree about whether the claim was settled, and
 * "not settled" is the only reading that cannot manufacture evidence. Promoting
 * `unverifiable`+`accepted` to `verified`+`accepted` would credit an arm on a
 * verdict the instrument itself said it could not support.
 *
 * The reason is written into `evidence.absenceReason` when that field is empty,
 * because the row is about to sit in a human's queue and "why is this here" is
 * the first thing they will ask.
 */
export function coerceVerdictPair(verdict) {
  const reason = verdictPairError(verdict);
  if (!reason) return { verdict, coerced: null };
  const note = `incoherent verdict pair (method ${JSON.stringify(verdict.method)} with outcome `
    + `${JSON.stringify(verdict.outcome)}) — recorded as unverifiable/needs_triage: ${reason}`;
  const evidence = verdict.evidence && typeof verdict.evidence === 'object'
    ? { ...verdict.evidence, absenceReason: verdict.evidence.absenceReason || note }
    : verdict.evidence;
  return { verdict: { ...verdict, method: 'unverifiable', outcome: 'needs_triage', evidence }, coerced: note };
}

/**
 * Validate a raw verdict, with the plan's non-negotiable downgrade: **a verdict
 * with unparseable or missing evidence becomes `unverifiable`/`needs_triage`,
 * not a warning.** An unsupported machine verdict is worth less than an honest
 * hand-off, and a malformed one must never become a silent `pending`.
 *
 * The pair contract is settled HERE, at the parse boundary, and not left to the
 * database: `method` and `outcome` are two independent enums in the tool schema,
 * so the model can return any of the six combinations and the schema alone
 * accepts all of them. Two of the six are illegal (see `verdictPairError`), and
 * only one of those two is caught downstream.
 */
export function normaliseVerdict(raw, { worksheetRowId }) {
  const parsed = AdjudicationVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: `schema: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}` };
  }
  const v = parsed.data;
  if (v.worksheetRowId !== worksheetRowId) {
    // The row id is the ONLY reconciliation key; a mismatched one would file a
    // verdict against the wrong finding.
    return { ok: false, reason: `worksheetRowId mismatch (expected ${worksheetRowId}, got ${v.worksheetRowId})` };
  }
  let verdict = v;
  let note = null;
  if (verdict.method === 'verified') {
    const e = verdict.evidence;
    const missing = ['path', 'sha', 'lineRange', 'quotedSpan'].filter((k) => !e[k]);
    if (verdict.outcome === 'dismissed' && !e.absenceReason) missing.push('absenceReason');
    if (missing.length > 0) {
      verdict = { ...verdict, method: 'unverifiable', outcome: 'needs_triage' };
      note = `verified verdict lacked evidence (${missing.join(', ')}) — downgraded to unverifiable`;
    }
  }
  // AFTER the evidence downgrade, deliberately: a `verified`+`needs_triage`
  // verdict that DOES carry full evidence never enters the branch above, and
  // was the exact shape the database refused in production.
  const paired = coerceVerdictPair(verdict);
  if (paired.coerced) note = note ? `${note}; ${paired.coerced}` : paired.coerced;
  return { ok: true, verdict: paired.verdict, downgraded: note };
}

/** Findings whose outcome routes to the human queue rather than counting. */
export function routesToHumanQueue(verdict) {
  return verdict.method === 'unverifiable' || verdict.outcome === 'needs_triage';
}

/**
 * Render the end-of-batch summary, and DERIVE the exit code from it.
 *
 * A pure function rather than three `process.stdout.write`s in the loop,
 * because the two properties that matter are properties of the arithmetic:
 *
 * **(1) The buckets are disjoint and they close.** The line this replaces read
 * `5 adjudicated · 9 routed to the human queue · 0 provider failure(s)` for a
 * `--limit 10` run — 14 outcomes from 10 rows. `adjudicated` counted every row
 * that got a provider call (including the ones that then routed to a human, so
 * they were counted twice) while the rows forced `unverifiable` before any call
 * were counted ONLY as routed. A summary that overcounts is how a partial run
 * reads as a complete one. Here `settled` and `humanQueue` are disjoint by
 * construction and every attempted row lands in exactly one bucket;
 * `providerFailures` is a SUBSET of `humanQueue` and is reported inline rather
 * than added.
 *
 * **(2) A verdict that failed to record is never silent.** The operator paid a
 * provider for it. It appears in its own bucket, in a block that names it as
 * lost evidence, and it makes the exit code non-zero — `emit({ok:false})`'s
 * contract (cli-io.mjs) applied to a verb that writes its own prose.
 *
 * The balance check is the self-audit: if the buckets do not sum to
 * `attempted`, the summary says so instead of printing a tidy lie.
 *
 * @returns {{lines: string[], exitCode: number, balanced: boolean}}
 */
export function renderAdjudicationSummary({
  attempted, settled = 0, humanQueue = 0, providerFailures = 0,
  unrecorded = 0, skipped = 0, previewed = 0, previewForced = 0, aborted = false, dryRun = false,
}) {
  const accounted = settled + humanQueue + unrecorded + skipped + previewed;
  const notReached = attempted - accounted;
  // `aborted` is the ONLY legitimate way a row goes unaccounted: the batch
  // stopped before reaching it. Anything else is an arithmetic bug in this
  // loop, and it is reported as one.
  const balanced = notReached === 0 || (aborted && notReached > 0);

  const lines = [];
  const parts = [];
  if (dryRun) {
    // The number an operator is previewing is SPEND, so the rows that would be
    // forced `unverifiable` without a provider call are named separately —
    // they cost nothing and they are not evidence either.
    parts.push(`${previewed - previewForced} would be sent to the adjudicator`);
    parts.push(`${previewForced} would be forced unverifiable with no provider call`);
  }
  else {
    parts.push(`${settled} settled as evidence`);
    parts.push(`${humanQueue} routed to the human queue${providerFailures > 0 ? ` (${providerFailures} provider failure(s))` : ''}`);
  }
  if (unrecorded > 0) parts.push(`${unrecorded} FAILED TO RECORD`);
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (aborted && notReached > 0) parts.push(`${notReached} not reached (batch aborted)`);
  lines.push(`  ${attempted} row(s) attempted: ${parts.join(' · ')}`);

  if (unrecorded > 0) {
    lines.push(`  ${unrecorded} verdict(s) were produced and could NOT be stored. That is paid-for evidence lost:`);
    lines.push('    the campaign\'s accepted counts are INCOMPLETE until those rows are re-adjudicated.');
    lines.push('    Their receipts stay in state `complete` (paid, unrecorded) — `campaign.mjs reconcile` lists them.');
  }
  if (!balanced) {
    lines.push(`  ACCOUNTING BUG: ${accounted} row(s) accounted for against ${attempted} attempted `
      + `(${notReached > 0 ? `${notReached} unaccounted` : `${-notReached} double-counted`}) — `
      + 'this summary is not trustworthy; treat the run as partial.');
  }
  return { lines, exitCode: unrecorded > 0 || !balanced ? 1 : 0, balanced };
}

/**
 * Cluster one snapshot's findings across ALL arms.
 *
 * `matchFindings` is pairwise (a primary against a shadow), so N arms are
 * clustered by running every arm pair through it and unioning the accepted
 * pairs. That is a faithful generalisation rather than a new matcher: the
 * threshold, the file-sharing conjunction and the deterministic tiebreak are
 * unchanged, and one-to-one within each pair still holds. Transitive closure
 * across pairs is deliberate — if A matches B and B matches C, the three are
 * one defect, and splitting them would double-count the denominator.
 *
 * **Refuses rather than guesses.** A snapshot whose findings yield no resolvable
 * file paths gets `coverage: 'unknown'` and NO cluster set — plan-mode findings
 * cite `§`-sections, so `affectedFilesOf` has nothing to intersect and the
 * prefilter can never fire. `verdict.mjs` then watermarks, which is the honest
 * outcome; writing a cluster set from an unusable match would silently revert to
 * the pre-matcher behaviour that made "unique" mean "total".
 *
 * **Within-arm dedup runs too, at its OWN threshold.** §2.5c-i states the rule —
 * "same defect raised twice within one arm ... counts once. Otherwise a verbose
 * arm inflates itself" — and it was not implemented: the loop below iterated
 * `i < k` over DISTINCT arms, so two findings from one arm could only ever land
 * in one cluster via a transitive bridge through a third. Measured 2026-08-10:
 * two byte-identical findings from one arm, same file, produced 2 clusters at
 * every threshold from 0.00 to 0.50. The stated anti-inflation rule was prose
 * next to a loop that could not enforce it.
 *
 * The two passes take DIFFERENT thresholds because they are different questions.
 * Cross-model matching is hard (two vocabularies, ~17% signature overlap, hence
 * 0.14); within-arm matching is easy (one voice), so both its distributions sit
 * higher and 0.14 there would merge distinct defects that merely share a file —
 * under-counting the arm, the inverse of the inflation the rule targets. See
 * `findingMatchConfig.withinArmThreshold` for why that number is UNCALIBRATED
 * and why shipping it uncalibrated is acceptable.
 *
 * @param {Array<{findingId: string, armId: string, section: string|null, category: string|null, detail: string|null, severity: string}>} findings
 * @param {{threshold: number, coverageFloor: number, withinArmThreshold?: number}} opts
 */
export function clusterSnapshotFindings(findings, { threshold, coverageFloor, withinArmThreshold = null }) {
  const rows = (findings || []).filter(Boolean);
  if (rows.length === 0) return { coverage: 'unknown', reason: 'no findings', clusters: [] };

  // LOCUS coverage, not file coverage: a plan-mode finding cites a `§`-section
  // rather than a path, and measuring it as "no key" is what made this floor
  // unreachable for a plan-mode campaign — five complete snapshots refused at
  // 0.31–0.65 against a 0.6 floor, so the attribution gate could never pass.
  const located = rows.filter((r) => affectedLociOf({ section: r.section }).length > 0);
  const coverage = located.length / rows.length;
  if (coverage < coverageFloor) {
    return {
      coverage: 'unknown', clusters: [],
      reason: `only ${located.length}/${rows.length} findings cite a resolvable file path or §-section (floor ${coverageFloor}) — `
        + 'the file-set prefilter cannot fire, so no attribution is possible for this snapshot',
    };
  }

  const byArm = new Map();
  for (const r of rows) {
    if (!byArm.has(r.armId)) byArm.set(r.armId, []);
    // `_hash` is the finding id, so the matcher's pairs map straight back.
    byArm.get(r.armId).push({ _hash: r.findingId, section: r.section, category: r.category, detail: r.detail });
  }

  const parent = new Map(rows.map((r) => [r.findingId, r.findingId]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb); };

  const armIds = [...byArm.keys()].sort();
  for (let i = 0; i < armIds.length; i += 1) {
    for (let k = i + 1; k < armIds.length; k += 1) {
      const res = matchFindings(byArm.get(armIds[i]), byArm.get(armIds[k]), { threshold, coverageFloor });
      for (const pair of res.pairs) union(pair.primaryHash, pair.shadowHash);
    }
  }

  // WITHIN-arm pass. `matchFindings` is one-to-one and would refuse to compare a
  // list against itself meaningfully, so each arm's findings are split into two
  // halves-by-position and matched pairwise across every ordered split — every
  // unordered pair within the arm is considered exactly once, through the same
  // matcher, with the same file-sharing conjunction and deterministic tiebreak.
  if (withinArmThreshold != null) {
    for (const armId of armIds) {
      const list = byArm.get(armId);
      for (let i = 0; i < list.length; i += 1) {
        for (let k = i + 1; k < list.length; k += 1) {
          const res = matchFindings([list[i]], [list[k]], { threshold: withinArmThreshold, coverageFloor });
          for (const pair of res.pairs) union(pair.primaryHash, pair.shadowHash);
        }
      }
    }
  }

  const groups = new Map();
  for (const r of rows) {
    const root = find(r.findingId);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  }
  // Both the cluster order and the MEMBER order are sorted by finding id.
  // Sorting the clusters alone is not enough: `groups` is built by iterating
  // `rows`, so a differently-ordered input produced identically-partitioned
  // clusters whose member arrays were permuted — two runs over one snapshot
  // that agree on the answer and disagree on the bytes, which is the shape that
  // makes a "deterministic" claim quietly false.
  const clusters = [...groups.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([root, members]) => ({
      canonicalFindingId: root,
      members: members
        .map((m) => ({ findingId: m.findingId, armId: m.armId, severity: m.severity }))
        .sort((a, b) => (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0)),
    }));
  return { coverage, clusters, reason: null };
}
