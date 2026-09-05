/**
 * @fileoverview symbol_file_imports — file-import graph edges + populated flag.
 *
 * Owns 7 exports:
 *   recordSymbolFileImports, copyForwardImports, listFileImportsForSnapshot,
 *   markImportGraphPopulated, getImportGraphPopulated, getImportersForFiles,
 *   getFreshImportersOrNull
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/imports
 */

import { many, one, updateWhere, upsert } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { describeSchemaFault } from '../../db/errors.mjs';
import { UPSERT_CHUNK_SIZE, IN_CHUNK, chunk, retainCarriedRows } from './_shared.mjs';

/**
 * Persist a snapshot's file-import edges.
 *
 * Input is de-duplicated on the conflict key BEFORE chunking. Postgres aborts
 * an `INSERT ... ON CONFLICT DO UPDATE` whose own VALUES list carries the same
 * conflict key twice ("cannot affect row a second time") — a second UPDATE to
 * a row the same statement already touched is ambiguous, so it refuses rather
 * than pick one. Extraction can legitimately hand us the same
 * (importer, imported) pair more than once, and a repeated edge carries no
 * extra information: the edge either exists or it doesn't. Collapsing is
 * therefore lossless, and the right place for it is this boundary, so the
 * write path is idempotent against its input regardless of what upstream does.
 *
 * De-dup is GLOBAL, not per-chunk. Per-chunk would be enough to stop the
 * abort (only same-statement repeats throw; a repeat landing in a later chunk
 * merely UPDATEs), but it would leave `inserted` counting the same edge twice.
 *
 * Field failure this fixes: a consumer's full refresh (8,431 symbols / 6,077
 * edges) died here at refresh step 12b, after the summarise and embed passes
 * had already been paid for. This repo never hit it at its own scale.
 * Guarded by tests/symbol-file-imports.test.mjs.
 *
 * @param {string} refreshId
 * @param {{importer: string, imported: string}[]} edges
 * @returns {Promise<{inserted: number}>} count of DISTINCT edges persisted
 */
export async function recordSymbolFileImports(refreshId, edges) {
  if (!Array.isArray(edges) || edges.length === 0) return { inserted: 0 };
  const seen = new Set();
  const distinct = [];
  for (const e of edges) {
    // NUL-delimited: paths cannot contain it, so the key is unambiguous where
    // a plain concatenation could collide across odd-but-legal path pairs.
    const key = `${e.importer}\u0000${e.imported}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(e);
  }
  let inserted = 0;
  for (const batch of chunk(distinct, UPSERT_CHUNK_SIZE)) {
    const payload = batch.map((e) => ({
      refresh_id: refreshId,
      importer_path: e.importer,
      imported_path: e.imported,
    }));
    try {
      const result = await upsert('symbol_file_imports', payload, {
        onConflict: ['refresh_id', 'importer_path', 'imported_path'],
        update: 'all',
      });
      // symbol-index-pipeline-reliability-hardening Theme 5 (D5): report the
      // DB's own rowCount, not the attempted payload length — this function's
      // own docstring already promised "count of DISTINCT edges PERSISTED",
      // so this makes the implementation match its contract for the first
      // time (the old payload.length counted attempts, which could silently
      // overstate "persisted" whenever a distinct edge's FK target didn't yet
      // exist). Same pattern as recordSymbolIndex's existing mismatch warning.
      if (result.rowCount !== payload.length) {
        process.stderr.write(`  [symbol-index] recordSymbolFileImports: chunk attempted ${payload.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      inserted += result.rowCount;
    } catch (err) {
      throw new Error(`recordSymbolFileImports failed: ${err.message}`, { cause: err });
    }
  }
  return { inserted };
}

/**
 * Copy a prior snapshot's import edges whose importer file is NOT in
 * `touchedFileSet` into the new snapshot.
 *
 * @param {((filePath: string) => boolean)|null} [args.fileStillExists] -
 *   optional on-disk gate, mirroring copyForwardUntouchedFiles. Passed only by
 *   the timed-out-full recovery so a deleted importer's edges are not
 *   resurrected; incremental passes null (deletions are already in touchedFileSet).
 */
export async function copyForwardImports({ repoId, fromRefreshId, toRefreshId, touchedFileSet, fileStillExists = null, isDisowned = null }) {
  // `repoId` binds the SOURCE read. `symbol_file_imports` has no `repo_id`
  // column, so ownership comes from the `refresh_runs` FK (`repo_id UUID NOT
  // NULL REFERENCES audit_repos(id)`) — a join, not a migration.
  //
  // This is a copy-FORWARD, which makes an unbound source read worse than a
  // plain query rather than better: a foreign `fromRefreshId` would not merely
  // report another repo's edges, it would PERSIST them into this repo's new
  // snapshot, where every later reader sees them as locally observed. That is
  // how `.audit-loop/domain-deps-observed.json` — the evidence layer that is
  // supposed to be "what code actually imports" — would come to describe
  // another codebase.
  //
  // Returns `{copied: 0}` rather than throwing, matching this function's
  // existing posture for a missing id: a refresh whose copy-forward is skipped
  // degrades to a full re-walk, never to wrong data.
  if (!repoId || !fromRefreshId || !toRefreshId || !await isCloudEnabled()) return { copied: 0 };
  let copied = 0;
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const rows = await many(
      `SELECT sfi.importer_path, sfi.imported_path FROM symbol_file_imports sfi
         JOIN refresh_runs rr ON rr.id = sfi.refresh_id AND rr.repo_id = $4
        WHERE sfi.refresh_id = $1
        ORDER BY sfi.importer_path, sfi.imported_path
        OFFSET $2 LIMIT $3`,
      [fromRefreshId, offset, pageSize, repoId]
    );
    if (rows.length === 0) break;
    // ONE rule, shared with symbols.mjs — keyed on importer_path here, because
    // the importer is the file whose ownership decides whether this edge is
    // ours to record. See `retainCarriedRows` for why `isDisowned` is nullable.
    const keep = retainCarriedRows(rows, { pathOf: (r) => r.importer_path, touchedFileSet, fileStillExists, isDisowned });
    if (keep.length > 0) {
      const payload = keep.map((r) => ({
        refresh_id: toRefreshId,
        importer_path: r.importer_path,
        imported_path: r.imported_path,
      }));
      const result = await upsert('symbol_file_imports', payload, {
        onConflict: ['refresh_id', 'importer_path', 'imported_path'],
        update: 'all',
      });
      // symbol-index-pipeline-reliability-hardening Theme 5 (D5). Note
      // (shadow finding, plan §5): every row here targets a brand-NEW
      // toRefreshId under this ON CONFLICT — by construction every row is a
      // fresh insert, never an update, so rowCount === payload.length is
      // expected on EVERY call. This warning is a defensive tripwire for an
      // unexpected reachable case (a batch-partial failure, or a conflict on
      // some other constraint), not something normally expected to fire —
      // unlike recordSymbolIndex's sibling warning, which DOES expect real
      // updates and can legitimately fire on ordinary runs.
      if (result.rowCount !== payload.length) {
        process.stderr.write(`  [symbol-index] copyForwardImports: page attempted ${payload.length} rows but DB reports rowCount=${result.rowCount} — investigate\n`);
      }
      copied += result.rowCount;
    }
    if (rows.length < pageSize) break;
    offset += pageSize;
  }
  return { copied };
}

/**
 * List every file-import edge in a snapshot. Used by render-mermaid to
 * derive observed domain→domain deps. Plan: docs/plans/observed-domain-deps.md
 *
 * Bound to the asking repo through the `refresh_runs` FK — `symbol_file_imports`
 * carries no `repo_id` of its own. This read is what `render-mermaid` turns
 * into the OBSERVED dependency tier, whose documented contract (AGENTS.md,
 * "Two-layer dependency model") is that it is the evidence layer: "what code
 * *actually* imports". An unbound read let that sentence be false about a
 * different repo's code while still rendering as this repo's evidence.
 *
 * THROWS on a missing `repoId`: `[]` is indistinguishable from a snapshot
 * predating the import-graph feature, and the coverage envelope would record
 * that silence as a measured result.
 *
 * @param {string} refreshId
 * @param {string} repoId
 * @returns {Promise<Array<{importer: string, imported: string}>>}
 */
export async function listFileImportsForSnapshot(refreshId, repoId) {
  if (!refreshId || !repoId) {
    throw new Error(`listFileImportsForSnapshot: refreshId and repoId are both required (got refreshId=${JSON.stringify(refreshId)}, repoId=${JSON.stringify(repoId)})`);
  }
  if (!await isCloudEnabled()) return [];
  try {
    const rows = await many(
      `SELECT sfi.importer_path, sfi.imported_path FROM symbol_file_imports sfi
         JOIN refresh_runs rr ON rr.id = sfi.refresh_id AND rr.repo_id = $2
        WHERE sfi.refresh_id = $1
        ORDER BY sfi.importer_path, sfi.imported_path`,
      [refreshId, repoId]
    );
    return rows.map((r) => ({ importer: r.importer_path, imported: r.imported_path }));
  } catch (err) {
    // R1-M9: preserve the underlying pg error as cause so callers can
    // inspect SQLSTATE / connection metadata without parsing the message.
    throw new Error(`listFileImportsForSnapshot failed: ${err.message}`, { cause: err });
  }
}

/**
 * Mutates the same multi-tenant `refresh_runs` table `abortRefreshRun`/
 * `getRefreshRun`/`heartbeatRefreshRun` are repo-scoped in (D1,
 * docs/plans/symbol-index-pipeline-reliability-hardening.md) — widened to
 * match rather than leave a same-class gap unacknowledged. Also scoped by
 * `status = 'running'` and returns `{populated: boolean}` (audit-code
 * round-1 H3 + round-4 H2): the caller must be able to tell a 0-row update
 * (wrong repo, or already-terminal) apart from a real success, rather than
 * silently continuing as if the flag had landed — the same fix `abortRefreshRun`
 * got (round-2 L1), applied consistently here too.
 */
export async function markImportGraphPopulated(refreshId, repoId) {
  // A missing refreshId/repoId is a call-site programmer error, not "did
  // not land" (shadow finding, closing the last instance of this class —
  // getImportGraphPopulated and getRefreshRun already got this treatment).
  if (!refreshId || !repoId) {
    throw new Error(`markImportGraphPopulated: refreshId and repoId are both required (got refreshId=${JSON.stringify(refreshId)}, repoId=${JSON.stringify(repoId)})`);
  }
  if (!await isCloudEnabled()) return { populated: false };
  try {
    const rows = await updateWhere('refresh_runs',
      { import_graph_populated: true },
      { id: refreshId, repo_id: repoId, status: 'running' },
      { returning: ['id'] });
    // No direct stderr write here (Gemini final-gate finding) — matches
    // abortRefreshRun's pattern (round-2 L1): a store-layer persistence
    // function shouldn't own a CLI logging convention. The caller already
    // logs based on the returned {populated} — see refresh.mjs.
    return { populated: rows.length > 0 };
  } catch (err) {
    throw new Error(`markImportGraphPopulated failed: ${err.message}`, { cause: err });
  }
}

/**
 * A missing `refreshId`/`repoId` is a call-site programmer error, not "the
 * graph isn't populated" — it THROWS rather than returning `false`, which
 * is the same value a genuine "not populated" reads as (shadow final-gate
 * finding: a silently-missing repoId at some future call site would
 * indistinguishably degrade the architecture map). Cloud-disabled and
 * genuine not-found/error cases still return `false` — that's the correct,
 * safe default for this flag's actual semantics (treat "can't confirm" the
 * same as "not populated", which only ever costs a future full re-embed,
 * never a correctness risk).
 */
export async function getImportGraphPopulated(refreshId, repoId) {
  if (!refreshId || !repoId) {
    throw new Error(`getImportGraphPopulated: refreshId and repoId are both required (got refreshId=${JSON.stringify(refreshId)}, repoId=${JSON.stringify(repoId)})`);
  }
  if (!await isCloudEnabled()) return false;
  try {
    const row = await one(
      `SELECT import_graph_populated FROM refresh_runs WHERE id = $1 AND repo_id = $2 LIMIT 1`,
      [refreshId, repoId]
    );
    return row?.import_graph_populated === true;
  } catch (err) {
    // `false` remains the correct, safe default for this flag (see the doc
    // comment above: treating "can't confirm" as "not populated" costs at most
    // a future full re-embed). But a schema fault is not a measurement, and
    // the whole point of this change is that the two must not look alike.
    const note = describeSchemaFault(err, 'getImportGraphPopulated');
    if (note) process.stderr.write(note);
    return false;
  }
}

/**
 * Look up file-level importers for a set of imported_path values within
 * a snapshot. Returns `Map<imported_path, sorted importer_paths[]>`.
 * Chunked at IN_CHUNK to avoid huge `= ANY($1)` parameter arrays.
 */
export async function getImportersForFiles({ refreshId, repoId, paths }) {
  const out = new Map();
  // A missing `repoId` THROWS rather than returning an empty Map. An empty
  // importer set is not inert here: `getCallersForFileCmd` renders it as
  // `snapshotProvenance: 'import-graph-populated'` — i.e. "asked and answered,
  // nothing imports this" — and Stage 0's `impactAdapter` reads the same
  // silence as `pre_existing_independent`, actively DISMISSING findings. The
  // provenance ladder in that command exists precisely to keep an unanswerable
  // question apart from a clean answer; a silent empty here would route round
  // the ladder rather than down it.
  if (!repoId) {
    throw new Error(`getImportersForFiles: repoId is required (got ${JSON.stringify(repoId)})`);
  }
  if (!refreshId || !Array.isArray(paths) || paths.length === 0) return out;
  if (!await isCloudEnabled()) return out;
  for (const batch of chunk(paths, IN_CHUNK)) {
    try {
      const rows = await many(
        `SELECT sfi.imported_path, sfi.importer_path FROM symbol_file_imports sfi
           JOIN refresh_runs rr ON rr.id = sfi.refresh_id AND rr.repo_id = $3
          WHERE sfi.refresh_id = $1 AND sfi.imported_path = ANY($2)`,
        [refreshId, batch, repoId]
      );
      for (const row of rows) {
        if (!out.has(row.imported_path)) out.set(row.imported_path, []);
        out.get(row.imported_path).push(row.importer_path);
      }
    } catch (err) {
      throw new Error(`getImportersForFiles failed: ${err.message}`, { cause: err });
    }
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * PURE decision: given the repo-BOUND `refresh_runs` row and the HEAD sha the
 * caller is asking about, is the published import graph a trustworthy
 * description of that commit?
 *
 * Split out of `getFreshImportersOrNull` for exactly the reason
 * `snapshots.mjs` split `resolveActiveSnapshot` out of `getActiveSnapshot`
 * (audit R3 H1): the decision is the part that can be wrong, and while it is
 * welded between two awaits no test can reach it without a database. That is
 * what hid this function's own defect for its entire history — the query it
 * sat behind selected a `commit_sha` column `refresh_runs` does not have, so
 * every call threw, the catch returned null, and `fresh` was never once
 * evaluated in production.
 *
 * WHY `walk_start_commit` IS THE RIGHT KEY. It is the only commit column on
 * `refresh_runs` (`walk_end_commit` was declared, never written, and dropped
 * in migration 20260721150000 — do not reintroduce it), and it records the
 * repo HEAD at the moment the refresh OPENED. Two independent consumers
 * already treat it as the snapshot's commit identity:
 * `resolveActiveSnapshot` publishes it as `commitSha`, and
 * `refresh-mode.mjs` anchors incremental walks on it. This function is the
 * third, and agreeing with them is the point.
 *
 * The comparison is conservative in the safe direction. If commits land
 * DURING a refresh, the walk may mix revisions — but those commits also move
 * HEAD, so a later read at the new HEAD fails the equality and degrades to
 * `null` (cannot verify) rather than vouching for a mixed graph. The residual
 * narrow case — checking the old commit back out after such a run — is the
 * same exposure `refresh-mode.mjs` already documents and accepts, not a new
 * one introduced here.
 *
 * `import_graph_populated` is required ALONGSIDE the sha match, never instead
 * of it (round-1 code-audit H1/H6): a refresh row can exist for the right
 * commit while its import-graph population crashed partway through, and an
 * incomplete graph must degrade to `null`, never read as an authoritative
 * empty importer set.
 *
 * @param {{walk_start_commit?: string|null, import_graph_populated?: boolean}|null|undefined} runRow
 * @param {string} headSha
 * @returns {{fresh: boolean, reason: 'ok'|'no-run-row'|'no-walk-commit'|'commit-mismatch'|'graph-incomplete'}}
 */
export function resolveImportGraphFreshness(runRow, headSha) {
  if (!runRow) return { fresh: false, reason: 'no-run-row' };
  if (!runRow.walk_start_commit) return { fresh: false, reason: 'no-walk-commit' };
  if (runRow.walk_start_commit !== headSha) return { fresh: false, reason: 'commit-mismatch' };
  if (runRow.import_graph_populated !== true) return { fresh: false, reason: 'graph-incomplete' };
  return { fresh: true, reason: 'ok' };
}

/**
 * Freshness-validated, dirty-tree-guarded, BOUNDED TRANSITIVE reverse-
 * dependency query for the tiered-recall Stage 0 evidence-relevance split
 * (plan: docs/plans/stage0-evidence-relevance-split.md decisions #5/#7).
 * Answers `tagPreExisting`'s `impactAdapter` contract DIRECTLY — `true`
 * means INDEPENDENT (no changed file depends on `filePath`, within
 * `maxDepth`), matching `evidence-triage.mjs::tagPreExisting`'s existing
 * polarity, not this function's own internal "found a dependent?" framing
 * (Gemini final-review round-2 G1 — the earlier draft's opposite polarity
 * made `pre_existing_independent` structurally unreachable).
 *
 * @param {object} args
 * @param {string} args.repoUuid
 * @param {string} args.headSha - the commit under audit; compared against
 *   the active refresh's own generation commit for freshness
 * @param {boolean} args.workingTreeDirty - round-2 plan-audit H2: a graph
 *   fresh for a COMMITTED headSha cannot see imports introduced/removed by
 *   an uncommitted change: `true` here always short-circuits to `null`
 * @param {string} args.filePath - the cited file to check
 * @param {string[]} args.changedFiles - this audit run's changed-file set
 * @param {number} [args.maxDepth=6] - bounded BFS depth (repo-configurable
 *   by the caller)
 * @returns {Promise<boolean|null>} `false` if `filePath` is itself among
 *   `changedFiles` (round-1 code-audit H2 — the cross-file import graph
 *   structurally cannot see a same-file dependency between new hunks
 *   elsewhere in `filePath` and the cited pre-existing lines, so a directly
 *   changed file is always confidently dependent, never independent), OR if
 *   a changed file depends on `filePath` (directly or transitively) within
 *   `maxDepth` — confident, regardless of overall graph completeness, since
 *   a found edge (or the file's own changed-ness) is real; `true` if the
 *   bounded traversal exhausts with no such dependent found, on an already
 *   freshness- AND completeness-validated graph; `null` on cloud-
 *   unavailable, stale OR incompletely-populated graph (round-1 code-audit
 *   H1/H6 — commit-sha match alone is not sufficient; a refresh whose
 *   import-graph population crashed partway through must never be treated
 *   as authoritative), dirty working tree, missing snapshot, an invalid
 *   `maxDepth` (round-1 code-audit M4 — must be a finite, non-negative
 *   integer; `Infinity`/`NaN`/negative would defeat the bound), or a
 *   depth-limit / unresolved-edge outcome — never a guess.
 */
export async function getFreshImportersOrNull({ repoUuid, headSha, workingTreeDirty, filePath, changedFiles, maxDepth = 6 }) {
  if (workingTreeDirty) return null;
  if (!repoUuid || !headSha || !filePath) return null;
  if (!Number.isInteger(maxDepth) || maxDepth < 0) return null;

  const changedSet = new Set(Array.isArray(changedFiles) ? changedFiles : []);
  // A directly changed file is confidently DEPENDENT on itself for this
  // adapter's purposes — the import graph is cross-file only and has no
  // visibility into whether NEW code elsewhere in the same file calls the
  // cited pre-existing lines. Checked BEFORE isCloudEnabled()/any DB
  // round-trip — cheap, and correct regardless of cloud availability or
  // graph freshness/completeness.
  if (changedSet.has(filePath)) return false;

  if (!await isCloudEnabled()) return null;

  let repoRow;
  try {
    repoRow = await one(`SELECT id, active_refresh_id FROM audit_repos WHERE repo_uuid = $1 LIMIT 1`, [repoUuid]);
  } catch (err) {
    // Degrading to null is correct (this is best-effort context), but a schema
    // fault must not degrade SILENTLY — see describeSchemaFault's comment for
    // the three-instance history of this exact shape.
    const note = describeSchemaFault(err, 'getFreshImportersOrNull/audit_repos');
    if (note) process.stderr.write(note);
    return null;
  }
  if (!repoRow?.active_refresh_id) return null;

  let refreshRow;
  try {
    // `walk_start_commit`, NOT `commit_sha`: that column DOES NOT EXIST on
    // `refresh_runs`. This query selected it from the day it was written, so
    // it threw on every call, the catch below turned the throw into `null`,
    // and this function's entire freshness cache never hit once — an
    // always-fallback wearing a working cache's clothes. Same phantom column,
    // same catch, same invisibility as the `getActiveSnapshot` defect fixed
    // just before this one; that fix's comment filed this site as the
    // remaining instance.
    //
    // `AND repo_id = $2` matches every sibling reader of this multi-tenant
    // table (`getRefreshRun`, `getImportGraphPopulated`, `getActiveSnapshot`):
    // the id reaches us through THIS repo's `active_refresh_id`, so the row is
    // bound by construction today — but only transitively, through a column
    // another writer could get wrong. Asking for the binding directly makes a
    // cross-repo answer unrepresentable rather than merely unlikely.
    refreshRow = await one(
      `SELECT walk_start_commit, import_graph_populated FROM refresh_runs WHERE id = $1 AND repo_id = $2 LIMIT 1`,
      [repoRow.active_refresh_id, repoRow.id]
    );
  } catch (err) {
    const note = describeSchemaFault(err, 'getFreshImportersOrNull/refresh_runs');
    if (note) process.stderr.write(note);
    return null;
  }
  // The decision itself lives in a pure function so it can be tested without a
  // database — see `resolveImportGraphFreshness`, and this function's own
  // never-executed history for what being untestable hid.
  if (!resolveImportGraphFreshness(refreshRow, headSha).fresh) return null;

  const refreshId = repoRow.active_refresh_id;
  const visited = new Set([filePath]);
  let frontier = [filePath];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= maxDepth) return null; // depth-limit hit before resolution
    let importersMap;
    try {
      // `repoRow.id` is the repo resolved from `repoUuid` at the top of this
      // function — the same one the freshness read above is now bound by.
      importersMap = await getImportersForFiles({ refreshId, repoId: repoRow.id, paths: frontier });
    } catch (err) {
      // getImportersForFiles rethrows a wrapper, so the SQLSTATE is on
      // `cause` — describeSchemaFault walks it.
      const note = describeSchemaFault(err, 'getFreshImportersOrNull/symbol_file_imports');
      if (note) process.stderr.write(note);
      return null;
    }
    const nextFrontier = [];
    for (const node of frontier) {
      for (const importer of (importersMap.get(node) || [])) {
        if (changedSet.has(importer)) return false; // confidently dependent
        if (!visited.has(importer)) {
          visited.add(importer);
          nextFrontier.push(importer);
        }
      }
    }
    frontier = nextFrontier;
    depth += 1;
  }
  return true; // bounded traversal exhausted, no dependent found -> confidently independent
}
