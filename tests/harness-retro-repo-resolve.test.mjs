/**
 * Harness retro — canonical repo identity for a session cwd (plan §2 c3).
 * git and identity are injected: the cases are path SHAPES, not this machine's repos.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRepoResolver, heuristicMainRoot } from '../scripts/lib/friction/retro/repo-resolve.mjs';

const ids = { 'C:/GIT/alpha': 'uuid-alpha', 'D:/work/alpha': 'uuid-alpha-2' };
function fakeDeps({ existing = [], toplevels = {} } = {}) {
  return {
    dirExists: (p) => existing.includes(p),
    runGit: (args, cwd) => toplevels[cwd] ?? null,
    resolveIdentity: (root) => (ids[root] ? { repoUuid: ids[root], name: root.split('/').pop(), source: 'origin-url' } : { repoUuid: 'x', name: 'x', source: 'path-fallback' }),
  };
}

describe('heuristicMainRoot', () => {
  it('maps a linked worktree and a fleet worktree to the main checkout', () => {
    assert.equal(heuristicMainRoot('C:\\GIT\\alpha\\.claude\\worktrees\\wt-1\\src'), 'C:\\GIT\\alpha');
    assert.equal(heuristicMainRoot('C:\\GIT\\.fleet-wt\\alpha\\chips\\x'), 'C:\\GIT\\alpha');
    assert.equal(heuristicMainRoot('/c/GIT/alpha/.claude/worktrees/w'), '/c/GIT/alpha');
  });
  it('leaves an ordinary path alone', () => {
    assert.equal(heuristicMainRoot('C:\\tmp\\x'), 'C:\\tmp\\x');
  });
});

describe('createRepoResolver', () => {
  it('a subdirectory resolves through git toplevel', () => {
    const r = createRepoResolver(fakeDeps({ existing: ['C:/GIT/alpha/src'], toplevels: { 'C:/GIT/alpha/src': 'C:/GIT/alpha' } }));
    assert.deepEqual(r.resolve('C:/GIT/alpha/src'), { repoUuid: 'uuid-alpha', name: 'alpha', root: 'C:/GIT/alpha' });
  });

  it('a DELETED worktree falls back to its main root', () => {
    const r = createRepoResolver(fakeDeps({ existing: ['C:/GIT/alpha'], toplevels: { 'C:/GIT/alpha': 'C:/GIT/alpha' } }));
    assert.equal(r.resolve('C:/GIT/alpha/.claude/worktrees/gone-1').repoUuid, 'uuid-alpha');
  });

  it('two repos with one basename keep distinct identities', () => {
    const r = createRepoResolver(fakeDeps({
      existing: ['C:/GIT/alpha', 'D:/work/alpha'],
      toplevels: { 'C:/GIT/alpha': 'C:/GIT/alpha', 'D:/work/alpha': 'D:/work/alpha' },
    }));
    assert.notEqual(r.resolve('C:/GIT/alpha').repoUuid, r.resolve('D:/work/alpha').repoUuid);
  });

  it('a non-repo temp dir, or a path-fallback identity, is unresolved — never guessed', () => {
    const r = createRepoResolver(fakeDeps({ existing: ['C:/tmp/snap', 'C:/GIT/noremote'], toplevels: { 'C:/GIT/noremote': 'C:/GIT/noremote' } }));
    assert.equal(r.resolve('C:/tmp/snap'), null);
    assert.equal(r.resolve('C:/GIT/noremote'), null);
  });

  it('caches per cwd', () => {
    let calls = 0;
    const deps = fakeDeps({ existing: ['C:/GIT/alpha'], toplevels: { 'C:/GIT/alpha': 'C:/GIT/alpha' } });
    const r = createRepoResolver({ ...deps, runGit: (...a) => { calls++; return deps.runGit(...a); } });
    r.resolve('C:/GIT/alpha'); r.resolve('C:/GIT/alpha');
    assert.equal(calls, 1);
  });
});
