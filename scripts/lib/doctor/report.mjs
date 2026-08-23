/**
 * @fileoverview The section/item report shape, extracted verbatim from
 * `check-setup.mjs`'s inline `Report` class (consumer-friction-doctor plan
 * §6, "extracted from check-setup.mjs:150") so `check-setup.mjs` and the
 * doctor's probe adapters render findings through one class instead of two
 * copies drifting apart (AGENTS.md #1 DRY, #5 single source of truth).
 *
 * Two vocabularies coexist here on purpose:
 *   - `Report`'s own item statuses (`PASS`/`FAIL`/`WARN`/`INFO`/`FIX`) are
 *     unchanged from `check-setup.mjs` — multiple findings per section, each
 *     independently rendered. `check-setup.mjs`'s behaviour must not change.
 *   - The doctor's registry (`scripts/lib/doctor/registry.mjs`) needs exactly
 *     ONE outcome per probe, drawn from the wider §2.3 enum
 *     (`pass|fail|warn|unknown|not_applicable|error`). `reportToProbeOutcome`
 *     is the reduction from the first vocabulary to the second, used by any
 *     probe that wraps a `Report`-producing adapter (the check-setup ones).
 *
 * @module scripts/lib/doctor/report
 */

/** The canonical doctor probe outcome enum (plan §2.3). */
export const PROBE_STATUSES = Object.freeze([
  'pass', 'fail', 'warn', 'unknown', 'not_applicable', 'error',
]);

export class Report {
  constructor() {
    this.sections = [];
    this.failures = 0;
    this.warnings = 0;
  }

  section(title) {
    this.sections.push({ title, items: [] });
    return this;
  }

  _last() { return this.sections.at(-1); }

  pass(label, detail = '') {
    this._last().items.push({ status: 'PASS', label, detail, fix: null });
  }

  fail(label, detail = '', fix = '') {
    this._last().items.push({ status: 'FAIL', label, detail, fix });
    this.failures++;
  }

  warn(label, detail = '', fix = '') {
    this._last().items.push({ status: 'WARN', label, detail, fix });
    this.warnings++;
  }

  info(label, detail = '') {
    this._last().items.push({ status: 'INFO', label, detail, fix: null });
  }

  fix(label, detail = '') {
    this._last().items.push({ status: 'FIX', label, detail, fix: null });
  }
}

/**
 * Reduce an adapter result (`{items, failures, warnings}` — the shape
 * `check-setup.mjs`'s `evaluate*` adapters return, i.e. `Report.sections`
 * ALREADY flattened to a single `items` array) into ONE doctor probe outcome
 * (§2.3 enum). Any FAIL item wins over any WARN, which wins over a clean
 * PASS-only report — the same severity ordering `check-setup.mjs` already
 * uses for its own overall verdict line.
 *
 * Deliberately takes the FLATTENED `{items, failures, warnings}` shape, never
 * a raw `Report` instance — that is the shape every adapter actually returns,
 * and a function that expects `.sections` on that object throws on every
 * call (a producer/consumer shape mismatch this repo has hit before; see
 * AGENTS.md "Contracts across the prose<->code seam").
 *
 * `detail` joins every non-PASS item's `label: detail` so the doctor's single
 * line still names what actually failed/warned, not just the sub-check's
 * section title. `fix` is the first non-empty fix string among the worst-
 * severity items — a probe carries exactly one fix string (D8), so ties are
 * broken by encounter order rather than concatenated into an unreadable blob.
 *
 * @param {{items: Array<{status:string,label:string,detail:string,fix:string|null}>}} result
 *   `failures`/`warnings` counters may also be present (the shape check-setup
 *   adapters return) but are never read here — `items` is the only source of
 *   truth for the outcome (round-2 audit M7).
 * @returns {{status: 'pass'|'fail'|'warn', detail: string, fix: string}}
 */
export function reportToProbeOutcome(result) {
  // Round-2 audit M7: derive the outcome from `items` itself, not the
  // separately-carried `failures`/`warnings` counters — every real adapter
  // keeps both in sync by construction (Report.fail()/.warn() increment the
  // same counter that pushed the item), but a hand-built result object
  // (or a future bug in Report) could pass FAIL items with a stale zero
  // counter and this function would report a false 'pass'.
  const items = result.items ?? [];
  const worstKind = items.some((it) => it.status === 'FAIL') ? 'FAIL'
    : items.some((it) => it.status === 'WARN') ? 'WARN'
      : null;

  if (!worstKind) {
    return { status: 'pass', detail: 'all checks passed', fix: '' };
  }

  const worstItems = items.filter((it) => it.status === worstKind);
  const detail = worstItems
    .map((it) => (it.detail ? `${it.label}: ${it.detail}` : it.label))
    .join('; ');
  const fix = worstItems.find((it) => it.fix)?.fix ?? '';

  return { status: worstKind === 'FAIL' ? 'fail' : 'warn', detail, fix };
}
