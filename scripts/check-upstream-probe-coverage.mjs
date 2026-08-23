#!/usr/bin/env node
/**
 * @fileoverview `upstream:coverage:gate` — every TERMINAL upstream report
 * must carry a disposition that resolves: a doctor probe id, a tracked
 * regression test, or a written exemption (consumer-friction-doctor plan
 * §2.4).
 *
 * Same shape as `check-db-suite-enrolment.mjs`: a pure function
 * (`computeDispositionDivergences`, in `lib/upstream/dispositions.mjs`) over
 * already-loaded data, with this file doing the fs/git reads. Fails closed on
 * an unreadable ledger, an unreadable registry, or zero entries — a gate that
 * can go green having read nothing is the class this repo keeps closing
 * (AGENTS.md sandbox-honesty).
 *
 * Usage:
 *   node scripts/check-upstream-probe-coverage.mjs           # human report
 *   node scripts/check-upstream-probe-coverage.mjs --gate    # exit 1 on drift
 *   node scripts/check-upstream-probe-coverage.mjs --json    # machine-readable
 *
 * Exit codes: 0 — clean (or advisory mode with findings) · 1 — --gate and drift found · 2 — usage error
 *
 * Source-repo-only: never declared in sync-to-repos.mjs, never in
 * CLI_SMOKE_SET — the ledger it validates is source-repo governance and is
 * never synced to a consumer (§9).
 *
 * @module scripts/check-upstream-probe-coverage
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { computeDispositionDivergences } from './lib/upstream/dispositions.mjs';
import { probeIds, validateRegistry } from './lib/doctor/registry.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LEDGER_PATH = path.join(REPO_ROOT, 'scripts', 'upstream-dispositions.json');

const KNOWN_FLAGS = ['--gate', '--json', '--selfcheck-relocation'];
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

/**
 * Every tracked path under `tests/`, filtered in JS to the `.test.mjs`
 * suffix — deliberately NOT a `git ls-files -- 'tests/**\/*.test.mjs'`
 * pathspec. Measured: git's default (non-glob-magic) pathspec `*` does not
 * cross `/`, so `tests/**\/*.test.mjs` matched only 19 ONE-level-nested files
 * and silently missed all ~690 flat `tests/*.test.mjs` files — which is most
 * of the suite, and every citation this ledger actually makes. Listing ALL
 * tracked files once and filtering by string suffix has no such ambiguity.
 *
 * NO fallback (round-2 audit H5/H6, GPT-sustained on rebuttal): a filesystem
 * walk can prove a path EXISTS but not that it is TRACKED, and "tracked" is
 * exactly what a `test:` disposition's contract requires — a walk-based
 * answer is a false proof of that contract, not merely a weaker one. Any
 * `git ls-files` failure now propagates; the caller's try/catch fails the
 * gate closed on it, always. The poison-pill isolation harness
 * (`check-gate-poison-pills.mjs`) gives this gate's fixture a REAL git repo
 * via its existing `needsGit` contract flag (see
 * `gate-contracts/upstream-coverage-gate.json`) rather than this function
 * pretending disk presence is git tracking.
 *
 * @returns {{files: Set<string>}}
 */
export function readTrackedTestFiles() {
  const out = execFileSync('git', ['ls-files', '-z', '--', 'tests/'], {
    cwd: REPO_ROOT, encoding: 'utf-8',
  });
  return {
    files: new Set(
      out.split('\0').filter(Boolean)
        .map((p) => p.replaceAll('\\', '/'))
        .filter((p) => p.endsWith('.test.mjs')),
    ),
  };
}

function readLedgerEntries() {
  const raw = fs.readFileSync(LEDGER_PATH, 'utf-8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed?.entries)) {
    throw new Error(`${LEDGER_PATH}: expected a top-level "entries" array`);
  }
  return parsed.entries;
}

function main() {
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-upstream-probe-coverage' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  // Round-6 audit M8 (GPT-sustained): forced process.exit() immediately
  // after a stdout write can truncate it when stdout is piped — the
  // selfcheck marker IS an automation contract (relocation-selfcheck-smoke.test.mjs
  // asserts the exact "OK" string), so it must be deterministic even at 3
  // bytes. process.exitCode + return lets the write drain naturally; this is
  // a LOCAL fix to this one call site, not a bundle-wide convention change —
  // see M8's own dismissed sibling L1/M3/M13 above for why the ordering
  // itself stays.
  if (process.argv.includes('--selfcheck-relocation')) {
    process.stdout.write('OK\n');
    process.exitCode = 0;
    return;
  }

  const gateMode = process.argv.includes('--gate');
  const asJson = process.argv.includes('--json');
  const problems = [];

  // Sandbox-honesty: the registry itself must be valid before anything it's
  // compared against means anything.
  const reg = validateRegistry();
  if (!reg.ok) {
    problems.push(`the doctor probe registry itself is invalid: ${reg.problems.join('; ')}`);
  }

  let ledgerEntries = [];
  try {
    ledgerEntries = readLedgerEntries();
  } catch (err) {
    problems.push(`cannot read ${LEDGER_PATH}: ${err.message} — refusing to report clean.`);
  }
  if (ledgerEntries.length === 0 && problems.length === 0) {
    problems.push(`${LEDGER_PATH} has zero entries — a ratchet with nothing in it is not coverage.`);
  }

  let trackedResult;
  try {
    trackedResult = readTrackedTestFiles();
  } catch (err) {
    problems.push(`git ls-files failed: ${err.message} — cannot verify test: dispositions, refusing to report clean.`);
  }

  let divergences = [], sharedPathWarnings = [];
  if (problems.length === 0) {
    ({ divergences, sharedPathWarnings } = computeDispositionDivergences({
      ledgerEntries,
      registryProbeIds: probeIds(),
      trackedTestFiles: trackedResult.files,
    }));
  }

  const allProblems = [...problems, ...divergences];
  const ok = allProblems.length === 0;

  // Round-5 audit M4: `process.exit()` immediately after a stdout write can
  // truncate the write when stdout is a pipe (CI/shell redirection) — the
  // stream may still be flushing asynchronously. `process.exitCode` sets the
  // eventual exit code and lets the event loop drain naturally instead.
  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ok, entries: ledgerEntries.length, problems: allProblems, sharedPathWarnings,
    }, null, 2)}\n`);
    process.exitCode = gateMode && !ok ? 1 : 0;
    return;
  }

  if (allProblems.length > 0) {
    process.stderr.write(`${B}${R}upstream:coverage: FAILED${X}\n`);
    for (const p of allProblems) process.stderr.write(`  ${R}✗${X} ${p}\n`);
  } else {
    process.stdout.write(
      `${G}✓${X} upstream:coverage: ${ledgerEntries.length} disposition(s) — every probe: id resolves, `
      + `every test: path is tracked and glob-matches, every exempt: reason is non-empty ${D}(0 duplicate issueId)${X}\n`,
    );
  }
  for (const w of sharedPathWarnings) {
    process.stdout.write(`  ${Y}⚠${X} ${w}\n`);
  }

  process.exitCode = gateMode && !ok ? 1 : 0;
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`
  || process.argv[1]?.endsWith('check-upstream-probe-coverage.mjs');

if (invokedDirectly) main();
