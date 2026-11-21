#!/usr/bin/env node
/**
 * @fileoverview Gate provenance: judge a PR by the gates of its BASE (the verification-lessons plan, section 2.2).
 *
 * Classifies how the PR changed every registered gate-defining file (.gate-files.json), builds the trusted verdict
 * snapshot (PR tree with the protected set swapped for the base version), runs each registered ratchet gate there (verdict)
 * (and, with the opt-in --shadow, in a clean worktree of the head), and checks the loosening authorization (label `gate-loosening` + an approving review).
 *
 * Usage:
 *   node scripts/gate-provenance.mjs --base <sha> [--head <rev>] [--repo-root <dir>] [--mode observe|enforce] [--json]
 *                                    [--pr <n> --repo <owner/name>] [--no-gate-runs]
 *
 * OBSERVE mode (the default, and the only mode CI runs) prints the report plus a
 * `::notice title=audit-loop-gate-provenance::` line and exits 0 - only an argv error exits 2. ENFORCE exits 1 on a
 * violation and 3 on an unmeasured state, because an unmeasured verdict must not pass. Unmeasured states (no base, a base
 * without the runner, no gh, no dependency install) are printed as `unmeasured`, never as clean.
 *
 * Exit codes: 0 ok / observe | 1 violation (enforce) | 2 usage error | 3 unmeasured (enforce)
 *
 * @module scripts/gate-provenance
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { resolvePushRange, describePushRange } from './lib/push-range.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import { analyze, formatReport, summaryLine, unmeasuredReport } from './lib/gate-provenance/analyze.mjs';
import { escapeData } from './lib/gate-provenance/actions-escape.mjs';

const KNOWN_FLAGS = ['--base', '--head', '--repo-root', '--mode', '--json', '--pr', '--repo', '--no-gate-runs', '--shadow', '--base-install-dir', '--help', '-h', '--selfcheck-relocation'];
const NOTICE = '::notice title=audit-loop-gate-provenance::';

/** `--name value` or `--name=value`; a flag present without a usable value is a usage error. */
function value(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === name) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new ArgvError(`gate-provenance: ${name} requires a value`);
      return v;
    }
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return null;
}

/** Tolerant, never-throwing read of the mode (both `--mode enforce` and `--mode=enforce`), done ONCE so a crash handler shares it. */
let MODE = "observe";
/** What a crash handler needs to still print a faithful JSON report: read tolerantly, before anything can throw. */
const CTX = { json: false, base: null, head: 'HEAD' };
function rawValue(argv, name) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === name) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${name}=`)) return argv[i].slice(name.length + 1);
  }
  return null;
}
function modeOf(argv) {
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--mode") return argv[i + 1] === "enforce" ? "enforce" : "observe";
    if (argv[i].startsWith("--mode=")) return argv[i].slice(7) === "enforce" ? "enforce" : "observe";
  }
  return "observe";
}

function gitRunner(repoRoot) {
  return (args) => {
    try {
      return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: sanitizeGitEnv(repoRoot) }).trim() || null;
    } catch { return null; }
  };
}

async function main() {
  const argv = process.argv;
  MODE = modeOf(argv);
  CTX.json = argv.includes('--json');
  CTX.base = rawValue(argv, '--base');
  CTX.head = rawValue(argv, '--head') ?? 'HEAD';
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }
  let opts;
  try {
    assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'gate-provenance' });
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stderr.write('Usage: node scripts/gate-provenance.mjs --base <sha> [--head <rev>] [--repo-root <dir>] [--mode observe|enforce] [--json] [--pr <n> --repo <owner/name>] [--no-gate-runs] [--shadow]\n');
      await finishAndExit(0);
      return;
    }
    const mode = value(argv, '--mode') ?? 'observe';
    if (mode !== 'observe' && mode !== 'enforce') throw new ArgvError(`gate-provenance: --mode must be observe or enforce, got ${JSON.stringify(mode)}`);
    const base = value(argv, '--base');
    if (!base) throw new ArgvError('gate-provenance: --base <sha> is required');
    opts = {
      mode, base,
      head: value(argv, '--head') ?? 'HEAD',
      repoRoot: path.resolve(value(argv, '--repo-root') ?? process.cwd()),
      pr: value(argv, '--pr') ?? undefined,
      repo: value(argv, '--repo') ?? process.env.GITHUB_REPOSITORY ?? undefined,
      baseInstallDir: value(argv, "--base-install-dir") ?? undefined,
      json: argv.includes('--json'),
      gateRuns: !argv.includes('--no-gate-runs'),
      shadow: argv.includes('--shadow'),
    };
  } catch (err) {
    if (err instanceof ArgvError || /requires a value/.test(String(err?.message))) { process.stderr.write(`${escapeData(err.message)}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (process.env.GATE_PROVENANCE_CRASH_FOR_TEST === "1") throw new Error("injected crash (test seam)");

  const run = gitRunner(opts.repoRoot);
  // One range, one resolver: an explicit base, never inferred, never HEAD~1 or the upstream.
  const range = resolvePushRange({ env: { AUDIT_PUSH_RANGE_BASE: opts.base, AUDIT_PUSH_RANGE_HEAD: opts.head }, requireExplicit: true, run });
  let report;
  if (!range.ok) {
    report = unmeasuredReport({ mode: opts.mode, base: opts.base, head: opts.head, reason: `base not usable: ${range.message}` });
  } else {
    process.stderr.write(`gate-provenance: ${escapeData(describePushRange(range))}\n`);
    const sha = (rev) => run(['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
    const baseSha = sha(range.base);
    const headSha = sha(range.head);
    if (!baseSha || !headSha) {
      report = unmeasuredReport({ mode: opts.mode, base: opts.base, head: opts.head, reason: 'base or head does not resolve to a commit' });
    } else {
      report = analyze({ repoRoot: opts.repoRoot, base: baseSha, head: headSha, mode: opts.mode, gateRuns: opts.gateRuns, shadow: opts.shadow, repo: opts.repo, pr: opts.pr, baseInstallDir: opts.baseInstallDir });
    }
  }

  const notice = `${NOTICE}${summaryLine(report)}`;
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.stderr.write(`${notice}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n${notice}\n`);
  }
  let code = 0;
  if (opts.mode === 'enforce') code = report.state === 'violation' ? 1 : report.state === 'unmeasured' ? 3 : 0;
  await finishAndExit(code);
}

if (isInvokedAsScript(import.meta.url)) {
  main().catch(async (err) => {
    // A crash is an UNMEASURED verdict, said as such; observe mode still exits 0, enforce refuses to pass it.
    const first = String(err?.message ?? err).split('\n')[0];
    process.stderr.write(`gate-provenance: ${escapeData(err?.stack ?? err)}\n`);
    process.stderr.write(`${NOTICE}state=unmeasured | runner crashed: ${escapeData(first)}\n`);
    // Under --json stdout is ONE JSON report even on a crash, built by the one report constructor.
    if (CTX.json) {
      const report = unmeasuredReport({ mode: MODE, base: CTX.base, head: CTX.head, reason: `runner crashed: ${escapeData(first)}` });
      process.stdout.write(`${JSON.stringify(report)}\n`);
    }
    await finishAndExit(MODE === "enforce" ? 3 : 0);
  });
}
