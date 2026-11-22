/**
 * @fileoverview Manual debt entry (`debt-auto-capture.mjs --add`): project ONE
 * operator-authored finding onto the adjudication-ledger ENTRY shape
 * (`ruling: 'defer'`) that `debt-auto-capture.mjs` already consumes, so it flows
 * through the one existing capture path — same `buildDebtEntry` (secret
 * redaction + sensitivity), same `PersistedDebtEntrySchema` validation, same
 * `persistDebtEntries` local + cloud durable write — and never a second writer.
 *
 * Why it exists: a chip needing to file debt for something no audit surfaced had
 * to fake a finding in a copied round-ledger/result file (2026-11-21).
 *
 * Unlike the auto path, nothing is padded or invented: `ensureRationaleLength`
 * pads a short rationale with dots, which is fine for a machine-generated one
 * and wrong for a human who is the only source of the reason. A missing field
 * is refused, not defaulted.
 *
 * @module scripts/lib/debt-manual-entry
 */
import { createHash } from 'node:crypto';

export const MANUAL_SEVERITIES = ['HIGH', 'MEDIUM', 'LOW'];
export const MANUAL_MIN_RATIONALE = 20;
export const MANUAL_MIN_DETAIL = 10;

/**
 * The topicId is `m`+8 hex of sha256(category|section|detail), NOT lib/findings.mjs's `semanticId`: this is tech-debt-domain code
 * and the findings barrel is not an allowed dependency of that domain (arm-vocabulary-layering). The `m` prefix says so — it does not
 * claim to equal an audit-captured id for the same text — and it is deterministic, so re-adding the same entry updates in place.
 * @param {{severity?: string, category?: string, file?: string, line?: string|number, detail?: string, rationale?: string, principle?: string}} f
 * @returns {{ok: true, entries: object[]} | {ok: false, error: string}}
 */
export function manualTopicId({ category, section, detail }) {
  return `m${createHash('sha256').update(`${category}|${section}|${detail}`.toLowerCase().trim()).digest('hex').slice(0, 8)}`;
}

export function manualToLedgerEntries(f) {
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const severity = text(f.severity).toUpperCase();
  if (!MANUAL_SEVERITIES.includes(severity)) return { ok: false, error: `--severity must be one of ${MANUAL_SEVERITIES.join('|')}, got ${JSON.stringify(f.severity ?? null)}` };
  const category = text(f.category);
  if (!category) return { ok: false, error: '--category is required' };
  const file = text(f.file).replace(/\\/g, '/').replace(/^\.\//, '');
  if (!file) return { ok: false, error: '--file is required (the primary file the debt is about)' };
  const detail = text(f.detail);
  if (detail.length < MANUAL_MIN_DETAIL) return { ok: false, error: `--detail is required (at least ${MANUAL_MIN_DETAIL} characters)` };
  const rationale = text(f.rationale);
  if (rationale.length < MANUAL_MIN_RATIONALE) return { ok: false, error: `--rationale is required (at least ${MANUAL_MIN_RATIONALE} characters naming why this is debt, not a fix now)` };
  const line = f.line == null || f.line === '' ? null : String(f.line).trim();
  if (line !== null && !/^\d+$/.test(line)) return { ok: false, error: `--line must be a positive integer, got ${JSON.stringify(f.line)}` };
  const section = line ? `${file}:${line}` : file;
  const topicId = manualTopicId({ category, section, detail });
  return {
    ok: true,
    entries: [{
      topicId,
      semanticHash: topicId,
      ruling: 'defer',
      severity,
      category,
      section,
      detailSnapshot: detail,
      affectedFiles: [file],
      affectedPrinciples: text(f.principle) ? [text(f.principle)] : [],
      pass: 'manual',
      classification: null,
      rulingRationale: rationale,
    }],
  };
}
