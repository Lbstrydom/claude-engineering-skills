/**
 * @fileoverview The shell and git environment a test must use when it means
 * "what git runs a hook with".
 *
 * On Windows a bare `bash` can resolve to WSL's System32\bash.exe (measured: it
 * is on this machine's PATH after Git's), which shares no process table, no
 * signals and no exit-code encoding with the MSYS bash git spawns for a hook —
 * so a probe through it measures the wrong runtime. Resolve the bash that sits
 * beside `git --exec-path` instead, and name it in the result so a test can say
 * which runtime it measured.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const IS_WIN = process.platform === 'win32';

/**
 * @returns {string|null} absolute path to Git for Windows' bash.exe, `'bash'`
 *   off Windows, or null when it cannot be found (callers skip, naming why).
 */
export function resolveGitBash() {
  if (!IS_WIN) return 'bash';
  let dir;
  // GIT_* stripped: an inherited GIT_EXEC_PATH would point discovery away from the
  // installation git actually runs hooks with (audit R2-M1).
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  try { dir = execFileSync('git', ['--exec-path'], { encoding: 'utf8', env }).trim(); } catch { return null; }
  for (let i = 0; i < 6 && dir; i += 1) {
    const candidate = path.join(dir, 'usr', 'bin', 'bash.exe');
    if (fs.existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

let emptyGlobalConfig = null;
/**
 * A HERMETIC environment for fixture git: no inherited GIT_DIR & co (so nothing
 * can write into the repo running the suite — the INC-002 / sanitizeGitEnv
 * class), and no system or global config (so a user's `commit.gpgSign`,
 * `core.hooksPath` or `init.defaultBranch` cannot change what a fixture does).
 * Tests set the few settings they need explicitly.
 */
export function hermeticGitEnv(extra = {}) {
  if (!emptyGlobalConfig) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-empty-gitconfig-'));
    emptyGlobalConfig = path.join(dir, 'config');
    fs.writeFileSync(emptyGlobalConfig, '');
    // Owned by the test process: removed when it exits (audit R2-L1).
    process.once('exit', () => { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ } });
  }
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}
