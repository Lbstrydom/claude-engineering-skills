#!/usr/bin/env node
/**
 * @fileoverview CLI driver for the tiered-recall plan's Phase 5 validation
 * session (Cluster C) — the missing executable wrapper around the pure
 * library `scripts/lib/solo-control/cheap-triager-validate.mjs` (which was
 * built + tested but never wired to a CLI; the manifest it emits gates
 * Phase 7's Stage-1 model choice).
 *
 * Two subcommands, split at the human-grading boundary the library
 * documents as load-bearing:
 *
 *   worksheet — runs the candidate cheap model as triager over the
 *     2,314-row blind-adjudication sheet (real, cheap LLM calls), builds
 *     the contrarian stratified worksheet, and writes THREE artifacts to
 *     `.audit-loop/solo-control/`:
 *       cheap-triager-worksheet.md      — human/LLM-readable grading doc
 *       cheap-triager-grades.csv        — 2-column template the grader fills
 *       cheap-triager-state.json        — candidate verdicts + datasetHash
 *                                         (consumed by `manifest`)
 *     STOPS there — never fabricates human ground truth.
 *
 *   manifest — AFTER a human grading session: joins the filled grades CSV
 *     with the state file, aggregates per stratum, and writes the committed
 *     decision artifacts `docs/experiments/audit-effectiveness/
 *     cheap-triager-validation.{json,md}` per the plan's Phase-5 spec.
 *
 * Usage:
 *   node scripts/cheap-triager-validate.mjs worksheet [--candidate <id>]
 *     [--tail-size 100] [--concurrency 8] [--limit N]
 *   node scripts/cheap-triager-validate.mjs manifest
 *
 * Source-repo research tooling (solo-control family) — not consumer-synced.
 */

if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  parseBlindCsv, computeTwoJudgeConsensus, buildContrarianStratifiedWorksheet,
  computeValidationManifest, renderValidationMarkdown, computeDatasetHash,
  runCandidateTriage,
} from './lib/solo-control/cheap-triager-validate.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { argOption } from './lib/cli-io.mjs';

const DATA_DIR = path.join('.audit-loop', 'solo-control');
const CLAUDE_CSV = path.join(DATA_DIR, 'blind-adjudication-claude.csv');
const GPT_CSV = path.join(DATA_DIR, 'blind-adjudication-gpt.csv');
const BLIND_MAP = path.join(DATA_DIR, '.blind-map.json');
const WORKSHEET_MD = path.join(DATA_DIR, 'cheap-triager-worksheet.md');
const GRADES_CSV = path.join(DATA_DIR, 'cheap-triager-grades.csv');
const STATE_JSON = path.join(DATA_DIR, 'cheap-triager-state.json');
const MANIFEST_JSON = path.join('docs', 'experiments', 'audit-effectiveness', 'cheap-triager-validation.json');
const MANIFEST_MD = path.join('docs', 'experiments', 'audit-effectiveness', 'cheap-triager-validation.md');
const EVIDENCE_JSON = path.join('docs', 'experiments', 'audit-effectiveness', 'cheap-triager-validation-evidence.json');

// ── Candidate triage adapter (the only live-LLM seam) ──────────────────────

const TriageVerdictSchema = z.object({ verdict: z.enum(['valid', 'dismissed']) });

const TRIAGE_SYSTEM = [
  'You are the Stage-1 cheap triager in a code-audit pipeline. You receive ONE',
  'audit finding (severity, category, file, description) produced by an earlier',
  'generation stage. Decide:',
  '- "dismissed" — not a real, actionable defect: speculative, stylistic,',
  '  unverifiable from the description, or describes intended behavior.',
  '- "valid" — a real, actionable defect worth engineer attention.',
  'Judge ONLY what the finding text supports. When genuinely uncertain, prefer',
  '"valid" (a false dismissal is the costly error in this pipeline).',
].join('\n');

function rowPrompt(row) {
  return [
    `severity: ${row.severity}`,
    `category: ${row.category}`,
    `file: ${row.file}`,
    `finding: ${row.detail}`,
  ].join('\n');
}

async function buildGlmAdapter(candidateModel) {
  const { createOpenRouterClient } = await import('./lib/openai-client.mjs');
  const { ossStructuredCall } = await import('./lib/oss-structured-output.mjs');
  const client = await createOpenRouterClient();
  return async (row) => {
    const r = await ossStructuredCall(client, {
      model: candidateModel,
      system: TRIAGE_SYSTEM,
      userPrompt: rowPrompt(row),
      schema: TriageVerdictSchema,
      schemaName: 'triage_verdict',
      maxTokens: 2000,
      timeoutMs: 120_000,
      passName: 'cheap-triager-validate',
      reasoningEffort: 'low',
    });
    return r?.result?.verdict ?? null;
  };
}

// ── worksheet subcommand ────────────────────────────────────────────────────

async function cmdWorksheet() {
  const { pickOssModel } = await import('./lib/model-resolver.mjs');
  const candidateModel = argOption('candidate', pickOssModel('reasoner'));
  const tailSize = Number(argOption('tail-size', '100'));
  const concurrency = Math.max(1, Number(argOption('concurrency', '8')));
  const limit = argOption('limit') ? Number(argOption('limit')) : null; // smoke-test aid

  const claudeText = fs.readFileSync(CLAUDE_CSV, 'utf8');
  const gptText = fs.readFileSync(GPT_CSV, 'utf8');
  const blindMapText = fs.readFileSync(BLIND_MAP, 'utf8');
  const datasetHash = computeDatasetHash(claudeText, gptText + blindMapText);

  const claudeRows = parseBlindCsv(claudeText);
  const gptRows = parseBlindCsv(gptText);
  const consensus = computeTwoJudgeConsensus(claudeRows, gptRows);
  let rows = claudeRows;
  if (limit) rows = rows.slice(0, limit);
  process.stderr.write(`  [worksheet] ${rows.length} rows, candidate=${candidateModel}, concurrency=${concurrency}\n`);

  // Chunked concurrency around the (sequential-by-design) library helper.
  const adapter = await buildGlmAdapter(candidateModel);
  const chunks = [];
  const per = Math.ceil(rows.length / concurrency);
  for (let i = 0; i < rows.length; i += per) chunks.push(rows.slice(i, i + per));
  let done = 0;
  const progressAdapter = (fn) => async (row) => {
    const v = await fn(row);
    done++;
    if (done % 100 === 0) process.stderr.write(`  [worksheet] triaged ${done}/${rows.length}\n`);
    return v;
  };
  const maps = await Promise.all(chunks.map((c) => runCandidateTriage(c, { callAdapter: progressAdapter(adapter) })));
  const candidateTier = new Map();
  for (const m of maps) for (const [k, v] of m) candidateTier.set(k, v);
  process.stderr.write(`  [worksheet] candidate verdicts: ${candidateTier.size}/${rows.length} (${rows.length - candidateTier.size} row-level failures omitted)\n`);

  // Deterministic seed from the dataset hash — reproducible, no clock.
  const seed = Number.parseInt(datasetHash.slice(0, 8), 16);
  const { worksheetRows, strata } = buildContrarianStratifiedWorksheet(rows, consensus, candidateTier, { tailSize, seed });

  // Artifact 1 — human/LLM-readable worksheet.
  const md = [
    '# Cheap-Triager Validation — Human Grading Worksheet',
    '',
    `- Candidate model: \`${candidateModel}\` | Dataset hash: \`${datasetHash.slice(0, 16)}…\` | Rows: ${worksheetRows.length}`,
    `- Strata: ${strata.map((s) => `${s.name}=${s.count}`).join(', ')}`,
    '',
    '## Grading instructions',
    '',
    'For EACH row below, answer ONE question — **was this finding FALSELY DISMISSED?**',
    '',
    '- `TRUE`  — the candidate verdict is `dismissed`, but the finding describes a',
    '  REAL, actionable defect (the dismissal was wrong).',
    '- `FALSE` — everything else: the candidate said `valid` (regardless of your view),',
    '  or it said `dismissed` and the finding is indeed not a real/actionable defect.',
    '',
    'Record answers in `cheap-triager-grades.csv` (blind_id, human_false_dismissal).',
    'Judge only from the finding text; when uncertain whether a defect is real, lean',
    'FALSE (uncertain findings are not clear false-dismissals).',
    '',
    '---',
    '',
    ...worksheetRows.map((r) => [
      `### ${r.blind_id}  \`[${r.stratum}]\``,
      '',
      `- severity: **${r.severity}** | category: ${r.category}`,
      `- file: \`${r.file}\``,
      `- candidate verdict: **${candidateTier.get(r.blind_id) ?? 'n/a (call failed)'}** | judge consensus: ${consensus.get(r.blind_id)?.consensusTier ?? 'n/a'}`,
      '',
      `> ${String(r.detail).replaceAll('\n', '\n> ')}`,
      '',
    ].join('\n')),
  ].join('\n');
  atomicWriteFileSync(WORKSHEET_MD, md);

  // Artifact 2 — the grades template the human fills.
  const gradesCsv = ['blind_id,human_false_dismissal', ...worksheetRows.map((r) => `${r.blind_id},`)].join('\n') + '\n';
  atomicWriteFileSync(GRADES_CSV, gradesCsv);

  // Artifact 3 — machine state for the manifest step.
  atomicWriteFileSync(STATE_JSON, JSON.stringify({
    datasetHash, candidateModel, tailSize, seed,
    strata,
    rowStratum: Object.fromEntries(worksheetRows.map((r) => [r.blind_id, r.stratum])),
    candidateTier: Object.fromEntries(candidateTier),
    generatedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  process.stderr.write(`  [worksheet] wrote ${WORKSHEET_MD} (${worksheetRows.length} rows), ${GRADES_CSV}, ${STATE_JSON}\n`);
  console.log(JSON.stringify({ ok: true, rows: worksheetRows.length, strata, worksheet: WORKSHEET_MD, grades: GRADES_CSV }));
}

// ── manifest subcommand ─────────────────────────────────────────────────────

// Accepts either the plain 2-column contract (blind_id,human_false_dismissal)
// or a 3-column extension carrying a rationale (blind_id,human_false_dismissal,
// reason) — the reason is preserved in the evidence artifact (cmdManifest)
// but never influences computeValidationManifest's aggregation, which only
// ever reads the boolean. A quoted reason field (commas inside quotes, per
// the CSV export some graders produced) is parsed properly, not split naively.
function parseGradesCsv(text) {
  const grades = new Map();
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  const header = lines[0]?.trim();
  if (header !== 'blind_id,human_false_dismissal' && header !== 'blind_id,human_false_dismissal,reason') {
    throw new Error(`grades CSV header must be "blind_id,human_false_dismissal" or "blind_id,human_false_dismissal,reason", got "${lines[0]}"`);
  }
  const hasReason = header.endsWith(',reason');
  for (const [i, line] of lines.slice(1).entries()) {
    // First two fields are never quoted (blind_id, TRUE/FALSE/blank); the
    // optional third field may be a quoted, comma-containing rationale.
    const m = /^([^,]*),([^,]*)(?:,(.*))?$/.exec(line);
    if (!m) throw new Error(`grades CSV row ${i + 2}: malformed — "${line}"`);
    const [, blindIdRaw, verdictRaw, reasonRaw] = m;
    if (!hasReason && reasonRaw !== undefined) throw new Error(`grades CSV row ${i + 2}: too many fields for a 2-column header — "${line}"`);
    const v = (verdictRaw || '').trim().toUpperCase();
    const blindId = blindIdRaw.trim();
    if (v === '') continue; // ungraded row — excluded, never defaulted
    if (v !== 'TRUE' && v !== 'FALSE') throw new Error(`grades CSV row ${i + 2}: human_false_dismissal must be TRUE or FALSE (or blank = ungraded), got "${verdictRaw}"`);
    let reason = null;
    if (hasReason && reasonRaw !== undefined) {
      reason = reasonRaw.trim();
      if (reason.startsWith('"') && reason.endsWith('"')) reason = reason.slice(1, -1).replaceAll('""', '"');
    }
    grades.set(blindId, { humanFalseDismissal: v === 'TRUE', reason });
  }
  return grades;
}

async function cmdManifest() {
  const state = JSON.parse(fs.readFileSync(STATE_JSON, 'utf8'));
  const grades = parseGradesCsv(fs.readFileSync(GRADES_CSV, 'utf8'));

  // Freshness: the dataset must not have changed since the worksheet was cut.
  const claudeText = fs.readFileSync(CLAUDE_CSV, 'utf8');
  const gptText = fs.readFileSync(GPT_CSV, 'utf8');
  const blindMapText = fs.readFileSync(BLIND_MAP, 'utf8');
  const freshHash = computeDatasetHash(claudeText, gptText + blindMapText);
  if (freshHash !== state.datasetHash) {
    console.error(`[manifest] dataset changed since the worksheet was generated (hash mismatch) — re-run the worksheet step`);
    process.exitCode = 2;
    return;
  }

  const byStratum = new Map();
  const evidence = [];
  let gradedCount = 0;
  for (const [blindId, { humanFalseDismissal, reason }] of grades) {
    const stratum = state.rowStratum[blindId];
    if (!stratum) throw new Error(`grades CSV contains unknown blind_id "${blindId}" — not in the worksheet state`);
    if (!byStratum.has(stratum)) byStratum.set(stratum, []);
    byStratum.get(stratum).push({ humanFalseDismissal });
    evidence.push({ blindId, stratum, candidateVerdict: state.candidateTier[blindId] ?? null, humanFalseDismissal, reason });
    gradedCount++;
  }
  const totalRows = Object.keys(state.rowStratum).length;
  process.stderr.write(`  [manifest] ${gradedCount}/${totalRows} worksheet rows graded\n`);
  if (gradedCount < totalRows) {
    process.stderr.write(`  [manifest] WARNING: ${totalRows - gradedCount} row(s) ungraded — rates computed over graded rows only\n`);
  }
  if (gradedCount === 0) {
    console.error('[manifest] zero graded rows — refusing to emit a manifest over nothing');
    process.exitCode = 2;
    return;
  }

  const gradedStrata = [...byStratum.entries()].map(([name, gradedRows]) => ({ name, gradedRows }));
  const manifest = computeValidationManifest(gradedStrata, {
    candidateModel: state.candidateModel,
    datasetHash: state.datasetHash,
    generatedAt: new Date().toISOString(),
  });
  atomicWriteFileSync(MANIFEST_JSON, JSON.stringify(manifest, null, 2) + '\n');
  atomicWriteFileSync(MANIFEST_MD, renderValidationMarkdown(manifest) + '\n');

  // Evidence artifact — not part of the plan's committed manifest contract
  // (computeValidationManifest only ever reads the boolean), but a durable,
  // per-row audit trail (rationale, candidate's own verdict, stratum) that
  // the manifest alone can't reconstruct. Written alongside, never
  // consumed by Phase 7's gate.
  atomicWriteFileSync(EVIDENCE_JSON, JSON.stringify({ datasetHash: state.datasetHash, generatedAt: manifest.generatedAt, rows: evidence }, null, 2) + '\n');

  process.stderr.write(`  [manifest] wrote ${MANIFEST_JSON} + ${MANIFEST_MD} + ${EVIDENCE_JSON} — passed=${manifest.passed}\n`);
  console.log(JSON.stringify({ ok: true, passed: manifest.passed, gradedCount, manifest: MANIFEST_JSON, evidence: EVIDENCE_JSON }));
}

// ── main ────────────────────────────────────────────────────────────────────

const sub = process.argv[2];
if (sub === 'worksheet') await cmdWorksheet();
else if (sub === 'manifest') await cmdManifest();
else {
  console.error('Usage: cheap-triager-validate.mjs worksheet [--candidate <id>] [--tail-size N] [--concurrency N] [--limit N] | manifest');
  process.exit(1);
}
