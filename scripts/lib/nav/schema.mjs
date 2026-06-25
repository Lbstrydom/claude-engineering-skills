/**
 * @fileoverview Zod contracts for the /nav-audit skill — single source of
 * truth for the three artifact shapes (plan docs/plans/nav-audit-skill.md §4a):
 *
 *   1. NavEdge          — one extracted navigation affordance (entry→destination)
 *   2. NavContract      — the committed `nav-contract.json` (personas→intents→anchors)
 *   3. NavObserved      — the gitignored observed-graph envelope (regenerated each run)
 *
 * The envelope lifecycle clones `observed-deps.mjs`: a config digest the reader
 * can independently recompute (contractDigest + adapterVersion) gates staleness;
 * source-file staleness is handled by regeneration + an advisory banner, never a
 * self-referential file-sha digest (plan §4a.D / Gemini-2-H).
 *
 * Zod 4 API (NOT Zod 3): `z.iso.datetime()`, `z.record(keyType, valueType)`,
 * `_def.type` is a string. See AGENTS.md Dependencies table.
 *
 * @module scripts/lib/nav/schema
 */
import crypto from 'node:crypto';
import { z } from 'zod';

/** Bumped when the extractor's edge semantics change — part of the config digest
 *  so a tool upgrade correctly invalidates a stale envelope. */
export const NAV_TOOL_VERSION = 1;

export const OBSERVED_FILE = '.audit-loop/nav-graph-observed.json';
export const DRIFT_LEDGER_FILE = '.audit-loop/nav-drift-ledger.json';
export const CONTRACT_FILE = 'nav-contract.json';

/** Affordance types — a primary tab is not an obscure CTA (plan §2.3); raw
 *  in-degree misleads, so the type is modelled per edge. */
export const AFFORDANCE_TYPES = /** @type {const} */ ([
  'link',            // <a href> / <Link to>
  'navigate-call',   // navigate()/router.push()/history.push()/switchView()/setView()
  'route-literal',   // a route object literal ({path, element})
  'modal-trigger',   // opens a modal/overlay pseudo-destination
  'redirect',        // programmatic redirect / <Navigate>
  'command-palette', // command-palette / search-driven nav
]);

export const CONFIDENCE = /** @type {const} */ (['high', 'medium', 'low']);

export const NavEdgeSchema = z.object({
  entryPoint: z.string().min(1),          // component/symbol that emits the affordance
  layer: z.string().min(1),               // nav layer key (primary|secondary|utility|content|…)
  anchor: z.string().nullable(),          // nearest declared-anchor ancestor (attributed), or null
  affordanceType: z.enum(AFFORDANCE_TYPES),
  label: z.string().nullable(),           // visible label, or null when unresolved
  destination: z.string().min(1),         // canonical destination id (§4a.A)
  confidence: z.enum(CONFIDENCE),
  sourceLoc: z.string().min(1),           // file:line[:col]
});

/** A single product intent: a persona needs `destination`, reachable from one of
 *  `approvedAnchors`, optionally required to sit in `requiredInLayer`. */
// Contract schemas are STRICT: a committed nav-contract.json with a typo'd key
// (`approvedAnchor`, `requiredLayer`) must FAIL loudly, not be silently stripped
// (audit M5/M14). The observed envelope is tool-generated, so it stays lenient.
export const NavIntentSchema = z.object({
  id: z.string().min(1),
  destination: z.string().min(1),
  approvedAnchors: z.array(z.string().min(1)).default([]),
  requiredInLayer: z.string().nullable().default(null),
  frequency: z.enum(['normal', 'high']).default('normal'),
  source: z.enum(['declared', 'inferred']).default('declared'),
}).strict();

export const NavPersonaSchema = z.object({
  id: z.string().min(1),
  intents: z.array(NavIntentSchema).default([]),
}).strict();

export const NavContractSchema = z.object({
  version: z.literal(1),
  appRoots: z.array(z.string().min(1)).optional(),
  // navLayers: { primary: [anchor,…], secondary: [anchor,…], … }
  navLayers: z.record(z.string(), z.array(z.string().min(1))).default({}),
  personas: z.array(NavPersonaSchema).default([]),
}).strict();

export const NavObservedSchema = z.object({
  version: z.literal(NAV_TOOL_VERSION),
  refreshId: z.string().min(1),
  configDigest: z.string().regex(/^[0-9a-f]{64}$/),
  headSha: z.string().nullable(),         // display provenance only — NOT in the digest
  generatedAt: z.iso.datetime({ offset: true }), // git %cI carries a tz offset

  edges: z.array(NavEdgeSchema).default([]),
  // The adapter-discovered route inventory is persisted too (audit R2-H4): a
  // zero-inbound route exists only here, so the dashboard/drift reader needs it
  // to reconstruct orphans from the envelope alone.
  destinations: z.array(z.object({ id: z.string().min(1) })).default([]),
  recall: z.object({
    extracted: z.number().int().nonnegative(),
    lowConfidence: z.number().int().nonnegative(),
    opaque: z.number().int().nonnegative(),
  }).optional(),
});

/**
 * Canonical digest of the contract's *meaningful* content (personas/intents/
 * navLayers/appRoots) — stable across key ordering and cosmetic edits so the
 * reader can recompute it from the committed file.
 * @param {unknown} contract
 * @returns {string} sha256 hex
 */
export function computeContractDigest(contract) {
  const c = contract && typeof contract === 'object' ? contract : {};
  const canonical = JSON.stringify({
    appRoots: Array.isArray(c.appRoots) ? [...c.appRoots].sort() : [],
    navLayers: sortRecordOfArrays(c.navLayers),
    personas: (Array.isArray(c.personas) ? c.personas : [])
      .map((p) => ({
        id: p?.id ?? '',
        intents: (Array.isArray(p?.intents) ? p.intents : [])
          .map((i) => ({
            id: i?.id ?? '',
            destination: i?.destination ?? '',
            approvedAnchors: Array.isArray(i?.approvedAnchors) ? [...i.approvedAnchors].sort() : [],
            requiredInLayer: i?.requiredInLayer ?? null,
            frequency: i?.frequency ?? 'normal',
            // `source` IS part of the contract's authority semantics (declared vs
            // inferred) — confirming an inferred intent must change the digest so
            // CI re-evaluates (audit H7).
            source: i?.source ?? 'declared',
          }))
          .sort((a, b) => a.id.localeCompare(b.id)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
  return sha256(canonical);
}

/**
 * The envelope's staleness digest — ONLY inputs the reader can independently
 * recompute (plan §4a.D / Gemini-2-H). Deliberately excludes source-file shas:
 * a self-referential file-sha digest cannot detect a nav link added in a *new*
 * file, so it would silently report false-fresh.
 * @param {{adapterVersion?: number, contractDigest: string}} parts
 * @returns {string} sha256 hex
 */
export function computeConfigDigest({ adapterVersion = NAV_TOOL_VERSION, contractDigest }) {
  return sha256(JSON.stringify({ adapterVersion, contractDigest }));
}

function sortRecordOfArrays(rec) {
  if (!rec || typeof rec !== 'object') return {};
  const out = {};
  for (const k of Object.keys(rec).sort()) {
    out[k] = Array.isArray(rec[k]) ? [...rec[k]].sort() : [];
  }
  return out;
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
