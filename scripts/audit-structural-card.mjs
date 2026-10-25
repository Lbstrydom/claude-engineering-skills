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
 * Read-only apart from the card file it writes next to the round results. It
 * creates no debt and no proposal; the verdict is a hint and the call is the
 * operator's. Exit 0 whenever the card was produced, 2 on an argument error.
 *
 * @module scripts/audit-structural-card
 */
import './lib/load-env.mjs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { AUDIT_ROUND_CAPS, cardFileName, parseRoundFlag, readFlagValue } from './lib/audit/round-cap.mjs';
import { buildStructuralCard, writeCardFile } from './lib/audit/structural-card.mjs';

const KNOWN_FLAGS = ['--sid', '--mode', '--round', '--plan', '--dir', '--json', '--no-write', '--selfcheck-relocation'];

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

  const { card, text } = await buildStructuralCard({ sid, mode, round: roundRes.value, planFile, caps, auditDir });
  if (!argv.includes('--no-write')) writeCardFile(auditDir, cardFileName(sid, roundRes.value), card);
  if (argv.includes('--json')) console.log(JSON.stringify(card, null, 2)); else console.log(text);
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
