/**
 * @fileoverview The IO half of the GPT round cap: reads argv, applies
 * {@link validateAuditRound}, and — when a round is refused for want of a human
 * call — builds, prints and writes the structural-or-stop card.
 *
 * `openai-audit.mjs` calls {@link gateRoundCap} first thing in `main()`, BEFORE
 * the model-catalog refresh, the sync check, the preflight cost estimate, the
 * brief or any provider is constructed. A refused round therefore makes zero
 * audit-inference requests. The card's architectural-memory read is the one
 * permitted paid call (a few embeddings, bounded) and is skipped when the store
 * is air-gapped or `AUDIT_CARD_NO_ARCH=1`.
 *
 * A refusal writes NO `--out` file and NO gate evidence: "stopped" must never be
 * readable as "passed" by the pre-push hook, the provenance trailers or the
 * convergence telemetry. Only the card file is written.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/round-cap-gate
 */
import path from 'node:path';
import {
  EXIT_CAPPED, cardFileName, formatRoundCapLine, parseRoundFlag, readFlagValue, resolveAuditMode, validateAuditRound,
} from './round-cap.mjs';
import { parseResultPath } from '../finalize-outcomes.mjs';
import { buildStructuralCard, readMatchingCard, writeCardFile } from './structural-card.mjs';
import { recordPastCap } from '../store/run-aggregates.mjs';

/**
 * Session id for card keying: the `<sid>` of `--out <sid>-r<N>-result.json`, else `AUDIT_SESSION_ID`.
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function sessionIdFromArgv(argv, env = process.env) {
  const out = readFlagValue(argv, '--out').value;
  return parseResultPath(out).sid ?? (env.AUDIT_SESSION_ID || null);
}

async function emitCard({ argv, sid, mode, round, caps, auditDir, cwd, env, write, build }) {
  try {
    const { card, text } = await build({ sid, mode, round, planFile: argv[1] || null, caps, auditDir, cwd, env });
    const file = writeCardFile(auditDir, cardFileName(sid, round), card);
    write(`\n${text}\n\n  card written: ${path.relative(cwd, file) || file}\n`);
    return card;
  } catch (err) {
    // The cap holds even when the card cannot be built: say so, never swallow it.
    write(`\n[round-cap] the structural-or-stop card could not be built (${err?.message || err}); the cap still applies.\n`);
    return null;
  }
}

/**
 * Gate one `openai-audit.mjs` invocation on its round number.
 *
 * @param {string[]} argv - the CLI arguments after the script name
 * @param {object} [opts]
 * @param {string} [opts.auditDir]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(s: string) => void} [opts.write] - stderr sink
 * @param {Function} [opts.build] - card builder (test seam)
 * @returns {Promise<{ok: true, round: number, roundCap: null | {mode: string, round: number, soft: number, absolute: number, pastCap: boolean,
 *   pastCapReason: string|null, cardSummary: object|null}} | {ok: false, exitCode: number, code: string}>}
 */
export async function gateRoundCap(argv, {
  auditDir = path.resolve('.audit'), cwd = process.cwd(), env = process.env,
  write = (s) => process.stderr.write(s), build = buildStructuralCard,
} = {}) {
  const modeRes = resolveAuditMode(argv);
  if (!modeRes.ok) { write(`Error: ${modeRes.error}\n`); return { ok: false, exitCode: modeRes.exitCode, code: modeRes.code }; }
  const mode = modeRes.mode;
  if (mode !== 'plan' && mode !== 'code') return { ok: true, roundCap: null, round: 1 };

  const roundRes = parseRoundFlag(argv, '--round', 1);
  if (!roundRes.ok) { write(`Error: ${roundRes.error}\n`); return { ok: false, exitCode: roundRes.exitCode, code: roundRes.code }; }
  const round = roundRes.value;

  const pc = readFlagValue(argv, '--past-cap');
  const pastCapReason = pc.present ? (pc.value ?? '') : null;
  const v = validateAuditRound({ mode, round, pastCapReason });
  const sid = sessionIdFromArgv(argv, env);
  const ctx = { argv, sid, mode, round, caps: v.caps, auditDir, cwd, env, write, build };

  if (!v.ok) {
    if (v.needsCard) await emitCard(ctx);
    write(`Error [${v.code}]: ${v.error}\n`);
    return { ok: false, exitCode: v.exitCode, code: v.code };
  }

  let cardSummary = null;
  if (v.pastCap) {
    const found = readMatchingCard(auditDir, cardFileName(sid, round), { round });
    if (!found.ok) {
      // A past-cap round needs the card for THIS (session, round) computed first — the evidence existed at the decision.
      await emitCard(ctx);
      write(`Error [CARD_REQUIRED]: --past-cap is accepted only after the structural-or-stop card for ${mode} round ${round} has been built (${found.reason}). `
        + 'It is printed above and written to the audit directory — read it, then re-run the same command.\n');
      return { ok: false, exitCode: EXIT_CAPPED, code: 'CARD_REQUIRED' };
    }
    cardSummary = found.card.summary ?? null;
  }

  write(`${formatRoundCapLine({ mode, round: v.round, pastCap: v.pastCap, pastCapReason: v.pastCapReason, caps: v.caps })}\n`);
  return {
    ok: true,
    round: v.round,
    roundCap: {
      mode, round: v.round, soft: v.caps.soft, absolute: v.caps.absolute,
      pastCap: v.pastCap, pastCapReason: v.pastCapReason, cardSummary,
    },
  };
}

/**
 * Stamp the cap state onto a round result and, for a past-cap round, record the override on the run. Mutates and
 * returns `data`. Fail-open: the store write never blocks the round (`recordPastCap` names what it could not write).
 * @param {object} data - the round result about to be written
 * @param {object|null} roundCap - from {@link gateRoundCap}
 * @returns {Promise<object>}
 */
export async function applyRoundCap(data, roundCap) {
  if (!roundCap) return data;
  const { soft, absolute, pastCap, pastCapReason, cardSummary } = roundCap;
  data._roundCap = { soft, absolute, pastCap, pastCapReason, cardSummary };
  if (pastCap && data._cloudRunId) await recordPastCap(data._cloudRunId, { reason: pastCapReason, card: cardSummary });
  return data;
}
