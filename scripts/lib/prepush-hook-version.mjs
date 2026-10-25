/**
 * @fileoverview The consumer pre-push hook's version, in ONE place. `install-prepush-hook.mjs` embeds it in the generated body; the body
 * asks `prepush-step.mjs hook-version` (which prints this) and warns when the source checkout expects a newer hook than the one
 * installed; the sync's epilogue reads each consumer's installed marker against it. Bump it when the generated body changes in a way a
 * consumer must re-install to pick up (the changelog stays beside the body, in the installer).
 *
 * Also the read-only inspector the sync uses to say, per consumer, whether its hook is current. It never installs: the sync deliberately
 * never writes to .git/hooks (an operator's hook is not ours to clobber).
 *
 * @module scripts/lib/prepush-hook-version
 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { GIT_LOCAL_ENV_VARS } from './git-env-sanitize.mjs';

export const PREPUSH_HOOK_VERSION = 16;

/** The marker the installer writes into every hook it owns (the installer imports it, so the two cannot drift). */
export const HOOK_MARKER = '# managed-by: claude-engineering-skills install-prepush-hook.mjs';
/** Markers of the pre-rename installer: still ours, still upgradable in place. */
export const LEGACY_HOOK_MARKERS = Object.freeze(['# managed-by: claude-audit-loop install-prepush-hook.mjs']);

export const isManagedHookText = (text) => !!text && (text.includes(HOOK_MARKER) || LEGACY_HOOK_MARKERS.some((m) => text.includes(m)));

/** `# hook-version: N` -> N, or null. Reads the marker the installer writes, nothing else. */
export function installedHookVersion(hookText) {
  const m = /^# hook-version: (\d+)\s*$/m.exec(String(hookText ?? ''));
  return m ? Number(m[1]) : null;
}

/** The EFFECTIVE hook path of a repo, absolute, as git resolves it (honours core.hooksPath and a linked worktree's `.git` file). null on any failure. */
export function effectiveHookPath(repoPath, { run } = {}) {
  const env = { ...process.env };
  for (const k of GIT_LOCAL_ENV_VARS) delete env[k];
  try {
    const out = (run ?? ((args) => execFileSync('git', ['-C', repoPath, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 })))(
      ['rev-parse', '--path-format=absolute', '--git-path', 'hooks/pre-push']).trim();
    return out && /^([A-Za-z]:[\\/]|\/)/.test(out) ? out : null;   // a relative answer is never resolved against THIS process's cwd
  } catch { return null; }
}

/**
 * Where does a consumer's installed hook stand against this checkout's expected version?
 * @returns {{state: 'current'|'stale'|'absent'|'not-managed'|'not-inspected', installed?: number, why?: string}}
 */
export function inspectInstalledHook(repoPath, { expected = PREPUSH_HOOK_VERSION, resolvePath = effectiveHookPath, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  const p = resolvePath(repoPath);
  if (!p) return { state: 'not-inspected', why: 'git could not resolve the hook path' };
  let text;
  try { text = readFile(p); } catch (e) { return e?.code === 'ENOENT' ? { state: 'absent' } : { state: 'not-inspected', why: `the hook file is unreadable (${e?.code || 'error'})` }; }
  if (!isManagedHookText(text)) return { state: 'not-inspected', why: 'not managed by this installer' };
  const installed = installedHookVersion(text);
  if (installed === null) return { state: 'stale', installed: 0 };   // a managed hook with no version line predates versioning
  return installed < expected ? { state: 'stale', installed } : { state: 'current', installed };
}

/**
 * The sync epilogue's per-consumer lines. Silent only for a managed hook at the current version; every other state says what it is.
 * @param {Array<{name: string, alias?: string, path: string}>} repos
 * @param {{inspect?: typeof inspectInstalledHook, expected?: number}} [opts]
 * @returns {string[]}
 */
export function hookEpilogueLines(repos, { inspect = inspectInstalledHook, expected = PREPUSH_HOOK_VERSION } = {}) {
  const lines = [];
  for (const r of repos) {
    if (!r?.path || !fs.existsSync(r.path)) continue;
    const s = inspect(r.path, { expected });
    const target = r.alias ?? r.name;
    if (s.state === 'stale') lines.push(`${r.name}: pre-push hook v${s.installed} installed, the bundle is v${expected} - npm run hooks:install -- --target ${target}`);
    else if (s.state === 'absent') lines.push(`${r.name}: no hook installed`);
    else if (s.state === 'not-inspected') lines.push(`${r.name}: hook not inspected (${s.why})`);
  }
  return lines;
}
