#!/usr/bin/env node
/**
 * @fileoverview Final-reviewer bake-off: run N arms over the SAME real audit
 * transcripts and compare, for the "is a cheaper final reviewer good enough?"
 * question (docs/research/experiment-4-cheap-final-reviewer-smoke.md).
 *
 * ## Why this is a passive window, and what that costs
 *
 * The repo's standing rule is that a MODEL SWAP is synchronous — run it when
 * the model ships, adjudicate in the same sitting — because passive collection
 * killed arm-eval and produced five false "window met" reads. That rule is not
 * being waived here; it genuinely cannot be satisfied for THIS role:
 *
 * - The known-defect corpus (18 curated cases) evaluates the AUDITOR role: can
 *   a model find a planted defect in a diff? The final reviewer's job is to
 *   review a *deliberation* — rounds of findings, challenges and rulings — and
 *   judge whether it was sound. A synthesized transcript with no real rounds
 *   tests the auditor question wearing the final reviewer's name.
 * - So real transcripts from real audits are the only valid input, and those
 *   only appear as ordinary work happens.
 *
 * The slot is available because the final-review 2nd-gate shadow CLOSED on
 * 2026-07-28 (verdict KEEP). This does not add a sixth collector; it reuses the
 * one that just freed up.
 *
 * What the doctrine still demands, and this script enforces:
 * 1. **Readiness is counted, never eyeballed.** `--status` reports the real
 *    number of eligible transcripts. Five false "window met" reads came from
 *    eyeballing.
 * 2. **Eligibility is explicit.** Only `mode: 'code'` transcripts with a
 *    resolvable plan count — a plan-mode transcript exercises a different
 *    prompt path, and a transcript whose plan file has since been deleted
 *    cannot be replayed.
 * 3. **Under-target refuses to run.** `--run` below the target exits non-zero
 *    rather than producing a thin result that reads like a verdict. Override
 *    is explicit (`--min`), never silent.
 * 4. **Adjudicate in the same sitting** the window fills. A result left
 *    unadjudicated is how the last experiment became unreadable.
 *
 * Usage:
 *   node scripts/final-review-bakeoff.mjs --status
 *   node scripts/final-review-bakeoff.mjs --run --arms opus,kimi-k3,glm-5.2
 *   node scripts/final-review-bakeoff.mjs --run --min 4 --out .audit/bakeoff
 *
 * @module scripts/final-review-bakeoff
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, hasFlag, emit } from './lib/cli-io.mjs';

const KNOWN_FLAGS = ['--status', '--run', '--arms', '--min', '--out', '--dir', '--json', '--timeout-ms', '--selfcheck-relocation'];

/** Target window size. Below this a `--run` refuses (rule 3). */
const DEFAULT_MIN = 8;

/** Arm registry: label → how to invoke gemini-review.mjs for it. */
const ARMS = Object.freeze({
  opus: { provider: 'anthropic', model: null, env: { CLAUDE_BACKEND: 'sdk' } },
  'kimi-k3': { provider: 'openrouter', model: 'moonshotai/kimi-k3', env: {} },
  'glm-5.2': { provider: 'openrouter', model: 'z-ai/glm-5.2', env: {} },
});

/**
 * Enumerate transcripts eligible for a final-review replay.
 * Pure w.r.t. its inputs so the eligibility rule is testable without a fixture tree.
 *
 * @param {string} dir
 * @param {{readFile?: Function, readdir?: Function, exists?: Function}} [io]
 */
export function findEligibleTranscripts(dir, io = {}) {
  const readdir = io.readdir || ((d) => (fs.existsSync(d) ? fs.readdirSync(d) : []));
  const readFile = io.readFile || ((p) => fs.readFileSync(p, 'utf8'));
  const exists = io.exists || ((p) => fs.existsSync(p));

  const eligible = [];
  const rejected = [];
  for (const name of readdir(dir)) {
    if (!/transcript.*\.json$/i.test(name)) continue;
    const full = path.join(dir, name);
    let t;
    try { t = JSON.parse(readFile(full)); } catch { rejected.push({ name, why: 'unparseable' }); continue; }
    // A plan-mode transcript drives a DIFFERENT prompt path (plan quality, not
    // code quality) — mixing them would silently average two questions.
    if (t.mode !== 'code') { rejected.push({ name, why: `mode=${t.mode ?? 'unset'}` }); continue; }
    const plan = typeof t.plan === 'string' ? t.plan.trim() : '';
    if (!plan) { rejected.push({ name, why: 'no plan reference' }); continue; }
    // A transcript whose plan has since been deleted cannot be replayed —
    // counting it would inflate readiness against inputs that cannot run.
    if (!exists(plan)) { rejected.push({ name, why: `plan missing: ${plan}` }); continue; }
    eligible.push({ name, path: full, plan, rounds: Array.isArray(t.rounds) ? t.rounds.length : 0 });
  }
  eligible.sort((a, b) => a.name.localeCompare(b.name));
  return { eligible, rejected };
}

/** Readiness verdict — counted, never eyeballed (rule 1). */
export function assessWindow(eligible, min) {
  return {
    count: eligible.length,
    target: min,
    ready: eligible.length >= min,
    verdict: eligible.length >= min
      ? `READY — ${eligible.length}/${min} eligible transcripts; run the bake-off and adjudicate in the same sitting.`
      : `COLLECTING — ${eligible.length}/${min}. Transcripts accrue from ordinary /audit-code and /cycle runs; nothing to do but work.`,
  };
}

function runArm(armLabel, transcript, outDir, timeoutMs) {
  const arm = ARMS[armLabel];
  const outFile = path.join(outDir, `${armLabel}--${transcript.name.replace(/\.json$/, '')}.json`);
  const env = { ...process.env, ...arm.env, GEMINI_REVIEW_TIMEOUT_MS: String(timeoutMs) };
  if (arm.model) env.FINAL_REVIEW_MODEL = arm.model;
  const args = ['scripts/gemini-review.mjs', 'review', transcript.plan, transcript.path,
    '--provider', arm.provider, '--out', outFile];
  const started = Date.now();
  const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', timeout: timeoutMs + 60000 });
  const elapsedMs = Date.now() - started;
  if (r.status !== 0 || !fs.existsSync(outFile)) {
    const why = (r.stderr || '').split('\n').filter((l) => /FAILED|Error/.test(l)).slice(-1)[0] || `exit ${r.status}`;
    return { arm: armLabel, transcript: transcript.name, ok: false, elapsedMs, error: why.trim().slice(0, 200) };
  }
  const res = JSON.parse(fs.readFileSync(outFile, 'utf8'));
  const findings = res.new_findings || [];
  const REQ = ['id', 'severity', 'category', 'section', 'detail', 'risk', 'recommendation'];
  // Schema compliance is measured, not assumed — it was the whole finding of
  // the first smoke test, and a regression here is silent (validation is
  // warn-and-keep, so degraded rows reach the store rather than failing).
  const nonCompliant = findings.filter((f) => REQ.some((k) => f[k] === undefined || f[k] === null || f[k] === '')).length;
  return {
    arm: armLabel, transcript: transcript.name, ok: true, elapsedMs,
    verdict: res.verdict, findings: findings.length, nonCompliant,
    severities: findings.reduce((a, f) => { a[f.severity] = (a[f.severity] || 0) + 1; return a; }, {}),
  };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'final-review-bakeoff' });

  const dir = argOption('dir', '.audit');
  const min = Number(argOption('min', String(DEFAULT_MIN)));
  if (!Number.isInteger(min) || min < 1) throw new ArgvError('final-review-bakeoff: --min must be a positive integer');
  const asJson = hasFlag('json');

  const { eligible, rejected } = findEligibleTranscripts(dir);
  const window = assessWindow(eligible, min);

  if (!hasFlag('run')) {
    if (asJson) return emit({ ok: true, ...window, eligible: eligible.map((e) => e.name), rejected });
    console.log(`\n${window.verdict}\n`);
    for (const e of eligible) console.log(`  eligible  ${e.name}  (plan: ${e.plan}, ${e.rounds} round(s))`);
    // Rejections are printed, never silently dropped — a transcript excluded
    // for a fixable reason (deleted plan) is actionable, not noise.
    for (const r of rejected) console.log(`  skipped   ${r.name}  — ${r.why}`);
    return undefined;
  }

  if (!window.ready) {
    console.error(`\n${window.verdict}`);
    console.error(`Refusing to run below target: ${eligible.length} transcript(s) cannot support a swap decision,`);
    console.error(`and a thin result reads like a verdict. Pass --min ${eligible.length} to override deliberately.\n`);
    process.exit(3);
  }

  const armLabels = String(argOption('arms', 'opus,kimi-k3,glm-5.2')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const a of armLabels) if (!ARMS[a]) throw new ArgvError(`final-review-bakeoff: unknown arm "${a}". Known: ${Object.keys(ARMS).join(', ')}`);
  const outDir = argOption('out', '.audit/bakeoff');
  const timeoutMs = Number(argOption('timeout-ms', '300000'));
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const t of eligible) {
    for (const a of armLabels) {
      process.stderr.write(`  [bakeoff] ${a} × ${t.name} …\n`);
      const r = runArm(a, t, outDir, timeoutMs);
      results.push(r);
      process.stderr.write(`  [bakeoff]   ${r.ok ? `${r.verdict} · ${r.findings} finding(s) · ${r.nonCompliant} non-compliant · ${(r.elapsedMs / 1000).toFixed(0)}s` : `FAILED: ${r.error}`}\n`);
    }
  }

  const summary = {};
  for (const a of armLabels) {
    const rs = results.filter((r) => r.arm === a);
    const ok = rs.filter((r) => r.ok);
    summary[a] = {
      runs: rs.length, completed: ok.length, failed: rs.length - ok.length,
      totalFindings: ok.reduce((s, r) => s + r.findings, 0),
      nonCompliantFindings: ok.reduce((s, r) => s + r.nonCompliant, 0),
      medianLatencyMs: ok.length ? ok.map((r) => r.elapsedMs).sort((x, y) => x - y)[Math.floor(ok.length / 2)] : null,
    };
  }
  const out = { ok: true, transcripts: eligible.length, arms: armLabels, summary, results,
    note: 'Counts are not a quality ranking. Adjudicate the findings by hand, in this sitting.' };
  fs.writeFileSync(path.join(outDir, 'bakeoff-summary.json'), JSON.stringify(out, null, 2));
  return emit(out);
}

// Direct-invocation guard (repo idiom, e.g. arch-coverage-gate.mjs): without it
// a plain `import` of this module for its pure helpers would execute the CLI —
// scanning .audit/ and printing a status listing as an import side effect.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch (err) {
    if (err instanceof ArgvError) { console.error(err.message); process.exit(2); }
    throw err;
  }
}
