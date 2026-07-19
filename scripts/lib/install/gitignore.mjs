/**
 * @fileoverview Ensure audit-loop artifacts are gitignored in consumer repos.
 *
 * Called on install and update-check so that newly-added patterns
 * (e.g. .audit/local/) land in the target repo's .gitignore automatically.
 */
import fs from 'node:fs';
import path from 'node:path';
import { isSourceRepo } from '../sync-manifest.mjs';

/**
 * Patterns that MUST be in .gitignore for any repo using the audit loop.
 *
 * Two categories:
 *
 * OPERATIONAL — output state produced by running the audit loop locally.
 * Never shared between repos; always gitignored.
 *
 * BUNDLE — files synced into the consumer from claude-engineering-skills.
 * These are NOT the consumer's code — they're versioned in the source repo
 * and replayed on each sync. Committing them in the consumer would cause
 * history pollution + drift. Shared state is the Supabase DB only.
 *
 * Kept in sync with scripts/sync-to-repos.mjs CORE_SCRIPTS / SKILL_FILES
 * / EDITOR_FILES — source of truth for what ships to consumers.
 */
const OPERATIONAL_PATTERNS = [
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
  '.audit-loop-install-receipt.json',
  '.audit-loop-install-txn.json',
  // The transaction lock sits beside the journal at the repo ROOT, so the
  // `.audit/**/*.lock` pattern above does not cover it. Without this every
  // install dirties the consumer's working tree, and a crashed install leaves
  // the file behind permanently.
  '.audit-loop-install-txn.json.lock',
  // Brainstorm temp files (topic stdin + malformed-payload debug JSONs).
  // Files are 0o600 inside the repo (Plan brainstorm-and-arch-discoverability v6,
  // Gemini-G3); contents are ephemeral session data.
  '.claude/tmp/',
];

const BUNDLE_PATTERNS = [
  // Skill surfaces — all three; consumers read but never author these
  '.claude/skills/',
  '.github/skills/',
  '.agents/skills/',
  // MCP wiring shipped alongside skills
  '.vscode/mcp.json',
  // Top-level audit-loop scripts (CORE_SCRIPTS in sync-to-repos.mjs)
  'scripts/openai-audit.mjs',
  'scripts/gemini-review.mjs',
  'scripts/bandit.mjs',
  'scripts/learning-store.mjs',
  'scripts/cross-skill.mjs',
  'scripts/phase7-check.mjs',
  'scripts/shared.mjs',
  'scripts/check-sync.mjs',
  'scripts/check-setup.mjs',
  'scripts/install-skills.mjs',
  'scripts/build-manifest.mjs',
  'scripts/regenerate-skill-copies.mjs',
  'scripts/check-skill-refs.mjs',
  'scripts/refine-prompts.mjs',
  'scripts/evolve-prompts.mjs',
  'scripts/meta-assess.mjs',
  'scripts/audit-loop.mjs',
  'scripts/brainstorm-round.mjs',
  'scripts/debt-auto-capture.mjs',
  'scripts/debt-backfill.mjs',
  'scripts/debt-budget-check.mjs',
  'scripts/debt-pr-comment.mjs',
  'scripts/debt-resolve.mjs',
  'scripts/debt-review.mjs',
  'scripts/write-ledger-r1.mjs',
  'scripts/write-plan-outcomes.mjs',
  'scripts/setup-permissions.mjs',
  // Shared lib — entire directory; consumers read it, never edit.
  // Includes scripts/lib/symbol-index/ (domain-tagger.mjs etc).
  'scripts/lib/',
  // Generated manifest
  'skills.manifest.json',
];

const REQUIRED_PATTERNS = [...OPERATIONAL_PATTERNS, ...BUNDLE_PATTERNS];

/**
 * The pattern set that applies to a GIVEN repo — the load-bearing seam.
 *
 * BUNDLE_PATTERNS are correct ONLY in consumer repos, where those files are
 * synced-in copies that must never be committed. In the SOURCE repo
 * (claude-engineering-skills itself) every one of those paths is real,
 * authored, committed source — gitignoring them there directly violates
 * AGENTS.md's generated-artifact policy (`.claude/skills/**` is Category B:
 * committed + freshness-verified).
 *
 * Incident (2026-07-15): the source repo's own `post-merge` git hook
 * (installed by setup.mjs) runs `install-skills.mjs --local ... 2>/dev/null`
 * after every `git pull` — whose main() calls `ensureAuditGitignore(repoRoot)`
 * with repoRoot = the source repo. That silently appended the whole
 * consumer-only BUNDLE block (`.claude/skills/`, `scripts/openai-audit.mjs`,
 * ~20 more core source files) into the source repo's .gitignore. Filtering
 * HERE — rather than throwing in ensureAuditGitignore, which would break the
 * legitimate setup.mjs/post-merge `--local` flow, or guarding one caller,
 * which the next caller would forget — makes the mistake structurally
 * impossible for every current and future caller, including the check/--fix
 * loop in check-skill-updates.mjs (both functions below share this seam, so
 * "missing" and "would add" can never disagree about bundle patterns).
 *
 * `isSourceRepo` (sync-manifest.mjs, package-name identity) fails FALSE on a
 * missing/unreadable package.json — an edge target degrades to consumer
 * semantics, which at worst adds ignorable patterns to a scratch checkout,
 * never strips protection from a real consumer.
 *
 * @param {string} repoRoot - Absolute path to the target repo root
 * @returns {{ patterns: string[], bundleSkipped: string[] }}
 */
export function requiredPatternsFor(repoRoot) {
  if (isSourceRepo(repoRoot)) {
    return { patterns: [...OPERATIONAL_PATTERNS], bundleSkipped: [...BUNDLE_PATTERNS] };
  }
  return { patterns: REQUIRED_PATTERNS, bundleSkipped: [] };
}

/**
 * Is `pattern` present in `.gitignore` content as its own rule?
 *
 * LINE-based, not substring. A raw `gi.includes(pattern)` reports a pattern as
 * present when it merely appears INSIDE another line — including a longer
 * pattern that happens to start with it. That is not hypothetical: adding
 * `.audit-loop-install-txn.json.lock` made it the only strict superstring in
 * the pattern set, so `includes('.audit-loop-install-txn.json')` would return
 * true from the `.lock` line alone and the journal — which records absolute
 * paths of every file an install touches — would silently never get ignored.
 * A commented-out line mentioning the pattern had the same effect.
 *
 * Shared by the writer (`ensureAuditGitignore`) and the checker
 * (`checkAuditGitignore`) so the two can never disagree about presence.
 *
 * @param {string} gi - full .gitignore content
 * @param {string} pattern
 * @returns {boolean}
 */
function hasPattern(gi, pattern) {
  // Trailing whitespace only. Git strips trailing spaces from a rule (unless
  // backslash-escaped) but LEADING space is significant: a line ` .env` matches
  // a file literally named " .env" and does NOT ignore `.env` — verified with
  // `git check-ignore`. So `line.trim()` would report the `.env` protection as
  // already satisfied when it isn't, and we'd skip adding the real rule. That
  // is the secret-protection path, so the safe direction is to under-report
  // presence (worst case: we append a rule that's already effective).
  return gi.split(/\r?\n/).some(line => line.replace(/\s+$/, '') === pattern);
}

/**
 * Is `pattern` already made redundant by an existing IGNORED DIRECTORY rule?
 *
 * `hasPattern` is exact-line, so a repo whose .gitignore has a bare `.audit/`
 * still reports every `.audit/<thing>` pattern "missing" and we append the lot —
 * pure churn, since git already ignores all of it (2026-07-19: this is what the
 * source repo's post-merge hook kept re-adding).
 *
 * This deliberately reasons about ONE narrow, safe case, because the whole
 * point of `hasPattern`'s design note is that over-reporting presence is the
 * dangerous direction (it would skip adding a real `.env` protection). The
 * bounds, each of which fails CLOSED to "not covered":
 *
 *   - the required pattern must be directory-scoped (contain `/`), so a bare
 *     filename rule like `.env` can never be claimed as covered by anything;
 *   - the covering line must be a literal directory rule (ends `/`, no `*`,
 *     `?` or `[`) — no glob semantics are inferred;
 *   - a negation (`!…`) is never treated as covering;
 *   - matching is on a `<dir>/` prefix, so `.audit/` covers `.audit/local/` but
 *     NOT `.audit-loop/x` (the strict-superstring trap `hasPattern` warns about).
 *
 * Git guarantees the containment here: "it is not possible to re-include a file
 * if a parent directory of that file is excluded", so an ignored directory
 * cannot be punctured by a later negation — which is why this narrow case is
 * safe when general glob reasoning would not be.
 *
 * @param {string} gi - full .gitignore content
 * @param {string} pattern
 * @returns {boolean}
 */
function isCoveredByIgnoredDirectory(gi, pattern) {
  if (!pattern.includes('/')) return false;
  const needle = pattern.replace(/^\//, '');
  for (const raw of gi.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    if (!line.endsWith('/')) continue;
    if (/[*?[]/.test(line)) continue;
    const dir = line.replace(/^\//, '');
    if (dir !== '/' && needle.startsWith(dir)) return true;
  }
  return false;
}

/**
 * Presence test shared by the writer and the checker so the two can never
 * disagree about what still needs adding: literally present, OR already
 * covered by an ignored parent directory.
 *
 * @param {string} gi
 * @param {string} pattern
 * @returns {boolean}
 */
function isPatternSatisfied(gi, pattern) {
  return hasPattern(gi, pattern) || isCoveredByIgnoredDirectory(gi, pattern);
}

/**
 * Header comment prepended when adding the audit-loop block.
 */
const BLOCK_HEADER = '\n# Audit-loop — operational state + synced bundle (auto-managed, do not edit by hand)\n';

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

  const { patterns, bundleSkipped } = requiredPatternsFor(repoRoot);
  if (bundleSkipped.length > 0 && !quiet) {
    process.stderr.write(
      '  .gitignore: source repo detected — bundle patterns skipped (they name authored source here)\n',
    );
  }

  const added = [];
  const alreadyPresent = [];

  for (const pattern of patterns) {
    if (isPatternSatisfied(gi, pattern)) {
      alreadyPresent.push(pattern);
    } else {
      added.push(pattern);
    }
  }

  // (Was: "if .audit/ is already present the fine-grained patterns are redundant
  // but we still add them for clarity when .audit/ gets removed." That traded a
  // speculative future edit for guaranteed churn now — the source repo's
  // post-merge hook re-proposed the whole redundant block on every pull.
  // isPatternSatisfied treats an ignored parent directory as satisfying them.)

  if (added.length > 0 && !dryRun) {
    const block = BLOCK_HEADER + added.join('\n') + '\n';
    fs.appendFileSync(giPath, block);
  }

  if (!quiet && added.length > 0) {
    const verb = created ? 'Created' : 'Updated';
    process.stderr.write(`  ${verb} .gitignore: +${added.length} audit-loop patterns\n`);
  }

  return { added, alreadyPresent, created, bundleSkipped };
}

/**
 * Check whether the target repo's .gitignore has all required patterns.
 * Does NOT modify the file — use ensureAuditGitignore() for that.
 *
 * @param {string} repoRoot - Absolute path to the repo root
 * @returns {{ missing: string[], present: string[], exists: boolean }}
 */
export function checkAuditGitignore(repoRoot) {
  // Same repo-aware seam as ensureAuditGitignore — in the source repo,
  // bundle patterns are deliberately absent, so reporting them "missing"
  // would send check-skill-updates' --fix loop chasing a state the writer
  // (correctly) refuses to produce.
  const { patterns } = requiredPatternsFor(repoRoot);
  const giPath = path.join(repoRoot, '.gitignore');
  if (!fs.existsSync(giPath)) {
    return { missing: [...patterns], present: [], exists: false };
  }

  const gi = fs.readFileSync(giPath, 'utf-8');
  const missing = [];
  const present = [];

  for (const pattern of patterns) {
    if (isPatternSatisfied(gi, pattern)) {
      present.push(pattern);
    } else {
      missing.push(pattern);
    }
  }

  return { missing, present, exists: true };
}

/**
 * Test-only surface for the pure presence predicates (mirrors the
 * `_internals` convention in file-io.mjs / anthropic-client.mjs). These are
 * safety-critical enough — an over-reported "present" silently skips a real
 * protection — to deserve direct coverage rather than only end-to-end tests.
 */
export const _internals = Object.freeze({ hasPattern, isCoveredByIgnoredDirectory, isPatternSatisfied });
