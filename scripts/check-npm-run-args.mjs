#!/usr/bin/env node
/**
 * @fileoverview `npm-args:gate` — a documented `npm run <script> --flag` that
 * omits the `--` separator is a silent bug, not a style nit.
 *
 * Why this exists (2026-07-20): npm consumes every token between the script
 * name and a bare `--` as ITS OWN config. `npm run sync --target wine` sets
 * `npm_config_target=wine`, drops `--target`, and forwards the value `wine` as
 * a bare positional the script ignores — so `sync` runs with no target filter
 * and writes into EVERY consumer repo. The AGENTS.md line every agent reads
 * each session carried exactly this form; so did two runbook commands, one of
 * which (`learning:stats --repoName X`) silently returned `{"unknownRepo":true}`
 * instead of erroring. A census found 34 instances.
 *
 * This is the `check-cli-flags` class one layer out: there a flag reaches argv
 * and is dropped inside the script; here npm eats the flag before argv exists,
 * so no in-script guard can ever see it. The only place to catch it is the
 * documentation that tells a human (or an agent) to run the broken command.
 *
 * **The fix is always the same**: `npm run <script> -- --flag`. The `--` ends
 * npm's own option parsing; everything after it is handed to the script
 * verbatim. npm-NATIVE flags (`--silent`, `--workspace`, …) are legitimately
 * consumed by npm and need no `--` — those are the allowlist, and widening it
 * is a deliberate act, never a convenience.
 *
 * **Drift-only gate, seeded with a baseline** — same mechanism and rationale as
 * `check-cli-flags.mjs`. Existing instances are baselined so the gate is a
 * ratchet, not a wall; only a NET-NEW broken command fails a push.
 *
 * **Scope excludes historical surfaces.** `docs/plans/**`, `docs/research/**`,
 * and `docs/completed/**` (a consumer archive dir) are RECORDS of decisions,
 * not instructions anyone runs, and `status.md` is an append-only log whose
 * entries legitimately QUOTE broken commands as the bug being described (this
 * file's own writeup does). Gating them would punish
 * documenting the defect — the same "prose about the bug is not the bug" lesson
 * `check-cli-flags`'s comment-stripping fix records. A broken command added to a
 * plan doc is describing what was decided; a broken command added to AGENTS.md
 * or a runbook is an instruction that will be followed.
 *
 * Usage:
 *   node scripts/check-npm-run-args.mjs            # report-only census
 *   node scripts/check-npm-run-args.mjs --gating   # drift-gate (pre-push)
 *   node scripts/check-npm-run-args.mjs --json
 *
 * Exit codes: 0 — ok (or report-only) · 1 — scanner failure or net-new drift.
 *
 * @module scripts/check-npm-run-args
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

/**
 * Flags npm itself consumes, so they are CORRECT before a `--` and must not be
 * flagged. Conservative on purpose: an unknown flag before `--` is far more
 * likely a script flag npm is silently eating than an npm config the author
 * meant. Widening this list is a deliberate decision — a wrong addition here
 * turns a real bug back into a silent one.
 *
 * `-s`/`-w` short forms and the `--flag=value` shape are handled by the parser.
 */
export const NPM_NATIVE_FLAGS = new Set([
  '--silent', '-s',
  '--quiet',
  '--if-present',
  '--loglevel',
  '--prefix',
  '--workspace', '-w', '--workspaces', '--no-workspaces', '--include-workspace-root',
  '--ignore-scripts',
  '--scripts-prepend-node-path',
  '--foreground-scripts',
]);

/**
 * Paths whose `npm run` lines are records or bug-quotes, not runnable
 * instructions — excluded from the scan entirely (see the file header).
 */
export function isExcludedPath(rel) {
  const p = rel.replace(/\\/g, '/');
  return (
    p.startsWith('docs/plans/') ||
    p.startsWith('docs/research/') ||
    // Archived finished plans — a records dir, same category as plans/research.
    // Upstream has none (the docs/completed archiver was removed; completed
    // plans stay in docs/plans with Status: Complete), but consumers keep one,
    // and a completed plan legitimately QUOTES the command it ran. Excluding it
    // is what lets a consumer's `--gating` be a ratchet rather than a wall on a
    // historical record (found wiring wine-cellar-app's pre-push.local).
    p.startsWith('docs/completed/') ||
    p === 'status.md' ||
    // The rotated session-log archives are the same historical record at a
    // new path; excluding status.md alone would make a rotation fail this
    // gate on prose that was already exempt.
    p.startsWith('docs/status/') ||
    // The gate's own source + test quote broken commands as fixtures.
    p === 'scripts/check-npm-run-args.mjs' ||
    p === 'tests/check-npm-run-args.test.mjs'
  );
}

// A `npm run <script>` invocation. The script token allows the chars npm script
// names legally use (`:`, `/`, `@`, `.`, `-`). The tail stops at a shell
// connector (`&` `|` `;`), a subshell close (`)`), a backtick, or a newline —
// so a SECOND `npm run` after `&&` is left for the global scan to match on its
// own rather than being swallowed here and then dropped. `<`/`>` are kept in
// the tail: `<placeholder>` positionals are common and a flag can legitimately
// follow one (the learning:replay bug), so stopping at `<` would miss it.
const NPM_RUN_RE = /\bnpm run ([\w:@/.-]+)([^\n`&|;)]*)/g;

/**
 * Given the raw tail after `npm run <script>`, return the arg segment that npm
 * would actually receive — everything up to the first shell connector. A later
 * `&& npm run other --x` is a SEPARATE invocation and must not be attributed
 * here (the global regex matches it on its own).
 */
function firstSegment(tail) {
  // Cut at the first shell connector / subshell close / redirect.
  const cut = tail.search(/\s(?:&&|\|\||;|\||>|<)\s|[)]/);
  return cut === -1 ? tail : tail.slice(0, cut);
}

/**
 * Scan one file's text for broken `npm run` commands.
 *
 * A finding is a `--flag` (or `-x` short form) that appears BEFORE any bare
 * `--` and is not an npm-native flag: npm swallows it. A bare `--` ends the
 * scan — everything after it is correctly handed to the script.
 *
 * @param {string} text
 * @returns {{command: string, flag: string, line: number}[]}
 */
export function findBrokenNpmRun(text) {
  const findings = [];
  for (const m of text.matchAll(NPM_RUN_RE)) {
    const script = m[1];
    const seg = firstSegment(m[2]);
    const tokens = seg.split(/\s+/).filter(Boolean);
    for (const rawTok of tokens) {
      // Strip surrounding markdown/optional-notation punctuation. Docs write
      // `[-- --limit N]` to mean "optionally `-- --limit N`", and that form is
      // CORRECT — the `--` is present. Without this, `[--` reads as a token
      // rather than the bare `--` separator, and every flag in the optional
      // group is falsely flagged (real FP: symbol-index/duplicates.mjs usage).
      const tok = rawTok.replace(/^[[({]+/, '').replace(/[\])}.,]+$/, '');
      if (tok === '--') break;               // separator reached — rest is safe
      const isLong = tok.startsWith('--');
      const isShort = /^-[a-z]$/i.test(tok);
      if (!isLong && !isShort) continue;     // a value/positional, not a flag
      const name = tok.includes('=') ? tok.slice(0, tok.indexOf('=')) : tok;
      if (NPM_NATIVE_FLAGS.has(name)) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ command: `npm run ${script}${seg}`.trim(), flag: name, line });
      break;                                 // one finding per command is enough
    }
  }
  return findings;
}

/** Fingerprint a finding for baselining — path + the offending command text. */
export function fingerprint(rel, f) {
  return `${rel.replace(/\\/g, '/')}::${f.command.replace(/\s+/g, ' ').trim()}`;
}

/**
 * Existing broken instructions accepted when this gate landed (2026-07-20).
 * Debt, not approval: shrink, never grow. Empty at birth — the three live
 * instances (AGENTS.md + two runbook lines) were fixed in the same change that
 * added this gate, so there was nothing to baseline. An entry here is a
 * documented command someone chose not to fix yet, keyed by
 * `<path>::<command>`.
 */
export const BASELINE = new Set([]);

/** Text-ish files worth scanning for runnable instructions. */
const SCAN_GLOBS = [
  '*.md', '*.mjs', '*.js', '*.json', '*.yml', '*.yaml', '*.sh',
];

export function discoverFiles(repoRoot) {
  const out = execFileSync('git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...SCAN_GLOBS,
      // also nested
      '**/*.md', '**/*.mjs', '**/*.js', '**/*.json', '**/*.yml', '**/*.yaml', '**/*.sh'],
    { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 128 * 1024 * 1024 });
  return [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];
}

/**
 * @param {{repoRoot:string, files:string[], gating?:boolean, baseline?:Set<string>}} opts
 */
export function runCheck({ repoRoot, files, gating = false, baseline = BASELINE } = {}) {
  const failures = [];
  const findings = [];
  let scanned = 0;

  // "Audit your success paths": an empty scan set is not clean, it is a broken
  // discovery reporting zero because it read nothing.
  if (!files || files.length === 0) {
    failures.push({ rule: 'scan/empty-scan-set', message: 'no files discovered — refusing to report a green' });
    return { ok: false, failures, findings: [], drift: [], baselined: 0, staleBaseline: [], scanned: 0 };
  }

  for (const rel of files) {
    if (isExcludedPath(rel)) continue;
    const abs = path.join(repoRoot, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch (err) {
      failures.push({ rule: 'scanner/stat-failed', file: rel, message: err.message });
      continue;
    }
    if (st.isSymbolicLink()) {
      failures.push({ rule: 'scanner/symlink-refused', file: rel, message: 'symlink refused' });
      continue;
    }
    if (!st.isFile()) continue;

    let text;
    try {
      text = fs.readFileSync(abs, 'utf-8');
    } catch (err) {
      failures.push({ rule: 'scanner/read-failed', file: rel, message: err.message });
      continue;
    }
    scanned++;
    for (const f of findBrokenNpmRun(text)) {
      findings.push({ file: rel.replace(/\\/g, '/'), ...f, fp: fingerprint(rel, f) });
    }
  }

  const drift = findings.filter((f) => !baseline.has(f.fp));
  const baselined = findings.length - drift.length;
  const foundFps = new Set(findings.map((f) => f.fp));
  const staleBaseline = [...baseline].filter((b) => !foundFps.has(b));

  return {
    ok: failures.length === 0 && (!gating || drift.length === 0),
    failures, findings, drift, baselined, staleBaseline, scanned,
  };
}

// This gate's own flags. It would be absurd for the tool that catches dropped
// flags to silently drop its own — and cli:flags:gate enforces exactly that.
const KNOWN_FLAGS = ['--gating', '--json', '--selfcheck-relocation'];

function main() {
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    process.exit(0);
  }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-npm-run-args' });
  const gating = process.argv.includes('--gating');
  const json = process.argv.includes('--json');
  const repoRoot = process.cwd();

  let files;
  try {
    files = discoverFiles(repoRoot);
  } catch (err) {
    console.error(`${R}npm-args: discovery failed${X} — ${err.message}`);
    process.exit(1);
  }

  const r = runCheck({ repoRoot, files, gating });

  if (json) {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }

  console.log(`${B}npm-run -- gate${X} — ${r.scanned} file(s) scanned, ` +
    `${r.findings.length} broken \`npm run\` command(s) (${r.baselined} baselined, ${r.drift.length} net-new)`);

  if (r.failures.length > 0) {
    console.error(`\n${R}${B}Scanner failures${X} (${r.failures.length}) — the scan is NOT trustworthy:`);
    for (const f of r.failures) console.error(`  ${R}${f.rule}${X} ${f.file ?? ''} — ${f.message}`);
  }

  if (r.staleBaseline.length > 0) {
    console.log(`\n${G}baseline can shrink${X} (${r.staleBaseline.length}) — fixed or gone, remove from BASELINE:`);
    for (const f of r.staleBaseline) console.log(`  ${f}`);
  }

  if (gating) {
    if (r.drift.length > 0) {
      console.error(`\n${R}${B}DRIFT${X} (${r.drift.length}) — \`npm run\` command(s) whose flag npm will swallow:`);
      for (const f of r.drift) {
        console.error(`  ${R}${f.file}:${f.line}${X}  ${D}${f.command}${X}`);
        console.error(`    ${Y}npm eats ${f.flag}${X} — insert \`--\` before it: ${D}npm run … -- ${f.flag} …${X}`);
      }
    } else {
      console.log(`\n${G}drift-gate: clean${X} — ${r.baselined} in the accepted baseline, 0 net-new.`);
    }
  } else if (r.findings.length > 0) {
    console.log(`\n${Y}report-only${X} — findings do not fail the run (pass --gating for the drift-gate).`);
    for (const f of r.findings) {
      console.log(`  ${f.file}:${f.line}  ${D}${f.command}${X}  ${Y}(npm eats ${f.flag})${X}`);
    }
  }

  process.exit(r.ok ? 0 : 1);
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the diagnostic alone, no stack.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
