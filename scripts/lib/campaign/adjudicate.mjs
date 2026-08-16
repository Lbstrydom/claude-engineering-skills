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
import { matchFindings, affectedFilesOf } from '../finding-match.mjs';

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
  '2. If a cited source is marked `truncated: true` and the defect is not visible in the span shown,',
  '   you MUST answer `method: "unverifiable"` with outcome "needs_triage". Never "dismissed".',
  '   A partial view is not evidence of absence, and a wrong dismissal penalises an arm for being right.',
  '3. If the claim cannot be settled against code at all (it is an opinion, a design preference, or the',
  '   sources do not cover it), answer `method: "unverifiable"` with outcome "needs_triage".',
  '4. `evidence` is mandatory. For "accepted": path, sha, lineRange, quotedSpan. For "dismissed": the same',
  '   plus absenceReason. Leave a field null only when it genuinely does not apply.',
  '',
  'Model and provider names have been redacted from the finding text. Do not speculate about which model',
  'wrote it; that information is deliberately withheld and guessing corrupts the measurement.',
].join('\n');

/**
 * Validate a raw verdict, with the plan's non-negotiable downgrade: **a verdict
 * with unparseable or missing evidence becomes `unverifiable`/`needs_triage`,
 * not a warning.** An unsupported machine verdict is worth less than an honest
 * hand-off, and a malformed one must never become a silent `pending`.
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
  if (v.method === 'verified') {
    const e = v.evidence;
    const missing = ['path', 'sha', 'lineRange', 'quotedSpan'].filter((k) => !e[k]);
    if (v.outcome === 'dismissed' && !e.absenceReason) missing.push('absenceReason');
    if (missing.length > 0) {
      return {
        ok: true,
        verdict: { ...v, method: 'unverifiable', outcome: 'needs_triage' },
        downgraded: `verified verdict lacked evidence (${missing.join(', ')}) — downgraded to unverifiable`,
      };
    }
  }
  return { ok: true, verdict: v, downgraded: null };
}

/** Findings whose outcome routes to the human queue rather than counting. */
export function routesToHumanQueue(verdict) {
  return verdict.method === 'unverifiable' || verdict.outcome === 'needs_triage';
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

  const withFiles = rows.filter((r) => affectedFilesOf({ section: r.section }).length > 0);
  const coverage = withFiles.length / rows.length;
  if (coverage < coverageFloor) {
    return {
      coverage: 'unknown', clusters: [],
      reason: `only ${withFiles.length}/${rows.length} findings cite a resolvable file path (floor ${coverageFloor}) — `
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
