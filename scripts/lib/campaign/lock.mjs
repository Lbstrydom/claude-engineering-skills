/**
 * @fileoverview Campaign lock + receipt protocol — the `CONTRACT_EPOCH` that
 * cannot be forgotten, and the crash window named rather than waved at.
 *
 * Plan: docs/plans/model-comparison-campaigns.md §2.5b (lock digest), §2.5b-i
 * (cohort identity), §807 (operational failure and resume semantics).
 *
 * The lock exists because five false "window met" reads came from a hand-bumped
 * epoch string. Here the epoch is DERIVED from live resolution, so a
 * meaning-changing drift — a new model resolution, an edited prompt, a swapped
 * adjudicator — automatically orphans prior evidence into its own cohort. There
 * is no string to remember to bump, which makes that failure unrepresentable
 * rather than merely discouraged.
 *
 * @module scripts/lib/campaign/lock
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteFileSync } from '../file-io.mjs';
import { isPathContained } from '../path-validation.mjs';
import { canonicalJson } from './config.mjs';

/** Category A (gitignored, derived from live resolution). The lock FILE is a
 * cache of the resolution for display and drift comparison; the authoritative
 * digest travels on `campaign_cohorts.lock_digest`. */
export const CAMPAIGNS_STATE_DIR = path.join('.audit', 'campaigns');

export const RECEIPT_STATES = Object.freeze(['intent', 'complete', 'recorded']);

/**
 * Every path this module derives interpolates consumer-owned values (campaign
 * id, arm id) and is therefore resolved and asserted repo-root-contained before
 * any write — INC-001's lesson one layer out. The id patterns in config.mjs are
 * defence-in-depth in front of this, not a substitute for it: this is the check
 * that still holds if a future edit loosens the pattern.
 */
function assertContained(candidate, repoRoot) {
  const resolved = path.resolve(repoRoot, candidate);
  if (!isPathContained(repoRoot, resolved)) {
    throw new Error(`[campaign/lock] refusing a path that escapes the repo root: ${candidate}`);
  }
  return resolved;
}

/**
 * The collection-time contract epoch.
 *
 * **Collection-time inputs ONLY.** `matcherVersion`/`matcherThreshold` are
 * deliberately absent: they are analysis-time parameters over already-paid
 * evidence, so including them would let a free re-clustering destroy a whole
 * cohort. The membership test: an input belongs here if changing it would make
 * already-collected evidence MEAN something different.
 *
 * `eligibilityRule` and `armIds` are in (§2.5b-i) — widening eligibility or
 * adding an arm mixes two populations, so it must orphan rather than blend. The
 * snapshot LIST is deliberately out: the population grows as ordinary work
 * happens, and freezing it would make the campaign uncollectable.
 *
 * @param {{schemaVersion:number, configDigest:string, resolvedModels:Record<string,string>,
 *   providerRoutes:Record<string,string>, reasoningEffort:string, promptTemplateHash:string,
 *   outputSchemaHash:string, adjudicatorModel:string, pricingVersion:string,
 *   eligibilityRule:string, armIds:string[]}} inputs
 * @returns {string} 16 hex chars
 */
export function computeLockDigest(inputs) {
  const required = ['schemaVersion', 'configDigest', 'resolvedModels', 'providerRoutes', 'reasoningEffort',
    'promptTemplateHash', 'outputSchemaHash', 'adjudicatorModel', 'pricingVersion', 'eligibilityRule', 'armIds'];
  for (const key of required) {
    if (inputs?.[key] == null) {
      // A missing input would silently produce a DIFFERENT digest that still
      // looks valid, orphaning evidence for a reason nobody can see.
      throw new Error(`[campaign/lock] computeLockDigest requires "${key}" — an absent input silently changes the epoch`);
    }
  }
  const canonical = canonicalJson({
    schemaVersion: inputs.schemaVersion,
    configDigest: inputs.configDigest,
    resolvedModels: inputs.resolvedModels,
    providerRoutes: inputs.providerRoutes,
    reasoningEffort: inputs.reasoningEffort,
    promptTemplateHash: inputs.promptTemplateHash,
    outputSchemaHash: inputs.outputSchemaHash,
    adjudicatorModel: inputs.adjudicatorModel,
    pricingVersion: inputs.pricingVersion,
    eligibilityRule: inputs.eligibilityRule,
    // Sorted: arm DECLARATION order is not part of the cohort's identity, only
    // its membership. Reordering arms in the config must not orphan evidence.
    armIds: [...inputs.armIds].sort(),
  });
  return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** `.audit/campaigns/<campaignId>.lock.json` */
export function lockFilePath(campaignId, { repoRoot = process.cwd() } = {}) {
  return assertContained(path.join(CAMPAIGNS_STATE_DIR, `${campaignId}.lock.json`), repoRoot);
}

export function writeLockFile(campaignId, lockBody, { repoRoot = process.cwd() } = {}) {
  const target = lockFilePath(campaignId, { repoRoot });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // Atomic here: the lock file's CONTENT is read for drift comparison, so a
  // torn write would compare against nonsense.
  atomicWriteFileSync(target, `${JSON.stringify(lockBody, null, 2)}\n`);
  return target;
}

export function readLockFile(campaignId, { repoRoot = process.cwd() } = {}) {
  const target = lockFilePath(campaignId, { repoRoot });
  if (!fs.existsSync(target)) return null;
  try { return JSON.parse(fs.readFileSync(target, 'utf-8')); }
  catch { return null; } // a torn cache is a cache miss, never a crash — the store holds the authority
}

/** Directory holding every receipt for one (campaign, cohort). */
export function receiptDir(campaignId, cohortDigest, { repoRoot = process.cwd() } = {}) {
  return assertContained(path.join(CAMPAIGNS_STATE_DIR, campaignId, cohortDigest), repoRoot);
}

/**
 * `.audit/campaigns/<campaignId>/<cohortDigest>/<snapshotId>--<armId>--<attempt>.receipt.json`
 *
 * **`<attempt>` is load-bearing.** Without it, the first thing a `--force`
 * retry does is collide with its own predecessor's receipt and die `EEXIST` —
 * the resume protocol would break the retry it exists to enable, because the
 * arm-run unique key includes `attempt` precisely so `--force` can append one.
 */
export function receiptPath({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot = process.cwd() }) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new Error(`[campaign/lock] attempt must be a positive integer, got ${attempt}`);
  }
  const dir = receiptDir(campaignId, cohortDigest, { repoRoot });
  return assertContained(path.join(dir, `${snapshotId}--${armId}--${attempt}.receipt.json`), repoRoot);
}

/**
 * `<snapshotId>--<armId>--<attempt>.receipt.json`, parsed NON-GREEDILY.
 *
 * Greedy `(.+)` was wrong, and wrong in the worst direction. An arm id may
 * contain `-` (`^[a-z0-9][a-z0-9-]*$` permits `solo--opus`), so on
 * `abcdef123456--solo--opus--1.receipt.json` the greedy first group ran past
 * the delimiter and yielded `snapshotId = "abcdef123456--solo"`,
 * `armId = "opus"`. Both then fail the caller's equality check, the receipt is
 * SILENTLY SKIPPED, `maxAttemptOnDisk` returns 0, every later run resolves
 * `attempt = 1`, collides on `wx`, and concludes it lost a race — the exact
 * permanent wedge, with the exact silent-skip symptom, that
 * `resolveNextAttempt` exists to prevent.
 *
 * Non-greedy is provably correct here rather than merely better: the first
 * group is minimal, so it stops at the first `--`, and a `snapshotId` never
 * contains one (it is 12 hex chars from `snapshotId()`, or the literal
 * `adjudicate` for an adjudication receipt). The arm id absorbs any remaining
 * `--`, which is what it should do.
 */
const RECEIPT_NAME = /^(.+?)--(.+?)--(\d+)\.receipt\.json$/;

/** Highest attempt number already CLAIMED on disk for one arm-run, or 0. */
export function maxAttemptOnDisk({ campaignId, cohortDigest, snapshotId, armId, repoRoot = process.cwd() }) {
  const dir = receiptDir(campaignId, cohortDigest, { repoRoot });
  if (!fs.existsSync(dir)) return 0;
  let max = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = RECEIPT_NAME.exec(name);
    if (!m) continue;
    if (m[1] !== snapshotId || m[2] !== armId) continue;
    const n = Number(m[3]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return max;
}

/**
 * Next attempt number — **DISK ∪ DB, never the DB alone.**
 *
 * The obvious implementation ("live row's attempt + 1, default 1") wedges the
 * arm-run permanently, and putting `attempt` in the path is what creates the
 * wedge: the runner claims `…--1.receipt.json`, crashes before the store write,
 * and now no row exists — so every later run resolves `attempt = 1`, collides
 * on `wx`, concludes it lost a race, and exits. Including under `--force`. The
 * arm-run becomes unrunnable forever and the symptom is a SILENT SKIP, the
 * worst available failure shape.
 *
 * The receipt directory is the authority on what was CLAIMED; the store is the
 * authority on what was RECORDED. A crash is exactly the window where those
 * differ, so consulting either alone is consulting the wrong one.
 *
 * Genuine concurrency is still excluded: two live runners resolve the same
 * `max + 1` and exactly one wins the `wx` create.
 */
export function resolveNextAttempt({ campaignId, cohortDigest, snapshotId, armId, dbMaxAttempt = 0, repoRoot = process.cwd() }) {
  const onDisk = maxAttemptOnDisk({ campaignId, cohortDigest, snapshotId, armId, repoRoot });
  const inDb = Number.isInteger(dbMaxAttempt) && dbMaxAttempt > 0 ? dbMaxAttempt : 0;
  return Math.max(onDisk, inDb) + 1;
}

/**
 * Step 1 — CLAIM. `flag:'wx'`, deliberately **not** `atomicWriteFileSync`.
 *
 * The repo's atomic helper is temp-file + rename, and rename REPLACES the
 * destination — it cannot express exclusive-create, so pairing it with
 * `flag:'wx'` would be an API error that silently destroyed the mutual
 * exclusion. A direct `wx` open is the only primitive that fails when the
 * destination exists, and that failure IS the attempt ownership. Atomicity is
 * not needed here: the file is a lock token whose mere existence is the signal.
 *
 * @returns {{ok: true, path: string} | {ok: false, code: 'claimed'}}
 */
export function claimReceipt({ campaignId, cohortDigest, snapshotId, armId, attempt, body = {}, repoRoot = process.cwd() }) {
  const target = receiptPath({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const payload = { state: 'intent', campaignId, cohortDigest, snapshotId, armId, attempt, ...body };
  try {
    fs.writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, { flag: 'wx' });
    return { ok: true, path: target };
  } catch (err) {
    if (err?.code === 'EEXIST') return { ok: false, code: 'claimed' };
    throw err;
  }
}

/**
 * Step 3 — persist the receipt BEFORE the store row: file first, because the
 * file is the cheaper thing to re-read and the database is the thing that just
 * failed. Atomic here (unlike the claim) because the CONTENT must never tear —
 * a half-written cost is worse than none.
 */
export function completeReceipt({ campaignId, cohortDigest, snapshotId, armId, attempt, result, repoRoot = process.cwd() }) {
  return writeReceiptState({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot, state: 'complete', patch: result });
}

/** Step 5 — mark recorded, once the store row is durable. */
export function markReceiptRecorded({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot = process.cwd() }) {
  return writeReceiptState({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot, state: 'recorded', patch: {} });
}

function writeReceiptState({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot, state, patch }) {
  const target = receiptPath({ campaignId, cohortDigest, snapshotId, armId, attempt, repoRoot });
  if (!fs.existsSync(target)) {
    throw new Error(`[campaign/lock] cannot mark "${state}": no claimed receipt at ${path.relative(repoRoot, target)} — the claim is what establishes ownership of this attempt`);
  }
  const existing = JSON.parse(fs.readFileSync(target, 'utf-8'));
  atomicWriteFileSync(target, `${JSON.stringify({ ...existing, ...patch, state }, null, 2)}\n`);
  return target;
}

/**
 * Scan every receipt for a campaign, for `campaign.mjs reconcile`.
 *
 * `complete` = paid and unrecorded → the store row can be inserted and the
 * receipt marked `recorded`. `intent` = the true crash window, where paid-or-not
 * is genuinely **unknown**; it is reported for an operator decision and NEVER
 * auto-retried, because silently re-calling is exactly the double-charge this
 * protocol exists to prevent. Raising the attempt number lets a NEW attempt
 * proceed; it does not decide that the abandoned one went unpaid. Both facts
 * stay on disk.
 */
export function scanReceipts(campaignId, { repoRoot = process.cwd() } = {}) {
  const root = assertContained(path.join(CAMPAIGNS_STATE_DIR, campaignId), repoRoot);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const cohort of fs.readdirSync(root)) {
    const dir = path.join(root, cohort);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = RECEIPT_NAME.exec(name);
      if (!m) continue;
      try {
        const body = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
        out.push({ ...body, cohortDigest: cohort, snapshotId: m[1], armId: m[2], attempt: Number(m[3]), path: path.join(dir, name) });
      } catch {
        // A torn receipt is reported, never skipped: an unreadable receipt in
        // the crash window is precisely the thing an operator must see.
        out.push({ state: 'unreadable', cohortDigest: cohort, snapshotId: m[1], armId: m[2], attempt: Number(m[3]), path: path.join(dir, name) });
      }
    }
  }
  return out;
}
