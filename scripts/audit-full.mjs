#!/usr/bin/env node
/**
 * @fileoverview Fused audit pipeline — runs `openai-audit.mjs` then
 * `gemini-review.mjs` in one invocation. Closes the recurring gap where
 * the GPT audit was run but the MANDATORY Gemini final review was
 * skipped (per Step 7 of audit-plan / audit-code SKILL.md).
 *
 * Usage mirrors `openai-audit.mjs`:
 *   node scripts/audit-full.mjs plan <plan-file> [openai-audit args]
 *   node scripts/audit-full.mjs code <plan-file> [openai-audit args]
 *
 * Exit codes:
 *   0  GPT + Gemini both succeeded; verdict in stdout summary
 *   1  GPT failed
 *   2  Gemini failed (GPT result still emitted)
 *   3  Gemini returned REJECT (operator review required)
 *
 * Skip Gemini explicitly with `--no-final-review` only when both
 * GEMINI_API_KEY and ANTHROPIC_API_KEY are unavailable.
 *
 * @module scripts/audit-full
 */
import './lib/load-env.mjs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT = path.resolve(import.meta.dirname, '..');

function nowSid(prefix) {
  return `${prefix}-${Date.now()}`;
}

function tmpFile(name) {
  return path.join(os.tmpdir(), name);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: false, ...opts });
  return { code: r.status ?? 1, signal: r.signal };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`Usage: node scripts/audit-full.mjs <plan|code> <plan-file> [openai-audit args]\n\n` +
      `Fused pipeline: runs openai-audit.mjs then gemini-review.mjs.\n` +
      `Closes the gap where Gemini final review (Step 7) is mandatory but\n` +
      `frequently skipped when audits are invoked manually.\n\n` +
      `Flags:\n` +
      `  --no-final-review   Skip Gemini (only legitimate when both GEMINI_API_KEY\n` +
      `                      and ANTHROPIC_API_KEY are absent — rare).\n`);
    process.exit(args[0] === '--help' || args[0] === '-h' ? 0 : 2);
  }

  const noFinalReview = args.includes('--no-final-review');
  const filteredArgs = args.filter(a => a !== '--no-final-review');

  const mode = filteredArgs[0];
  const planFile = filteredArgs[1];
  if (!['plan', 'code', 'rebuttal'].includes(mode)) {
    process.stderr.write(`audit-full: first arg must be plan|code|rebuttal, got: ${mode}\n`);
    process.exit(2);
  }
  if (!planFile) {
    process.stderr.write('audit-full: plan file path required\n');
    process.exit(2);
  }

  const sid = nowSid(`audit-${mode}`);
  const gptOut = tmpFile(`${sid}-gpt.json`);

  // Inject --out so we can chain Gemini against the result JSON, unless
  // the caller already specified --out.
  const auditArgs = [...filteredArgs];
  if (!auditArgs.includes('--out')) {
    auditArgs.push('--out', gptOut);
  }

  process.stderr.write(`\n══ audit-full: GPT round (${mode}) ══\n`);
  const gpt = run('node', [path.join(ROOT, 'scripts/openai-audit.mjs'), ...auditArgs]);
  if (gpt.code !== 0) {
    process.stderr.write(`audit-full: GPT audit exited with ${gpt.code}\n`);
    process.exit(1);
  }

  // Resolve the actual --out the GPT script wrote to (caller may have set their own)
  const outIdx = auditArgs.indexOf('--out');
  const transcriptPath = outIdx !== -1 ? auditArgs[outIdx + 1] : gptOut;
  if (!fs.existsSync(transcriptPath)) {
    process.stderr.write(`audit-full: expected GPT output at ${transcriptPath} but it was not written. Skipping Gemini.\n`);
    process.exit(2);
  }

  if (noFinalReview) {
    process.stderr.write('\n══ audit-full: Gemini SKIPPED (--no-final-review) ══\n');
    process.stderr.write('  Document this skip — Step 7 is mandatory unless both GEMINI_API_KEY and ANTHROPIC_API_KEY are absent.\n');
    process.exit(0);
  }

  const geminiOut = tmpFile(`${sid}-gemini.json`);

  // Thread the cloud run id into the final review. `--run-id` is what ARMS the
  // reviewer's store write — without it `runShadowAndPersist` returns early and
  // silently, leaving gemini_verdict, final_review_model and the shadow
  // token/latency telemetry unrecorded for every audit run through this script.
  // Unlike audit-loop.mjs (which mints the id itself), this script doesn't know
  // the id until the GPT audit reports it, so read it back off the result JSON
  // the same way skills/audit-code/SKILL.md instructs a human to. Best-effort:
  // a malformed or cloud-disabled result simply means no id to pass, which is
  // exactly the pre-existing behaviour rather than a new failure mode.
  let cloudRunId = null;
  try {
    cloudRunId = JSON.parse(fs.readFileSync(transcriptPath, 'utf-8'))?._cloudRunId ?? null;
  } catch { /* unreadable/unparseable result — proceed without run-id */ }
  if (!cloudRunId) {
    process.stderr.write('  [audit-full] no _cloudRunId in GPT result — final-review telemetry will not be recorded.\n');
  }

  process.stderr.write(`\n══ audit-full: Gemini final review ══\n`);
  const gemini = run('node', [
    path.join(ROOT, 'scripts/gemini-review.mjs'), 'review',
    planFile, transcriptPath,
    '--out', geminiOut,
    ...(cloudRunId ? ['--run-id', cloudRunId] : []),
  ]);
  if (gemini.code !== 0) {
    process.stderr.write(`audit-full: Gemini review exited with ${gemini.code}\n`);
    process.exit(2);
  }

  // Surface the verdict at the top level so callers can branch on it.
  try {
    const result = JSON.parse(fs.readFileSync(geminiOut, 'utf-8'));
    process.stdout.write(`\nFinal verdict: ${result.verdict}\n`);
    process.stdout.write(`  GPT result   : ${transcriptPath}\n`);
    process.stdout.write(`  Gemini result: ${geminiOut}\n`);
    if (result.verdict === 'REJECT') process.exit(3);
  } catch (err) {
    process.stderr.write(`audit-full: could not parse Gemini result at ${geminiOut}: ${err.message}\n`);
    process.exit(2);
  }

  process.exit(0);
}

main();
