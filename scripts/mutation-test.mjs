#!/usr/bin/env node
/**
 * @fileoverview Mutation-testing runner — the mechanised form of "a check is
 * not trustworthy until it has been seen to fail".
 *
 * ## Why a registry instead of "mutate everything"
 *
 * Stryker re-runs the covering tests once per mutant. This repo's suite is
 * ~10,500 tests / ~90s, so mutating the whole tree would take days and nobody
 * would run it — a gate nobody runs is worse than no gate, because it reads as
 * coverage. So each entry below pairs ONE source module with the ONE test file
 * that covers it, and each run is seconds-to-minutes.
 *
 * The registry is the actual deliverable. It is a declaration of which seams
 * are mutation-guarded, and its absence is a statement too: a module not listed
 * here has NOT had its tests proven to detect defects, only to pass.
 *
 * ## What a surviving mutant means
 *
 * Stryker changed the source (flipped a comparison, dropped a call, emptied a
 * block) and the tests still passed. That is a test-suite defect, not a style
 * nit: the covered behaviour is asserted loosely enough that a real regression
 * could land green. Read the survivor, then either tighten the assertion or
 * record why the mutant is equivalent (a mutation with no observable effect).
 *
 * ## Deliberately NOT in `npm run check`
 *
 * The pre-push gate must stay fast, and mutation scores drift with unrelated
 * refactors. This is an on-demand instrument (and a good CI-nightly candidate),
 * not a push blocker. Blocking a push on a slow, noisy signal is the
 * cried-wolf shape that earns `--no-verify`.
 *
 * Usage:
 *   node scripts/mutation-test.mjs --list
 *   node scripts/mutation-test.mjs --target shell-quote
 *   node scripts/mutation-test.mjs --all
 *
 * @module scripts/mutation-test
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { retrySync } from './lib/retry-transient-fs.mjs';
import { assertKnownFlags } from './lib/cli-io.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Mutation-guarded seams.
 *
 * ## `floor` is a RATCHET, not an aspiration — and that distinction is the
 * whole design
 *
 * The first census (2026-08-09) measured: shell-quote 100%, candidate-pagination
 * 83.2%, quickfix-policy 67.9%, sensitive-paths 67.5%, file-lock 31.7%. Three
 * of five sat below any threshold worth wanting.
 *
 * There were three ways to respond and only one is honest:
 *
 *  - Set `floor` to the number we WISH for -> the gate is red on day one,
 *    permanently, and gets ignored. That is the cried-wolf shape.
 *  - Set `floor` to the number we WANT and write tests until it is met -> good,
 *    but it blocks this work behind a multi-day test-writing project.
 *  - Set `floor` to what is MEASURED today and fail only on a DROP. The gate is
 *    meaningful immediately (it catches a test being weakened), and `goal`
 *    records the target so the floor is visibly a waypoint, not an endorsement.
 *
 * The third is what this repo already does for knip, docs-refs and cli-flags
 * ("N in the accepted baseline, 0 net-new"). Same reasoning, same shape.
 *
 * `floor` MUST only ever be raised. Lowering it to make a run pass converts a
 * regression into a new normal, which is the one move this instrument exists to
 * prevent.
 *
 * ## `floor` is the measured score FLOORED to an integer — a deliberate ~1pt
 * deadband, not an exact ratchet
 *
 * Stated because the difference is easy to overclaim. 83.17 is recorded as 83,
 * so a drop to 83.0 does NOT fail. That tolerance is intentional: mutation
 * scores are not perfectly reproducible — a mutant that TIMES OUT counts as
 * killed, and `file-lock` produced 3 timeouts on its census run, so an exact
 * floor would make the gate flap on machine load rather than on code quality. A
 * flapping gate gets ignored, which costs more than the fraction of a point it
 * buys.
 *
 * What the deadband does NOT hide: a real weakening removes whole mutants, and
 * every seam here has few enough that one lost kill moves the score by more
 * than a point (shell-quote 27 mutants ≈ 3.7pt each; quickfix-policy 56 ≈
 * 1.8pt). So the granularity of the signal is coarser than the granularity of
 * the deadband — which is the condition that makes the tolerance safe.
 *
 * `goal` is per-target on purpose: a pure string/predicate module should score
 * near-perfectly, while one whose branches need a genuinely abandoned lock or a
 * filesystem fault cannot. One global number would be too lax for the former
 * and would buy fake tests for the latter.
 */
const TARGETS = [
  {
    name: 'shell-quote',
    mutate: ['scripts/lib/shell-quote.mjs'],
    tests: ['tests/shell-quote.test.mjs'],
    floor: 100, goal: 100,
    why: 'Pure string transform on an injection boundary. A surviving mutant here means a '
       + 'metacharacter class is unasserted, which is exactly how the original bug (escaping '
       + 'only `"`) passed review.',
  },
  {
    name: 'sensitive-paths',
    mutate: ['scripts/lib/sensitive-paths.mjs'],
    tests: ['tests/sensitive-paths.test.mjs'],
    floor: 67, goal: 85,
    why: 'Tier-3 non-negotiable seam (AGENTS.md): a miss here ships credentials to a third-party '
       + 'LLM. Fail-closed classification is precisely the shape a loose assertion hides — '
       + '"returns sensitive" passes whether or not the reason was right.',
  },
  {
    name: 'candidate-pagination',
    mutate: ['scripts/lib/store/candidate-pagination.mjs'],
    tests: ['tests/plans-ship-consistency-candidates.test.mjs'],
    floor: 83, goal: 90,
    why: 'Keyset cursor + batch bounds. Off-by-one and comparison-direction mutants are the '
       + 'literal defect class this module was written to remove (a page that repeats or skips).',
  },
  {
    name: 'quickfix-policy',
    mutate: ['scripts/lib/quickfix-policy.mjs'],
    tests: ['tests/quickfix-policy.test.mjs'],
    floor: 67, goal: 90,
    why: 'Threshold parsing that already shipped one silent-acceptance bug ("0.2junk" reading '
       + 'as 0.2). Boundary mutants are the whole point.',
  },
  {
    name: 'file-lock',
    mutate: ['scripts/lib/file-lock.mjs'],
    tests: ['tests/file-lock.test.mjs'],
    floor: 31, goal: 70,
    why: 'The module whose durability property could NOT be proven by racing it (see '
       + 'tests/quarantine-lock-containment.test.mjs for why). Mutation is the instrument that '
       + 'reaches what a race could not: it flips the stale-age comparison, the pid-liveness '
       + 'check and the TOCTOU abort conditions one at a time and asks whether any test notices. '
       + 'Threshold is lower than the pure modules because several branches need a genuinely '
       + 'abandoned lock or a filesystem fault to reach, and inflating it would buy fake tests.',
  },
  {
    name: 'ledger',
    mutate: ['scripts/lib/ledger.mjs'],
    tests: ['tests/ledger.test.mjs'],
    floor: 19, goal: 70,
    why: 'R2+ suppression — it decides whether a finding is SUPPRESSED or REOPENED, so a loose '
       + 'assertion here is silent loss INSIDE the audit loop. Added 2026-08-10 once the module '
       + 'got its first dedicated suite (debt bb15049a); that suite immediately found the '
       + 'hard-suppress counter dead, because the two sides of its category key were normalised '
       + 'differently. Exactly what a mutation seam exists to keep catching.',
  },
];

// The `ledger` entry above closed the last Tier-1 gap. When a module named in
// docs/reference/testing-doctrine.md is missing from this registry, say so
// HERE — an absence nobody wrote down is indistinguishable from an oversight,
// which is the whole reason the previous note about ledger.mjs existed.

function usage() {
  return [
    'mutation-test — run Stryker against a declared seam',
    '',
    'Usage:',
    '  node scripts/mutation-test.mjs --list',
    '  node scripts/mutation-test.mjs --target <name>',
    '  node scripts/mutation-test.mjs --all',
    '',
    'Flags:',
    '  --list            Print the registry and exit',
    '  --target <name>   Run one seam',
    '  --all             Run every seam in sequence',
    '  --dry-run         Print the Stryker invocation without running it',
    '',
    'Exit: 0 every target held its floor · 1 a score fell BELOW its floor (a regression) · 2 bad input',
  ].join('\n');
}

const KNOWN_FLAGS = ['--list', '--target', '--all', '--dry-run', '--help',
  '--selfcheck-relocation'];

/**
 * Reuses the shared `assertKnownFlags` rather than carrying a local copy. The
 * duplication wave caught the private version at 0.87 similarity, and the
 * shared one is strictly better: it also handles `--flag=value` and the POSIX
 * `--` terminator, neither of which the copy did. Only the failure MODE differs
 * (it throws `ArgvError`; this CLI exits 2), which is a wrapper, not a fork.
 */
function checkFlags(argv) {
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'mutation-test', from: 0 });
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(2);
  }
}

/** Build the Stryker config for ONE target, written to a temp file. */
function writeConfig(target) {
  const cfg = {
    $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    packageManager: 'npm',
    reporters: ['clear-text', 'progress'],
    testRunner: 'command',
    // The command runner is deliberate: this repo uses node's BUILT-IN test
    // runner, which has no dedicated Stryker plugin. `command` treats any
    // non-zero exit as "mutant killed", which is exactly the contract
    // `node --test` already provides.
    commandRunner: { command: `node --test ${target.tests.join(' ')}` },
    coverageAnalysis: 'off',
    mutate: target.mutate,
    // Timeouts: a mutant can create an infinite loop, and the default factor is
    // tuned for fast unit suites. These are generous because a false "timeout"
    // reads as "killed" and inflates the score.
    timeoutMS: 60_000,
    timeoutFactor: 3,
    // `break` is the RATCHET floor, not the goal — Stryker exits non-zero only
    // when the score drops below what this seam already achieves. `goal` is
    // carried in the registry for humans and is deliberately NOT enforced here:
    // enforcing an unmet aspiration makes the gate red on day one.
    thresholds: { high: target.goal, low: target.floor, break: target.floor },
    tempDirName: '.stryker-tmp',
    cleanTempDir: true,
  };
  const p = path.join(REPO_ROOT, `.stryker-${target.name}.conf.json`);
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

/**
 * Validate one registry entry's file references. PURE — `exists` is injected so
 * the guard can be driven both ways without touching the filesystem.
 *
 * Extracted because it is a guard, and a guard nobody has watched FAIL is
 * indistinguishable from one that always passes. A registry entry pointing at a
 * moved or renamed file would otherwise run Stryker over nothing and report a
 * perfect score — the exact vacuous pass this whole instrument exists to catch,
 * reproduced inside the instrument.
 *
 * @param {{name:string, mutate:string[], tests:string[]}} target
 * @param {(relPath: string) => boolean} exists
 * @returns {{ok:true} | {ok:false, missing:string[]}}
 */
export function validateTargetFiles(target, exists) {
  // An EMPTY list is the purest form of the failure this guard exists to catch:
  // Stryker with nothing to mutate reports 100%, and a test command with no
  // files "passes". Both are vacuous, and neither trips a
  // does-this-path-exist check — so emptiness is rejected first, before
  // existence is even consulted.
  const empty = [];
  if (!Array.isArray(target.mutate) || target.mutate.length === 0) empty.push('mutate');
  if (!Array.isArray(target.tests) || target.tests.length === 0) empty.push('tests');
  if (empty.length) return { ok: false, missing: [], empty };

  const missing = [...target.mutate, ...target.tests].filter(f => !exists(f));
  return missing.length ? { ok: false, missing, empty: [] } : { ok: true };
}

/** The declared seams, exported so a test can assert the registry has not rotted. */
export { TARGETS };

function runTarget(target, { dryRun }) {
  const validation = validateTargetFiles(
    target, f => fs.existsSync(path.join(REPO_ROOT, f)),
  );
  if (!validation.ok) {
    process.stderr.write(
      `mutation-test: target "${target.name}" references missing file(s): ${validation.missing.join(', ')}\n`
      + '  A registry entry that points at nothing scores 100% having tested nothing. Fix the entry.\n',
    );
    return { name: target.name, ok: false, reason: 'missing-files' };
  }

  const configPath = writeConfig(target);
  const args = ['stryker', 'run', configPath];
  if (dryRun) {
    process.stdout.write(`[dry-run] npx ${args.join(' ')}\n`);
    process.stdout.write(`          test command: node --test ${target.tests.join(' ')}\n`);
    retrySync(() => fs.rmSync(configPath, { force: true }));
    return { name: target.name, ok: true, reason: 'dry-run' };
  }

  process.stdout.write(`\n── mutation: ${target.name} (floor ${target.floor}%, goal ${target.goal}%) ──\n`);
  const res = spawnSync('npx', args, { cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  retrySync(() => fs.rmSync(configPath, { force: true }));
  return { name: target.name, ok: res.status === 0, reason: res.status === 0 ? 'met' : 'below-threshold' };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  checkFlags(argv);
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage() + '\n'); return; }

  if (argv.includes('--list') || argv.length === 0) {
    process.stdout.write('Mutation-guarded seams:\n\n');
    for (const t of TARGETS) {
      const gap = t.floor < t.goal ? `  ← ${t.goal - t.floor} points below goal` : '  (at goal)';
      process.stdout.write(`  ${t.name}  floor ${t.floor}% → goal ${t.goal}%${gap}\n`);
      process.stdout.write(`    mutate: ${t.mutate.join(', ')}\n`);
      process.stdout.write(`    tests:  ${t.tests.join(', ')}\n`);
      process.stdout.write(`    why:    ${t.why}\n\n`);
    }
    process.stdout.write(
      'A module NOT listed here has not had its tests proven to detect defects —\n'
      + 'only to pass. Absence is a statement, not an oversight.\n',
    );
    return;
  }

  const dryRun = argv.includes('--dry-run');
  let selected;
  if (argv.includes('--all')) {
    selected = TARGETS;
  } else {
    // Accept BOTH --target name and --target=name: the shared flag validator
    // permits the '=' form, so parsing only the space form would let a valid
    // invocation through the gate and then fail with 'unknown target null'.
    const eq = argv.find(a => a.startsWith('--target='));
    const i = argv.indexOf('--target');
    const name = eq ? eq.slice('--target='.length) : (i >= 0 ? argv[i + 1] : null);
    selected = TARGETS.filter(t => t.name === name);
    if (!selected.length) {
      process.stderr.write(`mutation-test: unknown target "${name}". Known: ${TARGETS.map(t => t.name).join(', ')}\n`);
      process.exit(2);
    }
  }

  const results = selected.map(t => runTarget(t, { dryRun }));
  const failed = results.filter(r => !r.ok);
  process.stdout.write('\n── mutation summary ──\n');
  for (const r of results) process.stdout.write(`  ${r.ok ? 'ok  ' : 'FAIL'} ${r.name} (${r.reason})\n`);
  process.exit(failed.length ? 1 : 0);
}

// Only run as a CLI. Importing this module for its registry or its pure guard
// must not spawn Stryker — the test below does exactly that.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
