/**
 * @fileoverview Ship-train impact tiers — which ship-ready PRs make a train due.
 *
 * Pure. The caller supplies the PR's change list (parsed from
 * `git diff --name-status -z -M`), the sync closure (`getSyncClosure()`), and
 * optionally a code predicate; nothing here touches git, the store or the
 * filesystem. Plan: docs/plans/ship-trains.md §2.5–§2.6.
 *
 * Three tiers, decided in order, first match wins:
 *   1. `urgent`     — some changed path is in the sync closure: it reaches
 *                     consumers. The closure already contains the synced store,
 *                     db, migration and security libs, so "changes behaviour,
 *                     security or the store FOR CONSUMERS" is the same single
 *                     oracle — no second hand-kept list.
 *   2. `standard`   — otherwise, some changed path is code (or a file kind the
 *                     taxonomy cannot place) outside `tests/`: repo-internal
 *                     behaviour such as `scripts/sync-to-repos.mjs`.
 *   3. `ride-along` — otherwise: tests, docs and config only. Never a train of
 *                     its own; it rides the next real one.
 *
 * "Changed path" is the union of every destination AND every rename/copy
 * source. `--name-only` reports only the destination, so a file renamed OUT of
 * the closure would lose the consumer-visible path it removed (round-1 M2).
 *
 * @module scripts/lib/ship-train/impact
 */

import { matchFileKind } from '../file-taxonomy.mjs';

export const TIERS = Object.freeze(['urgent', 'standard', 'ride-along']);

/** A train is due at this many ship-ready PRs (with ≥1 non-ride-along). */
export const DUE_PR_COUNT = 3;

/**
 * Parse `git diff --name-status -z [-M] [-C]` output.
 *
 * The `-z` form is NUL-separated with no quoting, so a path may contain spaces
 * or newlines and still parse exactly. Records are `STATUS\0path\0` or, for a
 * rename/copy, `R<score>\0old\0new\0` / `C<score>\0old\0new\0`.
 *
 * @param {string|Buffer} raw
 * @returns {Array<{status: string, path: string, oldPath?: string}>}
 * @throws {Error} on a truncated record — a short list must never pass for a complete one
 */
export function parseNameStatusZ(raw) {
  const text = String(raw ?? '');
  if (text === '') return [];
  // `-z` output terminates EVERY field with NUL, the last one included. A
  // missing final terminator is a truncated record, not a short path (code R1 H4).
  if (!text.endsWith('\0')) throw new Error('parseNameStatusZ: output does not end with a NUL terminator — truncated');
  const fields = text.slice(0, -1).split('\0');
  const out = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i++];
    if (!/^[A-Z][0-9]*$/.test(status)) {
      throw new Error(`parseNameStatusZ: expected a status letter at field ${i - 1}, got ${JSON.stringify(status)}`);
    }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      if (i + 1 >= fields.length) throw new Error(`parseNameStatusZ: truncated ${status} record at field ${i - 1}`);
      const oldPath = fields[i++];
      const path = fields[i++];
      out.push({ status: letter, path, oldPath });
    } else {
      if (i >= fields.length) throw new Error(`parseNameStatusZ: truncated ${status} record at field ${i - 1}`);
      out.push({ status: letter, path: fields[i++] });
    }
  }
  return out;
}

/**
 * Every path a change list touches: destinations plus rename/copy sources,
 * de-duplicated, forward-slashed.
 *
 * @param {Array<{path: string, oldPath?: string}>} changes
 * @returns {string[]}
 */
export function changedPaths(changes) {
  const set = new Set();
  for (const c of changes ?? []) {
    if (c?.path) set.add(String(c.path).replace(/\\/g, '/'));
    if (c?.oldPath) set.add(String(c.oldPath).replace(/\\/g, '/'));
  }
  return [...set];
}

/**
 * Default code predicate. `uncovered` (a kind the taxonomy cannot place, e.g.
 * an extensionless `.githooks/pre-push`) counts as code: the conservative
 * direction, because calling a behaviour change a ride-along would let it wait
 * for an unrelated train.
 *
 * @param {string} p
 * @returns {boolean}
 */
export function isCodePath(p) {
  const { kind } = matchFileKind(p);
  return kind === 'source' || kind === 'uncovered';
}

const isTestPath = (p) => p === 'tests' || p.startsWith('tests/');

/**
 * Classify one PR's impact.
 *
 * @param {object} input
 * @param {Array<{status: string, path: string, oldPath?: string}>} input.changes
 * @param {Set<string>} input.closure — forward-slashed source-relative paths the sync ships
 * @param {(p: string) => boolean} [input.isCode]
 * @returns {{tier: 'urgent'|'standard'|'ride-along', reasons: string[], closurePaths: string[], codePaths: string[]}}
 */
export function classifyPrImpact({ changes, closure, isCode = isCodePath }) {
  if (!(closure instanceof Set)) throw new TypeError('classifyPrImpact: closure must be a Set');
  const paths = changedPaths(changes);
  if (paths.length === 0) {
    return { tier: 'ride-along', reasons: ['no-files'], closurePaths: [], codePaths: [] };
  }
  const closurePaths = paths.filter((p) => closure.has(p)).sort();
  const codePaths = paths.filter((p) => !isTestPath(p) && isCode(p)).sort();
  if (closurePaths.length > 0) {
    return { tier: 'urgent', reasons: [`reaches-consumers:${closurePaths.length}`], closurePaths, codePaths };
  }
  if (codePaths.length > 0) {
    return { tier: 'standard', reasons: [`repo-internal-code:${codePaths.length}`], closurePaths, codePaths };
  }
  return { tier: 'ride-along', reasons: ['tests-docs-config-only'], closurePaths, codePaths };
}

/**
 * Is a train due for this set of ship-ready PRs?
 *
 * due ⇔ at least one non-ride-along PR AND (any urgent PR OR ≥ DUE_PR_COUNT
 * ship-ready PRs in total OR end of day). A ride-along-only set is never due —
 * not even at end of day — which reconciles "three or more ship-ready PRs" with
 * "ride-alongs are never a train of their own" (plan §2.6).
 *
 * @param {object} input
 * @param {Array<{tier: string}>} input.prs
 * @param {boolean} [input.endOfDay]
 * @returns {{due: boolean, triggers: string[], missing: string[]}}
 */
export function isTrainDue({ prs, endOfDay = false }) {
  const list = prs ?? [];
  const urgent = list.filter((p) => p.tier === 'urgent').length;
  const nonRide = list.filter((p) => p.tier !== 'ride-along').length;
  if (nonRide === 0) {
    return {
      due: false,
      triggers: [],
      missing: [list.length === 0 ? 'no ship-ready PRs' : `only ride-alongs (${list.length}) — they wait for the next train with a non-ride-along PR`],
    };
  }
  const triggers = [];
  if (urgent > 0) triggers.push(`urgent:${urgent}`);
  if (list.length >= DUE_PR_COUNT) triggers.push(`count:${list.length}`);
  if (endOfDay) triggers.push('end-of-day');
  if (triggers.length > 0) return { due: true, triggers, missing: [] };
  return {
    due: false,
    triggers: [],
    missing: [`no urgent PR, ${list.length} < ${DUE_PR_COUNT} ship-ready PRs, not end of day — re-run as /ship --train --end-of-day to call it anyway`],
  };
}
