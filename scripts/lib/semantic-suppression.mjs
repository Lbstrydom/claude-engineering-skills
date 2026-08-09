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
import { normalizePath } from './file-io.mjs';
import { affectedFilesOf } from './finding-match.mjs';

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
    // MEMBERSHIP over the candidate's file SET, not equality on a positional
    // primary (plan §2.5e / invariant 1).
    //
    // This guard — the module's own docstring calls it "the single biggest
    // false-suppression guard" — was silently INERT. It ran
    // `normalizePath(candidate.section)`, and `section` is model-authored prose:
    // `"scripts/foo.mjs — someFn()"` normalises to itself, never to
    // `"scripts/foo.mjs"`, so the comparison failed and NO suppression ever
    // fired for such findings. Verified on real bake-off sections.
    //
    // Two asymmetric sides, deliberately: the neighbour's `primary_file` is a
    // persisted column written by `populateFindingMetadata` and is trusted
    // as-is (re-deriving it from a row we did not parse would invent a second
    // oracle); the candidate is resolved through the shared extractor. A
    // multi-file candidate whose `files[0]` differs from the neighbour's stored
    // primary must still match, which equality cannot express.
    // Resolve from the MOST structured field available, and never feed an
    // already-resolved path back through the prose parser (Gemini gate).
    //
    // The earlier form passed `primaryFile` in as `section`, so a stored path
    // was re-parsed by a regex built for free text. Measured: that regex matches
    // forward-slash paths but NOT backslash-separated ones, so a stored
    // `scripts\win\c.mjs` extracted to `[]` — no key at all. `normalizePath`
    // handles the separator perfectly well; it was the prose round-trip in front
    // of it that lost the path. It failed OPEN, so nothing was mis-suppressed,
    // but it silently skipped suppressions it should have made.
    // ONE call, no local fallback chain. The chain that used to live here
    // (`affectedFiles` else `primaryFile` else `section`) was itself a
    // narrowing: a candidate carrying BOTH a primary and a multi-file section
    // lost the section's files. `affectedFilesOf` now unions every source, so
    // there is nothing left here to get wrong.
    const candidateFiles = affectedFilesOf(candidate);
    // The neighbour is usually a DB row carrying ONE `primary_file` column. The
    // in-memory clustering path has the whole finding, though, so it may supply
    // `affected_files` — and must, or the canonical side reintroduces exactly
    // the positional narrowing just removed from the candidate side.
    const neighbourFiles = (Array.isArray(neighbour.affected_files) && neighbour.affected_files.length > 0)
      ? neighbour.affected_files.map((x) => normalizePath(x)).filter(Boolean)
      : [normalizePath(neighbour.primary_file || '')].filter(Boolean);
    // Fail OPEN (no suppression) when either side is unresolvable — including
    // legacy rows with a null `primary_file`. A false suppression hides a
    // possibly-new finding; a false keep costs one duplicate store row. That
    // asymmetry is the same one this module already argues for its threshold.
    if (neighbourFiles.length === 0 || candidateFiles.length === 0
      || !candidateFiles.some((p) => neighbourFiles.includes(p))) {
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
      // Pass the finding's FILE FIELDS through, not just its positional
      // primary (Gemini gate, union round 2). Hand-building
      // `{ primaryFile: f.primaryFile }` re-created §2.6's invariants 1 and 3
      // in one line: it reduced a multi-file finding to `files[0]` (positional
      // comparison) and dropped `affectedFiles`/`_primaryFile` at a rebuilt
      // envelope. `decideReRaise` prefers the richest field it is given, so
      // starving it here silently narrowed the match that was just widened.
      const d = decideReRaise(
        { primaryFile: f.primaryFile, _primaryFile: f._primaryFile, affectedFiles: f.affectedFiles, section: f.section },
        {
          finding_id: c.canonical.id,
          cosine: cos,
          primary_file: c.canonical.primaryFile,
          // Symmetric to the candidate side: this path holds the whole finding,
          // so give the canonical its full file set rather than files[0].
          affected_files: c.canonical.affectedFiles,
        },
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
export async function nearestOpenReRaise({
  pool, repoId, embedding, threshold, excludeRunId = null, excludeFindingId = null,
  sameFileScope = null,
}) {
  if (!repoId || !Array.isArray(embedding) || embedding.length === 0) return null;
  const lit = toVectorLiteral(embedding);
  // SAME-FILE FILTER IN THE QUERY, not only in decideReRaise.
  //
  // `LIMIT 1` ranks by cosine across the WHOLE repo, so with the filter applied
  // only afterwards, one high-scoring different-file finding shadows every
  // eligible same-file duplicate beneath it: the caller rejects the top row and
  // never learns a qualifying match existed. The ordering defect was harmless
  // while `requireSameFile` was inert (nothing suppressed either way) —
  // repairing that guard is what makes this live, which is why it is fixed in
  // the same change rather than deferred as pre-existing.
  //
  // `null` scope means "no constraint" so a `requireSameFile:false` caller is
  // byte-identical to before. An EMPTY array means "the candidate resolved no
  // file", which can never match — return null rather than issue a query whose
  // `= ANY('{}')` is always false.
  const scoped = Array.isArray(sameFileScope);
  if (scoped && sameFileScope.length === 0) return null;
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
        AND ($5::text[] IS NULL OR f.primary_file = ANY($5::text[]))
        AND NOT EXISTS (SELECT 1 FROM finding_adjudication_events ev
              WHERE ev.finding_id = f.id
                AND (ev.adjudication_outcome = 'dismissed'
                     OR ev.remediation_state IN ('fixed','verified')))
      ORDER BY e.embedding <=> $1::vector
      LIMIT 1`,
    // A PLAIN JS array, deliberately not `pgArray()`. That helper returns a
    // `{[PG_ARRAY]:true, value}` marker that only the db/query.mjs write
    // builders unwrap; this is a raw pool.query WHERE predicate, where
    // node-postgres already binds a JS array as a Postgres array literal —
    // exactly what `= ANY($5::text[])` needs. Passing the marker here would
    // bind an object and fail.
    [lit, repoId, excludeRunId, excludeFindingId, scoped ? sameFileScope : null],
  );
  const r = rows[0];
  if (!r || Number(r.cosine) < threshold) return null;
  return { finding_id: r.finding_id, cosine: Number(r.cosine), primary_file: r.primary_file, detail_snapshot: r.detail_snapshot };
}

/**
 * The PROSPECTIVE record-time hook: partition a batch of findings into those to
 * record and those to suppress as semantic re-raises of an EXISTING open
 * finding in another run of the same repo. The embedding of each kept finding is
 * returned so the caller can persist it AFTER insert (finding_embeddings.finding_id
 * is an FK to the row that does not exist yet), making it a future match target.
 *
 * SAFETY IS THE CONTRACT. This runs on the audit's store-write path, and a
 * suppressed finding does not get a store row. So every failure mode defaults to
 * KEEP: an embedding error, a query error, a missing embedding — the finding is
 * recorded, never dropped. The only thing that suppresses is a POSITIVE,
 * above-threshold, same-file match. A caller wrapping this in try/catch and
 * recording everything on throw is the intended belt-and-braces.
 *
 * @param {object} args
 * @param {import('pg').Pool|import('pg').PoolClient} args.pool
 * @param {string} args.repoId
 * @param {string} args.runId               excluded from matches (not a re-raise of self)
 * @param {object[]} args.findings          each carrying detail_snapshot text + _primaryFile/section
 * @param {(text:string)=>Promise<number[]>} args.embed   detail → vector (secret-redacted by the caller's embedText)
 * @param {number} args.threshold
 * @param {boolean} args.requireSameFile
 * @param {(msg:string)=>void} [args.log]
 * @returns {Promise<{kept:object[], suppressed:Array<{finding:object, matchedId:string, cosine:number}>,
 *                    vectorByFinding: Map<object, number[]>}>}
 */
export async function partitionRecordTimeReRaises({ pool, repoId, runId, findings, embed, threshold, requireSameFile, log = () => {} }) {
  const kept = [], suppressed = [];
  const vectorByFinding = new Map();
  for (const f of findings) {
    const text = typeof f?.detail === 'string' ? f.detail : (typeof f?.detail_snapshot === 'string' ? f.detail_snapshot : '');
    if (!text || text.trim().length < 30) { kept.push(f); continue; } // nothing to compare — keep
    // Resolve the candidate's file SET once and hand it to the query, so the
    // nearest-neighbour search ranks only rows that could actually qualify
    // (see nearestOpenReRaise). `decideReRaise` still re-checks membership —
    // defence in depth, and it keeps the pure decision independently testable.
    const candidateFiles = requireSameFile
      ? affectedFilesOf({ affectedFiles: f.affectedFiles, section: f._primaryFile || f.section || '' })
      : null;
    let vec = null, neighbour = null;
    try {
      vec = await embed(text.slice(0, 500));
      neighbour = await nearestOpenReRaise({
        pool, repoId, embedding: vec, threshold, excludeRunId: runId, sameFileScope: candidateFiles,
      });
    } catch (err) {
      log(`  [semantic-suppress] keep-on-error: ${err.message?.slice(0, 80)}`);
      kept.push(f); // fail-open — never drop a finding because of a suppression fault
      continue;
    }
    const decision = decideReRaise(
      { primaryFile: f._primaryFile || f.section, section: f.section },
      neighbour, { threshold, requireSameFile },
    );
    if (decision.suppress) {
      suppressed.push({ finding: f, matchedId: decision.matchedId, cosine: decision.cosine });
    } else {
      kept.push(f);
      if (vec) vectorByFinding.set(f, vec);
    }
  }
  return { kept, suppressed, vectorByFinding };
}
