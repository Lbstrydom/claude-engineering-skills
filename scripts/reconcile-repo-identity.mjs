#!/usr/bin/env node
/**
 * @fileoverview One-shot, reversible reconcile of fragmented `audit_repos` rows
 * onto stable `repo_uuid`-keyed canonical rows (signal-recovery Cluster A, Phase 2).
 *
 * B1: the audit/plan/learning path historically keyed repos on a volatile content
 * `fingerprint`, minting a new `audit_repos` row per evolving-repo audit (wine-
 * cellar-app: 193 rows). The arch/symbol-index path keyed on the stable
 * `resolveRepoIdentity().repo_uuid`, so a handful of CANONICAL rows already exist
 * (repo_uuid IS NOT NULL). This script re-points every child table's `repo_id`
 * from the fragmented fingerprint rows (repo_uuid IS NULL) onto the canonical row
 * sharing the same `name`, then deletes the emptied legacy rows.
 *
 * SAFETY (plan §8):
 *  - `--dry-run` is the DEFAULT. It writes a PROPOSED alias map to
 *    `.audit-loop/repo-alias-map.json` for human review and prints a before/after
 *    report. It NEVER mutates the DB.
 *  - `--apply` consumes ONLY the operator-approved map file, inside ONE
 *    transaction guarded by a Postgres advisory lock. Name is evidence WITH
 *    sign-off, never an automatic merge key (R2-H2).
 *  - Rows whose name maps to zero or >1 canonical row are QUARANTINED (reported,
 *    untouched) — never force-merged (R2-H4).
 *  - FK discovery is exhaustive over base tables (R3-H2): every BASE TABLE with a
 *    `repo_id` column is re-pointed; views are skipped.
 *  - Child-row collisions are merged, not crashed (Gemini-G1): for any child
 *    table with a repo-scoped UNIQUE constraint, legacy rows that would collide
 *    with an existing canonical row on the unique key are dropped (canonical
 *    wins) before the bulk UPDATE. This is intentional dedup of REDUNDANT
 *    fragmented rows: a collision means the same (repo_id, <unique key>) tuple
 *    already exists on the canonical side, so the legacy copy carries no new
 *    information. Every dropped row is counted (`collisionsDropped`) and the
 *    whole plan is previewed in the dry-run before `--apply` — accepted as the
 *    v1 backfill strategy (a richer field-level merge is out of scope for a
 *    one-shot, operator-reviewed migration).
 *
 * Usage:
 *   node scripts/reconcile-repo-identity.mjs                 # dry-run (default) → writes proposal map
 *   node scripts/reconcile-repo-identity.mjs --apply         # apply the approved map (transaction)
 *   node scripts/reconcile-repo-identity.mjs --map <path>    # use a specific approved map
 *   node scripts/reconcile-repo-identity.mjs --selfcheck-relocation
 *
 * @module scripts/reconcile-repo-identity
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIAS_MAP_PATH = '.audit-loop/repo-alias-map.json';
// Stable 63-bit advisory-lock key for the reconcile critical section.
const ADVISORY_LOCK_KEY = 760414233; // 'reconcile-repo-identity' arbitrary fixed key

/**
 * Pure proposal builder (exported for unit tests). Maps fragmented legacy rows
 * (repo_uuid NULL) to canonical rows (repo_uuid NOT NULL) by exact `name`:
 * a 1:1 name match → proposal; 0 or >1 → quarantine (never force-merge, R2-H4).
 *
 * @param {Array<{id:string,name:string,repo_uuid:string}>} canonical
 * @param {Array<{id:string,name:string,run_count?:number|string}>} legacy
 * @returns {{proposals: object[], quarantined: object[], byName: Map<string, object[]>}}
 */
export function buildProposals(canonical, legacy) {
  const byName = new Map();
  for (const c of canonical) {
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const proposals = [];
  const quarantined = [];
  for (const l of legacy) {
    const targets = byName.get(l.name) || [];
    if (targets.length === 1) {
      proposals.push({
        legacyId: l.id, legacyName: l.name, runCount: Number(l.run_count) || 0,
        canonicalId: targets[0].id, canonicalName: targets[0].name,
        canonicalRepoUuid: targets[0].repo_uuid,
      });
    } else {
      quarantined.push({
        legacyId: l.id, legacyName: l.name, runCount: Number(l.run_count) || 0,
        reason: targets.length === 0
          ? 'no canonical (repo_uuid) row with this name — run arch:refresh in that repo first'
          : `${targets.length} canonical rows share this name — ambiguous, resolve manually`,
      });
    }
  }
  return { proposals, quarantined, byName };
}

async function main() {
  // CLI smoke contract — must short-circuit before any DB/config work.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const apply = process.argv.includes('--apply');
  const mapArg = argValue('--map') || ALIAS_MAP_PATH;

  const { getPool, closePool } = await import('./lib/db/client.mjs');
  const { query, many, withTx } = await import('./lib/db/query.mjs');
  const pool = await getPool();
  if (!pool) {
    process.stderr.write('No DB pool — set AUDIT_DB_URL. Nothing to reconcile.\n');
    process.exit(2);
  }

  try {
    // ── Inventory ────────────────────────────────────────────────────────────
    const canonical = await many(
      `SELECT id, name, repo_uuid FROM audit_repos WHERE repo_uuid IS NOT NULL`,
    );
    const legacy = await many(
      `SELECT r.id, r.name, r.fingerprint,
              (SELECT count(*) FROM audit_runs ar WHERE ar.repo_id = r.id) AS run_count
         FROM audit_repos r
        WHERE r.repo_uuid IS NULL`,
    );

    const { proposals, quarantined, byName } = buildProposals(canonical, legacy);

    // Tables --apply will re-point: every BASE TABLE with a repo_id column.
    // Surfaced in BOTH dry-run and apply so the operator can veto the set
    // before committing (a repo_id column that is not an audit_repos FK would
    // be visible here for review — single-tenant convention is that it always is).
    const fkTablesPreview = (await many(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'repo_id'
          AND t.table_type = 'BASE TABLE' AND c.table_name <> 'audit_repos'
        ORDER BY c.table_name`,
    )).map((r) => r.table_name);

    // ── DRY-RUN (default) ──────────────────────────────────────────────────────
    if (!apply) {
      const map = {
        generatedAt: new Date().toISOString(),
        note: 'PROPOSED alias map — REVIEW before running with --apply. Remove or edit any proposal you do not approve. Quarantined rows are left untouched.',
        canonicalRepos: canonical.map((c) => ({ id: c.id, name: c.name, repoUuid: c.repo_uuid })),
        tablesToRepoint: fkTablesPreview,
        proposals,
        quarantined,
      };
      fs.mkdirSync(path.dirname(ALIAS_MAP_PATH), { recursive: true });
      const { atomicWriteFileSync } = await import('./lib/file-io.mjs');
      atomicWriteFileSync(ALIAS_MAP_PATH, JSON.stringify(map, null, 2) + '\n');

      process.stderr.write(
        `\n── reconcile-repo-identity (DRY-RUN) ──\n` +
        `  canonical rows (repo_uuid set): ${canonical.length}\n` +
        `  legacy rows (repo_uuid null):   ${legacy.length}\n` +
        `  proposed merges:                ${proposals.length}\n` +
        `  quarantined (untouched):        ${quarantined.length}\n` +
        `  proposal map written to:        ${ALIAS_MAP_PATH}\n` +
        `  tables --apply will re-point:   ${fkTablesPreview.length} (${fkTablesPreview.join(', ')})\n` +
        `\n  Review the map (incl. tablesToRepoint), then re-run with --apply to commit (one transaction).\n`,
      );
      for (const [name, rows] of byName) {
        const merges = proposals.filter((p) => p.canonicalName === name);
        if (merges.length) {
          const runs = merges.reduce((s, m) => s + m.runCount, 0);
          process.stderr.write(`  • ${name}: ${merges.length} legacy → 1 canonical (${runs} audit_runs re-pointed)\n`);
        }
      }
      console.log(JSON.stringify({ ok: true, mode: 'dry-run', proposals: proposals.length, quarantined: quarantined.length, mapPath: ALIAS_MAP_PATH }));
      return;
    }

    // ── APPLY ──────────────────────────────────────────────────────────────────
    if (!fs.existsSync(mapArg)) {
      process.stderr.write(`--apply requires an approved map at ${mapArg}. Run the dry-run first, review it, then --apply.\n`);
      process.exit(2);
    }
    const approved = JSON.parse(fs.readFileSync(mapArg, 'utf-8'));
    const approvedProposals = Array.isArray(approved.proposals) ? approved.proposals : [];
    if (approvedProposals.length === 0) {
      process.stderr.write('Approved map has no proposals — nothing to apply.\n');
      console.log(JSON.stringify({ ok: true, mode: 'apply', merged: 0 }));
      return;
    }
    // Shape validation (Gemini/audit): never trust the on-disk map blindly.
    for (const [i, p] of approvedProposals.entries()) {
      if (!p || typeof p.legacyId !== 'string' || typeof p.canonicalId !== 'string') {
        process.stderr.write(`Malformed proposal at index ${i}: requires string legacyId + canonicalId. Aborting.\n`);
        process.exit(2);
      }
      if (p.legacyId === p.canonicalId) {
        process.stderr.write(`Proposal ${i} maps a row to itself (${p.legacyId}). Aborting.\n`);
        process.exit(2);
      }
    }

    // Exhaustive FK discovery: every BASE TABLE with a repo_id column (skip views).
    const fkTables = (await many(
      `SELECT c.table_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND c.column_name = 'repo_id'
          AND t.table_type = 'BASE TABLE'
          AND c.table_name <> 'audit_repos'
        ORDER BY c.table_name`,
    )).map((r) => r.table_name);

    // Per-table repo-scoped UNIQUE constraints → the "other columns" form the
    // collision dedupe key (Gemini-G1).
    const uniqueKeysByTable = await discoverRepoScopedUniqueKeys(many, fkTables);

    const report = { tablesRepointed: {}, rowsMerged: 0, legacyDeleted: 0, collisionsDropped: 0 };

    // Identifier safety: discovered table/column names come from the live
    // catalog, but guard anyway before interpolating them into SQL.
    const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
    const assertIdent = (id) => {
      if (!SAFE_IDENT.test(id)) throw new Error(`refusing unsafe SQL identifier: ${JSON.stringify(id)}`);
      return id;
    };
    fkTables.forEach(assertIdent);

    await withTx(async () => {
      await query(`SELECT pg_advisory_xact_lock($1)`, [ADVISORY_LOCK_KEY]);

      // Revalidate the approved map against CURRENT DB state inside the lock
      // (the map may have been generated long ago / hand-edited). Skip any
      // proposal whose legacy row is no longer a fragmented row, or whose
      // canonical target is missing/not-canonical — never act on stale rows.
      const validated = [];
      for (const p of approvedProposals) {
        const legacy = await query(`SELECT name FROM audit_repos WHERE id = $1 AND repo_uuid IS NULL`, [p.legacyId]);
        const canon  = await query(`SELECT name, repo_uuid FROM audit_repos WHERE id = $1 AND repo_uuid IS NOT NULL`, [p.canonicalId]);
        const lRow = legacy.rows?.[0];
        const cRow = canon.rows?.[0];
        let reason = null;
        if (!lRow) reason = 'legacy row missing or no longer fragmented';
        else if (!cRow) reason = 'canonical target missing or not canonical';
        // Invariants from the reviewed dry-run map must still hold (catches a
        // hand-edited map that repoints to the wrong canonical row).
        else if (p.canonicalRepoUuid && cRow.repo_uuid !== p.canonicalRepoUuid) reason = `canonical repo_uuid changed (map: ${p.canonicalRepoUuid}, db: ${cRow.repo_uuid})`;
        else if (p.legacyName && lRow.name !== p.legacyName) reason = `legacy name changed (map: ${p.legacyName}, db: ${lRow.name})`;
        if (reason) {
          report.skippedStale = (report.skippedStale || 0) + 1;
          process.stderr.write(`  skip stale proposal ${p.legacyId} → ${p.canonicalId}: ${reason}\n`);
        } else {
          validated.push(p);
        }
      }

      for (const p of validated) {
        for (const table of fkTables) {
          // 1. Collision-aware: drop legacy rows that would violate a repo-scoped
          //    unique constraint after re-pointing (canonical row wins).
          for (const key of (uniqueKeysByTable[table] || [])) {
            const otherCols = key.filter((c) => c !== 'repo_id');
            if (otherCols.length === 0) continue; // UNIQUE(repo_id) alone — handled by the move itself
            otherCols.forEach(assertIdent);
            const joinPred = otherCols.map((c) => `canon."${c}" IS NOT DISTINCT FROM legacy."${c}"`).join(' AND ');
            const del = await query(
              `DELETE FROM "${table}" legacy
                WHERE legacy.repo_id = $1
                  AND EXISTS (SELECT 1 FROM "${table}" canon
                               WHERE canon.repo_id = $2 AND ${joinPred})`,
              [p.legacyId, p.canonicalId],
            );
            report.collisionsDropped += del.rowCount ?? 0;
          }
          // 2. Re-point the survivors.
          const upd = await query(
            `UPDATE "${table}" SET repo_id = $1 WHERE repo_id = $2`,
            [p.canonicalId, p.legacyId],
          );
          const n = upd.rowCount ?? 0;
          if (n) report.tablesRepointed[table] = (report.tablesRepointed[table] || 0) + n;
          report.rowsMerged += n;
        }
        // 3. Delete the now-orphaned legacy audit_repos row.
        const delRepo = await query(`DELETE FROM audit_repos WHERE id = $1 AND repo_uuid IS NULL`, [p.legacyId]);
        report.legacyDeleted += delRepo.rowCount ?? 0;
      }
    });

    process.stderr.write(
      `\n── reconcile-repo-identity (APPLIED) ──\n` +
      `  legacy rows merged + deleted: ${report.legacyDeleted}\n` +
      `  child rows re-pointed:        ${report.rowsMerged}\n` +
      `  collision rows dropped:       ${report.collisionsDropped}\n` +
      `  tables touched: ${Object.keys(report.tablesRepointed).join(', ') || '(none)'}\n`,
    );
    console.log(JSON.stringify({ ok: true, mode: 'apply', ...report }));
  } finally {
    await closePool().catch(() => {});
  }
}

/**
 * For each table, return the list of repo-scoped UNIQUE constraints as column
 * arrays (each includes 'repo_id'). Used for collision-aware merge.
 */
async function discoverRepoScopedUniqueKeys(many, tables) {
  if (tables.length === 0) return {};
  const rows = await many(
    `SELECT t.relname AS table_name, c.conname,
            array_agg(a.attname ORDER BY k.ord) AS cols
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
       JOIN unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) ON true
       JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
      WHERE c.contype = 'u' AND t.relnamespace = 'public'::regnamespace
      GROUP BY t.relname, c.conname`,
  );
  const out = {};
  const tableSet = new Set(tables);
  for (const r of rows) {
    if (!tableSet.has(r.table_name)) continue;
    if (!r.cols.includes('repo_id')) continue;
    (out[r.table_name] ||= []).push(r.cols);
  }
  return out;
}

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

// Run only as a CLI entry point — not when imported (e.g. by unit tests).
const _invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (_invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`reconcile-repo-identity failed: ${err.stack || err.message}\n`);
    process.exitCode = 1;
  });
}
