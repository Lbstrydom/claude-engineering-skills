/**
 * @fileoverview Final-review registry commands (docs/plans/cross-skill-command-registry.md
 * — Cluster B, Phase 3 writes; the readers `final-review-stats`/`-pending`
 * join in Cluster C).
 *
 * Behaviour-preserving moves. Both commands emit `{ok:false, cloud:false,
 * updated:0}` at EXIT 0 when cloud is off — a frozen legacy quirk, declared
 * `softFail` in the registry and pinned by the golden fixtures, not a
 * loophole discovered later.
 */
import { CommandError } from '../dispatch.mjs';

/** Shared bucket parsing: `--bucket primary|none` names the NULL bucket. */
function bucketOpt(ctx) {
  // `argOption` returns NULL for an absent flag, never `undefined` — the
  // `undefined` test once made the omitted-bucket branch UNREACHABLE, so every
  // caller that omitted `--bucket` silently got "scope to the PRIMARY bucket"
  // rather than the documented "let the store resolve it", and a shadow-only
  // finding matched 0 rows.
  const raw = ctx.flag('bucket');
  return raw === null ? {}
    : { bucket: (raw === 'primary' || raw === 'none') ? null : raw };
}

function bucketHint(res, extraReason, extraText) {
  if (res.reason === 'ambiguous-bucket') {
    return ` — fingerprint spans buckets [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]; re-run with --bucket <name>`;
  }
  if (res.reason === extraReason) return extraText;
  return '';
}

/**
 * `final-review-adjudicate` — write the accepted/dismissed axis.
 *
 * A 0-row adjudication is a FAILURE, not a quiet success: reporting ok:true
 * there is how a hardcoded bucket filter went unnoticed — every primary
 * finding "adjudicated" fine and nothing changed.
 */
export async function finalReviewAdjudicateCmd(ctx) {
  if (!ctx.cloud.enabled) return { ok: false, cloud: false, updated: 0 };
  const runId = ctx.flag('run-id');
  const fingerprint = ctx.flag('fingerprint');
  const action = ctx.flag('action');
  if (!runId || !fingerprint || !action) {
    throw new CommandError('BAD_INPUT', '--run-id <id> --fingerprint <hash> --action <accepted|dismissed> are all required');
  }
  if (action !== 'accepted' && action !== 'dismissed') {
    throw new CommandError('BAD_INPUT', `--action must be 'accepted' or 'dismissed', got '${action}'`);
  }
  const res = await ctx.deps.adjudicateFinalReviewFinding(runId, fingerprint, action, bucketOpt(ctx));
  if (!res.ok) {
    const hint = bucketHint(res, 'no-match-in-bucket',
      ` — no row in that bucket; present in [${(res.buckets || []).map((b) => b ?? 'primary').join(', ')}]`);
    throw new CommandError('ADJUDICATION_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  return res;
}

/**
 * `final-review-record-fix` — write the remediation axis.
 *
 * Deliberately separate from `--action`: accepted and fixed are orthogonal
 * axes (AGENTS.md two-axis model), and collapsing them would make "accepted,
 * fix pending" unrepresentable.
 */
export async function finalReviewRecordFixCmd(ctx) {
  if (!ctx.cloud.enabled) return { ok: false, cloud: false, updated: 0 };
  const runId = ctx.flag('run-id');
  const fingerprint = ctx.flag('fingerprint');
  if (!runId || !fingerprint) {
    throw new CommandError('BAD_INPUT', '--run-id <id> and --fingerprint <hash> are both required');
  }
  const state = ctx.flag('state');
  const opts = {
    commitSha: ctx.flag('commit'),
    ...(state ? { state } : {}),
    ...bucketOpt(ctx),
  };
  const res = await ctx.deps.recordFinalReviewFix(runId, fingerprint, opts);
  if (!res.ok) {
    const hint = bucketHint(res, 'dismissed-cannot-be-fixed',
      ' — this finding was adjudicated `dismissed`; recording a fix for a non-issue is incoherent');
    throw new CommandError('RECORD_FIX_FAILED', `${res.reason || 'unknown'}${hint}`, {
      updated: 0, cloud: res.cloud, buckets: res.buckets,
    });
  }
  return res;
}
