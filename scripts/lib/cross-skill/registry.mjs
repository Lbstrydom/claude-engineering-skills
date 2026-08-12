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

  // ── Cohort: nudge readers, learning, durability, friction (Cluster D) ────
  {
    name: 'list-unlocked-fixes',
    flags: ['repo', 'repo-id', 'limit', 'offset',
      { name: 'all-repos', kind: 'boolean' }, { name: 'all-ages', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'global-optin', kind: 'read', cloud: 'degrade-noop',
    degradeShape: {
      scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [], shown: 0, total: 0,
      byMode: { total: 0, code: 0, plan: 0 },
    },
    load: () => import('./commands/ship.mjs').then((m) => m.listUnlockedFixesCmd),
  },
  {
    name: 'list-unremediated-acceptances',
    flags: ['repo', 'repo-id', 'limit', 'offset',
      { name: 'all-repos', kind: 'boolean' }, { name: 'all-ages', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'global-optin', kind: 'read', cloud: 'degrade-noop',
    degradeShape: {
      scope: { mode: 'unresolved', repoId: null, slug: null },
      measured: false, reason: 'cloud-off', rows: [],
    },
    load: () => import('./commands/ship.mjs').then((m) => m.listUnremediatedAcceptancesCmd),
  },
  {
    name: 'recommend-skills',
    flags: ['changed', 'url', 'just-ran', 'max', 'plan-lenses', 'findings', 'format'],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop',
    degradeShape: {},
    load: () => import('./commands/ship.mjs').then((m) => m.recommendSkillsCmd),
  },
  {
    name: 'write-spill',
    flags: ['cap'], positionals: { verbs: ['status', 'drain'] }, payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    load: () => import('./commands/misc.mjs').then((m) => m.writeSpillCmd),
  },
  {
    name: 'get-friction-neighbourhood',
    flags: ['prompt', 'k'], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'forwards frictionNeighbourhood’s result verbatim, whose cloud-off/error shape can be ok:false at exit 0 — the same forwarded-result question as final-review-stats, owned by Cluster F §2b.' },
    load: () => import('./commands/misc.mjs').then((m) => m.getFrictionNeighbourhoodCmd),
  },
  {
    name: 'learning-stats',
    flags: [], positionals: 'none', payload: 'json',
    scope: 'none', kind: 'read', cloud: 'none',
    load: () => import('./commands/learning.mjs').then((m) => m.learningStatsCmd),
  },
  {
    name: 'learning-quickfix-stats',
    flags: ['action', 'repo-id', { name: 'bootstrap', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'none',
    load: () => import('./commands/learning.mjs').then((m) => m.learningQuickfixStatsCmd),
  },
  {
    name: 'learning-weekly-review',
    flags: ['repo', 'format', { name: 'dry-run', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'none',
    softFail: { all: true, reason: 'forwards runWeeklyReview’s result verbatim, which emits {ok:false, error:{…}} at EXIT 0 when repoName is unresolvable (measured: learning-weekly-dry). A 6th instance of the same forwarded-result question §2b F3/F4 settles.' },
    load: () => import('./commands/learning.mjs').then((m) => m.learningWeeklyReviewCmd),
  },
  {
    name: 'learning-backfill-outcomes',
    flags: ['repo', 'repo-id', { name: 'dry-run', kind: 'boolean' },
      { name: 'skip-drain', kind: 'boolean' }, { name: 'skip-resolve', kind: 'boolean' },
      { name: 'rebuild-stats', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/learning.mjs').then((m) => m.learningBackfillOutcomesCmd),
  },
  // Forwarders: the target CLI owns its own grammar, so flag validation is
  // delegated and the sub-CLI's envelope + ok-derived exit code travel verbatim.
  {
    name: 'friction-log',
    forward: { to: 'scripts/friction-log.mjs' }, portExempt: true,
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/misc.mjs').then((m) => m.frictionLogCmd),
  },
  {
    name: 'learning-replay',
    forward: { to: 'scripts/learning/replay.mjs' }, portExempt: true,
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'none',
    load: () => import('./commands/learning.mjs').then((m) => m.learningReplayCmd),
  },

  // ── Cohort: model-A/B/C + arm-eval (Cluster D) ───────────────────────────
  // The cloud-off `{ok:false}` shape on these five is the MEASURED set behind
  // plan §2b F3: it reports a supported mode as a failure, and 55 of 60 other
  // commands already use {ok:true, cloud:false}. Fixed in Cluster F with a
  // consumer census + deliberate re-capture, not silently here.
  {
    name: 'model-ab-stats',
    flags: ['run-id'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop', degradeShape: { rows: [] },
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false, rows:[]} at exit 0 — a SUPPORTED mode reported as a failure. One of the 5 measured F3 cases in plan §2b; fixed there with a consumer census and a deliberate fixture re-capture.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.modelAbStatsCmd),
  },
  {
    name: 'model-ab-decision',
    flags: ['run-id'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false} at exit 0 — a supported mode reported as a failure. Plan §2b F3.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.modelAbDecisionCmd),
  },
  {
    name: 'model-ab-adjudicate',
    flags: ['run-id', 'fingerprint', 'action', 'canonical', 'actor', 'limit', 'suggestions', 'out',
      { name: 'json', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false} at exit 0 — a supported mode reported as a failure. Plan §2b F3 (one of the 5 measured cases).' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.modelAbAdjudicateCmd),
  },
  {
    name: 'arm-eval-decision',
    flags: ['experiment', 'repo-id', 'phase', { name: 'all-repos', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    // scope:'none' — this command passes repoId/allRepos straight to a store
    // that REFUSES an unscoped read, so the refusal is the store's, not a
    // silent widening. Declaring global-optin would imply the dispatcher
    // resolves it, which it must not.
    scope: 'none', kind: 'read', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false} at exit 0 — a supported mode reported as a failure. Plan §2b F3.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalDecisionCmd),
  },
  {
    name: 'arm-eval-stats',
    flags: ['experiment', 'repo-id', { name: 'all-repos', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'none', kind: 'read', cloud: 'degrade-noop', degradeShape: { rows: [] },
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false, rows:[]} at exit 0 — a supported mode reported as a failure. Plan §2b F3.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalStatsCmd),
  },
  {
    name: 'arm-eval-adjudicate',
    flags: ['session-id', 'ranked', 'reviewer'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false} at exit 0 — a supported mode reported as a failure. Plan §2b F3 (measured).' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalAdjudicateCmd),
  },
  {
    name: 'arm-eval-export',
    flags: ['session-id', 'repo-id', { name: 'all', kind: 'boolean' }, { name: 'all-repos', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    softFail: { all: true, reason: 'cloud-off emits {ok:false, cloud:false} at exit 0 — a supported mode reported as a failure. Plan §2b F3 (measured). Also returns ok:r.written for a single-session export.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalExportCmd),
  },
  {
    name: 'arm-eval-toggle',
    flags: ['budget-eur'], positionals: { verbs: ['on', 'off', 'status'] }, payload: 'none',
    scope: 'none', kind: 'local', cloud: 'none',
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalToggleCmd),
  },
  {
    name: 'arm-eval-maybe-capture',
    flags: ['experiment', 'task', 'repo-id'], positionals: 'none', payload: 'none',
    scope: 'ambient-ok', kind: 'write', cloud: 'none',
    softFail: { all: true, reason: 'returns ok:(r.state===\'ran\') — a session the runner declined (budget, toggle race) is a legitimate non-run, not an error, and the `captured` field carries the fact. Plan §2b F2 decides whether declined-vs-failed needs separating.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalMaybeCaptureCmd),
  },
  {
    name: 'arm-eval-run',
    flags: ['experiment', 'task', 'budget-eur', 'repo-id', 'phase', 'seed'],
    positionals: 'none', payload: 'none',
    // NO cloud gate, by design: this is the entry point that AUTHORISES a paid
    // run (tiered-pipeline `allowTiered` doctrine — env flags say the window is
    // open, only an explicit CLI call spends). Consequence: its degrade path is
    // deliberately NOT golden-covered, because capturing it means paying.
    scope: 'ambient-ok', kind: 'write', cloud: 'none',
    softFail: { all: true, reason: 'returns ok:(r.state===\'ran\'); a declined run is a legitimate non-run. Plan §2b F2.' },
    load: () => import('./commands/model-eval.mjs').then((m) => m.armEvalRunCmd),
  },

  // ── Cohort: the last four (Cluster D) — legacy map empties here ──────────
  {
    name: 'finalize-outcomes',
    flags: ['run-id', 'ledger', 'result', 'round'], positionals: 'none', payload: 'none',
    scope: 'none', kind: 'write', cloud: 'degrade-noop',
    // Its cloud-off branch is NOT the canonical degrade shape — it runs the
    // local finalize and reports counts — so the handler builds it, and
    // degradeShape stays empty rather than pretending to describe it.
    degradeShape: {},
    load: () => import('./commands/plans.mjs').then((m) => m.finalizeOutcomesCmd),
  },
  {
    name: 'lock-with-test',
    flags: ['finding', 'test', 'description', 'repo', 'repo-id',
      { name: 'worksheet', kind: 'boolean' }, { name: 'all-repos', kind: 'boolean' }],
    positionals: 'none', payload: 'none',
    scope: 'global-optin', kind: 'write', cloud: 'degrade-noop',
    degradeShape: { locked: false },
    // Legacy returns {ok:false, error:'refusing: …'} at EXIT 0 for every
    // refusal (missing args, bad path, unresolvable repo, foreign finding) —
    // fixture-pinned by lock-with-test-missing. These are REFUSALS, which the
    // §2b F4 invariant says should exit non-zero; folded into that decision
    // rather than changed piecemeal here.
    softFail: { all: true, reason: 'every refusal path returns {ok:false, error:"refusing: …"} at exit 0 — fixture-pinned (lock-with-test-missing). A refusal is exactly what F4 says must exit non-zero; changing it is a consumer-visible break that belongs with the other four.' },
    load: () => import('./commands/ship.mjs').then((m) => m.lockWithTestCmd),
  },
  {
    name: 'quality',
    flags: ['title', 'scope-tags', { name: 'scope-tag', kind: 'repeatable' }, 'cost', 'name',
      'files', { name: 'file', kind: 'repeatable' }, 'symbols', { name: 'symbol', kind: 'repeatable' },
      'body', 'memory', 'kind', 'ref', 'window-days', 'min-similarity', 'window-hours',
      { name: 'repo-scoped', kind: 'boolean' }],
    positionals: { verbs: ['add', 'mirror', 'digest', 'link', 'session-review'] },
    payload: 'both',
    scope: 'none', kind: 'write', cloud: 'none',
    load: () => import('./commands/quality.mjs').then((m) => m.qualityCmd),
  },
  {
    name: 'upstream',
    flags: ['title', 'body', 'severity', 'affected-path', 'actor', 'id', 'note', 'commit',
      'state', 'before', 'limit', 'repo-id', { name: 'worksheet', kind: 'boolean' }],
    positionals: { verbs: ['report', 'list', 'ack', 'fix', 'wont-fix', 'drain'] },
    payload: 'none',
    scope: 'ambient-ok', kind: 'write', cloud: 'degrade-noop', degradeShape: {},
    load: () => import('./commands/quality.mjs').then((m) => m.upstreamCmd),
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
