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
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const before = content.slice(0, start).replace(/\s+$/, '');
  const after = content.slice(endSearch + LEGACY_COPILOT_END.length).replace(/^\s+/, '');
  if (before === '' && after === '') return { action: 'delete-file' };
  const joined = before && after ? `${before}${eol}${eol}${after}` : (before || after);
  return { action: 'remove-block', content: `${joined.replace(/\s+$/, '')}${eol}` };
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
 * @param {string} repoRoot - consumer repo root
 * @param {{dryRun?: boolean}} [opts]
 * @returns {string[]}
 */
export function retireLegacyCopilotBlock(repoRoot, { dryRun = false } = {}) {
  const abs = path.join(repoRoot, COPILOT_INSTRUCTIONS_PATH);
  try {
    const content = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
    const plan = planLegacyCopilotBlockRetirement(content);
    const line = describeLegacyCopilotBlockRetirement(plan, { dryRun });
    if (!dryRun && plan.action === 'remove-block') atomicWriteFileSync(abs, plan.content);
    if (!dryRun && plan.action === 'delete-file') fs.unlinkSync(abs);
    return line ? [line] : [];
  } catch (err) {
    return [`${COPILOT_INSTRUCTIONS_PATH}: retired-block check failed (${String(err?.message).slice(0, 100)}) — left untouched`];
  }
}
