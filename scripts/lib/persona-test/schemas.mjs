/**
 * @fileoverview Single source of truth for all consistency-mode Zod schemas.
 * Phase 0 of docs/plans/persona-test-consistency-mode.md — the contract layer.
 *
 * Everything downstream (manifest-resolver, capture library, consistency diff,
 * canary runner, ledger writer, semantic-compare) imports types from this
 * module so the contract drift cannot happen between files.
 *
 * Zod 4 idioms: `z.discriminatedUnion(<key>, variants)`, `z.literal()` for
 * narrowing, `.refine()` for cross-field invariants. AGENTS.md rule —
 * `_def.type` (string) for introspection, NOT `_def.typeName`.
 *
 * @module scripts/lib/persona-test/schemas
 */
import { z } from 'zod';

// ────────────────────────────────────────────────────────────────────────────
// Engine claim field types — enum used by both surfaces.json and the diff
// engine to decide exact-match vs semantic-match.
// ────────────────────────────────────────────────────────────────────────────

export const ENGINE_CLAIM_FIELD_TYPES = Object.freeze([
  'boolean',
  'enum',
  'integer',
  'count',
  'id',
  'freshness',
  'prose',
]);

const EngineClaimFieldTypeSchema = z.enum(ENGINE_CLAIM_FIELD_TYPES);

const SeveritySchema = z.enum(['P0', 'P1', 'P2', 'P3']);
const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

// Resolves R2-H11: regex patterns in the manifest are validated at load
// time, not silently no-matched at runtime. A bad pattern fails the
// manifest parse — operators see the error at the boundary instead of
// debugging "the rig doesn't see my surface" days later.
const RegexPatternSchema = z.string().min(1).refine(
  (s) => { try { new RegExp(s); return true; } catch { return false; } },
  { message: 'invalid regex pattern' },
);

// Declared up here (not next to ContradictionSchema below) because
// ExpectedContradictionShapeSchema in the canary schema references it,
// and the canary schema sits earlier in the file than the contradiction
// schemas. Move with care — the kinds list IS the contradiction grammar.
export const ContradictionKindSchema = z.enum([
  'value-mismatch',
  'stale-projection',
  'undeclared-engine-claim',
  'missing-surface',
  'value-coercion-error',
  'absent-not-rendered',
  'key-coercion-error',
  // R1-H13 — DOM claim with no matching network ground-truth is a
  // first-class outcome, not a silent skip. Severity clamped to
  // surface.severityFloor at most; default rank P2 when no floor.
  'unresolved-ground-truth',
  // Wine-cellar adoption round-2 #3 — locator matched an element in the
  // current DOM, but the element has no data-engine-claim attribute.
  // Different actionable signal from `missing-surface` (locator didn't
  // match anything) — this one means "you declared the surface in
  // manifest but haven't annotated the element yet". Common during
  // staged rollout (annotation in branch, canary against deployed URL).
  'unannotated-surface',
]);

// ────────────────────────────────────────────────────────────────────────────
// Locator — structured, not stringly-typed (resolves R1-M3).
// `kind` is the discriminator. `css` carries `warn:true` so the diff engine
// can emit a P2 "use semantic locator" finding without re-parsing the string.
// ────────────────────────────────────────────────────────────────────────────

export const LocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('role'),
    role: z.string().min(1),
    name: z.string().optional(),
  }),
  z.object({
    kind: z.literal('label'),
    text: z.string().min(1),
  }),
  z.object({
    kind: z.literal('testid'),
    id: z.string().min(1),
  }),
  // Resolves wine-cellar adoption #4 — `kind:'id'` for codebases without
  // data-testid attributes everywhere. HTML id is a stable semantic
  // selector (uniqueness is enforced by the HTML spec), so it doesn't
  // carry the css-kind `warn` flag; the rig considers id selectors
  // first-class alongside role/label/testid.
  z.object({
    kind: z.literal('id'),
    id: z.string().min(1).regex(/^[A-Za-z][\w-]*$/, 'HTML id must start with a letter and contain only word chars or hyphens'),
  }),
  z.object({
    kind: z.literal('css'),
    selector: z.string().min(1),
    warn: z.boolean().default(true),
  }),
]);

// ────────────────────────────────────────────────────────────────────────────
// Collection binding — resolves R1-H2.
// Lets a DOM element with `data-engine-scope="X" data-engine-key="Y"` map to
// a specific entry in a network response array.
// ────────────────────────────────────────────────────────────────────────────

export const CollectionBindingSchema = z.object({
  id: z.string().min(1),
  urlPattern: RegexPatternSchema,
  jsonPath: z.string().min(1),
  keyField: z.string().min(1),
});

// ────────────────────────────────────────────────────────────────────────────
// Applicability metadata — resolves R1-M4.
// Gates negative-space + freshness checks so route-conditional surfaces don't
// flag-as-absent on pages where they were never expected.
// ────────────────────────────────────────────────────────────────────────────

export const SurfaceApplicabilitySchema = z.object({
  routePattern: RegexPatternSchema.optional(),
  journeyStepLabels: z.array(z.string()).optional(),
  requiresState: z.array(z.string()).optional(),
});

// ────────────────────────────────────────────────────────────────────────────
// Network source — declares which endpoint(s) project an engineField.
// `excludeUrlPattern` replaces the (hallucinated) page.route alias mechanism
// (resolves Gemini-R1-G3 + R4-H1). Real Playwright API is page.on('response').
// ────────────────────────────────────────────────────────────────────────────

const NetworkSourceSchema = z.object({
  urlPattern: RegexPatternSchema,
  method: HttpMethodSchema.optional(),
  operationName: z.string().optional(),
  requestMatchers: z.array(z.object({
    location: z.enum(['body-json', 'query-string']),
    jsonPath: z.string().min(1),
    value: z.string(),
  })).optional(),
  jsonPath: z.string().min(1),
  captureWindow: z.enum(['step', 'step-end']).default('step-end'),
  winnerRule: z.enum(['latest', 'first']).default('latest'),
  excludeUrlPattern: RegexPatternSchema.optional(),
  // Wine-cellar round-3 #1 — per-source override for the runner's
  // auto-await-before-capture window. Default is the runner's
  // DEFAULT_AWAIT_MS (3000ms). Use for SPAs whose API call lives
  // behind a long auth/context boot chain. Capped at 30s — if you
  // need longer, your canary should declare an explicit wait step
  // instead of relying on the auto-await backstop.
  awaitTimeoutMs: z.number().int().positive().max(30000).optional(),
});

// ────────────────────────────────────────────────────────────────────────────
// EngineField — one declared claim on a surface.
// `llmSafe` (default false) gates LLM egress (resolves R1-H5).
// `llmMaxChars` caps prose length to LLM (resolves Gemini-R5-G1).
// ────────────────────────────────────────────────────────────────────────────

const EngineFieldSchema = z.object({
  field: z.string().min(1),
  type: EngineClaimFieldTypeSchema,
  semanticValues: z.array(z.string()).optional(),
  llmSafe: z.boolean().default(false),
  llmMaxChars: z.number().int().min(1).max(20000).default(2000),
  networkSource: NetworkSourceSchema.optional(),
});

// ────────────────────────────────────────────────────────────────────────────
// Surface — one declared state-rendering element in surfaces.json.
// ────────────────────────────────────────────────────────────────────────────

const SurfaceSchema = z.object({
  id: z.string().min(1),
  locator: LocatorSchema,
  scope: z.string().optional(),
  appliesTo: SurfaceApplicabilitySchema.optional(),
  engineFields: z.array(EngineFieldSchema).min(1),
  severityFloor: SeveritySchema,
});

export const SurfaceManifestSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  collections: z.array(CollectionBindingSchema).default([]),
  surfaces: z.array(SurfaceSchema).min(1),
});

// ────────────────────────────────────────────────────────────────────────────
// Canary journey — discriminated union of action types (resolves R3-H2).
// Each action carries its own required fields; runtime can't get them wrong.
// ────────────────────────────────────────────────────────────────────────────

export const WaitConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('visible'),
    locator: LocatorSchema,
    timeoutMs: z.number().int().positive().default(5000),
  }),
  z.object({
    kind: z.literal('hidden'),
    locator: LocatorSchema,
    timeoutMs: z.number().int().positive().default(5000),
  }),
  z.object({
    kind: z.literal('url'),
    urlPattern: RegexPatternSchema,
    timeoutMs: z.number().int().positive().default(10000),
  }),
  z.object({
    kind: z.literal('network'),
    urlPattern: RegexPatternSchema,
    method: HttpMethodSchema.optional(),
    timeoutMs: z.number().int().positive().default(10000),
  }),
  z.object({
    kind: z.literal('timeout'),
    ms: z.number().int().positive().max(30000),
  }),
]);

export const JourneyStepSchema = z.discriminatedUnion('action', [
  // XOR refine — resolves R4-M5: exactly one of url or routeKey
  z.object({
    action: z.literal('navigate'),
    label: z.string().min(1),
    url: z.string().optional(),
    routeKey: z.string().optional(),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle']).default('load'),
  }).refine(
    (s) => (!!s.url) !== (!!s.routeKey),
    { message: 'navigate requires EXACTLY ONE of url or routeKey (not both, not neither)' },
  ),
  z.object({
    action: z.literal('click'),
    label: z.string().min(1),
    locator: LocatorSchema,
    postWait: WaitConditionSchema.optional(),
  }),
  z.object({
    action: z.literal('fill'),
    label: z.string().min(1),
    locator: LocatorSchema,
    value: z.string(),
    blurAfter: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('wait'),
    label: z.string().min(1),
    condition: WaitConditionSchema,
  }),
  z.object({
    action: z.literal('evaluate'),
    label: z.string().min(1),
    scriptId: z.string().min(1),
    args: z.record(z.string(), z.unknown()).optional(),
  }),
]);

// Auth bootstrap — discriminated by kind (resolves R4-M5).
const AuthBootstrapSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('none') }),
  z.object({ kind: z.literal('token'),        tokenEnv: z.string().min(1) }),
  z.object({ kind: z.literal('storageState'), storageStatePath: z.string().min(1) }),
]);

const ExpectedContradictionShapeSchema = z.object({
  engineField: z.string().min(1),
  surfaceId: z.string().min(1),
  // resolves R1-H10 + R1-H15 — kind discriminator so distinct contradiction
  // types on the same (surfaceId, engineField) don't suppress each other.
  // Optional for backwards-compat — when omitted, suppress matches any kind.
  kind: ContradictionKindSchema.optional(),
});

const ExpectedContradictionsSchema = z.object({
  min: z.number().int().min(0).default(0),
  max: z.number().int().nullable().default(null),
  shapes: z.array(ExpectedContradictionShapeSchema).optional(),
});

export const CanaryDefinitionSchema = z.object({
  $schema: z.string().optional(),
  name: z.string().min(1),
  personaId: z.string().min(1),
  routes: z.record(z.string(), z.string()).default({}),
  scripts: z.record(z.string(), z.string()).default({}),
  authBootstrap: AuthBootstrapSchema.default({ kind: 'none' }),
  journeySteps: z.array(JourneyStepSchema).min(1),
  fixtureSeed: z.string().nullable(),
  expectedContradictions: ExpectedContradictionsSchema,
});

// ────────────────────────────────────────────────────────────────────────────
// Witness record — what the capture library produces per step.
// ────────────────────────────────────────────────────────────────────────────

const DomClaimSchema = z.object({
  surfaceId: z.string().min(1),
  engineField: z.string().min(1),
  domValueRaw: z.string(),
  freshness: z.enum(['current', 'stale', 'absent']),
  scope: z.string().nullable(),
  key: z.string().nullable(),
  locator: LocatorSchema,
  visible: z.boolean(),
});

const NetworkClaimSchema = z.object({
  surfaceId: z.string().min(1),
  engineField: z.string().min(1),
  scope: z.string().nullable(),
  key: z.string().nullable(),                   // stringified for cross-row matching
  keyNative: z.unknown().optional(),            // resolves Gemini-final-G2 — native JSON type (string|number|boolean)
  keyType: z.enum(['string','number','boolean']).optional(),
  value: z.unknown(),       // native JSON type — coercion happens in diffClaims
  sourceUrl: z.string(),
  receivedAt: z.string(),   // ISO
});

export const WitnessRecordSchema = z.object({
  stepIndex: z.number().int().min(0),
  domClaims: z.array(DomClaimSchema),
  networkClaims: z.array(NetworkClaimSchema),
  undeclaredDomClaims: z.array(z.object({
    engineField: z.string(),
    selector: z.string(),
  })),
  partialCapture: z.boolean(),
  customClaims: z.record(z.string(), z.unknown()).default({}),
});

// ────────────────────────────────────────────────────────────────────────────
// Contradiction — emitted by diffClaims.
// `kind` lets downstream filters and the candidate-fingerprint distinguish
// types (value-mismatch, stale-projection, undeclared-engine-claim,
// missing-surface, value-coercion-error, absent-not-rendered, key-coercion-error).
// ────────────────────────────────────────────────────────────────────────────

// ContradictionKindSchema is declared near the top of the file (before
// ExpectedContradictionShapeSchema needs it). This block keeps the
// section header for readers who navigate by §.

export const ContradictionSchema = z.object({
  kind: ContradictionKindSchema,
  severity: SeveritySchema,
  surfaceId: z.string().nullable(),
  engineField: z.string().nullable(),
  scope: z.string().nullable(),
  key: z.string().nullable(),
  domValue: z.string().nullable(),
  engineValue: z.unknown().nullable(),
  freshness: z.enum(['current', 'stale', 'absent']).nullable(),
  selector: z.string().nullable(),
  detail: z.string(),
  suppressedByLockedSpec: z.string().nullable().default(null),
});

export const FreshnessFindingSchema = z.object({
  surfaceId: z.string(),
  engineField: z.string(),
  freshness: z.enum(['stale', 'absent']),
  severity: SeveritySchema,
  detail: z.string(),
});

// ────────────────────────────────────────────────────────────────────────────
// Rig warning — non-contradiction observations (resolves Gemini-R5-G3).
// Settle timeouts, partial captures, prose truncations, locator warnings.
// ────────────────────────────────────────────────────────────────────────────

export const RigWarningKindSchema = z.enum([
  'settle-timeout',
  'partial-capture',
  'prose-truncated-for-llm',
  'dom-stabilisation-cap-reached',
  'css-locator-prefer-semantic',
  'cache-only-network-claim',
  // Wine-cellar adoption round-2 #1 — navigation step's response was a
  // non-2xx (typically 404 or 5xx). Playwright's waitUntil:'load' still
  // resolves on the error body, so the rig had no idea the route was
  // wrong. Surfacing this loudly turns "is the surface broken?" into
  // "is the URL right?" — a 30-second diagnosis instead of an hour.
  'navigated-to-non-2xx',
  // Wine-cellar adoption round-2 #2 — runner waited for a manifest-
  // declared networkSource.urlPattern but the response never arrived
  // within the timeout. Capture proceeds anyway; downstream
  // unresolved-ground-truth fires for the affected surfaces.
  'manifest-network-await-timeout',
  // Upstream a0b58a34 (HIGH, wine-cellar-app) — a collection binding's
  // `jsonPath` resolved to something that cannot be iterated as rows, so the
  // surface produced ZERO claims while `surfaces.json` still read as enforced
  // coverage. It sat that way for months: the skip was a bare `continue`, and
  // a silently-skipped binding is indistinguishable from a passing one. This
  // is the "green having done nothing" class, inside the rig meant to catch it.
  'collection-binding-unusable',
  // Upstream 8c62cfcc (MEDIUM, wine-cellar-app) — a surface's
  // `appliesTo.routePattern` matched NO route the run visited, so its
  // negative-space checks never ran while `surfaces.json` still read as
  // enforced coverage. Same class as `collection-binding-unusable` above:
  // the gate did not fail, it abstained, and an abstaining gate is
  // indistinguishable from a passing one. Emitted once per surface at end
  // of run (it is a property of the whole run, not of any single step).
  'route-pattern-never-matched',
]);

export const RigWarningSchema = z.object({
  kind: RigWarningKindSchema,
  surfaceId: z.string().nullable(),
  detail: z.string(),
});

// ────────────────────────────────────────────────────────────────────────────
// Session ledger — per-run JSON written to .persona-test/sessions/<SID>.json.
// Terminal-state fields resolve R1-H6 + Gemini-G1 (app-error verdict).
// ────────────────────────────────────────────────────────────────────────────

const StepRecordSchema = z.object({
  stepIndex: z.number().int().min(0),
  plan: z.string(),
  actionLabel: z.string(),
  // Wine-cellar adoption round-2 #7 — the resolved URL the step actually
  // navigated to. `actionLabel` carries intent (`navigate (routeKey=cellar)`)
  // but a ledger reader debugging "did the nav land where I expected"
  // shouldn't have to cross-reference canary.routes. For non-navigate
  // steps this is the page.url() at step start.
  resolvedTarget: z.string().nullable().default(null),
  navResponseStatus: z.number().int().nullable().default(null),  // 200/404/500 for navigate steps; null otherwise
  witness: WitnessRecordSchema,
  contradictions: z.array(ContradictionSchema),
  // DEPRECATED in wine-cellar round-4 #3 — left in the schema for
  // backwards-compat with ledgers written before the runner stopped
  // populating it. Stale-projection + absent-not-rendered findings now
  // live in `contradictions[]` under their `kind` field; readers
  // should filter contradictions[] by kind, NOT inspect freshness[].
  // New ledgers from the round-4 runner onwards write this as `[]`.
  freshness: z.array(FreshnessFindingSchema),
  warnings: z.array(RigWarningSchema),
  durationMs: z.number().int().min(0),
});

const RigVerdictSchema = z.enum(['healthy', 'broken', 'partial', 'fatal', 'app-error']);
const CanaryVerdictSchema = z.enum(['passed', 'broken', 'not-applicable']);

export const SessionLedgerSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  canaryName: z.string().nullable(),
  journeyKey: z.string().min(1),
  fixtureSeed: z.string().nullable(),
  // Wine-cellar adoption round-2 #1b — canary auth bootstrap kind
  // exposed at the ledger boundary so summary-line scrapers + the
  // dashboard can flag `none` against state surfaces.
  authKind: z.enum(['none', 'token', 'storageState']).default('none'),
  startedAt: z.string(),
  steps: z.array(StepRecordSchema),
  // Run-level rig warnings — facts about the run as a whole that cannot be
  // attributed to any one step (upstream 8c62cfcc:
  // `route-pattern-never-matched` is only knowable once every step has been
  // visited). Defaulted so ledgers written before this field parse unchanged.
  runWarnings: z.array(RigWarningSchema).default([]),
  candidateSpecIds: z.array(z.string()),
  rigVerdict: RigVerdictSchema,
  canaryVerdict: CanaryVerdictSchema,
  failureReason: z.string().nullable(),
  stepFailureReason: z.string().nullable(),
  truncated: z.boolean(),
  endedAt: z.string(),
});

// ────────────────────────────────────────────────────────────────────────────
// Semantic verdict — INNER schema only (resolves Gemini-R4-G4).
// `latencyMs` / `costUsd` / `usage` live in the OUTER {result, usage, latencyMs}
// envelope returned by the LLM wrapper, NOT in the verdict itself.
// ────────────────────────────────────────────────────────────────────────────

export const SemanticVerdictSchema = z.object({
  matched: z.enum(['yes', 'no', 'uncertain']),
  score: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
});

// ────────────────────────────────────────────────────────────────────────────
// Persona run context — resolves R2-H4.
// Resolved once at runner start; threaded through every cross-skill write.
// ────────────────────────────────────────────────────────────────────────────

export const PersonaRunContextSchema = z.object({
  repoId: z.string().min(1),
  personaId: z.string().nullable(),
  journeyKey: z.string().min(1),
  deploymentId: z.string().nullable().default(null),
  planId: z.string().nullable().default(null),
  commitSha: z.string().nullable(),
  branch: z.string().nullable(),
});

// ────────────────────────────────────────────────────────────────────────────
// Type-only exports — tooling / docs use these as the canonical names.
// ────────────────────────────────────────────────────────────────────────────

/** @typedef {z.infer<typeof SurfaceManifestSchema>}   SurfaceManifest */
/** @typedef {z.infer<typeof CanaryDefinitionSchema>}  CanaryDefinition */
/** @typedef {z.infer<typeof JourneyStepSchema>}       JourneyStep */
/** @typedef {z.infer<typeof WitnessRecordSchema>}     WitnessRecord */
/** @typedef {z.infer<typeof ContradictionSchema>}     Contradiction */
/** @typedef {z.infer<typeof RigWarningSchema>}        RigWarning */
/** @typedef {z.infer<typeof SessionLedgerSchema>}     SessionLedger */
/** @typedef {z.infer<typeof SemanticVerdictSchema>}   SemanticVerdict */
/** @typedef {z.infer<typeof PersonaRunContextSchema>} PersonaRunContext */
/** @typedef {z.infer<typeof LocatorSchema>}           Locator */
