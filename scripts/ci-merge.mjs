#!/usr/bin/env node
/**
 * @fileoverview `ci-merge` — wait for CI on the exact pushed head of one or more PRs, report a verdict per check, and
 * (only with `--merge`) squash-merge safely. Logic: `lib/ci-merge.mjs`. Synced to consumers.
 *
 * Usage:
 *   node scripts/ci-merge.mjs --pr 123 --wait-only                 # report mode: wait for EVERY check, verdict per check, change nothing
 *   node scripts/ci-merge.mjs --pr 123 --merge                     # wait, then merge if safe (the caller's explicit merge decision)
 *   node scripts/ci-merge.mjs --pr 123,124 --merge                 # serial queue: one PR at a time, stops at the first that does not merge
 *   node scripts/ci-merge.mjs --pr current --wait-only             # the current branch's PR
 *
 * Flags:
 *   --pr <n[,n...]|current>     PR number(s); required
 *   --repo <owner/name>         pass to gh (default: gh resolves it from the checkout; origin is never assumed)
 *   --gh-account <name>         run gh as that signed-in account (second-account repos); GH_TOKEN in the environment also works
 *   --wait-only                 report only; never update a branch or merge
 *   --merge                     the explicit merge decision; without it nothing is ever merged
 *   --allow-fail <a,b>          check NAMES whose failure is tolerated (repeatable). UNSTABLE is refused unless every failure is listed
 *   --expect <a,b>              check NAMES that must appear in the rollup before a verdict (guards the "check not registered yet" race)
 *   --fail-fast                 stop at the first disallowed failure instead of waiting for the other checks
 *   --follow-head               with --merge: follow a head somebody else pushed (default: refuse, the decision covered the old head)
 *   --deploy-wait <check-name>  after merging, wait for that check run on the merge commit
 *   --timeout-min <n>           per-PR wait budget (default 45); --poll-sec <n> (default 20); --deploy-timeout-min <n> (default 20)
 *   --blocked-grace-sec <n>     how long to poll BLOCKED/UNKNOWN once every check is done (default 90)
 *   --no-checks-grace-sec <n>   how long to wait for the first check to register (default 120)
 *
 * stdout is ONE JSON envelope: {ok, mode, results[], report}. `report` is the text to paste into a done report.
 * Progress goes to stderr. Exit codes: 0 green/merged, 1 a check failed or the merge was refused, 2 bad input,
 * 3 timed out (the envelope names what is still pending).
 *
 * @module scripts/ci-merge
 */
import { spawnSync } from 'node:child_process';
import { ArgvError, assertKnownFlags, emit, finishAndExit } from './lib/cli-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { ghEnvFor } from './lib/fleet/gh-account.mjs';
import { DEFAULTS, exitCodeFor, parseNameList, renderReport, runQueue } from './lib/ci-merge.mjs';

const VALUE_FLAGS = ['--pr', '--repo', '--gh-account', '--allow-fail', '--expect', '--deploy-wait', '--timeout-min', '--poll-sec',
  '--deploy-timeout-min', '--blocked-grace-sec', '--no-checks-grace-sec', '--gh-bin'];
const BOOL_FLAGS = ['--wait-only', '--merge', '--fail-fast', '--follow-head', '--selfcheck-relocation'];
const KNOWN = [...VALUE_FLAGS, ...BOOL_FLAGS];

/** Parse argv (after node + script) into `{values: Map<flag, string[]>, bools: Set}`. */
export function parseArgv(argv) {
  const values = new Map(); const bools = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new ArgvError(`ci-merge: unexpected argument "${a}"`);
    const eq = a.indexOf('=');
    const name = eq === -1 ? a : a.slice(0, eq);
    if (BOOL_FLAGS.includes(name)) { bools.add(name); continue; }
    const val = eq === -1 ? argv[++i] : a.slice(eq + 1);
    if (val === undefined || val.startsWith('--')) throw new ArgvError(`ci-merge: ${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), val]);
  }
  return { values, bools };
}

function num(values, flag, dflt, { unit = 1 } = {}) {
  const v = values.get(flag)?.at(-1);
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new ArgvError(`ci-merge: ${flag} must be a positive number, got "${v}"`);
  return n * unit;
}

/** Build run options from parsed argv; throws ArgvError on any contradiction. */
export function buildOptions({ values, bools }) {
  const prs = (values.get('--pr') ?? []).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean);
  if (!prs.length) throw new ArgvError('ci-merge: --pr <n[,n...]|current> is required');
  for (const p of prs) if (p !== 'current' && !/^\d+$/.test(p)) throw new ArgvError(`ci-merge: "${p}" is not a PR number`);
  if (prs.includes('current') && prs.length > 1) throw new ArgvError('ci-merge: "current" cannot be combined with other PRs');
  if (bools.has('--merge') && bools.has('--wait-only')) throw new ArgvError('ci-merge: --merge and --wait-only are mutually exclusive');
  if (!bools.has('--merge') && !bools.has('--wait-only')) throw new ArgvError('ci-merge: say what you want — --wait-only (report) or --merge (the explicit merge decision)');
  if (bools.has('--wait-only') && (bools.has('--follow-head') || values.has('--deploy-wait'))) throw new ArgvError('ci-merge: --follow-head and --deploy-wait apply only with --merge');
  return {
    prs,
    repo: values.get('--repo')?.at(-1) ?? null,
    ghAccount: values.get('--gh-account')?.at(-1) ?? null,
    ghBin: values.get('--gh-bin')?.at(-1) ?? 'gh',
    opts: {
      merge: bools.has('--merge'),
      allowFail: parseNameList(values.get('--allow-fail')),
      expect: parseNameList(values.get('--expect')),
      failFast: bools.has('--fail-fast'),
      followHead: bools.has('--follow-head'),
      deployWait: values.get('--deploy-wait')?.at(-1) ?? null,
      timeoutMs: num(values, '--timeout-min', DEFAULTS.timeoutMs, { unit: 60_000 }),
      pollMs: num(values, '--poll-sec', DEFAULTS.pollMs, { unit: 1000 }),
      deployTimeoutMs: num(values, '--deploy-timeout-min', DEFAULTS.deployTimeoutMs, { unit: 60_000 }),
      blockedGraceMs: num(values, '--blocked-grace-sec', DEFAULTS.blockedGraceMs, { unit: 1000 }),
      noChecksGraceMs: num(values, '--no-checks-grace-sec', DEFAULTS.noChecksGraceMs, { unit: 1000 }),
    },
  };
}

/** The real `gh`: never prompts, never coloured, in the declared account's environment when one is given. */
export function makeGh({ ghBin, env }) {
  return (args) => {
    const r = spawnSync(ghBin, args, { encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: { ...env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  if (argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(['', '', ...argv], KNOWN, { cli: 'ci-merge' });
  const parsed = buildOptions(parseArgv(argv));
  const { env, error: accountError } = ghEnvFor(parsed.ghAccount ? { ghAccount: parsed.ghAccount } : null, deps.env ?? process.env, deps.spawn ? { spawn: deps.spawn } : {});
  if (accountError) throw new ArgvError(`ci-merge: --gh-account ${parsed.ghAccount}: ${accountError}`);
  const d = {
    gh: deps.gh ?? makeGh({ ghBin: parsed.ghBin, env }),
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    log: deps.log ?? ((m) => process.stderr.write(`ci-merge: ${m}\n`)),
  };
  const results = await runQueue(parsed.prs, { ...parsed.opts, repo: parsed.repo }, d);
  const code = exitCodeFor(results);
  const report = renderReport(results);
  d.log(`\n${report}`);
  // 3 (timeout) must survive emit's `exitCode ||= 1`, so it is set first.
  if (code) process.exitCode = code;
  (deps.emit ?? emit)({ ok: code === 0, mode: parsed.opts.merge ? 'merge' : 'wait-only', exitCode: code, results, report });
  return code;
}

if (isInvokedAsScript(import.meta.url)) {
  let code;
  try {
    code = await main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    code = err instanceof ArgvError || err?.code === 'ARGV_ERROR' ? 2 : 1;
  }
  await finishAndExit(code);
}
