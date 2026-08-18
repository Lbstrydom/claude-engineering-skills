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
 * `--message-file -` reads the message from stdin, so a heredoc works and no
 * temp file is left behind. NOT `/dev/stdin`: Git-Bash resolves it to
 * `/proc/self/fd/0`, which is not a regular file and fails the existence check.
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
  resolveExpectedIdentity,
  verifyHeadIdentity,
  readActualIdentity,
  classifyStagedScope,
  makeGitRunner,
  sampleDirectoryEntries,
} from './lib/worktree-identity.mjs';
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

const KNOWN_FLAGS = new Set([
  '--message-file', '--skill', '--models', '--gate', '--path',
  '--expect-head', '--expect-branch',
]);
const KNOWN_BOOLEAN_FLAGS = new Set([
  '--no-run-id', '--no-tests', '--selfcheck-relocation', '--expect-detached',
  '--check-migrations',
]);

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
  //
  // MUTUALLY EXCLUSIVE, not a presence check. A bare `argv.includes(...)` means
  // any invocation that happens to carry the flag exits 0 having committed
  // NOTHING — a silent success, in the one binary whose entire purpose is now to
  // refuse rather than quietly do the wrong thing. `/ship` reads exit 0 as
  // "committed" and would push. Standalone behaviour is unchanged, so the
  // relocation smoke test still passes exactly as before.
  if (process.argv.includes('--selfcheck-relocation')) {
    const others = process.argv.slice(2).filter((a) => a !== '--selfcheck-relocation');
    if (others.length > 0) {
      err(
        'AGENT FIX: --selfcheck-relocation: a standalone smoke check that commits nothing; '
        + `it cannot be combined with commit arguments (also given: ${others.join(' ')}). `
        + 'Run it alone, or drop it to perform a real commit.',
      );
      process.exit(2);
    }
    console.log('OK');
    process.exit(0);
  }

  // Read-only preflight for the migration realization gate below — same
  // mutual-exclusivity contract as --selfcheck-relocation (a standalone check
  // that commits nothing must not be combined with commit arguments, or a
  // caller could misread "the check passed" as "the commit happened").
  //
  // Exists so /ship can surface an unapplied-migration block during Step 0.5,
  // BEFORE the doc-update and pre-push-hook work that follows it — not just at
  // Step 6.3, after that work is already done. The gate itself stays enforced
  // ONLY in the commit path below: a SKILL step is an instruction to an agent
  // and cannot block, so this flag is advisory-early, not a second gate.
  if (process.argv.includes('--check-migrations')) {
    const others = process.argv.slice(2).filter((a) => a !== '--check-migrations');
    if (others.length > 0) {
      err(
        'AGENT FIX: --check-migrations: a standalone read-only preflight that commits nothing; '
        + `it cannot be combined with commit arguments (also given: ${others.join(' ')}). `
        + 'Run it alone.',
      );
      process.exit(2);
    }
    const top = git(['rev-parse', '--show-toplevel'], process.cwd());
    if (top.error) { err('ship-commit: git spawn failed'); process.exit(1); }
    if (top.status !== 0) { err(`ship-commit: git: ${(top.stderr || '').trim()}`); process.exit(1); }
    const repoRoot = top.stdout.trim();
    const realization = await checkMigrationRealization(repoRoot);
    if (realization.behind) {
      err(formatMigrationBlockLine(realization));
      process.exit(2);
    }
    console.log(`ship-commit: migrations realized (${realization.reason}).`);
    process.exit(0);
  }

  // ---- arg parse (unknown flag = taxonomy row 1) -------------------------
  const argv = process.argv.slice(2);
  const opts = { noRunId: false, noTests: false, expectDetached: false, paths: [] };
  const inputErrors = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-run-id') { opts.noRunId = true; continue; }
    if (a === '--no-tests') { opts.noTests = true; continue; }
    if (a === '--expect-detached') { opts.expectDetached = true; continue; }
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
        custom: `AGENT FIX: ${a}: unknown flag; expected one of --message-file|--skill|--models|--gate|--path|--expect-head|--expect-branch|--expect-detached|--no-run-id|--no-tests. Example: --gate passed`,
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
  } else if (mf === '-') {
    // `-` reads the message from stdin, so a heredoc satisfies the skill's
    // "write it to a file, never -m" rule without leaving a file behind.
    // Upstream 575256de asked for this via `/dev/stdin`, which cannot work on
    // the containment path below: Git-Bash resolves it to `/proc/self/fd/0`,
    // which is not a regular file, so `existsSync` is false and it reported as
    // a merely-missing path. `-` is the portable spelling and needs no
    // filesystem at all.
    //
    // It also removes the reason temp files accumulate: `.claude/tmp` held 658
    // of them (39MB) when this landed, largely one-shot commit messages.
    //
    // No safety check, and that is not a gap: `checkMessageFileSafety` exists
    // to stop a path argument being pointed at a file the caller never intended
    // to read (a key, something outside the repo). Piped bytes were already in
    // the caller's hands — there is no path to traverse and no new egress.
    try {
      messageText = fs.readFileSync(0, 'utf-8');
    } catch (e) {
      err(`ship-commit: could not read the commit message from stdin: ${e.code}`);
      process.exit(1);
    }
    if (messageText.trim() === '') {
      // Same disposition as an empty file, including when nothing was piped at
      // all — an empty commit message is the failure either way, and saying
      // "empty" beats a hang or a blank commit.
      inputErrors.push(messageFileError('empty', 'stdin'));
      messageText = null;
    }
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
  const gitRun = makeGitRunner(repoRoot);
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

  // ---- Guard B: worktree identity is a PRECONDITION, not a diagnostic -----
  //
  // Runs BEFORE the index is inspected or touched. Absence of an expectation is
  // a refusal, not a log line: an optional safety input whose omission passes is
  // not a safety gate (INC-002's lesson, and the shape of the arch-memory bands
  // that fired zero times in 1,763 consultations).
  //
  // The expectation is an ATOMIC bundle {head, ref}. A head-only check passes
  // whenever two refs sit on the same commit — a feature branch freshly cut from
  // `main` is exactly that — and the commit then lands on the wrong branch,
  // which is the field incident this guard exists to prevent.
  //
  // Unborn HEAD is the one documented skip: there is no HEAD to bind to.
  let verifiedIdentity = null;
  if (headExists.status === 0) {
    const expectation = resolveExpectedIdentity({
      flags: {
        expectHead: opts.expectHead,
        expectBranch: opts.expectBranch,
        expectDetached: opts.expectDetached,
      },
      evidence,
    });
    if (!expectation.ok) {
      const actual = readActualIdentity({ run: gitRun });
      const nowHead = actual.ok ? actual.identity.head : '<unresolvable>';
      const nowRef = actual.ok && actual.identity.ref.kind === 'attached'
        ? `--expect-branch ${actual.identity.ref.name}`
        : '--expect-detached';
      err(
        `AGENT FIX: --expect-head: ${expectation.reason}`
        + `${expectation.detail ? ` — ${expectation.detail}` : ''}. `
        + 'Capture the worktree identity when the operation starts and pass it here, so a concurrent '
        + `checkout or amend cannot land this commit on a different base. Example: --expect-head ${nowHead} ${nowRef}`,
      );
      process.exit(2);
    }
    const verdict = verifyHeadIdentity(expectation.identity, { run: gitRun });
    if (!verdict.ok) {
      const exp = expectation.identity;
      const act = verdict.actual;
      const nameOf = (r) => (r && r.kind === 'attached' ? r.name : '(detached)');
      err(
        `AGENT FIX: --expect-head: ${verdict.reason} — the worktree is not the one this operation started in. `
        + `Expected ${exp.head.slice(0, 12)} on ${nameOf(exp.ref)}; `
        + `found ${act ? act.head.slice(0, 12) : '<unresolvable>'} on ${nameOf(act && act.ref)}. `
        + 'If you moved deliberately, re-verify what you are shipping and re-pass the new identity.',
      );
      process.exit(2);
    }
    verifiedIdentity = expectation.identity;
    // Guard D — announce. Emitted on EVERY verified run so the guard's presence
    // is visible rather than inferred. There is deliberately no `unverified`
    // outcome: that state is an exit 2 above, because a diagnostic everyone
    // reads as protection is the defect, not the fix.
    err(
      `  [worktree] identity verified (source: ${expectation.source}) — `
      + `${verifiedIdentity.head.slice(0, 12)} on `
      + `${verifiedIdentity.ref.kind === 'attached' ? verifiedIdentity.ref.name : '(detached)'}`,
    );
  } else {
    err('  [worktree] identity check skipped — unborn HEAD (no commit to bind to)');
  }

  // ---- --no-tests: the sanctioned override (feedback 2026-07-19 item 5) ---
  // The skill documented this flag but the parser rejected it and the commit
  // carried no `--no-verify`, so the escape hatch could not actually be taken.
  // That is worse than having no override: an operator who has verified a
  // failure is environmental is left with "retry until lucky" or "move the hook
  // aside" — i.e. a gate with no sanctioned override manufactures gate-tampering.
  //
  // An auditable override beats one people route around, so this is deliberately
  // LOUD and it can only ever DOWNGRADE the gate claim. It never forces `waived`
  // unconditionally: `waived` means "a verdict existed and I shipped past it",
  // which requires fresh evidence. Skipping hooks does not manufacture a verdict
  // to waive — with no evidence the truthful label is `not-run`.
  if (opts.noTests) {
    const capped = evidence.state === 'fresh' ? 'waived' : 'not-run';
    if (opts.gate && opts.gate !== capped) {
      err(`ship-commit: --no-tests caps AI-Gate at "${capped}" (was: ${opts.gate}) — hooks are being skipped, so a stronger verdict cannot be claimed`);
    }
    opts.gate = capped;
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
    // ---- E1: resolve the tree this commit will actually produce -----------
    // `passed` binds to WHAT was audited, not just to when, so the verifier
    // needs the committed content's identity. Two cases, and the second is a
    // deliberate refusal rather than an omission:
    //
    //   default (commit the index) → `git write-tree` IS the tree git is about
    //     to record, so it is exactly the right comparand.
    //   --path (commit only named paths) → the resulting tree is HEAD's tree
    //     with those paths overlaid, NOT the index tree. Comparing the index
    //     here would be a FALSE PASS: an operator could stage the whole audited
    //     worktree (index tree matches), then commit a subset via --path and
    //     still be told the content was audited. A whole-worktree audit does
    //     not cover a partial commit, so leave the comparand null and let
    //     evaluateGateVerification refuse — the honest answer.
    //
    // Adjacency decision (audit R1 HIGH, resolved): this resolution is
    // deliberately INSIDE the `passed && fresh` branch, not hoisted. The value
    // is consumed only by evaluateGateVerification, which no-ops unless the
    // gate is `passed` and the evidence is `fresh` — the very condition above.
    // Hoisting would spawn a `git write-tree` subprocess on every commit,
    // including docs-only `not-run` ships, for a value nothing else reads.
    // The tree this commit will actually carry.
    //
    // Guard A makes `--path` mandatory, so the old "index tree, but only when
    // unscoped" rule would have left `committedTree` null on EVERY run and made
    // `--gate passed` structurally unreachable — the exact defect this repo
    // already fixed once (the marker had four readers and zero writers). A gate
    // value that cannot be earned is worse than no gate value: it silently
    // understates the rigor behind a change.
    //
    // Under `--only`, git builds the commit from HEAD's tree with the named
    // paths' WORKTREE contents applied. That is reproducible here in a private
    // index, so the comparison stays honest rather than being skipped: a partial
    // commit of an audited worktree yields a DIFFERENT tree and is still
    // correctly refused — which is the property the old null-skip was protecting.
    //
    // Both branches delegate to lib/vcs.mjs, which owns every private-index
    // dance in this repo. The `--path` branch used to inline its own, deriving
    // the index as `<repoRoot>/.git/<name>` — correct only in a MAIN checkout.
    // In a linked worktree `.git` is a `gitdir:` pointer FILE, so `read-tree`
    // could not even create its lockfile, `committedTree` stayed null, and the
    // refusal below fired on EVERY worktree commit: `passed` was unreachable
    // there, which is precisely the "gate value that cannot be earned" defect
    // the comment above warns about, recurring 14 lines below it. Keeping the
    // plumbing in the seam is what stops a fourth copy getting it wrong again.
    let committedTree = null;
    let treeErr = null;
    if (opts.paths.length === 0) {
      const { gitIndexTree } = await import('./lib/vcs.mjs');
      const treeRes = gitIndexTree(repoRoot);
      committedTree = treeRes.ok ? treeRes.tree : null;
      if (!treeRes.ok) treeErr = treeRes.error;
    } else {
      const { gitPathspecTree } = await import('./lib/vcs.mjs');
      const treeRes = gitPathspecTree(repoRoot, opts.paths);
      // A failure still leaves committedTree null, which refuses `passed` and
      // points at `waived` — the fail-closed direction, unchanged. What changes
      // is that the cause is no longer swallowed: the bug above survived because
      // an unresolvable tree and a mismatched one produced the same silence.
      committedTree = treeRes.ok ? treeRes.tree : null;
      if (!treeRes.ok) treeErr = treeRes.error;
    }
    if (treeErr) err(`ship-commit: could not resolve the tree being committed (${treeErr.code}): ${treeErr.message}`);
    const ver = evaluateGateVerification({ gate: values.gate, evidence, cloudEnabled, convergence, committedTree });
    if (ver) {
      for (const line of renderAgentFixLines([ver])) err(line);
      process.exit(2);
    }
    // Verification ACCEPTED. Persist the value that was actually compared, so
    // the claim is re-checkable from the commit alone. Deliberately assigned
    // only here — after the refusal branch — so the trailer cannot appear on a
    // commit whose identity check did not run and pass. `committedTree` is the
    // index tree, which is the tree this commit will carry; at this point it is
    // equal to evidence.auditedTree, so one value records both halves.
    values.auditedTree = committedTree;
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
    // ---- Guard A: an unscoped commit is refused, fail-closed --------------
    //
    // This CLI cannot know WHOSE staged entries the index holds — there is no
    // ownership signal there — so the question is not "are these foreign?" but
    // "has the caller declared what it intends to commit?". Committing the bare
    // index in a shared worktree is how 13 staged deletions were absorbed into
    // another session's 12-line commit and pushed as a −2,324-line diff.
    //
    // There is deliberately NO `--index-is-mine` escape hatch. An unscoped
    // commit is a TOCTOU by construction — the index is read here and consumed
    // by `git commit` later — and HEAD verification cannot cover it, because
    // index mutations do not move HEAD. Deleting the mode removes the race
    // instead of documenting it, and removes a flag instead of adding one.
    const scope = classifyStagedScope({ paths: [], repoRoot, run: gitRun });
    if (scope.reason === 'nothing-staged') { err('ship-commit: nothing staged'); process.exit(1); }
    if (scope.reason === 'git-exec-failed') {
      err(`ship-commit: could not read the index (${scope.detail || 'git failed'})`);
      process.exit(1);
    }
    const staged = scope.staged || [];
    const shown = staged.slice(0, 5);
    err(
      `AGENT FIX: --path: refusing to commit the whole index (${staged.length} staged path(s): `
      + `${shown.join(', ')}${staged.length > 5 ? ', …' : ''}). `
      + "In a shared working tree the index may hold another session's in-flight work. "
      + `Name what you are shipping: ${shown.map((p) => `--path ${p}`).join(' ')}`,
    );
    process.exit(2);
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
      // A path absent from disk is only an ERROR when git does not know it
      // either. A DELETION is a legitimate scoped change — the file is gone from
      // the worktree but still tracked in HEAD — and rejecting it forced the
      // caller to either drop the deletion from the commit (leaving a staged
      // delete stranded in a shared index) or abandon `--path` scoping entirely
      // and commit another session's work along with their own. Found shipping
      // the `.githooks/post-merge` removal, where dropping it would have left the
      // hook live in HEAD and still recreating the tree the commit exists to
      // retire.
      // A DIRECTORY silently widens the declaration: git expands the pathspec,
      // so `--path sub` was measured to commit `sub/b.txt` — a file the caller
      // never named. Refused, and the sample is bounded: the decision rests on
      // `lstat` alone (a huge directory is refused as cheaply as a small one),
      // and the message stops collecting at the cap rather than computing an
      // exact remainder, which would reintroduce the traversal.
      let statErr = null;
      let isDirectory = false;
      try { isDirectory = fs.lstatSync(abs).isDirectory(); } catch (e) { statErr = e; }
      if (statErr && statErr.code !== 'ENOENT') {
        rollback();
        err(`ship-commit: could not stat ${rel} (${statErr.code})`);
        process.exit(1);
      }
      if (isDirectory) {
        const { sample, truncated } = sampleDirectoryEntries(abs);
        pathErrors.push({
          field: '--path',
          custom: `AGENT FIX: --path ${p}: is a directory, and git would expand it — `
            + `naming it commits everything beneath it (${sample.join(', ')}`
            + `${truncated ? ', … additional entries omitted' : ''}). `
            + 'Pass each file you are shipping. Example: --path scripts/foo.mjs',
        });
        continue;
      }
      if (!fs.existsSync(abs)) {
        // BOTH the index and HEAD, because they disagree in exactly the case
        // that matters: once `git rm --cached` (or `git add` of a removal) has
        // staged the deletion, the path is GONE from the index while still
        // present in HEAD — so an index-only probe reports "git does not track
        // it" for a deletion that is already half-committed.
        const inIndex = git(['ls-files', '--error-unmatch', '--', rel], repoRoot).status === 0;
        // `-t`, NOT `-e`. `cat-file -e` only asks "does this object exist", and
        // it exits 0 for a TREE as happily as for a blob — so a DELETED
        // directory passed this probe and `git commit --only -- <dir>` then
        // silently committed every deletion beneath it, reintroducing the
        // widening the directory check above exists to stop. Measured
        // 2026-08-11: lstat('sub') → ENOENT, `cat-file -e HEAD:sub` → exit 0,
        // `cat-file -t HEAD:sub` → `tree`.
        const headType = git(['cat-file', '-t', `HEAD:${rel}`], repoRoot);
        const headKind = headType.status === 0 ? (headType.stdout || '').trim() : null;
        if (headKind === 'tree') {
          pathErrors.push({
            field: '--path',
            custom: `AGENT FIX: --path ${p}: is a DELETED directory — naming it would commit every `
              + 'deletion beneath it, not just the path you named. Pass each deleted file. '
              + 'Example: --path scripts/foo.mjs',
          });
          continue;
        }
        const inHead = headKind === 'blob';
        if (!inIndex && !inHead) {
          pathErrors.push({
            field: '--path',
            custom: `AGENT FIX: --path ${p}: no such file, and git does not track it `
              + `(so it is not a deletion either). Example: --path scripts/foo.mjs`,
          });
          continue;
        }
        rels.push(rel);      // tracked + absent = a deletion; commit it as one
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

  // ---- migration realization gate ----------------------------------------
  //
  // A commit that ships a migration is only half-shipped until the migration is APPLIED.
  // On 2026-07-31 exactly that happened: migration + dependent code committed, tests green,
  // pushed — and the fix was byte-for-byte inert because nobody ran `--migrate`. The drift
  // checker existed and was wired to nothing.
  //
  // Enforced HERE, in the binary, not in `/ship`'s SKILL.md: a SKILL step is an instruction
  // to an agent and cannot block. This is the same place an unevidenced `AI-Gate: passed`
  // is refused.
  //
  // UNCONDITIONAL when cloud is on — deliberately not gated on "the push range touches
  // supabase/migrations/". A code-only commit can depend on a migration left unapplied by
  // an EARLIER push or a branch switch, which is the more dangerous version of the same
  // bug; and the check is one indexed SELECT against a connection the ship flow needs
  // anyway. Cloud off / unreachable ⇒ skip silently: blocking on an unmeasurable condition
  // is the cried-wolf shape that earns `--no-verify`.
  {
    const realization = await checkMigrationRealization(repoRoot);
    if (realization.behind) {
      if (pathspecRollback) pathspecRollback();
      err(formatMigrationBlockLine(realization));
      process.exit(2);
    }
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
    // Sanctioned hook bypass — the whole point of --no-tests (see above).
    if (opts.noTests) commitArgs.push('--no-verify');
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
      // ---- Post-commit verification (guard B's second half) ---------------
      //
      // This DETECTS; it does not prevent. `git commit` has already created the
      // commit and moved the checked-out ref by the time this runs, so it is
      // NOT a compare-and-swap — calling it one would let a reader believe the
      // window is closed when it is only narrowed. The full transaction
      // (candidate tree + `update-ref <ref> <new> <expected-old>`) lives in
      // docs/plans/ship-commit-transaction.md.
      //
      // What it buys is the half that mattered in the field: the incident
      // escaped because it was PUSHED. A detected, unpushed wrong-parent commit
      // is recoverable in seconds. So: report loudly, print the recovery
      // command, and NEVER auto-reset — an automatic reset in a shared worktree
      // is exactly the destructive action this plan exists to prevent.
      if (verifiedIdentity) {
        const parentRes = git(['rev-parse', '--verify', '--quiet', 'HEAD^'], repoRoot);
        const parentSha = parentRes.status === 0 ? (parentRes.stdout || '').trim() : null;
        const nowRef = readActualIdentity({ run: gitRun });
        const nowName = nowRef.ok && nowRef.identity.ref.kind === 'attached' ? nowRef.identity.ref.name : '(detached)';
        const expName = verifiedIdentity.ref.kind === 'attached' ? verifiedIdentity.ref.name : '(detached)';
        const drift = [];
        if (parentSha !== verifiedIdentity.head) drift.push(`parent ${parentSha ? parentSha.slice(0, 12) : '<none>'} != verified base ${verifiedIdentity.head.slice(0, 12)}`);
        if (nowName !== expName) drift.push(`branch ${nowName} != verified ${expName}`);
        if (drift.length > 0) {
          err(`ship-commit: post-commit-drift — the worktree moved between verification and commit (${drift.join('; ')}).`);
          err(`ship-commit: the commit EXISTS but was not built on the base you verified. DO NOT PUSH.`);
          err(`ship-commit: inspect with \`git log -1\`, and if it is wrong: git reset --soft HEAD^`);
          exitCode = 1;
        }
      }

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
        const trailerSummary = [`AI-Skill: ${values.skill}`, `AI-Gate: ${values.gate}`, values.runId ? `AI-Run-ID: ${values.runId}` : null, values.auditedTree ? `AI-Audited-Tree: ${values.auditedTree.slice(0, 12)}` : null].filter(Boolean).join(' · ');
        process.stdout.write(`ship-commit: committed "${subject}" (${trailerSummary})\n`);
      }
    }
  } finally {
    try { fs.unlinkSync(finalPath); } catch { /* best-effort cleanup */ }
  }
  process.exit(exitCode);
}

await main();

/**
 * Render the block message for a `{behind: true}` realization result.
 *
 * ONE oracle for this text, used by both the `--check-migrations` preflight
 * and the real Step 6.3 commit-time gate — they must never drift into two
 * different descriptions of the same block.
 */
function formatMigrationBlockLine(realization) {
  return `AGENT FIX: ${realization.db ? `database ${realization.db}` : 'the database'} is missing `
    + `${realization.missing.length} migration(s) this commit's bundle ships `
    + `(${realization.missing.slice(0, 3).join(', ')}`
    + `${realization.missing.length > 3 ? `, +${realization.missing.length - 3} more` : ''}) `
    + `— compared ${realization.dir} against public.audit_loop_migrations. `
    + 'Shipping now would push code whose schema does not exist yet. '
    + `Run: ${realization.command}`;
}

/**
 * Is the database missing migrations this checkout bundles?
 *
 * Fail-OPEN by construction: every uncertainty (cloud off, no pool, no migrations
 * directory, unreadable ledger) returns `{behind: false}`. Only a definite set difference
 * blocks the commit. A ship gate that fires on an unmeasurable condition gets
 * `--no-verify`'d, and then it protects nothing at all.
 *
 * Uses the same filename-set comparison the runtime write guard uses, so ship time and
 * runtime cannot disagree about what "realized" means.
 */
async function checkMigrationRealization(repoRoot) {
  try {
    const { getPool } = await import('./lib/db/client.mjs');
    const pool = await getPool();
    if (!pool) return { behind: false, reason: 'cloud-off' };

    const {
      resolveMigrationsDir, listBundledMigrations, readAppliedMigrations, findUnappliedMigrations,
      setupPostgresCommand, describeDatabase,
    } = await import('./lib/db/schema-realization.mjs');

    // No layout argument: the module reads its own install path. Passing `repoRoot` alone
    // used to leave the directory chosen by first-existing-wins, which in a consumer picked
    // that repo's OWN `supabase/migrations` and compared an app schema against the
    // audit-loop ledger — every app migration permanently "missing", every commit refused.
    const dir = resolveMigrationsDir(repoRoot);
    if (!dir) return { behind: false, reason: 'no-migrations-dir' };
    const bundled = listBundledMigrations(dir);
    // null = unreadable, not empty. Both fail open, but only one of them means "we looked".
    if (bundled === null) return { behind: false, reason: 'bundle-unreadable' };
    if (bundled.length === 0) return { behind: false, reason: 'no-migrations-dir' };

    const applied = await readAppliedMigrations(pool);
    if (applied === null) return { behind: false, reason: 'no-ledger' };

    const missing = findUnappliedMigrations(bundled, applied);
    return missing.length > 0
      ? { behind: true, missing, dir, db: describeDatabase(pool), command: setupPostgresCommand() }
      : { behind: false, reason: 'realized' };
  } catch {
    // Unreachable database, missing pg, bad DSN — all unmeasurable, none block.
    return { behind: false, reason: 'unmeasurable' };
  }
}
