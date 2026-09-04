/**
 * @fileoverview Cross-checks round adjudication ledgers
 * (`.audit/<SID>-ledger.json`, written by SKILL.md Step 3.5) against the debt
 * ledger (`.audit/tech-debt.json`, written by `debt-auto-capture.mjs`, Step
 * 3.6): every round-ledger entry with `ruling: 'defer'` is SUPPOSED to have a
 * matching entry in the debt ledger under the same `topicId`.
 *
 * Step 3.6 is a manual CLI invocation an LLM-driven audit session is
 * *instructed* (in prose, `references/debt-capture.md`) to run after writing
 * the ledger and before fixing findings — nothing mechanical enforces that it
 * actually ran. In a real consumer repo this silently stopped for 11 days:
 * `audit_runs` kept firing daily while 517 `ruling: 'defer'` entries across
 * that window's round ledgers were never captured, invisible to future-round
 * suppression, `debt-review.mjs` clustering, and `debt-budget-check.mjs`'s
 * policy gate — and `debt-health-check.mjs` (which only reads
 * `tech-debt.json` itself) stayed green the whole time, because a ruling
 * that was never captured can't make an already-hydrated ledger look
 * unhealthy. This module is the missing cross-ledger check.
 *
 * Identity match: the topicId a captured debt entry carries is always the
 * SOURCE round-ledger entry's own `topicId` — `debt-auto-capture.mjs`'s
 * `ledgerEntryToFinding()` sets `_topicId: ledgerEntry.topicId`, and
 * `buildDebtEntry()` (`lib/debt-capture.mjs`) persists
 * `topicId: finding._topicId || finding._hash || finding.topicId` verbatim.
 * So a direct `topicId` (or `contentAliases`, for entries later merged under
 * a different topicId by semantic-suppression) lookup is exact — no fuzzy
 * matching needed.
 *
 * @module scripts/lib/debt-capture-trail
 */

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_AUDIT_DIR = '.audit';
const ROUND_LEDGER_SUFFIX = '-ledger.json';

/**
 * Find every round ledger (`<SID>-ledger.json`) directly under `dir`.
 * Non-recursive, matching the `.audit/$SID-ledger.json` naming convention
 * (SKILL.md Step 3.5). Naturally excludes `tech-debt.json` (doesn't carry the
 * suffix). Missing/unreadable `dir` returns `[]` rather than throwing — a
 * fresh repo with no audits run yet has nothing to verify, not an error.
 *
 * @param {string} [dir=DEFAULT_AUDIT_DIR]
 * @returns {string[]} Sorted relative/absolute paths (matches `dir`'s form)
 */
/**
 * Whether the audit directory could be enumerated at all.
 *
 * The companion to `findRoundLedgers`, which returns `[]` both when the
 * directory holds no round ledgers and when it does not exist — a distinction
 * its callers need, because "no deferrals to verify" and "nothing was examined"
 * are opposite claims. `.audit/` is gitignored, so the second case is the
 * DEFAULT in a fresh clone, in CI, and in a linked worktree.
 *
 * Deliberately a sibling rather than a change to `findRoundLedgers`'s return
 * type: that function is consumed at four call sites and pinned by an existing
 * test asserting `[]` for a missing directory. A separate predicate makes
 * absence representable without a breaking signature change.
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md Phase 1 (recorded deviation).
 *
 * @param {string} [dir=DEFAULT_AUDIT_DIR]
 * @returns {boolean}
 */
export function auditDirAvailable(dir = DEFAULT_AUDIT_DIR) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function findRoundLedgers(dir = DEFAULT_AUDIT_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(ROUND_LEDGER_SUFFIX)) continue;
    files.push(path.join(dir, e.name));
  }
  return files.sort();
}

/**
 * Read one round ledger's `ruling: 'defer'` entries. A parse failure or
 * missing `entries` array is reported as `corrupt: true` rather than thrown —
 * one bad file must not stop the scan from covering the rest.
 *
 * @param {string} ledgerPath
 * @returns {{path: string, deferred: object[], corrupt: boolean, error?: string}}
 */
export function readDeferredEntries(ledgerPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(ledgerPath, 'utf-8'));
  } catch (err) {
    return { path: ledgerPath, deferred: [], corrupt: true, error: err.message };
  }
  if (!raw || !Array.isArray(raw.entries)) {
    return { path: ledgerPath, deferred: [], corrupt: true, error: 'missing entries array' };
  }
  return {
    path: ledgerPath,
    deferred: raw.entries.filter((e) => e && e.ruling === 'defer'),
    corrupt: false,
  };
}

/**
 * Collect the set of identities a hydrated debt ledger's entries resolve
 * under — `topicId` plus any `contentAliases` a later semantic-suppression
 * merge attached. A round-ledger `topicId` matching EITHER counts as
 * captured.
 *
 * @param {object[]} debtEntries - `readDebtLedger().entries` (hydrated)
 * @returns {Set<string>}
 */
export function collectDebtIdentities(debtEntries) {
  const ids = new Set();
  for (const e of debtEntries || []) {
    if (e.topicId) ids.add(e.topicId);
    for (const alias of e.contentAliases || []) ids.add(alias);
  }
  return ids;
}

/**
 * Pure core: which `ruling: 'defer'` entries across a set of already-read
 * round ledgers have no matching identity in the debt ledger.
 *
 * @param {{roundLedgers: ReturnType<typeof readDeferredEntries>[], debtIdentities: Set<string>}} args
 * @returns {{uncaptured: object[], deferredTotal: number, corruptLedgers: {path: string, error: string}[]}}
 */
export function findUncapturedDeferrals({ roundLedgers, debtIdentities }) {
  const uncaptured = [];
  const corruptLedgers = [];
  let deferredTotal = 0;

  for (const rl of roundLedgers) {
    if (rl.corrupt) {
      corruptLedgers.push({ path: rl.path, error: rl.error });
      continue;
    }
    for (const entry of rl.deferred) {
      deferredTotal++;
      if (!debtIdentities.has(entry.topicId)) {
        uncaptured.push({
          ledgerPath: rl.path,
          topicId: entry.topicId,
          semanticHash: entry.semanticHash || null,
          severity: entry.severity || null,
          category: entry.category || null,
          detailSnapshot: (entry.detailSnapshot || '').slice(0, 160),
        });
      }
    }
  }

  return { uncaptured, deferredTotal, corruptLedgers };
}

/**
 * Run the full check as a pure function of its inputs — mirrors
 * `debt-ledger-claim-check.mjs`'s `executeCheck()` shape (pure core, thin
 * process adapter in the CLI). `debtLedgerAvailable: false` while
 * `deferredTotal > 0` is a real finding here (unlike the claims check): if
 * any round ledger has `ruling: 'defer'` entries, `debt-auto-capture.mjs`
 * always creates `tech-debt.json` on a successful run, so its total absence
 * means capture never happened even once.
 *
 * @param {{roundLedgers: ReturnType<typeof readDeferredEntries>[], debtLedgerAvailable: boolean, debtIdentities: Set<string>}} args
 * @returns {{ok: boolean, deferredTotal: number, uncaptured: object[], corruptLedgers: object[], debtLedgerAvailable: boolean}}
 */
export function executeCheck({ roundLedgers, debtLedgerAvailable, debtIdentities }) {
  const { uncaptured, deferredTotal, corruptLedgers } = findUncapturedDeferrals({
    roundLedgers,
    debtIdentities,
  });
  return {
    ok: uncaptured.length === 0 && corruptLedgers.length === 0,
    deferredTotal,
    uncaptured,
    corruptLedgers,
    debtLedgerAvailable,
  };
}
