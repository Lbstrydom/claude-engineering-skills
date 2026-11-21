#!/usr/bin/env node
/**
 * @fileoverview `help:readonly:gate` — `--help` on every top-level CLI must be a
 * pure read: no filesystem write, no network, no mutating child process.
 *
 * **Why (2026-11-21).** `arch-intent-bootstrap.mjs` had no `--help`, so
 * `--help` RAN the bootstrap. It is the same hole as `symbol-index/refresh.mjs`
 * dropping `--dry-run` (see `assertKnownFlags`): an unrecognised flag is
 * silently ignored and the CLI does its real work. The static question "does
 * the file mention `--help`?" cannot answer this, so every `scripts/*.mjs` is
 * RUN with `--help` under an instrumented preload
 * (`lib/help-probe/preload.mjs`) that records and blocks writes, network and
 * non-read-only spawns, so the census itself cannot hurt anything.
 *
 * **Absolute, not baselined.** A baseline would hold KNOWN side effects on
 * `--help` — a paid provider call, a created worktree — which is the exact bug.
 * The census found 54 and every one was fixed (`lib/help-guard-run.mjs` as each
 * CLI's first import), so the only acceptable offender count is zero. An
 * offender is a fix, never a re-baseline.
 *
 * Usage:
 *   node scripts/check-help-readonly.mjs            # gate: any offender fails
 *   node scripts/check-help-readonly.mjs --report   # full census, exit 0
 *   node scripts/check-help-readonly.mjs --only <scripts-relative-path>
 *   node scripts/check-help-readonly.mjs --json
 *
 * Exit codes: 0 no offender (or --report) · 1 offender · 2 usage error.
 *
 * @module scripts/check-help-readonly
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { probeHelp, mapPool } from './lib/help-probe/probe.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const KNOWN_FLAGS = ['--json', '--report', '--only'];
const CONCURRENCY = 6;

/**
 * Files that are not CLIs: nothing runs when they are executed, so `--help` is
 * vacuously read-only. Each entry needs a reason; an unexplained exemption is a hole.
 */
export const NOT_A_CLI = Object.freeze({
  'shared.mjs': 'barrel of re-exports — no main, executing it runs nothing',
});

/** Every top-level `scripts/*.mjs`, derived from the filesystem (never a list). */
export function listEntryPoints(root = ROOT, smokeSet = []) {
  const dir = path.join(root, 'scripts');
  const top = fs.readdirSync(dir)
    .filter((n) => n.endsWith('.mjs') && !(n in NOT_A_CLI))
    .sort()
    .map((n) => path.join(dir, n));
  // Plus the relocation guard's CLI_SMOKE_SET members that live in a subdirectory
  // (symbol-index/drift.mjs, ...): they ship to consumers as CLIs too.
  const nested = [...smokeSet].filter((rel) => rel.includes('/')).sort()
    .map((rel) => path.join(dir, rel)).filter((p) => fs.existsSync(p));
  return [...top, ...nested];
}

/** Path of an entry point relative to `scripts/`, with `/` separators — its stable identity. */
export const labelOf = (abs, root = ROOT) => path.relative(path.join(root, 'scripts'), abs).split(path.sep).join('/');

/**
 * STATIC half. The dynamic probe only sees side effects reachable from the repo
 * state it runs in — `arch-intent-bootstrap.mjs` wrote only when
 * `docs/architecture-intent.md` was ABSENT, so a probe in this tree read it clean.
 * So the invariant itself is also asserted from source: a CLI must either handle
 * `--help` or refuse unknown flags (both make `--help` read-only), or it has no
 * contract and `--help` runs the tool.
 *
 * @param {string} text CLI source
 * @returns {boolean}
 */
export function hasHelpContract(text) {
  return /--help|help-guard-run|['"]-h['"]|assertKnownFlags|parseArgs\s*\(|ArgvError|unknown (?:flag|option)/i.test(text);
}

/** Add the static `no-help-contract` finding to a probe result. */
export function withStaticFinding(result, root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'scripts', result.file), 'utf-8');
  if (hasHelpContract(text)) return result;
  return {
    ...result,
    kinds: [...result.kinds, 'no-help-contract'].sort(),
    violations: [...result.violations, { kind: 'no-help-contract', detail: 'neither handles --help nor refuses unknown flags' }],
  };
}

/** @param {{file:string, kinds:string[]}[]} results */
export function offenderIds(results) {
  // `hang` is load-dependent (a loaded machine can push a slow CLI past the
  // timeout), so it is REPORTED but never part of the gated identity set — a
  // gate whose verdict flips on machine load is the flaky-gate shape.
  return results.flatMap((r) => r.kinds.filter((k) => k !== 'hang').map((k) => `${r.file}::${k}`)).sort();
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-help-readonly' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); return finishAndExit(2); }
    throw err;
  }
  const json = process.argv.includes('--json');
  const onlyIdx = process.argv.indexOf('--only');
  const only = onlyIdx !== -1 ? process.argv[onlyIdx + 1] : null;
  const { _internals } = await import('./lib/sync-isolation-verify.mjs');
  let files = listEntryPoints(ROOT, _internals.CLI_SMOKE_SET);
  if (only) files = files.filter((f) => labelOf(f) === only);

  const results = (await mapPool(files, CONCURRENCY, (f) => probeHelp(f, { cwd: ROOT, label: labelOf(f) })))
    .map((r) => withStaticFinding(r));
  const ids = offenderIds(results);

  if (process.argv.includes('--report')) {
    for (const r of results.filter((x) => x.kinds.length)) {
      process.stdout.write(`${r.file}: ${r.kinds.join(',')}  e.g. ${r.violations[0].detail}\n`);
    }
    process.stdout.write(`${ids.length} offender id(s) across ${files.length} CLI(s)\n`);
    return finishAndExit(0);
  }

  const ok = ids.length === 0;
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok, probed: files.length, offenders: ids })}\n`);
    return finishAndExit(ok ? 0 : 1);
  }
  if (!ok) {
    process.stderr.write(`help-readonly/offender: --help is not read-only for:\n  ${ids.join('\n  ')}\n`
      + "Fix the CLI, never a baseline: make `import './lib/help-guard-run.mjs'` its FIRST import "
      + '(see lib/help-guard.mjs), or handle --help before any side effect.\n');
  }
  process.stdout.write(`help-readonly: ${files.length} CLI(s) probed, ${ids.length} offender(s) — ${ok ? 'OK' : 'FAIL'}\n`);
  return finishAndExit(ok ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch((err) => { process.stderr.write(`check-help-readonly failed: ${err.message}\n`); process.exit(1); });
}
