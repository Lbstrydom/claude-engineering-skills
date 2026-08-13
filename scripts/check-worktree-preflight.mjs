#!/usr/bin/env node
/**
 * @fileoverview Gate: every skill whose documented commands reach the synced
 * tooling tree must carry the worktree-preflight marker block.
 *
 * **What it protects.** In a consumer, `scripts/.claude-skills/` is gitignored
 * and therefore absent from every linked git worktree, while the `.claude/`
 * tree holding the SKILL.md is copied in by the harness. A skill without the
 * marker sends an agent at a command that cannot run there, and the only
 * feedback is a bare `MODULE_NOT_FOUND`. Reported by a consumer 2026-08-13;
 * full incident in `docs/runbooks/consumer-adoption.md` §"Linked git worktrees".
 *
 * **Why it is a gate and not a note.** The same defect class has now shipped
 * four times (`check-cli-flags`, `check-npm-run-args`, `build-audit-transcript`,
 * and this) — the instruction reaches the consumer and the tool does not. Prose
 * has not stopped it. The subject set is derived from the filesystem by
 * `skillsInvokingSyncedTooling`, so a NEW skill is in scope the moment it
 * documents such a command, without anyone remembering to enrol it.
 *
 * Usage:
 *   node scripts/check-worktree-preflight.mjs           # gate; exit 1 on any gap
 *   node scripts/check-worktree-preflight.mjs --json    # machine-readable report
 *
 * Exit codes:
 *   0  every in-scope skill carries the marker
 *   1  at least one skill is missing it, or carries an edited copy
 *   2  usage error
 *
 * @module scripts/check-worktree-preflight
 */
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import {
  EXEMPTIONS,
  checkSkill,
  skillsInvokingSyncedTooling,
} from './lib/worktree-preflight.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const G = '\x1b[32m', R = '\x1b[31m', X = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m';

const KNOWN_FLAGS = ['--json'];

/**
 * Stable diagnostic code per failure status, and the remedy that clears it.
 *
 * The code is what a poison pill matches on: an exit code alone cannot tell
 * "detected the gap" from "crashed before looking".
 */
const FAILURES = {
  missing: {
    code: 'wtpf/marker-missing',
    remedy: 'add the marker block from scripts/lib/worktree-preflight.mjs (MARKER_BLOCK), verbatim',
  },
  edited: {
    code: 'wtpf/marker-edited',
    remedy: 'the block was edited — restore it byte-for-byte, or change MARKER_BLOCK and re-run the inserter',
  },
  'no-skill-md': {
    code: 'wtpf/no-skill-md',
    remedy: 'skill directory has no SKILL.md',
  },
};

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-worktree-preflight' });
  const json = process.argv.includes('--json');

  const inScope = skillsInvokingSyncedTooling(ROOT);
  const results = inScope.map(s => checkSkill(ROOT, s));
  const failures = results.filter(r => r.status !== 'ok');

  if (json) {
    process.stdout.write(`${JSON.stringify({
      ok: failures.length === 0,
      inScope: inScope.length,
      exemptions: Object.keys(EXEMPTIONS),
      failures,
    }, null, 2)}\n`);
    process.exit(failures.length === 0 ? 0 : 1);
  }

  for (const f of failures) {
    const { code, remedy } = FAILURES[f.status];
    process.stdout.write(`${R}✗${X} skills/${f.skill}/SKILL.md ${D}${code} — ${remedy}${X}\n`);
  }

  const exempt = Object.keys(EXEMPTIONS).length;
  process.stdout.write(
    `\n${B}worktree-preflight:${X} ${inScope.length} skill(s) in scope, `
    + `${failures.length} without the marker, ${exempt} exempt — `
    + `${failures.length === 0 ? `${G}OK${X}` : `${R}FAIL${X}`}\n`,
  );

  if (failures.length > 0) {
    // Codes on stderr, one per failing skill: the poison pill matches these, and
    // an exit code alone cannot separate "found the gap" from "crashed first".
    for (const f of failures) {
      process.stderr.write(`${FAILURES[f.status].code} skills/${f.skill}/SKILL.md\n`);
    }
    process.stderr.write(
      `${R}A skill documents a command into scripts/.claude-skills/ but does not warn `
      + `that the tree is absent in a linked worktree.${X}\n`
      + `${D}Why this is gated: docs/runbooks/consumer-adoption.md §"Linked git worktrees"${X}\n`,
    );
    process.exit(1);
  }
  process.exit(0);
}

const invokedDirectly = (() => {
  try {
    const metaPath = new URL(import.meta.url).pathname.toLowerCase();
    const argvPath = process.argv[1]
      ? new URL(`file://${process.argv[1].replaceAll(/\\/g, '/')}`).pathname.toLowerCase()
      : '';
    return metaPath.endsWith('/check-worktree-preflight.mjs')
      && argvPath.endsWith('/check-worktree-preflight.mjs');
  } catch { return false; }
})();

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }
}
