#!/usr/bin/env node
/**
 * @fileoverview `db:enrolment:gate` — a live-DB test suite that no runner
 * names has never run, and node reports it as a clean pass.
 *
 * Why this exists (measured 2026-08-11). A test file gated on
 * `AUDIT_DB_TEST_URL` skips itself when the variable is unset, and node's test
 * runner reports a suite that never ran as `# fail 0`. So the ONLY thing that
 * makes such a suite real coverage is being named in one of
 * `db-test-container.mjs`'s three exported lists. A census found 25 gated
 * files against 9 enrolled: **15 suites had never executed in any
 * environment** since the day they landed. `tests/plans-ship-persona-correlation.test.mjs`
 * shipped with the WS1 correlator, was named nowhere, and failed on its
 * first-ever run once enrolled — its fixture seeded a `verdict` value the
 * schema CHECK had rejected since 20260413224948.
 *
 * **The direction is the whole point.** `tests/db-test-container.test.mjs`
 * already checks registry↔workflow in BOTH directions, and it was green
 * throughout — because both sides agreed about the 9 files they knew of.
 * Nothing iterated the FILESYSTEM, so the 15 files neither side had heard of
 * were unrepresentable in the comparison. This gate iterates disk, which is
 * the only side that can see an unenrolled file. It is AGENTS.md's third
 * consumer-reported shape ("a check verifying one direction only — which side
 * am I iterating, and what is unrepresentable from it?") applied to the test
 * registry itself.
 *
 * **Why a literal-string scan plus an explicit exemption list**, rather than a
 * cleverer regex that recognises the skip idiom: the idiom is not one shape.
 * The real files use `const skip = TEST_URL ? …`, `{ skip: dbSkip }`,
 * `skipReason`, and `{ skip: !RUN_IT && … }`. A first pass at this census with
 * a skip-shaped regex silently missed two suites — the exact "static-scan
 * guards die on interpolation" failure this repo has hit before. The literal
 * `AUDIT_DB_TEST_URL` is the one token that cannot be spelled another way, so
 * the scan over-collects on purpose and every non-suite is disposed of by name
 * with a written reason. An allowlist is a property of what "needs a database"
 * means; a regex is a guess about how someone wrote their skip.
 *
 * Fails closed. Zero test files scanned, zero candidates found, or an
 * unreadable registry are all failures — a gate that can go green having read
 * nothing is the class this repo keeps closing (AGENTS.md sandbox-honesty).
 *
 * Usage:
 *   node scripts/check-db-suite-enrolment.mjs           # gate (exit 1 on drift)
 *   node scripts/check-db-suite-enrolment.mjs --json    # machine-readable
 *
 * Exit codes: 0 — every gated suite is enrolled or exempt · 1 — drift, or the
 * scanner could not do its job.
 *
 * @module scripts/check-db-suite-enrolment
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import {
  DESTRUCTIVE_SUITE_FILES,
  ISOLATED_SUITE_FILES,
  CONTRACT_SUITE_FILES,
  DB_SUITE_ENROLMENT_EXEMPT,
} from './db-test-container.mjs';

const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS_DIR = path.join(REPO_ROOT, 'tests');

/**
 * The one token a gated suite cannot spell any other way. Deliberately NOT a
 * skip-idiom pattern — see the file docstring.
 */
const GATE_TOKEN = 'AUDIT_DB_TEST_URL';

/**
 * `tests/fixtures/` holds INPUTS to suites, not suites — the runner never
 * executes them, so enrolment is meaningless there and a fixture that happens
 * to contain the token would be an unfixable false positive.
 */
const NOT_A_SUITE_DIR = 'tests/fixtures/';

/** Repo-relative, forward-slashed — the spelling both registries use. */
function listTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTestFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      const rel = path.relative(REPO_ROOT, full).split(path.sep).join('/');
      if (!rel.startsWith(NOT_A_SUITE_DIR)) out.push(rel);
    }
  }
  return out;
}

export function analyse({ testFiles, readFile, enrolled, exempt }) {
  const problems = [];
  const enrolledSet = new Set(enrolled);
  const exemptByFile = new Map(exempt.map((e) => [e.file, e.reason]));

  const candidates = testFiles.filter((f) => readFile(f).includes(GATE_TOKEN));

  // Sandbox honesty: both of these mean the scanner read nothing useful, which
  // must never present as "no drift".
  if (testFiles.length === 0) {
    problems.push('scanned ZERO test files — the scanner is broken or tests/ moved; refusing to report clean.');
  } else if (candidates.length === 0) {
    problems.push(`no test file mentions ${GATE_TOKEN} — either every DB suite was deleted or the scan is broken; refusing to report clean.`);
  }

  for (const f of candidates) {
    const isEnrolled = enrolledSet.has(f);
    const isExempt = exemptByFile.has(f);
    if (isEnrolled && isExempt) {
      problems.push(`${f}: BOTH enrolled and exempt — exactly one, never both. Drop the exemption if the suite really runs.`);
    } else if (!isEnrolled && !isExempt) {
      problems.push(
        `${f}: mentions ${GATE_TOKEN} but is named by no runner and has no exemption.\n`
        + `      As written it SKIPS whenever the variable is unset, and node reports a suite that never ran as a pass —\n`
        + `      so it is not coverage. Add it to a *_SUITE_FILES list in scripts/db-test-container.mjs AND to\n`
        + `      .github/workflows/postgres-parity.yml (kept in lockstep by tests/db-test-container.test.mjs),\n`
        + `      or add a DB_SUITE_ENROLMENT_EXEMPT entry saying why it needs no database.`,
      );
    }
  }

  // Stale dispositions cut the other way: an entry that no longer describes
  // reality is how a list quietly stops meaning anything.
  const candidateSet = new Set(candidates);
  for (const [file, reason] of exemptByFile) {
    if (!testFiles.includes(file)) {
      problems.push(`DB_SUITE_ENROLMENT_EXEMPT names ${file}, which does not exist — stale entry, delete it.`);
    } else if (!candidateSet.has(file)) {
      problems.push(`DB_SUITE_ENROLMENT_EXEMPT names ${file}, which no longer mentions ${GATE_TOKEN} — the exemption is moot, delete it.`);
    }
    if (!String(reason ?? '').trim()) {
      problems.push(`DB_SUITE_ENROLMENT_EXEMPT entry for ${file} has an empty reason — an undocumented exemption is just an unenrolled suite.`);
    }
  }
  for (const f of enrolledSet) {
    if (!testFiles.includes(f)) {
      problems.push(`a *_SUITE_FILES list names ${f}, which does not exist — the runner would fail on it.`);
    }
  }

  return { candidates, problems };
}

function main() {
  try {
    assertKnownFlags(process.argv.slice(2), ['--json']);
  } catch (e) {
    if (e instanceof ArgvError) { process.stderr.write(`${e.message}\n`); process.exit(1); }
    throw e;
  }
  const asJson = process.argv.includes('--json');

  let testFiles;
  try {
    testFiles = listTestFiles(TESTS_DIR);
  } catch (e) {
    process.stderr.write(`${R}db-suite-enrolment: could not read ${TESTS_DIR} (${e.message}) — failing rather than reporting clean.${X}\n`);
    process.exit(1);
  }

  const enrolled = [...DESTRUCTIVE_SUITE_FILES, ...ISOLATED_SUITE_FILES, ...CONTRACT_SUITE_FILES];
  const { candidates, problems } = analyse({
    testFiles,
    readFile: (f) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8'),
    enrolled,
    exempt: DB_SUITE_ENROLMENT_EXEMPT,
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify({
      ok: problems.length === 0,
      scanned: testFiles.length,
      candidates: candidates.length,
      enrolled: enrolled.length,
      exempt: DB_SUITE_ENROLMENT_EXEMPT.length,
      problems,
    }, null, 2)}\n`);
    process.exit(problems.length === 0 ? 0 : 1);
  }

  if (problems.length > 0) {
    process.stderr.write(`${B}${R}db-suite-enrolment: FAILED${X}\n`);
    for (const p of problems) process.stderr.write(`  ${R}✗${X} ${p}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `${G}✓${X} db-suite-enrolment: ${candidates.length} ${GATE_TOKEN}-gated suite(s) — `
    + `${enrolled.length} enrolled, ${DB_SUITE_ENROLMENT_EXEMPT.length} exempt ${D}(scanned ${testFiles.length} test files)${X}\n`,
  );
}

main();
