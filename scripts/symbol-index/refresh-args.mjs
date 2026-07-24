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
    const a = argv[i];
    if (a === '--full') args.full = true;
    else if (a === '--since-commit') args.sinceCommit = argv[++i];
    else if (a === '--force') args.force = true;
    else if (a === '--include-delegates') args.includeDelegates = true;
  }
  return args;
}
