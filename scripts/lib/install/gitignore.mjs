/**
 * @fileoverview Ensure audit-loop artifacts are gitignored in consumer repos.
 *
 * Called on install and update-check so that newly-added patterns
 * (e.g. .audit/local/) land in the target repo's .gitignore automatically.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * Patterns that MUST be in .gitignore for any repo using the audit loop.
 * Order matters for readability — grouped by purpose.
 */
const REQUIRED_PATTERNS = [
  '.env',
  '.audit/local/',
  '.audit/staging/',
  '.audit/quarantine/',
  '.audit/**/*.lock',
  '.audit/outcomes.jsonl',
  '.audit/experiments.jsonl',
  '.audit/experiment-manifests/',
  '.audit/prompt-revisions/',
  '.audit/bandit-state.json',
  '.audit/fp-tracker.json',
  '.audit/remediation-tasks.jsonl',
  '.audit/pipeline-state.json',
  '.audit/session-ledger.json',
  '.audit/meta-assessments.jsonl',
];

/**
 * Header comment prepended when adding the audit-loop block.
 */
const BLOCK_HEADER = '\n# Audit-loop operational state (auto-managed)\n';

/**
 * Ensure all required audit-loop patterns are in the target repo's .gitignore.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @param {{ dryRun?: boolean, quiet?: boolean }} [opts]
 * @returns {{ added: string[], alreadyPresent: string[], created: boolean }}
 */
export function ensureAuditGitignore(repoRoot, { dryRun = false, quiet = false } = {}) {
  const giPath = path.join(repoRoot, '.gitignore');
  let gi = '';
  let created = false;

  if (fs.existsSync(giPath)) {
    gi = fs.readFileSync(giPath, 'utf-8');
  } else {
    created = true;
  }

  const added = [];
  const alreadyPresent = [];

  for (const pattern of REQUIRED_PATTERNS) {
    if (gi.includes(pattern)) {
      alreadyPresent.push(pattern);
    } else {
      added.push(pattern);
    }
  }

  // Also handle legacy broad pattern — if .audit/ is already present,
  // the fine-grained patterns are redundant but we still add them
  // for clarity when .audit/ gets removed in favour of selective ignores.

  if (added.length > 0 && !dryRun) {
    const block = BLOCK_HEADER + added.join('\n') + '\n';
    fs.appendFileSync(giPath, block);
  }

  if (!quiet && added.length > 0) {
    const verb = created ? 'Created' : 'Updated';
    process.stderr.write(`  ${verb} .gitignore: +${added.length} audit-loop patterns\n`);
  }

  return { added, alreadyPresent, created };
}

/**
 * Check whether the target repo's .gitignore has all required patterns.
 * Does NOT modify the file — use ensureAuditGitignore() for that.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @returns {{ missing: string[], present: string[], exists: boolean }}
 */
export function checkAuditGitignore(repoRoot) {
  const giPath = path.join(repoRoot, '.gitignore');
  if (!fs.existsSync(giPath)) {
    return { missing: [...REQUIRED_PATTERNS], present: [], exists: false };
  }

  const gi = fs.readFileSync(giPath, 'utf-8');
  const missing = [];
  const present = [];

  for (const pattern of REQUIRED_PATTERNS) {
    if (gi.includes(pattern)) {
      present.push(pattern);
    } else {
      missing.push(pattern);
    }
  }

  return { missing, present, exists: true };
}
