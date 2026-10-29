/**
 * @fileoverview The one place an audit run's session identity is resolved
 * (docs/plans/audit-telemetry-capture.md Decision 1).
 *
 * Rounds of one audit are separate `audit_runs` rows. `audit_session_id` +
 * `audit_round` are what link them. Two sources carry the identity today -- the
 * `--session-id` / `--round` flags and the `<sid>-r<N>-result.json` `--out`
 * path -- and they can disagree. An ambiguous identity becomes NULL, never a
 * pick: a wrong session id silently merges two audits in every query.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/audit-identity
 */
import { parseResultPath } from '../finalize-outcomes.mjs';

/**
 * @param {{sessionFlag?: string|null, roundFlag?: number|null, outPath?: string|null}} input
 * @returns {{auditSessionId: string|null, auditRound: number|null, conflict: string|null}}
 */
export function resolveAuditIdentity({ sessionFlag = null, roundFlag = null, outPath = null } = {}) {
  const fromPath = parseResultPath(outPath);
  const flagSid = typeof sessionFlag === 'string' && sessionFlag.trim() ? sessionFlag.trim() : null;
  const flagRound = Number.isInteger(roundFlag) && roundFlag >= 1 ? roundFlag : null;

  if (flagSid && fromPath.sid && flagSid !== fromPath.sid) {
    return { auditSessionId: null, auditRound: null, conflict: `--session-id "${flagSid}" disagrees with the --out path session "${fromPath.sid}"` };
  }
  if (flagRound != null && fromPath.round != null && flagRound !== fromPath.round) {
    return { auditSessionId: null, auditRound: null, conflict: `--round ${flagRound} disagrees with the --out path round ${fromPath.round}` };
  }
  return {
    auditSessionId: flagSid ?? fromPath.sid ?? null,
    auditRound: flagRound ?? fromPath.round ?? null,
    conflict: null,
  };
}

let _sentinelWarned = false;

/**
 * The model id to stamp on a finding's `_sourceModel` (Decision 3): the concrete
 * id the provider returned, never normalised. Mechanical passes carry no model
 * (null -> null, an honest absence). A value that still reads as an unresolved
 * `latest-*` sentinel is refused and stored as NULL with one warning -- a
 * sentinel is a routing instruction, not the model that did the work.
 * @param {unknown} model
 * @returns {string|null}
 */
export function stampableSourceModel(model) {
  if (typeof model !== 'string' || !model.trim()) return null;
  const id = model.trim();
  if (/^latest-/i.test(id)) {
    if (!_sentinelWarned) {
      _sentinelWarned = true;
      process.stderr.write(`  [learning] source model "${id}" is an unresolved sentinel - stored as NULL\n`);
    }
    return null;
  }
  return id;
}
