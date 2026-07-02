/**
 * @fileoverview Telemetry-data collector for the dashboard. Gathers audit
 * metrics (Supabase + local), the requirements ledger, and learning-decision
 * counts into one object plus a per-source status map. Secret-redacts any
 * free text before it reaches the page (docs/plans/local-dashboard.md §2.5).
 *
 * @module scripts/lib/dashboard/collect-telemetry
 */
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { fetchCloudMetrics, computeLocalMetrics } from '../../audit-metrics.mjs';
import { getLearningStats } from '../learning/stats.mjs';
import { redactSecrets } from '../sanitizer.mjs';
import { resolveRepoIdentity } from '../repo-identity.mjs';
import { getRepoIdByUuid } from '../store/repo.mjs';
import { loadBanditArms } from '../store/bandit-fp.mjs';
import { readShipEvents, readAuditEffectiveness } from '../store/plans-ship.mjs';
import { getSecurityStats } from '../store/security.mjs';
import { getPurposeHealth } from '../store/purpose-health.mjs';
import { getAuthorTierStats } from '../store/learning-decisions.mjs';
import { aggregateAuthorTier } from './author-tier-agg.mjs';
import { getModelAbEffectiveness, getModelAbFindingScores, getModelAbArmCost, getModelAbAdjudicationQueue, cumulativeSpendEur } from '../store/model-ab.mjs';
import { evaluateDecision, DECISION_CONSTANTS } from '../model-ab-decision.mjs';
import { auditShadowConfig } from '../config.mjs';
import { PurposeConfigSchema } from './schema.mjs';
import { loadDomainRules, tagDomain } from '../symbol-index/domain-tagger.mjs';
import { classifyPath } from '../sensitive-paths.mjs';

const DAYS = 30;
const MAX_REQ_ITEMS = 200;

// M4 — Supabase client is gone. fetchCloudMetrics now ignores its first
// positional arg and reaches into the shared pg pool via lib/db/client.mjs.
// We keep the call shape so the rest of this collector + audit-metrics
// stays unchanged; the legacy `sb` is just passed as null.

/** Aggregate raw `audit_pass_stats` rows into per-pass totals. */
function aggregatePasses(passStats) {
  const byPass = {};
  for (const ps of passStats) {
    const name = ps.pass_name || 'unknown';
    if (!byPass[name]) byPass[name] = { name, runs: 0, raised: 0, accepted: 0, dismissed: 0 };
    const p = byPass[name];
    p.runs += 1;
    p.raised += ps.findings_raised || 0;
    p.accepted += ps.findings_accepted || 0;
    p.dismissed += ps.findings_dismissed || 0;
  }
  return Object.values(byPass).sort((a, b) => b.runs - a.runs);
}

/**
 * Collect the audit-runs section.
 *
 * @param {string|null} [repoId] canonical `audit_repos.id` for the cwd repo.
 *   When non-null the cloud query is scoped to that repo (`scope: 'repo'`);
 *   null falls back to the project-wide query (`scope: 'project'`) — the
 *   pre-scope behaviour, preserved for repos with no resolvable row / cloud
 *   off. (Replaces the dead legacy `sb` positional — pg path ignores it.)
 */
async function collectAuditRuns(repoId = null) {
  const local = computeLocalMetrics(DAYS);
  const localPart = { total: local.total, labeled: local.labeled };
  // `scope` describes the CLOUD result that is actually displayed. The
  // non-cloud paths below report 'project' because no repo-scoped cloud
  // query succeeded — emitting 'repo' there would be incoherent (the
  // section only consults scope when cloud===true, but the data must not
  // lie about what was fetched).
  let cloud = null;
  try {
    cloud = await fetchCloudMetrics(null, DAYS, repoId);
  } catch (err) {
    return {
      data: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: localPart, scope: 'project' },
      status: { status: 'unexpected-error', detail: redactSecrets(`cloud metrics query failed: ${err.message}`) },
    };
  }
  if (!cloud) {
    const empty = !local.total;
    return {
      data: { cloud: false, runCount: 0, labeledCount: 0, passes: [], local: localPart, scope: 'project' },
      status: empty
        ? { status: 'missing-optional', detail: 'no cloud store and no local outcomes' }
        : { status: 'ok', detail: 'local-only' },
    };
  }
  // Cloud query succeeded: scope reflects whether it was repo-filtered.
  const scope = repoId ? 'repo' : 'project';
  return {
    data: {
      cloud: true,
      runCount: cloud.runs.length,
      labeledCount: cloud.labeled.length,
      passes: aggregatePasses(cloud.passStats),
      local: localPart,
      scope,
    },
    status: { status: 'ok', detail: scope === 'repo' ? 'per-repo' : 'project-wide (no canonical repo row)' },
  };
}

/** Collect the requirements section from the committed ledger. */
function collectRequirements(root) {
  const rel = '.requirements/ledger.json';
  let raw;
  try { raw = fs.readFileSync(path.join(root, rel), 'utf-8'); }
  catch (err) {
    // ENOENT = the optional ledger is simply absent; any other read fault
    // (EACCES, …) is a real I/O failure, not "missing-optional".
    const status = err.code === 'ENOENT'
      ? { status: 'missing-optional', detail: 'no requirements ledger' }
      : { status: 'unexpected-error', detail: redactSecrets(`${rel} unreadable: ${err.message}`) };
    return { data: { present: false, total: 0, active: 0, truncated: false, items: [] }, status };
  }
  try {
    const ledger = JSON.parse(raw);
    const reqs = Array.isArray(ledger.requirements) ? ledger.requirements : [];
    const items = reqs.slice(0, MAX_REQ_ITEMS).map((r) => ({
      id: String(r.id || ''),
      kind: String(r.kind || 'unknown'),
      // Requirement statements are descriptive prose from the committed
      // .requirements/ledger.json — not a secret-bearing surface. They are
      // NOT secret-redacted: redactSecrets false-positives on ordinary words
      // (e.g. it mangled "[REDACTED_TOKEN]" into a real requirement).
      statement: String(r.assertion || r.statement || '').slice(0, 280),
      status: String(r.status || 'unknown'),
    }));
    return {
      data: {
        present: true,
        total: reqs.length,
        active: reqs.filter((r) => r.status === 'active').length,
        truncated: reqs.length > MAX_REQ_ITEMS,
        items,
      },
      status: { status: 'ok', detail: '' },
    };
  } catch (err) {
    return {
      data: { present: false, total: 0, active: 0, truncated: false, items: [] },
      status: { status: 'invalid', detail: redactSecrets(`ledger.json malformed: ${err.message}`) },
    };
  }
}

/** This repo's name — the learning store keys repos by it. */
function repoName(root) {
  if (process.env.LEARNING_REPO_NAME) return process.env.LEARNING_REPO_NAME;
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).name || null;
  } catch {
    return null;
  }
}

/** Collect the learning section via the shared accessor. */
async function collectLearning(root) {
  try {
    // Cluster A (§2.1 / Gemini-G3): resolve the STABLE canonical repoRowId via
    // repo_uuid identity — NOT the volatile repoName — so learning stats group
    // on the same id the writers use (matches the other collectors below).
    // Fall back to repoName only when the canonical row isn't resolvable.
    let repoId = null;
    try { repoId = (await getRepoIdByUuid(resolveRepoIdentity(root).repoUuid))?.id || null; } catch { /* fall back to name */ }
    const r = await getLearningStats(repoId ? { repoId } : { repoName: repoName(root) });
    const s = r.stats || { pendingTriageCount: 0, noBrainerCount: 0, staleClusterCount: 0 };
    return {
      data: { cloud: r.cloud, ...s },
      status: r.status,
    };
  } catch (err) {
    return {
      data: { cloud: false, pendingTriageCount: 0, noBrainerCount: 0, staleClusterCount: 0 },
      status: { status: 'unexpected-error', detail: redactSecrets(`learning stats failed: ${err.message}`) },
    };
  }
}

/**
 * Collect prompt-variant (bandit) effectiveness — surfaces the Thompson-sampling
 * arms (Cluster D / Phase 7). Arms are global (`context_bucket`), so no repo
 * scoping. Posterior mean = alpha/(alpha+beta); sorted by pulls desc.
 */
async function collectPromptVariants() {
  try {
    const armsMap = await loadBanditArms();
    if (!armsMap) {
      return {
        data: { cloud: false, arms: [] },
        status: { status: 'missing-optional', detail: 'no bandit arms yet (needs cloud + a deliberation/rebuttal run)' },
      };
    }
    const arms = Object.values(armsMap)
      .map((a) => {
        const denom = a.alpha + a.beta;
        return {
          passName: String(a.passName),
          variantId: String(a.variantId),
          pulls: Number(a.pulls) || 0,
          mean: denom > 0 ? Number((a.alpha / denom).toFixed(3)) : 0,
          alpha: Number(a.alpha.toFixed(2)),
          beta: Number(a.beta.toFixed(2)),
          contextBucket: String(a.contextBucket || 'global'),
        };
      })
      .sort((x, y) => y.pulls - x.pulls);
    return { data: { cloud: true, arms }, status: { status: 'ok', detail: '' } };
  } catch (err) {
    return {
      data: { cloud: false, arms: [] },
      status: { status: 'unexpected-error', detail: redactSecrets(`bandit arms query failed: ${err.message}`) },
    };
  }
}

/** Resolve the canonical repoRowId for the cwd repo (Cluster A identity). */
async function canonicalRepoId(root) {
  try { return (await getRepoIdByUuid(resolveRepoIdentity(root).repoUuid))?.id || null; }
  catch { return null; }
}

/** Collect ship-event health (Cluster D / Phase 7) — per-repo outcome mix + recent. */
async function collectShipHealth(root) {
  const empty = { cloud: false, byOutcome: [], recent: [] };
  try {
    const repoId = await canonicalRepoId(root);
    if (!repoId) return { data: empty, status: { status: 'missing-optional', detail: 'no canonical repo row for this directory' } };
    const r = await readShipEvents(repoId, { limit: 10 });
    if (!r) return { data: empty, status: { status: 'missing-optional', detail: 'ship telemetry needs cloud + a service-role key' } };
    if (!r.byOutcome.length) return { data: { cloud: true, byOutcome: [], recent: [] }, status: { status: 'missing-optional', detail: 'no ship events recorded yet' } };
    return {
      data: {
        cloud: true,
        byOutcome: r.byOutcome.map((o) => ({ outcome: String(o.outcome), count: Number(o.count) || 0 })),
        recent: r.recent.map((e) => ({
          outcome: String(e.outcome),
          branch: String(e.branch || ''),
          commitSha: String(e.commit_sha || '').slice(0, 8),
          overridden: !!e.overridden_by_user,
          createdAt: e.created_at ? new Date(e.created_at).toISOString() : '',
        })),
      },
      status: { status: 'ok', detail: '' },
    };
  } catch (err) {
    return { data: empty, status: { status: 'unexpected-error', detail: redactSecrets(`ship events query failed: ${err.message}`) } };
  }
}

/** Empty author-tier shape (schema-valid). */
function emptyAuthorTier() {
  return { cloud: false, total: 0, bySuggestedTier: [], ladders: [], distinctProviderLadders: 0, diversityGateMet: false, agreement: { agree: 0, disagree: 0, declaredUnknown: 0 } };
}

/**
 * Collect the author-tier observation panel (model-tier-observation —
 * observation-only). Per-repo, keyed by the same canonical repo id the recorder
 * writes with. Surfaces suggested-tier × converged, the declared ladder partition
 * keys, and the cross-model-bias diversity gate. Graceful degradation throughout.
 */
async function collectAuthorTier(root) {
  try {
    const repoId = await canonicalRepoId(root);
    if (!repoId) return { data: emptyAuthorTier(), status: { status: 'missing-optional', detail: 'no canonical repo row for this directory' } };
    const r = await getAuthorTierStats({ repoId });
    if (!r.cloud) return { data: emptyAuthorTier(), status: { status: 'missing-optional', detail: 'author-tier telemetry needs cloud + a service-role key' } };
    if (!r.rows.length) return { data: { cloud: true, ...aggregateAuthorTier([]) }, status: { status: 'missing-optional', detail: 'no author_tier observations recorded yet' } };
    return { data: { cloud: true, ...aggregateAuthorTier(r.rows) }, status: { status: 'ok', detail: '' } };
  } catch (err) {
    return { data: emptyAuthorTier(), status: { status: 'unexpected-error', detail: redactSecrets(`author-tier query failed: ${err.message}`) } };
  }
}

/** Empty model-A/B/C shape (schema-valid). */
function emptyModelAb() {
  return { cloud: false, status: 'off', reason: '', distinctAssignments: 0, minAssignments: DECISION_CONSTANTS.MIN_ASSIGNMENTS, spentEur: 0, capEur: null, pendingAdjudication: 0, arms: [] };
}

/**
 * Collect the model-A/B/C experiment panel ("A/B/C Testing") — the arm-eval
 * accumulation state: per-arm labelled outcomes, native conformance, spend vs
 * budget, decision status, and the pending human-adjudication queue depth.
 * EXPERIMENT-WIDE (not repo-scoped): assignments accumulate across every
 * toggled-on repo by design. Read-only over the same store views the
 * `model-ab-{stats,decision,adjudicate}` CLIs use. Graceful cloud-off.
 */
async function collectModelAb() {
  try {
    const eff = await getModelAbEffectiveness({});
    if (!eff.cloud) return { data: emptyModelAb(), status: { status: 'missing-optional', detail: 'model-A/B/C telemetry needs the cloud store' } };
    const [scores, costs, queue] = await Promise.all([
      getModelAbFindingScores({}),
      getModelAbArmCost({}),
      getModelAbAdjudicationQueue({ limit: 500 }),
    ]);
    const decision = evaluateDecision(scores.rows, costs.rows, DECISION_CONSTANTS);
    const spentEur = await cumulativeSpendEur({ activeTtlMs: auditShadowConfig.reservationTtlMs });
    const byArm = new Map();
    for (const r of eff.rows || []) {
      const a = byArm.get(r.arm) || { arm: r.arm, rows: 0, accepted: 0, dismissed: 0, pending: 0, acceptedHigh: 0, costUsd: 0, conformant: 0, passExecutions: 0 };
      const n = (v) => (v == null ? 0 : Number(v) || 0);
      a.rows++;
      a.accepted += n(r.accepted_uniques); a.dismissed += n(r.dismissed_uniques);
      a.pending += n(r.pending_uniques); a.acceptedHigh += n(r.accepted_high);
      a.costUsd += n(r.cost_usd); a.conformant += n(r.conformant_passes); a.passExecutions += n(r.pass_executions);
      byArm.set(r.arm, a);
    }
    const data = {
      cloud: true,
      status: String(decision.status ?? 'unknown'),
      reason: redactSecrets(String(decision.reason ?? '')),
      distinctAssignments: Number(decision.distinctAssignments) || 0,
      minAssignments: DECISION_CONSTANTS.MIN_ASSIGNMENTS,
      spentEur: Number(spentEur) || 0,
      capEur: auditShadowConfig.budgetEur == null ? null : Number(auditShadowConfig.budgetEur),
      pendingAdjudication: (queue.items || []).length,
      arms: [...byArm.values()].sort((a, b) => a.arm.localeCompare(b.arm)),
    };
    return { data, status: { status: 'ok', detail: '' } };
  } catch (err) {
    return { data: emptyModelAb(), status: { status: 'unexpected-error', detail: redactSecrets(`model-ab query failed: ${err.message}`) } };
  }
}

/** Empty audit-effectiveness shape (schema-valid). */
function emptyEffectiveness() {
  return { cloud: false, confirmedHits: 0, auditMisses: 0, falsePositives: 0, severityUnderstated: 0, severityOverstated: 0, precision: null, recall: null };
}

/** Collect audit-effectiveness (Cluster D / Phase 7) — per-repo precision/recall vs persona ground truth. */
async function collectAuditEffectiveness(root) {
  try {
    const repoId = await canonicalRepoId(root);
    if (!repoId) return { data: emptyEffectiveness(), status: { status: 'missing-optional', detail: 'no canonical repo row for this directory' } };
    const row = await readAuditEffectiveness(repoId);
    if (!row) return { data: emptyEffectiveness(), status: { status: 'missing-optional', detail: 'effectiveness needs cloud + a service-role key' } };
    const n = (v) => (v == null ? 0 : Number(v) || 0);
    const data = {
      cloud: true,
      confirmedHits: n(row.confirmed_hits),
      auditMisses: n(row.audit_misses),
      falsePositives: n(row.audit_false_positives),
      severityUnderstated: n(row.severity_understated),
      severityOverstated: n(row.severity_overstated),
      precision: row.user_visible_precision == null ? null : Number(row.user_visible_precision),
      recall: row.user_visible_recall == null ? null : Number(row.user_visible_recall),
    };
    // No correlations yet → all-zero/null. Surface that as the empty state so the
    // panel reads "awaiting persona↔audit correlations", not a false "0% precision".
    const hasSignal = data.confirmedHits || data.auditMisses || data.falsePositives
      || data.severityUnderstated || data.severityOverstated;
    if (!hasSignal) {
      return { data, status: { status: 'missing-optional', detail: 'no persona↔audit correlations yet (run /persona-test with audit linkage)' } };
    }
    return { data, status: { status: 'ok', detail: '' } };
  } catch (err) {
    return { data: emptyEffectiveness(), status: { status: 'unexpected-error', detail: redactSecrets(`effectiveness query failed: ${err.message}`) } };
  }
}

/** Empty security telemetry shape (schema-valid; used on absence/error). */
function emptySecurity() {
  return {
    cloud: false, totalIncidents: 0, embedded: 0,
    byStatus: [], eventCounts: [], lastRefreshAt: null, recentEvents: [],
  };
}

/** Re-shape getSecurityStats() (maps + raw rows) into the render data object. */
function securityData(stats) {
  const iso = (v) => (v ? new Date(v).toISOString() : null);
  return {
    cloud: true,
    totalIncidents: stats.totalIncidents,
    embedded: stats.embedded,
    byStatus: Object.entries(stats.byStatus).map(([status, c]) => ({ status, count: c })),
    eventCounts: Object.entries(stats.eventCounts).map(([kind, c]) => ({ kind, count: c })),
    lastRefreshAt: iso(stats.lastRefreshAt),
    recentEvents: (stats.recentEvents || []).map((e) => ({
      incidentId: String(e.incident_id || ''),
      eventKind: String(e.event_kind || ''),
      branch: String(e.branch || ''),
      createdAt: iso(e.created_at) || '',
    })),
  };
}

/**
 * Collect the security section. Keyed by the SAME repo identity the writers
 * use (resolveRepoIdentity → repo_uuid → audit_repos.id) so the dashboard
 * reads the rows refresh-incidents.mjs wrote — not a different, empty repo_id.
 */
async function collectSecurity(root) {
  try {
    const identity = resolveRepoIdentity(root);
    const repoRow = await getRepoIdByUuid(identity.repoUuid);
    if (!repoRow?.id) {
      return { data: emptySecurity(), status: { status: 'missing-optional', detail: 'no security incidents indexed for this repo' } };
    }
    const stats = await getSecurityStats(repoRow.id);
    if (!stats.cloud) {
      return { data: emptySecurity(), status: { status: 'missing-optional', detail: 'security telemetry needs cloud + a service-role key' } };
    }
    return { data: securityData(stats), status: { status: 'ok', detail: '' } };
  } catch (err) {
    return { data: emptySecurity(), status: { status: 'unexpected-error', detail: redactSecrets(`security stats failed: ${err.message}`) } };
  }
}

const WINDOW_DAYS = 30;
// In v2, only this purpose is confidently attributable from a single signal.
const ATTRIBUTED_PURPOSE = 'preserve-trust-safety';

/** Empty purposeHealth data (schema-shaped). */
function emptyPurposeHealth() {
  return {
    asOf: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    repoWide: { recentHighFindings: null, plansWithFailingCriteria: null, refusedSecrets: null, unattributable: null },
    purposeBadges: [],
  };
}

/**
 * Collect the Purpose Health telemetry section (cloud). Owns the taxonomy join:
 * reads the purposes from .audit-loop/domain-map.json (the same committed source
 * the reference Purpose tab uses), calls the pure store reader for counts, and
 * assembles `purposeBadges` (every purpose; only `preserve-trust-safety`
 * attributed). Source-state lives in the returned `status` (NOT in `data`).
 */
async function collectPurposeHealth(root) {
  // 1. Taxonomy (graceful ENOENT — a consumer repo without the purpose map).
  let purposes;
  try {
    const raw = fs.readFileSync(path.join(root, '.audit-loop', 'domain-map.json'), 'utf-8');
    const map = JSON.parse(raw);   // parse once (M7/M11)
    const parsed = PurposeConfigSchema.safeParse({
      purposes: map.purposes,
      domainPurposes: map.domainPurposes || {},
    });
    if (!parsed.success) {
      return { data: emptyPurposeHealth(), status: { status: 'missing-optional', detail: 'purpose config invalid — see the Purpose tab' } };
    }
    purposes = parsed.data.purposes;
    var domainPurposesCfg = parsed.data.domainPurposes;
  } catch (err) {
    if (err.code === 'ENOENT') {
      return { data: emptyPurposeHealth(), status: { status: 'missing-optional', detail: 'no purpose map (.audit-loop/domain-map.json)' } };
    }
    return { data: emptyPurposeHealth(), status: { status: 'unexpected-error', detail: redactSecrets(`purpose taxonomy unreadable: ${err.message}`) } };
  }

  // 2. Counts (cloud).
  let repoId = null;
  let counts;
  try {
    repoId = (await getRepoIdByUuid(resolveRepoIdentity(root).repoUuid))?.id || null;
    counts = await getPurposeHealth(repoId, { windowDays: WINDOW_DAYS });
  } catch (err) {
    return { data: emptyPurposeHealth(), status: { status: 'unexpected-error', detail: redactSecrets(`purpose health query failed: ${err.message}`) } };
  }
  if (!repoId || !counts.cloud) {
    return { data: emptyPurposeHealth(), status: { status: 'missing-optional', detail: 'needs a cloud database connection (AUDIT_DB_URL)' } };
  }

  // 3. Per-domain attribution (v3 Part A) — tag each HIGH finding's file to a
  //    domain → purpose. The whole block is guarded: any throw sets
  //    attributionAvailable=false (HIGH-based purposes → na; trust-safety still
  //    uses refusedSecrets). NEVER crashes the section.
  const domainCountByPurpose = {};      // purposeId → # mapped domains (for the no-domains→na rule)
  for (const p of purposes) domainCountByPurpose[p.id] = 0;
  for (const [, plist] of Object.entries(domainPurposesCfg || {})) {
    // Dedup per domain (a hand-edited `da:['p1','p1']` must count that domain
    // ONCE for p1, not twice) — matches collect-purposes' per-domain dedup.
    for (const pid of new Set(plist)) if (pid in domainCountByPurpose) domainCountByPurpose[pid] += 1;
  }
  const purposeIds = purposes.map((p) => p.id);
  let attribution;
  try {
    const rules = loadDomainRules(root);   // the throwy part (I/O) stays here
    attribution = attributeHighByFile(counts.highByFile, { rules, domainPurposesCfg, purposeIds });
  } catch (err) {
    process.stderr.write(`  [purpose-health] attribution failed (→ na): ${err.message}\n`);
    attribution = { highTally: Object.fromEntries(purposeIds.map((id) => [id, 0])), unattributable: null, attributionAvailable: false };
  }
  const { highTally, unattributable, attributionAvailable } = attribution;

  const purposeBadges = classifyPurposeBadges({
    purposes, domainCountByPurpose, highTally,
    refusedSecrets: counts.refusedSecrets, attributionAvailable,
  });

  const partial = [counts.recentHighFindings, counts.plansWithFailingCriteria, counts.refusedSecrets, counts.highByFile].some((v) => v == null);
  return {
    data: {
      asOf: new Date().toISOString(),
      windowDays: WINDOW_DAYS,
      repoWide: {
        recentHighFindings: counts.recentHighFindings,
        plansWithFailingCriteria: counts.plansWithFailingCriteria,
        refusedSecrets: counts.refusedSecrets,
        unattributable,
      },
      purposeBadges,
    },
    status: { status: 'ok', detail: partial ? 'some metrics unavailable (shown as —)' : '' },
  };
}

/**
 * Pure attribution (v3 Part A) — tag each HIGH-by-file row to a domain→purpose.
 * No I/O (rules passed in). Returns per-purpose HIGH tallies + the
 * `unattributable` bucket (null file / sensitive / non-path / no-purpose domain;
 * a finding in a multi-purpose domain counts toward EACH). `attributionAvailable`
 * is false only when the by-file data itself is absent.
 *
 * @param {Array<{file:string|null, n:number}>|null} highByFile
 * @param {{rules:object[], domainPurposesCfg:object, purposeIds:string[]}} ctx
 */
function attributeHighByFile(highByFile, { rules, domainPurposesCfg, purposeIds }) {
  const highTally = Object.fromEntries(purposeIds.map((id) => [id, 0]));
  if (!Array.isArray(highByFile)) return { highTally, unattributable: null, attributionAvailable: false };
  let unattributable = 0;
  for (const row of highByFile) {
    const n = Number(row.n) || 0;
    const file = row.file;
    if (file == null) { unattributable += n; continue; }              // guard before String()
    const norm = String(file).replace(/\\/g, '/').replace(/^\.\//, '');
    if (classifyPath(norm) === 'sensitive') { unattributable += n; continue; } // never attribute a secret file
    const domain = tagDomain(norm, rules);
    // Dedup per domain so a `da:['p1','p1']` doesn't add n twice to p1.
    const hit = [...new Set(domain ? (domainPurposesCfg[domain] || []) : [])].filter((pid) => pid in highTally);
    if (hit.length === 0) { unattributable += n; continue; }
    for (const pid of hit) highTally[pid] += n;                       // multi-purpose → each (distinct)
  }
  return { highTally, unattributable, attributionAvailable: true };
}

/**
 * Pure per-purpose health classifier (v3 Part A). Each signal is judged on its
 * OWN availability — never conflate "unavailable" with "healthy".
 * @returns {Array<{id,label,health,scope,reason}>}
 */
function classifyPurposeBadges({ purposes, domainCountByPurpose, highTally, refusedSecrets, attributionAvailable }) {
  return purposes.map((p) => {
    const highOn = attributionAvailable && highTally[p.id] > 0;
    if (p.id === ATTRIBUTED_PURPOSE) {
      const secretAvail = refusedSecrets != null;
      const secretOn = secretAvail && refusedSecrets > 0;
      if (!attributionAvailable && !secretAvail) {
        return { id: p.id, label: p.label, health: 'na', scope: 'repo-wide-only', reason: 'signals unavailable' };
      }
      const health = (highOn || secretOn) ? 'at-risk' : 'ok';
      const bits = [];
      if (attributionAvailable) bits.push(`${highTally[p.id]} recent HIGH in its domains`);
      if (secretAvail) bits.push(`${refusedSecrets} refused secret(s)`);
      else bits.push('refused-secret signal unavailable');
      return { id: p.id, label: p.label, health, scope: 'purpose-specific', reason: bits.join(' · ') };
    }
    // HIGH-attributed-only purposes.
    if (!attributionAvailable) {
      return { id: p.id, label: p.label, health: 'na', scope: 'repo-wide-only', reason: 'HIGH attribution unavailable this run' };
    }
    if (domainCountByPurpose[p.id] === 0) {
      return { id: p.id, label: p.label, health: 'na', scope: 'repo-wide-only', reason: 'no domains to assess' };
    }
    const health = highOn ? 'at-risk' : 'ok';
    return {
      id: p.id, label: p.label, health, scope: 'purpose-specific',
      reason: highOn ? `${highTally[p.id]} recent HIGH in its domains` : `no HIGH findings in its domains (${WINDOW_DAYS}d)`,
    };
  });
}

/**
 * Collect the full telemetry-data object.
 * @param {{git?: {baseSha: string}}} [opts]
 * @returns {Promise<object>} a TelemetryData object (validate before render)
 */
export async function collectTelemetry(opts = {}) {
  const root = process.cwd();
  const git = opts.git || { baseSha: 'unknown' };

  // M4 — collectAuditRuns pulls from the shared pg pool via lib/db/client.mjs.
  // Scope the Audit Runs tab to this directory's canonical repo row when
  // resolvable; null → project-wide fallback (cloud off / never-audited repo).
  const auditRepoId = await canonicalRepoId(root);
  const [auditRuns, learning, security, purposeHealth, promptVariants, shipHealth, auditEffectiveness, authorTier, modelAb] = await Promise.all([
    collectAuditRuns(auditRepoId),
    collectLearning(root),
    collectSecurity(root),
    collectPurposeHealth(root),
    collectPromptVariants(),
    collectShipHealth(root),
    collectAuditEffectiveness(root),
    collectAuthorTier(root),
    collectModelAb(),
  ]);
  const requirements = collectRequirements(root);

  return {
    kind: 'telemetry',
    provenance: {
      generatedAt: new Date().toISOString(),
      baseSha: git.baseSha,
      mode: auditRuns.data.cloud ? 'cloud' : 'local-only',
    },
    sources: {
      auditRuns: auditRuns.status,
      requirements: requirements.status,
      learning: learning.status,
      security: security.status,
      purposeHealth: purposeHealth.status,
      promptVariants: promptVariants.status,
      shipHealth: shipHealth.status,
      auditEffectiveness: auditEffectiveness.status,
      authorTier: authorTier.status,
      modelAb: modelAb.status,
    },
    auditRuns: auditRuns.data,
    requirements: requirements.data,
    learning: learning.data,
    security: security.data,
    purposeHealth: purposeHealth.data,
    promptVariants: promptVariants.data,
    shipHealth: shipHealth.data,
    auditEffectiveness: auditEffectiveness.data,
    authorTier: authorTier.data,
    modelAb: modelAb.data,
  };
}

// Internal exports for tests — collectRequirements is a pure file read, so
// it is fixturable; aggregatePasses is pure.
export const __test__ = { collectRequirements, aggregatePasses, securityData, emptySecurity, collectPurposeHealth, emptyPurposeHealth, classifyPurposeBadges, attributeHighByFile };
