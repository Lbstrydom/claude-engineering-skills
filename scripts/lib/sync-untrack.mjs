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
import { execFileSync } from 'node:child_process';

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
 * @param {{ dryRun?: boolean, exec?: Function, env?: NodeJS.ProcessEnv }} [opts]
 *   `exec` is injectable for tests — signature `(args: string[], options) =>
 *   string` (an ARGS ARRAY, matching `execFileSync('git', args, options)`;
 *   changed from a shell-string signature in the 2026-07-23 audit fix below
 *   — verified no caller/test currently injects a custom `exec`, so this is
 *   a safe internal contract change, not a breaking one). Defaults to a
 *   thin `execFileSync('git', ...)` wrapper.
 *   `env`, when supplied, REPLACES the inherited `process.env` for both git
 *   subprocess calls (2026-07-23 audit fix — `git rm --cached` under a
 *   leaked `GIT_DIR` could otherwise remove tracked files from the WRONG
 *   repo's index, not just misread the fixture; found during this plan's
 *   own implementation, not in the original audit-agent sweep, which only
 *   enumerated `tests/`). Omitted (the default) → identical to today's
 *   full-ambient-inherit production behaviour.
 * @returns {string[]} repo-relative paths untracked (or, under dryRun, that WOULD be)
 */
export function untrackNewlyIgnored(repoRoot, patterns, { dryRun = false, exec = defaultExec, env } = {}) {
  const regexps = (patterns || []).map(gitignoreToRegExp);
  if (regexps.length === 0) return [];

  const gitOpts = env ? { env } : {};
  let tracked = [];
  try {
    // 2026-07-23 audit fix (HIGH — command injection): this used to
    // interpolate the filename into a shell string run via `execSync`
    // (which invokes a shell for a string command). A tracked filename
    // containing shell metacharacters could break out of the double quotes
    // and execute arbitrary commands. `execFileSync`/the args-array `exec`
    // contract above never invokes a shell, so no interpolation happens —
    // the filename is passed as a single, literal argv entry regardless of
    // its content.
    // Gemini final-review catch (2026-07-24): no maxBuffer override meant
    // Node's 1MB default, which `git ls-files -z` can exceed on a repo with
    // a large tracked-file count — matches the 64MB bound used at other bulk
    // git call sites (diff-scope-resolver.mjs gitBuf, known-defect-corpus.mjs).
    const out = exec(['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024, ...gitOpts });
    tracked = String(out || '').split('\0').filter(Boolean);
  } catch (err) {
    // "not a git repo" is expected and silent; anything else gets a
    // breadcrumb so a genuine discovery failure isn't indistinguishable
    // from "nothing to untrack" (audit M5/M12 — never silent, matching the
    // established `gitBuf` precedent elsewhere in this repo).
    if (!/not a git repository/i.test(String(err?.stderr || err?.message || ''))) {
      process.stderr.write(`  [sync-untrack] git ls-files failed in ${repoRoot}: ${(err?.message || err).toString().split('\n')[0]}\n`);
    }
    return [];
  }

  const matched = tracked.filter((f) => regexps.some((re) => re.test(f)));
  if (dryRun) return matched;

  // Gemini final-review catch (2026-07-24): batch into one `git rm --cached`
  // per chunk instead of one subprocess per file — the prior per-file loop
  // was new code from this same fix (the H4 command-injection remediation
  // below) and spawned N git processes for N matched files. Chunked (not one
  // giant call) to respect OS argv length limits; a chunk failure is reported
  // for every file in that chunk rather than per-file, trading the old
  // per-file diagnostic granularity for far fewer subprocesses — acceptable
  // here since untracking is idempotent (a retry after fixing the cause
  // just re-attempts the same paths, per the module docstring above).
  const CHUNK_SIZE = 200;
  const removed = [];
  for (let i = 0; i < matched.length; i += CHUNK_SIZE) {
    const chunk = matched.slice(i, i + CHUNK_SIZE);
    try {
      exec(['rm', '--cached', '--quiet', '--', ...chunk], { cwd: repoRoot, stdio: 'ignore', ...gitOpts });
      removed.push(...chunk);
    } catch (err) {
      // best-effort; a single chunk failure must not abort the sync — but it
      // must not be silent either (audit M5/M12).
      process.stderr.write(`  [sync-untrack] git rm --cached failed for ${chunk.length} file(s) (e.g. "${chunk[0]}") in ${repoRoot}: ${(err?.message || err).toString().split('\n')[0]}\n`);
    }
  }
  return removed;
}

function defaultExec(args, options) {
  return execFileSync('git', args, options);
}
