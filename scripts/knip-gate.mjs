#!/usr/bin/env node
/**
 * @fileoverview Drift-only pre-push gate over `knip`.
 *
 * WHY DRIFT-ONLY, NOT ABSOLUTE. Both this repo and its consumers carry a real
 * backlog of pre-existing knip findings (17 here, 26 in wine-cellar-app at the
 * time of writing). A gate that fails on all of them fails on the first push,
 * teaches everyone to reach for `--no-verify`, and is then worse than no gate —
 * the exact failure documented in docs/plans/dead-code-phase-1-orphan-introduced.md
 * §Telemetry Verdict (78% FP, 0/113 findings ever triaged).
 *
 * So this mirrors `scripts/check-docs-refs.mjs`: a committed baseline of accepted
 * findings, and a non-zero exit ONLY for net-new ones. Burn the backlog down at
 * your own pace; never let it block an unrelated push.
 *
 * SELF-CLEANING (also from check-docs-refs): a baseline entry that no longer
 * appears is itself drift — someone fixed it, and leaving the entry behind would
 * silently re-accept the finding if it ever came back. Stale entries fail the
 * gate too, with instructions to remove them.
 *
 * Usage:
 *   node scripts/knip-gate.mjs                 # gate: exit 1 on net-new or stale
 *   node scripts/knip-gate.mjs --report        # report-only, always exit 0
 *   node scripts/knip-gate.mjs --update-baseline
 *   node scripts/knip-gate.mjs --baseline <path>
 *
 * @module scripts/knip-gate
 */

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags } from './lib/cli-io.mjs';

/** Issue types we gate on. `exports`/`types` are deliberately excluded — they
 *  are the high-volume, low-precision half (630 in wine-cellar-app). Run
 *  `npm run knip:exports` by hand when you want them. */
const GATED_TYPES = Object.freeze(['files', 'dependencies', 'devDependencies', 'unlisted', 'unresolved']);

const DEFAULT_BASELINE = '.knip-baseline.json';

/** Stable key for one finding: `<type>:<file>[→<name>]`. Both halves are
 *  slash-normalised before comparison — a `name` that IS the file path (the
 *  common case for `files`-type issues) but arrives with un-normalised
 *  backslashes must still collapse to the no-arrow form, or every Windows run
 *  would mint a spurious `file→file` key never seen on POSIX (and vice versa),
 *  making the baseline non-portable across OSes. */
function keyFor(type, file, name) {
  const f = String(file || '').replace(/\\/g, '/');
  const n = name ? String(name).replace(/\\/g, '/') : name;
  return n && n !== f ? `${type}:${f}→${n}` : `${type}:${f}`;
}

/** Flatten knip's JSON reporter output into a sorted array of stable keys. */
export function collectKeys(parsed, gatedTypes = GATED_TYPES) {
  const keys = new Set();
  for (const entry of parsed?.issues ?? []) {
    for (const type of gatedTypes) {
      for (const item of entry[type] ?? []) {
        const name = typeof item === 'string' ? item : item?.name;
        keys.add(keyFor(type, entry.file, name));
      }
    }
  }
  return [...keys].sort();
}

/** Pure diff so the decision logic is testable without spawning knip. */
export function diffAgainstBaseline(current, baseline) {
  const base = new Set(baseline);
  const cur = new Set(current);
  return {
    netNew: current.filter(k => !base.has(k)),
    stale: [...base].filter(k => !cur.has(k)).sort(),
  };
}

/**
 * Locate knip's CLI script and run it with the CURRENT Node binary — no
 * shell, no `npx`/`.cmd` shim. Node >=22.19 EINVALs when spawning a `.cmd`
 * without `shell: true` (CVE-2024-27980 hardening), the exact failure
 * `scripts/lib/playwright-runner.mjs` hit and fixed the same way; `shell: true`
 * would reopen the quoting pitfalls that fix was written to avoid.
 *
 * `knip/package.json`'s `exports` map only publishes `.` (→ `dist/index.js`)
 * and `./session` — no subpath for `bin/knip.js`, so `require.resolve` can't
 * reach it directly even though the file exists. Resolve the package's real
 * entry first (which the exports map does publish), then derive the CLI path
 * as a sibling of `dist/`. Verified 2026-07-28 against knip 6.29.0's own
 * `bin` field (`{"knip": "bin/knip.js"}`); re-check if a knip major bump ever
 * relocates it.
 */
function resolveKnipCli(repoRoot) {
  const req = createRequire(path.join(repoRoot, 'package.json'));
  const mainEntry = req.resolve('knip'); // …/node_modules/knip/dist/index.js
  const cli = path.join(path.dirname(path.dirname(mainEntry)), 'bin', 'knip.js');
  if (!fs.existsSync(cli)) {
    throw new Error(`knip CLI not found at expected path ${cli} — is knip installed? (npm i -D knip)`);
  }
  return cli;
}

function runKnip(repoRoot) {
  const cli = resolveKnipCli(repoRoot);
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [cli, '--no-progress', '--reporter', 'json', '--include', GATED_TYPES.join(',')], {
      cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // knip exits non-zero when it HAS findings — that is the normal path here.
    // A genuine crash produces no parseable stdout, which the caller detects.
    stdout = err.stdout || '';
    if (!stdout.trim()) {
      throw new Error(`knip failed to run: ${(err.stderr || err.message || '').toString().slice(0, 300)}`);
    }
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error('knip produced unparseable JSON — cannot gate honestly, refusing to pass');
  }
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, ['--report', '--update-baseline', '--baseline', '--help'], { cli: 'knip-gate' });

  const argv = process.argv.slice(2);
  const repoRoot = process.cwd();
  const bIdx = argv.indexOf('--baseline');
  const baselinePath = path.resolve(repoRoot, bIdx !== -1 ? argv[bIdx + 1] : DEFAULT_BASELINE);
  const reportOnly = argv.includes('--report');
  const updating = argv.includes('--update-baseline');

  const current = collectKeys(runKnip(repoRoot));

  if (updating) {
    fs.writeFileSync(baselinePath, `${JSON.stringify({ generated: 'knip-gate', keys: current }, null, 2)}\n`);
    console.log(`knip-gate — baseline written: ${current.length} accepted finding(s) → ${path.relative(repoRoot, baselinePath)}`);
    return;
  }

  let baseline = [];
  if (fs.existsSync(baselinePath)) {
    baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).keys ?? [];
  } else if (!reportOnly) {
    console.error(`knip-gate — no baseline at ${path.relative(repoRoot, baselinePath)}. Create one with:\n  node scripts/knip-gate.mjs --update-baseline`);
    process.exit(1);
  }

  const { netNew, stale } = diffAgainstBaseline(current, baseline);

  if (netNew.length === 0 && stale.length === 0) {
    console.log(`knip-gate: clean — ${baseline.length} finding(s) in the accepted baseline, 0 net-new.`);
    return;
  }
  for (const k of netNew) console.error(`  NET-NEW  ${k}`);
  for (const k of stale) console.error(`  STALE    ${k}  (fixed — remove from baseline)`);

  if (reportOnly) {
    console.log(`knip-gate: report-only — ${netNew.length} net-new, ${stale.length} stale (not failing).`);
    return;
  }
  console.error(`\nknip-gate FAILED — ${netNew.length} net-new, ${stale.length} stale.`);
  console.error('Fix the finding, or accept it deliberately with: node scripts/knip-gate.mjs --update-baseline');
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('knip-gate.mjs')) {
  main().catch(err => { console.error(`knip-gate: ${err.message}`); process.exit(1); });
}
