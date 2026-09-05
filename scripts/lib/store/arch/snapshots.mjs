/**
 * @fileoverview Active-snapshot pointer + embedding-model config.
 *
 * Owns 3 exports:
 *   getActiveSnapshot, setActiveEmbeddingModel, getActiveEmbeddingModel
 *
 * `getActiveSnapshot` reads from BOTH `audit_repos` (active_refresh_id +
 * embedding metadata) AND `refresh_runs` (import_graph_populated flag)
 * — kept together because the join target is the conceptual "snapshot
 * pointer" the repo currently exposes.
 *
 * Plan: docs/plans/sustainability-cleanup-batch.md (WS1).
 *
 * @module scripts/lib/store/arch/snapshots
 */

import { one, many, updateWhere } from '../../db/query.mjs';
import { isCloudEnabled } from '../repo.mjs';
import { describeSchemaFault } from '../../db/errors.mjs';

/**
 * PURE decision: given the repo row and the repo-BOUND `refresh_runs` row,
 * what should `getActiveSnapshot` return?
 *
 * Split out for the same reason `drift.mjs` splits `resolveStoreGateExit`: the
 * decision is the part that can be wrong, and it is unreachable by a test while
 * it is welded to two awaits. Audit R3 H1 is exactly what that hid — the first
 * fix added `AND repo_id = $2` to the query and then returned
 * `refreshId: data.active_refresh_id` regardless of whether the bound lookup
 * found anything, so a pointer at another repo's run (or a deleted one) still
 * came back as this repo's active snapshot. A guard whose failure changes
 * nothing is decorative, and no DB was needed to see that — only a seam.
 *
 * `runRow == null` with a non-null pointer means the pointer does not name a
 * run this repo owns. That is a data-integrity fault, and the honest answer is
 * the one this function already gives for "no snapshot": null. Every caller
 * treats null as cannot-verify rather than clean (`resolveStoreGateExit` exits
 * 2), so the conservative direction is preserved.
 *
 * @param {{active_refresh_id: string|null, active_embedding_model: string|null,
 *          active_embedding_dim: number|null}|null} repoRow
 * @param {{import_graph_populated?: boolean, walk_start_commit?: string|null}|null|undefined} runRow
 * @returns {{snapshot: object|null, corruptPointer: boolean}}
 */
export function resolveActiveSnapshot(repoRow, runRow) {
  if (!repoRow) return { snapshot: null, corruptPointer: false };
  const base = {
    refreshId: repoRow.active_refresh_id,
    activeEmbeddingModel: repoRow.active_embedding_model,
    activeEmbeddingDim: repoRow.active_embedding_dim,
    importGraphPopulated: false,
    commitSha: null,
    // NULL is the pre-adoption state and reads as UNVERIFIED, never 'compatible'.
    ownershipRuleEpoch: null,
  };
  // No pointer at all is a normal empty state, not corruption — a repo that has
  // never been indexed. The row is returned unchanged, exactly as before.
  if (!repoRow.active_refresh_id) return { snapshot: base, corruptPointer: false };
  if (!runRow) return { snapshot: null, corruptPointer: true };
  return {
    snapshot: {
      ...base,
      importGraphPopulated: runRow.import_graph_populated === true,
      commitSha: runRow.walk_start_commit ?? null,
      ownershipRuleEpoch: runRow.ownership_rule_epoch ?? null,
    },
    corruptPointer: false,
  };
}

/**
 * Read active snapshot pointers + the import-graph provenance flag.
 * Two-step: read repo pointers, then look up the active refresh's
 * import_graph_populated flag.
 */
export async function getActiveSnapshot(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    const data = await one(
      `SELECT active_refresh_id, active_embedding_model, active_embedding_dim
         FROM audit_repos WHERE id = $1 LIMIT 1`,
      [repoId]
    );
    if (!data) return null;
    // `walk_start_commit` — the repo HEAD when this refresh ran, i.e. the commit
    // the snapshot was TAKEN at. Not the local HEAD now, which is what
    // `arch:render` falls back to and which can have moved since. Reported by a
    // consumer 2026-09-04: `arch:drift` printed `Commit: unknown` for a
    // snapshot `arch:render` labelled with a real sha.
    //
    // NOT `commit_sha`: that column DOES NOT EXIST on `refresh_runs` (only
    // `walk_start_commit` and the never-written `walk_end_commit`). The first
    // version of this fix selected it, the whole query threw, the surrounding
    // `catch` swallowed it, and `getActiveSnapshot` returned null for every
    // healthy repo — a total outage of the active-snapshot pointer, invisible
    // because the catch converts any error into the same "no snapshot" answer
    // a fresh repo gives. Five audit rounds and two Gemini gates missed it; the
    // real-Postgres suite caught it in 80 seconds. `imports.mjs:322` still
    // selects the same phantom column (pre-existing, filed separately).
    //
    // `AND repo_id = $2` (audit R2 H1): the id comes from THIS repo's
    // `active_refresh_id`, so the row is bound by construction today — but
    // only transitively, through a column another writer could get wrong.
    // `refresh_runs.repo_id` is `NOT NULL REFERENCES audit_repos(id)`, so
    // asking for the binding directly costs nothing and makes a cross-repo
    // answer unrepresentable rather than merely unlikely.
    const runRow = data.active_refresh_id
      ? await one(
        `SELECT import_graph_populated, walk_start_commit, ownership_rule_epoch FROM refresh_runs WHERE id = $1 AND repo_id = $2 LIMIT 1`,
        [data.active_refresh_id, repoId],
      )
      : null;
    // The decision itself lives in a pure function so it can be tested without
    // a database — see `resolveActiveSnapshot`, and audit R3 H1 for what being
    // untestable hid.
    const { snapshot, corruptPointer } = resolveActiveSnapshot(data, runRow);
    if (corruptPointer) {
      // By PATH, not `npm run arch:refresh`: the sync never adds npm aliases to
      // a consumer (AGENTS.md "Five shapes" #5), so the alias form names a
      // script that does not exist where this module actually ships. Audit R4
      // H2/H3 caught this string one round after the same defect was fixed in
      // skills-hydrate.mjs — the third time in this audit that fixing the named
      // instance and not its sibling was the finding.
      process.stderr.write('  [arch] active_refresh_id does not name a refresh_run owned by this '
        + 'repo (deleted run, or a cross-repo pointer) — reporting NO active snapshot rather than '
        + 'returning an unverified refresh id. Re-run `node scripts/symbol-index/refresh.mjs`.\n');
    }
    return snapshot;
  } catch (err) {
    // The column defect this function already documents above was invisible
    // for one reason only: this catch rendered SQLSTATE 42703 as the same
    // null a never-indexed repo gives. Fixing the column without fixing the
    // catch would leave the NEXT schema drift equally silent.
    const note = describeSchemaFault(err, 'getActiveSnapshot');
    if (note) process.stderr.write(note);
    return null;
  }
}

/**
 * Set the repo's active embedding model + dim. Per R3 H7 / Gemini G2,
 * `model` MUST be a concrete provider id (never a sentinel string).
 */
export async function setActiveEmbeddingModel({ repoId, model, dim }) {
  if (!model || !dim) throw new Error('model and dim are both required');
  try {
    await updateWhere('audit_repos',
      { active_embedding_model: model, active_embedding_dim: dim },
      { id: repoId }
    );
  } catch (err) {
    throw new Error(`setActiveEmbeddingModel failed: ${err.message}`);
  }
}

export async function getActiveEmbeddingModel(repoId) {
  if (!await isCloudEnabled()) return null;
  try {
    const data = await one(
      `SELECT active_embedding_model, active_embedding_dim
         FROM audit_repos WHERE id = $1 LIMIT 1`,
      [repoId]
    );
    if (!data) return null;
    return { model: data.active_embedding_model, dim: data.active_embedding_dim };
  } catch (err) {
    // null here reads as "no embedding profile recorded", which callers use to
    // decide a full re-embed. A schema fault must not masquerade as that.
    const note = describeSchemaFault(err, 'getActiveEmbeddingModel');
    if (note) process.stderr.write(note);
    return null;
  }
}

/**
 * Persist a per-repo band calibration (plan §2.1 C4-REVISED).
 *
 * The floor is a MEASUREMENT of this repo's own embedding background, not a
 * setting — which is why it lives in the store rather than in synced config.
 * See the migration comment for why the whole record is one jsonb value.
 *
 * jsonb-safe write seam (AGENTS.md): the value is passed RAW. The db layer's
 * `serializeWriteParam` JSON-serialises plain objects/arrays bound to write
 * params; hand-stringifying here would double-encode.
 *
 * @param {string} repoId
 * @param {object|null} calibration - null clears it (back to uncalibrated)
 */
export async function recordBandCalibration(repoId, calibration) {
  if (!await isCloudEnabled()) return { ok: false, cloud: false };
  if (!repoId) return { ok: false, reason: 'no-repo-id' };
  // Adjudicate the write rather than assume it. An unconditional {ok:true} for
  // an update that matched no row reports success for a repo that does not
  // exist — the caller then records a calibration nothing is using.
  const updated = await updateWhere('audit_repos', { band_calibration: calibration }, { id: repoId });
  const rows = typeof updated === 'number' ? updated : (updated?.rowCount ?? updated?.length ?? null);
  if (rows === 0) return { ok: false, cloud: true, reason: 'repo-not-found' };
  return { ok: true, cloud: true };
}

/**
 * Read a repo's band calibration.
 *
 * Returns `null` for uncalibrated, and the caller MUST treat that as "band
 * `review` only" rather than substituting a default. A borrowed threshold is
 * precisely the defect this design removes.
 *
 * @returns {Promise<object|null>}
 */
export async function getBandCalibration(repoId) {
  if (!await isCloudEnabled()) return null;
  if (!repoId) return null;
  const row = await one(`SELECT band_calibration FROM audit_repos WHERE id = $1 LIMIT 1`, [repoId]);
  return row?.band_calibration ?? null;
}

/**
 * Random sample of embedding vectors from a published snapshot, for computing
 * the repo's background similarity distribution (plan §2.1 C4-REVISED).
 *
 * Samples from the DB rather than from the in-flight embed output on purpose:
 * an INCREMENTAL refresh only embeds touched files, so sampling the run's own
 * output would measure the background of whatever the developer happened to be
 * editing. The floor must describe the corpus, not the changeset.
 *
 * @param {string} refreshId
 * @param {number} limit
 * @returns {Promise<number[][]>}
 */
export async function sampleSnapshotEmbeddings(repoId, refreshId, limit = 120) {
  if (!await isCloudEnabled()) return [];
  // `repoId` FIRST and required, matching every sibling in this module
  // (`getActiveSnapshot`, `getBandCalibration`, `recordBandCalibration`). An
  // appended optional tenant key would be a guard you can forget; a leading
  // required one makes omission a visible call-site error.
  //
  // Bound to the repo (audit R1 H1 → R4 M2 → R5 H1, deferred five times on a
  // cost I had not measured: it is ONE caller, and `refresh.mjs` already holds
  // `repoId` on the very next line, where it passes it to
  // `recordBandCalibration`). `symbol_index.repo_id` is
  // `NOT NULL REFERENCES audit_repos(id)`, so this is one clause, not a join.
  //
  // What it protects: this feeds the per-repo band calibration, whose whole
  // premise is that the floor is measured from THIS repo's own embedding
  // background. A foreign or stale `refresh_id` silently calibrated a repo
  // against another corpus — the same class as borrowing a threshold, which is
  // the defect the calibration exists to remove.
  if (!repoId || !refreshId) return [];
  const rows = await many(
    `SELECT se.embedding::text AS emb
       FROM symbol_index si
       JOIN symbol_definitions sd ON sd.id = si.definition_id
       JOIN symbol_embeddings se ON se.definition_id = sd.id
                                AND se.signature_hash = si.signature_hash
      WHERE si.refresh_id = $1
        AND si.repo_id = $2
      ORDER BY random()
      LIMIT $3`,
    [refreshId, repoId, limit],
  );
  const out = [];
  for (const r of rows || []) {
    try {
      const v = JSON.parse(r.emb);
      if (Array.isArray(v) && v.length > 0) out.push(v);
    } catch { /* skip an unparseable vector rather than abort calibration */ }
  }
  return out;
}
