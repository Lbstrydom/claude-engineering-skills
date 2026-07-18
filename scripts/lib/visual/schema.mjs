/**
 * @fileoverview Zod contracts for the /visual-audit skill — single source of
 * truth for the artifact shapes (plan docs/plans/visual-audit-skill.md §2a/§2b):
 *
 *   1. VisualContract   — the committed `visual-contract.json` (product intent:
 *                          contracted surfaces, token sources, themes, gate scope)
 *   2. AllowedSet       — declared token allowed-set extracted from token sources
 *   3. VisualObserved   — the gitignored observed envelope (allowed-set + surfaces)
 *   4. VisualVerifyResult — the gitignored live-result (per device×theme findings)
 *   5. VisualFinding    — one deterministic finding
 *
 * Mirrors scripts/lib/nav/schema.mjs: a config digest the reader can recompute
 * (contractDigest + adapterVersion) gates envelope staleness; contract schemas are
 * STRICT (typos fail loudly); observed/verify envelopes are lenient (tool output).
 *
 * Zod 4 API (NOT Zod 3): `z.iso.datetime()`, `z.record(keyType, valueType)`,
 * `z.discriminatedUnion(...)`, `_def.type` is a string. See AGENTS.md.
 *
 * @module scripts/lib/visual/schema
 */
import crypto from 'node:crypto';
import { z } from 'zod';

/** OBSERVED-envelope schema version — bumped when the static extractor semantics
 *  change (part of the config digest so a tool upgrade invalidates a stale env). */
export const VISUAL_TOOL_VERSION = 1;
/** Live-RESULT tool-semantics version (decoupled from the observed-envelope schema
 *  version, mirroring nav's NAV_VERIFY_TOOL_VERSION). Bumped when live findings'
 *  semantics change so a stale persisted result is rejected.
 *  v2: theme-safety v2 — `contrast_parity_delta` class + fail-closed theme-pair
 *  resolution + parity key-ambiguity coverage (a v1 persisted result predates
 *  these semantics). */
export const VISUAL_VERIFY_TOOL_VERSION = 2;

export const CONTRACT_FILE = 'visual-contract.json';
// Committed accepted-findings ratchet (like a lint baseline): `--gate` blocks only
// on gate-eligible findings whose divergenceKey is NOT in here, so a noisy app can
// adopt a blocking gate by snapshotting today's defensible findings as accepted and
// failing only on NEW regressions. `--update-baseline` rewrites it.
export const BASELINE_FILE = 'visual-audit-baseline.json';
export const OBSERVED_FILE = '.audit-loop/visual-observed.json';
export const VERIFY_RESULT_FILE = '.audit-loop/visual-verify-result.json';
export const DRIFT_LEDGER_FILE = '.audit-loop/visual-drift-ledger.json';

/** Token families an allowed-set tracks (plan §2a TIER 1). */
export const TOKEN_FAMILIES = /** @type {const} */ ([
  'colors', 'spacing', 'radius', 'borderWidth',
  'fontSize', 'lineHeight', 'fontWeight', 'shadow',
]);

/** The full finding taxonomy (plan §2 + reference finding-taxonomy.md). Only a
 *  subset is gate-eligible — see GATE_ELIGIBLE_CLASSES. */
export const FINDING_CLASSES = /** @type {const} */ ([
  'token_violation',
  'theme_geometry_drift',
  'theme_unmapped_token',
  'contrast_failure',
  'layout_overflow',
  'content_clipping',
  'unexpected_overlap',
  'image_distortion',
  'missing_visible_focus',
  'state_has_no_visual_delta',
  'disabled_not_signified',
  'component_inconsistency',   // report-only unless a component is declared
  'token_unreferenced',        // source-coherence: defined-but-unused (report-only)
  'token_undefined_reference', // source-coherence: contract cites an undefined token (report-only)
  'token_duplicate_definition',// source-coherence: same token defined twice (report-only)
  'interactive_color_unset',   // theme-safety static lint: interactive selector styles the box but not `color` (report-only)
  'unadapted_text_color',      // theme-safety runtime: UA-default text color on an author-styled form control (report-only)
  'contrast_parity_delta',     // theme-safety v2: contrast passes in one theme, fails in the other — full-DOM sweep only (report-only)
]);

/** Classes that CAN block CI (still subject to changed-surface scoping). Inferred
 *  clustering, component-consistency without a declared component, and all
 *  source-coherence diagnostics are deliberately NOT here (plan §2 decision 2). */
export const GATE_ELIGIBLE_CLASSES = new Set([
  'token_violation',
  'theme_geometry_drift',
  'theme_unmapped_token',
  'contrast_failure',
  'layout_overflow',
  'content_clipping',
  'unexpected_overlap',
  'image_distortion',
  'missing_visible_focus',
  'disabled_not_signified',
]);

export const SEVERITY = /** @type {const} */ (['P0', 'P1', 'P2', 'P3', 'info']);

// ── Contract (committed, STRICT) ────────────────────────────────────────────

const SurfaceSchema = z.object({
  id: z.string().min(1),
  label: z.string().optional(),
  selector: z.string().min(1),
  sourceGlobs: z.array(z.string().min(1)).default([]),
  component: z.string().optional(),
  excludeSelectors: z.array(z.string().min(1)).default([]),
  allowOverlapWith: z.array(z.string().min(1)).default([]),
  nodeBudget: z.number().int().positive().default(400),
  interactiveBudget: z.number().int().positive().default(120),
}).strict();

const TokenSourceSchema = z.object({
  type: z.enum(['tailwind', 'css-vars', 'json']),
  path: z.string().min(1),
  theme: z.string().nullable().default(null),
  families: z.array(z.enum(TOKEN_FAMILIES)).default([...TOKEN_FAMILIES]),
}).strict();

// Discriminated union on `mode` (plan §2b-E / M2): each theme-apply mode carries
// only its own required fields, so a `class` theme can't silently omit `value`.
const ThemeApplySchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('class'),
    target: z.string().min(1).default('html'),
    value: z.string().min(1),
    settleSelector: z.string().nullable().default(null),
  }).strict(),
  z.object({
    mode: z.literal('attribute'),
    target: z.string().min(1).default('html'),
    attribute: z.string().min(1),
    value: z.string().min(1),
    settleSelector: z.string().nullable().default(null),
  }).strict(),
  z.object({
    mode: z.literal('localStorage'),
    key: z.string().min(1),
    value: z.string().min(1),
    settleSelector: z.string().nullable().default(null),
  }).strict(),
  z.object({
    mode: z.literal('media'),
    colorScheme: z.enum(['light', 'dark']),
    settleSelector: z.string().nullable().default(null),
  }).strict(),
]);

const ThemeSchema = z.object({
  name: z.string().min(1),
  apply: ThemeApplySchema,
}).strict();

export const VisualContractSchema = z.object({
  version: z.literal(1),
  _note: z.string().optional(),
  _comment: z.string().optional(),
  appRoots: z.array(z.string().min(1)).optional(),
  exclude: z.array(z.string().min(1)).optional(),
  surfaces: z.array(SurfaceSchema).default([]),
  tokenSources: z.array(TokenSourceSchema).default([]),
  themes: z.array(ThemeSchema).default([]),
  // Edits to these globs cascade into surfaces they don't textually live in →
  // mark ALL surfaces gate-eligible (plan §2b-H rule (d), Gemini-G2-2).
  globalStyleGlobs: z.array(z.string().min(1)).default([]),
  tolerances: z.object({
    geometryPx: z.number().nonnegative().default(1),
    contrastRatio: z.number().positive().default(4.5),
  }).default({ geometryPx: 1, contrastRatio: 4.5 }),
  propertyPolicy: z.object({
    tokenAudited: z.array(z.enum(TOKEN_FAMILIES)).default([...TOKEN_FAMILIES]),
    mustMatchGeometry: z.array(z.string().min(1)).default(
      ['width', 'height', 'flex-basis', 'grid-template', 'padding', 'margin'],
    ),
  }).default({
    tokenAudited: [...TOKEN_FAMILIES],
    mustMatchGeometry: ['width', 'height', 'flex-basis', 'grid-template', 'padding', 'margin'],
  }),
}).strict()
  // Identity uniqueness (audit R3-H1 — single source of truth): a duplicated
  // theme name or surface id makes downstream pairing/scoping ambiguous. The
  // producers carry quiet guards as backstops, but the CONTRACT is where a
  // malformed identity must fail — loudly, at parse time.
  .refine((c) => new Set(c.themes.map((t) => t.name)).size === c.themes.length,
    { message: 'themes[].name must be unique' })
  .refine((c) => new Set(c.surfaces.map((s) => s.id)).size === c.surfaces.length,
    { message: 'surfaces[].id must be unique' });

// ── Allowed-set + observed envelope (tool-generated, lenient) ────────────────

/** A per-family map of canonical-value → token metadata. Built by tokens.mjs. */
export const AllowedSetSchema = z.object({
  // family → array of { value, varName, sourceFile, theme }
  families: z.record(
    z.string(),
    z.array(z.object({
      value: z.string(),
      varName: z.string().nullable().default(null),
      sourceFile: z.string().nullable().default(null),
      theme: z.string().nullable().default(null),
    })),
  ).default({}),
  inferredMode: z.boolean().default(false),
  warnings: z.array(z.string()).default([]),
});

export const VisualObservedSchema = z.object({
  version: z.literal(VISUAL_TOOL_VERSION),
  refreshId: z.string().min(1),
  configDigest: z.string().regex(/^[0-9a-f]{64}$/),
  headSha: z.string().nullable(),
  generatedAt: z.iso.datetime({ offset: true }),
  allowedSet: AllowedSetSchema,
  surfaces: z.array(z.object({
    id: z.string().min(1),
    sourceGlobs: z.array(z.string()).default([]),
  })).default([]),
  // Static-layer (no-browser) diagnostics: source-coherence findings (report-only).
  diagnostics: z.array(z.object({
    class: z.string(),
    severity: z.enum(SEVERITY),
    detail: z.string(),
  })).default([]),
});

// ── Findings + verify result ────────────────────────────────────────────────

export const VisualFindingSchema = z.object({
  class: z.enum(FINDING_CLASSES),
  severity: z.enum(SEVERITY),
  surfaceId: z.string().nullable().default(null),
  nodeKey: z.string().nullable().default(null),
  device: z.string().nullable().default(null),
  theme: z.string().nullable().default(null),
  property: z.string().nullable().default(null),
  expected: z.string().nullable().default(null),
  actual: z.string().nullable().default(null),
  evidence: z.array(z.string()).default([]),
  gateEligible: z.boolean().default(false),
  source: z.enum(['static', 'live']).default('live'),
});

export const VisualVerifyResultSchema = z.object({
  version: z.literal(VISUAL_VERIFY_TOOL_VERSION),
  url: z.string().min(1),
  generatedAt: z.iso.datetime({ offset: true }),
  contractDigest: z.string().regex(/^[0-9a-f]{64}$/),
  toolVersion: z.number().int().optional(),
  statesRequested: z.array(z.string()).default([]),
  statesCollected: z.array(z.string()).default([]),
  // surfaces that were declared but visible-but-empty / never-observable → degrade
  // (plan §5 capture honesty, Gemini-G2-1).
  unverifiableSurfaces: z.array(z.string()).default([]),
  findings: z.array(VisualFindingSchema).default([]),
  warnings: z.array(z.string()).default([]),
});

// ── Digests ─────────────────────────────────────────────────────────────────

/**
 * Canonical digest of the contract's meaningful content — stable across key
 * ordering so the reader can recompute it from the committed file (mirrors
 * nav's computeContractDigest).
 * @param {unknown} contract
 * @returns {string} sha256 hex
 */
export function computeContractDigest(contract) {
  const c = contract && typeof contract === 'object' ? contract : {};
  const canonical = JSON.stringify({
    appRoots: arrSort(c.appRoots),
    exclude: arrSort(c.exclude),
    globalStyleGlobs: arrSort(c.globalStyleGlobs),
    surfaces: (Array.isArray(c.surfaces) ? c.surfaces : [])
      .map((s) => ({
        id: s?.id ?? '',
        selector: s?.selector ?? '',
        sourceGlobs: arrSort(s?.sourceGlobs),
        component: s?.component ?? null,
        excludeSelectors: arrSort(s?.excludeSelectors),
        allowOverlapWith: arrSort(s?.allowOverlapWith),
        nodeBudget: s?.nodeBudget ?? 400,
        interactiveBudget: s?.interactiveBudget ?? 120,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    tokenSources: (Array.isArray(c.tokenSources) ? c.tokenSources : [])
      .map((t) => ({ type: t?.type ?? '', path: t?.path ?? '', theme: t?.theme ?? null, families: arrSort(t?.families) }))
      .sort((a, b) => `${a.path}:${a.theme}`.localeCompare(`${b.path}:${b.theme}`)),
    themes: (Array.isArray(c.themes) ? c.themes : [])
      .map((t) => ({ name: t?.name ?? '', apply: t?.apply ?? {} }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    tolerances: c.tolerances ?? {},
    propertyPolicy: {
      tokenAudited: arrSort(c.propertyPolicy?.tokenAudited),
      mustMatchGeometry: arrSort(c.propertyPolicy?.mustMatchGeometry),
    },
  });
  return sha256(canonical);
}

/**
 * The envelope's staleness digest — only inputs the reader can recompute (mirrors
 * nav's computeConfigDigest). Deliberately excludes source-file shas.
 * @param {{adapterVersion?: number, contractDigest: string}} parts
 * @returns {string} sha256 hex
 */
export function computeConfigDigest({ adapterVersion = VISUAL_TOOL_VERSION, contractDigest }) {
  return sha256(JSON.stringify({ adapterVersion, contractDigest }));
}

function arrSort(a) {
  return Array.isArray(a) ? [...a].map(String).sort() : [];
}

// @duplicate-justification: target=scripts/lib/nav/schema.mjs:sha256 reason=nav-audit and visual-audit are a deliberately independent "sister lens" pair (AGENTS.md skill-naming-convention note) -- zero existing nav<->visual imports today, not accidental duplication
function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}
