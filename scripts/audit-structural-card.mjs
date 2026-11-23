#!/usr/bin/env node
/**
 * @fileoverview CLI — print the structural-or-stop card for an audit session.
 *
 * Run it when an audit reaches its soft cap and has not converged, so the
 * structural question is asked against the repo's memory and backlog even when
 * the operator chooses to stop. `openai-audit.mjs` builds the same card on a
 * cap refusal; this is the same builder, run on demand.
 *
 *   node scripts/audit-structural-card.mjs --sid audit-plan-1792-99 --mode plan --round 4 --plan "$PLAN_FILE"
 *
 * At code checkpoints 3 and 6 it also prints the round signals (reopen rate, severity drift, retired); `--step-back`
 * then runs the fresh-context reviewer (`--step-back-arm same|different`, default same = latest-gpt) through the
 * egress-gated context pack — it is a paid call, made only when a signal fired. After round 6 it prints the default:
 * stop-to-debt or a human; rounds 7-8 need --past-cap.
 *
 * Read-only apart from the card file it writes next to the round results and one
 * observation-only `round_cap_reached` learning decision (both skipped by --no-write). It
 * creates no debt and no proposal; the verdict is a hint and the call is the
 * operator's. Exit 0 whenever the card was produced, 2 on an argument error.
 *
 * @module scripts/audit-structural-card
 */
import './lib/load-env.mjs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { AUDIT_ROUND_CAPS, MIN_PAST_CAP_REASON_CHARS, cardFileName, parseRoundFlag, readFlagValue } from './lib/audit/round-cap.mjs';
import { buildStructuralCard, writeCardFile } from './lib/audit/structural-card.mjs';
import { recordCapStop } from './lib/audit/cap-productivity.mjs';
import { buildCheckpointSection } from './lib/audit/step-back-card.mjs';
import { createStepBackProvider } from './lib/audit/step-back-provider.mjs';

const KNOWN_FLAGS = ['--sid', '--mode', '--round', '--plan', '--dir', '--json', '--no-write', '--step-back', '--step-back-arm', '--revoke-meta-admission', '--by', '--reason', '--selfcheck-relocation'];

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); return; }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'audit-structural-card' });
  const argv = process.argv.slice(2);

  const sid = readFlagValue(argv, '--sid').value || process.env.AUDIT_SESSION_ID || null;
  const mode = readFlagValue(argv, '--mode').value;
  if (mode !== 'plan' && mode !== 'code') {
    throw new ArgvError('audit-structural-card: --mode plan|code is required (a plan audit and a code audit have different caps).');
  }
  const caps = AUDIT_ROUND_CAPS[mode];
  const roundRes = parseRoundFlag(argv, '--round', caps.soft + 1);
  if (!roundRes.ok) throw new ArgvError(`audit-structural-card: ${roundRes.error}`);
  const auditDir = path.resolve(readFlagValue(argv, '--dir').value || '.audit');
  const planFile = readFlagValue(argv, '--plan').value;

  const wantStepBack = argv.includes('--step-back');
  const arm = readFlagValue(argv, '--step-back-arm').value || 'same';
  if (!['same', 'different', 'higher'].includes(arm)) throw new ArgvError('audit-structural-card: --step-back-arm must be same, different or higher.');
  if (argv.includes('--revoke-meta-admission')) return revokeMetaAdmission({ sid, mode, auditDir, argv });
  const { card, text } = await buildStructuralCard({ sid, mode, round: roundRes.value, planFile, caps, auditDir });
  const provider = wantStepBack ? createStepBackProvider(arm) : null;
  const section = await buildCheckpointSection({
    sid, mode, round: roundRes.value, planFile, auditDir, stepBack: wantStepBack, provider: provider?.call ?? null, model: provider?.model ?? null,
  });
  if (section) card.stepBack = { checkpoint: section.checkpoint, signals: section.signals, record: section.record };
  if (!argv.includes('--no-write')) writeCardFile(auditDir, cardFileName(sid, roundRes.value), card);
  if (card.productivity && !argv.includes('--no-write')) {
    // Recorded only past the soft cap (recordCapStop refuses otherwise), as `on-demand`: the operator may still CONTINUE.
    // Same decision key as a later refusal of this round, so the two paths record ONE row.
    const rec = await recordCapStop({ sid, mode, round: roundRes.value, caps, productivity: card.productivity, runId: card.productivity.lastRunId, trigger: 'on-demand' });
    process.stderr.write(rec.recorded ? '  [round-cap] cap reached, recorded (round_cap_reached, on-demand)\n' : `  [round-cap] cap-reached telemetry not recorded (${rec.reason})\n`);
  }
  // The automatic meta-review's decisions for this session (docs/plans/meta-step-back-at-cap.md), when any exist.
  const metaLines = (await import('./lib/audit/meta-review.mjs')).renderMetaLog({ auditDir, sid });
  if (argv.includes('--json')) console.log(JSON.stringify(card, null, 2));
  else console.log([section ? [text, '', ...section.lines].join('\n') : text, ...(metaLines.length ? ['', ...metaLines] : [])].join('\n'));
}

/** Revoke every honoured, un-revoked meta-review admission of this session: the fold then admits nothing further. */
async function revokeMetaAdmission({ sid, mode, auditDir, argv }) {
  const by = readFlagValue(argv, '--by').value;
  const reason = readFlagValue(argv, '--reason').value;
  if (!sid || !by || !reason || reason.trim().length < MIN_PAST_CAP_REASON_CHARS) {
    throw new ArgvError(`audit-structural-card: --revoke-meta-admission needs --sid, --by "<name>" and --reason "<why, at least ${MIN_PAST_CAP_REASON_CHARS} characters>".`);
  }
  const m = await import('./lib/audit/meta-review.mjs');
  const log = m.readMetaLog(m.metaLogPath(auditDir, sid));
  if (log.malformed) throw new Error(`decision log is malformed (${log.malformed}); nothing revoked`);
  const fold = m.foldMetaLog(log.events);
  const open = [...fold.decisions.values()].filter((d) => d.mode === mode && d.guard?.effect === 'admit' && d.guard.honoured && !fold.overridden.has(d.attemptId));
  if (!open.length) { console.log(`No open meta-review admission for ${sid} (${mode}).`); return; }
  for (const d of open) {
    const out = await m.appendMetaOverride({ auditDir, sid, attemptId: d.attemptId, kind: 'revoke', by, reason, source: 'revoke-meta-admission' });
    if (!out.ok) throw new Error(`revoke of ${d.attemptId} not recorded (${out.reason})`);
    console.log(`Revoked ${d.attemptId} (admitted through round ${d.admittedThrough}); the next past-cap round needs --past-cap.`);
  }
}

if (isInvokedAsScript(import.meta.url)) {
  try {
    await main();
    await finishAndExit(0);
  } catch (err) {
    if (err instanceof ArgvError) { console.error(err.message); await finishAndExit(2); }
    console.error(`audit-structural-card: ${err?.message || err}`);
    await finishAndExit(1);
  }
}
