/**
 * @fileoverview `campaign.mjs adjudicate --redo`: argv parsing, redo-row resolution and the claim-conflict bucket. Split out of
 * scripts/campaign.mjs, which is size-ratcheted and may not grow.
 * @module scripts/lib/campaign/redo
 */
import { ArgvError } from '../cli-io.mjs';

const REDO_USAGE = '--redo <finding-uuid[,finding-uuid...]> is required when the flag is given';

/** `--redo a,b,c` → the DISTINCT finding ids (first-seen order), or null when the flag is absent. */
export function parseRedo(value) {
  if (value == null) return null;
  if (String(value).startsWith('--')) throw new ArgvError(REDO_USAGE);
  const ids = [...new Set(String(value).split(',').map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) throw new ArgvError('--redo was given no finding ids');
  return ids;
}

/**
 * `--redo` from its argv value. A flag that is PRESENT but valueless (a trailing `--redo`) is a usage error: the reader returns null,
 * which parseRedo treats as "flag absent", silently running the ordinary PAID adjudicate-all path the operator did not ask for.
 */
export function parseRedoFromArgv(value, argv) {
  if (value == null && argv.includes('--redo')) throw new ArgvError(REDO_USAGE);
  return parseRedo(value);
}

/** A lost receipt claim is a benign skip; it must land in the `skipped` bucket. */
export function claimConflictBucket(claim) {
  return claim && claim.ok ? null : 'skipped';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve `--redo` finding ids to blind worksheet rows, refusing before spend.
 *
 * Three refusals, all of them BEFORE any provider call, because every one of
 * them is cheaper to state than to discover halfway through a paid batch:
 *
 * 1. **No reason.** A redo supersedes a verdict that already counts toward the
 *    campaign's accepted totals. The superseded row stays readable either way,
 *    but "why did this number move" must not be reconstructable only from
 *    timestamps.
 * 2. **An id this cohort does not hold** — a typo, or a finding from another
 *    campaign. Silently adjudicating nothing would read as success.
 * 3. **A finding a HUMAN has already dispositioned.** The override names the
 *    agent verdict it overrides and that pair IS the published calibration
 *    figure, so superseding the named verdict would leave the override pointing
 *    at a superseded row. A person's decision also simply outranks a re-run.
 */
export async function resolveRedoRows({ redo, candidates, blindRows, reason, findingsWithHumanDisposition }) {
  if (!reason || String(reason).trim().length === 0) {
    return { ok: false, error: '--redo requires --reason "why": it supersedes verdicts that already count toward this campaign\'s totals.' };
  }
  const malformed = redo.filter((id) => !UUID_RE.test(id));
  if (malformed.length > 0) {
    return { ok: false, error: `--redo takes FINDING uuids; these are not uuids: ${malformed.join(', ')}` };
  }
  const rowIdFor = new Map(candidates.map((c) => [c.findingId, c.worksheetRowId]));
  const unknown = redo.filter((id) => !rowIdFor.has(id));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `these findings are not in this cohort's live evidence: ${unknown.join(', ')}\n`
        + '  (a redo names FINDING uuids from THIS campaign — check the id, or the cohort lock)',
    };
  }
  const human = await findingsWithHumanDisposition(redo);
  const blocked = redo.filter((id) => human.ids.has(id));
  if (blocked.length > 0) {
    return {
      ok: false,
      error: `${human.ok ? 'these findings already carry a HUMAN disposition' : 'the human-disposition guard could not be read, so every id is refused'}: ${blocked.join(', ')}\n`
        + '  A human override names the agent verdict it overrides, and that pair is the campaign\'s calibration figure.\n'
        + '  Re-record the human decision instead: campaign.mjs override --finding FINDING_UUID --verdict accepted --note "why"',
    };
  }
  const byRowId = new Map(blindRows.rows.map((r) => [r.worksheet_row_id, r]));
  const distinct = [...new Set(redo)];
  const rows = distinct.map((id) => byRowId.get(rowIdFor.get(id)));
  // A candidate whose blind worksheet row is absent would otherwise be dropped silently, and the redo would "succeed" on fewer rows.
  const missing = distinct.filter((_, i) => !rows[i]);
  if (missing.length > 0) return { ok: false, error: `these findings have no blind worksheet row (candidates and worksheet disagree): ${missing.join(', ')}` };
  return { ok: true, rows };
}

