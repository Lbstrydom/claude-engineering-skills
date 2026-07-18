#!/usr/bin/env node
/**
 * @fileoverview arch:coverage-gate — the enforcement exit code for observed-
 * graph coverage, deliberately DOWNSTREAM of `arch:render`.
 *
 * Why a separate command rather than an exit code on render (§2.1.6, R3 H4):
 * `dashboard:setup` is `arch:refresh && arch:render && dashboard:build`, so a
 * non-zero render would abort the chain and the dashboard would NOT build
 * precisely when it has yellow to show. The gate must never be able to
 * suppress the artifact that displays the problem. So render always exits 0
 * and this owns the verdict.
 *
 * Wired into the pre-push `check`, NOT into `dashboard:setup`.
 *
 * Exit codes (matching visual-audit's convention):
 *   0 — verified / unknown, or enforce=false (report-only)
 *   2 — degraded / unverified under enforcement, or unusable config
 *   1 — tool error (unreadable envelope, bad JSON)
 *
 * Plan: docs/plans/observed-graph-coverage-honesty.md §2.1.6
 *
 * @module scripts/arch-coverage-gate
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { OBSERVED_FILE, ObservedDepsSchema } from './lib/observed-deps.mjs';
import { loadCoverageConfig } from './lib/symbol-index/domain-tagger.mjs';
import { coverageGateExitCode, GRAPH_STATUS } from './lib/symbol-index/graph-verdict.mjs';

function log(msg) { process.stderr.write(`${msg}\n`); }

function main() {
  // AGENTS.md CLI smoke contract — proves imports survive relocation into a
  // consumer's scripts/.claude-skills/ tree.
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }

  const repoRoot = path.resolve(process.cwd());
  const envelopePath = path.join(repoRoot, OBSERVED_FILE);

  // The config is read with a COLLECTING warn callback, not the default
  // stderr one. §2.1.4 "BINDING ON PHASE 4": graceful degradation is right
  // for arch:render (a malformed domain-map must not take down the artifact
  // that shows the problem) but is a hole in the GATE. `enforce: "true"` — a
  // string — parses as invalid, falls back to enforce:false, and hands back a
  // gate that reports success while enforcing nothing. Green without having
  // checked anything, one typo away. So the gate refuses to run on a config
  // it could not parse cleanly.
  //
  // But ONLY on `invalid` warnings (Cluster B final gate, HIGH). `unknown`
  // exists precisely so a consumer on an older sync survives a newer schema
  // key; treating it as fatal would turn the forward-compat mechanism into
  // the breakage it was built to prevent — every consumer's CI failing the
  // moment someone adds a key upstream.
  const configWarnings = [];
  const config = loadCoverageConfig(repoRoot, (m, kind) => {
    if (kind === 'unknown') log(`arch:coverage-gate: note — ${m} (forward-compat; not fatal)`);
    else configWarnings.push(m);
  });
  if (configWarnings.length > 0) {
    log('arch:coverage-gate: FAILED — the coverage config did not parse cleanly.');
    log('  A gate cannot enforce a policy it had to guess at. Fix these, then re-run:');
    for (const w of configWarnings) log(`    · ${w}`);
    process.exit(2);
  }

  if (!fs.existsSync(envelopePath)) {
    // Not a gate failure: a repo that has never rendered has nothing to judge.
    // Failing here would block first-time consumers for a non-problem.
    log(`arch:coverage-gate: no ${OBSERVED_FILE} — run \`npm run arch:render\` first (skipping)`);
    process.exit(0);
  }

  let envelope;
  try {
    envelope = ObservedDepsSchema.parse(JSON.parse(fs.readFileSync(envelopePath, 'utf-8')));
  } catch (err) {
    log(`arch:coverage-gate: could not read ${OBSERVED_FILE} — ${err.message}`);
    process.exit(1);   // tool error, not a verdict
  }

  // A pre-feature envelope has no `coverage` block. That is `unknown`, which
  // does NOT fail the gate — we cannot fault a repo for a measurement that
  // did not exist when it rendered. It also must never read as `verified`.
  const verdict = envelope.coverage?.verdict
    ?? { status: GRAPH_STATUS.UNKNOWN, reason: 'not_measured' };

  const exitCode = coverageGateExitCode(verdict, config);
  const label = `${verdict.status.toUpperCase()}${verdict.reason ? ` (${verdict.reason})` : ''}`;

  if (exitCode === 0 && !config.enforce
      && (verdict.status === GRAPH_STATUS.DEGRADED || verdict.status === GRAPH_STATUS.UNVERIFIED)) {
    // Report-only stage: say plainly that this WOULD have failed, so the
    // rollout's first cycle produces real signal instead of silence.
    log(`arch:coverage-gate: ${label} — report-only (enforce=false); this would FAIL under enforcement`);
  } else if (exitCode === 0) {
    log(`arch:coverage-gate: ${label}`);
  } else {
    log(`arch:coverage-gate: FAILED — observed graph is ${label}.`);
    log('  The graph is not trustworthy enough to be an authority. Either fix coverage');
    log('  or set `coverage.enforce: false` in .audit-loop/domain-map.json deliberately.');
  }

  const cov = envelope.coverage;
  if (cov?.extraction) {
    log(`  extraction: ${cov.extraction.cruised}/${cov.extraction.eligible} eligible files cruised`
      + `${cov.stale ? ' [copied forward — not measured this run]' : ''}`);
  }
  if (cov?.attribution) {
    log(`  attribution: ${cov.attribution.attributed}/${cov.attribution.attributable} attributable edges`);
  }

  process.exit(exitCode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
