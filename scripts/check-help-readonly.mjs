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
import { REGISTRY } from './lib/cross-skill/registry.mjs';

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
  // Plus EVERY nested `scripts/<subsystem>/*.mjs` (symbol-index/, learning/, ...),
  // derived from the filesystem so a NEW nested CLI is covered the day it lands
  // rather than only if someone remembers to enrol it, and the relocation guard's
  // CLI_SMOKE_SET members under scripts/lib (which ship to consumers as CLIs).
  // Library modules among them are probed too (harmless: nothing runs) but only a
  // file that looks like a CLI owes the static contract — see `looksLikeCli`.
  // Only the ROOT `scripts/lib` and `node_modules` are excluded (below, at the top
  // level); a `scripts/<subsystem>/lib/tool.mjs` is a nested CLI like any other.
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(path.join(d, e.name));
      return e.name.endsWith('.mjs') ? [path.join(d, e.name)] : [];
    });
  const nested = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== 'lib' && e.name !== 'node_modules')
    .flatMap((e) => walk(path.join(dir, e.name)));
  const libSmoke = [...smokeSet].filter((rel) => rel.startsWith('lib/'))
    .map((rel) => path.join(dir, rel)).filter((p) => fs.existsSync(p));
  return [...top, ...nested, ...libSmoke];
}

/**
 * SUBCOMMAND half (2026-11-23). `cross-skill.mjs --help` is answered by its own
 * `main()` before dispatch, so probing the TOP level proved nothing about
 * `cross-skill.mjs ledger mint --help`, which ignored the flag and minted a work
 * item. Every registry command — and every declared positional verb of one — is
 * probed under the same write-blocking preload. Derived from the registry, never
 * hand-listed, so a NEW subcommand is covered the day it lands.
 *
 * @returns {{abs: string, args: string[], label: string}[]}
 */
export function listSubcommandProbes(root = ROOT) {
  const abs = path.join(root, 'scripts', 'cross-skill.mjs');
  return REGISTRY.flatMap((c) => {
    const verbs = c.positionals && typeof c.positionals === 'object' ? (c.positionals.verbs ?? []) : [];
    return [
      { abs, args: [c.name, '--help'], label: `cross-skill.mjs ${c.name}` },
      ...verbs.map((v) => ({ abs, args: [c.name, v, '--help'], label: `cross-skill.mjs ${c.name} ${v}` })),
    ];
  });
}

/**
 * BEHAVIOURAL half for subcommands. Some subcommands do work with NO observable
 * write (`ledger mint` computes and prints a work-item id), so the write-blocking
 * preload alone reads them clean — the hole this gate shipped with. A subcommand's
 * `--help` must therefore also be ANSWERED: exit 0 and a `Usage:` block on stdout,
 * never the command's own result.
 */
const USAGE_ONLY = /^Usage: [^\n]*\r?\n(Flags:\r?\n(  --[^\n]*\r?\n)*)?$/;

export function withHandledFinding(result) {
  // The WHOLE stdout must be the usage block (`Usage:` line, optional `Flags:` list) — a handler that
  // prints a usage line and then its result must not pass.
  // Truncated capture = the rest of stdout is unseen, so it cannot be vouched for.
  if (result.exitCode === 0 && !result.stdoutTruncated && USAGE_ONLY.test(result.stdout ?? '')) return result;
  const detail = `--help not answered with a Usage block (exit ${result.exitCode}): ${String(result.stdout ?? '').slice(0, 80).replace(/\s+/g, ' ')}`;
  return {
    ...result,
    kinds: [...result.kinds, 'help-not-handled'].sort(),
    violations: [...result.violations, { kind: 'help-not-handled', detail }],
  };
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
export function looksLikeCli(text) {
  return /^#!\/usr\/bin\/env node|isInvokedAsScript\(|process\.argv/m.test(text);
}

/** Source with block and line comments removed, so a docstring cannot satisfy the contract. */
export function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/**
 * The code (not the comments) must handle `--help` or refuse unknown flags. A
 * token anywhere in code still can't prove it runs BEFORE a side effect — the
 * dynamic probe is what tests reachability; this is the necessary backstop.
 */
export function hasHelpContract(text) {
  const code = stripComments(text);
  return /--help|help-guard-run|['"]-h['"]|assertKnownFlags\s*\(|parseArgs\s*\(|new ArgvError\s*\(|unknown (?:flag|option)/i.test(code);
}

/** Add the static `no-help-contract` finding to a probe result. */
export function withStaticFinding(result, root = ROOT) {
  const text = fs.readFileSync(path.join(root, 'scripts', result.file), 'utf-8');
  if (!looksLikeCli(text) || hasHelpContract(text)) return result;
  return {
    ...result,
    kinds: [...result.kinds, 'no-help-contract'].sort(),
    violations: [...result.violations, { kind: 'no-help-contract', detail: 'neither handles --help nor refuses unknown flags' }],
  };
}

/** @param {{file:string, kinds:string[]}[]} results */
export function offenderIds(results) {
  // `hang` IS gated: a CLI that has not exited has not been shown read-only, and
  // a green result over it would read incomplete coverage as success. The timeout
  // is generous (HELP_TIMEOUT_MS) so a loaded machine does not flip the verdict.
  return results.flatMap((r) => r.kinds.map((k) => `${r.file}::${k}`)).sort();
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
  let probes = [
    ...listEntryPoints(ROOT, _internals.CLI_SMOKE_SET).map((f) => ({ abs: f, args: ['--help'], label: labelOf(f), top: true })),
    ...listSubcommandProbes(ROOT),
  ];
  if (onlyIdx !== -1) {
    // A filter that matches nothing must not read as a pass over zero CLIs, and a
    // missing value must not silently fall back to the full census.
    if (!only || only.startsWith('--')) { process.stderr.write('check-help-readonly: --only requires a scripts-relative path\n'); return finishAndExit(2); }
    // `--only cross-skill.mjs` selects the script AND its subcommand probes (labels `cross-skill.mjs <cmd> [verb]`).
    probes = probes.filter((p) => p.label === only || p.label.startsWith(`${only} `));
    if (probes.length === 0) { process.stderr.write(`check-help-readonly: --only ${only} matches no CLI in the census\n`); return finishAndExit(2); }
  }
  const files = probes;

  const results = (await mapPool(probes, CONCURRENCY, (p) => probeHelp(p.abs, { cwd: ROOT, label: p.label, args: p.args, captureStdout: !p.top })))
    // The static no-help-contract half reads a CLI's source: top-level entry points only.
    .map((r, i) => (probes[i].top ? withStaticFinding(r) : withHandledFinding(r)));
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
