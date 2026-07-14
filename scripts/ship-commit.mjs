#!/usr/bin/env node
/**
 * @fileoverview Deterministic commit helper for /ship — validates structured
 * provenance input, appends the AI-* trailer block, and performs the commit.
 * The LLM agent never formats trailers; it supplies values, this CLI
 * validates against a closed grammar and refuses on semantic ambiguity.
 *
 * Plan: docs/plans/provenance-trailers-and-gate-honesty.md §F1.
 * Convention doc: docs/commit-provenance.md.
 *
 * Usage:
 *   node scripts/ship-commit.mjs --message-file <path> --skill <name> \
 *     --models <csv> --gate passed|waived|not-run [--no-run-id]
 *
 * Exit contract (§F1.4 — the exhaustive taxonomy is the single source of
 * truth, asserted row-by-row in tests/ship-commit-cli.test.mjs):
 *   0 — trailers validated + appended, commit succeeded
 *   2 — agent-correctable input (AGENT FIX lines on stderr; NO commit attempted)
 *   1 — operational/repository failure (no commit, except hook-rejection row 13)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  validateTrailerInput,
  renderAgentFixLines,
  resolveEvidence,
  checkMessageFileSafety,
  messageFileError,
  composeFinalMessage,
} from './lib/commit-trailers.mjs';

const KNOWN_FLAGS = new Set(['--message-file', '--skill', '--models', '--gate']);
const KNOWN_BOOLEAN_FLAGS = new Set(['--no-run-id', '--selfcheck-relocation']);

function err(line) { process.stderr.write(`${line}\n`); }

function git(args, cwd) {
  return spawnSync('git', args, { cwd, encoding: 'utf-8', windowsHide: true });
}

/**
 * Union of skill names visible in this layout: source repo (`skills/`) and/or
 * consumer (`.claude/skills/`) — §F1.3c layout resolution.
 */
function resolveSkillNames(repoRoot) {
  const names = new Set();
  for (const dir of ['skills', path.join('.claude', 'skills')]) {
    const abs = path.join(repoRoot, dir);
    try {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) names.add(ent.name);
      }
    } catch { /* layout doesn't have this dir — fine */ }
  }
  return names;
}

function main() {
  // CLI smoke contract — proves imports survived the scripts/.claude-skills
  // relocation. No git side effects.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  // ---- arg parse (unknown flag = taxonomy row 1) -------------------------
  const argv = process.argv.slice(2);
  const opts = { noRunId: false };
  const inputErrors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-run-id') { opts.noRunId = true; continue; }
    if (KNOWN_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        inputErrors.push({ field: a, expected: 'a value after the flag', got: '', example: `${a} <value>` });
      } else {
        opts[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v;
        i++;
      }
      continue;
    }
    if (!KNOWN_BOOLEAN_FLAGS.has(a)) {
      inputErrors.push({
        field: a,
        custom: `AGENT FIX: ${a}: unknown flag; expected one of --message-file|--skill|--models|--gate|--no-run-id. Example: --gate passed`,
      });
    }
  }

  // ---- repo resolution (row 12) ------------------------------------------
  const top = git(['rev-parse', '--show-toplevel'], process.cwd());
  if (top.error) { err('ship-commit: git spawn failed'); process.exit(1); }
  if (top.status !== 0) { err(`ship-commit: git: ${(top.stderr || '').trim()}`); process.exit(1); }
  const repoRoot = top.stdout.trim();

  // ---- message file (rows 6/6b/7/9) ---------------------------------------
  let messageText = null;
  const mf = opts.messageFile;
  if (!mf) {
    inputErrors.push(messageFileError('missing', String(mf)));
  } else {
    const abs = path.isAbsolute(mf) ? mf : path.resolve(repoRoot, mf);
    if (!fs.existsSync(abs)) {
      // Row 6 (ENOENT) before the safety check — a merely-missing in-repo
      // path is agent-correctable, not a containment violation.
      inputErrors.push(messageFileError('missing', mf));
    } else {
      const safety = checkMessageFileSafety(mf, { repoRoot });
      if (safety) {
        inputErrors.push(messageFileError(safety.reason, mf));
      } else {
        try {
          messageText = fs.readFileSync(abs, 'utf-8');
        } catch (e) {
          // EACCES / EISDIR / … — operational, not agent-correctable (row 9).
          err(`ship-commit: message file unreadable: ${e.code}`);
          process.exit(1);
        }
        if (messageText !== null && messageText.trim() === '') {
          inputErrors.push(messageFileError('empty', mf));
          messageText = null;
        }
      }
    }
  }

  // ---- evidence (§F1.3b; unborn HEAD → T_head = 0, Gemini R2-G1) ----------
  const head = git(['log', '-1', '--format=%ct'], repoRoot);
  const headCommitTs = head.status === 0 ? Number(head.stdout.trim()) || 0 : 0;
  const auditRunPath = path.join(repoRoot, '.audit', 'last-audit-run.json');
  const evidence = resolveEvidence({ auditRunPath, headCommitTs, noRunId: opts.noRunId });
  if (evidence.state === 'malformed') {
    // Row 10: environment state we must not guess about. --no-run-id opts out.
    err(`ship-commit: audit evidence unparseable: ${auditRunPath} (fix or pass --no-run-id)`);
    process.exit(1);
  }

  // ---- semantic validation (rows 2-5, 8) ----------------------------------
  const skillNames = resolveSkillNames(repoRoot);
  const { ok, errors, values } = validateTrailerInput({
    skill: opts.skill,
    modelsRaw: opts.models,
    gate: opts.gate,
    messageText,
    evidence,
  }, { skillNames: [...skillNames] });

  const allErrors = [...inputErrors, ...errors];
  if (!ok || allErrors.length > 0) {
    for (const line of renderAgentFixLines(allErrors)) err(line);
    process.exit(2);
  }
  if (evidence.state === 'opted-out') {
    err('ship-commit: --no-run-id override — audit evidence ignored for this commit (declared unrelated)');
  }

  // ---- staged check (row 11) ----------------------------------------------
  const staged = git(['diff', '--cached', '--quiet'], repoRoot);
  if (staged.error) { err('ship-commit: git spawn failed'); process.exit(1); }
  if (staged.status === 0) { err('ship-commit: nothing staged'); process.exit(1); }

  // ---- compose + commit (input file stays immutable — Gemini G2) ----------
  const finalMessage = composeFinalMessage(messageText, values);
  const tmpDir = path.join(repoRoot, '.claude', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const finalPath = path.join(tmpDir, `ship-commit-final-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(finalPath, finalMessage);
  try {
    // --cleanup=whitespace: the default `strip` deletes `#`-prefixed lines,
    // and LLM-authored bodies legitimately use markdown headers (Gemini R2-G2).
    const commit = git(['commit', '-F', finalPath, '--cleanup=whitespace'], repoRoot);
    if (commit.error) { err('ship-commit: git spawn failed'); process.exit(1); }
    if (commit.status !== 0) {
      err(`ship-commit: git commit failed:`);
      if (commit.stderr) process.stderr.write(commit.stderr);
      if (commit.stdout) process.stderr.write(commit.stdout);
      process.exit(1);
    }
    const subject = finalMessage.split('\n', 1)[0];
    const trailerSummary = [`AI-Skill: ${values.skill}`, `AI-Gate: ${values.gate}`, values.runId ? `AI-Run-ID: ${values.runId}` : null].filter(Boolean).join(' · ');
    process.stdout.write(`ship-commit: committed "${subject}" (${trailerSummary})\n`);
  } finally {
    try { fs.unlinkSync(finalPath); } catch { /* best-effort cleanup */ }
  }
}

main();
