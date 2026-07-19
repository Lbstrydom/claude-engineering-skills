#!/usr/bin/env node
/**
 * @fileoverview Deterministic commit helper for /ship — validates structured
 * provenance input, appends the AI-* trailer block, and performs the commit.
 * The LLM agent never formats trailers; it supplies values, this CLI
 * validates against a closed grammar and refuses on semantic ambiguity.
 *
 * Plan: docs/plans/provenance-trailers-and-gate-honesty.md §F1.
 * Convention doc: docs/reference/commit-provenance.md.
 *
 * Usage:
 *   node scripts/ship-commit.mjs --message-file <path> --skill <name> \
 *     --models <csv> --gate passed|waived|not-run [--no-run-id] \
 *     [--path <repo-relative-path> ...]
 *
 * `--path` (repeatable) scopes the commit to exactly those paths — git's
 * `--only` semantics: their WORKTREE contents are committed and every other
 * index entry is left alone. Use it when a second agent/session shares this
 * working tree: without it this CLI commits the whole index and would bundle
 * their in-flight staged work into your commit (field-found 2026-07-19). The
 * pre-existing alternative was a bare `git commit -- <paths>`, which scopes
 * correctly but silently loses the AI-* provenance trailers this CLI exists
 * to guarantee.
 *
 * Note the worktree/index asymmetry `--only` implies: if a named path is
 * staged at one version and modified further in the worktree, the WORKTREE
 * version is what lands.
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
  evaluateGateVerification,
  formatTrailerBlock,
  parseMessageTrailers,
} from './lib/commit-trailers.mjs';

const KNOWN_FLAGS = new Set(['--message-file', '--skill', '--models', '--gate', '--path']);
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
  let readableLayouts = 0;
  for (const dir of ['skills', path.join('.claude', 'skills')]) {
    const abs = path.join(repoRoot, dir);
    try {
      for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
        if (ent.isDirectory() && !ent.name.startsWith('.')) names.add(ent.name);
      }
      readableLayouts++;
    } catch (e) {
      // ENOENT = this layout simply isn't present (source vs consumer) —
      // expected. Anything else (EACCES, …) is operational: surfacing an
      // empty enum as a --skill rejection would mislead the agent (R3 M2).
      if (e?.code !== 'ENOENT') {
        err(`ship-commit: skill enum source unreadable (${e?.code}): ${abs}`);
        process.exit(1);
      }
    }
  }
  if (readableLayouts === 0) {
    err(`ship-commit: no skill layout found (neither skills/ nor .claude/skills/ under ${repoRoot}) — is this an audit-loop repo?`);
    process.exit(1);
  }
  return names;
}

async function main() {
  // CLI smoke contract — proves imports survived the scripts/.claude-skills
  // relocation. No git side effects.
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  // ---- arg parse (unknown flag = taxonomy row 1) -------------------------
  const argv = process.argv.slice(2);
  const opts = { noRunId: false, paths: [] };
  const inputErrors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-run-id') { opts.noRunId = true; continue; }
    if (KNOWN_FLAGS.has(a)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        inputErrors.push({ field: a, expected: 'a value after the flag', got: '', example: `${a} <value>` });
      } else if (a === '--path') {
        // Repeatable — collected, not last-wins. A comma-separated form was
        // rejected deliberately: paths may legally contain commas.
        opts.paths.push(v);
        i++;
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
  // R4 M1: T_head=0 is legal ONLY for the verified unborn-HEAD outcome — any
  // other git failure is operational (exit 1), never silently "fresh".
  const headExists = git(['rev-parse', '--verify', '--quiet', 'HEAD'], repoRoot);
  if (headExists.error) { err('ship-commit: git spawn failed'); process.exit(1); }
  // status 1 is rev-parse --quiet's DOCUMENTED missing-ref outcome (unborn
  // HEAD). Any other non-zero status is an operational failure — never a
  // silent T_head=0 (R5 H2).
  if (headExists.status !== 0 && headExists.status !== 1) {
    err(`ship-commit: git: HEAD verification failed (status ${headExists.status}): ${(headExists.stderr || '').trim()}`);
    process.exit(1);
  }
  let headCommitTs = 0;
  if (headExists.status === 0) {
    const head = git(['log', '-1', '--format=%ct'], repoRoot);
    const parsed = head.status === 0 ? Number(head.stdout.trim()) : NaN;
    if (!Number.isFinite(parsed) || parsed <= 0) {
      err(`ship-commit: git: cannot resolve HEAD committer time: ${(head.stderr || '').trim() || 'unparseable output'}`);
      process.exit(1);
    }
    headCommitTs = parsed;
  }
  const auditRunPath = path.join(repoRoot, '.audit', 'last-audit-run.json');
  const evidence = resolveEvidence({ auditRunPath, headCommitTs, noRunId: opts.noRunId });
  if (evidence.state === 'malformed') {
    // Row 10: environment state we must not guess about. --no-run-id opts out.
    err(`ship-commit: audit evidence unparseable: ${auditRunPath} (fix or pass --no-run-id)`);
    process.exit(1);
  }
  if (evidence.state === 'unreadable') {
    // Row 10b (R2 H2/H5): evidence exists but can't be read — refusing to
    // guess is the only honest option (treating it as absent would legalise
    // `not-run` while an audit record sits unreadable on disk).
    err(`ship-commit: audit evidence unreadable (${evidence.errno}): ${auditRunPath} (fix permissions or pass --no-run-id)`);
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

  // ---- verdict verification for "passed" (fail-closed; R1 H3/H5) ----------
  // Freshness proves an audit ran; only the store's convergence row proves it
  // passed. Store modules load lazily so the common paths (and --selfcheck-
  // relocation) never touch the db closure.
  if (values.gate === 'passed' && evidence.state === 'fresh') {
    let cloudEnabled = false;
    let convergence = null;
    try {
      const { isCloudEnabled } = await import('./lib/store/repo.mjs');
      cloudEnabled = await isCloudEnabled();
    } catch { /* genuinely unavailable (import/config) → the AUDIT_DB_URL-unset line */ }
    if (cloudEnabled) {
      try {
        const { getAuditRunConvergence } = await import('./lib/store/runs-findings.mjs');
        convergence = await getAuditRunConvergence(evidence.runId);
      } catch {
        // Query/connectivity failure with cloud CONFIGURED — keep
        // cloudEnabled=true so the diagnostic says "query failed", not
        // "AUDIT_DB_URL unset" (R2 M3). convergence stays null (fail-closed).
      }
    }
    const ver = evaluateGateVerification({ gate: values.gate, evidence, cloudEnabled, convergence });
    if (ver) {
      for (const line of renderAgentFixLines([ver])) err(line);
      process.exit(2);
    }
  }

  // ---- scope check (row 11) -----------------------------------------------
  // Two modes. Default: commit the INDEX, so "nothing staged" is the error.
  // With --path: commit ONLY the named paths (git's `--only` semantics), so
  // the index is irrelevant — what matters is that each named path actually
  // has something to commit. Deliberately distinct checks: reusing the staged
  // test under --path would reject a run whose paths are all unstaged-but-
  // modified, which is precisely the case the flag exists to serve.
  const pathspec = opts.paths;
  const usePathspec = pathspec.length > 0;
  // Untracked paths that we mark intent-to-add, so they can be rolled back if
  // the commit does not land (a failed run must not dirty a shared index).
  const intentAdded = [];
  let pathspecRollback = null;

  if (!usePathspec) {
    const staged = git(['diff', '--cached', '--quiet'], repoRoot);
    if (staged.error) { err('ship-commit: git spawn failed'); process.exit(1); }
    if (staged.status === 0) { err('ship-commit: nothing staged'); process.exit(1); }
  } else {
    // Rollback helper: a rejected run must leave the index exactly as found.
    // `git add -N` is the one index mutation this flag makes, and it is only
    // ever applied to paths the caller explicitly named.
    const rollback = () => { for (const rel of intentAdded) git(['reset', '-q', '--', rel], repoRoot); };
    const pathErrors = [];
    const rels = [];

    for (const p of pathspec) {
      // Containment: the same repo-root confinement the message file gets — a
      // pathspec escaping the repo is an input rejection, not a raw git error.
      const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(repoRoot, p);
      const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        pathErrors.push({
          field: '--path',
          custom: `AGENT FIX: --path ${p}: resolves outside the repository; pass a repo-relative path. Example: --path scripts/foo.mjs`,
        });
        continue;
      }
      if (!fs.existsSync(abs)) {
        pathErrors.push({
          field: '--path',
          custom: `AGENT FIX: --path ${p}: no such file. Example: --path scripts/foo.mjs`,
        });
        continue;
      }
      rels.push(rel);
      // Untracked → `git commit -- <path>` fails with "did not match any
      // file(s) known to git". Intent-to-add makes the path known WITHOUT
      // staging content, so no other session's data enters the index.
      const tracked = git(['ls-files', '--error-unmatch', '--', rel], repoRoot);
      if (tracked.status !== 0) {
        const added = git(['add', '-N', '--', rel], repoRoot);
        if (added.status !== 0) {
          rollback();
          err(`ship-commit: could not mark ${rel} intent-to-add: ${(added.stderr || '').trim()}`);
          process.exit(1);
        }
        intentAdded.push(rel);
      }
    }

    if (pathErrors.length === 0) {
      // Anything to commit? `diff HEAD` spans staged AND unstaged, which is
      // exactly what a pathspec commit takes.
      const dirty = git(['diff', 'HEAD', '--quiet', '--', ...rels], repoRoot);
      if (dirty.status === 0) {
        pathErrors.push({
          field: '--path',
          custom: `AGENT FIX: --path: the named path(s) have no changes to commit (${rels.join(', ')}). Edit or stage them first, or drop --path to commit the index. Example: --path scripts/foo.mjs`,
        });
      }
    }

    if (pathErrors.length > 0) {
      rollback();
      for (const line of renderAgentFixLines(pathErrors)) err(line);
      process.exit(2);
    }
    pathspecRollback = rollback;
  }

  // ---- compose + commit (input file stays immutable — Gemini G2) ----------
  const finalMessage = composeFinalMessage(messageText, values);
  const tmpDir = path.join(repoRoot, '.claude', 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const finalPath = path.join(tmpDir, `ship-commit-final-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(finalPath, finalMessage);
  // process.exit() skips `finally` blocks (R2 L1) — collect the outcome and
  // exit AFTER cleanup has run.
  let exitCode = 0;
  try {
    // --cleanup=whitespace: the default `strip` deletes `#`-prefixed lines,
    // and LLM-authored bodies legitimately use markdown headers (Gemini R2-G2).
    // With --path git switches to `--only` semantics: it commits the WORKTREE
    // contents of exactly these paths and leaves every other index entry
    // untouched. That is the whole point — a second session sharing this
    // working tree keeps its staged work, both out of this commit and still
    // staged afterwards.
    const commitArgs = ['commit', '-F', finalPath, '--cleanup=whitespace'];
    if (usePathspec) commitArgs.push('--', ...pathspec);
    const commit = git(commitArgs, repoRoot);
    if (commit.error) { err('ship-commit: git spawn failed'); exitCode = 1; }
    else if (commit.status !== 0) {
      if (pathspecRollback) pathspecRollback();
      err(`ship-commit: git commit failed:`);
      if (commit.stderr) process.stderr.write(commit.stderr);
      if (commit.stdout) process.stderr.write(commit.stdout);
      exitCode = 1;
    } else {
      // Post-commit integrity parse-back (R2 H3, tightened R3 H2): a
      // commit-msg hook or clean filter can rewrite the message after us —
      // parse the persisted message with git-trailer semantics (the same
      // parser as authoring) and require each expected key to appear EXACTLY
      // ONCE in the trailer BLOCK with the expected value. Substring matches
      // against body prose do not count.
      const persisted = git(['log', '-1', '--format=%B'], repoRoot);
      const expected = formatTrailerBlock(values);
      const parsed = persisted.status === 0 ? parseMessageTrailers(persisted.stdout) : { isTrailerBlock: false, trailers: [] };
      const missing = expected.filter((line) => {
        const [key, ...rest] = line.split(': ');
        const matches = parsed.trailers.filter((t) => t.key === key);
        return !(parsed.isTrailerBlock && matches.length === 1 && matches[0].value === rest.join(': '));
      });
      if (missing.length > 0) {
        err(`ship-commit: trailer integrity check failed — the committed message is missing: ${missing.join(' | ')} (a commit-msg hook may have rewritten it). The commit EXISTS but its provenance is incomplete.`);
        exitCode = 1;
      } else {
        const subject = finalMessage.split('\n', 1)[0];
        const trailerSummary = [`AI-Skill: ${values.skill}`, `AI-Gate: ${values.gate}`, values.runId ? `AI-Run-ID: ${values.runId}` : null].filter(Boolean).join(' · ');
        process.stdout.write(`ship-commit: committed "${subject}" (${trailerSummary})\n`);
      }
    }
  } finally {
    try { fs.unlinkSync(finalPath); } catch { /* best-effort cleanup */ }
  }
  process.exit(exitCode);
}

await main();
