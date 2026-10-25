#!/usr/bin/env node
/**
 * @fileoverview Thin CLI over lib/plan-status.mjs. Two modes:
 *   --select <dir>  — print the one plan the pre-push hook should audit (or nothing).
 *   (default)       — the vocabulary lint: fail on any non-conforming Status line.
 *   --drift         — lint, but gate ONLY on plans changed in the push range;
 *                     pre-existing violations are reported, never blocking
 *                     (on-conflict-lint.mjs's convention). This is what the
 *                     consumer pre-push hook runs, so turning the gate on in a
 *                     repo that already has violations cannot break its next push.
 *
 * It does NO parsing of its own (R1-H2 — one contract, one implementation).
 * Contract: docs/plans/reference-integrity-gate.md §2.
 *
 * Hook ↔ CLI protocol (R3-H5): in --select mode, **stdout carries ONLY the chosen
 * repo-relative path (or nothing)** — the hook reads it via command substitution,
 * so a stray stdout byte would become PLAN_FILE. Every diagnostic goes to stderr.
 * Exit 0 whether a plan was selected or not; exit ≠ 0 only on a genuine tool fault.
 *
 * @module scripts/check-plan-status
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parsePlanStatus, selectAuditPlan, classifyPlanStatus, listPlanFiles, checkPlanDependencies,
} from './lib/plan-status.mjs';
import { resolvePushRange, branchOwnedChangedFiles } from './lib/push-range.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { gitPlanFiles } from './lib/plan-git-source.mjs';
import { canonicalizeEol } from './lib/file-io.mjs';

const PLANS_DIR = 'docs/plans';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

/**
 * Files changed in the range about to be pushed, or `null` when git can't tell
 * us (no upstream, detached HEAD, not a repo, git missing). `null` is the
 * "no signal" value and must stay distinct from `[]` ("this push changed
 * nothing") — selectAuditPlan reads an empty list as a real answer.
 *
 * Deliberately tolerant: this only SHARPENS selection. A git hiccup must never
 * abort a push, so every failure degrades to `null` (unbound selection).
 *
 * @returns {string[]|null}
 */
function changedFilesForPush() {
  const rev = (args) => {
    const r = spawnSync('git', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    // A NUL-delimited (-z) listing is data: trimming would eat leading whitespace of its first path.
    return r.status === 0 ? (args.includes('-z') ? r.stdout : r.stdout.trim()) : null;
  };
  // The range comes from the shared push-range contract, which prefers what the
  // pre-push hook was told by git over anything inferred here. The old inline
  // `@{upstream} ?? HEAD~1` scoped a multi-commit push to its tip, and resolved
  // to HEAD~1 unconditionally in a detached checkout. See lib/push-range.mjs.
  const range = resolvePushRange({ run: rev });
  if (!range.ok) return null;
  // A merge of the default branch into the pushed branch brings the whole of main's delta into base..head. Plan selection and the
  // drift gate answer "which plans did THIS PUSH change", so they see the branch's own commits only (push-range.mjs).
  const owned = branchOwnedChangedFiles(range, { run: rev });
  if (owned === null) return null;
  if (owned.scoped) {
    process.stderr.write(`  [plan-status] merge push: ${owned.excluded} file(s) that arrived from the default branch are not this push's changes\n`);
  }
  return owned.files;
}

/**
 * The plan files of the commit being pushed, or `null` to use the working tree. Only a range git ITSELF handed the hook (trusted)
 * names the pushed commit; an inferred one is a guess, and so is any git failure - both fall back to the working tree, said aloud.
 * Fleet 4146: reading the working tree judged the wrong tree whenever the push came from a different checkout than the branch.
 */
const UNAVAILABLE = Symbol('pushed-plans-unavailable');
function pushedPlanFiles() {
  const range = resolvePushRange({});
  if (!range.ok || !range.trusted) return null;
  const files = gitPlanFiles({ head: range.head });
  if (files === null) {
    // A trusted pushed commit that cannot be read is NOT licence to read the working tree: that is the wrong-tree behaviour this exists to end.
    process.stderr.write("  [plan-status] could not read the pushed commit's plans from git; refusing to substitute this checkout's working tree\n");
    return UNAVAILABLE;
  }
  process.stderr.write(`  [plan-status] reading ${files.length} plan(s) from the pushed commit ${String(range.head).slice(0, 8)}, not the working tree\n`);
  return files;
}

/** The audit receives a PATH and reads the checkout: a plan whose pushed content differs from (or is absent in) the checkout would be audited as another document. */
function planMatchesCheckout(planFiles, absPath) {
  const pushed = planFiles.find((p) => p.abs === absPath);
  if (!pushed) return true;
  try { return canonicalizeEol(fs.readFileSync(absPath)).equals(canonicalizeEol(Buffer.from(pushed.content, 'utf8'))); } catch { return false; }
}

function selectMode(dir) {
  const abs = path.resolve(dir);

  // Explicit operator override always wins — the escape hatch for "I know which
  // plan this implements and the heuristics can't see it".
  const override = (process.env.AUDIT_PREPUSH_PLAN ?? '').trim();
  if (override) {
    if (!fs.existsSync(override)) {
      process.stderr.write(`  [plan-status] AUDIT_PREPUSH_PLAN=${override} does not exist — selecting nothing\n`);
      process.exit(0);
    }
    process.stdout.write(path.relative(process.cwd(), path.resolve(override)).replace(/\\/g, '/') + '\n');
    process.exit(0);
  }

  const changedFiles = changedFilesForPush();
  const planFiles = pushedPlanFiles();
  if (planFiles === UNAVAILABLE) { process.stderr.write('  [plan-status] no active plan to audit\n'); process.exit(0); }
  const sel = selectAuditPlan(abs, {
    warn: m => process.stderr.write(`  [plan-status] ${m}\n`),
    changedFiles,
    planFiles,
  });
  if (sel && planFiles && !planMatchesCheckout(planFiles, sel.path)) {
    process.stderr.write(`  [plan-status] the pushed ${path.basename(sel.path)} differs from this checkout's copy (or is absent here) - the audit would read a different document than the one selected, so nothing is selected. Check out the pushed commit, or set AUDIT_PREPUSH_PLAN=<path>.\n`);
    process.stderr.write('  [plan-status] no active plan to audit\n');
    process.exit(0);
  }
  if (sel) {
    if (sel.boundBy) process.stderr.write(`  [plan-status] selected ${path.basename(sel.path)} via ${sel.boundBy}${sel.why ? `: ${sel.why}` : ''}\n`);
    process.stdout.write(path.relative(process.cwd(), sel.path).replace(/\\/g, '/') + '\n');
  } else {
    process.stderr.write('  [plan-status] no active plan to audit\n');
  }
  process.exit(0); // selected or not, both normal
}

/**
 * Lint the Status vocabulary.
 *
 * `drift` mode (the pre-push default) gates ONLY on plans changed in the range
 * being pushed, matching on-conflict-lint.mjs's convention: a pre-existing bad
 * Status never blocks, a newly authored or edited one does. That distinction is
 * what makes this safe to turn on in a repo that already has violations — and
 * it keeps the gate proportional, so it can't decay into wallpaper the way an
 * always-red whole-tree warning would.
 *
 * Pre-existing violations are still REPORTED (advisory), because they are not
 * cosmetic: a non-conforming Status makes a plan invisible to `--select`, so it
 * can never be audited. That is exactly how a consumer's in-flight plan went
 * unauditable while two stale ones won the old mtime tiebreak (2026-07-19).
 *
 * @param {boolean} jsonOut
 * @param {boolean} drift gate on changed plans only
 */
function lintMode(jsonOut, drift = false) {
  const dir = path.resolve(PLANS_DIR);
  // The same enumeration and the same classification the selector uses (lib/plan-status.mjs): audit summaries are
  // excluded, non-files are skipped, symlinks are followed. A file the lint passes is a file the selector can read.
  // Drift mode judges what is being PUSHED, so it reads the pushed commit's plans (fleet 4146); whole-tree mode is the working tree.
  const pushed = drift ? pushedPlanFiles() : null;
  if (pushed === UNAVAILABLE) {
    console.error(`${R}plans:status${X} - the pushed commit's plans could not be read, so the push cannot be judged; not substituting the working tree`);
    process.exitCode = 1;
    return;
  }
  const files = pushed ?? listPlanFiles(dir);
  if (files === null) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: `cannot read ${PLANS_DIR}` }));
    else console.error(`${R}cannot read ${PLANS_DIR}${X}`);
    process.exitCode = 2;   // return, don't process.exit(): a piped stdout may not have flushed the envelope above
    return;
  }

  const flagged = [];
  for (const { name, abs, content } of files) {
    const s = parsePlanStatus(typeof content === 'string' ? content : fs.readFileSync(abs, 'utf8'));
    // Fails INVALID only: a correctly formatted terminal plan (Complete/Superseded) is valid and merely not selectable,
    // and a file with no status-shaped line is not a plan.
    if (classifyPlanStatus(s).validity !== 'invalid') continue;
    flagged.push({ file: `${PLANS_DIR}/${name}`, reason: s.reason, message: s.message });
  }

  // Split into what GATES and what is merely reported. In whole-tree mode every
  // finding gates (the source repo's `npm run check` contract is unchanged).
  // `changedFilesForPush()` returns null when git can't tell us; a missing
  // signal must never silently widen the gate to the whole tree, so drift mode
  // degrades to gating on NOTHING and says so.
  let gating = flagged, preExisting = [], driftBaseKnown = true;
  if (drift) {
    const changed = changedFilesForPush();
    if (changed === null) {
      driftBaseKnown = false;
      gating = [];
      preExisting = flagged;
    } else {
      const changedBases = new Set(changed.map(p => p.split(/[\\/]/).pop()));
      gating = flagged.filter(f => changedBases.has(f.file.split('/').pop()));
      preExisting = flagged.filter(f => !changedBases.has(f.file.split('/').pop()));
    }
  }

  if (jsonOut) {
    console.log(JSON.stringify({
      ok: gating.length === 0, mode: drift ? 'drift' : 'all',
      checked: files.length, flagged, gating, preExisting, driftBaseKnown,
    }, null, 2));
    process.exit(gating.length === 0 ? 0 : 1);
  }

  // Advisory: pre-existing violations are real (those plans can never be
  // audited) but they are not this push's fault, so they inform without gating.
  if (preExisting.length > 0) {
    console.error(`  ${Y}○${X} plans:status — ${preExisting.length} pre-existing non-conforming Status line(s), not gating this push: ${preExisting.map(f => f.file.split('/').pop()).join(', ')}`);
    console.error(`    ${D}Each is INVISIBLE to plan selection, so it can never be audited. Fix when you next touch it.${X}`);
  }
  if (drift && !driftBaseKnown) {
    console.error(`  ${Y}○${X} plans:status — no git range available; gating on nothing this run (reported ${flagged.length} finding(s) above).`);
  }

  if (gating.length === 0) {
    if (!drift) console.log(`${G}✓${X} plans:status — ${files.length} file(s), all Status lines conform (or are exempt).`);
    process.exit(0);
  }
  console.error(`\n${R}${B}✗ plans:status${X} — ${gating.length} non-conforming Status line(s)${drift ? ' in this push' : ''}:\n`);
  for (const f of gating) {
    console.error(`  ${R}${f.file}${X}  (${f.reason})${f.message ? `\n    ${D}${f.message}${X}` : ''}`);
  }
  console.error(`\n${D}Vocabulary: terminal Complete/Superseded · active Draft/Approved/In Progress.`);
  console.error(`A non-conforming Status makes the plan invisible to selection — it can never be audited.`);
  console.error(`Contract: docs/reference/reference-integrity.md / the plan's §2 status table.${X}\n`);
  process.exit(1);
}

/**
 * `--check-deps <plan-file>` — surface the plan's declared `Depends on:`
 * lines (f5ac366f) against the current on-disk status of each referenced
 * plan. Advisory ONLY: unlike `lintMode`, this never gates and always exits
 * 0 — whether an unmet dependency is safe to proceed past needs a human/agent
 * judgement call the file's Status line cannot make, so the point is making
 * the note visible before implementation starts, not blocking on it.
 *
 * @param {string} file
 */
function checkDepsMode(file) {
  if (!file) {
    process.stderr.write('  [plan-status] --check-deps requires a plan file path\n');
    process.exit(1);
  }
  const abs = path.resolve(file);
  let content;
  try { content = fs.readFileSync(abs, 'utf8'); }
  catch (err) {
    process.stderr.write(`  [plan-status] cannot read ${file}: ${err.message}\n`);
    process.exit(1);
  }
  const results = checkPlanDependencies(content, { plansDir: path.resolve(PLANS_DIR) });
  if (results.length === 0) {
    process.stderr.write(`  ${D}[plan-status] ${file} declares no cross-plan dependencies.${X}\n`);
    process.exit(0);
  }
  const unmet = results.filter((r) => r.outcome !== 'satisfied');
  for (const r of results) {
    const mark = r.outcome === 'satisfied' ? `${G}✓${X}` : `${Y}○${X}`;
    const statusNote = r.status ? ` (${r.status})` : '';
    const humanNote = r.note ? ` — ${r.note}` : '';
    process.stderr.write(`  ${mark} Depends on ${r.path}: ${r.outcome}${statusNote}${humanNote}\n`);
  }
  if (unmet.length > 0) {
    process.stderr.write(
      `\n  ${Y}${unmet.length} declared dependenc${unmet.length === 1 ? 'y is' : 'ies are'} not yet landed.${X} `
      + 'This is a nudge, not a gate — decide by hand whether it is still safe to proceed.\n',
    );
  }
  process.exit(0); // advisory only — never blocks
}

function main() {
  // Relocation smoke contract (AGENTS.md CLI_SMOKE_SET is CONSUMER-presence, so
  // this CLI is NOT in it — but the handler is free + correct; see R19/R22).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const argv = process.argv.slice(2);
  const selIdx = argv.indexOf('--select');
  if (selIdx >= 0) return selectMode(argv[selIdx + 1] ?? PLANS_DIR);
  const depsIdx = argv.indexOf('--check-deps');
  if (depsIdx >= 0) return checkDepsMode(argv[depsIdx + 1]);
  lintMode(
    argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json',
    argv.includes('--drift'),
  );
}

const isMain = isInvokedAsScript(import.meta.url);
if (isMain) main();
