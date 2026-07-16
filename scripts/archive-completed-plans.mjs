#!/usr/bin/env node
/**
 * @fileoverview Move completed plans (and their audit-summary siblings)
 * from `docs/plans/` to `docs/completed/`.  Pure CLI utility — no LLM
 * calls, no cloud writes.  Idempotent.
 *
 * A plan is "complete" when its metadata block contains a Status line
 * starting with "Complete":
 *
 *   - **Status**: Complete
 *   - **Status**: Complete (v1)
 *   - **Status**: Complete — shipped as commit abc123 ...
 *
 * For each complete plan, we ALSO move sibling files matching
 * `<plan-stem>-audit-summary*.md` (left behind by `/audit-code` Step 6).
 *
 * Wired into `/ship` SKILL as a final step; can be invoked directly:
 *
 *   npm run plans:archive
 *   npm run plans:archive -- --dry-run
 *   npm run plans:archive -- --force      # overwrite existing in completed/
 *
 * Plan: docs/plans/dogfooding-ergonomics-v1.md §B
 *
 * @module scripts/archive-completed-plans
 */
import fs from 'node:fs';
import path from 'node:path';
import { retrySync } from './lib/retry-transient-fs.mjs';

const PLANS_DIR     = 'docs/plans';
const COMPLETED_DIR = 'docs/completed';

const STATUS_LINE_RE = /^- \*\*Status\*\*:\s*(.+)$/m;
const COMPLETE_RE    = /^Complete\b/i;

/**
 * Parse the status string out of a plan's metadata block.
 *
 * @param {string} planContent
 * @returns {string|null}
 */
export function parseStatus(planContent) {
  if (typeof planContent !== 'string') return null;
  const m = STATUS_LINE_RE.exec(planContent);
  return m ? m[1].trim() : null;
}

/**
 * Decide if a plan's status indicates completion.  Accepts the full
 * status string (e.g. "Complete (v1) — shipped as commit abc123") and
 * matches against `^Complete\b` so prefixes like "Complete with debt"
 * still pass but "Approved-with-known-debt" does NOT.
 */
export function isComplete(statusString) {
  if (!statusString) return false;
  return COMPLETE_RE.test(statusString.trim());
}

/**
 * Discover audit-summary siblings for a given plan filename.  These are
 * left by `/audit-code` Step 6 with names like
 * `<plan-stem>-audit-summary.md` or `<plan-stem>-r3-audit-summary.md`.
 */
export function findAuditSummariesFor(planFilename, plansDir = PLANS_DIR) {
  const stem = path.basename(planFilename, '.md');
  const re = new RegExp(`^${escapeRegex(stem)}(?:-r\\d+)?-audit-summary(?:-\\w+)?\\.md$`);
  if (!fs.existsSync(plansDir)) return [];
  return fs.readdirSync(plansDir)
    .filter(f => re.test(f) && f !== planFilename);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Run one archive pass.  Pure given filesystem state.
 *
 * @param {object} [opts]
 * @param {string} [opts.plansDir]
 * @param {string} [opts.completedDir]
 * @param {boolean} [opts.dryRun]
 * @param {boolean} [opts.force] — overwrite existing files in completed/
 * @returns {{ moved: Array<{from:string,to:string}>, skipped: Array<{file:string,reason:string}>, errors: Array<{file:string,error:string}> }}
 */
export function runArchive({
  plansDir = PLANS_DIR,
  completedDir = COMPLETED_DIR,
  dryRun = false,
  force = false,
} = {}) {
  const summary = { moved: [], skipped: [], errors: [] };
  if (!fs.existsSync(plansDir)) return summary;
  if (!fs.existsSync(completedDir)) {
    if (dryRun) {
      summary.skipped.push({ file: completedDir, reason: 'destination-missing (dry-run)' });
    } else {
      fs.mkdirSync(completedDir, { recursive: true });
    }
  }

  const planFiles = fs.readdirSync(plansDir).filter(f => f.endsWith('.md'));
  for (const planFile of planFiles) {
    const planPath = path.join(plansDir, planFile);
    let content;
    try { content = fs.readFileSync(planPath, 'utf-8'); }
    catch (err) {
      summary.errors.push({ file: planFile, error: `read failed: ${err.message}` });
      continue;
    }
    const status = parseStatus(content);
    if (!status) {
      summary.skipped.push({ file: planFile, reason: 'no Status line found' });
      continue;
    }
    if (!isComplete(status)) {
      summary.skipped.push({ file: planFile, reason: `status: ${status.slice(0, 60)}` });
      continue;
    }

    // Move plan + any audit-summary siblings.
    const summaries = findAuditSummariesFor(planFile, plansDir);
    const filesToMove = [planFile, ...summaries];
    for (const f of filesToMove) {
      const src = path.join(plansDir, f);
      const dst = path.join(completedDir, f);
      if (fs.existsSync(dst) && !force) {
        summary.skipped.push({ file: f, reason: 'destination exists (use --force)' });
        continue;
      }
      try {
        if (dryRun) {
          summary.moved.push({ from: src, to: dst, dryRun: true });
        } else {
          if (force && fs.existsSync(dst)) retrySync(() => fs.unlinkSync(dst));
          retrySync(() => fs.renameSync(src, dst));
          summary.moved.push({ from: src, to: dst });
        }
      } catch (err) {
        summary.errors.push({ file: f, error: `move failed: ${err.message}` });
      }
    }
  }
  return summary;
}

// ── CLI entry ────────────────────────────────────────────────────────────

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force  = args.includes('--force');
  const formatIdx = args.indexOf('--format');
  const format = formatIdx >= 0 ? args[formatIdx + 1] : 'json';

  const result = runArchive({ dryRun, force });

  if (format === 'human') {
    process.stdout.write(`Moved:   ${result.moved.length}\n`);
    for (const m of result.moved) process.stdout.write(`  ✓ ${m.from} → ${m.to}${m.dryRun ? ' (dry-run)' : ''}\n`);
    process.stdout.write(`Skipped: ${result.skipped.length}\n`);
    for (const s of result.skipped) process.stdout.write(`  - ${s.file}: ${s.reason}\n`);
    if (result.errors.length > 0) {
      process.stdout.write(`Errors:  ${result.errors.length}\n`);
      for (const e of result.errors) process.stdout.write(`  ! ${e.file}: ${e.error}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify({ ok: result.errors.length === 0, ...result }) + '\n');
  }
  process.exit(result.errors.length === 0 ? 0 : 1);
}
