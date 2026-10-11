/**
 * @fileoverview The ONE resolver for Claude Code harness paths on this machine: the account's
 * config root, a project's memory dir, and the scheduled-task store. Path-only and dependency-free
 * (node built-ins), so lightweight callers (fleet) can use it without loading config/yaml/zod.
 *
 * Why it exists (docs/plans/fleet-handover.md §2b): the config root belongs to the ACCOUNT, not the
 * machine. Claude Code honours `CLAUDE_CONFIG_DIR`; the previous resolver hard-coded
 * `~/.claude`, so on an account with its own config dir it resolved memory nobody reads.
 *
 * @module scripts/lib/harness-paths
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * The account's Claude Code config root: `CLAUDE_CONFIG_DIR` when set and non-empty, else
 * `<home>/.claude`. Not canonicalised (it may be a symlink/junction — a normal setup).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{homedir?: string}} [opts] test seam
 */
export function claudeConfigDir(env = process.env, { homedir = os.homedir() } = {}) {
  const v = typeof env.CLAUDE_CONFIG_DIR === 'string' ? env.CLAUDE_CONFIG_DIR.trim() : '';
  return v ? path.resolve(v) : path.join(homedir, '.claude');
}

/** Harness project slug — VERIFIED: `C:\GIT\claude-engineering-skills` → `c--GIT-claude-engineering-skills`
 *  (lowercase the drive letter, then each non-alphanumeric char → a single `-`, per-char not per-run). */
export function harnessProjectSlug(absRoot) {
  return String(absRoot)
    .replace(/^([A-Za-z]):/, (_, d) => `${d.toLowerCase()}:`)
    .replace(/[^A-Za-z0-9]/g, '-');
}

/** The slug alphabet. A manifest-supplied slug outside it is refused (never a path component). */
export const SLUG_RE = /^[A-Za-z0-9-]+$/;

const dirExists = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };

/**
 * A project's harness memory dir under the account's config root. `repoRoot` must be the MAIN
 * checkout (the parent of the git common dir): the harness keys a worktree session's memory to the
 * repo it belongs to.
 * @returns {{dir: string, configDir: string, slug: string, exists: boolean}}
 */
export function harnessMemoryDir({ repoRoot = process.cwd(), env = process.env, homedir } = {}) {
  const configDir = claudeConfigDir(env, homedir ? { homedir } : undefined);
  const slug = harnessProjectSlug(path.resolve(repoRoot));
  const dir = path.join(configDir, 'projects', slug, 'memory');
  return { dir, configDir, slug, exists: dirExists(dir) };
}

/** `<config>/projects/<slug>/memory` for a known slug (refuses a slug outside the alphabet). */
export function memoryDirForSlug(configDir, slug) {
  if (!SLUG_RE.test(String(slug))) throw new Error(`invalid harness project slug: ${JSON.stringify(slug)}`);
  return path.join(configDir, 'projects', slug, 'memory');
}

/** The scheduled-task store: `<config>/scheduled-tasks/<id>/SKILL.md`. */
export function scheduledTasksDir(configDir) {
  return path.join(configDir, 'scheduled-tasks');
}

/** Case-insensitive on win32 (NTFS), exact elsewhere — the one comparison for harness paths. */
export function samePath(a, b, platform = process.platform) {
  const n = (p) => path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? n(a).toLowerCase() === n(b).toLowerCase() : n(a) === n(b);
}
