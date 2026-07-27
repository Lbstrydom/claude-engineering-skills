/**
 * @fileoverview Backfill v1 `persona_finding_outcomes` rows onto the v2
 * `personaFindingHash` identity (route/expected context added). Scoped
 * EXACTLY to the v1->v2 transition — docs/plans/persona-finding-hash-versioning.md.
 *
 * Design invariants (see the plan for the full derivation):
 * - `SOURCE_HASH_VERSION`/`TARGET_HASH_VERSION` are frozen module constants,
 *   NOT read from the live `PERSONA_FINDING_HASH_VERSION` — this command's
 *   identity is THIS transition. It refuses to run once
 *   `PERSONA_FINDING_HASH_VERSION` no longer equals `TARGET_HASH_VERSION`;
 *   a future v2->v3 bump gets its own dated command.
 * - Non-destructive: the old (v1) row is NEVER deleted or modified. The v2
 *   write is `ON CONFLICT DO UPDATE`, but conditionally (code-audit R4
 *   finding H2) — it only reconciles a v2 row this backfill itself created
 *   (`migrated_at IS NOT NULL`) and only when the v1 source is strictly
 *   newer; a v2 row a human directly labeled is never touched (see
 *   `backfillPersonaFindingHashV2` below for the exact WHERE clause).
 * - Idempotent, no persisted resume state: every candidate is re-derived
 *   fresh from source data each run; a killed process just needs a re-run.
 * - Bounded memory: the genuinely unbounded source (`persona_test_sessions`)
 *   is keyset-paged into a `REPEATABLE READ` DB-side temp table;
 *   `source_outcomes` (a repo's own outcome-label rows) is small enough
 *   for one un-paginated query. The ambiguity report is streamed to a
 *   JSONL file, never accumulated in one in-memory array.
 * - Ambiguous mappings (one old hash -> >1 new hash across sessions) are
 *   NEVER auto-resolved — always routed to the report for operator review.
 *
 * @module scripts/lib/store/persona-outcomes-hash-backfill
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, many, one, withTx } from '../db/query.mjs';
import { retrySync } from '../retry-transient-fs.mjs';
import {
  personaFindingHash, personaFindingHashV1, buildStepUrlLookup, isP0OrP1,
  isMalformedFinding, PERSONA_FINDING_HASH_VERSION,
} from '../persona/audit-correlator.mjs';

// Gemini gate finding G1: a malformed finding (missing element/observed)
// collapses onto the SAME synthetic personaFindingHash as every other
// malformed finding in the repo — must be excluded here too, or staging
// would compute a colliding old_hash/new_hash pair for every malformed
// finding across every session, corrupting the mapping.
const isIdentifiableP0OrP1 = (f) => isP0OrP1(f) && !isMalformedFinding(f);

const SOURCE_HASH_VERSION = 1;
const TARGET_HASH_VERSION = 2;

const SESSION_PAGE_SIZE = 500;
const AMBIGUOUS_REPORT_PAGE_SIZE = 500;
// 4 params/row; keeps a single batched INSERT safely under Postgres's
// 65535 bind-parameter limit even for an unusually finding-dense page.
const MAPPING_INSERT_CHUNK_SIZE = 1000;

const DEFAULT_REPORT_DIR = '.audit-loop/persona-hash-backfill-reports';

// code-audit R1 finding H3: `${repoId}-${Date.now()}` has only millisecond
// resolution, so two SEPARATE processes backfilling the SAME repo within
// the same ms could pick the identical default path and one would
// silently clobber the other's report after rename. A random suffix
// closes this without needing exclusive-create semantics (the report is
// additive/advisory, not a lock — a name collision should just not
// happen, not need detecting).
function defaultReportPath(repoId) {
  const suffix = crypto.randomBytes(4).toString('hex');
  return path.join(DEFAULT_REPORT_DIR, `${repoId}-${Date.now()}-${suffix}.jsonl`);
}

/** Append `lines` to `tmpPath`, creating its parent dir on first use. */
function appendReportLines(tmpPath, rows) {
  const text = rows.map((r) => JSON.stringify({
    oldHash: r.old_hash, newHash: r.new_hash, sessionId: r.session_id, route: r.route,
  })).join('\n') + '\n';
  fs.appendFileSync(tmpPath, text, 'utf-8');
}

/**
 * Stage the ambiguous `hash_mapping` rows (one old hash -> >1 new hash) to
 * a JSONL temp file, keyset-paged `ORDER BY (old_hash, id)` — `old_hash`
 * alone is NOT unique in `hash_mapping`, so pagination on it alone would
 * silently skip rows whenever a page boundary lands inside a group of
 * same-hash rows (the exact bug this two-column order fixes).
 *
 * Deliberately does NOT rename to `finalPath` — publishing happens in
 * `publishAmbiguousReport`, called only after the enclosing transaction
 * commits (Gemini gate R2 finding 121c7d93): this function runs INSIDE the
 * REPEATABLE READ transaction, reading temp tables that only exist for its
 * duration, so renaming here would let a rolled-back run (or a process
 * killed after rename but before COMMIT) leave behind a report describing
 * DB accounting that never actually happened.
 *
 * @returns {Promise<{tmpPath: string, finalPath: string}>}
 */
async function stageAmbiguousReportTemp(ambiguousOldHashes, finalPath) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });
  // code-audit R2 findings H2/H4: PID+timestamp alone can still collide
  // for two concurrent backfills in the same directory within the same
  // ms. A random suffix (matching the final report path's own fix above)
  // closes this without needing exclusive-create semantics.
  const tmpSuffix = crypto.randomBytes(4).toString('hex');
  const tmpPath = path.join(path.dirname(finalPath), `.tmp-${process.pid}-${Date.now()}-${tmpSuffix}`);
  // Gemini gate R2 finding G1: create the temp file unconditionally, before
  // the pagination loop. Without this, a first page that (for any reason)
  // returns 0 rows would break the loop having never called
  // `appendReportLines`, and the later rename would throw ENOENT against a
  // path that was never created.
  fs.writeFileSync(tmpPath, '', 'utf-8');
  try {
    let cursorHash = null;
    let cursorRowId = null;
    for (;;) {
      const pageRows = cursorHash === null
        ? await many(
          `SELECT id, old_hash, new_hash, session_id, route FROM hash_mapping
            WHERE old_hash = ANY($1)
            ORDER BY old_hash, id
            LIMIT $2`,
          [ambiguousOldHashes, AMBIGUOUS_REPORT_PAGE_SIZE],
        )
        : await many(
          `SELECT id, old_hash, new_hash, session_id, route FROM hash_mapping
            WHERE old_hash = ANY($1) AND (old_hash, id) > ($2, $3)
            ORDER BY old_hash, id
            LIMIT $4`,
          [ambiguousOldHashes, cursorHash, cursorRowId, AMBIGUOUS_REPORT_PAGE_SIZE],
        );
      if (pageRows.length === 0) break;
      appendReportLines(tmpPath, pageRows);
      const last = pageRows[pageRows.length - 1];
      cursorHash = last.old_hash;
      cursorRowId = last.id;
      if (pageRows.length < AMBIGUOUS_REPORT_PAGE_SIZE) break;
    }
    return { tmpPath, finalPath };
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Publish a staged ambiguity report: rename the temp file to its final,
 * operator-visible path. Called ONLY after the enclosing transaction has
 * committed (see `stageAmbiguousReportTemp`'s docstring) — same-directory
 * temp-file-then-rename atomic-write convention.
 * @returns {string|null} the final path, or null when nothing was staged
 */
function publishAmbiguousReport(pending) {
  if (!pending) return null;
  retrySync(() => fs.renameSync(pending.tmpPath, pending.finalPath));
  return pending.finalPath;
}

/** Bulk-insert one batch of `(old_hash, new_hash, session_id, route)` rows. */
async function insertMappingBatch(batch) {
  if (batch.length === 0) return;
  const values = [];
  const params = [];
  batch.forEach((row, i) => {
    const base = i * 4;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4})`);
    params.push(...row);
  });
  await query(
    `INSERT INTO hash_mapping (old_hash, new_hash, session_id, route) VALUES ${values.join(',')}`,
    params,
  );
}

/**
 * Keyset-page `persona_test_sessions` for `repoId`, computing and
 * bulk-inserting `(old_hash, new_hash, session_id, route)` rows into the
 * `hash_mapping` temp table. Peak application memory is bounded on TWO
 * axes (code-audit R1 finding M6 — the original draft only bounded
 * cross-history growth via `SESSION_PAGE_SIZE`, not the accumulator
 * WITHIN one page): `SESSION_PAGE_SIZE` bounds how many sessions are ever
 * loaded into memory at once (never the full session history), and this
 * function additionally FLUSHES the in-progress `mappingRows` buffer to
 * `hash_mapping` as soon as it reaches `MAPPING_INSERT_CHUNK_SIZE` WHILE
 * iterating a page's sessions/findings — not after accumulating the
 * whole page first — so a page with an unusually finding-dense set of
 * sessions can't inflate peak memory beyond one insert-batch's worth.
 */
async function stageHashMapping(repoId) {
  let cursorCreatedAt = null;
  let cursorId = null;
  for (;;) {
    const pageRows = cursorCreatedAt === null
      ? await many(
        `SELECT id, created_at, findings, click_path FROM persona_test_sessions
          WHERE repo_id = $1
          ORDER BY created_at, id
          LIMIT $2`,
        [repoId, SESSION_PAGE_SIZE],
      )
      : await many(
        `SELECT id, created_at, findings, click_path FROM persona_test_sessions
          WHERE repo_id = $1 AND (created_at, id) > ($2, $3)
          ORDER BY created_at, id
          LIMIT $4`,
        [repoId, cursorCreatedAt, cursorId, SESSION_PAGE_SIZE],
      );
    if (pageRows.length === 0) break;

    let mappingRows = [];
    for (const session of pageRows) {
      const stepUrlByNumber = buildStepUrlLookup(session.click_path);
      for (const finding of (session.findings || []).filter(isIdentifiableP0OrP1)) {
        const oldHash = personaFindingHashV1(finding);
        const newHash = personaFindingHash(finding, stepUrlByNumber);
        const route = String(stepUrlByNumber.get(finding?.step) ?? '');
        mappingRows.push([oldHash, newHash, session.id, route]);
        if (mappingRows.length >= MAPPING_INSERT_CHUNK_SIZE) {
          await insertMappingBatch(mappingRows);
          mappingRows = [];
        }
      }
    }
    await insertMappingBatch(mappingRows);

    const last = pageRows[pageRows.length - 1];
    cursorCreatedAt = last.created_at;
    cursorId = last.id;
    if (pageRows.length < SESSION_PAGE_SIZE) break;
  }
}

/**
 * Backfill one repo's `hash_version=1` outcome labels onto the v2 hash
 * identity. See the module docstring for the full design contract.
 *
 * `reconciledThisRun` (code-audit R4 finding H2): a v2 row that was itself
 * backfill-created (`migrated_at IS NOT NULL`) gets conditionally UPDATED,
 * not just left alone, when its v1 source is now strictly newer — this
 * closes the "a lagging, un-synced consumer edits v1 after migration"
 * staleness gap without ever touching a row a human directly labeled
 * (`upsertPersonaFindingOutcome` always clears `migrated_at` to NULL,
 * making a direct label unconditionally win).
 *
 * @param {{repoId: string, dryRun?: boolean, reportPath?: string}} args
 * @returns {Promise<{scanned: number, recoveredThisRun: number,
 *   reconciledThisRun: number, ambiguousCount: number,
 *   ambiguousReportPath: string|null, targetAlreadyExists: number,
 *   unrecoverable: number, alreadyCurrent: boolean}>}
 */
export async function backfillPersonaFindingHashV2({ repoId, dryRun = false, reportPath } = {}) {
  if (PERSONA_FINDING_HASH_VERSION !== TARGET_HASH_VERSION) {
    throw new Error(
      `backfillPersonaFindingHashV2: PERSONA_FINDING_HASH_VERSION ` +
      `(${PERSONA_FINDING_HASH_VERSION}) no longer equals TARGET_HASH_VERSION ` +
      `(${TARGET_HASH_VERSION}) — this command is scoped to the ` +
      `v${SOURCE_HASH_VERSION}->v${TARGET_HASH_VERSION} transition and must not ` +
      `be reused for a later hash-version bump. Write a new dated backfill ` +
      `command for that transition instead.`,
    );
  }
  if (!repoId) throw new Error('backfillPersonaFindingHashV2: repoId is required');

  // Step 0 — cheap short-circuit, outside any transaction.
  const countRow = await one(
    `SELECT count(*)::int AS n FROM persona_finding_outcomes
      WHERE repo_id = $1 AND hash_version = $2`,
    [repoId, SOURCE_HASH_VERSION],
  );
  if ((countRow?.n ?? 0) === 0) {
    return {
      scanned: 0, recoveredThisRun: 0, ambiguousCount: 0, ambiguousReportPath: null,
      targetAlreadyExists: 0, unrecoverable: 0, alreadyCurrent: true,
    };
  }

  return withTx(async () => {
    // REPEATABLE READ — pins one snapshot for the whole staging +
    // classification pass so a v1 outcome or session added mid-scan can't
    // produce accounting that was never true for one coherent DB state.
    await query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');

    await query(
      `CREATE TEMP TABLE source_outcomes (
         id uuid, repo_id uuid, persona_finding_hash text, outcome text,
         last_seen_session_id uuid, labeled_by text, rationale text,
         created_at timestamptz, updated_at timestamptz
       ) ON COMMIT DROP`,
    );
    // Single un-paginated query — a repo's outcome-label count is bounded
    // by human dismissal volume, not session volume.
    await query(
      `INSERT INTO source_outcomes
       SELECT id, repo_id, persona_finding_hash, outcome, last_seen_session_id,
              labeled_by, rationale, created_at, updated_at
         FROM persona_finding_outcomes
        WHERE repo_id = $1 AND hash_version = $2`,
      [repoId, SOURCE_HASH_VERSION],
    );

    await query(
      `CREATE TEMP TABLE hash_mapping (
         id serial PRIMARY KEY, old_hash text, new_hash text,
         session_id uuid, route text
       ) ON COMMIT DROP`,
    );
    await stageHashMapping(repoId);
    // code-audit R1 finding M8: hash_mapping had only its implicit PK
    // index on `id`, but the ambiguity report (below) filters by
    // `old_hash` and keyset-paginates `ORDER BY (old_hash, id)` — an
    // unindexed access pattern. Built AFTER staging (bulk-insert-then-
    // index is cheaper than maintaining the index during the staged
    // inserts).
    await query('CREATE INDEX ON hash_mapping (old_hash, id)');

    // Step 2 — ambiguity detection in SQL: project the candidate new_hash
    // itself (MAX is safe — only read when distinct_targets = 1), not just
    // its distinct count.
    const groupedRows = await many(
      `SELECT old_hash, MAX(new_hash) AS new_hash, count(DISTINCT new_hash)::int AS distinct_targets
         FROM hash_mapping GROUP BY old_hash`,
    );
    const groupedByOldHash = new Map(groupedRows.map((r) => [r.old_hash, r]));
    const sourceRows = await many('SELECT persona_finding_hash FROM source_outcomes');

    let unrecoverable = 0;
    const ambiguousOldHashes = [];
    for (const src of sourceRows) {
      const grouped = groupedByOldHash.get(src.persona_finding_hash);
      if (!grouped) { unrecoverable += 1; continue; }
      if (grouped.distinct_targets > 1) ambiguousOldHashes.push(src.persona_finding_hash);
    }
    const ambiguousCount = ambiguousOldHashes.length;

    // Ambiguity report is staged regardless of --dry-run — it costs
    // nothing extra and is exactly what an operator needs to review
    // before a real run. Publishing (rename to the final path) is
    // deferred until this transaction actually commits — see
    // `stageAmbiguousReportTemp`'s docstring (Gemini gate R2 finding
    // 121c7d93).
    let pendingReport = null;
    if (ambiguousCount > 0) {
      const finalPath = path.resolve(reportPath || defaultReportPath(repoId));
      pendingReport = await stageAmbiguousReportTemp(ambiguousOldHashes, finalPath);
    }

    const totalUnambiguousCandidates = sourceRows.length - unrecoverable - ambiguousCount;
    let recoveredThisRun = 0;
    let reconciledThisRun = 0;
    let targetAlreadyExists = 0;

    if (!dryRun) {
      // Step 3 — non-destructive-of-live-labels, atomically-accounted
      // write. Accounting is derived ENTIRELY from what RETURNING
      // actually returns, never guessed — race-free against a concurrent
      // `label` command or another backfill invocation (no read-then-
      // decide window between "check" and "write").
      //
      // code-audit R4 finding H2 (compromise): a plain `DO NOTHING` can
      // leave a v2 row permanently stale if a lagging, un-synced consumer
      // (this repo's actual shared-Postgres, staggered-sync-cadence
      // deployment topology — see R3 H1) edits the v1 source AFTER this
      // backfill already migrated it. The conditional `DO UPDATE ... WHERE`
      // reconciles ONLY when BOTH hold: (1) the existing v2 row was
      // itself backfill-created and never subsequently hand-labeled
      // (`migrated_at IS NOT NULL` — `upsertPersonaFindingOutcome` clears
      // this to NULL on every direct label, so a genuine human edit is
      // NEVER a candidate here), and (2) the v1 source is STRICTLY newer
      // (`EXCLUDED.updated_at > persona_finding_outcomes.updated_at`) —
      // a direct v2 label always wins; unconditional overwrite never
      // happens. A conflicting row that fails the WHERE clause is simply
      // absent from RETURNING (Postgres's own semantics for a
      // WHERE-qualified DO UPDATE) — accounted as `targetAlreadyExists`
      // below via subtraction, exactly like the old DO-NOTHING accounting.
      const written = await many(
        `WITH unambiguous AS (
           SELECT old_hash, MAX(new_hash) AS new_hash
             FROM hash_mapping
            GROUP BY old_hash
           HAVING count(DISTINCT new_hash) = 1
         )
         INSERT INTO persona_finding_outcomes (
           repo_id, persona_finding_hash, outcome, last_seen_session_id,
           labeled_by, rationale, created_at, updated_at, hash_version, migrated_at
         )
         SELECT $1, u.new_hash, so.outcome, so.last_seen_session_id,
                so.labeled_by, so.rationale, so.created_at, so.updated_at, $2, now()
           FROM source_outcomes so
           JOIN unambiguous u ON u.old_hash = so.persona_finding_hash
         ON CONFLICT (repo_id, persona_finding_hash) DO UPDATE SET
           outcome = EXCLUDED.outcome,
           last_seen_session_id = EXCLUDED.last_seen_session_id,
           labeled_by = EXCLUDED.labeled_by,
           rationale = EXCLUDED.rationale,
           updated_at = EXCLUDED.updated_at,
           migrated_at = now()
         WHERE persona_finding_outcomes.migrated_at IS NOT NULL
           AND EXCLUDED.updated_at > persona_finding_outcomes.updated_at
         RETURNING persona_finding_hash, (xmax = 0) AS was_insert`,
        [repoId, TARGET_HASH_VERSION],
      );
      recoveredThisRun = written.filter((r) => r.was_insert).length;
      reconciledThisRun = written.length - recoveredThisRun;
      targetAlreadyExists = totalUnambiguousCandidates - recoveredThisRun - reconciledThisRun;
    } else {
      // Dry-run simulation: mirrors the real INSERT...ON CONFLICT's
      // three-way semantics (insert / conditional-reconcile / already-
      // current) via a read-only LEFT JOIN against the live table.
      const sim = await one(
        `WITH unambiguous AS (
           SELECT old_hash, MAX(new_hash) AS new_hash
             FROM hash_mapping
            GROUP BY old_hash
           HAVING count(DISTINCT new_hash) = 1
         )
         SELECT
           count(*) FILTER (WHERE pfo.persona_finding_hash IS NULL)::int
             AS would_recover,
           count(*) FILTER (
             WHERE pfo.persona_finding_hash IS NOT NULL
               AND pfo.migrated_at IS NOT NULL
               AND so.updated_at > pfo.updated_at
           )::int AS would_reconcile,
           count(*) FILTER (
             WHERE pfo.persona_finding_hash IS NOT NULL
               AND NOT (pfo.migrated_at IS NOT NULL AND so.updated_at > pfo.updated_at)
           )::int AS already_current
           FROM source_outcomes so
           JOIN unambiguous u ON u.old_hash = so.persona_finding_hash
      LEFT JOIN persona_finding_outcomes pfo
             ON pfo.repo_id = $1 AND pfo.persona_finding_hash = u.new_hash`,
        [repoId],
      );
      recoveredThisRun = sim?.would_recover ?? 0;
      reconciledThisRun = sim?.would_reconcile ?? 0;
      targetAlreadyExists = sim?.already_current ?? 0;
    }

    return {
      scanned: sourceRows.length,
      recoveredThisRun,
      reconciledThisRun,
      ambiguousCount,
      pendingReport,
      targetAlreadyExists,
      unrecoverable,
      alreadyCurrent: false,
    };
  }).then((result) => {
    // Publish (rename) only now that the transaction has actually
    // committed — see `stageAmbiguousReportTemp`'s docstring.
    const { pendingReport, ...rest } = result;
    return { ...rest, ambiguousReportPath: publishAmbiguousReport(pendingReport) };
  });
}
