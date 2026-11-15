/**
 * @fileoverview Human-checkable spot sample for the decision-eval: a seeded,
 * blinded worksheet of graded arm outputs, and the parser that reads the
 * human's Y/N marks back into a judge–human agreement rate.
 *
 * Plan: docs/plans/fable-vs-opus-decision-eval.md §2.2 "Spot sample", §12.
 *
 * @module scripts/lib/model-eval/decision/spot-sample
 */

import { mulberry32, seededShuffleCopy } from '../../rng.mjs';
import { scrubModelNames } from './judge.mjs';

export const SPOT_FRACTION = 0.2;
export const SPOT_MIN = 4;

/** Blockquote every line: untrusted model text can then never begin a line with `#` or `|`,
 * so it cannot forge a section heading or a marks-table row the parser reads (audit R2 H2). */
const quoteBlock = (s) => String(s).split(/\r\n|\r|\n/).map((l) => `> ${l}`).join('\n');

/** Seeded draw of ⌈fraction·n⌉ items (min SPOT_MIN, max n). */
export function drawSpotSample(items, { seed = 1, fraction = SPOT_FRACTION, min = SPOT_MIN } = {}) {
  const k = Math.min(items.length, Math.max(min, Math.ceil(fraction * items.length)));
  return seededShuffleCopy(items, mulberry32(seed)).slice(0, k);
}

/**
 * Render the worksheet. items: {gradeId, caseId, question, decision, text, judgeCorrect}.
 * The human fills the `Your verdict` cell with Y (correct decision) or N.
 * Arm identity never appears; judge's verdict is hidden until the end so it
 * cannot anchor the human.
 */
export function renderSpotSample(items, { runId }) {
  const lines = [
    `# Spot sample — ${runId}`,
    '',
    'Blinded. For each response, read the question and the correct decision, then the response,',
    'and write **Y** (reaches the correct decision) or **N** in the table at the end.',
    'The judge labels sit in a collapsed block AFTER the marks table: do not open it until every row is filled.',
    '',
  ];
  items.forEach((it, i) => {
    lines.push(`## ${i + 1}. \`${it.gradeId}\` — case \`${it.caseId}\``, '', `**Question.** ${it.question}`, '', `**Correct decision.** ${it.decision}`, '', '<details><summary>Response</summary>', '', quoteBlock(scrubModelNames(it.text)), '', '</details>', '');
  });
  // Judge label = Y only when BOTH passes said correct (the same definition cost
  // per correct uses); `split` flags a pass disagreement so it is visible.
  // The judge labels live in their OWN table, collapsed, after the human's marks
  // table — never adjacent to the cell being filled (audit R1 M3/M7/M8: an
  // instruction not to look cannot blind a reviewer who sees the column).
  lines.push('## Marks', '', '| # | grade id | Your verdict (Y/N) |', '|---|---|---|');
  items.forEach((it, i) => lines.push(`| ${i + 1} | ${it.gradeId} |  |`));
  lines.push('', '<details><summary>Judge labels — open only after every verdict above is filled</summary>', '', '| # | grade id | Judge (both passes) | Passes split |', '|---|---|---|---|');
  items.forEach((it, i) => lines.push(`| ${i + 1} | ${it.gradeId} | ${it.judgeCorrect ? 'Y' : 'N'} | ${it.judgeSplit ? 'split' : '-'} |`));
  lines.push('', '</details>');
  return lines.join('\n') + '\n';
}

/**
 * Parse filled marks. Split rows are reported separately. Agreement is null —
 * unmeasured, never 0 — unless EVERY sampled row is marked (and there are at
 * least `min`): letting the human skip rows would let them choose which
 * observations decide the credibility gate (plan audit R2 M1).
 */
export function parseSpotAgreement(markdown, { min = SPOT_MIN, expectedIds = null } = {}) {
  const human = [];
  const judgeById = new Map();
  const sectionIds = [];
  for (const line of String(markdown).split(/\r\n|\r|\n/)) {
    const s = /^## \d+\. `([0-9a-f]{6,})`/.exec(line);
    if (s) sectionIds.push(s[1]); // one section per sampled output
    const h = /^\|\s*\d+\s*\|\s*([0-9a-f]{6,})\s*\|\s*([YyNn]?)\s*\|\s*$/.exec(line);
    if (h) { human.push({ gradeId: h[1], human: h[2] ? h[2].toUpperCase() : null }); continue; }
    const j = /^\|\s*\d+\s*\|\s*([0-9a-f]{6,})\s*\|\s*([YN])\s*\|\s*(split|-)\s*\|\s*$/.exec(line);
    if (j) judgeById.set(j[1], { judge: j[2], split: j[3] === 'split' });
  }
  const rows = human.map((r) => ({ ...r, ...(judgeById.get(r.gradeId) ?? { judge: null, split: false }) }));
  const marked = rows.filter((r) => r.human);
  const agree = marked.filter((r) => r.human === r.judge).length;
  // COMPLETE means: every sampled section has exactly one parsed verdict row with a
  // judge label. A deleted row or a malformed mark (e.g. "Yes") drops out of `rows`
  // and would silently shrink the denominator — the section count is the
  // authoritative sample size (audit R1 H7/H22/M5).
  // The AUTHORITATIVE sample is the persisted draw (`summary.spotSampleIds`), not the
  // editable worksheet: deleting a section AND its row would otherwise shrink the
  // sample the parser validates (audit R3 H1/M1). Callers with a summary pass it;
  // a bare worksheet falls back to its own headings.
  const expected = Array.isArray(expectedIds) ? expectedIds : sectionIds;
  const expectedRows = expected.length;
  const rowIds = new Set(rows.map((r) => r.gradeId));
  // Same ids on both sides, each once: a count match alone passes duplicate sections (audit R2 M1).
  const sectionSet = new Set(sectionIds);
  const complete = rows.length === expectedRows && new Set(expected).size === expectedRows
    && sectionIds.length === expectedRows && sectionSet.size === expectedRows && rowIds.size === rows.length
    && expected.every((id) => rowIds.has(id) && sectionSet.has(id)) && rows.every((r) => r.judge);
  return {
    rows: rows.length, expectedRows, marked: marked.length, unmarked: rows.length - marked.length, agree,
    splitRows: rows.filter((r) => r.split).length,
    agreement: complete && rows.length >= min && marked.length === rows.length ? agree / marked.length : null,
  };
}
