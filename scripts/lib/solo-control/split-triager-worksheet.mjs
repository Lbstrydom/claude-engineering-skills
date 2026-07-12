/**
 * @fileoverview One-off scratch splitter for the Phase 5 grading worksheet —
 * NOT part of the plan's committed tooling contract, just a practical aid so
 * a 1080-row worksheet is gradeable in clean-chat-sized batches. Separates
 * rows into "quick" (candidate verdict was 'valid', so human_false_dismissal
 * is definitionally FALSE per the worksheet's own instructions — no judgment
 * needed) vs "needsJudgment" (candidate said 'dismissed' — a real call).
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';

const DATA_DIR = path.join('.audit-loop', 'solo-control');
const state = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cheap-triager-state.json'), 'utf8'));
const worksheetText = fs.readFileSync(path.join(DATA_DIR, 'cheap-triager-worksheet.md'), 'utf8');

// Split the worksheet body into per-row sections (### blind_id ...).
const [header, ...rest] = worksheetText.split(/\n(?=### )/);
const sections = new Map();
for (const chunk of rest) {
  const m = /^### (\S+)/.exec(chunk);
  if (m) sections.set(m[1], chunk.replace(/\n$/, ''));
}

const quickIds = [];
const judgmentIds = [];
for (const [id, tier] of Object.entries(state.candidateTier)) {
  if (!state.rowStratum[id]) continue;
  if (tier === 'valid') quickIds.push(id);
  else judgmentIds.push(id);
}

// 1. Pre-filled grades for the quick rows (definitional FALSE).
const gradesLines = ['blind_id,human_false_dismissal'];
for (const id of quickIds) gradesLines.push(`${id},FALSE`);
for (const id of judgmentIds) gradesLines.push(`${id},`); // left blank for real grading
atomicWriteFileSync(path.join(DATA_DIR, 'cheap-triager-grades.csv'), gradesLines.join('\n') + '\n');

// 2. Reference file listing the auto-filled quick rows (for spot-checking).
const quickMd = [
  '# Auto-filled rows (candidate verdict was "valid" — definitionally FALSE, no judgment needed)',
  `${quickIds.length} rows. Spot-check a sample if you want to verify the rule was applied correctly;`
    + ' these are NOT part of the clean-chat grading batches.',
  quickIds.map((id) => sections.get(id) || `### ${id} (section not found)`).join('\n\n'),
].join('\n\n');
atomicWriteFileSync(path.join(DATA_DIR, 'cheap-triager-quick-autofill.md'), quickMd);

// 3. Judgment-needed rows, batched for clean-chat sessions.
const BATCH_SIZE = 50;
const batchDir = path.join(DATA_DIR, 'batches');
fs.mkdirSync(batchDir, { recursive: true });
const strataCount = {};
for (const id of judgmentIds) strataCount[state.rowStratum[id]] = (strataCount[state.rowStratum[id]] || 0) + 1;

// Priority order: load-bearing strata first (gate the pass/fail threshold),
// then known-defect, then contrarian, then random-tail.
const PRIORITY = ['high-dismissal', 'omission-dismissal', 'known-defect', 'contrarian', 'random-tail'];
const ordered = judgmentIds.slice().sort((a, b) => {
  const pa = PRIORITY.indexOf(state.rowStratum[a]);
  const pb = PRIORITY.indexOf(state.rowStratum[b]);
  return pa - pb;
});

const batches = [];
for (let i = 0; i < ordered.length; i += BATCH_SIZE) batches.push(ordered.slice(i, i + BATCH_SIZE));

const instructions = [
  '## Grading instructions (unchanged from the master worksheet)',
  '',
  'For EACH row, answer ONE question — **was this finding FALSELY DISMISSED?**',
  '(Every row in this batch has candidate verdict = `dismissed`, so this is a',
  'real judgment call, not the trivial case.)',
  '',
  '- `TRUE`  — the finding describes a REAL, actionable defect (the dismissal was wrong).',
  '- `FALSE` — the finding is NOT a real/actionable defect (the dismissal was correct).',
  '',
  'Judge only from the finding text. When genuinely uncertain whether a defect is',
  'real, lean FALSE (uncertain findings are not clear false-dismissals).',
  '',
  'Reply with one line per blind_id: `blind_id,TRUE|FALSE` — paste your answers',
  'back into `cheap-triager-grades.csv` for the matching rows.',
].join('\n');

const manifestLines = [`Batches (priority order: load-bearing strata first): ${batches.length} × up to ${BATCH_SIZE} rows, ${ordered.length} total rows needing judgment.`, ''];
batches.forEach((batch, i) => {
  const n = String(i + 1).padStart(2, '0');
  const strataInBatch = {};
  for (const id of batch) strataInBatch[state.rowStratum[id]] = (strataInBatch[state.rowStratum[id]] || 0) + 1;
  const label = Object.entries(strataInBatch).map(([s, c]) => `${s}=${c}`).join(', ');
  const md = [
    `# Cheap-Triager Grading — Batch ${n}/${String(batches.length).padStart(2, '0')}`,
    `Strata in this batch: ${label}`,
    instructions,
    '---',
    batch.map((id) => sections.get(id) || `### ${id} (section not found)`).join('\n\n'),
  ].join('\n\n');
  const fname = `batch-${n}-${Object.keys(strataInBatch)[0]}.md`;
  atomicWriteFileSync(path.join(batchDir, fname), md);
  manifestLines.push(`  ${fname} — ${batch.length} rows (${label})`);
});

console.log(JSON.stringify({
  ok: true,
  totalRows: quickIds.length + judgmentIds.length,
  autoFilled: quickIds.length,
  needsJudgment: judgmentIds.length,
  strataNeedingJudgment: strataCount,
  batchCount: batches.length,
  batchDir,
}, null, 2));
console.log('\n' + manifestLines.join('\n'));
