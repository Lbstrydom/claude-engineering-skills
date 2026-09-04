#!/usr/bin/env node
/**
 * @fileoverview `stdout:flush:gate` — a `process.exit()` that a stdout write can
 * reach must go through `finishAndExit`, which drains first.
 *
 * **Why this exists (2026-09-04).** `cli-io.mjs`'s `finishAndExit` docstring
 * names the failure as observed, not theoretical: on Windows `process.stdout` to
 * a PIPE is asynchronous — and `npm run x`, `x | tee`, and a CI capture are all
 * pipes — so `process.exit()` discards whatever has not flushed. The tail of a
 * report vanishes with no error anywhere.
 *
 * A detector-first census that day found the class was never confined to the one
 * file that prompted it. Repo-wide, **190 reachable sites across ~100 files**,
 * of which 95 carried a JSON envelope a caller parses. Those are the bad half:
 * a truncated envelope is a `SyntaxError` attributed to whatever the caller
 * happened to be doing, or — when the cut lands on a complete-looking prefix —
 * a silently short result nobody ever sees as an error. `symbol-index/refresh.mjs`
 * was emitting exactly that for its `cloud-disabled` and `unsupported-stack`
 * envelopes.
 *
 * **Drift-only, baselined, in knip-gate's shape.** 183 sites remained after the
 * `scripts/symbol-index/` family was fixed. A check that fails on 183 existing
 * files is a wall, not a ratchet, and a cried-wolf gate gets `--no-verify`'d —
 * the lesson `check-cli-flags.mjs` records from its own 24→82 baseline. Only a
 * NET-NEW site fails the run. A SHRINK fails too, asking you to re-baseline,
 * because a baseline pinned at the historical high-water mark lets the count
 * grow back unchallenged (`size:ratchet`'s rule, AGENTS.md).
 *
 * **Identity sets, not counts.** Fix one site and add another elsewhere and the
 * total never moves, so a count-only comparison reports neither growth nor
 * shrinkage — the "swap" blind spot `check-emit-exit-agreement.mjs` documents.
 * Identity is `file::writeHow->exit(code)#ordinal`, deliberately WITHOUT the
 * line number: a line-keyed baseline churns on every edit above a site, and a
 * baseline that churns for unrelated reasons is one people re-run `--update` on
 * reflexively, which is how a real drift gets waved through.
 *
 * **Two things this gate must never flag** (both enforced in the detector, not
 * here, so a consumer forking the module keeps them):
 *   1. `process.stderr.write(...)` before an exit. stderr is synchronous enough
 *      for the skip messages every symbol-index CLI has, and folding the two
 *      channels together would bury the real class in noise.
 *   2. The `--selfcheck-relocation` smoke contract's
 *      `console.log('OK'); process.exit(0);`. That literal shape is the
 *      documented contract (AGENTS.md §"CLI smoke contract") and is asserted
 *      across `CLI_SMOKE_SET`; rewriting it per-file would break the contract in
 *      exactly the files it exists to standardise. If it should change, the
 *      contract and every implementation change together.
 *
 * Usage:
 *   node scripts/check-stdout-flush.mjs              # drift gate (pre-push)
 *   node scripts/check-stdout-flush.mjs --json
 *   node scripts/check-stdout-flush.mjs --report     # full census, triaged
 *   node scripts/check-stdout-flush.mjs --update     # re-baseline deliberately
 *
 * Exit codes: 0 — at baseline (or `--report`) · 1 — drift, or a scan failure ·
 * 2 — argv error.
 *
 * @module scripts/check-stdout-flush
 */

import fs from 'node:fs';
import path from 'node:path';
import { findStdoutExitSites } from './lib/find-stdout-exit-sites.mjs';
import { emit, hasFlag, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const KNOWN_FLAGS = ['--json', '--report', '--update', '--selfcheck-relocation'];
const BASELINE_PATH = '.stdout-flush-baseline.json';
const SCAN_DIR = 'scripts';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Every `.mjs`/`.js` under `dir`, sorted, `node_modules` skipped.
 * @param {string} dir absolute
 * @returns {string[]} absolute paths
 */
function listSources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules') continue;
      listSources(p, out);
    } else if (e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.js'))) {
      out.push(p);
    }
  }
  return out.sort();
}

/**
 * Line-independent identity for one site. The ordinal disambiguates two sites in
 * one file that share a shape; it is stable under edits ABOVE them, which a line
 * number is not.
 */
function siteId(site, seen) {
  const base = `${site.file}::${site.writeHow}->exit(${site.exitCode})`;
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return `${base}#${n}`;
}

/**
 * Scan the tree.
 *
 * A parse failure is a **scan failure**, not a file with zero sites. The whole
 * point of this detector is a silent-truncation class; a scanner that treats an
 * unreadable file as clean reproduces that failure one level up.
 *
 * @param {string} repoRoot
 * @returns {{sites: object[], byFile: Record<string, number>, ids: string[], errors: string[]}}
 */
export function scanTree(repoRoot) {
  const cliIoAbsPath = path.join(repoRoot, 'scripts', 'lib', 'cli-io.mjs');
  const sites = [];
  const errors = [];
  for (const abs of listSources(path.join(repoRoot, SCAN_DIR))) {
    const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
    let found;
    try {
      found = findStdoutExitSites(fs.readFileSync(abs, 'utf8'), { fromFileAbsPath: abs, cliIoAbsPath });
    } catch (err) {
      errors.push(`${rel}: ${err.message}`);
      continue;
    }
    for (const s of found) sites.push({ file: rel, ...s });
  }
  const byFile = {};
  for (const s of sites) byFile[s.file] = (byFile[s.file] || 0) + 1;
  const seen = new Map();
  const ids = sites.map((s) => siteId(s, seen));
  return { sites, byFile, ids, errors };
}

/**
 * Read the baseline, FAILING CLOSED. A malformed or missing baseline is treated
 * as EMPTY, so every current site reads as growth — loud and fixable. The
 * opposite default (treat it as "whatever is there now") is a gate that goes
 * green on a damaged input, which reports coverage it does not have. Same
 * reasoning, and the same measured incident, as `check-emit-exit-agreement.mjs`.
 */
function readBaseline(repoRoot) {
  const p = path.join(repoRoot, BASELINE_PATH);
  if (!fs.existsSync(p)) return { ids: [], files: {}, present: false };
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    process.stderr.write(`  [stdout-flush] baseline is not valid JSON (${err.message}) — treating it as EMPTY\n`);
    return { ids: [], files: {}, present: false };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || !Array.isArray(parsed.ids) || !parsed.ids.every((x) => typeof x === 'string')) {
    process.stderr.write('  [stdout-flush] baseline is malformed (expected {ids:[…], files:{…}}) — treating it as EMPTY\n');
    return { ids: [], files: {}, present: false };
  }
  return {
    ids: parsed.ids,
    files: parsed.files && typeof parsed.files === 'object' && !Array.isArray(parsed.files) ? parsed.files : {},
    present: true,
  };
}

function writeBaseline(repoRoot, { ids, byFile, sites }) {
  const envelope = sites.filter((s) => s.payload === 'envelope').length;
  const body = {
    _description:
      'Reachable `process.exit()` sites preceded by a stdout write, per scripts/check-stdout-flush.mjs. '
      + 'Drift-only ratchet: a net-new site fails, and so does an unrecorded shrink. '
      + 'Shrink this list; never grow it. Re-baseline deliberately with --update. '
      + 'The fix for an entry is `await finishAndExit(code)` from scripts/lib/cli-io.mjs.',
    total: ids.length,
    envelope,
    files: byFile,
    ids,
  };
  fs.writeFileSync(path.join(repoRoot, BASELINE_PATH), `${JSON.stringify(body, null, 2)}\n`);
}

function main() {
  // AGENTS.md CLI smoke contract — proves imports survive relocation into a
  // consumer's scripts/.claude-skills/ tree.
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }
  try {
    assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-stdout-flush' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }

  // `--report` writes 183 lines to stdout, so `| head` is the natural way to
  // read it — and that closes the pipe mid-write. Without this handler Node
  // raises an unhandled `EPIPE` error event, printing a stack trace and exiting
  // non-zero, which reads as the gate failing. Found by running
  // `--report | head -1` on this very script: a tool about stdout behaviour
  // getting stdout behaviour wrong.
  process.stdout.on('error', (err) => {
    if (err?.code === 'EPIPE') process.exit(0);
    throw err;
  });

  const repoRoot = path.resolve(process.cwd());
  const { sites, byFile, ids, errors } = scanTree(repoRoot);

  // `hasFlag`, not `.includes`: assertKnownFlags accepts `--update=true`, so a
  // bare includes() check would let the equals form validate and then silently
  // run the GATING path instead of re-baselining — the accepted-and-inert class
  // `cli:flags:gate` exists to stop, reproduced inside a gate.
  if (hasFlag('update')) {
    if (errors.length > 0) {
      process.stderr.write(`  [stdout-flush] refusing to re-baseline: ${errors.length} file(s) failed to scan\n`);
      for (const e of errors) process.stderr.write(`    ${e}\n`);
      process.exit(1);
    }
    writeBaseline(repoRoot, { ids, byFile, sites });
    process.stderr.write(`  [stdout-flush] baseline re-written: ${ids.length} site(s)\n`);
    return;
  }

  const base = readBaseline(repoRoot);
  const baseIds = new Set(base.ids);
  const currentIds = new Set(ids);
  const added = ids.filter((id) => !baseIds.has(id));
  const removed = base.ids.filter((id) => !currentIds.has(id));
  const envelope = sites.filter((s) => s.payload === 'envelope');

  if (hasFlag('json')) {
    emit({
      ok: errors.length === 0 && added.length === 0 && removed.length === 0,
      total: sites.length,
      envelope: envelope.length,
      baseline: base.ids.length,
      added,
      removed,
      scanErrors: errors,
      files: byFile,
    });
    return;
  }

  if (hasFlag('report')) {
    process.stdout.write(
      `stdout-flush census: ${sites.length} reachable site(s) — ${envelope.length} envelope, ${sites.length - envelope.length} text\n\n`,
    );
    for (const s of sites) {
      process.stdout.write(
        `  ${s.payload === 'envelope' ? 'ENVELOPE' : 'text    '}  ${s.file}:${s.line}  exit(${s.exitCode})  ${D}<- ${s.writeHow} @${s.writeLine}${X}\n`,
      );
    }
    return;
  }

  if (errors.length > 0) {
    process.stderr.write(`${R}  [stdout-flush] SCAN FAILED on ${errors.length} file(s) — a file that cannot be parsed is not a clean file${X}\n`);
    for (const e of errors) process.stderr.write(`    ${e}\n`);
    process.exit(1);
  }

  if (added.length > 0) {
    process.stderr.write(
      `${R}  [stdout-flush] DRIFT: ${added.length} NEW site(s) where a stdout write can reach a process.exit().${X}\n`
      + `${added.map((id) => `    ${id}\n`).join('')}`
      + '  On Windows a piped stdout is async, so process.exit() drops whatever has not flushed —\n'
      + '  a truncated JSON envelope reads to the caller as a parse error in the wrong place.\n'
      + '  Fix: `await finishAndExit(code)` from scripts/lib/cli-io.mjs (it drains, then exits).\n'
      + '  In a SYNCHRONOUS function it cannot be awaited — hand the decision to the async caller\n'
      + '  rather than firing `void finishAndExit(code)`, which returns and lets the rest run.\n'
      + '  If a new site is genuinely correct, re-baseline deliberately:\n'
      + '    node scripts/check-stdout-flush.mjs --update\n',
    );
    process.exit(1);
  }

  if (removed.length > 0) {
    process.stderr.write(
      `${Y}  [stdout-flush] ${sites.length} site(s), down from ${base.ids.length} — ratchet DOWN with:${X}\n`
      + '    node scripts/check-stdout-flush.mjs --update\n',
    );
    process.exit(1);
  }

  process.stderr.write(
    `${G}  [stdout-flush] ${sites.length} site(s) (${envelope.length} envelope), at baseline${X}\n`,
  );
}

// `process.argv[1]` is undefined under `node --input-type=module -e`, which is
// how a test imports this module for its `scanTree` export — guard it, or the
// import runs main() before the export is reachable.
//
// No `finishAndExit` here, deliberately. Every stdout-writing path in `main()`
// RETURNS; only the stderr-only failure paths call `process.exit`. Letting the
// process end on its own terms is what makes that safe — and it is the same
// reasoning `emit` records for setting `process.exitCode` instead of exiting.
// A gate for this class that itself truncated its own report would be the
// funniest possible way to be wrong.
if (process.argv[1]?.endsWith('check-stdout-flush.mjs')) {
  main();
}
