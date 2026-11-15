/**
 * @fileoverview Does this checkout rewrite committed LF files to CRLF?
 *
 * **The report (work consumer, 2026-11-15).** Byte-identity tests failed in fresh
 * worktrees and passed in the main checkout. The cause was not the code: with
 * `core.autocrlf=true` (Git for Windows sets it SYSTEM-wide) and no repo-wide
 * `eol=lf` rule in `.gitattributes`, `git worktree add` checks every text file
 * out as CRLF, and a test that compares bytes compares CRLF with LF. The main
 * checkout had been normalised long ago, so nothing there showed it.
 *
 * The hazard is a PAIR, never one half: `autocrlf=true` alone is harmless when a
 * `* ... eol=lf` (or `* -text` / `* binary`) rule pins the working tree, and a
 * missing `.gitattributes` alone is harmless when autocrlf is `input`/`false`.
 * `assessEolHazard` is the pure decision; `probeEolHazard` asks git for the
 * EFFECTIVE value (system + global + local, the one git itself uses), never a
 * single config file.
 *
 * Warn-only: it names the fix and never edits `.gitattributes` or git config —
 * both are the repo owner's call, and a renormalise is a commit of its own.
 *
 * @module scripts/lib/eol-hazard
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Values `core.autocrlf` can hold, normalised to the behaviours that matter.
 * Git's bool parser accepts more spellings than `true`/`false`, and a check that
 * only recognised those two would read `yes` as off and a genuinely-converting
 * machine as fine. Shared with the doctor's `machine/git-autocrlf` probe.
 */
export const AUTOCRLF_ENABLED = new Set(['true', 'yes', 'on', '1']);
export const AUTOCRLF_DISABLED = new Set(['false', 'no', 'off', '0']);

/** The one-line fix the warning names. */
export const EOL_FIX = 'add `* text=auto eol=lf` to .gitattributes (then `git add --renormalize .` in its own commit)';

/**
 * Does `.gitattributes` text pin EVERY path's working-tree line ending?
 * Only a rule whose pattern is `*` can pin: a per-extension rule leaves the rest
 * of the tree to autocrlf, which is exactly the "not a full .gitattributes" case.
 * Rules are read IN ORDER, as git applies them (a later line overrides only the
 * attributes it names). An explicit `eol=crlf` (e.g. `*.cmd`) is a deliberate pin, not
 * autocrlf's doing, so it keeps the pin; ANY later rule that unsets `eol` (`!eol`, `-eol`) hands those paths
 * back to autocrlf. Nested `.gitattributes` files are not read; the repo-root
 * file is what a fresh checkout's whole tree is governed by in the reported case.
 * @param {string|null} text
 * @returns {boolean}
 */
export function gitattributesPinsEol(text) {
  if (!text) return false;
  let pinned = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const [pattern, ...attrs] = line.split(/\s+/);
    const unsetsEol = attrs.some((a) => a === '!eol' || a === '-eol');
    if (unsetsEol) pinned = false;
    else if (pattern === '*' && attrs.some((a) => a === 'eol=lf' || a === 'eol=crlf' || a === '-text' || a === 'binary')) pinned = true;
  }
  return pinned;
}

/**
 * @param {{autocrlf: string|null, gitattributes: string|null}} input
 *   `autocrlf` is git's effective value (null when unset); `gitattributes` the
 *   repo-root file's text (null when absent).
 * @returns {{hazard: boolean, reason: string|null}}
 */
export function assessEolHazard({ autocrlf, gitattributes }) {
  const on = AUTOCRLF_ENABLED.has(String(autocrlf ?? '').trim().toLowerCase());
  if (!on) return { hazard: false, reason: null };
  if (gitattributesPinsEol(gitattributes)) return { hazard: false, reason: null };
  return {
    hazard: true,
    reason: `core.autocrlf=${String(autocrlf).trim()} and ${gitattributes == null ? 'no .gitattributes' : 'no repo-wide `* … eol=lf` rule in .gitattributes'}`
      + ' — a fresh worktree checks text files out as CRLF, and byte-identity tests then fail on line endings, not code',
  };
}

/**
 * Probe a checkout. Never throws: a git failure reads as "not measured", never
 * as "no hazard".
 * @param {string} repoRoot
 * @param {{run?: (args: string[], cwd: string) => string}} [io]
 * @returns {{measured: boolean, hazard: boolean, reason: string|null}}
 */
export function probeEolHazard(repoRoot, io = {}) {
  const run = io.run ?? ((args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  let autocrlf = null;
  let top;
  try {
    top = run(['rev-parse', '--show-toplevel'], repoRoot).trim();
  } catch {
    return { measured: false, hazard: false, reason: 'not a git checkout' };
  }
  // `git config --get` exits 1 when the key is unset — that is "unset", not a
  // failure. Any other failure could not be measured and must not read as "unset".
  try { autocrlf = run(['config', '--get', 'core.autocrlf'], top).trim() || null; } catch (err) {
    if (err?.status !== 1) return { measured: false, hazard: false, reason: `could not read core.autocrlf (${err?.message || err})` };
    autocrlf = null;
  }
  let gitattributes = null;
  try { gitattributes = fs.readFileSync(path.join(top, '.gitattributes'), 'utf8'); } catch { gitattributes = null; }
  return { measured: true, ...assessEolHazard({ autocrlf, gitattributes }) };
}
