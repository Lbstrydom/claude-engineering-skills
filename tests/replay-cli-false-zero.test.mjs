/**
 * @fileoverview `learning/replay.mjs` must not report an UNMEASURED replay as a
 * clean one, and must not quietly drop the scope it was given.
 *
 * THE DEFECTS (final-review shadow findings 63ab8be9 / ced3dd98 / e18b1e39):
 *  - `--repo owner/repo` (a NAME — the flag is UUID-only) went straight into the
 *    query, matched nothing, and the CLI printed a `sampleSize: 0` comparison at
 *    exit 0, with a markdown report of zero deltas: a false zero.
 *  - Any empty window — cloud off, unknown repo id, quiet decision type — did
 *    the same, because `ok` was derived from "no exception", not "measured".
 *  - `--repo=<uuid>` passed `assertKnownFlags` (it validates the name half) and
 *    was then read with `indexOf('--repo')`, so the filter was silently dropped
 *    and the replay ran over EVERY repo.
 *  - The envelope was hand-written with `process.stdout.write` and the process
 *    ended with a bare `process.exit`, outside both the `emit()` coupling and
 *    the stdout-drain rule.
 *
 * Spawned with an EMPTY DSN (the air-gap signal), so nothing here can reach a
 * store: an empty window is exactly what cloud-off produces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'scripts', 'learning', 'replay.mjs');

function run(...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO,
    encoding: 'utf8',
    env: { ...process.env, AUDIT_DB_URL: '', AUDIT_POSTGRES_URL: '', LEARNING_DISABLE: '' },
    timeout: 60_000,
  });
  const lines = String(r.stdout || '').trim().split('\n').filter(Boolean);
  let envelope = null;
  try { envelope = JSON.parse(lines.at(-1)); } catch { /* asserted below */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, envelope, lines };
}

describe('replay CLI — an unmeasured replay is a failure, not a zero', () => {
  it('a repo NAME passed to the UUID-only --repo is refused before any read', () => {
    const r = run('pass_selection', '--repo', 'owner/repo');
    assert.notEqual(r.status, 0, `a name where a UUID belongs must not exit 0:\n${r.stderr}`);
    assert.equal(r.envelope?.ok, false, `expected a machine-readable failure envelope, got ${r.stdout}`);
    assert.match(r.envelope.error, /invalid-repo-id/);
  });

  it('an empty window exits non-zero with ok:false (cloud off ⇒ nothing measured)', () => {
    const r = run('pass_selection');
    assert.notEqual(r.status, 0, `sampleSize 0 must not read as a clean comparison:\n${r.stdout}`);
    assert.equal(r.envelope?.ok, false);
    assert.match(r.envelope.error, /empty-window/);
    assert.equal(r.lines.length, 1, 'exactly one machine-readable line on stdout');
  });

  it('the markdown format does not render a zero-delta table for an empty window', () => {
    const r = run('pass_selection', '--format', 'markdown');
    assert.notEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /Replay report/, 'no report for a replay that measured nothing');
  });

  it('--repo-id=<uuid> (the equals form) reaches the query, not just the validator', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const r = run('pass_selection', `--repo-id=${id}`);
    assert.match(r.stderr, new RegExp(`repoId=${id}`), `the equals-form filter was dropped:\n${r.stderr}`);
  });
});
