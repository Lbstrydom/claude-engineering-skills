/**
 * @fileoverview Log→spine promotion, retry marking — `promoteFromLog`,
 * `isArmRetried`, reconcile mechanics (D2).
 *
 * Moved from `scripts/campaign.mjs` (plan: comparison-tooling-consolidation.md,
 * Phase 3). Per D2a: may import `lib/store/campaign.mjs`; must NOT import any
 * `scripts/*.mjs` entry point, `bakeoff/**` (R4/H2 — no cycle back to the
 * collector), or `campaign/adjudicate.mjs`. **Writes the store; does NOT read
 * the log** — that is the D2b fix for the cycle this decomposition would
 * otherwise introduce (see below).
 *
 * **Two necessary deviations from verbatim, both required by the D2a/D2b
 * boundary (discovered during Phase 3 implementation, same class of fix as
 * `bakeoff/spawn.mjs` and `bakeoff/summary.mjs`'s own notes).**
 *
 * 1. **`promoteFromLog` takes `entries` as a PARAMETER, not `readLog()`
 *    internally — this is D2b's OWN documented fix, not a new one.** The
 *    plan's D2b section states it explicitly: adding `bakeoff` to
 *    `campaign`'s `allowedDeps` would legitimise a cycle (`bakeoff/arms.mjs
 *    → lib/campaign/config.mjs` runs one way, `campaign/promote.mjs →
 *    bakeoff/log.mjs` would run the other), so the log entries are threaded
 *    in from the CLI entry point instead, which already imports both
 *    subsystems and is the only layer permitted to.
 * 2. **`promoteFromLog` no longer prints the cloud-off notice itself** — it
 *    returns `{cloud:false}` and the caller (`verbReconcile`, which already
 *    owns `cloudOffNotice`) renders it. `cloudOffNotice` is a CLI-flavoured
 *    stdout helper with several OTHER callers in `campaign.mjs`; importing it
 *    here would be exactly the "lib module reaching back into the entry
 *    point" edge D2 exists to eliminate.
 *
 * `repoId()` moved here too (it was `campaign.mjs`-local but is pure
 * lib-composition — dynamic imports of `store/repo.mjs` + `context.mjs`, no
 * entry-point dependency) since `promoteFromLog` needs it and this module may
 * not import the CLI to get it; the CLI's own remaining caller
 * (`verbDeclareInconclusive`) now imports it back from here.
 *
 * @module scripts/lib/campaign/promote
 */
import * as store from '../store/campaign.mjs';

/**
 * Resolve this repo's store row id, or null for the two LEGITIMATE null
 * cases: cloud is off, or this repo genuinely has no store row yet.
 *
 * Bake-off-campaign gate finding (G1, verified against `store/repo.mjs`):
 * the earlier fix here only made a real operational failure (network
 * timeout, auth error, malformed config) VISIBLE on stderr while still
 * returning `null` — indistinguishable, to every caller, from the ordinary
 * cloud-off/unregistered case. `resolveRepoForStoreResult()` already
 * discriminates the three outcomes (`cloud-off` / `unresolved` / `error`),
 * so an operational failure can now be a genuine THROW instead of widening
 * this function's return shape — `promoteFromLog` calls this AFTER cloud
 * availability is already confirmed on, so an uncaught throw here means a
 * real store failure during promotion, which should fail the CLI (the
 * top-level `main().catch()` in campaign.mjs already exits non-zero on any
 * thrown error), not silently print "cloud off" and exit 0.
 */
export async function repoId() {
  const { resolveRepoForStoreResult } = await import('../store/repo.mjs');
  const { generateRepoProfile } = await import('../context.mjs');
  const r = await resolveRepoForStoreResult({ profile: generateRepoProfile() });
  if (r.kind === 'resolved') return r.repoRowId;
  if (r.kind === 'cloud-off' || r.kind === 'unresolved') return null;
  throw new Error(`[campaign/promote] repoId: resolveRepoForStoreResult failed (${r.error}) — a real operational failure, not an ordinary unregistered-repo case`);
}

/**
 * Classify one bake-off log entry for promotion into the campaign spine.
 *
 * PURE, and every refusal is named rather than silently skipped — a snapshot
 * that quietly fails to promote is indistinguishable from one that was never
 * collected, and the denominator would shrink without anyone seeing it.
 *
 * Four refusals, each from a stated invariant:
 *
 *  - **No `lockDigest`** (collected before the lock existed): ineligible, and
 *    never adopted into the current cohort. Relabelling evidence collected
 *    under an unknown contract is exactly what produced five false "window met"
 *    reads; the rows stay readable in the log, they just cannot count.
 *  - **A different campaign** (or none): not ours.
 *  - **Arms disagreeing about the commit**: not one snapshot (§2.5b-i). One
 *    snapshot is one transcript at one revision, because that revision is what
 *    adjudication verifies against.
 *  - **A plan-hash mismatch against LIVE, non-quarantined attempts already in
 *    the store** (§7 Phase 4, H1/H5) — shaped like the sha check above, but
 *    scoped to the store's own history rather than this entry's arms. `IS NOT
 *    DISTINCT FROM` semantics: a legacy NULL-hash live attempt is silently
 *    compatible with a further NULL-hash one, but a real, differing hash is a
 *    mismatch requiring `confirmMismatch`. `existingPlanHashesByArm` is
 *    `{armId: Set<hash|null>}` for LIVE, NON-QUARANTINED prior attempts —
 *    already filtered through `isAttemptExcluded` by the caller, so a
 *    quarantined legacy pairing drops out of the comparison population
 *    entirely and a corrected re-collection needs no flag once quarantined.
 *
 * @param {object} entry
 * @param {{campaignId: string, lockDigest: string, shaByRunId: Record<string,string|null>,
 *   existingPlanHashesByArm?: Record<string, Set<string|null>>, confirmMismatch?: boolean}} ctx
 */
/**
 * PURE. Which arms in this entry disagree with their OWN live,
 * non-quarantined store history on plan-content hash — extracted from
 * `classifyLogEntry` so the comparison rule is assertable and readable in
 * isolation (round 6, M6: the containing function was growing multiple
 * independent policy concerns).
 *
 * `IS NOT DISTINCT FROM` semantics: NULL-vs-NULL is a match (a legacy
 * snapshot with no historical hash accepts a further NULL-hash attempt);
 * only a REAL, differing value is a mismatch. An arm with no entry in
 * `existingPlanHashesByArm` (no live history at all — a genuinely new
 * arm-run) is never a mismatch, since there is nothing to disagree with.
 *
 * @param {Array<[string, object]>} armEntries - `Object.entries(entry.arms)`
 * @param {Record<string, Set<string|null>>} existingPlanHashesByArm
 * @returns {Array<{armId: string, oldHash: string|null, newHash: string|null}>}
 */
export function detectPlanHashMismatches(armEntries, existingPlanHashesByArm) {
  const mismatches = [];
  for (const [armId, arm] of armEntries) {
    const attemptHash = arm?.planContentHash ?? null;
    const existingHashes = existingPlanHashesByArm[armId];
    if (!existingHashes) continue;
    for (const oldHash of existingHashes) {
      if ((oldHash ?? null) !== attemptHash) mismatches.push({ armId, oldHash: oldHash ?? null, newHash: attemptHash });
    }
  }
  return mismatches;
}

export function classifyLogEntry(entry, {
  campaignId, lockDigest, shaByRunId, existingPlanHashesByArm = {}, confirmMismatch = false,
}) {
  if (entry?.campaignId !== campaignId) {
    return { eligible: false, reason: entry?.campaignId ? `belongs to campaign "${entry.campaignId}"` : 'collected before this campaign was declared (no campaignId)' };
  }
  if (!entry.lockDigest) {
    return { eligible: false, reason: 'no lockDigest — collected under an unknown contract; it cannot be adopted into a cohort without relabelling it' };
  }
  if (entry.lockDigest !== lockDigest) {
    return { eligible: false, reason: `superseded lock ${entry.lockDigest} (current ${lockDigest}) — its own cohort, not this one` };
  }
  const armEntries = Object.entries(entry.arms ?? {});
  const shas = new Set();
  for (const [, arm] of armEntries) {
    // LIVE attempts only, deliberately — a superseded attempt's run id is NOT
    // folded in here. A human-invoked retry can happen days after the first
    // attempt, at a different HEAD, so a superseded run legitimately carries a
    // different `audited_sha`; counting it would trip the "one snapshot is one
    // revision" rule below and make the whole snapshot ineligible for having
    // been retried. The revision that must be single is the one adjudication
    // verifies findings against, which is the live attempt's.
    const sha = arm?.runId ? shaByRunId[arm.runId] : null;
    if (sha) shas.add(sha);
  }
  if (shas.size === 0) {
    return { eligible: false, reason: 'no arm resolved an audited_sha — an unverifiable revision makes the snapshot unadjudicatable (§2.5b-i)' };
  }
  if (shas.size > 1) {
    return { eligible: false, reason: `arms recorded ${shas.size} different commits (${[...shas].join(', ')}) — one snapshot is one revision` };
  }

  // §7 Phase 4 plan-hash consistency check — per arm, against that arm's OWN
  // live non-quarantined history in the store.
  const mismatches = detectPlanHashMismatches(armEntries, existingPlanHashesByArm);
  if (mismatches.length > 0 && !confirmMismatch) {
    const named = mismatches.map((m) => `${m.armId} (store: ${m.oldHash ?? 'null'}, new: ${m.newHash ?? 'null'})`).join(', ');
    return {
      eligible: false,
      reason: `plan-hash mismatch against live evidence: ${named} — re-run \`campaign.mjs reconcile --confirm-mismatch\` to `
        + 'acknowledge a corrected plan pairing, or quarantine the old pairing first with `campaign.mjs quarantine`',
    };
  }

  return {
    eligible: true,
    auditedSha: [...shas][0],
    // Non-empty only when a REAL mismatch was let through by confirmMismatch
    // — the caller (`promoteFromLog`) auto-quarantines each named oldHash in
    // the same locked transaction before admitting the new attempt.
    mismatches,
    armRuns: armEntries.map(([armId, arm]) => ({
      armId,
      auditRunId: arm?.runId ?? null,
      // A LIVE (non-superseded) log entry carries its failure under
      // `shadowError` (bakeoff-collect.mjs never writes a top-level `error`
      // on the live shape) — `arm?.error` alone was always undefined here,
      // silently dropping every live failure to `null` and making
      // `liveArmRunsForSnapshot`'s `error IS NULL` success gate read a failed
      // arm as succeeded. `?? arm?.error` kept as a defensive fallback,
      // mirroring the superseded-attempt mapping below and bakeoff-collect's
      // own `prior.error ?? prior.shadowError` merge.
      error: arm?.shadowError ?? arm?.error ?? null,
      // `costUsd` absent is UNPRICED, never 0 — an unrecorded charge that reads
      // as free is lesson (e), and the CHECK constraint enforces the pairing.
      costUsd: Number.isFinite(arm?.costUsd) ? arm.costUsd : null,
      costStatus: Number.isFinite(arm?.costUsd) ? 'priced' : 'unpriced',
      // §7 Phase 4: each attempt's OWN provenance, populated at promotion
      // time — never a single entry-level value (round 5, H2).
      planContentHash: arm?.planContentHash ?? null,
      configDigest: arm?.configDigest ?? null,
      // Attempts that were spawned, billed, and replaced — oldest first. The
      // collector retries a TIMED-OUT arm automatically now, so an arm's live
      // result may be its second spawn; promoting only that one would report a
      // recovered arm as costing exactly what a first-try arm cost, which is
      // the asymmetry `armSpend` sums superseded rows to avoid. A timed-out
      // attempt is `unpriced` rather than $0: the provider may have burned the
      // whole reasoning budget and returned no usage block to price.
      supersededAttempts: (Array.isArray(arm?.supersededAttempts) ? arm.supersededAttempts : []).map((s) => ({
        auditRunId: s?.runId ?? null,
        error: s?.error ?? s?.errorCategory ?? 'superseded attempt',
        costUsd: Number.isFinite(s?.costUsd) ? s.costUsd : null,
        costStatus: Number.isFinite(s?.costUsd) ? 'priced' : 'unpriced',
        planContentHash: s?.planContentHash ?? null,
        configDigest: s?.configDigest ?? null,
      })),
    })),
  };
}

/**
 * Is THIS arm's result in THIS log entry a retry (D5)?
 *
 * Extracted so the rule is assertable without a database, same reasoning as
 * `resolvePromotionAttempts` immediately below, and because `retriedArmIds` is
 * PER-ARM while the log entry it lives on may carry several arms' results at
 * once — collapsing that back to a single boolean at the call site is exactly
 * the mistake that made `--force` retry the whole snapshot instead of one arm.
 *
 * `retriedArmIds` is bakeoff-collect.mjs's per-arm marker; its absence means
 * this log line predates D5, where the only marker was the whole-entry
 * `forced: true` — every arm present in such an entry WAS a retry by
 * definition, since a non-forced re-collection never wrote a second line for
 * an already-recorded snapshot.
 *
 * @param {object} entry - a bake-off log entry
 * @param {string} armId
 * @returns {boolean}
 */
export function isArmRetried(entry, armId) {
  return Array.isArray(entry?.retriedArmIds)
    ? entry.retriedArmIds.includes(armId)
    : entry?.forced === true;
}

/**
 * PURE. What promotion should do with one arm's recorded attempts, given
 * what the store ALREADY holds — by IDENTITY (§7 Phase 3), not by count.
 *
 * **Round 6/Phase 3 rework**: the predecessor signature
 * (`{existingAttempt, recordedAttempts, forced}`) compared two INTEGERS.
 * That is the exact root cause of defect #2 (this plan's Context Summary): a
 * fresh pinned-worktree fixture restarts local attempt-numbering at 1, so a
 * genuinely NEW successful run (a different `audit_run_id`) at local
 * "attempt 1" collided with the store's own attempt-1 (which may have been
 * the earlier failure) — `resolvePromotionAttempts` read that as "already
 * recorded" by count and silently skipped a real, paid success. `forced`
 * doesn't fix this either: it decides WHETHER to supersede, never WHICH
 * attempts are new. Identity removes the ambiguity: an attempt is already
 * recorded if and only if its OWN `auditRunId` is in `existingRunIds` — a
 * set the caller resolves from the store by exact id, not by counting rows.
 *
 * `forced`/`isArmRetried` are GONE from this function's inputs entirely —
 * they no longer gate anything here. Identity alone decides what's new.
 *
 * @param {{attempts?: Array<{auditRunId: string|null, [key: string]: unknown}>,
 *   existingAttempt?: number, existingRunIds?: Set<string>}} [args]
 * @returns {{skip: boolean, plans: Array<{attempt: number, supersedePrior: boolean, auditRunId: string|null, [key: string]: unknown}>}}
 */
export function resolvePromotionAttempts({ attempts = [], existingAttempt = 0, existingRunIds = new Set() } = {}) {
  const n = Number.isInteger(existingAttempt) && existingAttempt > 0 ? existingAttempt : 0;
  const list = Array.isArray(attempts) ? attempts : [];
  // A null `auditRunId` (an attempt with no minted run — e.g. a spawn that
  // never even registered) has no identity to collide on, so it is always
  // promoted; only a REAL id already present in `existingRunIds` is skipped.
  const toPromote = list.filter((a) => !a?.auditRunId || !existingRunIds.has(a.auditRunId));
  if (toPromote.length === 0) return { skip: true, plans: [] };
  const plans = toPromote.map((a, i) => ({
    attempt: n + i + 1,
    // Attempt 1 has nothing to supersede; every later one replaces the row
    // that was live until it.
    supersedePrior: (n + i + 1) > 1,
    ...a,
  }));
  return { skip: false, plans };
}

/**
 * Promote collected snapshots from the local bake-off log into the store.
 *
 * **This is the producer for `campaign_arm_runs`, and it lives here rather than
 * in the collector on purpose.** The collector writes the log and must never be
 * hostage to the store — refusing to collect because the database is down would
 * lose paid provider results. So the log is the durable file and promotion is a
 * separate, idempotent, re-runnable step: the same file-before-database
 * ordering the receipt protocol already prescribes, one level up.
 *
 * `entries` is a PARAMETER (see the module-level note on why) — the caller
 * passes `readLog()`'s own result.
 */
export async function promoteFromLog({ config, lock, configDigest, entries, confirmMismatch = false }) {
  const runIds = entries.flatMap((e) => Object.values(e.arms ?? {}).flatMap(
    (a) => [a?.runId, ...(Array.isArray(a?.supersededAttempts) ? a.supersededAttempts.map((s) => s?.runId) : [])],
  ).filter(Boolean));
  const shas = await store.auditedShasForRuns(runIds);
  if (shas.cloud === false) return { cloud: false };
  if (!lock?.lockDigest) {
    process.stdout.write('  promotion skipped: this campaign resolved no lock digest, so there is no cohort to promote into.\n');
    return { cloud: true, promoted: 0 };
  }

  const rid = await repoId();
  const campaign = await store.ensureCampaign({ repoId: rid, campaignKey: config.id, configDigest });
  if (!campaign.ok) { process.stderr.write(`  ${campaign.error}\n`); return { cloud: true, promoted: 0 }; }
  const cohort = await store.ensureCohort({ campaignId: campaign.id, lockDigest: lock.lockDigest, resolved: lock });
  if (!cohort.ok) { process.stderr.write(`  ${cohort.error}\n`); return { cloud: true, promoted: 0 }; }

  let promoted = 0;
  const refused = [];
  for (const entry of entries) {
    // Everything for ONE snapshot — classification (including the §7 Phase 4
    // plan-hash consistency check, which needs live store state), quarantine
    // admission, and every write — happens inside ONE locked transaction
    // (§7 Phase 3, round 4 H1+H4): `acquireSnapshotLock` serializes
    // concurrent `reconcile` invocations for this exact (cohort, snapshot),
    // so classification and the writes it gates cannot race.
    const result = await store.withTx(async () => {
      await store.acquireSnapshotLock(cohort.id, entry.snapshotId);

      const exclusions = await store.activeExclusionsForCohort(cohort.id);
      const liveRows = await store.liveArmRunRows({ cohortId: cohort.id, snapshotId: entry.snapshotId });
      const existingPlanHashesByArm = {};
      for (const r of liveRows.rows ?? []) {
        if (store.isAttemptExcluded({ snapshotId: entry.snapshotId, planContentHash: r.planContentHash }, exclusions)) continue;
        if (!existingPlanHashesByArm[r.armId]) existingPlanHashesByArm[r.armId] = new Set();
        existingPlanHashesByArm[r.armId].add(r.planContentHash ?? null);
      }

      const cls = classifyLogEntry(entry, {
        campaignId: config.id, lockDigest: lock.lockDigest, shaByRunId: shas.byRunId,
        existingPlanHashesByArm, confirmMismatch,
      });
      if (!cls.eligible) return { promotedCount: 0, refusals: [{ snapshotId: entry.snapshotId, reason: cls.reason }] };

      // §7 Phase 4 (round 6, H2): `--confirm-mismatch` is a STATE
      // TRANSITION, not a bare acknowledgement — every OLD, disagreeing
      // hash found among this snapshot's live attempts is auto-quarantined
      // in this SAME transaction before the new attempt is admitted, so no
      // window exists where the snapshot's live evidence mixes two pairings.
      const oldHashesToQuarantine = new Set(cls.mismatches.map((m) => m.oldHash));
      for (const oldHash of oldHashesToQuarantine) {
        await store.markSnapshotExcluded({
          cohortId: cohort.id, snapshotId: entry.snapshotId, planContentHash: oldHash,
          reason: 'auto-quarantined via --confirm-mismatch: promoting a corrected plan pairing',
        });
      }
      // Re-fetch exclusions if we just added any — the quarantine admission
      // check below must see the pairing it just excluded.
      const exclusionsForAdmission = oldHashesToQuarantine.size > 0 ? await store.activeExclusionsForCohort(cohort.id) : exclusions;

      const snap = await store.upsertSnapshot({
        cohortId: cohort.id, snapshotId: entry.snapshotId, auditedSha: cls.auditedSha, transcriptPath: entry.transcript ?? null,
      });
      if (!snap.ok) return { promotedCount: 0, refusals: [{ snapshotId: entry.snapshotId, reason: snap.error }] };

      let promotedCount = 0;
      const refusals = [];
      for (const arm of cls.armRuns) {
        // Every attempt this entry records for the arm, oldest first — the
        // superseded ones then the live one. Each was a separate spawn
        // against a provider, so each earns its own row.
        const attempts = [
          ...arm.supersededAttempts,
          {
            auditRunId: arm.auditRunId, costUsd: arm.costUsd, costStatus: arm.costStatus, error: arm.error,
            planContentHash: arm.planContentHash, configDigest: arm.configDigest,
          },
        ];
        const candidateRunIds = attempts.map((a) => a.auditRunId).filter(Boolean);
        const [existingIds, existingAttempt] = await Promise.all([
          store.existingAuditRunIds(candidateRunIds),
          store.maxArmRunAttempt({ cohortId: cohort.id, snapshotId: entry.snapshotId, armId: arm.armId }),
        ]);
        const plan = resolvePromotionAttempts({
          attempts, existingAttempt: existingAttempt.attempt, existingRunIds: existingIds.ids,
        });
        if (plan.skip) continue;
        for (const p of plan.plans) {
          // Quarantine admission, PER ATTEMPT, from its OWN carried hash
          // (§7 Phase 4/5 wiring; round 5 H2) — never a single entry-level
          // value. Until Phase 4 stamps a real `planContentHash` per arm
          // result, this reads `null` for every attempt, which still
          // correctly matches a `scope:'all'` exclusion or a legacy
          // `scope:'pairing', planContentHash:null` one (exactly the 3
          // known mis-paired snapshots' shape).
          if (store.isAttemptExcluded({ snapshotId: entry.snapshotId, planContentHash: p.planContentHash ?? null }, exclusionsForAdmission)) {
            process.stdout.write(`  quarantined pairing — not promoted: ${entry.snapshotId} ${arm.armId} (run ${p.auditRunId ?? 'unregistered'})\n`);
            continue;
          }
          const res = await store.recordArmRun({
            cohortId: cohort.id, snapshotRowId: snap.id, snapshotId: entry.snapshotId, armId: arm.armId, attempt: p.attempt,
            auditRunId: p.auditRunId, costUsd: p.costUsd, costStatus: p.costStatus, error: p.error,
            supersedePrior: p.supersedePrior, planContentHash: p.planContentHash ?? null, configDigest: p.configDigest ?? null,
          });
          if (res.ok) promotedCount += 1;
          else refusals.push({ snapshotId: entry.snapshotId, reason: `${arm.armId}: ${res.error}` });
        }
      }
      return { promotedCount, refusals };
    });
    promoted += result.promotedCount;
    refused.push(...result.refusals);
  }
  process.stdout.write(`  promoted ${promoted} arm-run(s) into cohort ${lock.lockDigest}\n`);
  // Every refusal is NAMED. A snapshot that quietly fails to promote is
  // indistinguishable from one never collected, and the denominator would
  // shrink with nobody seeing it.
  for (const r of refused) process.stdout.write(`  not promoted ${r.snapshotId}: ${r.reason}\n`);
  return { cloud: true, promoted, refused };
}
