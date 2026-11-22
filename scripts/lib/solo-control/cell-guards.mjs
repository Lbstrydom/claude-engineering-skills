/**
 * @fileoverview Pure per-cell guards for `solo-control-audit.mjs run`, extracted
 * from that over-1000-line file (it may not grow). Each is a decision that lived
 * inline in the cell loop where nothing could test it.
 *
 * @module scripts/lib/solo-control/cell-guards
 */
import { budgetVerdict } from './hardening-guards.mjs';

/**
 * The DeepSeek alias-drift pin (plan §2/§8) for ONE cell that got a reply. `deepseek-flash` is an unversioned alias, so the
 * FIRST fingerprint seeds the pin and every later cell is checked against it. A reply with NO fingerprint cannot be checked,
 * so it is refused exactly as a drifted one is — it used to skip the check and was accepted as a measured cell even beside a
 * pin, i.e. "could not verify" read as "verified". Anthropic replies carry no fingerprint by design and are never checked.
 * @param {{recipient: string, pinned: string|null, got: string|null|undefined}} a
 * @returns {{pin: string|null, refuse: null|'drift'|'missing'}}
 */
export function fingerprintVerdict({ recipient, pinned, got }) {
  if (recipient !== 'deepseek') return { pin: pinned ?? null, refuse: null };
  if (!got) return { pin: pinned ?? null, refuse: 'missing' };
  if (!pinned) return { pin: got, refuse: null };
  return { pin: pinned, refuse: got === pinned ? null : 'drift' };
}

/**
 * The budget verdict to take BEFORE a retry: the ledger so far PLUS what the attempt that just came back already cost (it is
 * recorded only when the pass returns, so the ledger alone cannot see it). An unpriced attempt that returned usage makes the
 * verdict `unmeasured` — "unpriced means unmeasured, never zero" — and a call that returned nothing adds nothing.
 * @param {object[]} rows ledger rows
 * @param {number} budgetUsd
 * @param {{input_tokens?: number, output_tokens?: number}|null} usage accumulated usage of the attempts so far
 * @param {string} resolvedModel
 * @param {(usage: object, model: string) => ({priced: boolean, unmeterable?: boolean, totalUsd?: number}|null)} costFn
 * @param {{replyWithoutUsage?: boolean}} [opts] a reply CAME BACK but reported no usage: billable, price unknown → unmeasured
 * @returns {ReturnType<typeof budgetVerdict>}
 */
export function retryBudgetVerdict(rows, budgetUsd, usage, resolvedModel, costFn, { replyWithoutUsage = false } = {}) {
  // A reply that came back reporting NO usage was still billed: represent it as usage-bearing and unpriced (→ unmeasured), never as "nothing came back".
  const noPrice = replyWithoutUsage && !usage; // never handed to costFn: an empty usage could price as $0
  if (noPrice) usage = {};
  const priced = usage && !noPrice ? costFn(usage, resolvedModel) : null;
  const pending = {
    callId: '__pending-retry__', costUsd: priced?.priced && !priced.unmeterable ? priced.totalUsd : null,
    usage, state: usage ? 'ok' : 'provider-error',
  };
  return budgetVerdict([...rows, pending], budgetUsd);
}

/** A reply's usage is MEASURED only when both token counts are present numbers: `{prompt_tokens: 1000}` alone used to read as a
 * complete usage with output 0, so a partial price was recorded as a real one. Anything less is unmeasured (null), never a low price. */
export const usageComplete = (u, inKey, outKey) => !!u && Number.isFinite(u[inKey]) && Number.isFinite(u[outKey]);

/** Must the ledger row for this cell be usage-bearing and unpriced (unmeasured)? True for a budget-stopped reply that reported no
 * usable usage, AND for a reply refused by the fingerprint pin that reported none: the refusal downgrades the cell to
 * `provider-error`, and a provider-error row with null usage is read as "nothing came back" (free) — wrong for a reply that did. */
export const usageUnknownFor = (r, fp) => !!r.replyWithoutUsage || (!!fp?.refuse && !r.providerError && !r.usage);

/** The terminal return of a pass stopped before its retry by the budget gate: the cell is UNMEASURED (never a conformance
 * miss scored against the model), and `usage` keeps whatever the first attempt billed. */
export const budgetStopMiss = (usage, extra = {}) => ({ findings: [], usage, rawText: null, ...extra, providerError: true, budgetStop: true });
