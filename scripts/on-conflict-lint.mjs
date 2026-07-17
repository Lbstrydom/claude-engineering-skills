#!/usr/bin/env node
/**
 * @fileoverview CLI: lint the cloud store's write path for the
 * conflict-target-≠-stored-identity defect class (see
 * scripts/lib/lint/on-conflict.mjs for the full rationale + the three field
 * instances that motivated it).
 *
 * Default is DRIFT mode: gate only on findings whose line is in the changed
 * hunks (vs the dirty-aware base — uncommitted work, else last commit),
 * mirroring nav-audit/visual-audit. The existing store's design-correct-but-
 * flagged writers never gate; a new/edited bad conflict target does. `--all`
 * lints the whole tree (manual/audit use).
 *
 * Exit codes:
 *   0 — clean (no gating findings)
 *   1 — at least one gating finding
 *   3 — --strict and at least one unresolved-* diagnostic (a site the lint
 *       could not read; refuse to certify clean)
 *
 * Flags:
 *   --all       lint the whole store tree (default is drift vs the base)
 *   --base <r>  drift base override (default: dirty→HEAD, clean→HEAD~1)
 *   --json      machine-readable output
 *   --strict    treat unresolved-* diagnostics as failures (exit 3)
 *
 * @module scripts/on-conflict-lint
 */
import { execFileSync } from 'node:child_process';
import { lintStoreTree, filterFindingsToDiff } from './lib/lint/on-conflict.mjs';
import { parseDiffText } from './lib/diff-annotation.mjs';
import { normalizePath } from './lib/file-io.mjs';

function resolveDefaultBase() {
  // As a pre-push gate the right base is "everything not yet on the remote" —
  // `git diff @{u}` covers committed AND uncommitted changes since the upstream,
  // so a bad conflict target in any un-pushed commit gates. Fall back to the
  // audit's dirty-aware convention when there's no upstream (fresh branch / CI).
  try {
    execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return '@{u}';
  } catch { /* no upstream */ }
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== '';
  return dirty ? 'HEAD' : 'HEAD~1';
}

function computeDriftFindings(findings, baseArg) {
  const base = baseArg || resolveDefaultBase();
  const opts = { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 };
  // Tracked changes vs the base. Parse in memory — no temp file (audit R1-H4).
  let diffText = execFileSync('git', ['diff', base, '--', 'scripts/lib/store'], opts);
  // `git diff` omits UNTRACKED files, so a brand-new store writer would never
  // gate (audit R2-M1). Append each untracked store file as a /dev/null→file
  // diff so it counts as wholly-changed — exactly the R2+ audit convention.
  const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', 'scripts/lib/store'], opts)
    .split('\n').map((s) => s.trim()).filter(Boolean);
  for (const f of untracked) {
    try { execFileSync('git', ['diff', '--no-index', '--no-color', '--', '/dev/null', f], opts); }
    catch (e) { diffText += (e.stdout || ''); } // --no-index exits 1 when files differ; the diff is on stdout
  }
  const diffMap = parseDiffText(diffText);
  return { drift: filterFindingsToDiff(findings, diffMap, { normalize: normalizePath }), base };
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const json = process.argv.includes('--json');
  const strict = process.argv.includes('--strict');
  const all = process.argv.includes('--all');
  const baseIdx = process.argv.indexOf('--base');
  const baseArg = baseIdx >= 0 ? process.argv[baseIdx + 1] : undefined;

  const { findings: allFindings, suppressed, diagnostics, filesScanned } = lintStoreTree();
  const unresolved = diagnostics.filter((d) => d.kind?.startsWith('unresolved'));

  let gating = allFindings;
  let base;
  if (!all) {
    try {
      const res = computeDriftFindings(allFindings, baseArg);
      gating = res.drift;
      base = res.base;
    } catch (err) {
      process.stderr.write(`on-conflict-lint: drift computation failed (${err.message}); falling back to --all\n`);
      gating = allFindings;
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ mode: all ? 'all' : 'drift', base, gating, allFindings, suppressed, diagnostics, filesScanned }, null, 2) + '\n');
  } else {
    for (const f of gating) {
      process.stdout.write(`  ✖ [${f.rule}] ${f.file}:${f.line} — table "${f.table}", column "${f.column}"\n      ${f.message}\n`);
    }
    // Diagnostics are advisory (non-gating). Keep the default drift gate quiet
    // on a clean push — the summary line still reports the counts; surface the
    // detail only when something gates, or on an explicit --all/--strict run.
    if (all || strict || gating.length > 0) {
      for (const d of diagnostics) {
        process.stdout.write(`  ⚠ [${d.kind}] ${d.file}:${d.line} — ${d.message}\n`);
      }
    }
    const scope = all ? 'whole tree' : `drift vs ${base}`;
    const verdict = gating.length === 0 ? 'clean' : `${gating.length} gating finding(s)`;
    const extra = [];
    if (!all && allFindings.length > gating.length) extra.push(`${allFindings.length - gating.length} pre-existing (not in diff)`);
    if (suppressed.length) extra.push(`${suppressed.length} suppressed`);
    if (unresolved.length) extra.push(`${unresolved.length} unresolved`);
    process.stderr.write(`on-conflict-lint: scanned ${filesScanned} store file(s), ${scope} — ${verdict}` +
      (extra.length ? ` (${extra.join(', ')})` : '') + '\n');
  }

  if (gating.length > 0) process.exit(1);
  if (strict && unresolved.length > 0) process.exit(3);
  process.exit(0);
}

main();
