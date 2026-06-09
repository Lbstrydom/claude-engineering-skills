/**
 * @fileoverview Pure presenter for the audit-run findings viewer
 * (docs/plans/dashboard-audit-run-viewer.md §7.0, M7). Maps a domain
 * `AuditRunFinding` (from store/runs-findings.mjs — raw DB columns mapped to
 * domain fields, NO presentation tokens) into a `PresentedFinding` carrying
 * closed-enum UI tokens. The section consumes presenter output and never
 * derives CSS classes or `data-*` values from raw DB strings — that keeps
 * the only attribute-injection surface closed (every token is from a fixed
 * set; arbitrary text like `file`/`detail` is escaped in the section, never
 * placed in an attribute).
 *
 * No I/O → directly unit-testable.
 *
 * @module scripts/lib/dashboard/audit-run-presenter
 */

// severity (DB CHECK enum HIGH/MEDIUM/LOW) → band class + data-severity token.
const SEV_MAP = {
  HIGH:   { sevClass: 'sev-high', sevToken: 'HIGH' },
  MEDIUM: { sevClass: 'sev-med',  sevToken: 'MEDIUM' },
  LOW:    { sevClass: 'sev-low',  sevToken: 'LOW' },
};

// data-pass closed set (plan §3) — anything else buckets to 'other'.
const PASS_TOKENS = new Set(['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix']);

// statusToken precedence (plan §7.0 M3): remediation_state wins when present
// (it is the later lifecycle state), else adjudication_outcome, else 'none'.
const REMEDIATION_TOKENS = new Set(['fixed', 'verified', 'regressed', 'pending']);
const ADJUDICATION_TOKENS = new Set(['accepted', 'dismissed', 'severity_adjusted']);

const STATUS_LABELS = {
  accepted: 'Accepted',
  dismissed: 'Dismissed',
  severity_adjusted: 'Severity adjusted',
  pending: 'Pending',
  fixed: 'Fixed',
  verified: 'Verified',
  regressed: 'Regressed',
  none: '—',
};

/** Resolve the closed statusToken from the two optional adjudication columns. */
export function resolveStatusToken(finding) {
  const r = String(finding.remediation ?? '').toLowerCase();
  if (REMEDIATION_TOKENS.has(r)) return r;
  const a = String(finding.adjudication ?? '').toLowerCase();
  if (ADJUDICATION_TOKENS.has(a)) return a;
  return 'none';
}

/**
 * Map one domain finding → a presented finding (closed UI tokens + the raw
 * text fields the section will escape).
 *
 * @param {object} f domain AuditRunFinding
 * @returns {object} PresentedFinding
 */
export function presentFinding(f) {
  const sev = SEV_MAP[f.severity] || { sevClass: 'sev-low', sevToken: 'LOW' };
  // Defensive: the DB CHECK guarantees HIGH/MEDIUM/LOW, but if an unknown
  // value ever slips through, fall back to the grey band and show the raw
  // (uppercased) label rather than crashing or mislabelling (plan §8).
  const known = Object.prototype.hasOwnProperty.call(SEV_MAP, f.severity);
  const sevLabel = known ? f.severity : String(f.severity ?? 'LOW').toUpperCase();

  const rawPass = String(f.pass ?? '').toLowerCase();
  const passToken = PASS_TOKENS.has(rawPass) ? rawPass : 'other';
  const passLabel = f.pass != null && String(f.pass).trim() ? String(f.pass) : 'other';

  const statusToken = resolveStatusToken(f);

  const fileLabel = f.file != null && String(f.file).trim() ? String(f.file) : 'No file';

  return {
    id: f.id,
    fingerprint: f.fingerprint,
    category: f.category ?? '',
    detail: f.detail ?? '',
    round: f.round ?? null,
    file: f.file ?? null,
    sevClass: sev.sevClass,
    sevToken: sev.sevToken,
    sevLabel,
    passToken,
    passLabel,
    statusToken,
    statusLabel: STATUS_LABELS[statusToken] || '—',
    fileLabel,
  };
}

/** Map an array of domain findings → presented findings (order preserved). */
export function presentFindings(findings) {
  return (findings || []).map(presentFinding);
}
