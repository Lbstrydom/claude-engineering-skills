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

const HOOK_MARKER     = '# managed-by: claude-engineering-skills install-prepush-hook.mjs';
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
#
# Auto-runs /audit-code on any draft plan in docs/plans/ before the push.
# Non-blocking by default: prints findings to stderr, never aborts the
# push.  To block on HIGH findings, set AUDIT_PREPUSH_BLOCK=1.
#
# Bypass per-push: \`git push --no-verify\`.
# Disable session: \`AUDIT_PREPUSH_DISABLE=1 git push\`.

[ "$AUDIT_PREPUSH_DISABLE" = "1" ] && exit 0

PLANS_DIR="docs/plans"
[ ! -d "$PLANS_DIR" ] && exit 0

# Find the newest plan (most recently modified) — typical convention is
# one active plan at a time.  If multiple exist, audit the freshest.
PLAN_FILE=$(ls -t "$PLANS_DIR"/*.md 2>/dev/null | head -1)
[ -z "$PLAN_FILE" ] && exit 0

# Locate the audit-loop install — rename-resilient discovery.  Search order:
#   1. \$CLAUDE_AUDIT_LOOP_DIR — explicit env override (manual escape hatch)
#   2. Sibling-dir scan: any ../<dir>/ that contains scripts/sync-to-repos.mjs.
#      Gemini-r3 G1 fix: aligned with the JS resolveSourceRepo's
#      single-deterministic-sentinel approach — sync-to-repos.mjs is
#      source-exclusive (never synced to consumer repos), so its mere
#      presence is sufficient proof of source-repo identity. The old
#      dual-file check (openai-audit.mjs + install-prepush-hook.mjs)
#      false-matched consumer repos that had both synced.
#   3. (No fallback) — print warning + skip.  Never aborts the push.
AUDIT_LOOP_DIR="$CLAUDE_AUDIT_LOOP_DIR"
if [ -z "$AUDIT_LOOP_DIR" ]; then
  for sibling in ../*/; do
    if [ -f "$sibling/scripts/sync-to-repos.mjs" ]; then
      AUDIT_LOOP_DIR="\${sibling%/}"
      break
    fi
  done
fi

AUDIT_SCRIPT="$AUDIT_LOOP_DIR/scripts/openai-audit.mjs"
if [ -z "$AUDIT_LOOP_DIR" ] || [ ! -f "$AUDIT_SCRIPT" ]; then
  echo "[prepush-hook] audit-loop not found in any sibling dir (set CLAUDE_AUDIT_LOOP_DIR to override) — skipping audit" >&2
  exit 0
fi

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

main();
