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
 *
 * **`ok:false` sets a non-zero exit code** (cross-skill-command-registry §2b
 * F4, 2026-08-12). This was a bare `stdout.write` with no exit coupling at all,
 * so a CLI could report a failure in its envelope and still exit 0 — and a
 * caller that checks `$?` (every shell script, every CI step, the pre-push
 * hook) would read that as success. Measured across the 124 captured
 * cross-skill invocations before the coupling landed: 13 emitted `ok:false` at
 * exit 0. F2 and F3 took that to 0, which is what makes this enforceable
 * rather than aspirational — the ordering is load-bearing, since coupling
 * first would have failed CI on paths that were *correctly* reporting a
 * failure and merely had the wrong exit code.
 *
 * `process.exitCode ||= 1` never LOWERS an already-set code: a CLI that has
 * chosen a specific exit (2 for argv errors, 6 for strict-selector violations)
 * keeps it. Nothing here calls `process.exit` — the process still ends on its
 * own terms.
 *
 * **The opt-out is a declaration, not a flag to reach for.** `{softFail:true,
 * reason}` requires a written reason for the same purpose the registry's
 * `softFail` serves: an exemption that has to be justified in place is a claim
 * a reader can check, and a bare boolean is a silencer. Use it only where
 * `ok:false` is genuinely not a process failure.
 *
 * @param {unknown} obj
 * @param {{softFail?: boolean, reason?: string}} [opts]
 */
export function emit(obj, opts = {}) {
  // `JSON.stringify(undefined)` returns the VALUE undefined, so the old
  // `JSON.stringify(obj) + '\n'` wrote the literal string "undefined\n" to
  // stdout — invalid JSON on the one channel that is contractually
  // machine-readable, and silent. Same for a value whose `toJSON` returns
  // undefined. Refusing is the only honest option: a consumer parsing stdout
  // cannot recover from it, and writing nothing would look like a command that
  // produced no output.
  const line = JSON.stringify(obj);
  if (line === undefined) {
    throw new TypeError(
      'emit() was given a value that does not serialise to JSON (undefined, a function, or a symbol). '
      + 'stdout is the machine-readable channel — writing "undefined" there is invalid JSON a consumer cannot parse.',
    );
  }
  process.stdout.write(`${line}\n`);
  if (obj && typeof obj === 'object' && obj.ok === false) {
    if (opts.softFail === true) {
      // A non-empty STRING, not any truthy value: `{}`, `[]` and `'   '` all
      // pass a bare `!opts.reason` while explaining nothing, which is the
      // silencer this requirement exists to prevent.
      if (typeof opts.reason !== 'string' || !opts.reason.trim()) {
        throw new Error(
          'emit({ok:false}, {softFail:true}) requires a written `reason` — an unexplained '
          + 'exemption from the exit-code coupling is exactly the silence §2b F4 removes.',
        );
      }
      return;
    }
    process.exitCode ||= 1;
  }
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
  // `--name=value` as well as `--name value`. The two halves of this seam
  // DISAGREED until 2026-08-12: `assertKnownFlags` explicitly accepts the `=`
  // form (it validates the name half), so `--limit=10` passed the guard and
  // then landed here, where `indexOf('--limit')` found nothing and the DEFAULT
  // was returned. Accepted, validated, and silently dropped — the
  // accepted-and-inert class `cli:flags:gate` exists to catch, one layer below
  // the gate. Found by the consolidated Gemini gate and confirmed by executing
  // it, not by reading.
  // LAST occurrence wins — see hasFlag. A wrapper appending an override to an
  // inherited argument list is the case that makes first-wins surprising.
  // Stops at the POSIX `--` terminator, matching the cross-skill dispatcher's
  // flagRegion. The two DISAGREED, which is the same validated-vs-consumed
  // drift Cluster D fixed inside the dispatcher: a literal `--limit` after
  // `--` is a positional, and reading it as a flag is how a value meant for a
  // sub-command gets consumed by its wrapper.
  const stop = process.argv.indexOf('--');
  const region = stop < 0 ? process.argv : process.argv.slice(0, stop);
  let found;
  for (let i = 0; i < region.length; i++) {
    const a = region[i];
    if (a.startsWith(`--${name}=`)) found = a.slice(name.length + 3);
    else if (a === `--${name}`) {
      const next = region[i + 1];
      if (next !== undefined && !next.startsWith('--')) found = next;
    }
  }
  return found !== undefined ? found : dflt;
}

/**
 * Whether a bare `--flag` is present anywhere in `process.argv`.
 * @param {string} name
 * @returns {boolean}
 */
export function hasFlag(name) {
  // `--name=<v>` is honoured for the same reason argOption had to learn it:
  // assertKnownFlags accepts the `=` form, so a boolean written that way would
  // otherwise be accepted and inert. The explicit falsy spellings mean OFF —
  // `--dry-run=false` reading as "dry-run enabled" is the one interpretation
  // nobody expects.
  //
  // LAST occurrence wins, which is the standard CLI convention and what a
  // wrapper script relies on when it appends an override to an inherited
  // argument list. The first cut returned true for a bare `--name` found
  // ANYWHERE, so a later `--name=false` was silently ignored — an override that
  // validates and does nothing, which is the very class this seam was being
  // fixed for.
  // Stops at the POSIX `--` terminator, matching the cross-skill dispatcher's
  // flagRegion. The two DISAGREED, which is the same validated-vs-consumed
  // drift Cluster D fixed inside the dispatcher: a literal `--limit` after
  // `--` is a positional, and reading it as a flag is how a value meant for a
  // sub-command gets consumed by its wrapper.
  const stop = process.argv.indexOf('--');
  const region = stop < 0 ? process.argv : process.argv.slice(0, stop);
  let present = false;
  for (const a of region) {
    if (a === `--${name}`) present = true;
    else if (a.startsWith(`--${name}=`)) {
      present = !['false', '0', 'no', 'off', ''].includes(a.slice(name.length + 3).toLowerCase());
    }
  }
  return present;
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
