#!/usr/bin/env node
/**
 * @fileoverview Replay CLI — counterfactual evaluation of a candidate
 * policy against historical learning_decisions.  Used to validate v2
 * promotion candidates per master plan §5 promotion gates.
 *
 *   node scripts/learning/replay.mjs <decision_type>
 *     [--policy <module-path>]   default: built-in historical baseline
 *     [--baseline <module-path>] default: historical-choice baseline
 *     [--since <duration>]       default: 30d (e.g. 7d, 14d, 90d)
 *     [--repo-id <uuid>]         filter by repo UUID (audit_repos.id)
 *     [--repo <uuid>]            alias for --repo-id (NOT a name lookup)
 *     [--format json|markdown]   default: json
 *
 * CLI output contract (per master plan §6):
 *   - stdout: JSON by default (the comparison-result object)
 *   - --format markdown: switches stdout to a comparison table
 *   - stderr: progress logs (cloud read pages, sample sizes, etc.)
 *
 * Plan: docs/plans/adaptive-learning-phase-3-replay.md §2 (replay CLI)
 *
 * @module scripts/learning/replay
 */
import 'dotenv/config';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  replay,
  passSelectionReward,
  convergencePredictReward,
  archMemoryBandReward,
  historicalBaseline,
} from '../lib/learning/replay.mjs';

const DEFAULT_REWARDS = {
  pass_selection:      passSelectionReward,
  convergence_predict: convergencePredictReward,
  arch_memory_band:    archMemoryBandReward,
};

// ── Duration parsing ──────────────────────────────────────────────────────

const DURATION_RE = /^(\d+)(ms|s|m|h|d|w)?$/i;
const DURATION_MULTIPLIERS = {
  ms: 1,
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000,
};

export function parseDuration(input, fallbackMs) {
  if (!input) return fallbackMs;
  const m = DURATION_RE.exec(String(input).trim());
  if (!m) return fallbackMs;
  const num = parseInt(m[1], 10);
  const unit = (m[2] || 'ms').toLowerCase();
  const mult = DURATION_MULTIPLIERS[unit];
  if (!mult) return fallbackMs;
  return num * mult;
}

// ── Markdown rendering ────────────────────────────────────────────────────

export function renderMarkdownReport(result) {
  const lines = [
    `# Replay report — \`${result.decisionType}\``,
    '',
    `- Sample size: **${result.sampleSize}** decisions`,
    `- Window:      \`${(result.sinceMs / (24 * 60 * 60 * 1000)).toFixed(1)}d\``,
    '',
    '## Reward distributions',
    '',
    '| Policy    | mean   | p50    | p90    | total   |',
    '|-----------|--------|--------|--------|---------|',
    `| baseline  | ${fmtNum(result.baselineDist.mean)} | ${fmtNum(result.baselineDist.p50)} | ${fmtNum(result.baselineDist.p90)} | ${fmtNum(result.baselineDist.total)} |`,
    `| candidate | ${fmtNum(result.candidateDist.mean)} | ${fmtNum(result.candidateDist.p50)} | ${fmtNum(result.candidateDist.p90)} | ${fmtNum(result.candidateDist.total)} |`,
    '',
    '## Delta',
    '',
    `- mean delta: **${fmtNum(result.deltaSummary.meanDelta)}**`,
    `- candidate-better: **${(result.deltaSummary.candidateBetterPct * 100).toFixed(1)}%** of decisions`,
    `- ties: ${result.deltaSummary.ties}`,
    '',
    '_Promotion gate (master plan §5)_: pass_selection ≤5% recall loss vs all-pass; convergence_predict ≤2% false-stop rate; arch_memory_band ≥10% precision lift on reuse band.',
  ];
  return lines.join('\n');
}

function fmtNum(n) {
  if (!Number.isFinite(n)) return 'NaN';
  return Math.abs(n) >= 1 ? n.toFixed(2) : n.toFixed(4);
}

// ── Policy loader ─────────────────────────────────────────────────────────

async function loadPolicy(modulePath, fallback) {
  if (!modulePath) return fallback;
  // Resolve relative to cwd; convert to file:// URL for cross-platform import.
  const abs = path.isAbsolute(modulePath) ? modulePath : path.resolve(process.cwd(), modulePath);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  if (typeof mod.default !== 'function' && typeof mod.policy !== 'function') {
    throw new Error(`Policy module ${modulePath} must export default OR named 'policy' as a function`);
  }
  return mod.default || mod.policy;
}

// ── CLI entry ─────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

export async function runReplayCli(args) {
  const positional = args.filter(a => !a.startsWith('--'));
  const decisionType = positional[0];
  if (!decisionType) {
    process.stderr.write('Usage: replay <decision_type> [--policy <path>] [--baseline <path>] [--since 30d] [--repo <name>] [--format json|markdown]\n');
    return { ok: false, error: 'missing-decision-type' };
  }

  const optIdx = (name) => args.indexOf(`--${name}`);
  const optVal = (name) => { const i = optIdx(name); return i >= 0 ? args[i + 1] : null; };

  const policyPath   = optVal('policy');
  const baselinePath = optVal('baseline');
  const sinceStr     = optVal('since') || '30d';
  // Audit-fix Phase 3 R1 H4: accept BOTH --repo-id (canonical, UUID) and
  // --repo (alias).  The flag was advertised in the docstring but only
  // --repo-id was wired — fix the inconsistency at the CLI surface.
  const repoId       = optVal('repo-id') || optVal('repo');
  const format       = optVal('format') || 'json';

  const sinceMs = parseDuration(sinceStr, 30 * 24 * 60 * 60 * 1000);

  // Load candidate + baseline.  When no candidate is provided, fall back
  // to the historical baseline (so the run effectively replays "what we
  // already shipped") — useful for sanity-checking the rewardFn.
  const candidatePolicy = await loadPolicy(policyPath, historicalBaseline);
  const baselinePolicy  = await loadPolicy(baselinePath, historicalBaseline);

  const rewardFn = DEFAULT_REWARDS[decisionType];
  if (!rewardFn) {
    return { ok: false, error: `no built-in rewardFn for decision_type='${decisionType}' (supported: ${Object.keys(DEFAULT_REWARDS).join(', ')})` };
  }

  process.stderr.write(`[replay] decisionType=${decisionType} sinceMs=${sinceMs} repoId=${repoId || 'all'}\n`);

  const result = await replay({
    decisionType,
    sinceMs,
    candidatePolicy,
    baselinePolicy,
    rewardFn,
    repoId,
  });

  if (format === 'markdown') {
    process.stdout.write(renderMarkdownReport(result) + '\n');
  } else {
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  return result;
}

if (isMain) {
  const result = await runReplayCli(process.argv.slice(2));
  process.exit(result.ok === false ? 1 : 0);
}
