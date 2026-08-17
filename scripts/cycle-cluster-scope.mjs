#!/usr/bin/env node
/**
 * @fileoverview `/cycle` Step 3C's deterministic half — the work a SKILL.md
 * cannot do.
 *
 * WHY THIS EXISTS (measured 2026-08-13). `/cycle`'s per-cluster audit told the
 * agent to invoke `/audit-code --scope=diff` with `--changed`=the cluster's
 * derived scope. `--changed` does not scope the prompt — it is the R2+ impact
 * set for reopen detection (`openai-audit.mjs:622`) — so `--scope=diff`
 * recomputed the file set from the working tree instead. On a tree shared with a
 * concurrent session that meant **52 files reached the prompt against 11
 * declared**, and 26 of 31 findings concerned code the cluster never touched.
 * The failure was silent and read as thoroughness.
 *
 * The fix is `--files` (an allowlist that overrides `--scope`). But the
 * surrounding protocol — computing the reconciliation set, keeping deletes and
 * both rename operands, filtering to on-disk paths for the allowlist, and
 * running the admission pre-flight — is deterministic work that was originally
 * written as prose for an LLM to carry out. That is unsound: a model cannot
 * reliably parse a NUL-delimited byte stream inline, and hand-applying
 * `isAuditInfraFile` invites a hallucinated admission decision on the one check
 * that must be deterministic. So it lives here, in code, with tests, and
 * `/cycle` reads the JSON.
 *
 * **TWO SETS, TWO PURPOSES — conflating them is unsatisfiable.**
 *   reconciliation set — every changed path, INCLUDING deletes and both rename
 *                        operands. Answers "did an edit leave the cluster?"
 *   allowlist (files)  — that set filtered to paths that exist on disk.
 *                        Answers "what should the audit read?"
 * A deleted path must be in the first and must not be in the second: the audit's
 * admission policy rejects paths that are not on disk, so including it
 * guarantees a shortfall.
 *
 * Usage:
 *   node scripts/cycle-cluster-scope.mjs --base <ref> --scope-file <file> \
 *     [--out-dir .audit] [--cluster <id>] [--json]
 *
 * Exit codes: 0 — clean · 1 — out-of-scope edit, unadmittable path, or a
 * comma-unsafe path · 2 — usage error.
 *
 * Design: docs/plans/cycle-cluster-audit-scope.md KD-2 / KD-3.
 *
 * @module scripts/cycle-cluster-scope
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertKnownFlags, ArgvError, argOption, hasFlag } from './lib/cli-io.mjs';
// The ONE admission oracle. Imported, never restated — a second copy of the
// predicate is how the pre-flight and the CLI would silently disagree.
import { isAuditInfraFile } from './lib/audit-scope.mjs';
import { resolveReferenceExtension } from './lib/plan-paths.mjs';

// The extension policy is IMPORTED from the module the auditor itself uses
// (`mergeScopeFiles` resolves admission through the same oracle). An earlier
// version hardcoded a set "mirroring" it — a second authority that would drift
// the moment the auditor gained or dropped an extension, leaving this pre-flight
// rejecting files the audit would have read, or admitting files it then filtered.
// `resolveReferenceExtension` — not a bare `path.extname()` Set-lookup — is
// what keeps this pre-flight in agreement with `mergeScopeFiles` on a
// double-extension name like `index.html.template`: `path.extname()`
// truncates to the outer, unregistered segment ('.template') and rejects
// every such file as 'extension', caught by running a fixture, not by
// reading.

/**
 * Run git with an ARGV ARRAY — never a shell string, so no path can word-split.
 *
 * `cwd` is an explicit parameter rather than a module-level `process.cwd()`
 * captured at import: an ambient root makes the exported functions untestable
 * against a fixture repo (a `chdir` after import has no effect), and an
 * import-time constant is exactly the kind of hidden state that reads correct
 * and behaves otherwise.
 */
function git(args, cwd) {
  return execFileSync('git', args, {
    cwd, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/** Split a NUL-delimited git stream into records, dropping the trailing empty. */
const nulSplit = out => out.split('\0').filter(s => s.length > 0);

/**
 * The reconciliation set: every path that differs from `base`, including
 * deletes and BOTH operands of a rename/copy.
 *
 * Parsing is STATUS-AWARE. `--name-status -z` emits `STATUS\0path\0` except for
 * `R*`/`C*`, which emit `STATUS\0old\0new\0`. A parser reading fixed pairs
 * desynchronises on the first rename and mis-attributes every later path.
 *
 * No `--diff-filter`: the set is "everything that differs", and filtering it is
 * an opportunity to forget a letter (an earlier draft's `ACMRD` omitted `T`,
 * type changes).
 *
 * @returns {{tracked: string[], untracked: string[], all: string[]}}
 */
export function collectReconciliationSet(baseOid, cwd = process.cwd()) {
  const tracked = [];
  const records = nulSplit(git(['-c', 'core.quotepath=off', 'diff', '--name-status', '-z', '-M', baseOid], cwd));
  for (let i = 0; i < records.length;) {
    const status = records[i];
    if (/^[RC]/.test(status)) {
      // Rename/copy: both operands count. The old path LEFT the cluster's scope.
      if (records[i + 1]) tracked.push(records[i + 1]);
      if (records[i + 2]) tracked.push(records[i + 2]);
      i += 3;
    } else {
      if (records[i + 1]) tracked.push(records[i + 1]);
      i += 2;
    }
  }
  const untracked = nulSplit(git(['ls-files', '--others', '--exclude-standard', '-z'], cwd));
  return { tracked, untracked, all: [...new Set([...tracked, ...untracked])] };
}

/**
 * The admission pre-flight, run BEFORE any spend. An earlier design compared
 * counts after invoking — by which point the model has been paid and has emitted
 * a verdict over the narrowed set, which is the confident-but-hollow outcome the
 * whole protocol exists to prevent.
 *
 * @returns {{path: string, admitted: boolean, reason: string|null}[]}
 */
export function admissionPreflight(scopePaths, { exists, cwd = process.cwd(), changedPaths = [] } = {}) {
  const onDisk = exists ?? (p => fs.existsSync(path.join(cwd, p)));
  // A declared path can be absent for two very different reasons, and conflating
  // them made a legitimate delete unrunnable: a cluster whose plan intent-tags a
  // file `(delete)` MUST declare it (that is how the ownership check knows the
  // deletion was authorised), but it is gone from disk by the time we look.
  //   - absent AND present in the reconciliation set ⇒ THIS cluster removed it.
  //     Correctly excluded from the allowlist, NOT a problem.
  //   - absent and unexplained ⇒ a typo or a path that never existed. Fatal.
  const changed = new Set(changedPaths);
  return scopePaths.map((p) => {
    if (!onDisk(p)) {
      return changed.has(p)
        ? { path: p, admitted: false, reason: 'removed-by-this-cluster', fatal: false }
        : { path: p, admitted: false, reason: 'not-on-disk', fatal: true };
    }
    if (resolveReferenceExtension(p) === null) return { path: p, admitted: false, reason: 'extension', fatal: true };
    if (isAuditInfraFile(p)) return { path: p, admitted: true, reason: 'infra-requires-allow-flag', fatal: false };
    return { path: p, admitted: true, reason: null, fatal: false };
  });
}

/** Paths `--files` cannot transport: it splits on `,` (openai-audit.mjs:594). */
export const commaUnsafe = paths => paths.filter(p => p.includes(','));

function main() {
  const REPO_ROOT = process.cwd();
  assertKnownFlags(process.argv,
    ['--base', '--scope-file', '--out-dir', '--cluster', '--json', '--selfcheck-relocation'],
    { cli: 'cycle-cluster-scope' });
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const baseRef = argOption('base');
  const scopeFile = argOption('scope-file');
  const outDir = argOption('out-dir', '.audit');
  const clusterId = argOption('cluster', 'x');
  const asJson = hasFlag('json');

  if (!baseRef || !scopeFile) {
    console.error('cycle-cluster-scope: --base <ref> and --scope-file <file> are both required');
    process.exit(2);
  }

  // Resolve to a FULL IMMUTABLE OID and keep it in that form. A symbolic ref is
  // mutable; the repo's one-range-one-resolver rule exists because a base that
  // moves yields a silently wrong envelope rather than an error.
  let baseOid;
  try {
    baseOid = git(['rev-parse', '--verify', `${baseRef}^{commit}`], REPO_ROOT).trim();
  } catch {
    console.error(`cycle-cluster-scope: --base "${baseRef}" is not a resolvable commit`);
    process.exit(2);
  }
  try {
    git(['merge-base', '--is-ancestor', baseOid, 'HEAD'], REPO_ROOT);
  } catch {
    console.error(`cycle-cluster-scope: base ${baseOid.slice(0, 12)} is not an ancestor of HEAD — `
      + 'it has left this history (rebase/amend). Refusing rather than silently widening the range.');
    process.exit(2);
  }

  let scopePaths;
  try {
    scopePaths = fs.readFileSync(path.resolve(scopeFile), 'utf-8')
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch (err) {
    console.error(`cycle-cluster-scope: cannot read --scope-file ${scopeFile}: ${err.message}`);
    process.exit(2);
  }
  if (scopePaths.length === 0) {
    console.error('cycle-cluster-scope: --scope-file declared no paths; refusing an empty cluster scope');
    process.exit(2);
  }

  const problems = [];

  // A comma-bearing path cannot cross --files without splitting into two wrong
  // paths. Stop loudly rather than silently narrowing the allowlist — a silent
  // narrowing is the very failure class this tool exists to remove.
  const unsafe = commaUnsafe(scopePaths);
  if (unsafe.length > 0) {
    problems.push(`comma-unsafe path(s) cannot be passed via --files: ${unsafe.join(' | ')}`);
  }

  // Reconciliation FIRST: admission needs it to tell a cluster's own delete
  // from a path that never existed.
  const recon = collectReconciliationSet(baseOid, REPO_ROOT);
  const admissions = admissionPreflight(scopePaths, { cwd: REPO_ROOT, changedPaths: recon.all });
  for (const a of admissions) {
    if (a.fatal) problems.push(`declared scope path would not be admitted (${a.reason}): ${a.path}`);
  }
  const allowInfraScopeRequired = admissions.some(a => a.reason === 'infra-requires-allow-flag');

  // Anything changed since base that no cluster owns.
  const owned = new Set(scopePaths);
  const outOfScope = recon.all.filter(p => !owned.has(p));
  for (const p of outOfScope) {
    problems.push(`out-of-scope edit (belongs to no declared cluster scope): ${p}`);
  }

  // The allowlist is the declared scope filtered to what exists on disk —
  // deletes and old rename operands are deliberately absent here while remaining
  // in the reconciliation set above.
  const files = admissions.filter(a => a.admitted).map(a => a.path);

  let diffPath = null;
  if (files.length > 0) {
    fs.mkdirSync(path.resolve(outDir), { recursive: true });
    diffPath = path.join(outDir, `cluster-${clusterId}.diff`);
    // argv array, not a shell string: a path with a space cannot split.
    fs.writeFileSync(path.resolve(diffPath), git(['diff', baseOid, '--', ...files], REPO_ROOT));
  }

  const result = {
    ok: problems.length === 0,
    base: baseOid,
    filesCsv: files.join(','),
    files,
    diffPath,
    allowInfraScopeRequired,
    admissions,
    reconciliation: { tracked: recon.tracked, untracked: recon.untracked },
    outOfScope,
    // An empty allowlist is reported, never disguised. A deletion-only cluster
    // legitimately lands here: there is no code to read, so it routes to the
    // consolidated gate rather than producing a vacuous per-cluster pass.
    emptyAllowlist: files.length === 0,
    problems,
  };

  if (asJson) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else console.log(`cycle-cluster-scope: ${files.length} file(s) admitted, ${outOfScope.length} out-of-scope`);

  if (problems.length > 0) {
    for (const p of problems) console.error(`  ${p}`);
    console.error('  AGENT FIX: amend the cluster scope in the plan, or stop and ask — do NOT audit a partial scope.');
    process.exit(1);
  }
  if (result.emptyAllowlist) {
    console.error('cycle-cluster-scope: no auditable files (deletion-only cluster?) — '
      + 'route to the consolidated gate over the union diff; a per-cluster pass here would be vacuous.');
  }
  process.exit(0);
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
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
