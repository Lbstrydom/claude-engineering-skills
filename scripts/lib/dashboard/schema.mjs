/**
 * @fileoverview Zod contracts for the local dashboard subsystem — the
 * reference-data object, the telemetry-data object, and the committed
 * flow manifest. Boundary validation per the repo's "Zod at boundaries"
 * rule: `renderDocument()` validates its input against these before
 * embedding it into a page (see `docs/plans/local-dashboard.md` §4).
 *
 * Zod 4 API (NOT Zod 3) — see AGENTS.md dependency table.
 *
 * @module scripts/lib/dashboard/schema
 */
import { z } from 'zod';

/** A discrete, non-negative count — not any float (boundary validation). */
const count = z.number().int().nonnegative();

/**
 * Per-source status — every collector input is classified so expected
 * absence and unexpected corruption are never conflated (plan §2.5).
 */
export const SourceStatusSchema = z.object({
  status: z.enum(['ok', 'missing-optional', 'invalid', 'unexpected-error']),
  detail: z.string(),
});

/** A `{ <name>: SourceStatus }` map. */
export const SourcesMapSchema = z.record(z.string(), SourceStatusSchema);

// ── Flow manifest (committed: scripts/lib/dashboard/flows.json) ──────────

export const FlowManifestSchema = z.object({
  nodes: z.array(z.object({
    id: z.string().min(1),
    skill: z.string().min(1),
    label: z.string().min(1),
  })).min(1),
  edges: z.array(z.object({
    from: z.string().min(1),
    to: z.string().min(1),
    label: z.string().optional(),
  })),
})
  // Semantic invariants — not just shape (boundary validation #12):
  .refine(
    (m) => new Set(m.nodes.map((n) => n.id)).size === m.nodes.length,
    { message: 'flow node ids must be unique' },
  )
  .refine(
    (m) => {
      const ids = new Set(m.nodes.map((n) => n.id));
      return m.edges.every((e) => ids.has(e.from) && ids.has(e.to));
    },
    { message: 'every flow edge endpoint must reference an existing node id' },
  );

// ── Reference data ───────────────────────────────────────────────────────

const SkillSchema = z.object({
  name: z.string(),
  oneLiner: z.string(),
  triggers: z.array(z.string()),
  usage: z.array(z.string()),
  disableModelInvocation: z.boolean(),
  path: z.string(),
});

const PlanSchema = z.object({
  title: z.string(),
  path: z.string(),
  status: z.string().nullable(),
  date: z.string().nullable(),
  malformed: z.boolean(),
  // Full markdown body for inline render in the dashboard's Plans tab.
  // Optional so older snapshots without `body` still validate.
  body: z.string().optional(),
});

const DomainSchema = z.object({
  name: z.string(),
  anchor: z.string(),
  symbolCount: count.nullable(),
  summary: z.string(),
});

/**
 * CLI catalog entry — one row per package.json script, joined against
 * scripts/.cli-catalog.json by collect-cli. `uncatalogued: true` when the
 * script exists in package.json but has no sidecar entry — surfaced in the
 * UI as a friction nudge to backfill metadata.
 */
const CliEntrySchema = z.object({
  name: z.string().min(1),
  command: z.string(),
  description: z.string(),
  category: z.enum([
    'audit', 'diagnostic', 'sync', 'skills', 'arch', 'security',
    'learning', 'plans', 'dashboard', 'hooks', 'parity', 'test', 'other',
  ]),
  relatedSkill: z.string().nullable(),
  outputs: z.string().nullable(),
  uncatalogued: z.boolean(),
});

// ── Purpose view (outcome map) ───────────────────────────────────────────
//
// docs/plans/dashboard-purpose-view.md. Two schemas:
//   PurposeConfigSchema — validates the hand-edited `.audit-loop/domain-map.json`
//     {purposes, domainPurposes} blocks at the collector boundary (H1).
//   PurposesSchema — the single discriminated COLLECTOR OUTPUT contract shared
//     by the collector, ReferenceDataSchema, and sections/purpose.mjs (R2-H1).

/** Raw config slug. */
const purposeIdSlug = z.string().regex(/^[a-z][a-z0-9-]*$/, 'purpose id must be a lower-kebab slug');

export const PurposeConfigSchema = z.object({
  purposes: z.array(z.object({
    id: purposeIdSlug,
    label: z.string().min(1),
    summary: z.string().min(1),
    kind: z.enum(['skill-chain', 'curated']),
    flowNodes: z.array(z.string()).default([]),
  })),
  domainPurposes: z.record(z.string(), z.array(z.string())),
}).superRefine((cfg, ctx) => {
  const ids = cfg.purposes.map((p) => p.id);
  const dup = ids.find((id, i) => ids.indexOf(id) !== i);
  if (dup) ctx.addIssue({ code: 'custom', message: `duplicate purpose id "${dup}"` });
  const idset = new Set(ids);
  for (const [domain, plist] of Object.entries(cfg.domainPurposes)) {
    for (const pid of plist) {
      if (!idset.has(pid)) {
        ctx.addIssue({ code: 'custom', message: `domainPurposes["${domain}"] references unknown purpose id "${pid}"` });
      }
    }
  }
});

export const PurposesSchema = z.object({
  status: z.enum(['ok', 'missing-optional', 'invalid']),
  detail: z.string(),
  // false ⇒ renderer shows "run npm run requirements"; true + empty node
  // requirements ⇒ "no invariants mapped here".
  ledgerPresent: z.boolean(),
  nodes: z.array(z.object({
    id: z.string(),
    label: z.string(),
    kind: z.enum(['skill-chain', 'curated']),  // same closed set as PurposeConfigSchema
    summary: z.string(),
    flowNodes: z.array(z.string()),
    domains: z.array(z.object({
      id: z.string(),
      anchor: z.string().nullable(),     // dashboard arch-domain id, or null when the domain has no architecture-map entry
      alsoServes: count,                 // # of OTHER purposes this domain also serves
    })),
    requirements: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      assertion: z.string(),
    })),
  })),
  // Coverage stratification (v2 Part 1). Optional so v1 snapshots validate.
  coverage: z.object({
    direct: count,
    platform: count,
    unmapped: count,
    total: count,
    catchAllPct: count,
  }).optional(),
  hygiene: z.object({
    unmappedDomains: z.array(z.string()),
    unattachedRequirements: z.array(z.string()),
    skippedRequirements: count,
    unknownDomains: z.array(z.string()),
    domainsMissingArchitecture: z.array(z.string()),
    // v3.1 — mapped domains that are code-less by design (informational, not a
    // ⚠ warning). Optional so older snapshots validate.
    codelessMapped: z.array(z.string()).optional(),
  }),
});

export const ReferenceDataSchema = z.object({
  kind: z.literal('reference'),
  provenance: z.object({
    baseSha: z.string(),
    dirty: z.boolean(),
    sourceHash: z.string(),
  }),
  sources: SourcesMapSchema,
  skills: z.array(SkillSchema),
  plans: z.object({
    active: z.array(PlanSchema),
    completed: z.array(PlanSchema),
  }),

  // ── UX-lens + campaign payloads ────────────────────────────────────────
  //
  // DECLARED, because Zod strips unknown keys and `renderDocument` builds every
  // section from the PARSED object. An undeclared payload is therefore not
  // "passed through unvalidated" — it is DELETED, and the section renders its
  // empty state with no error anywhere. Measured 2026-08-10: `navAudit` and
  // `visualAudit` were both undeclared, so those two shipped tabs could never
  // display data. It went unnoticed because both collectors are
  // `missing-optional` in this repo, and a missing-optional pane and a
  // silently-emptied one look identical — the section reads `src.status` from
  // `sources`, which IS declared and does survive.
  //
  // `.passthrough()` rather than a full mirror of each shape: the collectors
  // own those contracts and duplicating them here would be a second source of
  // truth that drifts. What this declaration buys is survival, not validation.
  // Optional so a pre-feature snapshot still parses.
  navAudit: z.object({}).passthrough().nullable().optional(),
  visualAudit: z.object({}).passthrough().nullable().optional(),
  campaigns: z.object({}).passthrough().nullable().optional(),
  architecture: z.object({
    domains: z.array(DomainSchema),
    // Flat domain → allowed-dependency domains. Merged from observed
    // (DB import graph, .audit-loop/domain-deps-observed.json) and manual
    // (allowedDeps in domain-map.json) by readDomainDeps(). archTiers()
    // reads this to lay the architecture tab out in dependency layers.
    deps: z.record(z.string(), z.array(z.string())),
    // Provenance-tagged form: each `to` carries source ∈ observed|manual|both.
    // Plumbed through for future per-edge UI; v1 unused by archTiers.
    mergedDeps: z.record(
      z.string(),
      z.array(z.object({
        to: z.string(),
        source: z.enum(['observed', 'manual', 'both']),
      })),
    ),
    // Architecture-panel subtitle metadata — drives formatDepsSourceLine.
    // Plan: docs/plans/observed-domain-deps.md §6.
    depsSource: z.object({
      observedAvailable: z.boolean(),
      observedRejectedReason: z.enum(['absent', 'unreadable', 'schema-invalid', 'stale-rules']).nullable(),
      observedRefreshId: z.string().nullable(),
      observedGeneratedAt: z.string().nullable(),
      manualKeyCount: z.number().int().nonnegative(),
      edgeCounts: z.object({
        observed: z.number().int().nonnegative(),
        manual: z.number().int().nonnegative(),
        both: z.number().int().nonnegative(),
      }),
      // Observed-graph coverage (docs/plans/observed-graph-coverage-honesty.md).
      // Optional + nullable so pre-feature snapshots still validate; `.passthrough()`
      // keeps the extraction/attribution detail without duplicating the full
      // §2.1.6b shape here — the renderer reads verdict + a few counts.
      coverage: z.object({
        verdict: z.object({
          status: z.enum(['verified', 'degraded', 'unverified', 'unknown']),
          reason: z.string().nullable(),
        }),
      }).passthrough().nullable().optional(),
    }),
    mapPath: z.string().nullable(),
    // v2 Part 2 — inverse edge {domainId: [{id,label}]} for Architecture→Purpose
    // "serves:" chips. Optional so v1 snapshots validate.
    domainPurposes: z.record(z.string(), z.array(z.object({
      id: z.string(),
      label: z.string(),
    }))).optional(),
  }),
  flows: FlowManifestSchema.nullable(),
  cli: z.array(CliEntrySchema),
  // Optional so reference snapshots captured before the Purpose tab existed
  // still validate (docs/plans/dashboard-purpose-view.md).
  purposes: PurposesSchema.optional(),
});

// ── Telemetry data ───────────────────────────────────────────────────────

const PassStatSchema = z.object({
  name: z.string(),
  runs: count,
  raised: count,
  accepted: count,
  dismissed: count,
});

export const TelemetryDataSchema = z.object({
  kind: z.literal('telemetry'),
  provenance: z.object({
    generatedAt: z.string(),
    baseSha: z.string(),
    mode: z.enum(['cloud', 'local-only']),
  }),
  sources: SourcesMapSchema,
  auditRuns: z.object({
    cloud: z.boolean(),
    runCount: count,
    labeledCount: count,
    passes: z.array(PassStatSchema),
    local: z.object({ total: count, labeled: count }),
    // 'repo' when the cloud query was scoped to this directory's canonical
    // audit_repos row; 'project' for the project-wide fallback (no resolvable
    // repo row, or local-only). `.default` keeps pre-scope snapshots valid.
    scope: z.enum(['repo', 'project']).default('project'),
  }),
  requirements: z.object({
    present: z.boolean(),
    total: count,
    active: count,
    truncated: z.boolean(),
    items: z.array(z.object({
      id: z.string(),
      kind: z.string(),
      statement: z.string(),
      status: z.string(),
    })),
  }),
  learning: z.object({
    cloud: z.boolean(),
    pendingTriageCount: count,
    noBrainerCount: count,
    staleClusterCount: count,
  }),
  // Security governance telemetry. Optional so telemetry snapshots captured
  // before this section existed still validate (back-port: docs/plans/security).
  security: z.object({
    cloud: z.boolean(),
    totalIncidents: count,
    embedded: count,
    byStatus: z.array(z.object({ status: z.string(), count })),
    eventCounts: z.array(z.object({ kind: z.string(), count })),
    lastRefreshAt: z.string().nullable(),
    recentEvents: z.array(z.object({
      incidentId: z.string(),
      eventKind: z.string(),
      branch: z.string(),
      createdAt: z.string(),
    })),
  }).optional(),
  // Purpose Health (v2 Part 3) — cloud governance overlay. NO status here (the
  // source-state lives in sources.purposeHealth, like security/learning).
  // Optional so snapshots without it validate.
  purposeHealth: z.object({
    asOf: z.string(),
    windowDays: count,
    repoWide: z.object({
      recentHighFindings: count.nullable(),
      plansWithFailingCriteria: count.nullable(),
      refusedSecrets: count.nullable(),
      // v3 Part A — HIGH findings not attributable to a purpose (null file /
      // non-path / no-purpose domain / sensitive). null when attribution
      // unavailable. Optional so v2 snapshots validate.
      unattributable: count.nullable().optional(),
    }),
    purposeBadges: z.array(z.object({
      id: z.string(),
      label: z.string(),
      health: z.enum(['ok', 'at-risk', 'failing', 'na']),
      scope: z.enum(['purpose-specific', 'repo-wide-only']),
      reason: z.string(),
    })),
  }).optional(),
  // Prompt-variant (bandit) effectiveness — Cluster D / Phase 7. Optional so
  // snapshots captured before this section existed still validate.
  promptVariants: z.object({
    cloud: z.boolean(),
    arms: z.array(z.object({
      passName: z.string(),
      variantId: z.string(),
      pulls: count,
      mean: z.number(),
      alpha: z.number(),
      beta: z.number(),
      contextBucket: z.string(),
    })),
  }).optional(),
  // Ship-event health — Cluster D / Phase 7. Optional (back-compat).
  shipHealth: z.object({
    cloud: z.boolean(),
    byOutcome: z.array(z.object({ outcome: z.string(), count })),
    recent: z.array(z.object({
      outcome: z.string(),
      branch: z.string(),
      commitSha: z.string(),
      overridden: z.boolean(),
      createdAt: z.string(),
    })),
  }).optional(),
  // Persona-tests telemetry — WS3 (docs/plans/persona-nav-feedback-recovery.md).
  // Optional (back-compat, same convention as every other telemetry block).
  personaTests: z.object({
    cloud: z.boolean(),
    latestByPersona: z.array(z.object({
      persona: z.string(), verdict: z.string(),
      p0Count: count, p1Count: count, createdAt: z.string(),
    })),
    trend: z.array(z.object({
      persona: z.string(), verdict: z.string(),
      p0Count: count, p1Count: count, createdAt: z.string(),
    })),
    correlations: z.object({
      total: count,
      byType: z.array(z.object({ type: z.string(), count })),
    }),
  }).optional(),
  // Audit effectiveness (precision/recall vs persona ground truth) — Cluster D.
  auditEffectiveness: z.object({
    cloud: z.boolean(),
    confirmedHits: count,
    auditMisses: count,
    falsePositives: count,
    severityUnderstated: count,
    severityOverstated: count,
    precision: z.number().nullable(),
    recall: z.number().nullable(),
  }).optional(),
  // Author-tier observation (model-tier-observation) — observation-only. Suggested
  // tier × converged, declared ladder partition keys, the cross-model-bias
  // diversity gate. Optional so pre-feature snapshots validate.
  authorTier: z.object({
    cloud: z.boolean(),
    total: count,
    bySuggestedTier: z.array(z.object({ tier: z.string(), total: count, converged: count, convergedPct: count })),
    ladders: z.array(z.object({ provider: z.string(), family: z.string(), model: z.string(), count })),
    distinctProviderLadders: count,
    diversityGateMet: z.boolean(),
    agreement: z.object({ agree: count, disagree: count, declaredUnknown: count }),
  }).optional(),
  // Model-A/B/C experiment ("A/B/C Testing") — arm-eval accumulation state:
  // per-arm labelled outcomes + conformance + spend vs budget + decision status.
  // Experiment-wide (not repo-scoped). Optional so pre-feature snapshots validate.
  modelAb: z.object({
    cloud: z.boolean(),
    status: z.string(),
    reason: z.string(),
    distinctAssignments: count,
    minAssignments: count,
    spentEur: z.number(),
    capEur: z.number().nullable(),
    pendingAdjudication: count,
    arms: z.array(z.object({
      arm: z.string(), rows: count, accepted: count, dismissed: count, pending: count,
      acceptedHigh: count, costUsd: z.number(), conformant: count, passExecutions: count,
    })),
  }).optional(),
  // Tiered-recall Close-out shadow validation — Phase-14 window progress
  // (docs/plans/tiered-recall-audit-pipeline.md). Aggregation reuses the
  // report CLI's summarize(); the dashboard is a read surface, the CLI stays
  // authoritative. Optional so pre-feature snapshots validate.
  tieredShadow: z.object({
    cloud: z.boolean(),
    flagEnabled: z.boolean(),
    totalRuns: count,
    windowMin: count,
    windowMax: count,
    legacyFailures: count,
    shadowFailures: count,
    comparedRuns: count,
    // docs/plans/stage0-evidence-relevance-split.md round-3 M1 — the two
    // named, non-overlapping completion metrics + the three exclusion
    // reasons. Defaulted (not `.optional()`) so a pre-split snapshot still
    // validates while every NEW snapshot always carries them: an absent
    // count would otherwise be indistinguishable from a genuine zero on the
    // render side.
    historicalCompleteRuns: count.default(0),
    excludedNoStage0Evidence: count.default(0),
    excludedDegenerateComparison: count.default(0),
    // .default(0) keeps envelopes stored before this bucket existed valid — a
    // required field would fail validation and take the whole telemetry panel down.
    excludedUnclassified: count.default(0),
    excludedFallback: count.default(0),
    costDeltaUsd: z.object({ mean: z.number().nullable(), median: z.number().nullable() }),
    latencyDeltaSec: z.object({ mean: z.number().nullable(), median: z.number().nullable() }),
    findingOverlapRate: z.object({ mean: z.number().nullable(), median: z.number().nullable() }),
    tieredRunStatusCounts: z.record(z.string(), count),
    tieredFallbackReasons: z.record(z.string(), count),
    perRepo: z.array(z.object({ label: z.string(), count })),
    source: z.enum(['cloud', 'local', 'none']),
    // A cloud read hit the query LIMIT — the aggregate may be missing
    // recent rows. `windowMet` is computed server-side against comparedRuns
    // (not totalRuns) so the render layer never has to re-derive the
    // decision-gate threshold itself.
    truncated: z.boolean().default(false),
    windowMet: z.boolean().default(false),
  }).optional(),
});

// ── Audit-run findings viewer (docs/plans/dashboard-audit-run-viewer.md) ──
//
// A per-run findings detail page. Unlike reference/telemetry it carries a
// discriminated collector `status.code` in `src.status` (NOT the 4-value
// SourceStatus enum), and a `provenance` block in the non-reference shape
// (generatedAt/baseSha/mode). The two no-id collector codes
// (missing_run_pointer / invalid_run_pointer) never reach the renderer — they
// are CLI-only (stderr + non-zero exit, no HTML) — so only the four
// id-resolved codes appear here (plan §5, §9, G3).

const AuditRunMetaSchema = z.object({
  id: z.string(),
  planFile: z.string().nullable(),
  mode: z.string().nullable(),
  rounds: z.number().int().nullable(),
  geminiVerdict: z.string().nullable(),
  totalFindings: z.number().int().nullable(),
  roundConvergedAfter: z.number().int().nullable(),
  commitSha: z.string().nullable(),
  branch: z.string().nullable(),
  planId: z.string().nullable(),
  createdAt: z.string().nullable(),
});

// Closed presentation-token sets — the presenter is the ONLY producer (M7).
const SEV_CLASS = z.enum(['sev-high', 'sev-med', 'sev-low']);
const SEV_TOKEN = z.enum(['HIGH', 'MEDIUM', 'LOW']);
const STATUS_TOKEN = z.enum([
  'accepted', 'dismissed', 'severity_adjusted', 'pending',
  'fixed', 'verified', 'regressed', 'none',
]);
// data-pass closed set (plan §3 filter contract) + 'other' defensive bucket.
const PASS_TOKEN = z.enum([
  'structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix', 'other',
]);

const PresentedFindingSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  category: z.string(),
  detail: z.string(),
  round: z.number().int().nullable(),
  file: z.string().nullable(),
  // Presenter tokens (closed enums → safe in data-* attributes, H3):
  sevClass: SEV_CLASS,
  sevToken: SEV_TOKEN,
  sevLabel: z.string(),
  passToken: PASS_TOKEN,
  passLabel: z.string(),
  statusToken: STATUS_TOKEN,
  statusLabel: z.string(),
  fileLabel: z.string(),
});

export const AuditRunDataSchema = z.object({
  kind: z.literal('audit-run'),
  provenance: z.object({
    generatedAt: z.string(),
    baseSha: z.string(),
    mode: z.string(),
    dirty: z.boolean().optional(),
  }),
  src: z.object({
    status: z.enum(['ok', 'cloud_disabled', 'run_not_found', 'query_error']),
    detail: z.string().optional(),
  }),
  auditRun: z.object({
    runId: z.string(),
    meta: AuditRunMetaSchema.nullable(),
    findings: z.array(PresentedFindingSchema),
    convergedAfter: z.number().int().nullable(),
  }),
});

/**
 * Validate a collected data object against the schema for its `kind`.
 * Throws a ZodError on mismatch (boundary validation — plan §4).
 * @param {'reference'|'telemetry'|'audit-run'} kind
 * @param {unknown} data
 * @returns {object} the parsed (and thus trusted) object
 */
export function validateDashboardData(kind, data) {
  if (kind === 'reference') return ReferenceDataSchema.parse(data);
  if (kind === 'telemetry') return TelemetryDataSchema.parse(data);
  if (kind === 'audit-run') return AuditRunDataSchema.parse(data);
  throw new Error(`Unknown dashboard kind: ${kind}`);
}
