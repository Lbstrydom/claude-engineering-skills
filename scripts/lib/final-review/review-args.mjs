/**
 * @fileoverview argv parsing for `gemini-review.mjs review`. Pure relocation
 * out of `scripts/gemini-review.mjs` (which sits on the size ratchet) plus the
 * `--round` / `--prior` pair; validation of those two lives with the cap it
 * enforces (`round-gate.mjs::validateRoundArgs`).
 *
 * @module scripts/lib/final-review/review-args
 */

/** Every flag `review` accepts — gemini-review.mjs refuses anything else (assertKnownFlags). */
export const REVIEW_FLAGS = Object.freeze([
  '--json', '--out', '--provider', '--mode', '--run-id', '--role', '--envelope-scope', '--campaign-digest',
  '--round', '--prior',
]);

const flagValue = (args, name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

/**
 * @param {string[]} args - argv after the script path (`args[0]` is the mode)
 */
export function parseReviewArgs(args) {
  const planFile = args[1];
  const transcriptFile = args[2];
  const jsonMode = args.includes('--json');
  const outFile = flagValue(args, '--out');
  const providerOverride = flagValue(args, '--provider');
  const auditMode = flagValue(args, '--mode') ?? 'code';
  // --run-id <audit_runs.id> — enables per-finding cloud persistence keyed to
  // this run (shadow A/B). Absent → local-only, today's behaviour unchanged.
  const runId = flagValue(args, '--run-id');
  // --role <adjudicator-only> (Phase 12) — closed value set, validated in
  // main(). Absent (null) → today's default behaviour, byte-identical.
  const role = flagValue(args, '--role');
  // --envelope-scope <full|thin|gap> — the CAMPAIGN's declared scope for the
  // shadow reviewer this process spawns. Presence of this flag (or
  // --campaign-digest) is the "a campaign is active" signal — see KD-6's
  // correction: an earlier draft used the presence of ANY envelope-scope
  // source as that signal, which made identical `gap` intent behave
  // differently by transport (env-supplied gap was fine, CLI-supplied gap was
  // a campaign violation). Precedence: this flag > FINAL_REVIEW_SHADOW_SCOPE
  // env > 'full' default (resolveEnvelopeScope owns the actual resolution).
  const envelopeScopeCli = flagValue(args, '--envelope-scope');
  // --campaign-digest <hex> — the manifest's configDigest, recorded (never
  // verified here; verification is the COLLECTOR's job, which owns the
  // manifest) so a persisted snapshot can be matched to the specific signed
  // cohort that claims it. Its PRESENCE is the campaign-active signal.
  const campaignDigest = flagValue(args, '--campaign-digest');
  // --round <1|2> + --prior <previous result.json> — the final-review round
  // cap as CODE (round-gate.mjs). Absent → legacy single-shot behaviour.
  const round = flagValue(args, '--round');
  const priorPath = flagValue(args, '--prior');
  return {
    planFile, transcriptFile, jsonMode, outFile, providerOverride, auditMode, runId, role,
    envelopeScopeCli, campaignDigest, round, priorPath,
  };
}
