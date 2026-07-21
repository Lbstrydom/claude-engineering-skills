/**
 * @fileoverview Semantic re-raise suppression — promote the pgvector prototype
 * (docs/research/pgvector-clustering-prototype.md) into a working suppressor.
 *
 * The problem it solves (measured, not assumed): a real finding re-raised across
 * audit RUNS with different wording gets a fresh fingerprint AND low trigram
 * overlap, so neither the fingerprint dedup nor the ledger's Jaccard suppression
 * collapses it — the store accumulates N duplicate OPEN rows for one issue (the
 * prototype found ~75 such pairs on this repo). Cosine over `detail_snapshot`
 * embeddings catches those reworded re-raises (cos 0.93–0.97 where trigram sits
 * just under its 0.5 cutoff).
 *
 * WHAT IT SUPPRESSES, AND WHAT IT DOES NOT. This dedups the STORE — it stops a
 * new audit_findings row being written when an equivalent OPEN finding already
 * exists for the same repo+file. It does NOT hide the finding from the current
 * audit's user-facing report; the audit still tells you about the issue. Only
 * the redundant learning-store row is suppressed. That distinction is the whole
 * safety argument: a false suppression costs a duplicate store row, never a
 * missed bug in the report.
 *
 * CONSERVATIVE BY CONSTRUCTION (suppression hides data, so the bar is high):
 *   - same primary_file REQUIRED (a re-raise is about the same file);
 *   - a HIGH cosine threshold (default 0.92, well above the 0.85 the prototype
 *     used for MEASURING — measuring tolerates recall-for-precision, suppression
 *     does not);
 *   - only suppresses against OPEN findings (not dismissed/fixed — those are the
 *     ledger's job, and re-raising a fixed-then-regressed finding must survive);
 *   - never cross-repo;
 *   - every suppression is logged with the target it matched (the "audit your
 *     success paths" doctrine — a silent suppressor is unauditable).
 *
 * @module scripts/lib/audit/semantic-suppression
 */
import { normalizePath } from '../file-io.mjs';

/**
 * The pure suppression decision: given a candidate finding and its nearest
 * OPEN semantic neighbour, decide whether the candidate is a re-raise to
 * suppress. No I/O — the caller supplies the neighbour (from `nearestOpenReRaise`).
 *
 * @param {{primaryFile?: string}} candidate
 * @param {{finding_id: string, cosine: number, primary_file: string}|null} neighbour
 * @param {{threshold: number, requireSameFile: boolean}} opts
 * @returns {{suppress: boolean, reason: string, matchedId?: string, cosine?: number}}
 */
export function decideReRaise(candidate, neighbour, { threshold, requireSameFile }) {
  if (!neighbour) return { suppress: false, reason: 'no-neighbour' };
  if (typeof neighbour.cosine !== 'number' || Number.isNaN(neighbour.cosine)) {
    return { suppress: false, reason: 'no-cosine' };
  }
  if (neighbour.cosine < threshold) {
    return { suppress: false, reason: 'below-threshold', cosine: neighbour.cosine };
  }
  if (requireSameFile) {
    const a = normalizePath(candidate?.primaryFile || candidate?._primaryFile || candidate?.section || '');
    const b = normalizePath(neighbour.primary_file || '');
    if (!a || !b || a !== b) {
      return { suppress: false, reason: 'different-file', cosine: neighbour.cosine };
    }
  }
  return { suppress: true, reason: 're-raise', matchedId: neighbour.finding_id, cosine: neighbour.cosine };
}

/** Cosine similarity of two equal-length vectors. Returns NaN on length/zero-norm mismatch. */
export function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) return NaN;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return NaN;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Greedy re-raise clustering (PURE — JS cosine, no I/O). Processes findings
 * OLDEST-first; each finding either joins the first earlier cluster whose
 * canonical it is a re-raise of (per `decideReRaise`), or starts its own. The
 * canonical is the OLDEST member — the original raising — so the suppression
 * keeps the finding with the most history and dismisses the reworded repeats.
 *
 * Oldest-canonical is load-bearing: it makes the clustering ORDER-INDEPENDENT
 * for a fixed input (ties broken by id), and it never suppresses an older
 * finding in favour of a newer reword.
 *
 * @param {Array<{id:string, primaryFile?:string, createdAt?:string|number, embedding:number[]}>} findings
 * @param {{threshold:number, requireSameFile:boolean}} opts
 * @returns {Array<{canonical:object, duplicates:object[]}>} every cluster
 *   (singletons included); the caller filters to `duplicates.length > 0` to act.
 */
export function greedyReRaiseClusters(findings, { threshold, requireSameFile }) {
  const ordered = [...findings].sort((x, y) => {
    const cx = x.createdAt ? new Date(x.createdAt).getTime() : 0;
    const cy = y.createdAt ? new Date(y.createdAt).getTime() : 0;
    if (cx !== cy) return cx - cy;
    return String(x.id) < String(y.id) ? -1 : String(x.id) > String(y.id) ? 1 : 0;
  });
  const clusters = [];
  for (const f of ordered) {
    let joined = null;
    for (const c of clusters) {
      const cos = cosine(f.embedding, c.canonical.embedding);
      const d = decideReRaise(
        { primaryFile: f.primaryFile },
        { finding_id: c.canonical.id, cosine: cos, primary_file: c.canonical.primaryFile },
        { threshold, requireSameFile },
      );
      if (d.suppress) { joined = c; break; }
    }
    if (joined) joined.duplicates.push(f);
    else clusters.push({ canonical: f, duplicates: [] });
  }
  return clusters;
}

/**
 * Format a candidate embedding as a pgvector literal `[0.1,0.2,…]`. Mirrors the
 * symbol_embeddings writer — a JS array binds as a Postgres array, which the
 * `vector` type rejects, so the caller casts `$n::vector`.
 * @param {number[]} vec
 */
export function toVectorLiteral(vec) {
  if (!Array.isArray(vec) || vec.length === 0) throw new TypeError('toVectorLiteral: non-empty number[] required');
  for (let i = 0; i < vec.length; i++) {
    if (!Number.isFinite(vec[i])) throw new TypeError(`toVectorLiteral: vec[${i}] not finite`);
  }
  return `[${vec.join(',')}]`;
}

/**
 * Find the nearest OPEN finding for a repo by cosine over finding_embeddings,
 * using the pgvector `<=>` operator. Returns the single best match at/above
 * `threshold`, or null.
 *
 * "Open" = not dismissed and not fixed/verified — the same population the
 * memory-health metric counts. Excludes the candidate's own run (a finding is
 * not a re-raise of itself) and, when `excludeFindingId` is given, that row too.
 *
 * @param {object} args
 * @param {import('pg').Pool|import('pg').PoolClient} args.pool
 * @param {string} args.repoId
 * @param {number[]} args.embedding
 * @param {number} args.threshold
 * @param {string} [args.excludeRunId]
 * @param {string} [args.excludeFindingId]
 * @returns {Promise<{finding_id:string, cosine:number, primary_file:string, detail_snapshot:string}|null>}
 */
export async function nearestOpenReRaise({ pool, repoId, embedding, threshold, excludeRunId = null, excludeFindingId = null }) {
  if (!repoId || !Array.isArray(embedding) || embedding.length === 0) return null;
  const lit = toVectorLiteral(embedding);
  const { rows } = await pool.query(
    `SELECT f.id AS finding_id, f.primary_file, f.detail_snapshot,
            (1 - (e.embedding <=> $1::vector)) AS cosine
       FROM finding_embeddings e
       JOIN audit_findings f ON f.id = e.finding_id
       JOIN audit_runs r     ON r.id = f.run_id
      WHERE r.repo_id = $2
        AND e.embedding IS NOT NULL
        AND ($3::uuid IS NULL OR r.id <> $3::uuid)
        AND ($4::uuid IS NULL OR f.id <> $4::uuid)
        AND NOT EXISTS (SELECT 1 FROM finding_adjudication_events ev
              WHERE ev.finding_id = f.id
                AND (ev.adjudication_outcome = 'dismissed'
                     OR ev.remediation_state IN ('fixed','verified')))
      ORDER BY e.embedding <=> $1::vector
      LIMIT 1`,
    [lit, repoId, excludeRunId, excludeFindingId],
  );
  const r = rows[0];
  if (!r || Number(r.cosine) < threshold) return null;
  return { finding_id: r.finding_id, cosine: Number(r.cosine), primary_file: r.primary_file, detail_snapshot: r.detail_snapshot };
}
