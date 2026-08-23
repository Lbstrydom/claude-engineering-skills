/**
 * @fileoverview The single place `bundleRoot` and `subjectRoot` are resolved
 * for the doctor (consumer-friction-doctor plan §2.3a, closes R1-H1).
 *
 * **Two roots, never one.** `bundleRoot` is where the doctor's own CODE lives
 * — used only to resolve its sibling `lib/**` modules. `subjectRoot` is the
 * repo being DIAGNOSED. They are the same directory in the common case (a
 * consumer running its own hydrated tooling), but they are NOT the same thing
 * conceptually, and the `install.mjs doctor <target>` bootstrap is the case
 * where they genuinely diverge: `bundleRoot` is a transient acquired-bundle
 * checkout under `~/.claude-engineering-skills/bundle`, while `subjectRoot`
 * is the consumer repo `install.mjs` was pointed at. No probe ever reads
 * `bundleRoot` — that would silently diagnose the WRONG repo.
 *
 * @module scripts/lib/doctor/context
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findRepoRootFromScript } from '../assert-repo-root.mjs';

/**
 * `--consumer-root <path>` (or `=path`) out of an EXPLICIT argv array.
 *
 * Deliberately NOT `lib/cli-io.mjs`'s `argOption` — that helper reads the
 * real `process.argv` unconditionally and ignores any argv passed to it, so
 * it cannot be driven by a fixture argv in a test. `buildDoctorContext` takes
 * `argv` as a real parameter precisely so root resolution is testable without
 * mutating global process state; this tiny parser is what makes that honest.
 *
 * Three outcomes, not two (round-1 audit H6/H10 — an earlier version
 * collapsed "absent" and "present with no usable value" into one `null`,
 * so `doctor.mjs --consumer-root --gate` silently swallowed `--gate` as the
 * path and `doctor.mjs --consumer-root` at the end of argv silently fell
 * through to `subjectRoot = bundleRoot` — diagnosing the wrong repo while
 * reporting success). Mirrors `argOption`'s own "don't swallow a following
 * flag" guard, and stops at the POSIX `--` terminator the same way.
 *
 * @param {string[]} argv
 * @returns {{present: false} | {present: true, value: string|null}} `value:
 *   null` means the flag WAS given but carries no usable value — a distinct,
 *   must-error state from `present: false`.
 */
function consumerRootFlag(argv) {
  const stop = argv.indexOf('--');
  const region = stop < 0 ? argv : argv.slice(0, stop);
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    if (a.startsWith('--consumer-root=')) {
      const v = a.slice('--consumer-root='.length);
      return { present: true, value: v || null };
    }
    if (a === '--consumer-root') {
      const next = region[i + 1];
      const value = next !== undefined && !next.startsWith('--') ? next : null;
      return { present: true, value };
    }
  }
  return { present: false };
}

/**
 * Resolve `{bundleRoot, subjectRoot}` for one doctor invocation.
 *
 * Resolution order for `subjectRoot`:
 *   1. `--consumer-root <path>` if passed — realpath'd, required to exist and
 *      to contain a `.git` (a hard error otherwise, never a silent fallback).
 *   2. Otherwise `subjectRoot = bundleRoot` — the common case, where the tool
 *      runs from inside the repo it diagnoses.
 *
 * `install.mjs doctor <target>` ALWAYS passes `--consumer-root <target>`
 * explicitly (defaulting `target` to `process.cwd()` only at ITS OWN argv
 * layer, never here) — this function never guesses on that path.
 *
 * @param {string[]} argv typically `process.argv`
 * @param {{importMetaUrl?: string}} [opts] `importMetaUrl` defaults to this
 *   module's own URL; overridable so a test can point at a fixture layout
 *   without a real file tree.
 * @returns {{bundleRoot: string, subjectRoot: string}}
 */
export function buildDoctorContext(argv, opts = {}) {
  const importMetaUrl = opts.importMetaUrl ?? import.meta.url;
  const bundleRoot = findRepoRootFromScript(importMetaUrl);
  if (!bundleRoot) {
    throw new Error(
      'buildDoctorContext: could not resolve bundleRoot — this module must live under a `scripts/` '
      + 'ancestor directory (source repo layout or the synced scripts/.claude-skills/lib/doctor/ layout).',
    );
  }

  const flag = consumerRootFlag(argv);

  if (!flag.present) {
    return { bundleRoot, subjectRoot: bundleRoot };
  }
  if (flag.value == null) {
    throw new Error(
      '--consumer-root was given with no usable value (missing, or the next token looks like '
      + 'another flag) — refusing to silently fall back to bundleRoot and diagnose the wrong repo',
    );
  }

  let resolved;
  try {
    resolved = fs.realpathSync(flag.value);
  } catch (err) {
    throw new Error(`--consumer-root "${flag.value}" does not exist or is unreadable: ${err.message}`);
  }
  // A genuine `git rev-parse --is-inside-work-tree` check, not mere
  // `.git` existence (round-1 audit H6, GPT-sustained on rebuttal): a bare
  // `.git` FILE or DIRECTORY can exist without being a functioning working
  // tree — empty, corrupt, or a stray leftover from a half-finished
  // operation — and `fs.existsSync` cannot tell the difference. This still
  // accepts a linked worktree's `.git` FILE (the case the original rebuttal
  // was right to defend) because `rev-parse` resolves through it correctly;
  // it only additionally rejects the case existsSync alone could not: a
  // `.git` artifact that doesn't actually resolve to a working tree.
  const check = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: resolved, encoding: 'utf-8', windowsHide: true,
  });
  if (check.error || check.status !== 0 || check.stdout.trim() !== 'true') {
    throw new Error(
      `--consumer-root "${resolved}" is not a usable git working tree `
      + `(git rev-parse --is-inside-work-tree: ${check.error ? check.error.message : (check.stderr || check.stdout).trim() || `exit ${check.status}`}) `
      + '— refusing to guess a subjectRoot',
    );
  }
  // `--is-inside-work-tree` only proves `resolved` is SOMEWHERE inside a
  // working tree — a nested subdirectory (e.g. `src/`, a monorepo package)
  // passes too (round-3 audit M6), which would silently diagnose that
  // subdirectory as if it were the repo (probes expect subjectRoot to be the
  // repo ROOT). Normalise to the real top-level directory rather than
  // trusting the user-supplied path verbatim — this also correctly resolves
  // to a linked worktree's OWN top, not the main checkout's.
  const toplevel = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: resolved, encoding: 'utf-8', windowsHide: true,
  });
  // Round-6 audit M6: `.trim()` strips ALL leading/trailing whitespace, not
  // just git's own line terminator — a repo path that genuinely begins or
  // ends with a space (rare, but valid on the filesystems that allow it)
  // would be silently mangled. Strip only the trailing `\n`/`\r\n` record
  // terminator git's stdout always carries, leaving path characters intact.
  const toplevelPath = toplevel.stdout?.replace(/\r?\n$/, '') ?? '';
  if (toplevel.error || toplevel.status !== 0 || !toplevelPath) {
    throw new Error(
      `--consumer-root "${resolved}" is inside a git working tree but its top-level directory `
      + `could not be resolved (git rev-parse --show-toplevel: ${toplevel.error ? toplevel.error.message : (toplevel.stderr || '').trim() || `exit ${toplevel.status}`}) `
      + '— refusing to guess a subjectRoot',
    );
  }
  return { bundleRoot, subjectRoot: fs.realpathSync(toplevelPath) };
}
