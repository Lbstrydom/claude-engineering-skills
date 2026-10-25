/**
 * @fileoverview The GPT audit ROUND CAP — pure validation, no IO.
 *
 * **Why this is here and not in prose.** "Cap: 3 rounds by default, 5 absolute"
 * (/audit-plan) and "Max 6 rounds" (/audit-code) lived only in SKILL.md, and
 * `openai-audit.mjs` accepted any `--round`: 64 of 297 wine audits ran past
 * round 6 (max 102), $462 of $1,259 spent there. The Gemini gate was already
 * enforced in code (`final-review/round-gate.mjs` `validateRoundArgs`); this is
 * its sibling for the GPT loop. It is a sibling and not an extension because the
 * semantics differ: two levels (soft + absolute), a reason-gated override and a
 * per-mode table, where the final-review gate has one hard cap tied to `--prior`.
 *
 * **What the cap counts.** The caller-supplied `--round` within one session. It
 * is a per-invocation guard — it does not claim to bound orchestration, and a
 * new session id restarts the count (docs/plans/audit-round-cap-structural-or-stop.md §8).
 *
 * **Exit codes.** `EXIT_CAPPED` (4) is a stop that means "a human call is
 * needed", distinct from 1 (the CLI errored / bad arguments) and 3 (INCOMPLETE
 * round). An agent or loop must never read a cap stop as "retry with different
 * arguments".
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/round-cap
 */

/** Soft cap = the default number of rounds; absolute = never exceeded, override or not. */
export const AUDIT_ROUND_CAPS = Object.freeze({
  plan: Object.freeze({ soft: 3, absolute: 5 }),
  code: Object.freeze({ soft: 6, absolute: 8 }),
});

/** A cap stop: the audit needs a human call (see the structural-or-stop card). */
export const EXIT_CAPPED = 4;

/** The shortest `--past-cap` reason accepted (after trimming). */
export const MIN_PAST_CAP_REASON_CHARS = 15;

/** Modes the cap applies to. `rebuttal` has no round and is never capped. */
const CAPPED_MODES = Object.freeze(['plan', 'code']);

/**
 * Read the raw value of `--flag <value>` from argv. A flag that is present but
 * has no value (end of argv, or the next token is another `--flag`) is reported
 * as `{present:true, value:null}`, never silently treated as absent.
 * @param {string[]} argv
 * @param {string} flag
 * @returns {{present: boolean, value: string|null}}
 */
export function readFlagValue(argv, flag) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return { present: false, value: null };
  const next = argv[idx + 1];
  if (next === undefined || next.startsWith('--')) return { present: true, value: null };
  return { present: true, value: next };
}

/**
 * Strict positive-integer parse of a round-shaped flag (`--round`,
 * `--max-rounds`). The default applies ONLY when the flag is absent; a present
 * flag must be a whole-string positive safe integer. `Number.parseInt` accepted
 * `1.5`, `3junk` and `1e2` as 1, 3 and 1.
 * @param {string[]} argv
 * @param {string} flag
 * @param {number|null} defaultValue
 * @returns {{ok: true, value: number|null} | {ok: false, code: 'BAD_ROUND', error: string, exitCode: 1}}
 */
export function parseRoundFlag(argv, flag, defaultValue) {
  const { present, value } = readFlagValue(argv, flag);
  if (!present) return { ok: true, value: defaultValue };
  if (value === null) return badRound(flag, '(missing value)');
  if (!/^[1-9]\d*$/.test(value)) return badRound(flag, value);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) return badRound(flag, value);
  return { ok: true, value: n };
}

function badRound(flag, got) {
  return {
    ok: false,
    code: 'BAD_ROUND',
    exitCode: 1,
    error: `${flag} must be a positive whole number (1, 2, 3, ...), got ${got}.`,
  };
}

/**
 * The one mode contract. The positional `args[0]` is authoritative; `--mode`
 * (which /audit-plan passes for the benefit of gemini-review) is accepted when
 * absent or equal and refused when it names a different mode — so
 * `plan … --mode code` can never be audited under the wrong cap.
 * @param {string[]} argv - the CLI arguments after the script name
 * @returns {{ok: true, mode: string|undefined} | {ok: false, code: 'MODE_CONFLICT', error: string, exitCode: 1}}
 */
export function resolveAuditMode(argv) {
  const positional = argv[0];
  const { present, value } = readFlagValue(argv, '--mode');
  if (present && value !== null && ['plan', 'code', 'rebuttal'].includes(positional) && value !== positional) {
    return {
      ok: false,
      code: 'MODE_CONFLICT',
      exitCode: 1,
      error: `--mode ${value} conflicts with the positional mode "${positional}". The positional mode is authoritative; drop --mode or make them agree.`,
    };
  }
  return { ok: true, mode: positional };
}

/**
 * Validate a round against the cap table. Pure.
 *
 * | round                          | `--past-cap`         | result |
 * |--------------------------------|----------------------|--------|
 * | <= soft                        | absent               | ok     |
 * | <= soft                        | given                | PAST_CAP_UNNEEDED (exit 1) |
 * | soft < round <= absolute       | absent / too short   | PAST_CAP_REQUIRED (exit 4, card) |
 * | soft < round <= absolute       | reason >= 15 chars   | ok, pastCap |
 * | > absolute                     | any                  | ABSOLUTE_CAP (exit 4, card) |
 *
 * `needsCard` marks the refusals that must print the structural-or-stop card.
 * @param {{mode: string|undefined, round: number|null, pastCapReason?: string|null}} input
 * @returns {{ok: true, round: number|null, pastCap: boolean, pastCapReason: string|null, caps: {soft: number, absolute: number}|null}
 *   | {ok: false, code: string, error: string, exitCode: number, needsCard: boolean, caps: {soft: number, absolute: number}}}
 */
export function validateAuditRound({ mode, round, pastCapReason = null }) {
  if (!CAPPED_MODES.includes(mode)) {
    return { ok: true, round, pastCap: false, pastCapReason: null, caps: null };
  }
  const caps = AUDIT_ROUND_CAPS[mode];
  const r = round ?? 1;
  const reason = typeof pastCapReason === 'string' ? pastCapReason.trim() : '';

  if (r <= caps.soft) {
    if (pastCapReason !== null && pastCapReason !== undefined) {
      return refuse('PAST_CAP_UNNEEDED', 1, false, caps,
        `--past-cap is only for rounds past the soft cap (${mode}: ${caps.soft}); round ${r} is within it. Drop the flag.`);
    }
    return { ok: true, round: r, pastCap: false, pastCapReason: null, caps };
  }

  if (r > caps.absolute) {
    return refuse('ABSOLUTE_CAP', EXIT_CAPPED, true, caps,
      `${mode} audit round ${r} refused: the absolute cap is ${caps.absolute} and --past-cap cannot lift it. `
      + 'The audit is over. Either capture the remaining findings as debt (debt-auto-capture.mjs) or open a structural plan for the cluster the card names.');
  }

  if (reason.length < MIN_PAST_CAP_REASON_CHARS) {
    return refuse('PAST_CAP_REQUIRED', EXIT_CAPPED, true, caps,
      `${mode} audit round ${r} is past the soft cap (${caps.soft}, absolute ${caps.absolute}). `
      + `Read the structural-or-stop card below and make the call. To continue anyway, re-run with `
      + `--past-cap "<why this round will converge, at least ${MIN_PAST_CAP_REASON_CHARS} characters>".`);
  }
  return { ok: true, round: r, pastCap: true, pastCapReason: reason, caps };
}

function refuse(code, exitCode, needsCard, caps, error) {
  return { ok: false, code, exitCode, needsCard, caps, error };
}

/**
 * The card file a past-cap round must find on disk, keyed by session + round.
 * A missing session id falls back to a fixed token so a manual run still has one.
 * @param {string|null} sid
 * @param {number} round
 * @returns {string} file name (no directory)
 */
export function cardFileName(sid, round) {
  return `${sid || 'session'}-r${round}-structural-card.json`;
}

/**
 * One-line summary of the cap state for the result summary / stderr.
 * @param {{mode: string, round: number, pastCap: boolean, pastCapReason?: string|null, caps?: {soft: number, absolute: number}|null}} s
 * @returns {string}
 */
export function formatRoundCapLine({ mode, round, pastCap, pastCapReason = null, caps = null }) {
  const c = caps ?? AUDIT_ROUND_CAPS[mode];
  if (!c) return '';
  if (!pastCap) return `[round-cap] within cap: ${mode} round ${round}/${c.soft}`;
  return `[round-cap] past cap: ${mode} round ${round} (soft ${c.soft}, absolute ${c.absolute}) — "${pastCapReason}"`;
}
