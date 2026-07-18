/**
 * @fileoverview Store seam for the friction-feedback mirror (`memory_friction`).
 * Plan: docs/plans/friction-feedback-loop.md (Cluster A). The memory file is the
 * source of truth; these are the DB-mirror writes/reads. All graceful-cloud-off
 * (no-op when AUDIT_DB_URL is unset), exactly like the other store modules.
 *
 * jsonb/array seam (M3 rule): `mitigation_refs` (jsonb) is passed RAW (the
 * db/query.mjs write seam JSON-serializes it); `scope_tags`/`files`/`symbols`
 * (genuine text[]) opt OUT via `pgArray()`.
 *
 * @module scripts/lib/store/friction
 */
import { z } from 'zod';
import { upsert, query, pgArray } from '../db/query.mjs';
import { frictionRecurrence as rpcRecurrence, frictionNeighbourhood as rpcNeighbourhood } from '../db/rpc.mjs';
import { isCloudEnabled } from './repo.mjs';
// GENTLE secret-shape redactor — NOT sanitizer.mjs (it blanket-redacts any 20+ char
// token and would corrupt friction prose). AGENTS.md security seam.
import { redactSecrets } from '../secret-patterns.mjs';
import { classifyPath } from '../sensitive-paths.mjs';

/** Mitigation-ref identity (closure artifact). */
const MitigationRefSchema = z.object({
  kind: z.enum(['commit', 'agents_rule', 'doc', 'test', 'durable_memory', 'ignore']),
  ref: z.string().min(1),
}).strict();

/** Validated friction mirror-row shape (store boundary — before any DB write). */
const FrictionRowSchema = z.object({
  memory_name: z.string().min(1),
  source_hash: z.string().min(1),
  title: z.string().min(1),
  body_excerpt: z.string().default(''),
  scope_tags: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  symbols: z.array(z.string()).default([]),
  cost: z.enum(['S', 'M', 'L']).default('M'),
  fingerprint: z.string().min(1),
  trgm_text: z.string().min(1),
  signature_text: z.string().default(''),
  mitigation_refs: z.array(MitigationRefSchema).default([]),
}).strip();

// secret-patterns.redactSecrets returns { text, redacted } — take `.text` (the
// repo-wide convention; sanitizer.mjs's same-named fn would corrupt prose).
const redact = (s) => (typeof s === 'string' ? redactSecrets(s).text : s);
const redactArr = (a) => (Array.isArray(a) ? a.map(redact) : []);
/** Drop any file path that classifies as sensitive (defense-in-depth; the parser is the primary gate). */
const safeFiles = (a) => (Array.isArray(a) ? a.filter((p) => classifyPath(p) !== 'sensitive') : []);
const SeenNamesSchema = z.array(z.string().min(1));

/**
 * Build the exact DB-write payload for one friction row — validate (store
 * boundary) → redact every egressing field → `pgArray`-wrap the genuine `text[]`
 * cols → pass `mitigation_refs` as a raw jsonb array. Extracted as a PURE,
 * exported function (no cloud/DB) so the jsonb-vs-`pgArray` M3 serialization class
 * is regression-tested against the REAL code path instead of a hand-rebuilt copy
 * that could silently drift (audit M16). `now` is injectable for deterministic tests.
 *
 * @param {string} repoId
 * @param {object} row - raw mirror row (memory-paths buildRow shape)
 * @param {{now?: string}} [opts]
 * @returns {object} the upsert payload (jsonb raw, text[] via pgArray)
 */
export function buildFrictionUpsertPayload(repoId, row, { now } = {}) {
  if (!repoId) throw new TypeError('buildFrictionUpsertPayload: repoId is required');
  const v = FrictionRowSchema.parse(row);   // validate at the store boundary (cost enum, arrays, required)
  // Redact secret SHAPES on every field that reaches the DB (the egress boundary — can't be bypassed).
  return {
    repo_id: repoId,
    memory_name: v.memory_name,
    source_hash: v.source_hash,
    active: true,
    title: redact(v.title),
    body_excerpt: redact(v.body_excerpt),
    scope_tags: pgArray(redactArr(v.scope_tags)),  // genuine text[] (elements redacted)
    files: pgArray(redactArr(safeFiles(v.files))), // sensitive paths dropped, then redacted
    symbols: pgArray(redactArr(v.symbols)),        // genuine text[]
    cost: v.cost,
    fingerprint: v.fingerprint,
    trgm_text: redact(v.trgm_text),
    signature_text: redact(v.signature_text),
    mitigation_refs: v.mitigation_refs.map((m) => ({ ...m, ref: redact(m.ref) })), // jsonb — RAW
    last_seen_at: now ?? new Date().toISOString(),
  };
}

/**
 * Idempotent upsert of one friction row (keyed on repo_id + memory_name).
 * Pass the row with raw JS values; the seam handles serialization.
 * @returns {Promise<{upserted: number}>}
 */
export async function upsertFrictionRow(repoId, row) {
  if (!await isCloudEnabled()) return { upserted: 0 };
  const payload = buildFrictionUpsertPayload(repoId, row);   // throws on missing repoId (cloud-on path)
  const { rowCount } = await upsert('memory_friction', [payload], {
    onConflict: ['repo_id', 'memory_name'],
    update: 'all',
  });
  // Unverified-write guard (RLS / 0-row silent failure — AGENTS.md store invariant).
  if (!rowCount || rowCount < 1) {
    throw new Error(`upsertFrictionRow: wrote 0 rows for ${payload.memory_name} (RLS or constraint?) — write unverified`);
  }
  return { upserted: rowCount };
}

/**
 * Current `(memory_name → source_hash)` map for this repo's ACTIVE rows. Lets the
 * mirror skip an upsert when the file bytes are unchanged (C5 `unchanged` count).
 * **ACTIVE-only is load-bearing (H10):** an inactive (tombstoned) row must NOT
 * count as "unchanged" — otherwise a tombstoned-then-restored note (same bytes)
 * would be skipped and never reactivated. Excluding inactive rows forces the
 * unchanged-check to miss → the row is re-upserted → `active` flips back to true.
 * Returns an empty map when cloud is off or the repo has no active rows.
 * @returns {Promise<Map<string,string>>}
 */
export async function listFrictionSourceHashes(repoId) {
  if (!repoId) throw new TypeError('listFrictionSourceHashes: repoId is required');
  if (!await isCloudEnabled()) return new Map();
  const res = await query(
    'SELECT memory_name, source_hash FROM memory_friction WHERE repo_id = $1 AND active = true',
    [repoId],
  );
  const map = new Map();
  for (const r of res.rows ?? []) map.set(r.memory_name, r.source_hash);
  return map;
}

/**
 * Reconcile: tombstone (active=false) any OPEN row for this repo whose
 * memory_name was NOT seen this pass. Caller MUST only invoke after a COMPLETE
 * scan (a partial scan must never tombstone live notes). `seenNames` empty +
 * complete scan → tombstones everything (all friction memories were deleted).
 * @returns {Promise<{tombstoned: number}>}
 */
export async function reconcileTombstones({ repoId, seenNames, scanComplete } = {}) {
  if (!repoId) throw new TypeError('reconcileTombstones: repoId is required');
  // HARD refusal (C5 safety): a partial/failed scan must NEVER tombstone live rows.
  if (scanComplete !== true) return { tombstoned: 0, skipped: 'incomplete-scan' };
  const names = [...new Set(SeenNamesSchema.parse(seenNames))];   // validate + dedupe at the boundary
  if (!await isCloudEnabled()) return { tombstoned: 0 };
  // active rows whose name is not in the seen set → tombstone.
  const res = await query(
    `UPDATE memory_friction
        SET active = false
      WHERE repo_id = $1 AND active = true
        AND NOT (memory_name = ANY($2::text[]))
      RETURNING id`,
    [repoId, names],
  );
  return { tombstoned: res.rowCount ?? (res.rows?.length ?? 0) };
}

/** Append a mitigation ref to one row (closure). Re-reads + rewrites the jsonb array. */
export async function appendMitigationRef(repoId, memoryName, ref) {
  if (!repoId || !memoryName) throw new TypeError('appendMitigationRef: repoId and memoryName are required');
  const parsed = MitigationRefSchema.parse(ref);          // validate the closure artifact
  const safeRef = { ...parsed, ref: redact(parsed.ref) }; // redact the free-text ref
  if (!await isCloudEnabled()) return { updated: 0, cloud: false };
  // jsonb concat, idempotent via `@>` containment on the exact {kind,ref} (C6).
  const res = await query(
    `UPDATE memory_friction
        SET mitigation_refs = mitigation_refs || $3::jsonb
      WHERE repo_id = $1 AND memory_name = $2
        AND NOT (mitigation_refs @> $3::jsonb)
      RETURNING id`,
    [repoId, memoryName, JSON.stringify([safeRef])],
  );
  return { updated: res.rowCount ?? (res.rows?.length ?? 0) };
}

/** Recurrence clusters — cross-repo (repoIdFilter null) or one repo. */
export async function getFrictionRecurrence({ repoIdFilter = null, windowDays, minSimilarity } = {}) {
  if (!await isCloudEnabled()) return null;
  return rpcRecurrence({ repoIdFilter, windowDays, minSimilarity });
}

/** Injection neighbourhood — top-k open friction matching the prompt (repo-scoped). */
export async function getFrictionNeighbourhood({ repoId, prompt, k, minWordSim } = {}) {
  if (!repoId || typeof prompt !== 'string') throw new TypeError('getFrictionNeighbourhood: repoId and a string prompt are required');
  if (!prompt.trim()) return [];                  // empty prompt → nothing to match
  if (!await isCloudEnabled()) return [];
  return rpcNeighbourhood({ repoId, prompt, k, minWordSim });
}
