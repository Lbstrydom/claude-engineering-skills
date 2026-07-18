/**
 * @fileoverview Tests for the stale-suppression-pragma sweep added to
 * `arch:drift` (docs/plans/audit-code-duplication-wave.md, "Out of Scope
 * (Future)" mitigation for round-2 Gemini's wrongly_dismissed H4 finding).
 * Exercises the real `git grep`-backed scan against a throwaway temp git
 * repo — not a fake — since the false-positive this test guards against
 * (markdown documentation quoting the pragma's syntax as a placeholder
 * example) was found by actually running the sweep against this repo's own
 * AGENTS.md during implementation.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { findStalePragmas, renderStalePragmaSection } from '../scripts/lib/symbol-index/stale-pragma-sweep.mjs';

function mkGitRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-stale-pragma-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir });
  return dir;
}

function commitAll(dir) {
  execFileSync('git', ['add', '-A'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'x'], { cwd: dir });
}

describe('findStalePragmas — real git grep against a throwaway repo', () => {
  it('flags a pragma whose target file does not exist on disk', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(path.join(repo, 'a.mjs'), '// @duplicate-justification: target=nowhere.mjs:foo reason=x\nfunction foo() {}\n');
    commitAll(repo);
    const stale = findStalePragmas(repo);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].targetFile, 'nowhere.mjs');
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('does not flag a pragma whose target file exists', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(path.join(repo, 'canonical.mjs'), 'function foo() {}\n');
    fs.writeFileSync(path.join(repo, 'a.mjs'), '// @duplicate-justification: target=canonical.mjs:foo reason=x\nfunction foo() {}\n');
    commitAll(repo);
    const stale = findStalePragmas(repo);
    assert.equal(stale.length, 0);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('excludes markdown docs quoting the pragma syntax as a placeholder example (the false-positive found against this repo\'s own AGENTS.md)', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'Suppress with `// @duplicate-justification: target=<file>:<symbol> reason=<why>`\n');
    commitAll(repo);
    const stale = findStalePragmas(repo);
    assert.equal(stale.length, 0);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('excludes tests/ fixture files carrying synthetic pragmas with fake targets (found live against this repo\'s own duplication-wave test suite)', () => {
    const repo = mkGitRepo();
    fs.mkdirSync(path.join(repo, 'tests'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'tests', 'duplication-detector.test.mjs'),
      "fs.writeFileSync('a.mjs', '// @duplicate-justification: target=nowhere.mjs:foo reason=x\\n');\n",
    );
    commitAll(repo);
    const stale = findStalePragmas(repo);
    assert.equal(stale.length, 0);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('excludes a targetFile containing template-interpolation/placeholder syntax (source code BUILDING the pragma as instructional text, found live in this repo\'s own duplication-report.mjs recommendation string)', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(
      path.join(repo, 'a.mjs'),
      'const msg = `add // @duplicate-justification: target=${topMatch.filePath}:${topMatch.symbolName} reason=<why>`;\n',
    );
    commitAll(repo);
    const stale = findStalePragmas(repo);
    assert.equal(stale.length, 0);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('returns [] (never throws) when there are zero pragmas anywhere', () => {
    const repo = mkGitRepo();
    fs.writeFileSync(path.join(repo, 'a.mjs'), 'function foo() {}\n');
    commitAll(repo);
    assert.deepEqual(findStalePragmas(repo), []);
    fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});

describe('renderStalePragmaSection', () => {
  it('renders an empty string when there is nothing stale (no noise on the common case)', () => {
    assert.equal(renderStalePragmaSection([]), '');
  });

  it('renders a LOW-severity, non-blocking markdown table for stale entries', () => {
    const md = renderStalePragmaSection([{ file: 'a.mjs', line: 3, targetFile: 'gone.mjs' }]);
    assert.match(md, /LOW/);
    assert.match(md, /a\.mjs:3/);
    assert.match(md, /gone\.mjs/);
  });
});
