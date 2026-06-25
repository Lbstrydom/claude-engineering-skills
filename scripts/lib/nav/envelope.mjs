/**
 * @fileoverview Observed nav-graph envelope read/write — clones the
 * `observed-deps.mjs` lifecycle (Zod-validated on-disk envelope, atomic write,
 * config-digest staleness rejection) for the nav graph.
 *
 * Plan note (§4a.D / R1-M5): the plan contemplated factoring a repo-shared
 * `scripts/lib/observed-envelope.mjs` "only if direct reuse is insufficient."
 * The observed-deps envelope keys on `deps` (domain→domain) and this one keys on
 * `edges` (nav affordances) — the shapes differ enough that a generic helper
 * would be over-abstraction for two call sites. We instead MIRROR the proven
 * pattern in this nav-scoped module (no cross-domain import, no copy-paste of
 * domain-deps logic). If a third envelope consumer appears, factor then.
 *
 * @module scripts/lib/nav/envelope
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { NavObservedSchema, OBSERVED_FILE, computeConfigDigest } from './schema.mjs';

/**
 * Read + validate the observed envelope. Mirrors `observed-deps.mjs`'s
 * read-then-validate-then-digest-check shape.
 *
 * @param {string} root - repo root
 * @param {string} expectedConfigDigest - recomputed from the live contract
 * @returns {{envelope: object|null, rejectedReason: string|null}}
 */
export function readObservedEnvelope(root, expectedConfigDigest) {
  const file = path.join(root, OBSERVED_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') return { envelope: null, rejectedReason: null };
    return { envelope: null, rejectedReason: `observed envelope unreadable: ${err.message}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { envelope: null, rejectedReason: `observed envelope malformed JSON: ${err.message}` };
  }
  const result = NavObservedSchema.safeParse(parsed);
  if (!result.success) {
    return { envelope: null, rejectedReason: `observed envelope failed schema: ${result.error.issues[0]?.message ?? 'invalid'}` };
  }
  // Config-digest rejection (the proven domainMapDigest pattern). When the
  // caller passes an expected digest and it mismatches, the envelope is stale:
  // the contract or tool version moved without a fresh regeneration.
  if (expectedConfigDigest && result.data.configDigest !== expectedConfigDigest) {
    return { envelope: null, rejectedReason: 'observed envelope stale: config digest changed without regeneration — re-run /nav-audit' };
  }
  return { envelope: result.data, rejectedReason: null };
}

/**
 * Atomically write the observed envelope. The caller assembles a valid envelope;
 * we validate before write (boundary validation, schemas-at-boundaries rule) so a
 * malformed in-memory object never lands on disk.
 *
 * @param {string} root
 * @param {object} envelope - must satisfy NavObservedSchema
 * @returns {string} the path written
 */
export function writeObservedEnvelope(root, envelope) {
  const result = NavObservedSchema.safeParse(envelope);
  if (!result.success) {
    throw new Error(`refusing to write invalid nav envelope: ${result.error.issues[0]?.message ?? 'invalid'}`);
  }
  const file = path.join(root, OBSERVED_FILE);
  atomicWriteFileSync(file, JSON.stringify(result.data, null, 2));
  return file;
}

/**
 * Assemble an envelope from extracted edges + the contract digest.
 * @param {object} args
 * @param {string} args.refreshId
 * @param {string} args.contractDigest
 * @param {string|null} args.headSha
 * @param {string} args.generatedAt - ISO-8601 (caller supplies; no Date.now() here)
 * @param {object[]} args.edges
 * @param {object} [args.recall]
 * @returns {object} envelope
 */
export function assembleEnvelope({ refreshId, contractDigest, headSha, generatedAt, edges, destinations, recall }) {
  return {
    version: 1,
    refreshId,
    configDigest: computeConfigDigest({ contractDigest }),
    headSha: headSha ?? null,
    generatedAt,
    edges: edges ?? [],
    destinations: (destinations ?? []).map((d) => ({ id: d.id })),
    ...(recall ? { recall } : {}),
  };
}
