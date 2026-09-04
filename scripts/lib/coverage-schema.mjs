/**
 * @fileoverview `CoverageSchema` — the observed-graph coverage contract.
 *
 * Lives in `shared-lib` because it is a CONTRACT consumed by two domains:
 * `arch-memory` produces coverage records ([`observed-deps.mjs`](./observed-deps.mjs))
 * and `stores` validates them at the write boundary
 * ([`store/arch/coverage.mjs`](./store/arch/coverage.mjs)). Keeping it in the producer
 * made that an undeclared `stores -> arch-memory` edge — persistence depending on
 * architecture-observation internals rather than on a shared contract.
 *
 * Moved here 2026-07-31; the original export was REMOVED rather than re-exported, so a
 * consumer cannot silently recreate the edge. Plan:
 * docs/plans/layering-and-mutation-contracts.md (L1).
 *
 * @module scripts/lib/coverage-schema
 */

import { z } from 'zod';

/**
 * Coverage block — §2.1.6b of the coverage-honesty plan.
 *
 * OPTIONAL by design. Every envelope written before this feature lacks it, and
 * those must keep parsing; the reader maps an absent block to
 * `unknown`/`not_measured`, never to `verified` (absence is not evidence of
 * cleanliness). `schemaVersion` is present from day one so a future shape
 * change is a version bump rather than a guess at the reader.
 *
 * Counts are `.nullable()` because a failed or timed-out extraction has NO
 * measurement — null, not 0. Zero is a measurement; conflating the two is how
 * a failed cruise reads as an empty repo.
 */
export const CoverageSchema = z.object({
  schemaVersion: z.literal(1),
  verdict: z.object({
    status: z.enum(['verified', 'degraded', 'unverified', 'unknown']),
    // Closed enum, not z.string() — matches graph-verdict.mjs's GRAPH_REASON
    // and the symbol_refresh_coverage table's own CHECK constraint literally
    // (duplicated rather than imported for the same cross-domain reason as
    // the superRefine above: shared-lib cannot depend on arch-memory).
    // Round-3 audit M2: an unconstrained string let an invalid reason cross
    // the application-schema boundary and rely on the DB CHECK constraint as
    // the only backstop, surfacing as a less-informative 'db-error' instead
    // of 'schema-invalid' at the earliest validation point.
    //
    // fp=d0c0d2ba (2026-08-20): the duplication above is exactly what let
    // this list drift out from under GRAPH_REASON — `malformed_measurement`
    // (graph-verdict.mjs's row 11, a genuinely reachable verdict whenever
    // extraction.elapsedMs/ratio or attribution.ratio comes back non-finite)
    // was never added here. `recordGraphCoverage`'s `safeParse` silently
    // refused to persist that verdict (`schema-invalid`), and
    // `render-mermaid.mjs`'s `ObservedDepsSchema.parse(envelope)` — a
    // THROWING parse — crashed `arch:render` outright the one time this path
    // was actually live. `tests/graph-reason-parity.test.mjs` now asserts
    // this array's values equal `Object.values(GRAPH_REASON)` so the next
    // reason added to graph-verdict.mjs fails a test here instead of drifting
    // silently again.
    reason: z.enum([
      'extraction_failed', 'extraction_timeout', 'not_measured',
      'stale_measurement', 'empty_universe', 'zero_cruised',
      'zero_attributed', 'budget_exceeded', 'below_floor',
      'below_attribution_floor', 'malformed_measurement',
    ]).nullable(),
  }),
  measuredAt: z.iso.datetime(),
  refreshId: z.string().min(1),
  stale: z.boolean(),
  extraction: z.object({
    outcome: z.enum(['ok', 'failed', 'timedOut']),
    eligible: z.number().int().nonnegative().nullable(),
    cruised: z.number().int().nonnegative().nullable(),
    ratio: z.number().min(0).max(1).nullable(),
    elapsedMs: z.number().nonnegative().nullable(),
    edges: z.object({
      external: z.number().int().nonnegative(),
      selfEdge: z.number().int().nonnegative(),
      escaping: z.number().int().nonnegative(),
      // Added 2026-09-04 with the filters that produce them. `.optional()`
      // rather than required: every envelope written before that date lacks
      // them, and a write-boundary schema that rejects the historical shape
      // turns a read of old data into a `schema-invalid` error rather than a
      // read.
      //
      // **Deliberately NOT `.default(0)`.** An earlier draft defaulted them,
      // reasoning that 0 is arithmetically consistent with the old
      // exhaustivity sum (back then such an edge landed in another bucket).
      // That is true and beside the point: it makes a claim about history
      // that a reader cannot tell apart from a measurement, so "this run
      // never counted disowned edges" would render as "this run found no
      // disowned edges" — the false zero this whole change exists to remove,
      // written into its own schema. Absent stays absent; every current
      // producer emits all six via `normalizeEdgeBuckets`, and
      // `assertExtractionExhaustive` already sums with `?? 0` so a historical
      // envelope still reconciles.
      unresolved: z.number().int().nonnegative().optional(),
      disowned: z.number().int().nonnegative().optional(),
      persisted: z.number().int().nonnegative(),
    }).nullable(),
    // Which eligible files this dep-cruiser install has no parser for.
    // `null` on a failed/timed-out extraction (no measurement at all);
    // `known:false` when the producer could not ask dep-cruiser — never
    // absent-meaning-fine. Optional for the same back-compat reason as the
    // two edge buckets above.
    parser: z.object({
      known: z.boolean(),
      unavailableExtensions: z.array(z.string()),
      unparseable: z.number().int().nonnegative().nullable(),
      byExtension: z.record(z.string(), z.number().int().nonnegative()),
    }).nullable().optional(),
    samples: z.object({ uncruised: z.array(z.string()) }),
  }).nullable(),
  attribution: z.object({
    candidates: z.number().int().nonnegative(),
    attributed: z.number().int().nonnegative(),
    attributable: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
    edges: z.object({
      malformed: z.number().int().nonnegative(),
      untaggedFrom: z.number().int().nonnegative(),
      untaggedTo: z.number().int().nonnegative(),
      untaggedBoth: z.number().int().nonnegative(),
      sameDomain: z.number().int().nonnegative(),
      attributed: z.number().int().nonnegative(),
    }),
    samples: z.object({ untagged: z.array(z.string()) }),
  }).nullable(),
}).superRefine((val, ctx) => {
  // ── Arithmetic coherence — runs BEFORE the precedence chain below ──────────
  //
  // Placement is load-bearing: the chain below is FIRST-MATCH-WINS and `return`s,
  // so a check placed inside it would be skipped for every record that matches an
  // earlier row. These are unconditional invariants about the numbers themselves,
  // orthogonal to which verdict they justify, so they run first and never return.
  //
  // They codify what the producer already guarantees rather than inventing a new
  // rule — `graph-coverage.mjs` only counts a file as `cruised` if it is in the
  // eligible set, and computes `ratio` as exact unrounded division — so no real
  // record can fail them. What they catch is a future producer regression or a
  // hand-crafted payload, which is exactly what a write-boundary schema is for.
  {
    const ex = val?.extraction;
    if (ex && ex.eligible != null && ex.cruised != null && ex.cruised > ex.eligible) {
      ctx.addIssue({
        code: 'custom', path: ['extraction', 'cruised'],
        message: `extraction.cruised (${ex.cruised}) cannot exceed extraction.eligible (${ex.eligible}) — a file is only counted as cruised when it is in the eligible set`,
      });
    }
    // Tolerance, not equality: `ratio` is a float division, so an exact `===`
    // would reject records over a rounding artefact rather than a real defect.
    const EPS = 1e-9;
    // `ex.eligible` truthiness would SKIP the check when eligible is 0 — letting
    // `{eligible:0, cruised:0, ratio:0.99}` through, a mathematically impossible
    // payload. Zero is a real, reachable state (empty universe), and the producer
    // emits `ratio: null` for it, so the rule is: no denominator ⇒ no ratio.
    // `!(eligible > 0)` covers BOTH zero and null in one predicate. Writing it
    // as `=== 0` left `eligible: null` falling through both branches — the
    // nullable case exists precisely for a failed/timed-out extraction, which by
    // definition has NO measurement, so a non-null ratio there is the most
    // contradictory payload of all: a coverage figure from a run that never
    // measured anything.
    if (ex && ex.ratio != null && !(ex.eligible > 0)) {
      ctx.addIssue({
        code: 'custom', path: ['extraction', 'ratio'],
        message: `extraction.ratio must be null when eligible is ${ex.eligible === null ? 'null (no measurement)' : '0 (no denominator)'} — got ${ex.ratio}`,
      });
    }
    if (ex && ex.ratio != null && ex.eligible > 0) {
      const expected = ex.cruised / ex.eligible;
      if (Math.abs(ex.ratio - expected) > EPS) {
        ctx.addIssue({
          code: 'custom', path: ['extraction', 'ratio'],
          message: `extraction.ratio (${ex.ratio}) disagrees with cruised/eligible (${expected}) — a ratio that does not follow from its own counts is not evidence`,
        });
      }
    }
    // A file can only be unparseable if it was eligible in the first place —
    // `assessParserAvailability` counts a SUBSET of the eligible list. A
    // payload claiming more unparseable files than eligible ones is arithmetic
    // nonsense, and it is the shape a hand-built or half-migrated record takes.
    if (ex && ex.parser && ex.parser.unparseable != null && ex.eligible != null
      && ex.parser.unparseable > ex.eligible) {
      ctx.addIssue({
        code: 'custom', path: ['extraction', 'parser', 'unparseable'],
        message: `extraction.parser.unparseable (${ex.parser.unparseable}) cannot exceed extraction.eligible (${ex.eligible}) — unparseable files are a subset of the eligible universe`,
      });
    }
    const at = val?.attribution;
    if (at && at.attributed > at.attributable) {
      ctx.addIssue({
        code: 'custom', path: ['attribution', 'attributed'],
        message: `attribution.attributed (${at.attributed}) cannot exceed attribution.attributable (${at.attributable}) — attributable is defined as attributed plus the untagged buckets`,
      });
    }
    if (at && at.ratio != null && !(at.attributable > 0)) {
      ctx.addIssue({
        code: 'custom', path: ['attribution', 'ratio'],
        message: `attribution.ratio must be null when attributable is ${at.attributable} — no denominator, got ${at.ratio}`,
      });
    }
    if (at && at.ratio != null && at.attributable > 0) {
      const expected = at.attributed / at.attributable;
      if (Math.abs(at.ratio - expected) > EPS) {
        ctx.addIssue({
          code: 'custom', path: ['attribution', 'ratio'],
          message: `attribution.ratio (${at.ratio}) disagrees with attributed/attributable (${expected})`,
        });
      }
    }
  }

  // Cross-field trust-precedence check, mirroring graph-verdict.mjs's
  // rows 1-4 (the config-INDEPENDENT precedence rows only — rows 8-10
  // depend on the per-repo floor/budget config and are deliberately NOT
  // re-validated here, since a legitimate config difference between
  // measurement time and validation time could otherwise reject a real
  // record). Not importing graph-verdict.mjs directly: this module is
  // `shared-lib` domain and graph-verdict.mjs is `arch-memory` domain;
  // domain-map.json's allowedDeps only permits arch-memory -> shared-lib,
  // not the reverse, so the literal checks below are duplicated on purpose
  // rather than crossing that boundary.
  // These four checks are FIRST-MATCH-WINS, mirroring graph-verdict.mjs's own
  // precedence order exactly (extraction failure/timeout is rows 1-2, checked
  // BEFORE staleness at row 4) — not independent ANDed constraints (round-1
  // audit H2). A copied-forward row whose prior measurement never succeeded
  // (extraction.outcome 'failed'/'timedOut') is real and reachable —
  // copyForwardCoverage preserves that verdict rather than downgrading it to
  // stale_measurement — so checking `stale` unconditionally alongside the
  // extraction-outcome checks would demand verdict.status be BOTH 'unknown'
  // AND 'unverified' simultaneously for that exact record, an impossible
  // requirement that would reject a legitimate persisted shape.
  const { verdict, stale, extraction, attribution } = val;
  // Mirrors symbol_refresh_coverage's own CHECK constraint bit-for-bit:
  // (status = 'verified') = (reason IS NULL). 'verified' is the only status
  // that may carry no reason, and it must not carry one — every other
  // status names exactly why.
  if ((verdict.status === 'verified') !== (verdict.reason === null)) {
    ctx.addIssue({ code: 'custom', path: ['verdict', 'reason'], message: `verdict.status==='verified' iff verdict.reason===null (matches the symbol_refresh_coverage table's own CHECK constraint) — got status="${verdict.status}", reason=${JSON.stringify(verdict.reason)}` });
    return;
  }
  // Each branch below checks BOTH status AND the specific reason literal
  // that row names in graph-verdict.mjs (round-4 audit M1/M2) — checking
  // status alone let a mismatched-but-enum-valid reason through, e.g.
  // {extraction.outcome:'failed', status:'unverified', reason:'zero_cruised'}
  // would have passed despite 'zero_cruised' not being what a failed
  // extraction actually produces.
  if (extraction?.outcome === 'failed') {
    if (verdict.status !== 'unverified' || verdict.reason !== 'extraction_failed') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.outcome==='failed' requires verdict={status:'unverified',reason:'extraction_failed'} (checked before staleness, matching graph-verdict.mjs's precedence), got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (extraction?.outcome === 'timedOut') {
    if (verdict.status !== 'unverified' || verdict.reason !== 'extraction_timeout') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.outcome==='timedOut' requires verdict={status:'unverified',reason:'extraction_timeout'} (checked before staleness, matching graph-verdict.mjs's precedence), got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (stale === true) {
    if (verdict.status !== 'unknown' || verdict.reason !== 'stale_measurement') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `stale===true requires verdict={status:'unknown',reason:'stale_measurement'} — a copied-forward row whose prior measurement succeeded can never read verified/degraded/unverified, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (extraction == null) {
    if (verdict.status !== 'unknown' || verdict.reason !== 'not_measured') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `a null extraction (pre-feature envelope) requires verdict={status:'unknown',reason:'not_measured'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  // Rows 5-7 (round-5 audit H3/H5): the vacuity guards are ALSO
  // config-independent — they reference only extraction.eligible/cruised and
  // attribution.attributable/attributed, never `config` — so the earlier
  // "rows 8-10 depend on config, deliberately not re-validated" note was
  // over-broad; only rows 8-10 (budget/floor thresholds) actually need a
  // config value this schema doesn't have access to. Rows 5-7 can and must
  // be checked here too, closing the full config-independent precedence
  // chain (rows 1-7) rather than stopping partway through it.
  if (!extraction.eligible) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'empty_universe') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.eligible falsy requires verdict={status:'unverified',reason:'empty_universe'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (!extraction.cruised) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'zero_cruised') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `extraction.cruised falsy requires verdict={status:'unverified',reason:'zero_cruised'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
    return;
  }
  if (attribution && attribution.attributable > 0 && attribution.attributed === 0) {
    if (verdict.status !== 'unverified' || verdict.reason !== 'zero_attributed') {
      ctx.addIssue({ code: 'custom', path: ['verdict'], message: `attribution.attributable>0 with attribution.attributed===0 requires verdict={status:'unverified',reason:'zero_attributed'}, got status="${verdict.status}" reason=${JSON.stringify(verdict.reason)}` });
    }
  }
  // Remaining reachable cases (a genuinely non-vacuous extraction/attribution)
  // fall through to graph-verdict.mjs's config-DEPENDENT rows 8-10 (budget/
  // floor/attribution-floor thresholds) — deliberately not re-validated
  // here, since a legitimate per-repo config difference between measurement
  // time and validation time could otherwise reject a real record.
});
