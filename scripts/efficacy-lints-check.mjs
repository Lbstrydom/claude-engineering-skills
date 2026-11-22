#!/usr/bin/env node
/**
 * @fileoverview CLI wiring for the deterministic efficacy lints (GREEN ≠ REALIZED, Cluster A).
 * Loads the committed `efficacy-lints.config.json` (off by default → SILENT no-op), runs the
 * recognizers, prints the per-rule status + coverage + findings, and applies the gate policy:
 *   - advisory (default / `gate:false`) → always exit 0.
 *   - `gate:true` → exit 1 on `findings` OR `unverified` (fail-closed: "you asked me to gate and I
 *     couldn't verify" is a failure, not a pass).
 * Wiring point is a dedicated CLI (not phase7-check.mjs, which is the ML-readiness check; not
 * config.mjs, which is env-only) — chain `npm run efficacy:check` into the pre-push as advisory.
 *
 * @module scripts/efficacy-lints-check
 */
import './lib/help-guard-run.mjs'; import process from 'node:process';
import { runEfficacyLints, loadEfficacyConfig } from './lib/efficacy-lints.mjs';

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  const root = process.cwd();
  const config = loadEfficacyConfig(root);
  if (!config.enabled) {
    // Opt-in by design (a synced script: every consumer lacks a config), so this stays exit 0, but it must
    // never read as a clean run: say on stderr that nothing was checked (stdout stays empty for callers).
    process.stderr.write('efficacy-lints: NOT RUN (no efficacy-lints.config.json, or enabled:false) - nothing was checked\n');
    process.exitCode = 0; // return, never process.exit(): a forced exit can drop a pending pipe write (audit M2)
    return;
  }

  const { status, ruleResults, findings, coverage } = runEfficacyLints({ root, config, modelHint: config.modelHint });
  process.stdout.write(`efficacy-lints: ${status} (scanned ${coverage.scannedFiles} files, ${coverage.applicableSites} sites)\n`);
  for (const [id, r] of Object.entries(ruleResults)) {
    process.stdout.write(`  ${id.padEnd(18)} ${r.status}${r.skipReason ? `  (${r.skipReason})` : ''}\n`);
  }
  for (const f of findings) {
    process.stdout.write(`  [${f.confidence === 'high' ? 'FINDING' : 'review '}] ${f.ruleId} ${f.loc} — ${f.message}\n`);
  }
  // Gate policy (advisory unless config.gate). `unverified` fails closed ONLY when gating.
  if (config.gate && (status === 'findings' || status === 'unverified')) {
    process.stderr.write(`efficacy-lints: gate:true and status=${status} → blocking.\n`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => { process.stderr.write(`[efficacy-lints] ${err.stack || err.message}\n`); process.exit(2); });
