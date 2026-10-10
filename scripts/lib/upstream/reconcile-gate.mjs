/**
 * @fileoverview The `upstream reconcile --gate` decision: which ledger-vs-store
 * divergences THIS PUSH is responsible for.
 *
 * WHY THIS EXISTS (2026-10-10, measured twice in one day). `upstream fix` writes
 * a disposition entry into the closer's working tree, then transitions the store
 * row. The gate compared the pushed commit's ledger with the LIVE store and
 * blocked on any difference. So the moment anybody closed a report, every push
 * from every session failed until that one JSON entry landed on main. Three
 * sessions were blocked, one used three pre-push attempts, and both fixes were
 * hand-made one-file PRs (#180, #183).
 *
 * THE LEVEL RULE. A gate's level follows the KIND of state it reads. The pushed
 * commit's ledger is repo state and may block. A store row someone ELSE just
 * transitioned is shared live state. Blocking an unrelated commit on it fixes
 * nothing: that commit can neither land another checkout's uncommitted file
 * nor, without breaking scope discipline, carry a regenerated copy of it. So a
 * divergence BLOCKS only when the pushed range changed that issue's ledger entry
 * (added, removed or edited it). Everything else is REPORTED, on every run, with
 * its cause and remedy. The same drift-only shape is used by `plans:status --drift`
 * (pre-existing lines are "not gating this push").
 *
 * FAIL CLOSED. Attribution needs BOTH ledgers readable: the base, via the ONE
 * range oracle `push-range.mjs`, and the head. Any other state blocks every
 * divergence, as the gate always did, and says why. A malformed head ledger
 * blocks even with no per-id divergence, so a corrupt file can never read as a
 * clean empty one.
 *
 * Plan: docs/plans/upstream-disposition-landing.md.
 *
 * @module scripts/lib/upstream/reconcile-gate
 */

import { execFileSync } from 'node:child_process';

import { resolvePushRange, describePushRange } from '../push-range.mjs';
import { readLedgerEntriesAtRef, DISPOSITION_LEDGER_PATH } from './disposition-ledger.mjs';

/** Ledger evidence statuses under which a per-id comparison is meaningful. */
const ATTRIBUTABLE = new Set(['read', 'absent']);

/**
 * The ledger at the pushed range's BASE. The range comes from `resolvePushRange`,
 * never from a local inference (AGENTS.md "one range, one resolver"). In the
 * pre-push sandbox that is the hook's explicit base: the remote branch tip, or the
 * merge-base with origin/main for a new branch.
 *
 * @returns {{status: 'read'|'absent'|'unresolved'|'unreadable'|'malformed',
 *   entries: object[]|null, reason: string|null, range: string|null}}
 */
export function readRangeBaseLedger({ repoRoot = process.cwd(), env = process.env } = {}) {
  const run = (args) => {
    try {
      return execFileSync('git', args, {
        cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      return null;
    }
  };
  const range = resolvePushRange({ env, run });
  if (!range.ok) return { status: 'unresolved', entries: null, reason: range.message, range: null };
  return { ...readLedgerEntriesAtRef({ ref: range.base, repoRoot }), range: describePushRange(range) };
}

/** Canonical bytes of one entry, so key order can never fake a change. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Issue ids whose entry the range added, removed or changed in ANY field. A
 * `recordedAt`-only rewrite counts as a change. That is the conservative
 * direction: it can only make more divergence blocking, never less. PURE.
 *
 * @param {{baseEntries: object[], headEntries: object[]}} args
 * @returns {Set<string>}
 */
export function changedLedgerIds({ baseEntries = [], headEntries = [] }) {
  const index = (entries) => {
    const m = new Map();
    for (const e of entries) if (e?.issueId) m.set(e.issueId, canonical(e));
    return m;
  };
  const base = index(baseEntries);
  const head = index(headEntries);
  const changed = new Set();
  for (const [id, bytes] of head) if (base.get(id) !== bytes) changed.add(id);
  for (const id of base.keys()) if (!head.has(id)) changed.add(id);
  return changed;
}

/**
 * Flatten a reconciliation into id-bearing divergence items. Foreign-store
 * entries are NOT divergence (they are scope) and stay out, exactly as before.
 */
function divergenceItems(r) {
  const items = [];
  for (const id of r.missingFromLedger ?? []) items.push({ category: 'missing', issueId: id, detail: null });
  for (const id of r.ledgerOnly ?? []) items.push({ category: 'ledgerOnly', issueId: id, detail: null });
  // Records, never the prose lists: each carries its own id (code-audit R1 M2). A
  // reconciliation without `mismatches` but with prose mismatches cannot be
  // attributed, so each prose line becomes an id-less item, which blocks.
  if (Array.isArray(r.mismatches)) {
    for (const m of r.mismatches) {
      items.push({ category: m.kind === 'state' ? 'stateMismatch' : 'dispositionMismatch', issueId: m.issueId ?? null, detail: m.detail });
    }
  } else {
    for (const detail of r.stateMismatch ?? []) items.push({ category: 'stateMismatch', issueId: null, detail });
    for (const detail of r.dispositionMismatch ?? []) items.push({ category: 'dispositionMismatch', issueId: null, detail });
  }
  for (const id of r.needsReview ?? []) items.push({ category: 'needsReview', issueId: id, detail: null });
  return items;
}

/**
 * The gate decision. PURE: every input is plain data.
 *
 * @param {object} args
 * @param {object} args.reconciliation  `computeLedgerReconciliation`'s result
 * @param {{status: string, entries: object[]|null, reason?: string|null}} args.head  working-tree (= pushed) ledger
 * @param {{status: string, entries: object[]|null, reason?: string|null, range?: string|null}} args.base
 * @returns {{attributable: boolean, why: string|null, range: string|null,
 *   blocking: object[], preExisting: object[]}}
 */
export function decideReconcileGate({ reconciliation, head, base }) {
  const range = base?.range ?? null;
  const integrity = [];
  if (head?.status === 'malformed' || head?.status === 'unreadable') {
    integrity.push({
      category: 'ledger-unreadable', issueId: null,
      detail: `${DISPOSITION_LEDGER_PATH} on this commit is ${head.status}${head.reason ? ` (${head.reason})` : ''}`,
    });
  }
  const items = divergenceItems(reconciliation ?? {});

  let why = null;
  if (!ATTRIBUTABLE.has(head?.status)) why = `the ledger on this commit is ${head?.status ?? 'unknown'}`;
  else if (!ATTRIBUTABLE.has(base?.status)) {
    why = `the ledger at the push base is ${base?.status ?? 'unknown'}${base?.reason ? ` (${base.reason})` : ''}`;
  }
  if (why) return { attributable: false, why, range, blocking: [...integrity, ...items], preExisting: [] };

  const changed = changedLedgerIds({ baseEntries: base.entries ?? [], headEntries: head.entries ?? [] });
  const blocking = [];
  const preExisting = [];
  for (const item of items) {
    // An item with no id cannot be attributed to anything, so it blocks.
    (item.issueId === null || changed.has(item.issueId) ? blocking : preExisting).push(item);
  }
  return { attributable: true, why: null, range, blocking, preExisting };
}

const LABEL = Object.freeze({
  missing: 'terminal db row with no ledger entry',
  ledgerOnly: 'ledger entry with no matching terminal db row',
  stateMismatch: 'state mismatch',
  dispositionMismatch: 'disposition mismatch',
  needsReview: 'row still carries the migration catch-all sentinel',
  'ledger-unreadable': 'ledger malformed',
});

// Terminal states are final (`LEGAL_TRANSITIONS`: fixed/wont_fix -> nothing), so no
// `upstream fix` can replace a terminal row's disposition (code-audit R1 M3).
const SENTINEL_REMEDY = 'A terminal row cannot be re-closed, so its disposition is corrected by a reviewed '
  + 'store migration (see scripts/backfill-upstream-dispositions.mjs), then the ledger entry to match';

const closedPhrase = (id, rowsById) => {
  const row = rowsById.get(id);
  return row ? `closed (${row.state}) at ${row.closedAt ?? 'an unknown time'}` : 'terminal';
};

/** Why THIS push is responsible for an item: the line a blocked operator acts on. */
function blockingSentence(item, rowsById, attributable) {
  const head = `${LABEL[item.category]}: ${item.issueId ?? item.detail}`;
  if (item.category === 'ledger-unreadable') return `${head}. Fix the JSON. A broken ledger is never read as an empty one`;
  if (!attributable) return item.detail ? `${LABEL[item.category]}: ${item.detail}` : head;
  switch (item.category) {
    case 'missing':
      return `${head}. This push removes its disposition entry, but the store row is ${closedPhrase(item.issueId, rowsById)}. Restore the entry`;
    case 'ledgerOnly':
      return `${head}. This push adds or edits an entry with no terminal store row. Was the store transition lost after the ledger write, or the id mistyped? If the row is still open, re-run the upstream fix/wont-fix; otherwise drop the entry`;
    case 'needsReview':
      return `${head}. This push changed its entry, but the store row still carries the catch-all sentinel. ${SENTINEL_REMEDY}`;
    default:
      return `${LABEL[item.category]}: ${item.detail}. This push changed this entry; make it agree with the store`;
  }
}

/** Why an item is NOT this push's doing, and who can fix it. */
function preExistingSentence(item, rowsById, presentUpstream) {
  const id = item.issueId;
  switch (item.category) {
    case 'missing':
      if (presentUpstream.has(id)) {
        return `${id}: its disposition entry has already landed upstream. This branch predates it, so rebasing clears this`;
      }
      return `${id}: store row ${closedPhrase(id, rowsById)}, but its disposition entry has never been committed here. `
        + 'A closure (upstream fix/wont-fix) whose ledger entry was never landed. Land '
        + `${DISPOSITION_LEDGER_PATH} from the checkout that closed it, or regenerate it anywhere with `
        + '`npm run upstream:reconcile -- --apply` and land that one file in its own PR';
    case 'ledgerOnly':
      return `${id}: a ledger entry (unchanged by this push) has no terminal store row. The row was reopened, a store write `
        + `was lost, or it belongs to an unstamped other store. Inspect: node scripts/cross-skill.mjs upstream history --id ${id} --worksheet`;
    case 'needsReview':
      return `${id}: the store row still carries the migration catch-all sentinel. ${SENTINEL_REMEDY}`;
    default:
      return `${LABEL[item.category]}: ${item.detail}. The ledger entry and the store row disagree, and fixed/wont_fix are `
        + `final, so re-closing cannot fix it. Make the entry agree with the store row (inspect: node scripts/cross-skill.mjs `
        + `upstream history --id ${id} --worksheet) and land that one-file change`;
  }
}

/**
 * The CommandError message for a blocked gate. It IS the failure text, so the
 * cause cannot be swallowed by a throw that skips a sibling render (plan §2.2,
 * Gemini R1 G1).
 */
export function renderBlockingMessage(decision, { rows = [] } = {}) {
  const rowsById = new Map(rows.map((r) => [r.issueId, r]));
  const lines = decision.blocking.map((i) => blockingSentence(i, rowsById, decision.attributable));
  const n = decision.blocking.length;
  const head = decision.attributable
    ? `${n} divergence(s) attributable to this push (${decision.range})`
    : `could not attribute divergence to the pushed range, because ${decision.why}. Failing closed on all ${n}`;
  return `${head}: ${lines.join(' | ')}`;
}

/** Stderr lines for divergence this push did not cause. Empty when there is none. */
export function renderPreExistingLines(decision, { rows = [], presentUpstream = [] } = {}) {
  if (!decision.preExisting.length) return [];
  const rowsById = new Map(rows.map((r) => [r.issueId, r]));
  const upstream = new Set(presentUpstream);
  const tag = '  [upstream reconcile --gate]';
  return [
    `${tag} ${decision.preExisting.length} divergence(s) NOT caused by this push. Their ledger entries are unchanged in `
      + `${decision.range}. Reported, not blocking:`,
    ...decision.preExisting.map((i) => `${tag}   - ${preExistingSentence(i, rowsById, upstream)}`),
  ];
}
