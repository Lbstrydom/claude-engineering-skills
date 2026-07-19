/**
 * The pure triage router (D1, D3b).
 *
 * Plan: docs/plans/sast-triage-routing.md — Phase 2.
 *
 * **Pure — no I/O.** It consumes whatever the Phase-3 adapter produced and
 * performs no filesystem contact of its own, mirroring `evidence-triage.mjs`.
 *
 * D1 is the load-bearing contract: predicates ROUTE, they never delete. The
 * output contains every ingested finding exactly once, each carrying its bucket
 * and a machine-readable reason. A wrong predicate therefore costs *rank*, not
 * a missed vulnerability — a wrong suppression would be INC-002 again.
 */
import { z } from 'zod';
import {
  NormalizedFindingSchema,
  FindingLocationSchema,
  BOUND_DEFAULTS,
  BUCKETS,
} from './sarif.mjs';
import { PREDICATE_KINDS, PREDICATES } from './predicates.mjs';

/**
 * Review priority, not confidence (D2). `A` first because it is unexplained;
 * `C` sits deliberately ABOVE `D` because `sanitizer-wrapped` is the predicate
 * that can be wrong in the dangerous direction, so it never reaches the bottom
 * bucket. Mirrors `SCOPE_BUCKET_RESTRICTIVENESS` in `evidence-triage.mjs`.
 */
export const BUCKET_RESTRICTIVENESS = Object.freeze({ A: 0, C: 1, D: 2 });

const RoutableLocationSchema = FindingLocationSchema.extend({
  canonicalPath: z.string(),
  repoRelativePath: z.string(),
  pathClassification: z.enum(['ok', 'sensitive', 'unresolved', 'escaped']),
});

/**
 * The router's entry contract. Distinct from `NormalizedFinding` because the
 * three adapter-supplied fields are filesystem-derived: keeping them in one
 * schema would let a caller assume Phase 1 had produced them.
 *
 * `sourceLines` is source from **line 1** through the last line any finding in
 * that file needs — not just the window — because whether the window opens
 * inside a block comment or template is undecidable from the window alone
 * (D3a2). It is stripped from the report.
 */
export const RoutableFindingSchema = NormalizedFindingSchema.extend({
  location: RoutableLocationSchema.nullable(),
  sinkLocation: RoutableLocationSchema.nullable(),
  sourceLines: z.array(z.string()).nullable().optional(),
});

/**
 * Route every finding into exactly one bucket.
 *
 * @param {object[]} findings adapter-enriched findings
 * @param {object} config validated `ConfigSchema`
 * @param {{bounds?: object}} [opts]
 * @returns {{findings: object[], counts: {A:number,C:number,D:number},
 *            unusedPredicates: string[], diagnostics: string[]}}
 */
export function routeFindings(findings, config, opts = {}) {
  const bounds = opts.bounds || BOUND_DEFAULTS;
  const diagnostics = [];
  const matchedKinds = new Set();
  const counts = { A: 0, C: 0, D: 0 };
  const out = [];

  for (const raw of findings || []) {
    // A shape violation here is an adapter bug, not untrusted input. Throwing
    // is the honest response: silently routing a malformed finding would let a
    // missing `pathClassification` read as a successful evaluation.
    const parsed = RoutableFindingSchema.safeParse(raw);
    if (!parsed.success) {
      throw new TypeError(
        `routeFindings: finding ${raw?.findingId ?? '<unknown>'} does not satisfy RoutableFindingSchema: ${parsed.error.message}`,
      );
    }
    const finding = parsed.data;
    const matches = [];

    const blocked = sensitivityBlock(finding);
    if (blocked) {
      // Gemini G1 — a genuine security-invariant bypass. `contextWithheld`
      // alone could NOT carry this: it is also set for a merely *large* file,
      // which is legitimately demotable. So a `.env` finding whose path
      // happened to match a broad `nonReachableGlobs` entry would have been
      // demoted to `D`, silently bypassing the bucket-`A` review SC2 promises.
      // Sensitivity is an explicit, separate input, checked BEFORE any
      // predicate runs.
      matches.push({ predicate: 'sensitivity-guard', matched: false, reason: blocked });
      out.push(emit(finding, 'A', matches));
      counts.A++;
      continue;
    }

    for (const kind of PREDICATE_KINDS) {
      let result = null;
      try {
        result = PREDICATES[kind](finding, config, bounds);
      } catch (err) {
        // A predicate that throws has not evaluated anything; it must not be
        // able to take the run down, and it must not demote.
        diagnostics.push(`predicate-error:${kind}:${finding.findingId}:${err.message}`);
        result = null;
      }
      if (!result) {
        matches.push({ predicate: kind, matched: false, reason: 'no-match' });
        continue;
      }
      if (result.bucket == null) {
        matches.push({ predicate: kind, matched: false, reason: result.reason });
        continue;
      }
      matchedKinds.add(kind);
      matches.push({ predicate: kind, matched: true, reason: result.reason, bucket: result.bucket });
    }

    const bucket = selectBucket(matches);
    out.push(emit(finding, bucket, matches));
    counts[bucket]++;
  }

  return {
    findings: out,
    counts,
    unusedPredicates: PREDICATE_KINDS.filter((k) => !matchedKinds.has(k)),
    diagnostics,
  };
}

/**
 * The most conservative (lowest-lettered) bucket among the matches (D3b), so a
 * finding matching both `sanitizer-wrapped` (`C`) and `path-scope` (`D`) lands
 * in `C`. Ties are impossible: the ordering is total. No match → `A`.
 */
export function selectBucket(matches) {
  // The minimum is taken over the MATCHED buckets only, then defaulted —
  // seeding `best` with the default `A` instead would make it absorbing (`A`
  // is the most restrictive), so no match could ever win and every finding
  // would route to `A`. Mirrors `resolveScopeBucketForFinding`.
  let best = null;
  for (const m of matches) {
    if (!m.matched || !m.bucket) continue;
    if (best === null || BUCKET_RESTRICTIVENESS[m.bucket] < BUCKET_RESTRICTIVENESS[best]) {
      best = m.bucket;
    }
  }
  return best ?? 'A';
}

/**
 * Non-`ok` classification on EITHER the primary or the sink path blocks every
 * predicate. Checking both is deliberate: a demotion decided from the primary
 * path while the sink lives in a credential file would hide exactly the finding
 * SC2 promises a human will read.
 */
function sensitivityBlock(finding) {
  if (!finding.location) return 'location-null';
  const primary = finding.location.pathClassification;
  if (primary !== 'ok') return `primary-path-${primary}`;
  if (finding.sinkLocation && finding.sinkLocation.pathClassification !== 'ok') {
    return `sink-path-${finding.sinkLocation.pathClassification}`;
  }
  return null;
}

function emit(finding, bucket, matches) {
  // `sourceLines` is predicate input, never report output — it is unredacted
  // file content and the report gets pasted into issues, PRs, and chat.
  const { sourceLines, ...rest } = finding;
  if (!BUCKETS.includes(bucket)) {
    /* c8 ignore next 2 -- guarded by selectBucket's closed domain */
    throw new RangeError(`routeFindings: illegal bucket ${bucket}`);
  }
  return { ...rest, bucket, matches };
}
