import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// Defect c28c2850 (second half): `--fix --yes` printed "Applied N" from the
// dry-run PREVIEW and discarded the real run's result, so a failed write was
// invisible and the exit code never said so. A real EPERM is Windows-only
// (a read-only target), so a --import preload makes the one rename for AGENTS.md
// fail on every platform without changing what the CLI does.

const CLI = path.resolve(import.meta.dirname, '..', '..', 'scripts', 'claudemd-lint.mjs');

const tmpDirs = [];
function mkTmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tmpDirs.length) {
    try { fs.rmSync(tmpDirs.pop(), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best-effort */ }
  }
});

function buildRepo() {
  const repo = mkTmp('autofix-cli-');
  // Two instruction files, each carrying one standalone stale link. Scan order
  // is not part of the contract: assertions below key on the file name.
  fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# Claude\n\n[gone](docs/gone-claude.md)\n');
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# Agents\n\n[gone](docs/gone-agents.md)\n');
  return repo;
}

function runFix(repo, { failRenameFor } = {}) {
  const args = [];
  if (failRenameFor) {
    const preload = path.join(mkTmp('autofix-preload-'), 'fail-rename.mjs');
    fs.writeFileSync(preload, [
      "import fs from 'node:fs';",
      'const real = fs.renameSync;',
      `const target = ${JSON.stringify(failRenameFor)};`,
      'fs.renameSync = (from, to) => {',
      '  if (String(to).endsWith(target)) {',
      "    throw Object.assign(new Error('read-only file system'), { code: 'EROFS' });",
      '  }',
      '  return real(from, to);',
      '};',
      '',
    ].join('\n'));
    args.push('--import', pathToFileURL(preload).href);
  }
  args.push(CLI, '--fix', '--yes');
  return spawnSync(process.execPath, args, { cwd: repo, encoding: 'utf-8' });
}

describe('claudemd-lint --fix --yes — reports the REAL result (c28c2850)', () => {
  it('a failed write is named, counted, skipped from "Applied", and exits 3; the other file is still fixed', () => {
    const repo = buildRepo();
    const r = runFix(repo, { failRenameFor: 'AGENTS.md' });

    assert.equal(r.status, 3, `a failed --fix write must exit 3, got ${r.status}\n${r.stderr}`);
    assert.match(r.stderr, /Applied 1 fixes/, 'the count is the real run\'s, not the preview\'s 2');
    assert.doesNotMatch(r.stderr, /Applied 2 fixes/);
    assert.match(r.stderr, /AGENTS\.md:3 — write failed: EROFS/, 'the failed group is listed with its reason');
    assert.match(r.stderr, /1 file write\(s\) failed/);
    assert.match(r.stdout, /claudemd-lint: 2 files/, 'the summary line is still printed and drained');
    assert.equal(fs.readFileSync(path.join(repo, 'CLAUDE.md'), 'utf-8'), '# Claude\n\n', 'the other file WAS fixed');
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8'), '# Agents\n\n[gone](docs/gone-agents.md)\n', 'the failed file is untouched');
  });

  it('negative control: with no write failure both files are fixed, "Applied 2", and the findings-based exit code is kept', () => {
    const repo = buildRepo();
    const r = runFix(repo);

    assert.match(r.stderr, /Applied 2 fixes/);
    assert.doesNotMatch(r.stderr, /write failed/);
    assert.notEqual(r.status, 3, `no write failed, so exit must not be 3\n${r.stderr}`);
    assert.equal(fs.readFileSync(path.join(repo, 'AGENTS.md'), 'utf-8'), '# Agents\n\n');
  });
});
