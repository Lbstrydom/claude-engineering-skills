/**
 * @fileoverview CLI-level integration test for `scripts/sync-status.mjs`'s
 * `main()` — specifically, does `--repo-root` actually reach the printed
 * "safe to commit" suggestion, not just the pure `buildCommitSuggestion`
 * helper it wraps (already covered at the unit level in
 * `tests/sync-status.test.mjs`)?
 *
 * Upstream/audit finding "Repository Context Mismatch": "Status collection
 * honors `--repo-root`, but the suggested command includes neither `git -C`
 * nor a directory change. The repository inspected by the CLI can therefore
 * differ from the repository affected when the command is executed." The
 * underlying fix (main() resolves `repoRoot` from `--repo-root` and threads
 * it into `buildCommitSuggestion`) is present in `scripts/sync-status.mjs`
 * — this test is the missing regression lock proving the CLI's *own* wiring,
 * not just the lib function it calls.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import path from 'node:path';
import { initTempRepo, cleanupTempRepo } from './helpers/worktree-guard-args.mjs';
import { writeFile, sh, collectStream } from './helpers/fixtures.mjs';
import { hashFile } from '../scripts/lib/sync-manifest.mjs';
import { OWNED_SIDECAR_RELATIVE_PATH, OWNED_SIDECAR_VERSION } from '../scripts/lib/sync-owned-sidecar.mjs';
import { main } from '../scripts/sync-status.mjs';

const dirs = [];
after(() => { for (const d of dirs) cleanupTempRepo(d); });

/** A fresh fixture repo with a sidecar + manifest declaring `owned-file.mjs`
 * as sync-owned, its content hash matching, and left UNTRACKED (dirty) so
 * it classifies as syncOwned and triggers the "safe to commit" suggestion. */
function makeFixtureRepo() {
  const dir = initTempRepo('sync-status-cli-');
  dirs.push(dir);
  const ownedRel = 'owned-file.mjs';
  const ownedAbs = path.join(dir, ownedRel);
  const content = 'export const x = 1;\n';
  // Hash computed from content directly (crypto, not hashFile-on-disk) so the
  // file itself never has to exist before the sidecar/manifest commit below —
  // it must stay UNTRACKED afterward to be the one dirty entry the test reads.
  const hash = 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  writeFile(dir, OWNED_SIDECAR_RELATIVE_PATH, JSON.stringify({
    version: OWNED_SIDECAR_VERSION, source: 'test', comparison: 'case-insensitive',
    note: 'fixture', paths: [ownedRel],
  }));
  writeFile(dir, 'scripts/.sync-manifest.json', JSON.stringify({ files: { [ownedRel]: hash } }));
  // Commit ONLY the sidecar + manifest — owned-file.mjs is written AFTER, so
  // it lands untracked (the one dirty entry the report should classify).
  sh(dir, 'add', OWNED_SIDECAR_RELATIVE_PATH, 'scripts/.sync-manifest.json');
  sh(dir, 'commit', '-q', '-m', 'seed sidecar + manifest');
  writeFile(dir, ownedRel, content);
  assert.equal(hashFile(ownedAbs), hash, 'fixture sanity: the written file must hash to what the manifest declares');
  return dir;
}

describe('sync-status.mjs main() — --repo-root wiring', () => {
  it('the printed commit suggestion is pinned to --repo-root, not the process cwd', () => {
    const dir = makeFixtureRepo();
    const out = collectStream();
    const err = collectStream();
    const exitCode = main(['node', 'sync-status.mjs', '--repo-root', dir], out, err);
    assert.equal(exitCode, 0);
    const text = out.text();
    assert.match(text, /Sync-owned/, 'the fixture file must classify as sync-owned for the suggestion to print at all');
    const expected = new RegExp(`git --literal-pathspecs -C '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
    assert.match(text, expected, 'the suggested command must be pinned to the --repo-root directory, not cwd');
  });

  it('defaults to process.cwd() when --repo-root is omitted', () => {
    const dir = makeFixtureRepo();
    const priorCwd = process.cwd();
    process.chdir(dir);
    try {
      const out = collectStream();
      const err = collectStream();
      const exitCode = main(['node', 'sync-status.mjs'], out, err);
      assert.equal(exitCode, 0);
      const text = out.text();
      const expected = new RegExp(`-C '${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`);
      assert.match(text, expected);
    } finally {
      process.chdir(priorCwd);
    }
  });

  it('a --repo-root pointing at a DIFFERENT repo never mixes the two — git status runs there too, not just the suggestion text', () => {
    // The finding's own scenario: if git status ran against cwd while the
    // suggestion printed a different --repo-root, the report would describe
    // files that don't match the printed remedy at all.
    const target = makeFixtureRepo();
    const elsewhere = initTempRepo('sync-status-cli-elsewhere-');
    dirs.push(elsewhere);
    const priorCwd = process.cwd();
    process.chdir(elsewhere);
    try {
      const out = collectStream();
      const err = collectStream();
      const exitCode = main(['node', 'sync-status.mjs', '--repo-root', target], out, err);
      assert.equal(exitCode, 0);
      const text = out.text();
      assert.match(text, /owned-file\.mjs/, 'must report the TARGET repo\'s dirty file, not the empty elsewhere repo');
      assert.match(text, new RegExp(`-C '${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`));
    } finally {
      process.chdir(priorCwd);
    }
  });
});
