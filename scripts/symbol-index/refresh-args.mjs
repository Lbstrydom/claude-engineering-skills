/**
 * @fileoverview CLI argument parsing for `refresh.mjs`.
 *
 * Extracted from `refresh.mjs` (docs/plans/tiered-pipeline-refresh-god-module-decomposition.md).
 *
 * @module scripts/symbol-index/refresh-args
 */

import { assertKnownFlags } from '../lib/cli-io.mjs';

/**
 * Every flag this CLI accepts. `assertKnownFlags` rejects anything else.
 *
 * **The allowlist must list only flags this file actually HANDLES.** A first
 * draft added `--selfcheck-relocation` on the assumption refresh.mjs carried the
 * smoke-test handler like its siblings. It does not — it is not in
 * `CLI_SMOKE_SET` (AGENTS.md) — so the guard accepted the flag, the parser
 * ignored it, and the run proceeded to a real live refresh that published as
 * active. That is precisely the accepted-then-ignored bug this guard exists to
 * prevent, reintroduced one layer up. An allowlist entry is a claim that the
 * parser below does something with it.
 */
export const KNOWN_FLAGS = Object.freeze([
  '--full', '--since-commit', '--force', '--include-delegates',
]);

export function parseArgs(argv) {
  // Reject unknown flags BEFORE any work. This chain used to have no `else`, so
  // an unrecognised flag was silently dropped: `--full --dry-run`, intended as a
  // costing dry run, discarded `--dry-run` and ran a REAL full refresh against
  // the live store (2026-07-20). Note this CLI has no `--dry-run` while its
  // sibling `prune.mjs` does — a family that honours the flag in one destructive
  // command and ignores it in another fails in the dangerous direction.
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'refresh' });

  const args = { full: false, sinceCommit: null, force: false, includeDelegates: false };
  for (let i = 2; i < argv.length; i++) {
    let a = argv[i], inlineValue = null;
    // POSIX `--` terminator: assertKnownFlags above already stops validating
    // at this token (cli-io.mjs), so this parser must honor the same
    // boundary — without this break, `refresh.mjs -- --full` would pass
    // validation but this loop would keep going and match the positional
    // `--full` as a real flag (Gemini-shadow finding, symbol-index-pipeline-
    // reliability-hardening final-gate round 2).
    if (a === '--') break;
    const eq = a.indexOf('=');
    if (eq !== -1) { inlineValue = a.slice(eq + 1); a = a.slice(0, eq); }
    switch (a) {
      case '--full':
        if (inlineValue !== null) throw new Error(`--full does not take a value; got --full=${inlineValue}`);
        args.full = true; break;
      case '--since-commit': {
        const value = inlineValue !== null ? inlineValue : argv[i + 1];
        // round-2 H2: reject, never silently accept, every shape that would
        // otherwise fall through to "value is falsy → treated as absent →
        // silently promoted to a full walk" — end-of-argv (value undefined),
        // a missing value where the NEXT token is itself a known flag
        // (`--since-commit --force`, which used to consume `--force` as the
        // commit and leave force disabled), and `--since-commit=` (empty
        // string).
        if (!value || value.startsWith('--')) {
          throw new Error(`--since-commit requires a non-empty value (got ${JSON.stringify(value ?? null)})`);
        }
        if (inlineValue === null) i++; // only advance past a space-separated value
        args.sinceCommit = value;
        break;
      }
      case '--force':
        if (inlineValue !== null) throw new Error(`--force does not take a value; got --force=${inlineValue}`);
        args.force = true; break;
      case '--include-delegates':
        if (inlineValue !== null) throw new Error(`--include-delegates does not take a value; got --include-delegates=${inlineValue}`);
        args.includeDelegates = true; break;
    }
  }
  return args;
}
