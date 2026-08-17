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
 * PURE. What promotion should do with one arm, given how many attempts the
 * ENTRY records, what the store already holds, and whether the collection was
 * forced.
 *
 * Three outcomes, and the middle one is the whole of `--force`:
 *   - nothing recorded          → attempts 1..K, no supersede on the first
 *   - recorded, not forced      → SKIP. Promotion is idempotent; re-running
 *                                 reconcile must never append a second attempt,
 *                                 which would double-count the arm's spend.
 *   - recorded, forced          → attempts N+1..N+K, superseding as they go.
 *                                 Never an overwrite: the earlier attempt stays
 *                                 readable and its spend still counts, which is
 *                                 exactly why `armSpend` sums superseded rows.
 *
 * **K, not 1** (2026-08-18): the collector now retries a timed-out arm
 * automatically, so ONE log entry can carry several attempts for one arm. The
 * singular predecessor could only ever promote the live one, which would have
 * silently dropped every automatically-retried attempt's charge — the same
 * under-report as promoting a `--force` retry without superseding. Because it
 * plans a LIST, the "recorded, not forced" branch also stops being all-or-
 * nothing: a reconcile interrupted after attempt 1 resumes at attempt 2 instead
 * of reading the arm as fully promoted (`n < K` is now a resumable state, not
 * an invisible one).
 *
 * The returned plans align to the TAIL of the entry's attempt list — the caller
 * skips the first `K - plans.length` of them, which are the ones the store
 * already holds.
 *
 * Extracted so the rule is assertable without a database. Before `--force`
 * existed, the third branch was unreachable — and with it the `attempt` column,
 * the partial unique index and the receipt-attempt protocol were all machinery
 * no operator action could trigger.
 *
 * @param {{existingAttempt?: number, recordedAttempts?: number, forced?: boolean}} [args]
 * @returns {{skip: boolean, plans: Array<{attempt: number, supersedePrior: boolean}>}}
 */
export function resolvePromotionAttempts({ existingAttempt = 0, recordedAttempts = 1, forced = false } = {}) {
  const n = Number.isInteger(existingAttempt) && existingAttempt > 0 ? existingAttempt : 0;
  const k = Number.isInteger(recordedAttempts) && recordedAttempts > 0 ? recordedAttempts : 1;
  // How many of this entry's attempts still need a row. Forced means the whole
  // entry is a fresh set appended after everything already stored.
  const toRecord = forced ? k : k - n;
  if (toRecord <= 0) return { skip: true, plans: [] };
  const plans = [];
  for (let i = 0; i < toRecord; i++) {
    const attempt = n + i + 1;
    // Attempt 1 has nothing to supersede; every later one replaces the row that
    // was live until it — including within a single entry, where the automatic
    // retry's success supersedes the timeout that preceded it.
    plans.push({ attempt, supersedePrior: attempt > 1 });
  }
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
      // Every attempt this entry records for the arm, oldest first — the
      // superseded ones then the live one. Each was a separate spawn against a
      // provider, so each earns its own row; the live one is simply the last.
      const attempts = [
        ...arm.supersededAttempts,
        { auditRunId: arm.auditRunId, costUsd: arm.costUsd, costStatus: arm.costStatus, error: arm.error },
      ];
      const existing = await store.maxArmRunAttempt({ cohortId: cohort.id, snapshotId: entry.snapshotId, armId: arm.armId });
      const plan = resolvePromotionAttempts({
        existingAttempt: existing.attempt, recordedAttempts: attempts.length, forced: isArmRetried(entry, arm.armId),
      });
      if (plan.skip) continue;
      // Plans align to the TAIL: the first `attempts.length - plan.plans.length`
      // are already in the store and must not be written twice.
      const offset = attempts.length - plan.plans.length;
      for (let i = 0; i < plan.plans.length; i++) {
        const a = attempts[offset + i];
        const res = await store.recordArmRun({
          cohortId: cohort.id, snapshotRowId: snap.id, snapshotId: entry.snapshotId, armId: arm.armId, attempt: plan.plans[i].attempt,
          auditRunId: a.auditRunId, costUsd: a.costUsd, costStatus: a.costStatus, error: a.error,
          supersedePrior: plan.plans[i].supersedePrior,
        });
        if (res.ok) promoted += 1;
        else refused.push({ snapshotId: entry.snapshotId, reason: `${arm.armId}: ${res.error}` });
      }
    }
  }
  process.stdout.write(`  promoted ${promoted} arm-run(s) into cohort ${lock.lockDigest}\n`);
  // Every refusal is NAMED. A snapshot that quietly fails to promote is
  // indistinguishable from one never collected, and the denominator would
  // shrink with nobody seeing it.
  for (const r of refused) process.stdout.write(`  not promoted ${r.snapshotId}: ${r.reason}\n`);
  return { cloud: true, promoted, refused };
}
