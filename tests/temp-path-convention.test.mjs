/**
 * @fileoverview Contract: no literal temp root in shipped script source, plus
 * the `scratchPath()` behaviour that replaces it.
 *
 * Why this is a gate and not a doc line: a literal temp root names a DIFFERENT
 * directory per shell — git-bash/MSYS rewrites a `/tmp` argv to
 * `%LOCALAPPDATA%\Temp`, Node resolves a literal `'/tmp'` path to
 * `<drive>:\tmp`, and `os.tmpdir()` returns `%LOCALAPPDATA%\Temp`. One such
 * straggler already cost a full mis-triage. These files also SYNC to consumer
 * repos, so a single bad example teaches every agent that greps the bundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { scratchPath, scratchDir, _internals } from '../scripts/lib/temp-paths.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_ROOT = path.join(REPO_ROOT, 'scripts');

/**
 * Temp ROOT only — quote- or separator-terminated so `/tmpfs`, a `/tmpl` inside
 * a URL, and `.tmp` suffixes don't match. Mirrors the `literal-temp-root`
 * quickfix pattern; both exist because they catch it at different moments
 * (edit time vs push time).
 */
const LITERAL_TEMP_ROOT = /['"`](?:\/tmp|\/var\/tmp|[A-Za-z]:[\\/]{1,2}tmp)(?:['"`]|[\\/])/;

/**
 * Comment lines are exempt: the hazard is worth DOCUMENTING, and the matchers
 * that detect it must spell it. A line carrying real code cannot start with a
 * comment marker, so this exempts prose without exempting violations — and it
 * needs no hand-maintained allowlist to drift.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      yield* walk(full);
    } else if (entry.isFile() && /\.(mjs|js)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe('contract: no literal temp root in scripts/', () => {
  it('every temp path is scratchPath() or os.tmpdir()', () => {
    const violations = [];
    for (const file of walk(SCAN_ROOT)) {
      const rel = path.relative(REPO_ROOT, file).replaceAll(path.sep, '/');
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!LITERAL_TEMP_ROOT.test(line)) return;
        if (COMMENT_LINE.test(line)) return;
        violations.push(`${rel}:${i + 1}  ${line.trim().slice(0, 110)}`);
      });
    }
    assert.deepEqual(
      violations,
      [],
      `Literal temp root(s) found — these resolve to different directories under ` +
      `git-bash, Node-on-Windows and Linux:\n  ${violations.join('\n  ')}\n\n` +
      `Read later by a human/agent/next step? → scratchPath(...) from scripts/lib/temp-paths.mjs.\n` +
      `Disposable within the run?            → fs.mkdtempSync(path.join(os.tmpdir(), 'prefix-')).`
    );
  });
});

describe('scratchPath', () => {
  it('is anchored to the repo, at the one known scratch location', () => {
    const p = scratchPath('contract-check', 'x.json');
    assert.ok(path.isAbsolute(p), 'must be absolute — the point is an unambiguous path');
    assert.ok(p.startsWith(REPO_ROOT), `${p} should live under ${REPO_ROOT}`);
    assert.equal(scratchDir(), path.join(REPO_ROOT, '.claude', 'tmp'));
    // Deliberately NOT asserted: "the path is outside os.tmpdir()". The
    // pre-push sandbox checks out the repo INTO `%TEMP%`, so there a
    // repo-anchored path is legitimately also under the OS temp root and that
    // assertion failed on correct code. Repo-anchoring is the real invariant;
    // a regression to `os.tmpdir()` breaks the two assertions above.
  });

  it('creates the parent directory but not the file', () => {
    const p = scratchPath('contract-check', 'nested', 'y.json');
    assert.ok(fs.existsSync(path.dirname(p)), 'parent should exist');
    assert.ok(!fs.existsSync(p), 'the file itself should not be created');
  });

  it('refuses segments that escape the scratch directory', () => {
    assert.throws(() => scratchPath('..', '..', 'escaped.json'), /escape the scratch directory/);
  });

  it('is repo-anchored, not cwd-anchored', () => {
    // Several harnesses run scripts with cwd set to os.tmpdir(); the artifact
    // must still land in the repo.
    const before = process.cwd();
    try {
      process.chdir(os.tmpdir());
      assert.ok(scratchDir().startsWith(REPO_ROOT));
    } finally {
      process.chdir(before);
    }
  });

  it('resolves the repo root from the module, so the synced copy targets the consumer', () => {
    assert.equal(_internals.repoRoot(), REPO_ROOT);
  });
});
