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
});

/**
 * Validate a collected data object against the schema for its `kind`.
 * Throws a ZodError on mismatch (boundary validation — plan §4).
 * @param {'reference'|'telemetry'} kind
 * @param {unknown} data
 * @returns {object} the parsed (and thus trusted) object
 */
export function validateDashboardData(kind, data) {
  if (kind === 'reference') return ReferenceDataSchema.parse(data);
  if (kind === 'telemetry') return TelemetryDataSchema.parse(data);
  throw new Error(`Unknown dashboard kind: ${kind}`);
}
