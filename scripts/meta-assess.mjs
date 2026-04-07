#!/usr/bin/env node
/**
 * @fileoverview Periodic meta-assessment of audit-loop performance.
 *
 * Every N audit runs (default 4), evaluates system health:
 *   - FP rate per pass (dismissed / total)
 *   - Recurring FP patterns
 *   - Signal quality (findings that led to code changes)
 *   - Severity calibration accuracy
 *   - Convergence speed
 *   - Pipeline variant A/B comparison
 *
 * Deterministic metrics always computed. LLM assessment optional (interprets
 * metrics + recommends prompt changes). Results stored in
 * .audit/meta-assessments.jsonl for trend tracking.
 *
 * Usage:
 *   node scripts/meta-assess.mjs                    # Full assessment
 *   node scripts/meta-assess.mjs --metrics-only     # Deterministic only
 *   node scripts/meta-assess.mjs --json             # JSON output
 *   node scripts/meta-assess.mjs --force            # Run even if interval not reached
 *   node scripts/meta-assess.mjs --out <file>       # Write to file
 *
 * @module scripts/meta-assess
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { loadOutcomes, computePassEffectiveness, FalsePositiveTracker } from './lib/findings.mjs';
import { PromptBandit } from './bandit.mjs';
import { assessmentConfig, PASS_NAMES } from './lib/config.mjs';
import { MetaAssessmentSchema, zodToGeminiSchema } from './lib/schemas.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

// ── Deterministic Metrics ───────────────────────────────────────────────────

/**
 * Compute assessment metrics from outcome data. Pure function, no LLM.
 * @param {object[]} outcomes - Raw outcome records from outcomes.jsonl
 * @param {FalsePositiveTracker} fpTracker
 * @param {PromptBandit} bandit
 * @param {{ windowSize?: number }} options
 * @returns {object} Structured metrics object
 */
export function computeAssessmentMetrics(outcomes, fpTracker, bandit, options = {}) {
  const windowSize = options.windowSize || assessmentConfig.windowSize;
  const windowed = outcomes.slice(-windowSize);

  if (windowed.length === 0) {
    return emptyMetrics();
  }

  // Window metadata
  const firstTs = windowed[0]?.timestamp || 0;
  const lastTs = windowed[windowed.length - 1]?.timestamp || Date.now();
  const window = {
    fromRun: windowed[0]?.round || 0,
    toRun: windowed[windowed.length - 1]?.round || 0,
    outcomeCount: windowed.length,
    dateRange: `${new Date(firstTs).toISOString().slice(0, 10)} to ${new Date(lastTs).toISOString().slice(0, 10)}`,
  };

  // ── FP Rate ──────────────────────────────────────────────────────────────
  const dismissed = windowed.filter(o => !o.accepted).length;
  const fpRateOverall = windowed.length > 0 ? dismissed / windowed.length : 0;

  const byPass = {};
  for (const pass of PASS_NAMES) {
    const passOutcomes = windowed.filter(o => o.pass === pass);
    if (passOutcomes.length > 0) {
      byPass[pass] = passOutcomes.filter(o => !o.accepted).length / passOutcomes.length;
    }
  }

  // Trend: compare first half vs second half
  const mid = Math.floor(windowed.length / 2);
  const firstHalf = windowed.slice(0, mid);
  const secondHalf = windowed.slice(mid);
  const fpFirst = firstHalf.length > 0 ? firstHalf.filter(o => !o.accepted).length / firstHalf.length : 0;
  const fpSecond = secondHalf.length > 0 ? secondHalf.filter(o => !o.accepted).length / secondHalf.length : 0;
  const fpTrend = fpSecond < fpFirst - 0.05 ? 'improving' : fpSecond > fpFirst + 0.05 ? 'worsening' : 'stable';

  // ── Signal Quality ───────────────────────────────────────────────────────
  const accepted = windowed.filter(o => o.accepted);
  // Proxy for "led to code changes": accepted findings (in a real system,
  // we'd check remediationState, but outcome records don't always have that)
  const signalQuality = {
    findingsLeadingToChanges: accepted.length,
    totalFindings: windowed.length,
    changeRate: windowed.length > 0 ? accepted.length / windowed.length : 0,
  };

  // ── Severity Calibration ─────────────────────────────────────────────────
  const bySeverity = { HIGH: { total: 0, accepted: 0 }, MEDIUM: { total: 0, accepted: 0 }, LOW: { total: 0, accepted: 0 } };
  for (const o of windowed) {
    const s = bySeverity[o.severity];
    if (s) { s.total++; if (o.accepted) s.accepted++; }
  }
  const highRate = bySeverity.HIGH.total > 0 ? bySeverity.HIGH.accepted / bySeverity.HIGH.total : 0;
  const medRate = bySeverity.MEDIUM.total > 0 ? bySeverity.MEDIUM.accepted / bySeverity.MEDIUM.total : 0;
  const lowRate = bySeverity.LOW.total > 0 ? bySeverity.LOW.accepted / bySeverity.LOW.total : 0;

  const severityCalibration = {
    highAcceptanceRate: highRate,
    mediumAcceptanceRate: medRate,
    lowAcceptanceRate: lowRate,
    miscalibrated: bySeverity.HIGH.total >= 3 && highRate < medRate,
  };

  // ── Convergence Speed ────────────────────────────────────────────────────
  // Group outcomes into audit sessions by (repoFingerprint + promptVariant + day)
  // to determine max round per session. More robust than hour-boundary grouping.
  const roundCounts = {};
  for (const o of windowed) {
    const day = o.timestamp ? new Date(o.timestamp).toISOString().slice(0, 10) : 'unknown';
    const key = `${o.repoFingerprint || 'local'}:${day}`;
    roundCounts[key] = Math.max(roundCounts[key] || 0, o.round || 1);
  }
  const rounds = Object.values(roundCounts);
  const avgRounds = rounds.length > 0 ? rounds.reduce((a, b) => a + b, 0) / rounds.length : 1;
  const sortedRounds = [...rounds].sort((a, b) => a - b);
  const medianRounds = sortedRounds.length > 0 ? sortedRounds[Math.floor(sortedRounds.length / 2)] : 1;

  // Trend: first half vs second half of round counts
  const rMid = Math.floor(rounds.length / 2);
  const rFirst = rounds.slice(0, rMid);
  const rSecond = rounds.slice(rMid);
  const avgFirst = rFirst.length > 0 ? rFirst.reduce((a, b) => a + b, 0) / rFirst.length : avgRounds;
  const avgSecond = rSecond.length > 0 ? rSecond.reduce((a, b) => a + b, 0) / rSecond.length : avgRounds;
  const convTrend = avgSecond < avgFirst - 0.3 ? 'faster' : avgSecond > avgFirst + 0.3 ? 'slower' : 'stable';

  const convergenceSpeed = {
    avgRoundsToConverge: Math.round(avgRounds * 10) / 10,
    medianRoundsToConverge: medianRounds,
    trend: convTrend,
  };

  return {
    window,
    metrics: {
      fpRate: { overall: Math.round(fpRateOverall * 1000) / 1000, byPass, trend: fpTrend },
      signalQuality,
      severityCalibration,
      convergenceSpeed,
    },
  };
}

function emptyMetrics() {
  return {
    window: { fromRun: 0, toRun: 0, outcomeCount: 0, dateRange: 'N/A' },
    metrics: {
      fpRate: { overall: 0, byPass: {}, trend: 'stable' },
      signalQuality: { findingsLeadingToChanges: 0, totalFindings: 0, changeRate: 0 },
      severityCalibration: { highAcceptanceRate: 0, mediumAcceptanceRate: 0, lowAcceptanceRate: 0, miscalibrated: false },
      convergenceSpeed: { avgRoundsToConverge: 0, medianRoundsToConverge: 0, trend: 'stable' },
    },
  };
}

// ── Assessment Interval ─────────────────────────────────────────────────────

const PIPELINE_STATE_PATH = '.audit/pipeline-state.json';

/**
 * Check if a meta-assessment is due based on run count.
 * @param {string} [statePath]
 * @param {number} [interval]
 * @returns {{ shouldRun: boolean, runsSinceLastAssessment: number, totalRuns: number }}
 */
export function shouldRunAssessment(statePath = PIPELINE_STATE_PATH, interval = assessmentConfig.interval) {
  try {
    const state = JSON.parse(fs.readFileSync(path.resolve(statePath), 'utf-8'));
    const totalRuns = state.runCount || 0;
    const lastAssessment = state.lastAssessmentAtRun || 0;
    const runsSince = totalRuns - lastAssessment;
    return { shouldRun: runsSince >= interval, runsSinceLastAssessment: runsSince, totalRuns };
  } catch {
    return { shouldRun: false, runsSinceLastAssessment: 0, totalRuns: 0 };
  }
}

/**
 * Mark assessment as completed in pipeline state.
 * @param {string} [statePath]
 */
function markAssessmentComplete(statePath = PIPELINE_STATE_PATH) {
  const absPath = path.resolve(statePath);
  try {
    const state = JSON.parse(fs.readFileSync(absPath, 'utf-8'));
    state.lastAssessmentAtRun = state.runCount || 0;
    state.lastAssessmentAt = new Date().toISOString();
    fs.writeFileSync(absPath, JSON.stringify(state, null, 2));
  } catch { /* non-fatal */ }
}

// ── Sample Outcomes for LLM ─────────────────────────────────────────────────

function sampleOutcomes(outcomes, maxPerCategory = 5) {
  const dismissed = outcomes.filter(o => !o.accepted)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, maxPerCategory)
    .map(o => ({ severity: o.severity, category: o.category?.slice(0, 60), pass: o.pass, section: o.section?.slice(0, 60) }));

  const accepted = outcomes.filter(o => o.accepted)
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
    .slice(0, maxPerCategory)
    .map(o => ({ severity: o.severity, category: o.category?.slice(0, 60), pass: o.pass, section: o.section?.slice(0, 60) }));

  return { dismissed, accepted };
}

// ── LLM Assessment ──────────────────────────────────────────────────────────

const ASSESSMENT_SYSTEM = `You are evaluating the performance of an automated code audit system.

The system uses GPT-5.4 to audit code in 5 parallel passes (structure, wiring,
backend, frontend, sustainability), then Claude deliberates on findings, and
Gemini provides an independent final review. An A/B test alternates between
GPT-auditor (variant A) and Gemini-auditor (variant B).

Below are metrics from recent audit outcomes plus sample findings.

YOUR TASKS:

1. DIAGNOSE: What patterns do you see? Which passes are underperforming?
   Is severity calibration accurate? Are recurring FPs being handled?

2. RECOMMEND: Suggest specific, actionable changes (max 5). Types:
   - prompt_change: modify a pass prompt (cite which pass, what to change)
   - threshold_adjustment: change FP suppression or severity thresholds
   - pass_config: change pass structure (split, merge, reasoning level)
   - pipeline_config: change A/B test weights or model selection

3. OVERALL HEALTH: healthy / needs_attention / degraded

Be concise. Focus on the 2-3 highest-impact recommendations.`;

/**
 * Run LLM-driven assessment of audit-loop performance.
 * @param {object} metrics - From computeAssessmentMetrics()
 * @param {object} samples - From sampleOutcomes()
 * @param {object[]} fpPatterns - Top FP patterns from tracker
 * @returns {Promise<object>} MetaAssessmentResult
 */
export async function runLLMAssessment(metrics, samples, fpPatterns) {
  const userPrompt = [
    '## Metrics\n',
    '```json',
    JSON.stringify(metrics.metrics, null, 2),
    '```\n',
    '## Sample Outcomes\n',
    '### Recently Dismissed (potential false positives)',
    JSON.stringify(samples.dismissed, null, 2),
    '\n### Recently Accepted (good signal)',
    JSON.stringify(samples.accepted, null, 2),
    '\n### Recurring FP Patterns',
    JSON.stringify(fpPatterns.slice(0, 10), null, 2),
  ].join('\n');

  // Try Gemini Flash first (cheap), fall back to GPT
  const model = assessmentConfig.model;
  process.stderr.write(`  [meta-assess] Running LLM assessment via ${model}...\n`);
  const startMs = Date.now();

  if (model.startsWith('gemini') && process.env.GEMINI_API_KEY) {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const jsonSchema = zodToGeminiSchema(MetaAssessmentSchema);

    const response = await ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: ASSESSMENT_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: jsonSchema,
        maxOutputTokens: 4000,
      },
    });

    let result = JSON.parse(response.text);
    // Validate Gemini response against schema
    const validated = MetaAssessmentSchema.safeParse(result);
    if (validated.success) {
      result = validated.data;
    } else {
      process.stderr.write(`  [meta-assess] Gemini Zod validation warning: ${validated.error.message.slice(0, 200)}\n`);
    }
    // Overlay our deterministic metrics (LLM can't change the numbers)
    result.window = metrics.window;
    result.metrics = metrics.metrics;
    process.stderr.write(`  [meta-assess] Done in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return result;
  }

  // GPT fallback
  if (process.env.OPENAI_API_KEY) {
    const OpenAI = (await import('openai')).default;
    const { zodTextFormat } = await import('openai/helpers/zod');
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    const response = await openai.responses.parse({
      model: 'gpt-4.1-mini',
      input: [
        { role: 'system', content: ASSESSMENT_SYSTEM },
        { role: 'user', content: userPrompt },
      ],
      text: { format: zodTextFormat(MetaAssessmentSchema, 'meta_assessment') },
      max_output_tokens: 4000,
    });

    const result = response.output_parsed;
    if (!result) throw new Error('No parsed output from GPT assessment');
    // Overlay our deterministic metrics (LLM can't change the numbers)
    result.window = metrics.window;
    result.metrics = metrics.metrics;
    process.stderr.write(`  [meta-assess] Done in ${((Date.now() - startMs) / 1000).toFixed(1)}s\n`);
    return result;
  }

  throw new Error('No API key available for meta-assessment (need GEMINI_API_KEY or OPENAI_API_KEY)');
}

// ── Storage ─────────────────────────────────────────────────────────────────

const ASSESSMENT_LOG = '.audit/meta-assessments.jsonl';

/**
 * Append assessment to JSONL log.
 * @param {object} result
 * @param {string} [logPath]
 */
export function storeAssessment(result, logPath = ASSESSMENT_LOG) {
  const absPath = path.resolve(logPath);
  const dir = path.dirname(absPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const record = { timestamp: Date.now(), ...result };
  fs.appendFileSync(absPath, JSON.stringify(record) + '\n');
}

// ── Markdown Report ─────────────────────────────────────────────────────────

/**
 * Format assessment result as readable markdown.
 * @param {object} result
 * @returns {string}
 */
export function formatAssessmentReport(result) {
  const m = result.metrics;
  const lines = [
    `# Audit-Loop Meta-Assessment — ${new Date().toISOString().slice(0, 10)}`,
    '',
    `**Health**: ${result.overallHealth}`,
    `**Window**: ${result.window.outcomeCount} outcomes (${result.window.dateRange})`,
    '',
    '## Metrics',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| FP Rate (overall) | ${(m.fpRate.overall * 100).toFixed(1)}% (${m.fpRate.trend}) |`,
    `| Signal Quality | ${(m.signalQuality.changeRate * 100).toFixed(1)}% findings accepted |`,
    `| HIGH acceptance | ${(m.severityCalibration.highAcceptanceRate * 100).toFixed(1)}% |`,
    `| MEDIUM acceptance | ${(m.severityCalibration.mediumAcceptanceRate * 100).toFixed(1)}% |`,
    `| LOW acceptance | ${(m.severityCalibration.lowAcceptanceRate * 100).toFixed(1)}% |`,
    `| Severity miscalibrated | ${m.severityCalibration.miscalibrated ? 'YES' : 'no'} |`,
    `| Avg rounds to converge | ${m.convergenceSpeed.avgRoundsToConverge} (${m.convergenceSpeed.trend}) |`,
    '',
    '### FP Rate by Pass',
    '',
  ];

  for (const [pass, rate] of Object.entries(m.fpRate.byPass)) {
    lines.push(`- **${pass}**: ${(rate * 100).toFixed(1)}%`);
  }

  if (result.diagnosis) {
    lines.push('', '## Diagnosis', '', result.diagnosis);
  }

  if (result.recommendations?.length > 0) {
    lines.push('', '## Recommendations', '');
    for (let i = 0; i < result.recommendations.length; i++) {
      const r = result.recommendations[i];
      lines.push(`### ${i + 1}. [${r.priority}] ${r.target}`);
      lines.push(`- **Type**: ${r.type}`);
      lines.push(`- **Action**: ${r.action}`);
      lines.push(`- **Rationale**: ${r.rationale}`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const metricsOnly = args.includes('--metrics-only');
  const jsonMode = args.includes('--json');
  const force = args.includes('--force');
  const outIdx = args.indexOf('--out');
  const outFile = outIdx !== -1 && args[outIdx + 1] ? args[outIdx + 1] : null;

  // Check interval
  if (!force) {
    const { shouldRun, runsSinceLastAssessment, totalRuns } = shouldRunAssessment();
    if (!shouldRun) {
      const msg = `Assessment not due (${runsSinceLastAssessment}/${assessmentConfig.interval} runs since last). Use --force to override.`;
      if (jsonMode) console.log(JSON.stringify({ skipped: true, reason: msg }));
      else process.stderr.write(`  [meta-assess] ${msg}\n`);
      return;
    }
  }

  // Load data
  const outcomes = loadOutcomes('.audit/outcomes.jsonl');
  if (outcomes.length < assessmentConfig.minOutcomes) {
    const msg = `Insufficient data: ${outcomes.length} outcomes (need ${assessmentConfig.minOutcomes}). Use --force with low minOutcomes to override.`;
    if (jsonMode) console.log(JSON.stringify({ skipped: true, reason: msg }));
    else process.stderr.write(`  [meta-assess] ${msg}\n`);
    return;
  }

  const fpTracker = new FalsePositiveTracker();
  const bandit = new PromptBandit();

  // Phase 1: Deterministic metrics
  const metrics = computeAssessmentMetrics(outcomes, fpTracker, bandit);
  const samples = sampleOutcomes(outcomes);
  const fpPatterns = fpTracker.getReport?.() || [];

  if (metricsOnly) {
    const output = jsonMode ? JSON.stringify(metrics, null, 2) : formatAssessmentReport({ ...metrics, overallHealth: 'N/A', recommendations: [] });
    if (outFile) fs.writeFileSync(outFile, output);
    else console.log(output);
    return;
  }

  // Phase 2: LLM assessment
  let result;
  try {
    result = await runLLMAssessment(metrics, samples, fpPatterns);
  } catch (err) {
    process.stderr.write(`  [meta-assess] LLM failed: ${err.message?.slice(0, 100)} — falling back to metrics-only\n`);
    result = {
      ...metrics,
      diagnosis: 'LLM assessment unavailable — metrics-only report.',
      recommendations: [],
      overallHealth: metrics.metrics.fpRate.overall > 0.5 ? 'degraded'
        : metrics.metrics.severityCalibration.miscalibrated ? 'needs_attention'
        : 'healthy',
    };
  }

  // Phase 3: Store + output
  storeAssessment(result);
  markAssessmentComplete();

  const output = jsonMode ? JSON.stringify(result, null, 2) : formatAssessmentReport(result);
  if (outFile) {
    fs.writeFileSync(outFile, output);
    process.stderr.write(`  [meta-assess] Written to ${outFile}\n`);
  } else {
    console.log(output);
  }

  // Summary to stderr
  process.stderr.write(`  [meta-assess] Health: ${result.overallHealth} | FP: ${(metrics.metrics.fpRate.overall * 100).toFixed(1)}% | Recommendations: ${result.recommendations?.length || 0}\n`);
}

// CLI entry point — only when invoked directly
const isDirectRun = process.argv[1]?.endsWith('meta-assess.mjs') || process.argv[1]?.endsWith('meta-assess');
if (isDirectRun) {
  main().catch(err => {
    console.error(`Meta-assessment failed: ${err.message}`);
    process.exit(1);
  });
}
