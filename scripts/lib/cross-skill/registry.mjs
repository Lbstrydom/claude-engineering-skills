/**
 * @fileoverview The declarative command registry for `scripts/cross-skill.mjs`
 * (docs/plans/cross-skill-command-registry.md D1/D2).
 *
 * One entry per MIGRATED subcommand. The registry starts empty and grows one
 * cohort at a time (audit R1-H1) — an entry never points at a module that
 * does not exist yet, and a name present here is served by the registry path
 * ONLY (a loader failure is `REGISTRY_LOAD_FAILED`, never a silent fallback
 * to the legacy map). The frozen inventory
 * (`tests/fixtures/cross-skill-inventory.json`) is the conservation law:
 * `registryNames ∪ legacyNames = INVENTORY`, disjoint, at every commit.
 *
 * Entry shape (plan D1):
 *   name        string — the subcommand
 *   flags       Array<string|{name, kind:'valued'|'boolean'|'repeatable'}>
 *               (string shorthand = valued). Lexical SHAPE only — value
 *               semantics stay handler-owned (audit R1-H3 boundary).
 *   positionals 'none' | {verbs: string[]} — bare-word grammar. For {verbs},
 *               unknown verbs FLOW TO THE HANDLER (its legacy usage message
 *               is the frozen surface); the declaration exists for
 *               conformance and for the 'none' refusal.
 *   payload     'json' | 'flags' | 'both' | 'none' — derives which payload
 *               flags (--json/--stdin) are accepted (audit R1-H2).
 *   scope       'none' | 'ambient-ok' | 'explicit-required' | 'global-optin'
 *   kind        'read' | 'write' | 'local'
 *   cloud       'none' | 'degrade-noop' | 'require'
 *   degradeShape object — extra fields on the canonical cloud-off envelope
 *               {ok:true, cloud:false, ...degradeShape}; pinned to the
 *               captured legacy fixture by the golden suite (shadow R1-M3).
 *   softFail    boolean — frozen legacy quirk: this command emits ok:false at
 *               exit 0 (must be proven by a golden fixture).
 *   forward     {to: string} — rest-forwarding command; flag validation is
 *               delegated to the target CLI (shadow R1-M1/G2).
 *   portExempt  boolean — self-contained sub-CLI wrapper; store-call goldens
 *               skip it (shadow G2-H). Only legal beside forward/wrapper.
 *   parent      {table, idField} — parent-scoped child write (D7; Cluster F).
 *   load        () => Promise<handler> — lazy; cold start does not scale
 *               with command count.
 *
 * Handlers receive `ctx` (see dispatch.mjs) and return the FULL legacy
 * envelope (ok:true) or throw CommandError — byte-compatibility forbids
 * envelope normalisation (audit R1-H4).
 */

/**
 * Flags every command ACCEPTS for validation. `--selfcheck-relocation` is
 * the only name every command genuinely honours; `--help` is accepted
 * everywhere for byte-compatibility with the legacy global KNOWN_FLAGS (a
 * per-command `record-ship-event --help` reaches the handler and BAD_INPUTs,
 * exactly as before — "honoured" only in the subcommand position, which
 * main() traps before dispatch).
 */
export const UNIVERSAL_FLAGS = ['--help', '--selfcheck-relocation'];

/** Payload-source flags derived from the payload declaration (audit R1-H2). */
export function payloadFlags(payload) {
  return (payload === 'json' || payload === 'both') ? ['--json', '--stdin'] : [];
}

/** Normalise a flag declaration to {name, kind}. */
export function normalizeFlag(f) {
  return typeof f === 'string' ? { name: f, kind: 'valued' } : f;
}

export const REGISTRY = Object.freeze([
  // ── Cohort: template trio (Cluster A, Phase 2) ───────────────────────────
  {
    name: 'whoami',
    flags: [],
    positionals: 'none',
    payload: 'none',
    scope: 'none',
    kind: 'read',
    // cloud:'none' — whoami REPORTS cloud state as data, so it owns its own
    // init + isCloudEnabled read via the port rather than being gated.
    cloud: 'none',
    load: () => import('./commands/misc.mjs').then((m) => m.whoamiCmd),
  },
  {
    name: 'record-ship-event',
    flags: [],
    positionals: 'none',
    payload: 'json',
    scope: 'ambient-ok',
    kind: 'write',
    cloud: 'degrade-noop',
    degradeShape: {},
    load: () => import('./commands/ship.mjs').then((m) => m.recordShipEventCmd),
  },
  {
    name: 'persona-outcomes',
    flags: [
      'repo', 'repo-id', 'out', 'session', 'hash', 'outcome', 'rationale', 'by',
      'report-path',
      { name: 'worksheet', kind: 'boolean' },
      { name: 'dry-run', kind: 'boolean' },
    ],
    positionals: { verbs: ['summary', 'label', 'backfill-hash'] },
    payload: 'both',
    // Scope policy applies to the verbs that RESOLVE a repo (summary,
    // --worksheet, backfill-hash — all --repo-authoritative). `label` never
    // calls resolveScope: its repo derives from the ADDRESSED session row via
    // resolveLabelTarget (legacy-correct — the session IS the parent, the
    // same parent-derivation shape D7/Cluster F formalises with the ownership
    // join; declaring --repo required for label would break its documented
    // invocation). A per-verb scope grammar for one command is the
    // over-engineered cliff; this note is the honest middle (audit CA-r2).
    scope: 'explicit-required',
    kind: 'write',
    cloud: 'degrade-noop',
    degradeShape: {},
    // Frozen legacy quirk, scoped to the ONE verb that has it (audit CA-r1):
    // `summary` returns the store's result VERBATIM (`emit(res)`), and the
    // store's error path is `{ok:false, error}` at exit 0 — a returned non-ok
    // envelope predating the CommandError contract. Command-wide softFail
    // would have exempted label/backfill/worksheet regressions too; the
    // verb-scoped form keeps the validator armed everywhere the quirk is not.
    // Not hermetically capturable (it needs a store error), so the proof is
    // the legacy source (`cmdPersonaOutcomes` → `return emit(res)`).
    softFail: { verbs: ['summary'] },
    load: () => import('./commands/persona.mjs').then((m) => m.personaOutcomesCmd),
  },

  // ── Cohort: mutating writers (Cluster B, Phase 3) ────────────────────────
  // `softFail: true` below marks the legacy `ok: !!id` shape — a store that
  // swallows a failure returns null, which the legacy CLI emitted as
  // `{ok:false}` at exit 0. Each is fixture-pinned; tightening any of them
  // changes an envelope a skill reads, so it is a deliberate later decision.
  {
    name: 'upsert-plan',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop',
    // softFail REMOVED (audit CB-r4): upsertPlanCmd now throws for EVERY
    // `!res.ok`, including an unhandled future reason, so it can no longer
    // return a failure-shaped envelope and needs no exemption. This is what
    // paying down a softFail looks like — one down, the rest listed for
    // Cluster F with written reasons.
    degradeShape: { planId: null },
    load: () => import('./commands/plans.mjs').then((m) => m.upsertPlanCmd),
  },
  {
    name: 'update-plan-status',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop',
    degradeShape: {},
    load: () => import('./commands/plans.mjs').then((m) => m.updatePlanStatusCmd),
  },
  {
    name: 'record-regression-spec',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { specId: null }, softFail: { all: true, reason: 'legacy `ok: !!specId` — same swallowed-null shape as upsert-plan. Owned by Cluster F.' },
    load: () => import('./commands/ship.mjs').then((m) => m.recordRegressionSpecCmd),
  },
  {
    name: 'record-regression-spec-run',
    flags: [], positionals: 'none', payload: 'json',
    // scope:'none' — addressed purely by specId. Cluster F adds
    // `parent: {table:'regression_specs', idField:'specId'}`.
    scope: 'none', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    load: () => import('./commands/ship.mjs').then((m) => m.recordRegressionSpecRunCmd),
  },
  {
    name: 'record-correlation',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    load: () => import('./commands/persona.mjs').then((m) => m.recordCorrelationCmd),
  },
  {
    name: 'record-nav-audit-run',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop',
    degradeShape: {},
    softFail: { all: true, reason: 'legacy ok = (result.status !== "failed") — the store\'s own failure shape rides the envelope. Owned by Cluster F.' },
    load: () => import('./commands/misc.mjs').then((m) => m.recordNavAuditRunCmd),
  },
  {
    name: 'record-plan-verify-run',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { runId: null }, softFail: { all: true, reason: 'legacy `ok: !!runId` — same swallowed-null shape. Owned by Cluster F.' },
    load: () => import('./commands/plan-verify.mjs').then((m) => m.recordPlanVerifyRunCmd),
  },
  {
    name: 'record-plan-verify-items',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { inserted: 0 },
    load: () => import('./commands/plan-verify.mjs').then((m) => m.recordPlanVerifyItemsCmd),
  },
  {
    name: 'add-persona',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { personaId: null, existed: false }, softFail: { all: true, reason: 'legacy `ok: !!personaId` — same swallowed-null shape. Owned by Cluster F.' },
    load: () => import('./commands/persona.mjs').then((m) => m.addPersonaCmd),
  },
  {
    name: 'record-persona-session',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { sessionId: null, existed: false, statsUpdated: false },
    softFail: { all: true, reason: 'legacy ok = !!result.sessionId — a throw would DISCARD the correlationSummary payload that names why (reason: session-write-failed), so this one needs a payload-preserving design. Owned by Cluster F.' },
    load: () => import('./commands/persona.mjs').then((m) => m.recordPersonaSessionCmd),
  },
  {
    name: 'final-review-adjudicate',
    flags: ['run-id', 'fingerprint', 'action', 'bucket'],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    // Frozen quirk: cloud-off emits {ok:false, cloud:false, updated:0} at exit 0.
    degradeShape: {}, softFail: { all: true, reason: 'FIXTURE-PINNED (fr-adj-cloud-off): cloud-off emits {ok:false, cloud:false, updated:0} at exit 0.' },
    load: () => import('./commands/final-review.mjs').then((m) => m.finalReviewAdjudicateCmd),
  },
  {
    name: 'final-review-record-fix',
    flags: ['run-id', 'fingerprint', 'bucket', 'commit', 'state'],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: {}, softFail: { all: true, reason: 'FIXTURE-PINNED (fr-fix-cloud-off): cloud-off emits {ok:false, cloud:false, updated:0} at exit 0.' },
    load: () => import('./commands/final-review.mjs').then((m) => m.finalReviewRecordFixCmd),
  },
  {
    name: 'learning-record',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { decisionKey: null },
    load: () => import('./commands/misc.mjs').then((m) => m.learningRecordCmd),
  },
  // Arch-refresh pipeline steps. `scope:'none'` + payload repoId is correct
  // here and not a gap: these are invoked only by `arch:refresh`, which
  // resolves the id itself immediately before calling them.
  // `cloud:'none'` matches legacy: they call initLearningStore and then the
  // store, whose own guards produce the failure — there is no cloud-off
  // envelope to degrade to.
  {
    name: 'open-refresh-run',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.openRefreshRunCmd),
  },
  {
    name: 'publish-refresh-run',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.publishRefreshRunCmd),
  },
  {
    name: 'abort-refresh-run',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.abortRefreshRunCmd),
  },
  {
    name: 'record-symbol-definitions',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.recordSymbolDefinitionsCmd),
  },
  {
    name: 'record-symbol-index',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.recordSymbolIndexCmd),
  },
  {
    name: 'record-symbol-embedding',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.recordSymbolEmbeddingCmd),
  },
  {
    name: 'record-layering-violations',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.recordLayeringViolationsCmd),
  },
  {
    name: 'set-active-embedding-model',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/arch-refresh.mjs').then((m) => m.setActiveEmbeddingModelCmd),
  },

  // ── Cohort: readers (Cluster C, Phase 4) ─────────────────────────────────
  // No softFail in this cohort: a reader's job is to keep "empty" and
  // "unmeasured" apart, and every one of these already does it with a named
  // field (repoFound, snapshotProvenance, degraded, measured) rather than a
  // failure-shaped envelope.
  {
    name: 'plan-satisfaction',
    flags: ['plan-id'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { row: null, persistentFailures: [] },
    load: () => import('./commands/plans.mjs').then((m) => m.planSatisfactionCmd),
  },
  {
    name: 'audit-effectiveness',
    flags: ['repo-id'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { row: null },
    load: () => import('./commands/misc.mjs').then((m) => m.auditEffectivenessCmd),
  },
  {
    name: 'detect-stack',
    flags: ['cwd', { name: 'include-env-manager', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'local', cloud: 'none',
    load: () => import('./commands/misc.mjs').then((m) => m.detectStackCmd),
  },
  {
    name: 'get-nav-first-seen',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'ambient-ok', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { firstSeen: {} },
    // Legacy emits {ok:false, cloud:true, firstSeen:{}, error} when the history
    // read fails — a reader reporting its own unmeasurability, at exit 0.
    softFail: { all: true, reason: 'legacy history-read failure emits ok:false with firstSeen:{} at exit 0 — a reader saying "unmeasured". Cluster F §2b F4 decides whether an unmeasured READ should exit non-zero or become {ok:true, measured:false}; the latter is likely correct and is NOT the same question as a failed write.' },
    load: () => import('./commands/misc.mjs').then((m) => m.getNavFirstSeenCmd),
  },
  {
    name: 'preview-gate',
    flags: ['format'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'local', cloud: 'none',
    load: () => import('./commands/ship.mjs').then((m) => m.previewGateCmd),
  },
  {
    name: 'resolve-repo-identity',
    flags: ['cwd', { name: 'persist', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'local', cloud: 'none',
    load: () => import('./commands/arch-query.mjs').then((m) => m.resolveRepoIdentityCmd),
  },
  {
    name: 'get-active-refresh-id',
    flags: ['repo-uuid'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { refreshId: null },
    load: () => import('./commands/arch-query.mjs').then((m) => m.getActiveRefreshIdCmd),
  },
  {
    name: 'compute-target-domains',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'local', cloud: 'none',
    load: () => import('./commands/arch-query.mjs').then((m) => m.computeTargetDomainsCmd),
  },
  {
    name: 'get-callers-for-file',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { callers: [], callerDomains: [], snapshotProvenance: 'cloud-disabled' },
    load: () => import('./commands/arch-query.mjs').then((m) => m.getCallersForFileCmd),
  },
  {
    name: 'list-symbols-for-snapshot',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { rows: [] },
    load: () => import('./commands/arch-query.mjs').then((m) => m.listSymbolsForSnapshotCmd),
  },
  {
    name: 'list-layering-violations-for-snapshot',
    flags: ['refresh-id'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { rows: [] },
    load: () => import('./commands/arch-query.mjs').then((m) => m.listLayeringViolationsForSnapshotCmd),
  },
  {
    name: 'compute-drift-score',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { drift: null },
    load: () => import('./commands/arch-query.mjs').then((m) => m.computeDriftScoreCmd),
  },
  {
    name: 'get-neighbourhood',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: {
      refreshId: null, records: [], totalCandidatesConsidered: 0, truncated: false,
      hint: 'cloud disabled — run `npm run arch:refresh` to enable',
    },
    load: () => import('./commands/arch-query.mjs').then((m) => m.getNeighbourhoodCmd),
  },
  {
    name: 'get-incident-neighbourhood',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: {
      records: [], totalCandidatesConsidered: 0, freshnessWarning: null,
      hint: 'cloud disabled — security memory unavailable',
    },
    load: () => import('./commands/arch-query.mjs').then((m) => m.getIncidentNeighbourhoodCmd),
  },

  // ── Cohort: remaining readers (Cluster D, Phase 5) ───────────────────────
  {
    name: 'list-personas',
    flags: ['url'], positionals: 'none', payload: 'both',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { rows: [] },
    load: () => import('./commands/persona.mjs').then((m) => m.listPersonasCmd),
  },
  {
    name: 'get-persona-sessions-by-repo',
    flags: ['repo', 'repo-id', 'limit', 'select', { name: 'p0-only', kind: 'boolean' }],
    positionals: 'none', payload: 'both',
    scope: 'explicit-required', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { rows: [] },
    load: () => import('./commands/persona.mjs').then((m) => m.getPersonaSessionsByRepoCmd),
  },
  {
    name: 'get-persona-sessions-by-url',
    flags: ['url', 'limit', 'select'], positionals: 'none', payload: 'both',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { rows: [] },
    load: () => import('./commands/persona.mjs').then((m) => m.getPersonaSessionsByUrlCmd),
  },
  {
    name: 'get-reachability-evidence',
    flags: ['repo', 'limit', 'since-days'], positionals: 'none', payload: 'both',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { personas: [] },
    load: () => import('./commands/persona.mjs').then((m) => m.getReachabilityEvidenceCmd),
  },
  {
    name: 'get-recent-findings',
    flags: ['repo', 'repo-id', 'limit', 'severity'], positionals: 'none', payload: 'both',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { findings: [] },
    load: () => import('./commands/persona.mjs').then((m) => m.getRecentFindingsCmd),
  },
  {
    name: 'final-review-stats',
    flags: ['repo', 'queue-limit', 'out', { name: 'worksheet', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'none',
    // The store's result travels verbatim (legacy `emit(res)`), error shape
    // included — the same forwarded-result quirk as persona-outcomes summary.
    softFail: { all: true, reason: 'legacy forwards getFinalReviewStats’s result VERBATIM, so its {ok:false, error} shape reaches the envelope at exit 0. Cluster F §2b decides whether a forwarded store error should exit non-zero; it is the same question as the other forwarded-result commands, not a per-command judgement.' },
    load: () => import('./commands/final-review.mjs').then((m) => m.finalReviewStatsCmd),
  },
  {
    name: 'final-review-pending',
    flags: ['repo', 'commit', 'page-size', { name: 'render', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    // Three states, exit 0 for ALL of them — /ship must continue through every
    // one, because a credit nudge that can FAIL a ship is worse than no nudge.
    // The envelope carries its outcome in `state`, not `ok`, so it is declared
    // okless rather than softFail: there is no `ok` to lie with, and the
    // declaration is what stops a handler that merely FORGOT `ok` from
    // inheriting the same exemption.
    okless: { reason: 'the envelope is {schemaVersion, state: ready|disabled|unavailable, …} — outcome rides `state`, and all three states are exit 0 by contract so /ship can never be failed by its own credit nudge.' },
    degradeShape: {},
    load: () => import('./commands/final-review.mjs').then((m) => m.finalReviewPendingCmd),
  },
  {
    name: 'shadow-overlap',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: { hint: 'cloud disabled — overlap is unmeasurable locally' },
    load: () => import('./commands/final-review.mjs').then((m) => m.shadowOverlapCmd),
  },
]);

const _byName = new Map(REGISTRY.map((e) => [e.name, e]));

/** @returns {object|undefined} the registry entry, or undefined (→ legacy map). */
export function getCommand(name) {
  return _byName.get(name);
}

export function registryCommandNames() {
  return REGISTRY.map((e) => e.name);
}
