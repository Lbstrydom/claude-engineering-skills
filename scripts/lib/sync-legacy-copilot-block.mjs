/**
 * @fileoverview Retire the stale audit-loop block the old installer merged into
 * a consumer's `.github/copilot-instructions.md`.
 *
 * ## The defect this closes (field report, 2026-09-26)
 *
 * The retired installer (`scripts/lib/install/merge.mjs`, deleted in b7efb9e6)
 * merged a marker-delimited block into `.github/copilot-instructions.md` whose
 * "Keeping Skills Current" section told Copilot to run
 * `node .audit-loop/bootstrap.mjs check|install`. The installer is gone, `check`
 * was removed from the bootstrap, and nothing ever took the block back out — so
 * every consumer that ran the old installer carries instructions that send an
 * agent to commands that no longer exist.
 *
 * ## Remove, don't replace
 *
 * The current sync writes NO copilot-instructions surface: skills are discovered
 * from `.claude/skills/**` and shared context lives in AGENTS.md
 * (docs/reference/skill-surface-ownership.md). Replacing the block with a fresh
 * one would re-create a managed surface nothing maintains — the exact shape that
 * let this one rot. So the block is removed, and the operator is told where the
 * diagnostics live now (`doctor.mjs`, its path derived from sync-path-map).
 *
 * ## Ownership is the markers
 *
 * The block was always "ours between the markers" — `mergeBlock` replaced
 * everything between them on every install. Only that span is touched; text
 * before and after it is the consumer's and is preserved byte-for-byte apart
 * from the blank-line seam the block leaves behind. A file that held nothing
 * BUT our block (the installer created it that way when absent) is deleted
 * rather than left empty. Markers out of order, or only one present, is not a
 * block we can prove we wrote: left alone and reported.
 *
 * The decision (`planLegacyCopilotBlockRetirement`) is pure; the one I/O entry
 * point (`retireLegacyCopilotBlock`) honours --dry-run exactly as the managed
 * `.gitignore` block does, and edits a tracked consumer file the same way.
 *
 * @module scripts/lib/sync-legacy-copilot-block
 */

import fs from 'node:fs';
import path from 'node:path';

import { atomicWriteFileSync } from './file-io.mjs';
import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

/** The retired installer's markers, verbatim from `git show b7efb9e6^:scripts/lib/install/merge.mjs`. */
export const LEGACY_COPILOT_START = '<!-- audit-loop-bundle:start -->';
export const LEGACY_COPILOT_END = '<!-- audit-loop-bundle:end -->';

/** Consumer-relative path of the file the old installer wrote into. */
export const COPILOT_INSTRUCTIONS_PATH = '.github/copilot-instructions.md';

/** Where the retired block's "keeping current" guidance points now. */
export const DOCTOR_CONSUMER_PATH = `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/doctor.mjs`;

/**
 * True only for the retired installer's block STRUCTURE (R3 H6, R4 H1): each
 * marker alone on its line, the body opening with the installer's heading and
 * containing its "Keeping Skills Current" section with the bootstrap command
 * (git show b7efb9e6^:scripts/lib/install/merge.mjs). A consumer example that
 * quotes the markers and path inline fails at least one of these.
 */
function insideFence(text) {
  let open = null; // { ch, len }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!m) continue;
    const ch = m[1][0];
    const len = m[1].length;
    if (!open) {
      if (ch === '`' && m[2].includes('`')) continue; // backtick info string may not contain `
      open = { ch, len };
    } else if (ch === open.ch && len >= open.len && m[2].trim() === '') {
      open = null;
    }
  }
  return open !== null;
}

function isRetiredInstallerBlock(content, start, end) {
  const onOwnLine = (i, len) => (i === 0 || content[i - 1] === '\n')
    && /^(\r?\n|$)/.test(content.slice(i + len, i + len + 2));
  if (!onOwnLine(start, LEGACY_COPILOT_START.length) || !onOwnLine(end, LEGACY_COPILOT_END.length)) return false;
  // A block quoted inside a fenced code example is the consumer's, not the
  // installer's (R5 H1). Fences are tracked CommonMark-style (R6): a fence
  // closes only on the same character with at least the opening length, so
  // `~~~` inside a backtick fence, or ``` inside a ```` fence, stays literal.
  if (insideFence(content.slice(0, start))) return false;
  const body = content.slice(start + LEGACY_COPILOT_START.length, end).replace(/\r\n/g, '\n');
  return body.startsWith('\n## Engineering Skills Bundle\n')
    && /\n## Keeping Skills Current\n[\s\S]*\.audit-loop\/bootstrap\.mjs/.test(body);
}

/**
 * Decide what to do with a copilot-instructions file's content.
 *
 * @param {string|null} content - file content, or null when absent
 * @returns {{action: 'noop'|'remove-block'|'delete-file'|'malformed', content?: string, reason?: string}}
 */
export function planLegacyCopilotBlockRetirement(content) {
  if (typeof content !== 'string') return { action: 'noop' };
  const start = content.indexOf(LEGACY_COPILOT_START);
  const endSearch = start === -1 ? -1 : content.indexOf(LEGACY_COPILOT_END, start + LEGACY_COPILOT_START.length);
  if (start === -1 && content.indexOf(LEGACY_COPILOT_END) === -1) return { action: 'noop' };
  if (start === -1 || endSearch === -1) {
    return { action: 'malformed', reason: 'only one audit-loop-bundle marker (or markers out of order) — not provably ours; left untouched' };
  }
  // Exactly one well-ordered block, or nothing is provably ours (R2 H6).
  const count = (m) => content.split(m).length - 1;
  if (count(LEGACY_COPILOT_START) !== 1 || count(LEGACY_COPILOT_END) !== 1) {
    return { action: 'malformed', reason: 'more than one audit-loop-bundle marker pair — ambiguous, not provably ours; left untouched' };
  }
  // Ownership = the retired installer's STRUCTURE, not a substring (R3 H6, R4
  // H1): each marker alone on its line, the block opening with the installer's
  // heading, and containing its "Keeping Skills Current" section with the
  // bootstrap command (git show b7efb9e6^:scripts/lib/install/merge.mjs). A
  // consumer example quoting markers + path inline fails at least one of these.
  if (!isRetiredInstallerBlock(content, start, endSearch)) {
    return { action: 'malformed', reason: 'audit-loop-bundle markers present but the span is not the retired installer block — left untouched' };
  }
  // Exact inverse of the retired installer's append (`trimmed + '\n\n' + block
  // + '\n'`, git show b7efb9e6^:scripts/lib/install/merge.mjs): remove the
  // managed span, the one line ending closing the end-marker line, and the one
  // blank separator line directly before the start marker. Every other
  // consumer byte is preserved — trimming whitespace wholesale would rewrite
  // consumer content such as an indented Markdown code block.
  let cut = endSearch + LEGACY_COPILOT_END.length;
  if (content.startsWith('\r\n', cut)) cut += 2;
  else if (content[cut] === '\n') cut += 1;
  let keepTo = start;
  for (const eol of ['\r\n', '\n']) {
    if (content.slice(0, keepTo).endsWith(eol + eol)) { keepTo -= eol.length; break; }
  }
  const remaining = content.slice(0, keepTo) + content.slice(cut);
  // Delete only when NOTHING of the consumer's remains; whitespace they wrote
  // outside the managed span is still theirs (R6 M1).
  if (remaining === '') return { action: 'delete-file' };
  return { action: 'remove-block', content: remaining };
}

/**
 * Operator line for a plan. PURE.
 *
 * @param {ReturnType<typeof planLegacyCopilotBlockRetirement>} plan
 * @param {{dryRun?: boolean}} [opts]
 * @returns {string|null}
 */
export function describeLegacyCopilotBlockRetirement(plan, { dryRun = false } = {}) {
  if (plan.action === 'noop') return null;
  if (plan.action === 'malformed') return `${COPILOT_INSTRUCTIONS_PATH}: ${plan.reason}`;
  const verb = plan.action === 'delete-file'
    ? (dryRun ? 'would delete' : 'deleted')
    : (dryRun ? 'would remove the' : 'removed the');
  const what = plan.action === 'delete-file'
    ? `${COPILOT_INSTRUCTIONS_PATH} (it held only the retired audit-loop block)`
    : `retired audit-loop block from ${COPILOT_INSTRUCTIONS_PATH}`;
  return `${verb} ${what} — it pointed at \`node .audit-loop/bootstrap.mjs\`, which no longer works. `
    + `Diagnostics now: \`node ${DOCTOR_CONSUMER_PATH}\`. Commit the change in the consumer.`;
}

/**
 * Apply the retirement to one consumer. The sync's only call site: it reads,
 * plans, writes (unless dry-run), and returns the operator lines. Never throws —
 * a failure here must never abort a sync, so it comes back as a line.
 *
 * `retired` is the edit ACTUALLY made, for the caller to record in
 * `.sync-receipt.json` (upstream report aac80849: a console line was the only
 * trace, so a tracked consumer file changed with no in-repo attribution). It is
 * null on dry-run and on every path that left the file alone — the receipt
 * records what a sync did, never what it would have done.
 *
 * @param {string} repoRoot - consumer repo root
 * @param {{dryRun?: boolean}} [opts]
 * @returns {{notes: string[], retired: {path: string, action: 'remove-block'|'delete-file'}|null}}
 */
export function retireLegacyCopilotBlock(repoRoot, { dryRun = false } = {}) {
  const abs = path.join(repoRoot, COPILOT_INSTRUCTIONS_PATH);
  try {
    // Only a regular file inside the consumer tree is ours to edit: refuse a
    // symlinked .github/ or target, which could point outside the repo (R2 H3/M6).
    // Only ENOENT is "absent" — an access error must not read as a missing file (R3 H4).
    let st = null;
    try { st = fs.lstatSync(abs); } catch (err) { if (err?.code !== 'ENOENT') throw err; }
    if (st && !st.isFile()) return untouched(`${COPILOT_INSTRUCTIONS_PATH}: not a regular file (symlink or other) — left untouched`);
    if (st && fs.realpathSync(abs) !== path.join(fs.realpathSync(repoRoot), COPILOT_INSTRUCTIONS_PATH)) {
      return untouched(`${COPILOT_INSTRUCTIONS_PATH}: resolves outside the consumer repo (symlinked directory) — left untouched`);
    }
    // latin1 maps every byte to one code unit and back, so bytes outside the
    // (ASCII) markers survive unchanged even when not valid UTF-8 (R2 H4).
    const content = st ? fs.readFileSync(abs, 'latin1') : null;
    const plan = planLegacyCopilotBlockRetirement(content);
    const line = describeLegacyCopilotBlockRetirement(plan, { dryRun });
    let retired = null;
    if (!dryRun && plan.action === 'remove-block') {
      atomicWriteFileSync(abs, Buffer.from(plan.content, 'latin1'));
      retired = { path: COPILOT_INSTRUCTIONS_PATH, action: plan.action };
    }
    if (!dryRun && plan.action === 'delete-file') {
      fs.unlinkSync(abs);
      retired = { path: COPILOT_INSTRUCTIONS_PATH, action: plan.action };
    }
    return { notes: line ? [line] : [], retired };
  } catch (err) {
    return untouched(`${COPILOT_INSTRUCTIONS_PATH}: retired-block check failed (${String(err?.message).slice(0, 100)}) — left untouched`);
  }
}

/** A result that edited nothing, carrying one operator line. */
function untouched(note) {
  return { notes: [note], retired: null };
}
