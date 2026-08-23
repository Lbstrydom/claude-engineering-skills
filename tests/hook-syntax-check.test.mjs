/**
 * Integration tests for .claude/hooks/syntax-check.mjs
 *
 * The hook parse-checks an edited `.mjs` file on disk and emits
 * {systemMessage} to stdout only when it does NOT parse.
 *
 * Both directions are covered deliberately. A hook that fires correctly but
 * ALSO fires on valid input is worse than no hook — a cried-wolf advisory gets
 * disabled, and then it protects nothing. The must-NOT-fire cases below
 * (valid .mjs, JSX in .js, .ts, sensitive path, disable flag) are the load-
 * bearing half of this suite, not padding.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const HOOK = path.resolve(REPO_ROOT, '.claude', 'hooks', 'syntax-check.mjs');

// Fixtures must live INSIDE the repo: resolveAndClassify treats a
// repo-escaping path as sensitive (fail-closed), which would make every case
// pass for the wrong reason.
const FIXTURE_DIR = path.join(REPO_ROOT, '.claude', 'tmp', `syntax-check-test-${process.pid}`);

const VALID_MJS = 'export const a = 1;\n';
const BROKEN_MJS = 'export const a = ;\n';
const JSX_SOURCE = 'const A = () => <div className="x">hi</div>;\nexport default A;\n';

function fixture(relPath, content) {
  const abs = path.join(FIXTURE_DIR, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

function runHook(stdinJson, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(stdinJson),
    env: { ...process.env, ...env },
    encoding: 'utf-8',
    timeout: 10000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const edit = (filePath) => ({ tool_name: 'Edit', tool_input: { file_path: filePath, new_string: 'x' } });

describe('syntax-check hook', () => {
  before(() => { fs.mkdirSync(FIXTURE_DIR, { recursive: true }); });
  // Retry-hardened per tests/rmsync-retry-guard.test.mjs — on Windows a
  // just-spawned `node --check` can still hold a handle in the fixture tree,
  // which surfaces as a transient EPERM/EBUSY on teardown.
  after(() => {
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  // ---- instrument check: the fixture must genuinely be broken ------------
  // Guards against a vacuous suite where every "silent" assertion passes
  // because the subject never had anything to find.
  it('negative control — node --check itself rejects the broken fixture', () => {
    const abs = fixture('control.mjs', BROKEN_MJS);
    const r = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf-8' });
    assert.notEqual(r.status, 0, 'fixture must actually fail to parse');
  });

  // ---- must fire ---------------------------------------------------------
  it('fires on a .mjs that does not parse', () => {
    const abs = fixture('broken.mjs', BROKEN_MJS);
    const r = runHook(edit(abs));
    assert.equal(r.status, 0, 'hook must never fail the tool call');
    assert.ok(r.stdout.length > 0, 'expected a systemMessage on a parse error');
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /Syntax error/);
    assert.match(out.systemMessage, /broken\.mjs/);
  });

  it('reports a repo-RELATIVE path, never the absolute checkout path', () => {
    const abs = fixture('relpath.mjs', BROKEN_MJS);
    const r = runHook(edit(abs));
    const out = JSON.parse(r.stdout);
    // An absolute path smuggles the checkout's ancestry into the transcript
    // and differs per machine/worktree.
    assert.ok(
      !out.systemMessage.includes(REPO_ROOT),
      `message leaked the absolute repo root:\n${out.systemMessage}`,
    );
    assert.match(out.systemMessage, /\.claude[\\/]tmp/);
  });

  it('never emits continue:false — advisory only', () => {
    const abs = fixture('advisory.mjs', BROKEN_MJS);
    const out = JSON.parse(runHook(edit(abs)).stdout);
    assert.equal(out.continue, undefined);
  });

  // ---- must NOT fire -----------------------------------------------------
  it('stays silent on a valid .mjs', () => {
    const abs = fixture('valid.mjs', VALID_MJS);
    const r = runHook(edit(abs));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'a parsing file must produce no output');
  });

  it('stays silent on JSX in .js — the disqualifying false-positive class', () => {
    // node --check exits 1 on this content. If the extension guard ever
    // widens to .js, every React consumer gets a false positive per edit.
    const abs = fixture('Component.js', JSX_SOURCE);
    assert.notEqual(
      spawnSync(process.execPath, ['--check', abs], { encoding: 'utf-8' }).status,
      0,
      'precondition: node --check must reject JSX (else this test is vacuous)',
    );
    assert.equal(runHook(edit(abs)).stdout.trim(), '');
  });

  it('stays silent on .ts', () => {
    const abs = fixture('types.ts', 'const x: number = 1;\n');
    assert.equal(runHook(edit(abs)).stdout.trim(), '');
  });

  it('stays silent on a sensitive path even when the file is broken', () => {
    const abs = fixture(path.join('secrets', 'leak.mjs'), BROKEN_MJS);
    const r = runHook(edit(abs));
    assert.equal(r.stdout.trim(), '', 'must not echo a sensitive file\'s source line');
  });

  it('stays silent when SYNTAX_CHECK_HOOK_DISABLE=1', () => {
    const abs = fixture('disabled.mjs', BROKEN_MJS);
    assert.equal(runHook(edit(abs), { SYNTAX_CHECK_HOOK_DISABLE: '1' }).stdout.trim(), '');
  });

  it('stays silent for tools other than Edit/Write', () => {
    const abs = fixture('other-tool.mjs', BROKEN_MJS);
    const r = runHook({ tool_name: 'Read', tool_input: { file_path: abs } });
    assert.equal(r.stdout.trim(), '');
  });

  it('fails open on a missing file', () => {
    const abs = path.join(FIXTURE_DIR, 'does-not-exist.mjs');
    const r = runHook(edit(abs));
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('fails open on malformed stdin', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf-8', timeout: 10000 });
    assert.equal(r.status, 0);
    assert.equal((r.stdout || '').trim(), '');
  });

  // ---- layout resolution -------------------------------------------------
  // `.claude/hooks/` stays canonical in BOTH layouts, so the hook cannot infer
  // the tooling root from its own position. The sibling quickfix-scan.mjs
  // hardcodes `scripts/lib/` and is therefore silently inert under the
  // consumer layout — these two cases are why this hook resolves candidates.
  describe('tooling-layout resolution', () => {
    const LIB_SRC = path.join(REPO_ROOT, 'scripts', 'lib', 'sensitive-paths.mjs');

    /** Build a throwaway repo with the hook at its canonical path. */
    function scaffold(libRelDir) {
      const root = fs.mkdtempSync(path.join(FIXTURE_DIR, 'layout-'));
      fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
      fs.copyFileSync(HOOK, path.join(root, '.claude', 'hooks', 'syntax-check.mjs'));
      if (libRelDir) {
        const libDir = path.join(root, ...libRelDir);
        fs.mkdirSync(libDir, { recursive: true });
        fs.copyFileSync(LIB_SRC, path.join(libDir, 'sensitive-paths.mjs'));
      }
      const target = path.join(root, 'broken.mjs');
      fs.writeFileSync(target, BROKEN_MJS);
      return { hook: path.join(root, '.claude', 'hooks', 'syntax-check.mjs'), target };
    }

    function runAt(hookPath, target) {
      const r = spawnSync('node', [hookPath], {
        input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: target, new_string: 'x' } }),
        encoding: 'utf-8',
        timeout: 10000,
      });
      return r.stdout.trim();
    }

    it('fires under the CONSUMER layout (scripts/.claude-skills/lib)', () => {
      const { hook, target } = scaffold(['scripts', '.claude-skills', 'lib']);
      const out = runAt(hook, target);
      assert.ok(out.length > 0, 'hook must resolve the isolated consumer tooling tree');
      assert.match(JSON.parse(out).systemMessage, /Syntax error/);
    });

    it('fires under the SOURCE layout (scripts/lib)', () => {
      const { hook, target } = scaffold(['scripts', 'lib']);
      const out = runAt(hook, target);
      assert.ok(out.length > 0, 'hook must resolve the source tooling tree');
    });

    it('checks NOTHING when no layout resolves — cannot prove the file is safe', () => {
      const { hook, target } = scaffold(null);
      assert.equal(runAt(hook, target), '', 'no classifier ⇒ no read, no advisory');
    });
  });

  it('handles Write as well as Edit', () => {
    const abs = fixture('written.mjs', BROKEN_MJS);
    const r = runHook({ tool_name: 'Write', tool_input: { file_path: abs, content: BROKEN_MJS } });
    assert.match(JSON.parse(r.stdout).systemMessage, /written\.mjs/);
  });
});
