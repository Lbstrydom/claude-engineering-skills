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
  EXIT_CAPPED, META_T2_ROUND, MIN_PAST_CAP_REASON_CHARS, cardFileName, formatRoundCapLine, parseRoundFlag, readFlagValue, resolveAuditMode, validateAuditRound,
} from './round-cap.mjs';
import { parseResultPath } from '../finalize-outcomes.mjs';
import { buildStructuralCard, readMatchingCard, writeCardFile } from './structural-card.mjs';
import { recordPastCap } from '../store/run-aggregates.mjs';
import { recordCapStop } from './cap-productivity.mjs';

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

async function emitCard({ argv, sid, mode, round, caps, auditDir, cwd, env, write, build, recordCap }, { recordStop = false } = {}) {
  try {
    const { card, text } = await build({ sid, mode, round, planFile: argv[1] || null, caps, auditDir, cwd, env });
    const file = writeCardFile(auditDir, cardFileName(sid, round), card);
    write(`\n${text}\n\n  card written: ${path.relative(cwd, file) || file}\n`);
    if (recordStop && card?.productivity) {
      // Observation-only, and only for a REFUSED round (never --past-cap's missing-card case, which is an operator
      // continuing): capped-while-productive is data for the cap policy, never a reason to admit the round.
      const rec = await recordCap({ sid, mode, round, caps, productivity: card.productivity, runId: card.productivity.lastRunId, trigger: 'refused' });
      write(rec.recorded ? '  [round-cap] cap reached, recorded (round_cap_reached)\n' : `  [round-cap] cap-reached telemetry not recorded (${rec.reason})\n`);
    }
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
 * With `metaReview: true` (only `openai-audit.mjs` `main()` passes it: library and test callers never spend) and no
 * opt-out (`--no-meta-review` / `AUDIT_META_REVIEW=off`), the AUTOMATIC META-REVIEW (docs/plans/meta-step-back-at-cap.md)
 * decides at two triggers: T1, a round refused at the soft cap, only with `AUDIT_META_REVIEW_T1=on` (off by default;
 * admit within the absolute cap — L1 — or stop / structural, with the open topics captured as debt — L3); and T2, code round 4 when a round signal fires (an early
 * stop only when the last round is measured unproductive — L2). Its module is loaded lazily, only when eligible.
 * Every non-decision (no route, invalid, budget, malformed log) leaves today's behaviour exactly as it was.
 *
 * @param {string[]} argv - the CLI arguments after the script name
 * @param {object} [opts]
 * @param {string} [opts.auditDir]
 * @param {string} [opts.cwd]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {(s: string) => void} [opts.write] - stderr sink
 * @param {Function} [opts.build] - card builder (test seam)
 * @param {Function} [opts.recordCap] - cap-stop telemetry recorder (test seam)
 * @param {boolean} [opts.metaReview] - eligibility for the automatic meta-review (default false)
 * @param {string|null} [opts.auditorModel] - the model the audit rounds run on (reviewer independence)
 * @param {object} [opts.metaDeps] - test seams passed through to runMetaReview / appendMetaOverride
 * @returns {Promise<{ok: true, round: number, roundCap: null | {mode: string, round: number, soft: number, absolute: number, pastCap: boolean,
 *   pastCapReason: string|null, cardSummary: object|null}} | {ok: false, exitCode: number, code: string}>}
 */
export async function gateRoundCap(argv, {
  cwd = process.cwd(), auditDir = path.resolve(cwd, '.audit'), env = process.env,
  write = (s) => process.stderr.write(s), build = buildStructuralCard, recordCap = recordCapStop,
  metaReview = false, auditorModel = null, metaDeps = {},
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
  const ctx = { argv, sid, mode, round, caps: v.caps, auditDir, cwd, env, write, build, recordCap };
  const passed = (fields) => {
    write(`${formatRoundCapLine({ mode, round: v.round ?? round, pastCap: fields.pastCap, pastCapReason: fields.pastCapReason, caps: v.caps })}\n`);
    return { ok: true, round: v.round ?? round, roundCap: { mode, round: v.round ?? round, soft: v.caps.soft, absolute: v.caps.absolute, ...fields } };
  };

  let meta = null;
  if (metaReview) {
    const m = await import('./meta-review.mjs');
    if (!m.isMetaReviewOptedOut({ argv, env })) meta = m;
  }
  const metaArgs = { sid, mode, round, caps: v.caps, argv, auditDir, cwd, env, auditorModel };
  const mo = readFlagValue(argv, '--meta-override');
  // --meta-override answers ONE honoured early stop inside the soft cap. Refused, writing nothing, on any round the
  // cap itself refuses or a --past-cap continues: the override is recorded only once the round is otherwise accepted.
  if (mo.present && (!v.ok || v.pastCap)) {
    write(`Error [META_OVERRIDE_UNNEEDED]: --meta-override applies only to an accepted code round ${META_T2_ROUND} inside the soft cap; drop it.\n`);
    return { ok: false, exitCode: 1, code: 'META_OVERRIDE_UNNEEDED' };
  }

  if (!v.ok) {
    const t1 = Boolean(meta) && v.code === 'PAST_CAP_REQUIRED' && meta.isMetaT1Enabled({ env });
    if (t1) {
      const adm = admissionOf(meta, { argv, mode, sid, auditDir, round });
      if (adm) return passed({ pastCap: true, pastCapReason: `meta-review ${adm.attemptId}: ${adm.verdict?.reason ?? 'admitted'}`.slice(0, 500), cardSummary: null });
    }
    if (v.needsCard) await emitCard(ctx, { recordStop: true });
    if (t1) {
      const res = await meta.runMetaReview({ trigger: 'T1', ...metaArgs }, metaDeps);
      for (const l of res.lines) write(`${l}\n`);
      if (res.honoured && res.effect === 'admit') {
        return passed({ pastCap: true, pastCapReason: `meta-review ${res.decision.attemptId}: ${res.decision.verdict?.reason ?? 'admitted'}`.slice(0, 500), cardSummary: null });
      }
      if (res.honoured && (res.effect === 'stop' || res.effect === 'structural')) return metaStop(meta, { res, write, auditDir, sid, early: false });
    }
    write(`Error [${v.code}]: ${v.error}\n`);
    return { ok: false, exitCode: v.exitCode, code: v.code };
  }

  let cardSummary = null;
  if (v.pastCap) {
    const found = readMatchingCard(auditDir, cardFileName(sid, round), { round, mode, planFile: argv[1] || null });
    if (!found.ok) {
      // A past-cap round needs the card for THIS (session, round) computed first — the evidence existed at the decision.
      const built = await emitCard(ctx);
      write(`Error [CARD_REQUIRED]: --past-cap is accepted only after the structural-or-stop card for ${mode} round ${round} has been built (${found.reason}). `
        + (built
          ? 'It is printed above and written to the audit directory — read it, then re-run the same command.\n'
          : 'Building it failed (reason above), so a re-run is refused the same way until the card can be built.\n'));
      return { ok: false, exitCode: EXIT_CAPPED, code: 'CARD_REQUIRED' };
    }
    cardSummary = found.card.summary ?? null;
    // A human --past-cap over an honoured T1 stop/structural is an OVERRIDE of that decision: recorded, never silent.
    if (meta) {
      const rec = await recordPastCapOverride(meta, { argv, mode, sid, auditDir, round, reason: v.pastCapReason, write, deps: metaDeps });
      // An override nobody can see is indistinguishable from the stop still standing: an unrecorded one admits nothing.
      if (!rec.ok) { write(`Error [META_OVERRIDE_WRITE]: the --past-cap override of ${rec.attemptId} could not be recorded (${rec.reason}); the round is not admitted. Re-run, or opt out with --no-meta-review.\n`); return { ok: false, exitCode: 1, code: 'META_OVERRIDE_WRITE' }; }
    }
  }

  if (mo.present) {
    const res = await applyMetaOverride({ meta, mode, round, sid, argv, auditDir, env, reason: mo.value, deps: metaDeps });
    if (!res.ok) { write(`Error [${res.code}]: ${res.error}\n`); return { ok: false, exitCode: 1, code: res.code }; }
    write(`  [meta-review] override recorded against ${res.attemptId}: the round runs\n`);
  }

  if (meta && !v.pastCap && !mo.present && meta.metaTriggerFor({ mode, round }) === 'T2') {
    const res = await meta.runMetaReview({ trigger: 'T2', ...metaArgs }, metaDeps);
    for (const l of res.lines) write(`${l}\n`);
    if (res.honoured && (res.effect === 'stop' || res.effect === 'structural')) {
      await emitCard(ctx);
      return metaStop(meta, { res, write, auditDir, sid, early: true });
    }
  }

  return passed({ pastCap: v.pastCap, pastCapReason: v.pastCapReason, cardSummary });
}

/** An honoured loop-ending decision: exit 4, the debt command, and how a human overrides it. */
function metaStop(meta, { res, write, auditDir, sid, early }) {
  const code = res.effect === 'stop' ? 'META_STOP' : 'META_STRUCTURAL';
  write(`  [meta-review] ${res.effect === 'stop' ? 'STOP' : 'STRUCTURAL'} (${res.decision.attemptId}). Capture the open topics as debt:\n    ${meta.metaDebtCommand({ auditDir, sid, attemptId: res.decision.attemptId })}\n`);
  if (res.effect === 'structural') write(`  [meta-review] structural cause: ${res.decision.verdict?.cause ?? ''}\n  [meta-review] proposed fix (its own plan or PR): ${res.decision.verdict?.proposedFix ?? ''}\n`);
  write(`Error [${code}]: the meta-review ended this audit${early ? ' before the soft cap (L2)' : ' at the cap'}. To continue anyway, re-run with `
    + `${early ? '--meta-override "<why this round will converge>"' : '--past-cap "<why this round will converge>"'}, or opt out with --no-meta-review.\n`);
  return { ok: false, exitCode: EXIT_CAPPED, code };
}

function identityDigest(meta, { argv, mode, sid }) {
  return meta.fingerprintDigest(meta.fingerprintOf({ argv, mode, sid }));
}

/** The honoured, un-revoked admission covering this round for this identity, or null (a malformed log admits nothing). */
function admissionOf(meta, { argv, mode, sid, auditDir, round }) {
  const log = meta.readMetaLog(meta.metaLogPath(auditDir, sid));
  if (log.malformed) return null;
  return meta.admissionFor({ fold: meta.foldMetaLog(log.events), digest: identityDigest(meta, { argv, mode, sid }), round });
}

/** Honoured loop-ending decisions for this session, round, trigger and identity (newest last). */
function loopEndsFor(meta, { argv, mode, sid, auditDir, round, trigger }) {
  const log = meta.readMetaLog(meta.metaLogPath(auditDir, sid));
  if (log.malformed) return [];
  const fold = meta.foldMetaLog(log.events);
  const digest = identityDigest(meta, { argv, mode, sid });
  return [...fold.decisions.values()].filter((d) => d.trigger === trigger && d.round === round && d.fingerprintDigest === digest && meta.honouredLoopEnd({ fold, attemptId: d.attemptId }));
}

async function recordPastCapOverride(meta, { argv, mode, sid, auditDir, round, reason, write, deps }) {
  for (const d of loopEndsFor(meta, { argv, mode, sid, auditDir, round, trigger: 'T1' })) {
    const out = await meta.appendMetaOverride({ auditDir, sid, attemptId: d.attemptId, kind: 'override', by: null, reason, source: 'past-cap' }, deps);
    if (!out.ok) return { ok: false, attemptId: d.attemptId, reason: out.reason };
    write(`  [meta-review] --past-cap overrides decision ${d.attemptId} (${d.guard.effect}); recorded\n`);
  }
  return { ok: true };
}

/** `--meta-override "<reason>"`: override an honoured T2 stop/structural for this round and identity; refused otherwise. */
async function applyMetaOverride({ meta, mode, round, sid, argv, auditDir, reason, deps }) {
  if (!meta) return { ok: false, code: 'META_OVERRIDE_UNNEEDED', error: '--meta-override has nothing to override: the meta-review is off for this run (opted out, or not an openai-audit invocation).' };
  if (typeof reason !== 'string' || reason.trim().length < MIN_PAST_CAP_REASON_CHARS) {
    return { ok: false, code: 'META_OVERRIDE_REASON', error: `--meta-override needs a reason of at least ${MIN_PAST_CAP_REASON_CHARS} characters.` };
  }
  const ends = mode === 'code' && round === META_T2_ROUND ? loopEndsFor(meta, { argv, mode, sid, auditDir, round, trigger: 'T2' }) : [];
  if (!ends.length) return { ok: false, code: 'META_OVERRIDE_UNNEEDED', error: `--meta-override: no honoured meta-review stop for ${mode} round ${round} of this session and change. Drop the flag.` };
  const target = ends[ends.length - 1];
  const out = await meta.appendMetaOverride({ auditDir, sid, attemptId: target.attemptId, kind: 'override', by: null, reason: reason.trim(), source: 'meta-override' }, deps);
  if (!out.ok) return { ok: false, code: 'META_OVERRIDE_WRITE', error: `--meta-override could not be recorded (${out.reason}); nothing was changed.` };
  return { ok: true, attemptId: target.attemptId };
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
  const { soft, absolute, pastCap, pastCapReason, cardSummary, round } = roundCap;
  data._roundCap = { soft, absolute, pastCap, pastCapReason, cardSummary };
  if (pastCap && data._cloudRunId) await recordPastCap(data._cloudRunId, { reason: pastCapReason, card: cardSummary, round });
  return data;
}
