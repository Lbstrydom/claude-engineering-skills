#!/usr/bin/env node
/**
 * @fileoverview event-wiring-scan.mjs — Phase 0 GO/NO-GO probe for the
 * event-wiring-symmetry detector, and a standalone diagnostic afterwards.
 *
 * Repo-wide mode only (D2d): every production dispatch site in the corpus is
 * treated as a candidate, no diff/baseline is used. The diff-triggered
 * production entry point lives in event-wiring-corpus.mjs's
 * detectEventWiringAsymmetry, wired into Wave 1.5c (Phase 1).
 *
 * Design: docs/plans/event-wiring-symmetry.md §7 (CLI result envelope), §7b
 * (Phase 0's GO/NO-GO gate).
 *
 * Usage:
 *   node scripts/event-wiring-scan.mjs --repo <path> [--json]
 *   node scripts/event-wiring-scan.mjs --repo <path> --oracle <expected.json> [--json]
 *
 * Exit codes (precedence 2 -> 1 -> 3 -> 4 -> 0):
 *   0 — scan completed, zero findings is a success
 *   1 — operational scan failure (repo unreadable, corpus build threw)
 *   2 — invalid invocation (unknown flag, bad --repo, malformed --oracle, invalid wrapper config)
 *   3 — partial scan (counters.skippedFiles > 0)
 *   4 — oracle mismatch (--oracle only) — the Phase-0 NO-GO signal
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, emit } from './lib/cli-io.mjs';
import { buildCorpus, loadEventWiringConfig } from './lib/audit/event-wiring-corpus.mjs';
import { resolveSymmetry } from './lib/audit/event-wiring.mjs';

const KNOWN_FLAGS = ['--repo', '--json', '--oracle', '--selfcheck-relocation'];

// audit-code R2/M3,M6,M8 fix: validate flags FIRST, matching cross-skill.mjs's
// precedent (assertKnownFlags before its own --selfcheck-relocation check) —
// not check-setup.mjs's/symbol-index/drift.mjs's unconditional-first pattern,
// which this file originally followed and which lets `--selfcheck-relocation
// --unknown-garbage` succeed silently. assertKnownFlags is a lightweight,
// dependency-free check in the same cli-io.mjs module this file already
// requires to run at all, so gating on it first doesn't weaken the
// relocation smoke test's own guarantee (imports resolved).
try {
  assertKnownFlags(process.argv.slice(2), KNOWN_FLAGS, { cli: 'event-wiring-scan', from: 0 });
} catch (err) {
  process.stderr.write(`${err.message}\n`);
  process.exit(2);
}
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

// audit-code R1/M7 fix: a value-taking flag with no following token (a
// terminal `--oracle`) or whose "value" is really the next flag (`--oracle
// --json`) must be an invocation error, not a silently-absent option — the
// prior version read `argv[idx+1]` unconditionally, so `--oracle` at the end
// of argv resolved to `undefined`, which is indistinguishable from "no
// --oracle flag at all" and made an intended oracle-gated run execute as an
// ungated scan that exits 0.
function requiredValue(argv, flag, cli) {
  const idx = argv.indexOf(flag);
  if (idx === -1) return null;
  const value = argv[idx + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`${cli}: ${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv) {
  // Flags already validated at module top (before the --selfcheck-relocation
  // check) — not re-validated here to avoid a confusing double-check.
  return {
    repo: requiredValue(argv, '--repo', 'event-wiring-scan'),
    json: argv.includes('--json'),
    oracle: requiredValue(argv, '--oracle', 'event-wiring-scan'),
  };
}

function fail(code, message, jsonOut) {
  // No softFail here — these ARE real failures (that's the whole point of a
  // non-zero exit). softFail declares an ok:false that ISN'T a failure, which
  // is the opposite claim and would wrongly register this CLI in the repo's
  // emit:exit:gate opt-out ratchet. emit()'s own `process.exitCode ||= 1` only
  // ever sets 1; the explicit assignment below is what actually selects 2/3/4,
  // and it always wins since it runs after.
  if (jsonOut) {
    emit({ ok: false, error: { code: `EXIT_${code}`, message } });
  } else {
    process.stderr.write(`event-wiring-scan: ${message}\n`);
  }
  process.exitCode = code;
}

function main() {
  const argv = process.argv.slice(2);
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  // audit-code R4/L1 fix: existsSync alone accepts a regular FILE, which
  // then surfaces as an opaque git failure deep inside corpus construction
  // instead of the CLI's own documented invocation error.
  let repoStat;
  try { repoStat = args.repo ? fs.statSync(args.repo) : null; } catch { repoStat = null; }
  if (!args.repo || !repoStat || !repoStat.isDirectory()) {
    fail(2, `--repo is required and must be an existing directory (got: ${args.repo ?? '(none)'})`, args.json);
    return;
  }
  const repoPath = path.resolve(args.repo);

  let expected = null;
  if (args.oracle) {
    try {
      expected = JSON.parse(fs.readFileSync(args.oracle, 'utf8'));
    } catch (err) {
      fail(2, `--oracle file unreadable/malformed: ${err.message}`, args.json);
      return;
    }
    // audit-code R2/M2 fix (REOPENED — the round-1 fix for a missing value
    // didn't cover this adjacent gap): a syntactically valid JSON file with
    // the WRONG shape (e.g. `{}`, or `events` missing/not-an-array) passed
    // the truthy `if (expected)` check unconditionally, and an oracle with
    // zero events trivially "matches" any real result — silently disabling
    // verification instead of failing on a malformed invocation.
    const shapeError = validateOracleShape(expected);
    if (shapeError) {
      fail(2, `--oracle file has an invalid shape: ${shapeError}`, args.json);
      return;
    }
  }

  let wrappers;
  let totalByteBudgetMb;
  try {
    ({ wrappers, totalByteBudgetMb } = loadEventWiringConfig(repoPath));
  } catch (err) {
    fail(2, `invalid wrapper config: ${err.message}`, args.json);
    return;
  }

  let corpus;
  let counters;
  try {
    // audit-code R4/M1 fix — same class of gap the R1/M6 fix closed for the
    // production entry point, missed here: the config's own budget was
    // loaded but never threaded into THIS call.
    const built = buildCorpus({ repoPath, wrappers, totalByteBudgetMb });
    corpus = built.sites;
    counters = built.counters;
  } catch (err) {
    fail(1, `corpus build failed: ${err.message}`, args.json);
    return;
  }

  const { findings, coverage } = resolveSymmetry({
    corpus,
    addedDispatches: corpus.dispatches.filter(d => d.runtime === 'production'),
    removedListeners: [],
  });
  const partial = counters.skippedFiles > 0;

  if (partial) {
    // Precedence: 3 before 4 — a partial scan can never legitimately mismatch,
    // so this returns unconditionally, before any --oracle comparison runs.
    fail(3, `partial scan — ${counters.skippedFiles} file(s) skipped; refusing to claim completeness`, args.json);
    return;
  }

  if (expected) {
    const mismatch = compareOracle(expected, coverage, findings);
    if (mismatch) {
      if (args.json) {
        emit({ ok: false, error: { code: 'EXIT_4', message: mismatch } });
      } else {
        process.stderr.write(`event-wiring-scan: oracle mismatch — ${mismatch}\n`);
      }
      process.exitCode = 4;
      return;
    }
  }

  const envelope = { ok: true, findings, counters, partial };
  if (args.json) {
    emit(envelope);
  } else {
    process.stdout.write(`event-wiring-scan: ${findings.length} finding(s), ${counters.skippedFiles} skipped, ${counters.excludedFiles} excluded\n`);
  }
}

// §7b's fixed vocabulary: actionable = disposition ∈ {DELETED, REAL-BUG}; the
// third value (FP) is the pragma-suppressed case. Nothing else is meaningful.
const KNOWN_DISPOSITIONS = new Set(['DELETED', 'REAL-BUG', 'FP']);

/**
 * Returns an error string if `expected` isn't a usable oracle shape, else
 * null. audit-code R3/M2,M4 fix: a non-empty string alone isn't validation —
 * `compareOracle` only assigns meaning to the fixed 3-value vocabulary above,
 * so an unrecognised disposition previously passed shape validation and then
 * silently fell into the "actionable" bucket (anything `!== 'FP'`) with no
 * signal that the oracle file itself was wrong.
 */
function validateOracleShape(expected) {
  if (!expected || typeof expected !== 'object') return 'not an object';
  // audit-code R4/M5 fix: version-check + duplicate-name check — an
  // unversioned or duplicate-name oracle previously passed shape validation
  // and reached compareOracle(), where duplicate names silently collapsed
  // through Set-based comparison with no signal the input was ambiguous.
  if (expected.version !== 1) return `"version" must be 1, got: ${JSON.stringify(expected.version)}`;
  if (!Array.isArray(expected.events) || expected.events.length === 0) return '"events" must be a non-empty array';
  const seenNames = new Set();
  for (const [i, e] of expected.events.entries()) {
    if (!e || typeof e.name !== 'string' || !e.name) return `events[${i}] is missing a string "name"`;
    if (seenNames.has(e.name)) return `events[${i}] duplicates event name "${e.name}"`;
    seenNames.add(e.name);
    if (e.class !== 'dispatch-only') return `events[${i}].class must be "dispatch-only" (v1's only recognised class, D3), got: ${JSON.stringify(e.class)}`;
    if (typeof e.disposition !== 'string' || !KNOWN_DISPOSITIONS.has(e.disposition)) {
      return `events[${i}].disposition must be one of ${[...KNOWN_DISPOSITIONS].join('|')}, got: ${JSON.stringify(e.disposition)}`;
    }
  }
  return null;
}

/**
 * Two checks against two channels of the SAME in-memory result (docs/plans/
 * event-wiring-symmetry.md §7b R2/H4 fix): (1) all expected event names
 * appear in `coverage` (classified dispatch-only); (2) with pragmas applied,
 * `findings` surfaces exactly the actionable set. Loci are NOT compared
 * (Gemini round-3 G3 — positional, fragile, not the precision claim).
 */
function compareOracle(expected, coverage, findings) {
  // audit-code R1/H1 fix: verify the explicit `class` field, not just
  // membership — presence in `coverage[]` happened to imply dispatch-only by
  // construction, but the oracle should check the stated classification, not
  // an unstated producer-side invariant a future edit could silently break.
  const dispatchOnlyNames = new Set(coverage.filter(c => c.class === 'dispatch-only').map(c => c.eventName));
  const expectedNames = expected.events.map(e => e.name);
  const missingFromCoverage = expectedNames.filter(n => !dispatchOnlyNames.has(n));
  if (missingFromCoverage.length) {
    return `expected dispatch-only classification for [${missingFromCoverage.join(', ')}] but coverage has no dispatch-only entry`;
  }

  const findingNames = new Set(findings.map(f => f.eventName));
  const expectedActionable = expected.events.filter(e => e.disposition !== 'FP').map(e => e.name).sort();
  const expectedSuppressed = expected.events.filter(e => e.disposition === 'FP').map(e => e.name);

  const actualActionable = [...findingNames].sort();
  if (JSON.stringify(actualActionable) !== JSON.stringify(expectedActionable)) {
    return `expected findings [${expectedActionable.join(', ')}] but got [${actualActionable.join(', ')}]`;
  }
  const stillSurfaced = expectedSuppressed.filter(n => findingNames.has(n));
  if (stillSurfaced.length) {
    return `expected [${stillSurfaced.join(', ')}] to be pragma-suppressed but they still surfaced as findings`;
  }
  return null;
}

main();
