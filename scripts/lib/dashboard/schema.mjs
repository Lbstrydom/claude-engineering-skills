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
    // domain → allowed-dependency domains (from .audit-loop/domain-map.json),
    // used to lay the architecture tab out in dependency layers.
    deps: z.record(z.string(), z.array(z.string())),
    mapPath: z.string().nullable(),
  }),
  flows: FlowManifestSchema.nullable(),
  cli: z.array(CliEntrySchema),
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
    mode: z.enum(['supabase', 'local-only']),
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
