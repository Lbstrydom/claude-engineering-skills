#!/usr/bin/env node
/**
 * @fileoverview Thin CLI over lib/plan-status.mjs. Two modes:
 *   --select <dir>  — print the one plan the pre-push hook should audit (or nothing).
 *   (default)       — the vocabulary lint: fail on any non-conforming Status line.
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
import { parsePlanStatus, selectAuditPlan } from './lib/plan-status.mjs';

const PLANS_DIR = 'docs/plans';
const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

// `*-audit-summary.md` is exempt from the vocabulary lint — docs/README.md
// mandates its free-text convergence sentence ("Audit-complete. 17 fixes applied.").
// `[\w-]+` (not `\w+`) so a hyphenated suffix (`…-audit-summary-phase-1.md`) is
// still exempted (consolidated Gemini gate round-2 G2).
const isAuditSummary = name => /-audit-summary(?:-[\w-]+)?\.md$/.test(name);

function selectMode(dir) {
  const abs = path.resolve(dir);
  const sel = selectAuditPlan(abs, { warn: m => process.stderr.write(`  [plan-status] ${m}\n`) });
  if (sel) process.stdout.write(path.relative(process.cwd(), sel.path).replace(/\\/g, '/') + '\n');
  else process.stderr.write('  [plan-status] no active plan to audit\n');
  process.exit(0); // selected or not, both normal
}

function lintMode(jsonOut) {
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

  if (jsonOut) {
    console.log(JSON.stringify({ ok: flagged.length === 0, checked: names.length, flagged }, null, 2));
    process.exit(flagged.length === 0 ? 0 : 1);
  }

  if (flagged.length === 0) {
    console.log(`${G}✓${X} plans:status — ${names.length} file(s), all Status lines conform (or are exempt).`);
    process.exit(0);
  }
  console.error(`\n${R}${B}✗ plans:status${X} — ${flagged.length} non-conforming Status line(s):\n`);
  for (const f of flagged) {
    console.error(`  ${R}${f.file}${X}  (${f.reason})${f.message ? `\n    ${D}${f.message}${X}` : ''}`);
  }
  console.error(`\n${D}Vocabulary: terminal Complete/Superseded · active Draft/Approved/In Progress.`);
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
  lintMode(argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json');
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) main();
