/**
 * @fileoverview Hard spend cap for the decision-eval runner: reserve the
 * WORST-CASE cost of a call before it is made, settle it from MEASURED usage
 * after, refuse any call that could carry spend past the cap.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.2 "Meter", §C6.
 *
 * Why reservation, not a running estimate: pre-flight cost estimates in this
 * repo have run 8x low. A reservation bounds the NEXT call from its own
 * `max_tokens` and input size, so the cap holds whatever the estimate said —
 * unless the price table is wrong, which is why an unpriced model STOPS rather
 * than pricing as zero.
 *
 * USD figures are DERIVED (measured tokens × published price), never billed.
 *
 * @module scripts/lib/model-eval/decision/meter
 */

import { priceFor as defaultPriceFor, costFromUsage as defaultCostFromUsage, PRICING_VERSION } from '../../model-pricing.mjs';

/** Input-size bound for reservation: the UTF-8 BYTE length. A byte-level BPE
 * token covers at least one byte, so bytes ≥ tokens for any input — a strict
 * upper bound, not a heuristic (plan audit R3 H1). Real text runs ~4 bytes per
 * token, so this over-reserves input ~4x; input is the small half of a call. */
export function inputTokenUpperBound(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8');
}

export const INPUT_WRITE_MULTIPLIER = 2;
export const LONG_PROMPT_BOUND = 100_000;
export const LONG_PROMPT_MULTIPLIER = 5;

export class BudgetStop extends Error {
  constructor(message, detail) { super(message); this.name = 'BudgetStop'; this.detail = detail; }
}

export class UnpricedModelError extends Error {
  constructor(model) { super(`model "${model}" has no price row — refusing to spend on an unpriceable call`); this.name = 'UnpricedModelError'; this.model = model; }
}

/**
 * Worst-case USD of one call: `inputTokensMax` (from inputTokenUpperBound) at
 * the input price, and the whole output budget at the output price. The output
 * budget is a provider-enforced hard cap that INCLUDES thinking/reasoning tokens
 * (Anthropic `max_tokens`, OpenAI `max_output_tokens`), so it bounds billing.
 */
export function worstCaseCostUsd({ model, inputTokensMax, maxOutputTokens, priceFor = defaultPriceFor }) {
  const px = priceFor(model);
  if (!px || !Number.isFinite(px.input) || !Number.isFinite(px.output)) throw new UnpricedModelError(model);
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) throw new Error(`meter: a call must carry a finite output cap (got ${maxOutputTokens})`);
  // An undefined / NaN bound would make the reservation NaN, and `spent + NaN > cap`
  // is false — the cap would silently not apply (audit R1 H6/H15).
  if (!Number.isFinite(inputTokensMax) || inputTokensMax < 0) throw new Error(`meter: a call must carry a finite input-size bound (got ${inputTokensMax})`);
  const inTok = inputTokensMax;
  // Fail-closed margins (audit R1 H5/H16, sustained by GPT deliberation): the byte
  // bound already over-reserves ~4x on typical text, but a hard cap must not rest on
  // a typical ratio. Input is priced at the dearest write rate (1-hour cache write,
  // 2x) although no arm sends cache_control, and a request big enough to reach a
  // long-prompt price tier (Haiku 5.5: 5x above 100K tokens — the table carries only
  // the short-prompt row) is reserved wholly at that tier's multiplier.
  const tier = inTok > LONG_PROMPT_BOUND ? LONG_PROMPT_MULTIPLIER : 1;
  return tier * (inTok * px.input * INPUT_WRITE_MULTIPLIER + Math.max(0, maxOutputTokens) * px.output) / 1e6;
}

/**
 * Normalise a provider usage object into the Anthropic shape `costFromUsage`
 * prices. Anthropic usage passes through. OpenAI Responses usage reports
 * `input_tokens` INCLUDING cached tokens (`input_tokens_details.cached_tokens`),
 * so the cached share is split out to be priced at the cached rate.
 * @returns {object|null} null when usage is absent
 */
export function toPricingUsage(usage, provider) {
  if (!usage || typeof usage !== 'object') return null;
  if (provider === 'openai') {
    // A missing / non-numeric billable count is UNKNOWN, not zero: coercing it would
    // price a partial usage object as a measured, cheaper call (audit R1 H4/H18/H21).
    // null ⇒ settle() charges the worst case and stops.
    if (!Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) return null;
    const rawCached = usage.input_tokens_details?.cached_tokens;
    const cached = Number.isFinite(rawCached) ? rawCached : 0; // absent cached share = none cached (provider omits when 0)
    return {
      input_tokens: Math.max(0, usage.input_tokens - cached),
      cache_read_input_tokens: cached,
      output_tokens: usage.output_tokens,
    };
  }
  return usage;
}

/**
 * @param {{ capUsd: number, append?: (row: object) => void, initialSpentUsd?: number,
 *   priceFor?: Function, costFromUsage?: Function, contractEpoch: number }} opts
 */
export function createMeter({ capUsd, append = () => {}, priceFor = defaultPriceFor, costFromUsage = defaultCostFromUsage, contractEpoch, initialSpentUsd = 0 }) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error(`meter: capUsd must be a positive number (got ${capUsd})`);
  if (!Number.isFinite(initialSpentUsd) || initialSpentUsd < 0) throw new Error(`meter: initialSpentUsd must be a non-negative number (got ${initialSpentUsd})`);
  // A budget SCOPE spans runs (rehearsal + variance share one cap): the caller
  // passes what earlier runs in the scope already spent (sumScopeSpend).
  let spentUsd = initialSpentUsd;
  let open = null; // one in-flight reservation at a time — calls are sequential
  let seq = 0;

  return {
    get spentUsd() { return spentUsd; },
    get capUsd() { return capUsd; },
    /** Reserve before a billable call; throws BudgetStop if it could breach the cap. */
    reserve({ label, model, inputTokensMax, maxOutputTokens }) {
      if (open) throw new Error(`meter: reservation "${open.label}" still open — settle or release it first`);
      const worst = worstCaseCostUsd({ model, inputTokensMax, maxOutputTokens, priceFor });
      if (spentUsd + worst > capUsd) {
        throw new BudgetStop(
          `budget stop before "${label}": spent $${spentUsd.toFixed(4)} + worst case $${worst.toFixed(4)} > cap $${capUsd.toFixed(2)}`,
          { spentUsd, worstUsd: worst, capUsd, label },
        );
      }
      // Persisted BEFORE the call (plan audit R3 H2): a crash mid-call leaves an
      // open reservation that sumScopeSpend charges at its worst case.
      const reservationId = ++seq;
      append({ contractEpoch, kind: 'reserve', reservationId, label, model, worstUsd: worst, spentUsd, capUsd });
      open = { label, model, worstUsd: worst, reservationId };
      return worst;
    },
    /**
     * Settle the open reservation from measured usage. Usage missing on a call
     * that returned ⇒ the spend is unknowable ⇒ STOP (charged at worst case so
     * the ledger never under-reports). Returns the derived USD.
     */
    settle({ usage, provider, responseModel, meta = {} }) {
      if (!open) throw new Error('meter: settle() with no open reservation');
      const r = open; open = null;
      const priced = toPricingUsage(usage, provider);
      const model = responseModel || r.model;
      if (!priced) {
        spentUsd += r.worstUsd;
        append({ contractEpoch, kind: 'settle', reservationId: r.reservationId, label: r.label, model, usd: r.worstUsd, usdBasis: 'worst-case (usage missing)', spentUsd, capUsd, pricingVersion: PRICING_VERSION, ...meta });
        throw new BudgetStop(`usage missing for "${r.label}" — spend unknowable; charged worst case and stopped`, { label: r.label });
      }
      const cost = costFromUsage(priced, model);
      if (cost?.unmeterable) {
        spentUsd += r.worstUsd;
        append({ contractEpoch, kind: 'settle', reservationId: r.reservationId, label: r.label, model, usd: r.worstUsd, usdBasis: 'worst-case (usage unmeterable)', spentUsd, capUsd, pricingVersion: PRICING_VERSION, ...meta });
        throw new BudgetStop(`usage for "${r.label}" carries no valid token counts — spend unknowable; charged worst case and stopped`, { label: r.label });
      }
      if (!cost || cost.priced === false || !Number.isFinite(cost.totalUsd)) {
        spentUsd += r.worstUsd;
        append({ contractEpoch, kind: 'settle', reservationId: r.reservationId, label: r.label, model, usd: r.worstUsd, usdBasis: 'worst-case (unpriced response model)', spentUsd, capUsd, pricingVersion: PRICING_VERSION, ...meta });
        throw new UnpricedModelError(model);
      }
      spentUsd += cost.totalUsd;
      append({ contractEpoch, kind: 'settle', reservationId: r.reservationId, label: r.label, model, usd: cost.totalUsd, usdBasis: 'derived (measured tokens × published price)', reservedUsd: r.worstUsd, spentUsd, capUsd, pricingVersion: PRICING_VERSION, ...meta });
      return cost.totalUsd;
    },
    /** A call that never reached the provider (threw before sending) costs nothing. */
    release({ meta = {} } = {}) {
      if (!open) return;
      append({ contractEpoch, kind: 'release', reservationId: open.reservationId, label: open.label, model: open.model, usd: 0, spentUsd, capUsd, ...meta });
      open = null;
    },
    /** A call that failed AFTER sending with no usage: charge the worst case (never under-report). */
    chargeWorstCase({ meta = {} } = {}) {
      if (!open) return 0;
      const r = open; open = null;
      spentUsd += r.worstUsd;
      append({ contractEpoch, kind: 'settle', reservationId: r.reservationId, label: r.label, model: r.model, usd: r.worstUsd, usdBasis: 'worst-case (call failed, usage unknown)', spentUsd, capUsd, pricingVersion: PRICING_VERSION, ...meta });
      return r.worstUsd;
    },
  };
}

/**
 * Spend already recorded under a budget scope: a ledger's `spentUsd` is per-run,
 * so sum each run's settled `usd` rows that carry this scope — PLUS the worst
 * case of every reservation with no settle/release row (a crash mid-call: the
 * request may have been billed, so it stays charged until reconciled by hand).
 * Pure over rows.
 * @param {Array<object>} ledgerRows - every ledger row of every run in the root
 * @param {string} scope
 */
export function sumScopeSpend(ledgerRows, scope) {
  const rows = ledgerRows.filter((r) => r.budgetScope === scope);
  const closed = new Set(rows.filter((r) => (r.kind === 'settle' || r.kind === 'release') && r.reservationId != null).map((r) => `${r.runId}:${r.reservationId}`));
  const settled = rows.filter((r) => r.kind === 'settle' && Number.isFinite(r.usd)).reduce((n, r) => n + r.usd, 0);
  const open = rows.filter((r) => r.kind === 'reserve' && !closed.has(`${r.runId}:${r.reservationId}`)).reduce((n, r) => n + (Number.isFinite(r.worstUsd) ? r.worstUsd : 0), 0);
  return settled + open;
}
