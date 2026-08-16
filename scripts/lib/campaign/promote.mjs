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
 * Resolve this repo's store row id, or null when unresolvable/cloud-off.
 *
 * The `null` return is unavoidable (every caller already treats it as
 * "cloud-off or unregistered" — widening the return shape would ripple into
 * every call site) — but the FAILURE case was previously silent (`.catch(()
 * => null)` with nothing else), conflating "cloud is off" / "repo genuinely
 * never registered" with a real operational failure (network timeout, auth
 * error, malformed config). Consolidated-gate finding (round-4/5 H7):
 * `promoteFromLog` calls this AFTER cloud availability is already confirmed
 * on, so a null result there specifically means resolution failed for some
 * OTHER reason — and that reason is now visible on stderr rather than
 * indistinguishable from the ordinary unregistered-repo case.
 */
export async function repoId() {
  const { resolveRepoForStore } = await import('../store/repo.mjs');
  const { generateRepoProfile } = await import('../context.mjs');
  const ref = await resolveRepoForStore({ profile: generateRepoProfile() }).catch((err) => {
    process.stderr.write(`  [campaign/promote] repoId: resolveRepoForStore failed (${err.message}) — treating as unresolvable, but this is a REAL failure, not an ordinary unregistered-repo case\n`);
    return null;
  });
  return ref?.repoRowId ?? null;
}

/**
 * Classify one bake-off log entry for promotion into the campaign spine.
 *
 * PURE, and every refusal is named rather than silently skipped — a snapshot
 * that quietly fails to promote is indistinguishable from one that was never
 * collected, and the denominator would shrink without anyone seeing it.
 *
 * Three refusals, each from a stated invariant:
 *
 *  - **No `lockDigest`** (collected before the lock existed): ineligible, and
 *    never adopted into the current cohort. Relabelling evidence collected
 *    under an unknown contract is exactly what produced five false "window met"
 *    reads; the rows stay readable in the log, they just cannot count.
 *  - **A different campaign** (or none): not ours.
 *  - **Arms disagreeing about the commit**: not one snapshot (§2.5b-i). One
 *    snapshot is one transcript at one revision, because that revision is what
 *    adjudication verifies against.
 *
 * @param {object} entry
 * @param {{campaignId: string, lockDigest: string, shaByRunId: Record<string,string|null>}} ctx
 */
export function classifyLogEntry(entry, { campaignId, lockDigest, shaByRunId }) {
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
    const sha = arm?.runId ? shaByRunId[arm.runId] : null;
    if (sha) shas.add(sha);
  }
  if (shas.size === 0) {
    return { eligible: false, reason: 'no arm resolved an audited_sha — an unverifiable revision makes the snapshot unadjudicatable (§2.5b-i)' };
  }
  if (shas.size > 1) {
    return { eligible: false, reason: `arms recorded ${shas.size} different commits (${[...shas].join(', ')}) — one snapshot is one revision` };
  }
  return {
    eligible: true,
    auditedSha: [...shas][0],
    armRuns: armEntries.map(([armId, arm]) => ({
      armId,
      auditRunId: arm?.runId ?? null,
      error: arm?.error ?? null,
      // `costUsd` absent is UNPRICED, never 0 — an unrecorded charge that reads
      // as free is lesson (e), and the CHECK constraint enforces the pairing.
      costUsd: Number.isFinite(arm?.costUsd) ? arm.costUsd : null,
      costStatus: Number.isFinite(arm?.costUsd) ? 'priced' : 'unpriced',
    })),
  };
}

/**
 * Is THIS arm's result in THIS log entry a retry (D5)?
 *
 * Extracted so the rule is assertable without a database, same reasoning as
 * `resolvePromotionAttempt` immediately below, and because `retriedArmIds` is
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
 * PURE. What promotion should do with one arm, given what the store already
 * holds and whether the collection was forced.
 *
 * Three outcomes, and the middle one is the whole of `--force`:
 *   - nothing recorded          → attempt 1, no supersede
 *   - recorded, not forced      → SKIP. Promotion is idempotent; re-running
 *                                 reconcile must never append a second attempt,
 *                                 which would double-count the arm's spend.
 *   - recorded, forced          → attempt N+1, supersede the prior live row.
 *                                 Never an overwrite: the earlier attempt stays
 *                                 readable and its spend still counts, which is
 *                                 exactly why `armSpend` sums superseded rows.
 *
 * Extracted so the rule is assertable without a database. Before `--force`
 * existed, the third branch was unreachable — and with it the `attempt` column,
 * the partial unique index and the receipt-attempt protocol were all machinery
 * no operator action could trigger.
 */
export function resolvePromotionAttempt({ existingAttempt = 0, forced = false } = {}) {
  const n = Number.isInteger(existingAttempt) && existingAttempt > 0 ? existingAttempt : 0;
  if (n === 0) return { skip: false, attempt: 1, supersedePrior: false };
  if (!forced) return { skip: true, attempt: n, supersedePrior: false };
  return { skip: false, attempt: n + 1, supersedePrior: true };
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
export async function promoteFromLog({ config, lock, configDigest, entries }) {
  const runIds = entries.flatMap((e) => Object.values(e.arms ?? {}).map((a) => a?.runId).filter(Boolean));
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
    const cls = classifyLogEntry(entry, { campaignId: config.id, lockDigest: lock.lockDigest, shaByRunId: shas.byRunId });
    if (!cls.eligible) { refused.push({ snapshotId: entry.snapshotId, reason: cls.reason }); continue; }
    const snap = await store.upsertSnapshot({
      cohortId: cohort.id, snapshotId: entry.snapshotId, auditedSha: cls.auditedSha, transcriptPath: entry.transcript ?? null,
    });
    if (!snap.ok) { refused.push({ snapshotId: entry.snapshotId, reason: snap.error }); continue; }
    for (const arm of cls.armRuns) {
      const existing = await store.maxArmRunAttempt({ cohortId: cohort.id, snapshotId: entry.snapshotId, armId: arm.armId });
      const plan = resolvePromotionAttempt({ existingAttempt: existing.attempt, forced: isArmRetried(entry, arm.armId) });
      if (plan.skip) continue;
      const res = await store.recordArmRun({
        cohortId: cohort.id, snapshotRowId: snap.id, snapshotId: entry.snapshotId, armId: arm.armId, attempt: plan.attempt,
        auditRunId: arm.auditRunId, costUsd: arm.costUsd, costStatus: arm.costStatus, error: arm.error,
        supersedePrior: plan.supersedePrior,
      });
      if (res.ok) promoted += 1;
      else refused.push({ snapshotId: entry.snapshotId, reason: `${arm.armId}: ${res.error}` });
    }
  }
  process.stdout.write(`  promoted ${promoted} arm-run(s) into cohort ${lock.lockDigest}\n`);
  // Every refusal is NAMED. A snapshot that quietly fails to promote is
  // indistinguishable from one never collected, and the denominator would
  // shrink with nobody seeing it.
  for (const r of refused) process.stdout.write(`  not promoted ${r.snapshotId}: ${r.reason}\n`);
  return { cloud: true, promoted, refused };
}
