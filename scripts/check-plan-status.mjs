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
import { parsePlanStatus, selectAuditPlan } from './lib/plan-status.mjs';
import { resolvePushRange } from './lib/push-range.mjs';

const PLANS_DIR = 'docs/plans';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// `*-audit-summary.md` is exempt from the vocabulary lint — docs/README.md
// mandates its free-text convergence sentence ("Audit-complete. 17 fixes applied.").
// `[\w-]+` (not `\w+`) so a hyphenated suffix (`…-audit-summary-phase-1.md`) is
// still exempted (consolidated Gemini gate round-2 G2).
const isAuditSummary = name => /-audit-summary(?:-[\w-]+)?\.md$/.test(name);

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
    return r.status === 0 ? r.stdout.trim() : null;
  };
  // The range comes from the shared push-range contract, which prefers what the
  // pre-push hook was told by git over anything inferred here. The old inline
  // `@{upstream} ?? HEAD~1` scoped a multi-commit push to its tip, and resolved
  // to HEAD~1 unconditionally in a detached checkout. See lib/push-range.mjs.
  const range = resolvePushRange({ run: rev });
  if (!range.ok) return null;
  const out = rev(['diff', '--name-only', `${range.base}..${range.head}`]);
  if (out === null) return null;
  return out.split('\n').map(s => s.trim()).filter(Boolean);
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
  const sel = selectAuditPlan(abs, {
    warn: m => process.stderr.write(`  [plan-status] ${m}\n`),
    changedFiles,
  });
  if (sel) {
    if (sel.boundBy) process.stderr.write(`  [plan-status] selected via ${sel.boundBy}\n`);
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
  let names;
  try { names = fs.readdirSync(dir).filter(n => n.endsWith('.md')); }
  catch (err) {
    if (jsonOut) console.log(JSON.stringify({ ok: false, error: `cannot read ${PLANS_DIR}: ${err.message}` }));
    else console.error(`${R}cannot read ${PLANS_DIR}: ${err.message}${X}`);
    process.exit(2);
  }

  const flagged = [];
  for (const name of names) {
    if (isAuditSummary(name)) continue;                 // exempt
    const abs = path.join(dir, name);
    // A subdirectory named `*.md` would EISDIR on readFileSync (G1) — skip
    // non-files. Shallow, like selection.
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    const content = fs.readFileSync(abs, 'utf8');
    const s = parsePlanStatus(content);
    if (s.ok) continue;
    if (s.reason === 'absent') continue;                // not a plan; not a failure
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
      checked: names.length, flagged, gating, preExisting, driftBaseKnown,
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
    if (!drift) console.log(`${G}✓${X} plans:status — ${names.length} file(s), all Status lines conform (or are exempt).`);
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

function main() {
  // Relocation smoke contract (AGENTS.md CLI_SMOKE_SET is CONSUMER-presence, so
  // this CLI is NOT in it — but the handler is free + correct; see R19/R22).
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const argv = process.argv.slice(2);
  const selIdx = argv.indexOf('--select');
  if (selIdx >= 0) return selectMode(argv[selIdx + 1] ?? PLANS_DIR);
  lintMode(
    argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json',
    argv.includes('--drift'),
  );
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) main();
