#!/usr/bin/env node
/**
 * @fileoverview `skills:check` member — validates every skill's
 * `gate-contract.json` against the shared policy (schema.mjs), so contract rot is a pre-push
 * failure, not a test-time surprise. Deliberately validate-don't-generate
 * (plan §F2.7): this does NOT write anything into SKILL.md.
 *
 * Exit codes: 0 = all contracts valid (uncontracted skills listed, not a
 * failure); 1 = at least one contract has a divergence.
 *
 * @module scripts/check-gate-contracts
 */

import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadGateContracts, formatSummaryLines } from './lib/gate-honesty/loader.mjs';
import { resolvePushRange, PUSH_RANGE_ENV } from './lib/push-range.mjs';
import {
  isCandidateLine, normalizeCandidateLine, findUndispositionedCandidates,
} from './lib/gate-honesty/verb-pattern.mjs';

/**
 * Parse a unified `git diff` into new/modified candidate lines per skill (D6).
 * PURE — the git call is separate — so the diff→candidate rules are testable
 * without a repo. Reads only `+` lines (added/modified-new) under
 * `skills/<name>/SKILL.md`, keeps the ones bearing an enforcement verb, and
 * normalises them for comparison against contract dispositions.
 *
 * @param {string} diffText
 * @returns {Array<{skill: string, line: string}>}
 */
export function parseChangedSkillCandidates(diffText) {
  const out = [];
  let skill = null;
  // Hunk-awareness (audit M3): a `+++ ` line is a FILE HEADER only in the
  // header block (before the first `@@`); INSIDE a hunk, an added content line
  // whose text starts with `++ ` also renders as `+++ …`. Distinguishing by
  // prefix alone would misread that content as a header and drop its candidate.
  // So headers are only interpreted while `inHunk` is false; content `+` lines
  // only while it is true.
  let inHunk = false;
  for (const raw of String(diffText).split('\n')) {
    if (raw.startsWith('diff --git ')) { skill = null; inHunk = false; continue; }
    if (!inHunk) {
      if (raw.startsWith('+++ ')) {
        const m = raw.match(/^\+\+\+ b\/skills\/([^/]+)\/SKILL\.md$/);
        skill = m ? m[1] : null;
        continue;
      }
      if (raw.startsWith('--- ')) continue;
    }
    if (raw.startsWith('@@')) { inHunk = true; continue; }
    if (inHunk && skill && raw.startsWith('+')) {
      const content = normalizeCandidateLine(raw.slice(1));
      if (content && isCandidateLine(content)) out.push({ skill, line: content });
    }
  }
  return out;
}

/**
 * Diff-scoped candidate-coverage check (D6). Resolves the push range, extracts
 * changed SKILL.md candidate lines, and flags any that a CONTRACTED skill has
 * not dispositioned. Returns divergence strings (empty = clean).
 *
 * Fail-open ONLY when unforced (sandbox-honesty rule + audit H1/M2/M3). A diff
 * gate that skips on a missing range would go green in a clean checkout having
 * read nothing — so an unresolvable range or a failed `git diff` degrades to a
 * loud SKIP by default (local `gates:check`), but is promoted to a hard
 * DIVERGENCE when `AUDIT_PUSH_RANGE_REQUIRED=1` — the flag the pre-push sandbox
 * sets, where the range MUST be resolvable. A skill with no contract is out of
 * scope here (its contract is forced by the Phase-D ratchet; D6 then keeps it
 * current).
 */
function checkCandidateCoverage({ repoRoot, contracted, warn }) {
  const required = (process.env[PUSH_RANGE_ENV.REQUIRED] ?? '').trim() === '1';
  const degrade = (msg) => {
    if (required) {
      return [`coverage-check: UNVERIFIABLE and ${PUSH_RANGE_ENV.REQUIRED}=1 — ${msg}. A diff gate that cannot scope must fail, not pass silently.`];
    }
    warn(`coverage-check: SKIPPED — ${msg}; candidate coverage UNVERIFIED this run (set ${PUSH_RANGE_ENV.REQUIRED}=1 to make this a hard failure)`);
    return [];
  };

  const range = resolvePushRange();
  if (!range.ok) return degrade(`could not resolve a diff range (${range.reason})`);
  let diffText;
  try {
    diffText = execFileSync('git', [
      // Pin the output format so the `b/`-prefix parser cannot be silently
      // defeated by a developer's ~/.gitconfig (Gemini G1): `diff.noprefix=true`
      // would emit `+++ skills/…`, the regex would miss, and the check would
      // pass having read nothing. `--no-ext-diff`/`--no-textconv` keep the body
      // mechanical too.
      '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
      'diff', '--no-ext-diff', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/',
      '--unified=0', `${range.base}`, `${range.head}`, '--', 'skills/*/SKILL.md',
    ], { cwd: repoRoot, encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    return degrade(`git diff failed (${e.message?.slice(0, 80)})`);
  }
  const changed = parseChangedSkillCandidates(diffText);
  if (changed.length === 0) return [];

  const contracts = new Map(contracted.map((c) => [c.skill, {
    stateds: c.gates.map((g) => g.stated).filter(Boolean),
    ignoredLines: (c.ignoredCandidates ?? []).map((ic) => normalizeCandidateLine(ic.line)),
  }]));

  return findUndispositionedCandidates(changed, contracts).map(
    (u) => `[${u.skill}] undispositioned enforcement-verb line — add a gate whose \`stated\` covers it, or an \`ignoredCandidates\` entry:\n      "${u.line}"`,
  );
}

function main() {
  // process.exitCode (not process.exit()) throughout: lets buffered
  // stdout/stderr writes drain naturally before the process terminates —
  // process.exit() can truncate output when stdout/stderr is a pipe (CI
  // logs, `| tee`) rather than a TTY.
  if (process.argv.includes('--selfcheck-relocation')) {
    console.log('OK');
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const skillsRoot = path.join(repoRoot, 'skills');
  const { contracted, uncontracted, divergences } = loadGateContracts({ skillsRoot, repoRoot });

  // D6 candidate-coverage — only meaningful once contracts validate, so run it
  // after the loader and fold its findings into the same failure gate.
  const coverage = divergences.length === 0
    ? checkCandidateCoverage({ repoRoot, contracted, warn: (m) => process.stderr.write(`  ${m}\n`) })
    : [];
  const allDivergences = [...divergences, ...coverage];

  if (allDivergences.length > 0) {
    process.stderr.write('check-gate-contracts: FAILED\n');
    for (const d of allDivergences) process.stderr.write(`  ${d}\n`);
    process.exitCode = 1;
    return;
  }

  const lines = formatSummaryLines({ contracted, uncontracted });
  process.stdout.write(`${lines.join('\n')}\n`);
}

// Only self-execute as a CLI, so `parseChangedSkillCandidates` (and any future
// export) stays importable by its tests without running the whole check.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
