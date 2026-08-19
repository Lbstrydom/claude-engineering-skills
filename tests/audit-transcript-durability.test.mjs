/**
 * @fileoverview A transcript written inside a linked worktree must survive that
 * worktree's removal.
 *
 * The defect (measured 2026-08-18, plan `docs/plans/audit-transcript-durability.md`):
 * `.audit/` is gitignored, so every linked worktree keeps its OWN copy and it is
 * deleted with the worktree. Agent/chip sessions run real audits in throwaway
 * worktrees under `.claude/worktrees/<name>`; ZERO transcripts dated 2026-08-17
 * survived anywhere on disk while the store recorded real audit sessions that
 * day. The store keeps the findings; the transcripts are the only replayable
 * INPUT the model-comparison campaigns have, and they were being generated and
 * destroyed.
 *
 * Everything here runs against a REAL git repo with a REAL linked worktree,
 * because the whole defect is a property of git worktree layout — a mocked
 * filesystem would prove nothing about it.
 *
 * THE NEGATIVE CONTROL IS LOAD-BEARING. `AUDIT_TRANSCRIPT_ARCHIVE=0` executes
 * the pre-change behaviour, and the suite asserts that under it the transcript
 * is DESTROYED by teardown. Without that direction pinned, the acceptance test
 * could pass for reasons unrelated to archiving (a stray copy, a teardown that
 * silently did nothing) and nobody would know.
 *
 * Temp repos live under the OS temp dir, NOT the session scratchpad: a deep
 * scratchpad path plus a checkout hits Windows MAX_PATH and half-checks-out,
 * which reads as a broken tool rather than a path-length problem.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { git } from './helpers/git.mjs';

// @babel/traverse ships CJS; under ESM the callable lands on .default (and on
// .default.default via some interop paths). Same normalisation as
// tests/rmsync-retry-guard.test.mjs.
const traverse = _traverse?.default?.default ?? _traverse?.default ?? _traverse;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BUILD_CLI = path.join(REPO, 'scripts', 'build-audit-transcript.mjs');
const HARVEST_CLI = path.join(REPO, 'scripts', 'harvest-audit-transcripts.mjs');

let ROOT; let MAIN;

/** A minimal round result — enough for `buildAuditTranscript` to accept it. */
function writeRoundResult(dir, sid, round, findings = []) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${sid}-r${round}-result.json`),
    JSON.stringify({ findings, code_files: [] }, null, 2),
  );
}

/**
 * Spawn a repo CLI with the archive setting PINNED, then apply any override.
 *
 * `AUDIT_TRANSCRIPT_ARCHIVE` is stated explicitly rather than inherited: a
 * developer or CI environment with the kill switch set would otherwise make
 * the negative control pass for the ambient reason instead of the one it
 * asserts — a vacuous green in the one test whose whole job is to prove the
 * acceptance test is not vacuous.
 */
function runCli(cli, args, cwd, envOverride = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf-8',
    env: { ...process.env, AUDIT_TRANSCRIPT_ARCHIVE: '1', ...envOverride },
  });
}

function archiveDir(mainRoot) {
  return path.join(mainRoot, '.audit', 'transcripts');
}

/** Every file in the archive, or [] when it was never created. */
function archived(mainRoot) {
  try {
    return fs.readdirSync(archiveDir(mainRoot)).sort();
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

beforeEach(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-durability-'));
  MAIN = path.join(ROOT, 'repo');
  fs.mkdirSync(MAIN, { recursive: true });

  git(['init', '-b', 'main'], MAIN);
  git(['config', 'user.email', 'test@example.invalid'], MAIN);
  git(['config', 'user.name', 'test'], MAIN);
  // The same ignore rules the real repo has — `.audit/` being gitignored is the
  // premise of the defect, not an incidental detail.
  fs.writeFileSync(path.join(MAIN, '.gitignore'), '.audit/\n.claude/worktrees/\n');
  fs.writeFileSync(path.join(MAIN, 'marker.txt'), 'main\n');
  git(['add', '-A'], MAIN);
  git(['commit', '-m', 'init'], MAIN);
});

afterEach(() => {
  // maxRetries/retryDelay per the repo-wide rmSync retry guard: removing a tree
  // git has just touched hits EPERM/EBUSY on Windows, which is precisely the
  // situation this suite manufactures.
  try { fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
});

/**
 * Create a linked worktree, run an audit-transcript build inside it, then
 * DESTROY it the way a half-finished teardown does — `rm -rf`, not a clean
 * `git worktree remove`. That is the observed failure mode: a removal that
 * deregisters and leaves (or takes) whatever it likes.
 *
 * @returns {{sid: string, localPath: string, stdout: string, stderr: string, status: number}}
 */
function auditInThrowawayWorktree({ sid, envOverride = {} } = {}) {
  // Named per session id, so one test can run this twice (e.g. archive on vs
  // off) without colliding on the branch name.
  const name = `wt-${sid}`;
  const wt = path.join(MAIN, '.claude', 'worktrees', name);
  git(['worktree', 'add', '-b', name, wt], MAIN);

  const localAudit = path.join(wt, '.audit');
  writeRoundResult(localAudit, sid, 1, [{ severity: 'HIGH', title: 'from a throwaway worktree' }]);

  const res = runCli(BUILD_CLI, ['--sid', sid], wt, envOverride);
  const localPath = path.join(localAudit, `${sid}-transcript.json`);
  assert.equal(res.status, 0, `build-audit-transcript failed: ${res.stderr}`);
  assert.ok(fs.existsSync(localPath), 'the worktree-local transcript should exist before teardown');

  // Teardown.
  fs.rmSync(wt, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  git(['worktree', 'prune'], MAIN);
  assert.ok(!fs.existsSync(localPath), 'teardown must really have destroyed the worktree-local copy');

  return { sid, localPath, stdout: res.stdout, stderr: res.stderr, status: res.status };
}

describe('audit-transcript durability across worktree teardown', () => {
  it('ACCEPTANCE: a transcript built in a linked worktree survives the worktree being removed', () => {
    const sid = 'audit-plan-1786900000';
    auditInThrowawayWorktree({ sid });

    const survivor = path.join(archiveDir(MAIN), `${sid}-transcript.json`);
    assert.ok(
      fs.existsSync(survivor),
      `the transcript must survive in the main checkout's archive; archive holds: ${JSON.stringify(archived(MAIN))}`,
    );

    // Surviving as bytes is not enough — it has to still BE the transcript.
    const parsed = JSON.parse(fs.readFileSync(survivor, 'utf-8'));
    assert.equal(parsed.audit_mode, 'plan');
    assert.equal(parsed.rounds.length, 1);
    assert.equal(parsed.rounds[0].findings[0].title, 'from a throwaway worktree');
  });

  it('NEGATIVE CONTROL: with archiving disabled (the pre-change behaviour) the transcript is destroyed', () => {
    const sid = 'audit-plan-1786900001';
    auditInThrowawayWorktree({ sid, envOverride: { AUDIT_TRANSCRIPT_ARCHIVE: '0' } });

    assert.deepEqual(
      archived(MAIN), [],
      'with the archive off, teardown must leave NOTHING — this is what makes the acceptance test load-bearing',
    );
  });

  it('names the archive destination, and says so distinctly when it did NOT archive', () => {
    // A run that failed to archive must not read like one that succeeded — the
    // whole class of bugs this replaces was invisible because a lost transcript
    // looked exactly like a normal run.
    const ok = auditInThrowawayWorktree({ sid: 'audit-plan-1786900002' });
    assert.match(ok.stderr, /\[transcript\] archived → /);

    const off = auditInThrowawayWorktree({
      sid: 'audit-plan-1786900003', envOverride: { AUDIT_TRANSCRIPT_ARCHIVE: '0' },
    });
    assert.match(off.stderr, /\[transcript\] NOT archived/);
  });
});

describe('durability is enforced by the EXIT CODE, not only by a log line', () => {
  // A warning is not an enforceable guarantee: every caller that checks `$?`
  // reads exit 0 as success. Before this, a disk-full or permissions failure
  // let the operator finish the audit, remove the worktree, and lose the
  // transcript — the original defect restored through the reporting channel.

  /** Make the archive directory un-creatable by putting a FILE where it goes. */
  function blockArchive() {
    fs.mkdirSync(path.join(MAIN, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(MAIN, '.audit', 'transcripts'), 'not a directory');
  }

  function buildIn(dir, sid, extraArgs = []) {
    writeRoundResult(path.join(dir, '.audit'), sid, 1);
    return runCli(BUILD_CLI, ['--sid', sid, ...extraArgs], dir);
  }

  it('exits NON-ZERO when a worktree transcript could not be mirrored', () => {
    blockArchive();
    const wt = path.join(MAIN, '.claude', 'worktrees', 'wt-fail');
    git(['worktree', 'add', '-b', 'wt-fail', wt], MAIN);

    const res = buildIn(wt, 'audit-plan-1786900020');
    assert.equal(res.status, 1, `expected a non-zero exit; stderr:\n${res.stderr}`);
    assert.match(res.stderr, /will be LOST when this worktree is removed/);
    // The local transcript is still written — failing the exit code must not
    // also destroy the work.
    assert.ok(fs.existsSync(path.join(wt, '.audit', 'audit-plan-1786900020-transcript.json')));
  });

  it('exits ZERO for the SAME failure in the main checkout — the local copy is durable there', () => {
    // The direction the gate must NOT fire. Without this, "always fail on a
    // mirror error" would pass the test above while breaking every ordinary
    // main-checkout audit.
    blockArchive();
    const res = buildIn(MAIN, 'audit-plan-1786900021');
    assert.equal(res.status, 0, `main-checkout build must not fail; stderr:\n${res.stderr}`);
    assert.match(res.stderr, /survives here \(main checkout\)/);
  });

  it('exits ZERO with --allow-nondurable, and says the transcript is not durable', () => {
    blockArchive();
    const wt = path.join(MAIN, '.claude', 'worktrees', 'wt-optout');
    git(['worktree', 'add', '-b', 'wt-optout', wt], MAIN);

    const res = buildIn(wt, 'audit-plan-1786900022', ['--allow-nondurable']);
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stderr, /NOT archived/);
  });

  it('exits ZERO when archiving is switched OFF — a chosen degradation is not a failure', () => {
    const wt = path.join(MAIN, '.claude', 'worktrees', 'wt-off');
    git(['worktree', 'add', '-b', 'wt-off', wt], MAIN);
    writeRoundResult(path.join(wt, '.audit'), 'audit-plan-1786900023', 1);

    const res = runCli(BUILD_CLI, ['--sid', 'audit-plan-1786900023'], wt, { AUDIT_TRANSCRIPT_ARCHIVE: '0' });
    assert.equal(res.status, 0, res.stderr);
  });
});

describe('option parsing does not swallow the next flag', () => {
  it('refuses `--changed --json` instead of setting changed to "--json"', () => {
    // Silent acceptance produced a transcript whose scope filter was the
    // literal string "--json" — the reviewer then dropped nothing, and the
    // symptom (out-of-scope findings accepted) surfaced far downstream.
    const wt = path.join(MAIN, '.claude', 'worktrees', 'wt-parse');
    git(['worktree', 'add', '-b', 'wt-parse', wt], MAIN);
    writeRoundResult(path.join(wt, '.audit'), 'audit-code-1786900040', 1);

    const res = runCli(BUILD_CLI, ['--sid', 'audit-code-1786900040', '--changed', '--json'], wt);
    assert.notEqual(res.status, 0, `expected a refusal; stdout:\n${res.stdout}`);
    assert.match(res.stderr + res.stdout, /--changed expects a value/);

    // Positive control: the same CLI accepts a real value, so the guard is not
    // just rejecting everything.
    const ok = runCli(BUILD_CLI, ['--sid', 'audit-code-1786900040', '--changed', 'a.mjs', '--json'], wt);
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual(JSON.parse(ok.stdout).changedFiles, 1);
  });
});

describe('a reported archive is a VERIFIED archive', () => {
  it('reports failure when the published bytes do not match the source', async () => {
    // Auditing the success path: "write did not throw" is a weaker claim than
    // "the durable copy is correct", and the exit-code contract turns the
    // second claim into a durability guarantee. A copy that silently differed
    // would be worse than no copy, because the run would report success.
    const mod = await import('../scripts/lib/audit/transcript-archive.mjs');
    const src = path.join(MAIN, 'src-transcript.json');
    fs.writeFileSync(src, '{"real":true}');

    const realRead = fs.readFileSync;
    let firstReadDone = false;
    // Corrupt only the READ-BACK, leaving the write intact — the exact shape of
    // a torn or truncated copy that a naive implementation would call archived.
    fs.readFileSync = (p, ...rest) => {
      const buf = realRead(p, ...rest);
      if (!firstReadDone && String(p).includes('src-transcript.json')) { firstReadDone = true; return buf; }
      if (String(p).includes(path.join('.audit', 'transcripts'))) return Buffer.from('{"corrupted":true}');
      return buf;
    };
    try {
      const outcome = mod.archiveTranscript(src, { cwd: MAIN });
      assert.equal(outcome.archived, false, JSON.stringify(outcome));
      assert.match(outcome.error, /does not match the source bytes/);
    } finally {
      fs.readFileSync = realRead;
    }

    // Positive control: with reads untampered the same call succeeds, so the
    // assertion above is about verification and not about a broken fixture.
    const ok = mod.archiveTranscript(src, { cwd: MAIN });
    assert.equal(ok.archived, true, JSON.stringify(ok));
  });
});

describe('archive publication never clobbers', () => {
  it('leaves an existing byte-different transcript at the preferred name untouched', async () => {
    // The concurrency finding: a read-then-write target selection has a window
    // in which a second worktree publishes the same basename and this write
    // replaces it. Exclusive creation removes the window; the observable
    // property is that the first file's bytes are never modified.
    const { archiveTranscript } = await import('../scripts/lib/audit/transcript-archive.mjs');

    const archive = path.join(MAIN, '.audit', 'transcripts');
    fs.mkdirSync(archive, { recursive: true });
    fs.writeFileSync(path.join(archive, 'x-transcript.json'), '{"first":true}');

    const src = path.join(MAIN, '.audit', 'x-transcript.json');
    fs.writeFileSync(src, '{"second":true}');

    const outcome = archiveTranscript(src, { cwd: MAIN });
    assert.equal(outcome.archived, true, JSON.stringify(outcome));
    assert.equal(fs.readFileSync(path.join(archive, 'x-transcript.json'), 'utf-8'), '{"first":true}');
    assert.equal(fs.readFileSync(outcome.path, 'utf-8'), '{"second":true}');
  });
});

describe('harvest-audit-transcripts sweep', () => {
  it('harvests the MAIN checkout too — durable against teardown is not durable against pruning', () => {
    // audit-clean.mjs caps the main checkout's working copies at the newest 25,
    // so a transcript that only ever lived there is still on a clock.
    fs.mkdirSync(path.join(MAIN, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(MAIN, '.audit', 'audit-code-1786900030-transcript.json'), '{"rounds":[]}');

    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    assert.deepEqual(archived(MAIN), ['audit-code-1786900030-transcript.json']);
  });

  it('exits NON-ZERO when a discovered transcript could not be archived', () => {
    // A partial repair reported as success leaves those sources one
    // `git worktree remove` from being lost while the operator believes the
    // sweep made them safe.
    const orphan = path.join(MAIN, '.claude', 'worktrees', 'orphan');
    fs.mkdirSync(path.join(orphan, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(orphan, '.audit', 'x-transcript.json'), '{"rounds":[]}');
    // Block the archive: a FILE where the directory must go.
    fs.mkdirSync(path.join(MAIN, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(MAIN, '.audit', 'transcripts'), 'not a directory');

    const res = runCli(HARVEST_CLI, [], MAIN);
    assert.equal(res.status, 1, `expected non-zero; stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /NOT archived/);
  });

  it('visits exactly as many directories as the filesystem actually created', () => {
    // Integration check, portable across case-sensitive and case-insensitive
    // volumes WITHOUT asking `process.platform`: create both spellings, ask the
    // filesystem how many directories that really made, and require the sweep
    // to agree. NOTE this one is only DISCRIMINATING on a case-sensitive
    // volume — on Windows/macOS-default both spellings are one directory and it
    // would pass under a case-folding key too. The unit test below is the
    // guard that fails everywhere; this is the end-to-end companion.
    const base = path.join(MAIN, '.claude', 'worktrees');
    for (const name of ['wt-A', 'wt-a']) {
      fs.mkdirSync(path.join(base, name, '.audit'), { recursive: true });
      fs.writeFileSync(path.join(base, name, '.audit', `${name}-transcript.json`), `{"from":"${name}"}`);
    }
    const distinctOnDisk = new Set(fs.readdirSync(base)).size;

    const res = runCli(HARVEST_CLI, ['--json'], MAIN);
    assert.equal(res.status, 0, res.stderr);
    const { found } = JSON.parse(res.stdout);
    assert.equal(
      found, distinctOnDisk,
      `the filesystem made ${distinctOnDisk} director(ies); the sweep must visit exactly that many`,
    );
  });

  it('canonicalPathKey asks the filesystem and does NOT fold case', async () => {
    // The non-vacuous half. `wt-A` vs `wt-a` cannot be distinguished on a
    // case-insensitive volume, so that scenario alone would let a case-folding
    // key pass on Windows and macOS — measured: reverting to `.toLowerCase()`
    // left the integration test above GREEN. What IS observable everywhere is
    // that the key preserves the filesystem's own spelling. Folding breaks
    // this assertion on every platform, which is what makes it a guard.
    const { canonicalPathKey } = await import('../scripts/lib/audit/transcript-archive.mjs');
    const dir = path.join(MAIN, 'Mixed-Case-Dir');
    fs.mkdirSync(dir, { recursive: true });

    assert.ok(
      canonicalPathKey(dir).endsWith('Mixed-Case-Dir'),
      `key must preserve on-disk casing, got ${canonicalPathKey(dir)}`,
    );
    // Positive control: on a case-insensitive volume a differently-spelled path
    // to the SAME directory must still resolve to one key, or dedup is broken
    // in the other direction. Skipped where the spelling is a different dir.
    const alt = path.join(MAIN, 'mixed-case-dir');
    if (fs.existsSync(alt)) assert.equal(canonicalPathKey(alt), canonicalPathKey(dir));
  });

  it('separates "directory absent" from "directory unreadable"', async () => {
    // Swallowing every readdir error makes an EACCES checkout look identical to
    // an empty one — the same class as the git-enumeration finding, on the
    // filesystem side. Only the classifier is unit-tested here: EACCES cannot
    // be staged portably (Windows ignores chmod), so testing through a real
    // directory would silently skip on the platform this runs on.
    const mod = await import('../scripts/harvest-audit-transcripts.mjs');
    assert.equal(mod.isAbsentDirError('ENOENT'), true);
    assert.equal(mod.isAbsentDirError('ENOTDIR'), true);
    for (const code of ['EACCES', 'EPERM', 'EIO', 'EMFILE', undefined]) {
      assert.equal(mod.isAbsentDirError(code), false, `${code} must NOT be treated as absent`);
    }

    // And the benign case really is silent end-to-end: a checkout whose
    // `.audit` is a FILE (ENOTDIR) reports no scan error.
    const wt = path.join(MAIN, 'weird');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.audit'), 'not a directory');
    const errors = [];
    assert.deepEqual(mod.transcriptsIn(wt, { onError: e => errors.push(e) }), []);
    assert.deepEqual(errors, []);
  });

  it('every catch in the sweep either classifies the error or is dispositioned', () => {
    // A CENSUS, not another point test. "Swallowed a filesystem error" has now
    // recurred three times in this one file — readdir on `.claude/worktrees`,
    // readdir on `.audit`, then statSync in candidateWorktrees — and each time
    // the previous fix looked complete. Point tests cannot cover it: EACCES is
    // not stageable on Windows, and reverting the statSync fix left the whole
    // suite green. So the oracle enumerates the catch blocks instead, and a new
    // unclassified one fails here rather than in production.
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'harvest-audit-transcripts.mjs'), 'utf-8');
    const ast = parse(src, { sourceType: 'module', plugins: [] });

    // Each key is a catch that deliberately does NOT call isAbsentDirError,
    // with the reason it does not need to. Anything else must classify.
    const DISPOSITIONED = new Map([
      ['worktreeDirsFromGit', 'returns {ok:false,error} — the failure IS the return value'],
      ['harvest', 'returns {ok:false} when the repository itself cannot be resolved'],
    ]);

    const offenders = [];
    traverse(ast, {
      CatchClause(p) {
        const fn = p.getFunctionParent();
        const name = fn?.node?.id?.name ?? '(anonymous)';
        const body = src.slice(p.node.start, p.node.end);
        if (body.includes('isAbsentDirError')) return;
        if (DISPOSITIONED.has(name)) return;
        offenders.push(`${name}: ${body.split('\n')[0]}`);
      },
    });

    assert.deepEqual(
      offenders, [],
      'each of these swallows a filesystem error without classifying it — an unreadable '
      + 'directory becomes indistinguishable from an absent one. Classify with '
      + 'isAbsentDirError, or add a disposition here saying why it does not need to.',
    );
    // Vacuous-pass guard: the walk must actually be finding catch blocks.
    let seen = 0;
    traverse(ast, { CatchClause() { seen += 1; } });
    assert.ok(seen >= 4, `expected the walk to find catch clauses, found ${seen}`);
  });

  it('reports a git-enumeration failure distinctly from "no worktrees"', async () => {
    // Collapsing the two would let half the union die silently while the sweep
    // still reported a clean run.
    const { worktreeDirsFromGit } = await import('../scripts/harvest-audit-transcripts.mjs');
    const notARepo = fs.mkdtempSync(path.join(os.tmpdir(), 'not-a-repo-'));
    try {
      const failed = worktreeDirsFromGit(notARepo);
      assert.equal(failed.ok, false);
      assert.deepEqual(failed.dirs, []);

      const okResult = worktreeDirsFromGit(MAIN);
      assert.equal(okResult.ok, true, 'positive control: a real repo must enumerate');
      assert.ok(okResult.dirs.length >= 1, 'positive control: the main checkout is itself a worktree');
    } finally {
      fs.rmSync(notARepo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('finds an .audit/ in a directory that git worktree list does NOT report', () => {
    // The exact blindness that motivated the sweep: a failed `git worktree
    // remove` deregisters but leaves the directory. Simulated as a plain
    // directory git never knew about — indistinguishable from an orphan.
    const orphan = path.join(MAIN, '.claude', 'worktrees', 'gallant-hopper-orphan');
    fs.mkdirSync(path.join(orphan, '.audit'), { recursive: true });
    fs.writeFileSync(
      path.join(orphan, '.audit', 'audit-code-1786900010-transcript.json'),
      JSON.stringify({ audit_mode: 'code', rounds: [], code_files: [], changed_files: [] }),
    );

    // PROVE the premise rather than assume it: git must really be blind here,
    // otherwise this test would pass through the registry path and prove nothing.
    const registry = git(['worktree', 'list', '--porcelain'], MAIN);
    assert.ok(!registry.includes('gallant-hopper-orphan'), `git unexpectedly knows the orphan:\n${registry}`);

    const res = runCli(HARVEST_CLI, [], MAIN);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(archived(MAIN), ['audit-code-1786900010-transcript.json']);
  });

  it('also harvests a REGISTERED worktree outside .claude/worktrees/ (the union\'s other half)', () => {
    const outside = path.join(ROOT, 'outside-wt');
    git(['worktree', 'add', '-b', 'outside', outside], MAIN);
    fs.mkdirSync(path.join(outside, '.audit'), { recursive: true });
    fs.writeFileSync(
      path.join(outside, '.audit', 'audit-code-1786900011-transcript.json'),
      JSON.stringify({ audit_mode: 'code', rounds: [], code_files: [], changed_files: [] }),
    );

    const res = runCli(HARVEST_CLI, [], MAIN);
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(archived(MAIN), ['audit-code-1786900011-transcript.json']);
  });

  it('is idempotent — a second sweep over the same bytes adds nothing', () => {
    const orphan = path.join(MAIN, '.claude', 'worktrees', 'orphan');
    fs.mkdirSync(path.join(orphan, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(orphan, '.audit', 'x-transcript.json'), '{"rounds":[]}');

    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    const first = archived(MAIN);
    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    assert.deepEqual(archived(MAIN), first);
  });

  it('never deletes the source', () => {
    const orphan = path.join(MAIN, '.claude', 'worktrees', 'orphan');
    fs.mkdirSync(path.join(orphan, '.audit'), { recursive: true });
    const src = path.join(orphan, '.audit', 'x-transcript.json');
    fs.writeFileSync(src, '{"rounds":[]}');

    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    assert.ok(fs.existsSync(src), 'the sweep copies; it must never delete');
  });

  it('preserves BOTH transcripts when two worktrees mint the same session id', () => {
    // Not hypothetical: the live worktree observed on 2026-08-18 held
    // `audit-plan-1755500000-transcript.json` — a hand-picked id another
    // session could mint verbatim. Silently overwriting one with the other
    // would destroy a transcript while reporting success.
    for (const [dir, body] of [['wt-a', '{"rounds":[1]}'], ['wt-b', '{"rounds":[2]}']]) {
      const d = path.join(MAIN, '.claude', 'worktrees', dir, '.audit');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'audit-plan-1755500000-transcript.json'), body);
    }

    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    const files = archived(MAIN);
    assert.equal(files.length, 2, `both transcripts must survive, got ${JSON.stringify(files)}`);
    const bodies = files.map(f => fs.readFileSync(path.join(archiveDir(MAIN), f), 'utf-8')).sort();
    assert.deepEqual(bodies, ['{"rounds":[1]}', '{"rounds":[2]}']);
  });

  it('collapses identical bytes under one name to a single file', () => {
    for (const dir of ['wt-a', 'wt-b']) {
      const d = path.join(MAIN, '.claude', 'worktrees', dir, '.audit');
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'same-transcript.json'), '{"rounds":[]}');
    }

    assert.equal(runCli(HARVEST_CLI, [], MAIN).status, 0);
    assert.deepEqual(archived(MAIN), ['same-transcript.json']);
  });
});
