#!/usr/bin/env node
/**
 * @fileoverview Install (or refresh) a `.git/hooks/pre-push` hook in
 * each consumer repo.  The hook auto-runs `/audit-code` against any
 * draft plan in `docs/plans/` BEFORE the push lands, so audits actually
 * happen on real diffs without the user remembering to invoke them.
 *
 * Single source of truth for the consumer-repo list: imported from
 * `scripts/sync-to-repos.mjs`'s `REPOS` constant (so adding a new
 * consumer repo there auto-extends here too).
 *
 * The installed hook is OPTIONAL by default — it warns about audit
 * findings rather than blocking the push.  Operators who want
 * blocking behaviour can `git push --no-verify` to bypass, OR we
 * can flip the hook to exit 1 on findings via env (`AUDIT_PREPUSH_BLOCK=1`).
 *
 * Plan: docs/plans/dogfooding-ergonomics-v1.md §C
 *
 * Usage:
 *   node scripts/install-prepush-hook.mjs                # install in all consumer repos
 *   node scripts/install-prepush-hook.mjs --target wine  # one repo only
 *   node scripts/install-prepush-hook.mjs --dry-run      # show what would happen
 *   node scripts/install-prepush-hook.mjs --uninstall    # remove the hook
 *
 * @module scripts/install-prepush-hook
 */
import fs from 'node:fs';
import path from 'node:path';

// Single source of truth for consumer repos — see scripts/lib/consumer-repos.mjs.
// Adding a new consumer repo there auto-extends this script.
import { CONSUMER_REPOS, resolveTargets } from './lib/consumer-repos.mjs';
import { assertRepoRoot } from './lib/assert-repo-root.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

// Every accepted flag. `--target` and `--format` TAKE A VALUE (both the
// `--flag value` and `--flag=value` forms are accepted by the guard).
const KNOWN_FLAGS = ['--dry-run', '--uninstall', '--target', '--format'];

const HOOK_MARKER     = '# managed-by: claude-engineering-skills install-prepush-hook.mjs';
// Bump when the generated body changes in a way a consumer must re-install to
// pick up. v2 (reference-integrity-gate Cluster C): plan selection moved from
// `ls -t docs/plans/*.md | head -1` to the Status-aware `check-plan-status.mjs
// --select`, so a Complete plan is never re-audited. A stale v1 body is
// detectable by the ABSENCE of this line; `hooks:install` rewrites it.
// v3 (2026-09-04): the source-repo sibling scan is anchored on the MAIN
// checkout instead of cwd. A v2 body run from a linked worktree enumerated
// sibling WORKTREES, found nothing, and skipped the audit with exit 0 — on
// every push a Claude Code session makes. Re-install to pick it up.
const HOOK_VERSION    = 3;
const HOOK_VERSION_MARKER = `# hook-version: ${HOOK_VERSION}`;
// Accept the legacy marker too so existing installs (pre-rename) can be
// upgraded in place by `npm run hooks:install` without manual cleanup.
const LEGACY_MARKERS  = [
  '# managed-by: claude-audit-loop install-prepush-hook.mjs',
];
function isManagedHook(content) {
  if (!content) return false;
  if (content.includes(HOOK_MARKER)) return true;
  return LEGACY_MARKERS.some(m => content.includes(m));
}
const HOOK_BODY = `#!/bin/sh
${HOOK_MARKER}
${HOOK_VERSION_MARKER}
#
# Auto-runs /audit-code on any draft plan in docs/plans/ before the push.
# Non-blocking by default: prints findings to stderr, never aborts the
# push.  To block on HIGH findings, set AUDIT_PREPUSH_BLOCK=1.
#
# Bypass per-push: \`git push --no-verify\`.
# Disable session: \`AUDIT_PREPUSH_DISABLE=1 git push\`.

[ "$AUDIT_PREPUSH_DISABLE" = "1" ] && exit 0

# ── Opportunistic weekly local maintenance (opt-in, backgrounded) ───────────
# Local replica of the 5 GH Actions cron workflows (architectural-drift,
# migration-drift, model-freshness, memory-health, learning-weekly-review)
# for operators whose org blocks GitHub-hosted Actions runners. Deliberately
# NOT an OS-scheduled task — see docs/runbooks/local-maintenance-checks.md for why.
#
# MUST run before the code-audit section below (round-4 Gemini gate G1 fix):
# that section \`exit 0\`s early whenever docs/plans/ is absent or has no
# .md file — the common case on most pushes — which meant this block, when
# placed at the end of the file, almost never actually ran. Placed here, it
# fires on every push regardless of whether a plan is active.
#
# Always invoked (cheap no-op check); maintenance-checks.mjs itself decides
# whether AUDIT_LOOP_WEEKLY_MAINTENANCE=1 is set and whether a run is due —
# silent no-op otherwise. Runs the CONSUMER's own synced copy (repo-scoped
# checks like arch:refresh need cwd = this repo, not the source sibling).
#
# BACKGROUNDED, not just \`|| true\` (round-1 code-audit H1 fix): \`|| true\`
# only suppresses the exit code — the command still ran SYNCHRONOUSLY, so
# \`git push\` blocked for up to ~40 minutes (6 checks x 5-minute timeout)
# once overdue. \`( cmd & )\` detaches into a subshell that backgrounds the
# node process and exits almost immediately itself, so this hook script
# (and git) never waits for the checks to finish. Output goes to a log
# file, not this hook's inherited stderr, since nothing is watching it live
# once detached — check it with \`npm run maintenance:status\`.
MAINT_SCRIPT="scripts/.claude-skills/maintenance-checks.mjs"
if [ -f "$MAINT_SCRIPT" ]; then
  mkdir -p .audit-loop 2>/dev/null
  ( node "$MAINT_SCRIPT" --opportunistic > .audit-loop/last-maintenance.log 2>&1 < /dev/null & ) 2>/dev/null
fi

PLANS_DIR="docs/plans"
[ ! -d "$PLANS_DIR" ] && exit 0

# Locate the audit-loop install FIRST — plan selection now runs through the
# SOURCE repo's Status-aware CLI (check-plan-status.mjs), so discovery must
# precede selection (reference-integrity-gate Cluster C, R1-H2/R3-H5).
# Search order:
#   1. \$CLAUDE_AUDIT_LOOP_DIR — explicit env override (manual escape hatch)
#   2. Sibling-dir scan for a dir containing scripts/sync-to-repos.mjs.
#      sync-to-repos.mjs is source-exclusive (never synced to consumers), so its
#      mere presence is sufficient proof of source-repo identity.
#   3. (No fallback) — print warning + skip.  Never aborts the push.
#
# ANCHOR THE SCAN ON THE MAIN CHECKOUT, NOT ON CWD. A push from a linked
# worktree runs with cwd = <repo>/.claude/worktrees/<name>, where \`../*/\`
# enumerates sibling WORKTREES and can never contain a sibling REPO. Measured
# 2026-09-04 in a consumer: the scan found nothing, printed a warning and
# exited 0 — a skip that reads exactly like a clean pass — on every push a
# Claude Code session makes, which is the majority of them. \`--git-common-dir\`
# is the main checkout's .git from ANY worktree; \`--show-toplevel\` is not (it
# is the worktree's own root, which is the value that was already wrong).
# Both anchors are scanned because outside a worktree they are the same
# directory, so this cannot change behaviour for a plain checkout.
AUDIT_LOOP_DIR="$CLAUDE_AUDIT_LOOP_DIR"
if [ -z "$AUDIT_LOOP_DIR" ]; then
  MAIN_PARENT=""
  COMMON_GIT_DIR="$(git rev-parse --git-common-dir 2>/dev/null)"
  if [ -n "$COMMON_GIT_DIR" ]; then
    MAIN_PARENT="$(cd "$COMMON_GIT_DIR/../.." 2>/dev/null && pwd)"
  fi
  for parent in "$MAIN_PARENT" ".."; do
    [ -n "$parent" ] || continue
    [ -d "$parent" ] || continue
    for sibling in "$parent"/*/; do
      if [ -f "$sibling/scripts/sync-to-repos.mjs" ]; then
        AUDIT_LOOP_DIR="\${sibling%/}"
        break
      fi
    done
    [ -n "$AUDIT_LOOP_DIR" ] && break
  done
fi

AUDIT_SCRIPT="$AUDIT_LOOP_DIR/scripts/openai-audit.mjs"
STATUS_CLI="$AUDIT_LOOP_DIR/scripts/check-plan-status.mjs"
if [ -z "$AUDIT_LOOP_DIR" ] || [ ! -f "$AUDIT_SCRIPT" ]; then
  echo "[prepush-hook] claude-engineering-skills not found beside \"\${MAIN_PARENT:-..}\" (set CLAUDE_AUDIT_LOOP_DIR to override) — skipping audit" >&2
  exit 0
fi

# Select the ONE in-flight plan to audit via the Status-aware CLI — NOT
# \`ls -t | head -1\`, which selected any newest .md regardless of its Status
# and would re-audit a Complete plan. The CLI writes ONLY the chosen path to
# stdout (or nothing); diagnostics + the >1-active-plan ambiguity go to stderr.
# \`|| true\` + empty-check: a malformed/absent Status must never abort the push
# (fail-closed for the gate, fail-open for the push — R3-H5).
# ── Plan Status vocabulary (drift-gated) ───────────────────────────────────
# A non-conforming Status line makes a plan INVISIBLE to the selector below, so
# it can never be audited — silently. That is how a consumer ended up with six
# unauditable plans while the pre-push audit produced a verdict zero times
# (2026-07-19). This runs the same lint the source repo gates on, but in
# \`--drift\` mode: only a plan CHANGED in this push can block, so switching it
# on cannot break a repo that already has violations. Pre-existing ones are
# printed as advisory context.
# Bypass: PLAN_STATUS_DISABLE=1 or \`git push --no-verify\`.
if [ "$PLAN_STATUS_DISABLE" != "1" ]; then
  if ! node "$STATUS_CLI" --drift >&2; then
    echo "[prepush-hook] a plan changed in this push has a non-conforming Status — fix it or set PLAN_STATUS_DISABLE=1" >&2
    exit 1
  fi
fi

PLAN_FILE=$(node "$STATUS_CLI" --select "$PLANS_DIR" 2>/dev/null || true)
[ -z "$PLAN_FILE" ] && exit 0

echo "[prepush-hook] auditing $PLAN_FILE via $AUDIT_LOOP_DIR (--scope diff)..." >&2
# AUDIT_ALLOW_FOREIGN_CWD=1: this runs the SOURCE repo's openai-audit.mjs against
# THIS (consumer) repo's cwd on purpose — the audit reads its diff from cwd, so
# the script-repo != cwd is correct here. Without it, assertRepoRoot would exit 1
# every push and the audit would never actually run.
AUDIT_ALLOW_FOREIGN_CWD=1 node "$AUDIT_SCRIPT" code "$PLAN_FILE" --scope diff > /tmp/prepush-audit-$$.json 2>&1
EXIT=$?

if [ "$EXIT" != "0" ]; then
  # Surface WHY (signal vs noise) — a non-zero audit exit is usually a config/env
  # issue (e.g. OPENAI_API_KEY absent in the push environment) rather than real
  # findings, and a blind "proceeding anyway" hides which it is. Print the tail of
  # the captured output so the operator can tell.
  echo "[prepush-hook] audit exited $EXIT (non-blocking) — reason (last lines of output):" >&2
  tail -n 6 /tmp/prepush-audit-$$.json >&2 2>/dev/null || true
  echo "[prepush-hook] ↑ config/key error → noise (fix env or ignore); real findings → address, or set AUDIT_PREPUSH_BLOCK=1 to gate." >&2
  if [ "$AUDIT_PREPUSH_BLOCK" = "1" ]; then rm -f /tmp/prepush-audit-$$.json; exit "$EXIT"; fi
fi
rm -f /tmp/prepush-audit-$$.json

# ── Surfaces-manifest drift (persona-test consistency mode) ─────────────────
# When the synced builder + a .persona-test/ dir are present, verify the
# committed .persona-test/surfaces.json still matches its *.persona-test.json
# fragments. This is the local counterpart to the CI contract test, which
# skips because the gitignored .claude-skills/ tree isn't hydrated in CI.
# BLOCKING by design: drift = a fragment edited without regenerating the
# merged file, a definite error. Bypass: SURFACES_DRIFT_DISABLE=1 or
# \`git push --no-verify\`.
SURFACES_BUILDER="scripts/.claude-skills/build-surfaces-manifest.mjs"
if [ "$SURFACES_DRIFT_DISABLE" != "1" ] && [ -f "$SURFACES_BUILDER" ] && [ -d ".persona-test" ]; then
  if ! node "$SURFACES_BUILDER" --verify >&2; then
    echo "[prepush-hook] surfaces.json drift — run \\\`npm run surfaces:build\\\` and stage it (bypass: SURFACES_DRIFT_DISABLE=1)" >&2
    exit 1
  fi
fi

# ── Repo-local extension (UNMANAGED — the consumer owns this file) ──────────
# This installer rewrites the whole hook body on every run, so repo-specific
# push gates appended HERE would be silently wiped on the next sync. Put them
# in .githooks/pre-push.local instead: it is committed, reviewable, owned by
# the consumer repo, and this installer never touches it.
#
# Its exit code is authoritative — a non-zero exit aborts the push, so a repo
# can express a genuinely blocking gate (e.g. its own test suite) without
# forking upstream tooling.
#
# Bypass: PREPUSH_LOCAL_DISABLE=1 or \`git push --no-verify\`.
LOCAL_HOOK=".githooks/pre-push.local"
if [ "$PREPUSH_LOCAL_DISABLE" != "1" ] && [ -f "$LOCAL_HOOK" ]; then
  sh "$LOCAL_HOOK" || exit $?
fi
exit 0
`;

// ── CLI args ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun     = args.includes('--dry-run');
const uninstall  = args.includes('--uninstall');
const targetIdx  = args.indexOf('--target');
const targetName = targetIdx >= 0 ? args[targetIdx + 1] : null;
const formatIdx  = args.indexOf('--format');
const format     = formatIdx >= 0 ? args[formatIdx + 1] : 'json';

// ── Per-repo install ───────────────────────────────────────────────────────

function installInRepo(repo) {
  const result = { repo: repo.name, path: repo.path, action: 'noop', error: null };
  if (!fs.existsSync(repo.path)) {
    result.action = 'skip';
    result.error  = 'repo path does not exist';
    return result;
  }
  const hooksDir = path.join(repo.path, '.git', 'hooks');
  if (!fs.existsSync(hooksDir)) {
    result.action = 'skip';
    result.error  = '.git/hooks does not exist (not a git repo, or worktree)';
    return result;
  }
  const hookPath = path.join(hooksDir, 'pre-push');

  if (uninstall) {
    if (!fs.existsSync(hookPath)) {
      result.action = 'noop';
      return result;
    }
    const existing = fs.readFileSync(hookPath, 'utf-8');
    if (!isManagedHook(existing)) {
      result.action = 'skip';
      result.error  = 'existing hook not managed by this installer';
      return result;
    }
    if (!dryRun) fs.unlinkSync(hookPath);
    result.action = dryRun ? 'would-uninstall' : 'uninstalled';
    return result;
  }

  // Install / refresh
  let existing = null;
  try { existing = fs.readFileSync(hookPath, 'utf-8'); } catch { /* absent */ }
  if (existing && !isManagedHook(existing)) {
    result.action = 'skip';
    result.error  = 'pre-push hook exists and is NOT managed by this installer (refusing to overwrite — review manually)';
    return result;
  }
  if (existing === HOOK_BODY) {
    result.action = 'noop';
    return result;
  }
  if (!dryRun) {
    fs.writeFileSync(hookPath, HOOK_BODY);
    try { fs.chmodSync(hookPath, 0o755); } catch { /* Windows — best effort */ }
  }
  result.action = dryRun ? (existing ? 'would-update' : 'would-install')
                          : (existing ? 'updated' : 'installed');
  return result;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'install-prepush-hook.mjs' });
  assertRepoRoot(import.meta.url);
  const targetRepos = resolveTargets(targetName);

  if (targetRepos.length === 0) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: `No matching repos for --target ${targetName} (available: ${CONSUMER_REPOS.map(r => r.alias).join(', ')})`,
    }) + '\n');
    process.exit(1);
  }

  const results = targetRepos.map(installInRepo);
  const ok = results.every(r => r.error === null || r.action === 'skip');

  if (format === 'human') {
    for (const r of results) {
      const icon = r.error ? '⚠' : (r.action === 'noop' ? '·' : '✓');
      process.stdout.write(`${icon} ${r.repo.padEnd(20)} ${r.action}${r.error ? ` (${r.error})` : ''}\n`);
    }
  } else {
    process.stdout.write(JSON.stringify({ ok, results }) + '\n');
  }
  process.exit(ok ? 0 : 1);
}

// Test-only surface (mirrors the file-io/shared.mjs `_internals` pattern).
export const _internals = { HOOK_BODY, HOOK_VERSION_MARKER, isManagedHook, installInRepo };

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) {
  try {
    main();
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
