/**
 * @fileoverview Shared CLI / I/O micro-helpers.
 *
 * These one-liners were independently copy-pasted across many scripts
 * (the `arch:duplicates` detector flagged them). Consolidated here so
 * there is a single source of truth — DRY without ceremony.
 *
 * @module scripts/lib/cli-io
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * Write a JSON object to stdout followed by a newline. The standard
 * machine-readable output line for the repo's CLIs (stderr stays free
 * for human progress logging).
 * @param {unknown} obj
 */
export function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

/**
 * Create a directory recursively, tolerating a pre-existing path.
 * @param {string} dir
 */
export function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

/**
 * SHA-256 of a buffer/string, hex, truncated. Default 12 chars — enough
 * to make collisions negligible for content-identity use (skill-copy
 * sync, audit-ref sync).
 * @param {import('node:crypto').BinaryLike} buf
 * @param {number} [len=12]
 * @returns {string}
 */
export function sha(buf, len = 12) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, len);
}

/**
 * Value of a `--flag` from `process.argv`, or `dflt` when absent.
 *
 * Guards against swallowing a FOLLOWING flag as this option's value (e.g.
 * `--out --json` — a missing value immediately followed by a real flag):
 * without the `startsWith('--')` check, `--json` would silently become
 * `--out`'s value and the actual `--json` flag would vanish (found live in
 * tiered-shadow-report.mjs, Gemini final-review fix 2026-07-13).
 *
 * Consolidated from THREE independently-written copies across scripts/*.mjs
 * (flagged by `arch:duplicates`) that differed only in whether they had this
 * guard. Verified safe to unify to the guarded behaviour everywhere: none of
 * the merged call sites ever expects a flag value that itself starts with
 * `--`, so the guard is a strict safety improvement with no observable
 * change for any existing caller (arch-drift-duplication-cleanup plan).
 *
 * @param {string} name
 * @param {string|null} [dflt=null]
 * @returns {string|null}
 */
export function argOption(name, dflt = null) {
  const i = process.argv.indexOf(`--${name}`);
  const next = i >= 0 ? process.argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : dflt;
}

/**
 * Whether a bare `--flag` is present anywhere in `process.argv`.
 * @param {string} name
 * @returns {boolean}
 */
export function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

/**
 * Write a message to stderr with a trailing newline — the standard
 * human-progress logging line for the repo's CLIs (stdout stays free for
 * machine-readable JSON via `emit`).
 * @param {string} msg
 */
/**
 * `1234` → `1.2s`, `188` → `188ms`. The shared duration formatter for CLI
 * output.
 *
 * Lives here rather than beside its first caller because its second caller
 * (`db-suites-gate.mjs`) would otherwise have had to import
 * `db-test-container.mjs` — a module that pulls in the `pg` driver — purely for
 * a formatter, and would have inverted the dependency: the gate is a thin
 * wrapper AROUND that script, not a consumer of its internals. Two copies of a
 * one-line formatter is the other wrong answer.
 *
 * @param {number} ms
 * @returns {string}
 */
export function fmtMs(ms) {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms)}ms`;
}

export function log(msg) {
  process.stderr.write(`${msg}\n`);
}

/**
 * Error thrown by CLI argv parsers. Carries `code: 'ARGV_ERROR'` so the
 * entry point can distinguish a usage mistake from a runtime failure.
 */
export class ArgvError extends Error {
  constructor(message) {
    super(message);
    this.code = 'ARGV_ERROR';
    this.name = 'ArgvError';
  }
}

/**
 * Reject unknown `--flags` instead of ignoring them.
 *
 * **Why this exists** (2026-07-20): `symbol-index/refresh.mjs` parsed flags with
 * an if/else-if chain and no `else`, so an unrecognised flag was silently
 * dropped. `refresh.mjs --full --dry-run` — intended as a costing dry run —
 * discarded `--dry-run` and executed a **real full refresh against the live
 * store**. It was killed before publish, but it stranded a `running` row holding
 * the per-repo lock that blocks every subsequent refresh.
 *
 * The assumption behind that command was not careless: its sibling
 * `symbol-index/prune.mjs` **does** support `--dry-run`. A family where one
 * destructive CLI honours the flag and another silently ignores it fails in the
 * dangerous direction — the operator believes they asked for less work than they
 * got. Silence is the wrong default wherever the CLI mutates.
 *
 * Deliberately narrow: it validates flag NAMES only, not values, arity, or
 * combinations — those stay with each parser, which knows its own semantics.
 * Bare (non-`--`) positional arguments are ignored for the same reason.
 *
 * @param {string[]} argv        typically `process.argv`
 * @param {Iterable<string>} known  every accepted flag, INCLUDING `--x=y` forms
 * @param {{cli?: string, from?: number}} [opts] `from` defaults to 2 (skip node + script)
 * @throws {ArgvError} naming the offending flag and listing what is accepted
 */
export function assertKnownFlags(argv, known, { cli = 'cli', from = 2 } = {}) {
  const allowed = new Set(known);
  for (let i = from; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    // `--` ends flag parsing by POSIX convention; everything after is positional.
    if (a === '--') break;
    // Accept `--flag=value` by checking the name half.
    const name = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
    if (allowed.has(name)) continue;
    throw new ArgvError(
      `${cli}: unknown flag "${name}". Accepted: ${[...allowed].sort().join(', ')}. `
      + 'Refusing to run rather than ignore it — an ignored flag on a mutating command '
      + 'silently does more than you asked for.',
    );
  }
}
