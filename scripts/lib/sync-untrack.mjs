/**
 * @fileoverview Self-heal: untrack consumer files now covered by a managed
 * `.gitignore` pattern the sync owns.
 *
 * A `.gitignore` rule never untracks an already-committed file — so a runtime
 * output (e.g. `.audit/cache-metrics.jsonl`) that a consumer committed BEFORE
 * the ignore pattern existed churns forever as "modified". This generalises the
 * one-off `chore(sync): gitignore the source sync-manifest` fix into the tool:
 * after the managed block is written, any tracked file matching a managed
 * pattern is `git rm --cached`'d so it stops churning.
 *
 * **Safety — scoped to OUR patterns only.** The caller passes only the
 * sync-managed runtime-output patterns, every one of which is a Category-A
 * artifact THIS tooling produces (never a consumer's own file). Matching uses
 * faithful gitignore glob semantics (`*` does NOT cross `/`), so a tracked
 * `.audit-loop/migrations/*.sql` or the consumer's own files can never match
 * `.audit-loop/*-observed.json`. Mode-agnostic: it matches the tracked set
 * directly (not the on-disk `.gitignore`), so a dry-run previews exactly what a
 * real run would untrack regardless of write-ordering. Idempotent: once removed
 * from the index, a later run's `git ls-files` no longer lists it.
 *
 * Supported pattern subset (all that AUDIT_RUNTIME_IGNORES uses): a root-
 * anchored path with optional single-segment `*` wildcards. Not `**`, `?`,
 * char-classes, negation, or trailing-`/` dir markers.
 *
 * @module scripts/lib/sync-untrack
 */
import { execSync } from 'node:child_process';

/**
 * Convert a simple gitignore pattern to a RegExp with gitignore glob semantics
 * (`*` → `[^/]*`, i.e. never crossing a path separator), anchored to the full
 * repo-relative path. Our managed patterns all contain a `/`, so they are
 * root-anchored — matching gitignore's own anchoring rule.
 * @param {string} pattern
 * @returns {RegExp}
 */
export function gitignoreToRegExp(pattern) {
  const escaped = String(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex metachars (NOT `*`)
    .replace(/\*/g, '[^/]*');             // gitignore `*` = any run of non-separators
  return new RegExp(`^${escaped}$`);
}

/**
 * Untrack consumer-repo files now covered by a managed ignore pattern.
 *
 * @param {string} repoRoot - consumer repo root (cwd for the git calls)
 * @param {string[]} patterns - managed gitignore patterns to reconcile (OURS only)
 * @param {{ dryRun?: boolean, exec?: Function }} [opts]
 *   `exec` is injectable for tests; defaults to node's execSync.
 * @returns {string[]} repo-relative paths untracked (or, under dryRun, that WOULD be)
 */
export function untrackNewlyIgnored(repoRoot, patterns, { dryRun = false, exec = execSync } = {}) {
  const regexps = (patterns || []).map(gitignoreToRegExp);
  if (regexps.length === 0) return [];

  let tracked = [];
  try {
    const out = exec('git ls-files -z', { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    tracked = String(out || '').split('\0').filter(Boolean);
  } catch {
    return []; // not a git repo / git missing — nothing to do
  }

  const matched = tracked.filter((f) => regexps.some((re) => re.test(f)));
  const removed = [];
  for (const f of matched) {
    if (dryRun) { removed.push(f); continue; }
    try {
      exec(`git rm --cached --quiet -- "${f}"`, { cwd: repoRoot, stdio: 'ignore' });
      removed.push(f);
    } catch {
      /* best-effort; a single failure must not abort the sync */
    }
  }
  return removed;
}
