/**
 * @fileoverview Final-review credit loop — the PURE half.
 *
 * Two functions, no I/O: classify a final-review finding's outcome from its two
 * persisted axes, and render the `/ship` advisory card from a reader result.
 *
 * **Why this exists.** `adjudicateFinalReviewFinding` (the adjudication axis) and
 * `recordFinalReviewFix` (the remediation axis) have been built, tested and
 * CLI-exposed since the shadow A/B closed — and **nothing ever called them**. No
 * SKILL.md referenced either, so `user_action` stayed null, credit landed only in
 * source comments, and the resulting tail read as noise until a manual sweep
 * recovered it (2026-07-28). The gap was never the writers; it was that no
 * workflow prompted for them. This module is the nudge's brain.
 *
 * **Nudge, never a gate** — same posture as the quick-fix hook and the skill
 * recommender. Nothing here can fail a ship: the renderer's worst case is an
 * empty string.
 *
 * Plan: docs/plans/final-review-credit-and-cheap-shadow.md §2 (Cluster A).
 *
 * @module scripts/lib/final-review-credit
 */

/**
 * Every `user_action` the `audit_findings_user_action_check` constraint permits
 * (migration 20260722120000 widened it once, adding `auto_dismissed` — which is
 * exactly why rule 1 below exists).
 */
export const KNOWN_USER_ACTIONS = Object.freeze([
  'fix-now', 'deferred', 'dismissed', 'needs_triage', 'accepted-permanent', 'auto_dismissed',
]);

/**
 * Remediation states meaning "a fix landed". A strict SUBSET of the store's
 * `TERMINAL_REMEDIATION` (`fixed`/`verified`/`regressed`) — `regressed` is
 * terminal but emphatically NOT fixed, and collapsing them would let a
 * re-opened defect read as closed.
 */
const FIXED_STATES = Object.freeze(['fixed', 'verified']);

/**
 * The closed diagnostic set for a `state:'unavailable'` result. Exported so the
 * reader (which maps every caught failure onto one of these) and the renderer
 * (which refuses anything else) share ONE definition — a second copy would be
 * free to drift, and the whole point is that no free-form text reaches stdout.
 */
export const DIAGNOSTIC_CODES = Object.freeze([
  'CLOUD_UNREACHABLE', 'AUTH_FAILED', 'NOT_MIGRATED', 'MALFORMED_RESPONSE', 'UNKNOWN',
]);

/** Classifications that want the operator's attention on a ship. */
export const ACTIONABLE = Object.freeze([
  'unadjudicated', 'fixed-unlabelled', 'accepted-unfixed', 'regressed',
  'integrity-warning', 'unknown',
]);

/**
 * Classify one finding's outcome from its two persisted axes.
 *
 * **ORDERED rules, first match wins.** An earlier draft of the plan presented an
 * unordered table whose rows genuinely overlapped — `any|regressed` collided with
 * `dismissed|any`, `deferred|any` and `unrecognised|any`, so `dismissed +
 * regressed` matched two rows and the mapping was not a function (audit R3-H1).
 * Precedence is the fix, and contradictory pairs get their own surfaced outcome
 * rather than an arbitrary winner.
 *
 * Total over `user_action ∈ {null} ∪ KNOWN_USER_ACTIONS ∪ {unrecognised}` ×
 * `remediation_state ∈ {null, fixed, verified, regressed, unrecognised}`;
 * `tests/final-review-pending.test.mjs` enumerates that whole product.
 *
 * @param {{user_action?: string|null, remediation_state?: string|null}} row
 * @returns {'unknown'|'integrity-warning'|'regressed'|'closed'|'deferred'|'fixed-unlabelled'|'unadjudicated'|'accepted-unfixed'}
 */
export function classifyFinalReviewOutcome(row = {}) {
  const ua = row.user_action ?? null;
  const rs = row.remediation_state ?? null;

  // 1 — an action outside the CHECK set must degrade LOUDLY. The constraint has
  // been widened before; a future value must never silently read as closed.
  if (ua !== null && !KNOWN_USER_ACTIONS.includes(ua)) return 'unknown';

  const isFixed = FIXED_STATES.includes(rs);
  const closedByAction = ua === 'dismissed' || ua === 'auto_dismissed';

  // 2 — contradiction: something judged a non-issue, or deliberately deferred,
  // cannot have regressed. Surfaced for manual reconciliation, never resolved
  // silently in either direction.
  if (rs === 'regressed' && (closedByAction || ua === 'deferred')) return 'integrity-warning';
  // 3 — a genuine re-opened defect.
  if (rs === 'regressed') return 'regressed';
  // 4/5 — terminal by decision.
  if (closedByAction) return 'closed';
  if (ua === 'deferred') return 'deferred';
  // 6/7 — not yet decided. `needs_triage` is treated as undecided; paired with a
  // shipped fix the fix is the stronger signal, so it lands on fixed-unlabelled.
  if (ua === null || ua === 'needs_triage') return isFixed ? 'fixed-unlabelled' : 'unadjudicated';
  // 8/9 — accepted (`fix-now` or `accepted-permanent`).
  return isFixed ? 'closed' : 'accepted-unfixed';
}

/** Is this classification worth showing on a ship? */
export function isActionable(classification) {
  return ACTIONABLE.includes(classification);
}

/**
 * Sum classifications into the reader's `counts` shape. Fed the AGGREGATE
 * `(user_action, remediation_state, n)` groups — never the bounded page — so the
 * totals are exact regardless of `pageSize`.
 *
 * @param {Array<{user_action?: string|null, remediation_state?: string|null, n?: number|string}>} groups
 * @returns {{unadjudicated: number, fixedUnlabelled: number, acceptedUnfixed: number, regressed: number, integrityWarning: number, unknown: number, totalActionable: number}}
 */
export function summariseCounts(groups) {
  const counts = {
    unadjudicated: 0, fixedUnlabelled: 0, acceptedUnfixed: 0,
    regressed: 0, integrityWarning: 0, unknown: 0, totalActionable: 0,
  };
  const key = {
    'unadjudicated': 'unadjudicated', 'fixed-unlabelled': 'fixedUnlabelled',
    'accepted-unfixed': 'acceptedUnfixed', 'regressed': 'regressed',
    'integrity-warning': 'integrityWarning', 'unknown': 'unknown',
  };
  for (const g of (groups || [])) {
    // COUNT(*) comes back from pg as a STRING — Number() it, or every total
    // silently concatenates instead of adding.
    const n = Number(g?.n ?? 0);
    if (!Number.isFinite(n) || n <= 0) continue;
    const cls = classifyFinalReviewOutcome(g);
    if (!isActionable(cls)) continue;
    counts[key[cls]] += n;
    counts.totalActionable += n;
  }
  return counts;
}

/** Severity rank for the deterministic order (HIGH first). */
const SEVERITY_RANK = { HIGH: 0, MEDIUM: 1, LOW: 2 };

/**
 * Deterministic total order: severity, then newest first, then fingerprint as
 * the tiebreak — so two runs over unchanged data render byte-identically.
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function orderItems(items) {
  return [...(items || [])].sort((a, b) => {
    const sa = SEVERITY_RANK[a?.severity] ?? 3, sb = SEVERITY_RANK[b?.severity] ?? 3;
    if (sa !== sb) return sa - sb;
    const ta = String(a?.created_at ?? ''), tb = String(b?.created_at ?? '');
    if (ta !== tb) return ta < tb ? 1 : -1; // DESC
    return String(a?.finding_fingerprint ?? '').localeCompare(String(b?.finding_fingerprint ?? ''));
  });
}

const CLI = 'node scripts/cross-skill.mjs';

/**
 * Build the adjudicate command for one item. `--bucket shadow-only` is ALWAYS
 * explicit: this queue is shadow-only by construction, and stating it means the
 * store's ambiguous-bucket refusal can never fire if the same fingerprint later
 * also appears as a primary finding.
 */
function adjudicateCmd(it, action) {
  return `${CLI} final-review-adjudicate --run-id ${it.run_id} --fingerprint ${it.finding_fingerprint} --action ${action} --bucket shadow-only`;
}

function recordFixCmd(it, state, commitSha) {
  return `${CLI} final-review-record-fix --run-id ${it.run_id} --fingerprint ${it.finding_fingerprint} --bucket shadow-only --commit ${commitSha} --state ${state}`;
}

/**
 * Render the `/ship` advisory card.
 *
 * Every command is emitted COMPLETE, with resolved values — no ellipsis and no
 * `<angle-brackets>`. That is a repo-wide operator-doc rule (PowerShell reserves
 * `<`, making such a line unpasteable), and the plan's own first draft broke it,
 * which is why the card test asserts it mechanically.
 *
 * Returns `''` whenever there is nothing to say — `disabled`, a zero-count
 * `ready`, or an unrecognised shape. **The empty string is the safe default**:
 * this text is printed by a ship that must never fail because a label is
 * missing.
 *
 * @param {object} result - a `final-review-pending` result
 * @param {{commitSha?: string|null}} [opts] - resolved AFTER the commit succeeds
 * @returns {string}
 */
export function renderFinalReviewCard(result, { commitSha = null } = {}) {
  if (!result || typeof result !== 'object') return '';
  if (result.state === 'disabled') return '';
  if (result.state === 'unavailable') {
    // One non-blocking line, and the code is VALIDATED against the closed set
    // rather than interpolated (code-audit R2-M5). The reader only ever emits
    // these literals, but this is an exported pure function: interpolating
    // `result.diagnostic` raw meant an unexpected caller could put anything —
    // including an err.message carrying a DSN — straight into stdout, while the
    // test that claimed to cover "the last line of defence" only ever put
    // secrets in NEIGHBOURING fields. Anything unrecognised collapses to
    // UNKNOWN, so the leak is closed by construction, not by convention.
    const code = DIAGNOSTIC_CODES.includes(result.diagnostic) ? result.diagnostic : 'UNKNOWN';
    return `⚠ final-review credit check unavailable (${code}) — ship continues; no labels recorded.`;
  }
  if (result.state !== 'ready') return '';

  // A MALFORMED `ready` must not read as a healthy empty queue (code-audit
  // R1-M6). An earlier version returned '' for `{state:'ready'}` with no
  // counts/items, so a reader/schema regression — the one failure that would
  // silently stop the whole credit loop surfacing anything — was indistinguishable
  // from "nothing pending". That is precisely the anti-green class AGENTS.md
  // says to be adversarial about: ask whether a path can return clean without
  // having checked anything. Silence is now reserved for a WELL-FORMED empty
  // result; a broken shape gets the same non-blocking warning shape as
  // `unavailable`, so the ship still cannot fail.
  // Validated against the CANONICAL envelope, not a loose subset (R2-M4): the
  // reader declares a `schemaVersion`, so accepting a payload without one would
  // codify a malformed response as healthy — the exact thing this check exists
  // to prevent, one level up.
  const counts = result.counts;
  const shapeOk = result.schemaVersion === 1
    && counts && typeof counts === 'object'
    && typeof counts.totalActionable === 'number' && Number.isFinite(counts.totalActionable)
    && Array.isArray(result.items);
  if (!shapeOk) {
    return '⚠ final-review credit check returned a malformed result (MALFORMED_READY) — ship continues; the pending queue was NOT surfaced.';
  }
  const total = counts.totalActionable;
  if (total <= 0) return '';

  const items = orderItems(result.items);
  const sha = commitSha || null;
  const out = [
    '⚠ FINAL-REVIEW CREDIT (non-blocking)',
    `  ${total} shadow finding(s) await credit: ${counts.unadjudicated || 0} unadjudicated · ${counts.fixedUnlabelled || 0} fixed-but-unlabelled · ${counts.acceptedUnfixed || 0} accepted-unfixed · ${counts.regressed || 0} regressed`,
    '  Recording these is what makes the second gate measurable — an unlabelled fix reads as noise.',
    '',
  ];

  for (const it of items) {
    const cls = it.classification || classifyFinalReviewOutcome(it);
    const head = `  • [${it.severity || '?'}] ${it.primary_file || '(no file)'} — ${cls}`;
    if (cls === 'unknown') {
      out.push(`${head}: unrecognised user_action ${JSON.stringify(it.user_action ?? null)} — reconcile by hand.`);
      continue;
    }
    if (cls === 'integrity-warning') {
      out.push(`${head}: user_action=${JSON.stringify(it.user_action ?? null)} with remediation_state=${JSON.stringify(it.remediation_state ?? null)} — contradictory; reconcile by hand.`);
      continue;
    }
    out.push(head);
    if (cls === 'unadjudicated') {
      out.push(`      ${adjudicateCmd(it, 'accepted')}`);
      out.push(`      ${adjudicateCmd(it, 'dismissed')}`);
    } else if (cls === 'fixed-unlabelled') {
      // BOTH actions (code-audit R1-H4). An earlier version offered `accepted`
      // only, reasoning that "a shipped fix implies the finding was real" — but
      // that collapses the two axes this repo deliberately keeps orthogonal
      // (AGENTS.md: adjudicationOutcome and remediationState are separate
      // facts). A recorded remediation proves somebody ASSOCIATED a commit with
      // the finding; it does not prove the finding was valid, that the change
      // addressed it, or that the fingerprint was even the right one — and
      // mis-linking is easy when the card lists many similar fingerprints. The
      // adjudication is MOST worth capturing in exactly that state, so removing
      // the only surface for it was the wrong call.
      out.push(`      ${adjudicateCmd(it, 'accepted')}`);
      out.push(`      ${adjudicateCmd(it, 'dismissed')}   # if the recorded fix was mis-linked`);
    } else if (cls === 'accepted-unfixed' || cls === 'regressed') {
      const state = cls === 'regressed' ? 'verified' : 'fixed';
      // With no sha there is no runnable command, and the fallback must not
      // LOOK like one either: a line reading "--commit sha" is indistinguishable
      // from a truncated command, which is the same unpasteable-operator-doc
      // failure the no-angle-brackets rule exists to prevent. So the guidance
      // names no flags at all.
      out.push(sha
        ? `      ${recordFixCmd(it, state, sha)}`
        : `      (no commit sha yet — re-run this check after the commit lands to get the record-fix command for state ${state})`);
    }
  }

  const shown = items.length;
  if (total > shown) {
    out.push('');
    out.push(`  ${total - shown} more not shown — full queue: ${CLI} final-review-stats --repo ${result.repo || 'REPO'} --worksheet`);
  }
  return out.join('\n');
}
