/**
 * @fileoverview The final reviewer's per-finding reversals as `reviewer`
 * adjudication events (docs/plans/audit-telemetry-capture.md Decision 4).
 *
 * The reviewer's response schema lists REVERSALS only (`wrongly_dismissed[]`); it
 * does not rule on each presented finding. So a presented finding that was not
 * reversed is "not reversed", never "sustained", no sustain event is written, and
 * the metric is a REVERSAL rate over an explicit presented set -- not an
 * agreement rate.
 *
 * The presented set is the dismissed ledger entries in the transcript
 * (`presented_dismissals`). Each resolves to its SOURCE finding row -- which can
 * sit in an earlier round -- through `(repo_id, audit_session_id, audit_round)`.
 * Every id that cannot be resolved is COUNTED, never guessed and never dropped:
 * the receipt on the reviewing run says whether the denominator is complete.
 *
 * The planning half is pure; `persistReviewerEvents` is the I/O half.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/final-review/reviewer-events
 */

/**
 * Parse the reviewer's `original_finding_id`. A round-qualified id (`R2 H7`, the
 * form the transcript prints) carries its round; a bare id (`H7`) does not.
 * Surrounding brackets and case are tolerated.
 * @param {unknown} raw
 * @returns {{round: number|null, id: string}|null}
 */
export function parseOriginalFindingId(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().replace(/^\[|\]$/g, '').trim();
  if (!s) return null;
  const qualified = s.match(/^R(\d+)\s+(\S+)$/i);
  if (qualified) return { round: Number(qualified[1]), id: qualified[2].toUpperCase() };
  if (/\s/.test(s)) return null;
  return { round: null, id: s.toUpperCase() };
}

/**
 * Match a reversal id against the presented set. The id must match EXACTLY ONE
 * presented entry: a round-qualified id on (round, id), a bare id on id alone --
 * which is ambiguous the moment two rounds both presented that id.
 * @param {unknown} rawId
 * @param {{latestFindingId: string, resolvedRound: number|null}[]} presented
 * @returns {{status: 'matched', entry: object} | {status: 'unmatched'|'ambiguous'}}
 */
export function matchPresented(rawId, presented) {
  const parsed = parseOriginalFindingId(rawId);
  if (!parsed) return { status: 'unmatched' };
  const hits = presented.filter((e) => String(e.latestFindingId).toUpperCase() === parsed.id
    && (parsed.round == null || e.resolvedRound === parsed.round));
  if (hits.length === 1) return { status: 'matched', entry: hits[0] };
  return { status: hits.length === 0 ? 'unmatched' : 'ambiguous' };
}

/**
 * The finding fingerprint (`_hash`) of a presented entry, read from the round
 * result the transcript carries. Null when the round or the finding is not there
 * (e.g. the finding was suppressed out of that round's result).
 * @param {{latestFindingId: string, resolvedRound: number|null}} entry
 * @param {object[]} rounds - transcript.rounds
 * @returns {string|null}
 */
export function fingerprintOfPresented(entry, rounds) {
  if (!Array.isArray(rounds) || entry.resolvedRound == null) return null;
  const round = rounds.find((r) => r?.round === entry.resolvedRound);
  const f = Array.isArray(round?.findings) ? round.findings.find((x) => x?.id === entry.latestFindingId) : null;
  return typeof f?._hash === 'string' && f._hash ? f._hash : null;
}

/**
 * PURE. Plan the reviewer events for one completed review.
 * @param {{transcript: object, wronglyDismissed: object[]}} input
 * @returns {{
 *   presented: number,
 *   resolvable: {entry: object, fingerprint: string}[],
 *   reversals: {entry: object, fingerprint: string, reason: string, severity: string|null}[],
 *   unresolved: number, ambiguous: number,
 * }}
 *   `unresolved` counts reversals that matched nothing, matched an entry with no
 *   fingerprint, or fell outside the presented set; `ambiguous` counts ids that
 *   matched more than one entry. Neither is ever written.
 */
export function planReviewerEvents({ transcript, wronglyDismissed }) {
  // An ABSENT field is not an empty set: a transcript built without a ledger (or by an older builder, or hand-made) never
  // said what was presented, so the denominator is unknown. The builder always emits the field when it had a ledger.
  const presentedKnown = Array.isArray(transcript?.presented_dismissals);
  const presented = presentedKnown ? transcript.presented_dismissals : [];
  const rounds = transcript?.rounds ?? [];
  const resolvable = [];
  for (const entry of presented) {
    const fingerprint = fingerprintOfPresented(entry, rounds);
    if (fingerprint) resolvable.push({ entry, fingerprint });
  }
  const byEntry = new Map(resolvable.map((r) => [r.entry, r.fingerprint]));
  const reversals = [];
  const seen = new Set();
  let unresolved = 0;
  let ambiguous = 0;
  for (const wd of Array.isArray(wronglyDismissed) ? wronglyDismissed : []) {
    const m = matchPresented(wd?.original_finding_id, presented);
    if (m.status === 'ambiguous') { ambiguous++; continue; }
    if (m.status === 'unmatched' || !byEntry.has(m.entry)) { unresolved++; continue; }
    if (seen.has(m.entry)) continue; // the same finding cited twice is one reversal
    seen.add(m.entry);
    reversals.push({
      entry: m.entry, fingerprint: byEntry.get(m.entry),
      reason: wd.reason_claude_was_wrong ?? '', severity: wd.recommended_severity ?? null,
    });
  }
  return { presented: presented.length, presentedKnown, resolvable, reversals, unresolved, ambiguous };
}

/**
 * PURE. The receipt stored under `write_outcomes.reviewer`. `status` is
 * `complete` only when every presented entry resolved to a source row, every
 * reversal was written (not spilled, not lost), and nothing was unresolved or
 * ambiguous. A query for the reversal rate uses `complete` runs only.
 */
export function buildReviewerReceipt({ plan, presentedResolved, reversalsWritten }) {
  const complete = plan.presentedKnown !== false
    && plan.presented === presentedResolved
    && reversalsWritten === plan.reversals.length
    && plan.unresolved === 0
    && plan.ambiguous === 0;
  return {
    presented: plan.presented,
    presented_resolved: presentedResolved,
    reversals: plan.reversals.length,
    reversals_written: reversalsWritten,
    unresolved: plan.unresolved,
    ambiguous: plan.ambiguous,
    status: complete ? 'complete' : 'incomplete',
    ...(plan.presentedKnown === false ? { reason: 'no-presented-set' } : {}),
  };
}

/**
 * I/O. Write the reviewer events for a completed PRIMARY review and the receipt
 * on the reviewing run. Never throws: the review result must survive a store
 * failure. Shadow reviews never reach here.
 *
 * @param {object} args
 * @param {string} args.runId - the reviewing run (`--run-id`)
 * @param {number|null} args.reviewRound
 * @param {string} args.primaryModel
 * @param {object} args.result - the review result (`wrongly_dismissed`, `verdict`)
 * @param {object} args.transcript - the parsed transcript
 * @param {object} args.deps - injected store seams (`captureV1Present`, `resolveSourceRun`,
 *   `durableWrite`, `recordWriteReceipt`); keeps this module free of a store import
 * @returns {Promise<{skipped?: string, receipt?: object}>}
 */
export async function persistReviewerEvents({ runId, reviewRound, primaryModel, result, transcript, deps }) {
  try {
    if (!runId) return { skipped: 'no-run-id' };
    if (!result?.verdict) return { skipped: 'no-verdict' };
    if (!await deps.captureV1Present()) return { skipped: 'unmigrated' };

    const plan = planReviewerEvents({ transcript, wronglyDismissed: result.wrongly_dismissed });

    // Resolve each distinct source round once: (repo, session, round) -> run id. A presented entry is RESOLVED only when
    // its fingerprint also has a finding row in that run -- a run id alone proves nothing about the finding.
    const runByRound = new Map();
    for (const round of new Set(plan.resolvable.map((r) => r.entry.resolvedRound))) {
      runByRound.set(round, await deps.resolveSourceRun(runId, round));
    }
    const sourceOf = new Map();
    for (const r of plan.resolvable) {
      const sourceRunId = runByRound.get(r.entry.resolvedRound);
      if (sourceRunId && await deps.hasFinding(sourceRunId, r.fingerprint)) sourceOf.set(r.entry, sourceRunId);
    }
    const presentedResolved = sourceOf.size;

    // A re-run of THIS review replaces its earlier observations wholesale: a reversal the reviewer no longer makes must
    // not survive. Other reviews of the same findings are untouched (the delete is keyed on this reviewing run).
    await deps.clearReviewerEvents(runId);

    let reversalsWritten = 0;
    let unresolvedSource = 0;
    for (const rev of plan.reversals) {
      const sourceRunId = sourceOf.get(rev.entry);
      if (!sourceRunId) { unresolvedSource++; continue; }
      const out = await deps.durableWrite('audit.reviewerEvents', {
        runId: sourceRunId, run_id: sourceRunId, fingerprint: rev.fingerprint,
        event: {
          adjudicationOutcome: 'accepted', remediationState: 'pending', ruling: 'overrule', adjudicatorKind: 'reviewer',
          adjudicatorModel: primaryModel, rulingRationale: rev.reason, round: rev.entry.resolvedRound,
          evidence: { reviewing_run_id: runId, review_round: reviewRound ?? null },
        },
      });
      if (out.outcome === 'written') reversalsWritten++;
    }

    const receipt = buildReviewerReceipt({
      plan: { ...plan, unresolved: plan.unresolved + unresolvedSource }, presentedResolved, reversalsWritten,
    });
    await deps.recordWriteReceipt(runId, 'reviewer', receipt);
    return { receipt };
  } catch (err) {
    process.stderr.write(`  [reviewer-events] not recorded (non-blocking): ${err.message}\n`);
    return { skipped: 'error' };
  }
}
