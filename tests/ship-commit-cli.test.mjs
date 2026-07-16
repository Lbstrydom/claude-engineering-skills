/**
 * @fileoverview CLI integration tests for scripts/ship-commit.mjs — asserts
 * the §F1.4 failure taxonomy row-by-row (exit code + stderr family +
 * commit-attempted) against a temp git repo, plus the happy-path trailer
 * parse-back through `git interpret-trailers --parse` and the Gemini G2
 * input-immutability invariant. Grammar/byte-format details are covered in
 * tests/commit-trailers.test.mjs.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../scripts/ship-commit.mjs');
let repo;

function git(args, cwd = repo) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

function runCli(args, cwd = repo) {
  // Hermetic env: redirect HOME/USERPROFILE into the temp repo so
  // ~/.audit-loop.env (shared cloud config) can't inject a real AUDIT_DB_URL,
  // and blank the var itself — gate-verdict verification must never hit a
  // live store from tests (it degrades to "verification unavailable").
  const env = { ...process.env, AUDIT_DB_URL: '', HOME: cwd, USERPROFILE: cwd };
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf-8', env });
}

function commitCount() {
  const r = spawnSync('git', ['rev-list', '--count', 'HEAD'], { cwd: repo, encoding: 'utf-8' });
  return r.status === 0 ? Number(r.stdout.trim()) : 0;
}

/** Write a message file inside the repo and stage a change. */
function arrange({ message = 'feat: test subject\n\nbody line\n', stage = true } = {}) {
  fs.mkdirSync(path.join(repo, '.claude', 'tmp'), { recursive: true });
  const mf = path.join('.claude', 'tmp', 'msg.txt');
  fs.writeFileSync(path.join(repo, mf), message);
  if (stage) {
    fs.writeFileSync(path.join(repo, 'work.txt'), `payload ${Date.now()}\n`);
    git(['add', 'work.txt']);
  }
  return mf;
}

const BASE_ARGS = (mf) => ['--message-file', mf, '--skill', 'ship', '--models', 'claude,gpt', '--gate', 'not-run'];

beforeEach(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-cli-'));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  // skill-name enum source (§F1.3c): source layout uses skills/<name>/
  fs.mkdirSync(path.join(repo, 'skills', 'ship'), { recursive: true });
  // baseline commit so HEAD exists for most rows
  fs.writeFileSync(path.join(repo, 'README.md'), 'seed\n');
  git(['add', 'README.md']);
  git(['commit', '-q', '-m', 'seed']);
});
afterEach(() => { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('ship-commit CLI — §F1.4 taxonomy', () => {
  it('row 0: all valid → exit 0, commit carries the AI-* block, parse-back round-trips', () => {
    const mf = arrange({ message: 'feat: happy path\n\nbody with detail\n\n# markdown header must survive\n' });
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /ship-commit: committed "feat: happy path"/);
    const body = git(['log', '-1', '--format=%B']);
    assert.match(body, /AI-Skill: ship\n/);
    assert.match(body, /AI-Models: claude,gpt\n/);
    assert.match(body, /AI-Gate: not-run/);
    assert.match(body, /# markdown header must survive/, '--cleanup=whitespace preserves #-lines (Gemini R2-G2)');
    // parse-back through git's own trailer parser
    const parsed = spawnSync('git', ['interpret-trailers', '--parse'], { cwd: repo, input: body, encoding: 'utf-8' });
    assert.match(parsed.stdout, /AI-Skill: ship/);
    assert.match(parsed.stdout, /AI-Gate: not-run/);
  });

  it('row 0 + G2: the agent message file is byte-identical after the run (input immutability)', () => {
    const mf = arrange();
    const before = fs.readFileSync(path.join(repo, mf), 'utf-8');
    assert.equal(runCli(BASE_ARGS(mf)).status, 0);
    assert.equal(fs.readFileSync(path.join(repo, mf), 'utf-8'), before);
  });

  it('rows 1-4: unknown flag / bad skill / bad models / bad gate → exit 2, AGENT FIX, no commit', () => {
    const mf = arrange();
    const before = commitCount();
    for (const [args, family] of [
      [[...BASE_ARGS(mf), '--bogus'], /AGENT FIX: --bogus: unknown flag/],
      [['--message-file', mf, '--skill', 'shipping', '--models', 'claude', '--gate', 'not-run'], /AGENT FIX: --skill: expected one of \[ship\]/],
      [['--message-file', mf, '--skill', 'ship', '--models', 'claude gpt', '--gate', 'not-run'], /AGENT FIX: --models:/],
      [['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'green'], /AGENT FIX: --gate:/],
    ]) {
      const r = runCli(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, family);
    }
    assert.equal(commitCount(), before, 'exit 2 must leave the repo uncommitted');
  });

  it('row 5: fresh evidence + --gate not-run → exit 2; and --gate passed without evidence → exit 2', () => {
    const mf = arrange();
    // no evidence: passed is illegal
    let r = runCli(['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'passed']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX: gate-evidence: no fresh audit evidence exists but --gate is "passed"/);
    // fresh evidence: not-run is illegal
    fs.mkdirSync(path.join(repo, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.audit', 'last-audit-run.json'),
      JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: new Date(Date.now() + 60_000).toISOString() }));
    r = runCli(['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'not-run']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX: gate-evidence: an audit ran after HEAD/);
    // fresh evidence + passed WITHOUT verifiable store verdict: refused
    // fail-closed (R1 H3/H5) — freshness proves an audit ran, not that it passed
    r = runCli(['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'passed']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX: gate-evidence: "passed" requires a verified verdict for run ecae388d-c176-4182-9d27-0210b919b844 but verification is unavailable \(AUDIT_DB_URL unset\)/);
    // fresh evidence + waived (declared, unverified): legal, AI-Run-ID auto-injected
    r = runCli(['--message-file', mf, '--skill', 'ship', '--models', 'claude', '--gate', 'waived']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(git(['log', '-1', '--format=%B']), /AI-Run-ID: ecae388d-c176-4182-9d27-0210b919b844/);
    assert.match(git(['log', '-1', '--format=%B']), /AI-Gate: waived/);
  });

  it('row 5b: --no-run-id declares the fresh audit unrelated → not-run legal, no AI-Run-ID trailer', () => {
    const mf = arrange();
    fs.mkdirSync(path.join(repo, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.audit', 'last-audit-run.json'),
      JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: new Date(Date.now() + 60_000).toISOString() }));
    const r = runCli([...BASE_ARGS(mf), '--no-run-id']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /--no-run-id override/);
    assert.doesNotMatch(git(['log', '-1', '--format=%B']), /AI-Run-ID:/);
  });

  it('rows 6/7/8: missing file, whitespace-only file, reserved AI-* trailer → exit 2', () => {
    const mf = arrange();
    let r = runCli(BASE_ARGS(path.join('.claude', 'tmp', 'nope.txt')));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX: --message-file: expected a readable non-empty file; got ".*" \(ENOENT\)/);

    fs.writeFileSync(path.join(repo, mf), '   \n\n');
    r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /empty or whitespace-only/);

    fs.writeFileSync(path.join(repo, mf), 'feat: x\n\nbody\n\nAI-Gate: passed\n');
    r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /AGENT FIX: reserved-trailer:/);
  });

  it('row 6b (Gemini G1): traversal and in-repo sensitive message paths are refused', () => {
    arrange();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-out-'));
    fs.writeFileSync(path.join(outside, 'evil.txt'), 'stolen\n');
    let r = runCli(BASE_ARGS(path.join(outside, 'evil.txt')));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must resolve inside the repo and not be a sensitive path/);
    fs.rmSync(outside, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

    fs.writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    r = runCli(BASE_ARGS('.env'));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /must resolve inside the repo and not be a sensitive path/);
  });

  it('row 10: malformed audit evidence → exit 1 unless --no-run-id opts out', () => {
    const mf = arrange();
    fs.mkdirSync(path.join(repo, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.audit', 'last-audit-run.json'), '{broken');
    let r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: audit evidence unparseable:/);
    r = runCli([...BASE_ARGS(mf), '--no-run-id']);
    assert.equal(r.status, 0, r.stderr);
  });

  it('row 11: nothing staged → exit 1, named stderr', () => {
    const mf = arrange({ stage: false });
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: nothing staged/);
  });

  it('row 12: not a git repo → exit 1', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-bare-'));
    const r = runCli(['--message-file', 'x.txt', '--skill', 'ship', '--models', 'claude', '--gate', 'not-run'], bare);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: git:/);
    fs.rmSync(bare, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('trailer integrity (R2 H3): a commit-msg hook that strips AI-* trailers → exit 1 integrity error', () => {
    const mf = arrange();
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    // hook rewrites the message, dropping every AI-* line
    fs.writeFileSync(path.join(hooksDir, 'commit-msg'), '#!/bin/sh\ngrep -v "^AI-" "$1" > "$1.tmp" && mv "$1.tmp" "$1"\n');
    fs.chmodSync(path.join(hooksDir, 'commit-msg'), 0o755);
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: trailer integrity check failed/);
  });

  it('cleanup (R2 L1): failure paths still remove the helper temp file (finally runs before exit)', () => {
    const mf = arrange();
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    const leftovers = fs.readdirSync(path.join(repo, '.claude', 'tmp')).filter((f) => f.startsWith('ship-commit-final-'));
    assert.deepEqual(leftovers, [], 'helper-owned temp file must be cleaned up on failure');
  });

  it('row 10b (R2 H2/H5): unreadable evidence (EISDIR) → exit 1, never silently treated as absent', () => {
    const mf = arrange();
    // a DIRECTORY at the evidence path → EISDIR on read, but it exists
    fs.mkdirSync(path.join(repo, '.audit', 'last-audit-run.json'), { recursive: true });
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: audit evidence unreadable \(EISDIR\)/);
    // --no-run-id opts out of reading it entirely → proceeds
    const r2 = runCli([...BASE_ARGS(mf), '--no-run-id']);
    assert.equal(r2.status, 0, r2.stderr);
  });

  it('trailer integrity (R3 H2): a hook DUPLICATING an AI-* trailer also fails the parse-back', () => {
    const mf = arrange();
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'commit-msg'), '#!/bin/sh\necho "AI-Skill: ship" >> "$1"\n');
    fs.chmodSync(path.join(hooksDir, 'commit-msg'), 0o755);
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /trailer integrity check failed/);
  });

  it('skill-enum layout (R3 M2): a git repo with neither skills/ nor .claude/skills/ → exit 1, named error', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-noskills-'));
    const g = (args) => spawnSync('git', args, { cwd: bare, encoding: 'utf-8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@e.c']);
    g(['config', 'user.name', 'T']);
    fs.mkdirSync(path.join(bare, '.claude', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(bare, '.claude', 'tmp', 'msg.txt'), 'feat: x\n\nbody\n');
    const r = runCli(BASE_ARGS(path.join('.claude', 'tmp', 'msg.txt')), bare);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: no skill layout found/);
    fs.rmSync(bare, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('row 13: commit hook rejection → exit 1, git stderr passed through, working tree intact', () => {
    const mf = arrange();
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'pre-commit'), '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    fs.chmodSync(path.join(hooksDir, 'pre-commit'), 0o755);
    const before = commitCount();
    const r = runCli(BASE_ARGS(mf));
    assert.equal(r.status, 1);
    assert.match(r.stderr, /ship-commit: git commit failed:/);
    assert.equal(commitCount(), before);
  });

  it('unborn HEAD (Gemini R2-G1): first commit of a fresh repo works; evidence reads fresh', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-fresh-'));
    const g = (args) => spawnSync('git', args, { cwd: fresh, encoding: 'utf-8' });
    g(['init', '-q', '-b', 'main']);
    g(['config', 'user.email', 't@e.c']);
    g(['config', 'user.name', 'T']);
    g(['config', 'commit.gpgsign', 'false']);
    fs.mkdirSync(path.join(fresh, 'skills', 'ship'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.claude', 'tmp'), { recursive: true });
    fs.mkdirSync(path.join(fresh, '.audit'), { recursive: true });
    fs.writeFileSync(path.join(fresh, '.claude', 'tmp', 'msg.txt'), 'feat: first commit\n\nbody\n');
    fs.writeFileSync(path.join(fresh, '.audit', 'last-audit-run.json'),
      JSON.stringify({ runId: 'ecae388d-c176-4182-9d27-0210b919b844', ts: '2020-01-01T00:00:00Z' }));
    fs.writeFileSync(path.join(fresh, 'work.txt'), 'x\n');
    g(['add', 'work.txt']);
    const r = runCli(['--message-file', path.join('.claude', 'tmp', 'msg.txt'), '--skill', 'ship', '--models', 'claude', '--gate', 'waived'], fresh);
    assert.equal(r.status, 0, r.stderr);
    const body = g(['log', '-1', '--format=%B']).stdout;
    assert.match(body, /AI-Run-ID: ecae388d/);
    fs.rmSync(fresh, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('--selfcheck-relocation → prints OK, exit 0, no git side effects', () => {
    const before = commitCount();
    const r = runCli(['--selfcheck-relocation']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), 'OK');
    assert.equal(commitCount(), before);
  });
});
