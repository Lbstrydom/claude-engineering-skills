#!/usr/bin/env node
/**
 * @fileoverview Drift-only ratchet over the size of skill markdown.
 *
 * **Why it exists.** AGENTS.md has a hard character cap (`context:check`); skills
 * capped only the `description` (1024 chars) and the reference-index summaries
 * (120 chars). The "SKILL.md ≤3K tokens" target in
 * `docs/reference/skill-reference-format.md` was prose nothing enforced, so skill
 * markdown grew by accretion: measured 2026-10-14, 13 of 17 SKILL.md files sit
 * over the 12,000-char (≈3K-token) target and `skills/fleet/references/coordination.md`
 * grew twice in a single day.
 *
 * **Why drift-only, not an absolute cap.** Thirteen SKILL.md files are already over
 * the limit; a gate that fails on all of them fails on the first push and teaches
 * `--no-verify`. So this mirrors `file-size-ratchet.mjs`: a committed baseline, a
 * non-zero exit only for drift, and a shrink that nobody re-baselined FAILS too
 * (otherwise the baseline stays pinned at each file's historical high-water mark).
 * The decision core is shared: `scripts/lib/size-ratchet.mjs`.
 *
 * **The hard ceiling falls out of the same rule.** A governed file that is under
 * the limit is not baselined, so crossing it reports `NEW>LIMIT`.
 *
 * **What is governed.** Every `*.md` at any depth under `skills/` (the authoritative
 * `SKILL.md`, `references/**` and `examples/**`) plus the canonical shared
 * references under `docs/audit/shared-references/`. NEVER `.claude/skills/**`
 * (generated) and NEVER the generated copies of the shared references that live
 * under `skills/*\/references/` — those are `findSyncTargets()`'s targets, so one
 * growth would otherwise fail ten times over and a generated file would be judged
 * as if authored. A symbolic link anywhere in a governed tree FAILS the run: the
 * gate can neither measure it honestly nor ignore it.
 *
 * Unit: characters of the LF-canonical decoded text (the same unit as the AGENTS.md
 * cap), with `≈tokens = ceil(chars/4)` printed for orientation.
 *
 * Usage:
 *   node scripts/skill-size-ratchet.mjs                  # gate
 *   node scripts/skill-size-ratchet.mjs --report         # report-only, exit 0
 *   node scripts/skill-size-ratchet.mjs --update-baseline
 *
 * Plan: docs/plans/skill-markdown-size-ratchet.md
 *
 * @module scripts/skill-size-ratchet
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, finishAndExit } from './lib/cli-io.mjs';
import { atomicWriteFileSync, canonicalizeEol } from './lib/file-io.mjs';
import { isInvokedAsScript } from './lib/cli-entry.mjs';
import { diffAgainstBaseline as diffSizes, updatedBaseline, readBaselineState } from './lib/size-ratchet.mjs';
import { findSyncTargets } from './sync-shared-audit-refs.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_BASELINE = '.skill-size-baseline.json';

/** A governed file at or above this many characters is baselined (≈3K tokens at 4 chars/token). */
export const LIMIT_CHARS = 12000;

/** Growth/shrink under this many characters (about two lines of prose) is noise, not a ratchet event. */
export const TOLERANCE_CHARS = 200;

/** The governed roots, repo-relative. */
export const GOVERNED_ROOTS = Object.freeze(['skills', 'docs/audit/shared-references']);

/** The phrase every growth-type failure prints; the poison pill matches it. */
export const GROWTH_PHRASE = 'skill markdown may not grow';

export const estimateTokens = (chars) => Math.ceil(chars / 4);

const toRel = (repoRoot, abs) => path.relative(repoRoot, abs).replace(/\\/g, '/');

/** Characters of the LF-canonical decoded text of a file. */
export function charCount(absPath) {
  return canonicalizeEol(fs.readFileSync(absPath)).toString('utf8').length;
}

/**
 * Every governed file's current size in characters, filtered to those at or
 * above the limit, as a sorted plain object.
 *
 * Fails closed (throws): an unreadable governed root or nested directory, or ANY
 * symbolic link met on the walk. ENOENT on a NESTED directory is the one benign
 * case (a concurrent clean can remove one mid-walk); ENOENT on a declared root is
 * not, since a missing root means the gate would report "no growth" for files it
 * never inspected.
 *
 * @param {string} [repoRoot]
 * @param {{ roots?: readonly string[], limit?: number }} [opts]
 * @returns {Record<string, number>}
 */
export function collectSkillSizes(repoRoot = REPO, { roots = GOVERNED_ROOTS, limit = LIMIT_CHARS } = {}) {
  // The generated copies of the shared references are derived, not authored.
  const generated = new Set(
    findSyncTargets(repoRoot).map((p) => toRel(repoRoot, p.target).toLowerCase()),
  );
  const out = {};
  const walk = (dir, isRoot) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (isRoot || err.code !== 'ENOENT') {
        throw new Error(`cannot read ${isRoot ? 'governed root' : 'directory'} ${toRel(repoRoot, dir) || dir}: ${err.message}`);
      }
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      // Checked BEFORE isDirectory()/isFile(): a Dirent link is neither, so a
      // walker that only tests those two skips it silently.
      if (e.isSymbolicLink()) {
        throw new Error(`symbolic link in a governed tree: ${toRel(repoRoot, full)} — the gate cannot measure it honestly or ignore it; replace it with a real file or directory`);
      }
      if (e.isDirectory()) { walk(full, false); continue; }
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const rel = toRel(repoRoot, full);
      if (generated.has(rel.toLowerCase())) continue;
      const chars = charCount(full);
      if (chars >= limit) out[rel] = chars;
    }
  };
  for (const r of roots) {
    const abs = path.join(repoRoot, r);
    // lstat the ROOT itself: readdirSync would silently follow a symlinked root.
    let st;
    try { st = fs.lstatSync(abs); } catch (err) {
      throw new Error(`cannot read governed root ${r}: ${err.message}`);
    }
    if (st.isSymbolicLink()) {
      throw new Error(`symbolic link in a governed tree: ${r} — the gate cannot measure it honestly or ignore it`);
    }
    walk(abs, true);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Bind the character tolerance; the decision core is the shared one. */
export function diffAgainstBaseline(current, baseline, tolerance = TOLERANCE_CHARS) {
  return diffSizes(current, baseline, tolerance);
}

const fmt = (n) => `${n.toLocaleString('en-US')} chars (≈${estimateTokens(n).toLocaleString('en-US')} tokens)`;

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); await finishAndExit(0); return; }

  try {
    assertKnownFlags(process.argv, ['--report', '--update-baseline', '--baseline', '--help', '-h', '--selfcheck-relocation'], { cli: 'skill-size-ratchet' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); await finishAndExit(2); return; }
    throw err;
  }
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(`Usage: node scripts/skill-size-ratchet.mjs [options]

Drift-only ratchet over skill markdown (skills/**/*.md and the canonical
docs/audit/shared-references/**/*.md). A file at or above ${LIMIT_CHARS} chars (about 3K tokens)
is baselined and may not grow; a file under the limit may not cross it; an
improvement must be locked in so the baseline does not stay at the old high-water mark.

Options:
  --report              Report findings, always exit 0
  --update-baseline     Re-baseline deliberately. No baseline yet: bootstrap every
                        over-limit file. Valid baseline: ratchet DOWN only, never
                        admit growth or a new file. Invalid baseline: refuse.
  --baseline <path>     Baseline file (default: ${DEFAULT_BASELINE})
  --help                Show this message

Exit codes: 0=clean, 1=drift or an unmeasurable tree, 2=no/invalid baseline or bad flag
`);
    await finishAndExit(0); return;
  }
  const i = process.argv.findIndex((a) => a === '--baseline' || a.startsWith('--baseline='));
  // A valueless or flag-followed --baseline must not silently gate against the default.
  if (i !== -1 && process.argv[i] === '--baseline'
      && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('-'))) {
    process.stderr.write('skill-size-ratchet: --baseline requires a path.\n');
    await finishAndExit(2); return;
  }
  const baselinePath = path.resolve(REPO, argOption('baseline', DEFAULT_BASELINE));
  const reportOnly = process.argv.includes('--report');
  const update = process.argv.includes('--update-baseline');

  let current;
  try {
    current = collectSkillSizes();
  } catch (err) {
    // An unmeasurable tree is a FAILURE, never "no growth".
    process.stderr.write(`skill-size-ratchet: cannot measure the governed tree — ${err.message}\n`);
    await finishAndExit(reportOnly ? 0 : 1); return;
  }

  if (update) {
    const state = readBaselineState(baselinePath);
    if (state.kind === 'invalid') {
      process.stderr.write(`skill-size-ratchet: refusing --update-baseline — the baseline at ${path.relative(REPO, baselinePath)} exists but is invalid (${state.reason}). Fix or delete it deliberately; nothing was written.\n`);
      await finishAndExit(2); return;
    }
    const prior = state.kind === 'ok' ? state.files : null;
    const files = updatedBaseline(current, prior);
    atomicWriteFileSync(baselinePath, `${JSON.stringify({
      _description: 'Character counts for skill markdown already at or over the size limit. Drift-only ratchet: '
        + 'see scripts/skill-size-ratchet.mjs. Regenerate deliberately with --update-baseline (ratchets down only).',
      limitChars: LIMIT_CHARS,
      toleranceChars: TOLERANCE_CHARS,
      files,
    }, null, 2)}\n`, 'utf-8');
    process.stdout.write(`skill-size-ratchet: baseline updated (${prior ? 'ratchet-down only' : 'bootstrap'}) — ${Object.keys(files).length} file(s) baselined.\n`);
    const { grew, newOver } = prior ? diffAgainstBaseline(current, files) : { grew: [], newOver: [] };
    for (const g of [...grew, ...newOver]) {
      process.stdout.write(`  NOT absorbed: ${g.file} (${g.now ?? g.size} chars) — move detail into references/, or hand-edit its entry in a reviewed commit.\n`);
    }
    await finishAndExit(0); return;
  }

  const baselineState = readBaselineState(baselinePath);
  const baseline = baselineState.kind === 'ok' ? baselineState.files : null;
  if (baseline === null) {
    // Fail closed: "cannot say" must never render as "clean". An INVALID baseline
    // is named as such; "run --update-baseline" would be the wrong advice for it.
    process.stderr.write(baselineState.kind === 'invalid'
      ? `skill-size-ratchet: the baseline at ${path.relative(REPO, baselinePath)} is invalid (${baselineState.reason}) — fix it by hand; --update-baseline refuses to overwrite it.\n`
      : `skill-size-ratchet: no baseline at ${path.relative(REPO, baselinePath)} — run --update-baseline to create it.\n`);
    await finishAndExit(reportOnly ? 0 : 2); return;
  }

  const { grew, newOver, shrank, dropped } = diffAgainstBaseline(current, baseline);
  const lines = [];
  for (const g of grew) lines.push(`  GREW      ${g.file}: ${g.was} → ${g.now} (+${g.now - g.was}) ${fmt(g.now)}`);
  for (const n of newOver) lines.push(`  NEW>LIMIT ${n.file}: ${fmt(n.size)} (limit ${LIMIT_CHARS})`);
  for (const s of shrank) lines.push(`  SHRANK    ${s.file}: ${s.was} → ${s.now} (−${s.was - s.now}) — lock it in`);
  for (const d of dropped) lines.push(`  DROPPED   ${d.file}: was ${d.was}, now under the limit — remove from baseline`);

  if (lines.length === 0) {
    process.stdout.write(`skill-size-ratchet: clean — ${Object.keys(baseline).length} file(s) baselined, none grew.\n`);
    await finishAndExit(0); return;
  }

  process.stdout.write(`skill-size-ratchet: ${lines.length} change(s)\n${lines.join('\n')}\n\n`);
  if (grew.length || newOver.length) {
    process.stdout.write(`  Rule: ${GROWTH_PHRASE} past ${LIMIT_CHARS} chars (about 3K tokens), and a file already over it may not grow.\n`
      + '  Move detail into references/<topic>.md (progressive disclosure, docs/reference/skill-reference-format.md),\n'
      + '  or justify it and hand-edit the baseline entry in a reviewed commit\n'
      + '  (--update-baseline only ratchets down, so it never absorbs growth).\n');
  }
  if (shrank.length || dropped.length) {
    process.stdout.write('  Improvements must be locked in, or the ratchet stays at the old high-water mark:\n');
    process.stdout.write('    npm run skills:size:gate -- --update-baseline\n');
  }
  await finishAndExit(reportOnly ? 0 : 1);
}

if (isInvokedAsScript(import.meta.url)) {
  await main();
}
