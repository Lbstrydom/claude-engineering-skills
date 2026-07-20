#!/usr/bin/env node
/**
 * @fileoverview CLI: lint the cloud store's write path for the
 * conflict-target-≠-stored-identity defect class (see
 * scripts/lib/lint/on-conflict.mjs for the full rationale + the three field
 * instances that motivated it).
 *
 * Default is DRIFT mode: gate only on findings whose line is in the changed
 * hunks (vs the push range — see scripts/lib/push-range.mjs), mirroring
 * nav-audit/visual-audit. The existing store's design-correct-but-flagged
 * writers never gate; a new/edited bad conflict target does. `--all` lints
 * the whole tree (manual/audit use).
 *
 * Exit codes:
 *   0 — clean (no gating findings)
 *   1 — at least one gating finding
 *   3 — --strict and at least one unresolved-* diagnostic (a site the lint
 *       could not read; refuse to certify clean)
 *
 * Flags:
 *   --all       lint the whole store tree (default is drift vs the base)
 *   --base <r>  drift base override (default: the resolved push range)
 *   --json      machine-readable output
 *   --strict    treat unresolved-* diagnostics as failures (exit 3)
 *
 * @module scripts/on-conflict-lint
 */
import { execFileSync } from 'node:child_process';
import { resolvePushRange } from './lib/push-range.mjs';
import { lintStoreTree, filterFindingsToDiff } from './lib/lint/on-conflict.mjs';
import { parseDiffText } from './lib/diff-annotation.mjs';
import { normalizePath } from './lib/file-io.mjs';

/**
 * Resolve the drift base via the shared push-range contract.
 *
 * This used to infer the base from working-tree state (`@{u}`, else
 * dirty ? HEAD : HEAD~1). That silently under-scoped the gate twice over: a
 * multi-commit push collapsed to its tip commit, and a clean detached checkout
 * (which is never dirty and has no upstream) collapsed to HEAD~1 on EVERY run.
 * The pre-push hook already knows the true range and now passes it through
 * AUDIT_PUSH_RANGE_BASE; see scripts/lib/push-range.mjs.
 *
 * @returns {{base: string, source: string, trusted: boolean}}
 * @throws when no base is resolvable — the caller falls back to --all rather
 *   than reporting a clean drift run it could not actually scope.
 */
function resolveDefaultBase() {
  const r = resolvePushRange();
  if (!r.ok) throw new Error(`cannot resolve a drift base — ${r.message}`);
  return r;
}

function computeDriftFindings(findings, baseArg) {
  // An explicit --base is an operator override and is trusted as given.
  const resolved = baseArg ? { base: baseArg, source: 'flag', trusted: true } : resolveDefaultBase();
  const base = resolved.base;
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
  return {
    drift: filterFindingsToDiff(findings, diffMap, { normalize: normalizePath }),
    base,
    source: resolved.source,
    trusted: resolved.trusted,
  };
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
  let base, rangeSource, rangeTrusted, driftFellBack = false;
  if (!all) {
    try {
      const res = computeDriftFindings(allFindings, baseArg);
      gating = res.drift;
      base = res.base;
      rangeSource = res.source;
      rangeTrusted = res.trusted;
    } catch (err) {
      process.stderr.write(`on-conflict-lint: drift computation failed (${err.message}); falling back to --all\n`);
      gating = allFindings;
      driftFellBack = true;   // so the summary cannot claim a drift scope it never had
    }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ mode: all ? 'all' : 'drift', base, rangeSource, rangeTrusted, gating, allFindings, suppressed, diagnostics, filesScanned }, null, 2) + '\n');
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
    // Name the range SOURCE, not just the base. An inferred base may have
    // under-scoped this run, and a summary that hides that reads as a
    // stronger clean than it is.
    const scope = (all || driftFellBack)
      ? `whole tree${driftFellBack ? ' (drift unavailable)' : ''}`
      : `drift vs ${base}${rangeTrusted === false ? ` (inferred: ${rangeSource})` : ''}`;
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
