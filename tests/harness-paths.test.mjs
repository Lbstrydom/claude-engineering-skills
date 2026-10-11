/**
 * @fileoverview scripts/lib/harness-paths.mjs — the one resolver for the account's Claude Code
 * config root and harness memory/scheduled-task paths (docs/plans/fleet-handover.md §2b).
 *
 * The defect it closes: memory-paths.mjs hard-coded `~/.claude`, so an account with its own
 * CLAUDE_CONFIG_DIR resolved a memory dir nobody reads. Every case uses injected env/homedir —
 * never the real ~/.claude.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  SLUG_RE, claudeConfigDir, harnessMemoryDir, harnessProjectSlug, memoryDirForSlug, samePath, scheduledTasksDir,
} from '../scripts/lib/harness-paths.mjs';
import { resolveHarnessMemoryDir } from '../scripts/lib/memory-paths.mjs';

const HOME = path.resolve('/fake-home');

describe('claudeConfigDir', () => {
  it('CLAUDE_CONFIG_DIR wins when set', () => {
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: path.resolve('/acct-b/config') }, { homedir: HOME }), path.resolve('/acct-b/config'));
  });
  it('unset or blank falls back to <home>/.claude', () => {
    assert.equal(claudeConfigDir({}, { homedir: HOME }), path.join(HOME, '.claude'));
    assert.equal(claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, { homedir: HOME }), path.join(HOME, '.claude'));
  });
});

describe('harnessProjectSlug', () => {
  it('matches the verified harness rule (drive letter lowercased, every non-alphanumeric -> -)', () => {
    assert.equal(harnessProjectSlug('C:\\GIT\\claude-engineering-skills'), 'c--GIT-claude-engineering-skills');
    assert.equal(harnessProjectSlug('C:/GIT/wine-cellar-app'), 'c--GIT-wine-cellar-app');
    assert.match(harnessProjectSlug('C:\\GIT\\a b.c'), SLUG_RE);
  });
  it('memory-paths re-exports the SAME function (one rule, not two)', async () => {
    const mp = await import('../scripts/lib/memory-paths.mjs');
    assert.equal(mp.harnessProjectSlug, harnessProjectSlug);
  });
});

describe('harnessMemoryDir / memoryDirForSlug / scheduledTasksDir', () => {
  it('memory lives under the ACCOUNT config root', () => {
    const repo = path.resolve('/GIT/demo'); // portable: the slug derives from whatever path.resolve yields here
    const r = harnessMemoryDir({ repoRoot: repo, env: { CLAUDE_CONFIG_DIR: path.resolve('/acct-b') } });
    assert.equal(r.configDir, path.resolve('/acct-b'));
    assert.equal(r.dir, path.join(path.resolve('/acct-b'), 'projects', harnessProjectSlug(repo), 'memory'));
    assert.equal(r.exists, false);
  });
  it('memoryDirForSlug refuses a slug that could become a path', () => {
    assert.throws(() => memoryDirForSlug(HOME, '../escape'), /invalid harness project slug/);
    assert.throws(() => memoryDirForSlug(HOME, 'a/b'), /invalid harness project slug/);
    assert.equal(memoryDirForSlug(HOME, 'c--GIT-x'), path.join(HOME, 'projects', 'c--GIT-x', 'memory'));
  });
  it('scheduled tasks sit under the config root', () => {
    assert.equal(scheduledTasksDir(HOME), path.join(HOME, 'scheduled-tasks'));
  });
});

describe('resolveHarnessMemoryDir (friction mirror) now honours CLAUDE_CONFIG_DIR', () => {
  it('derived dir follows CLAUDE_CONFIG_DIR (was hard-coded ~/.claude)', () => {
    const repo = path.resolve('/GIT/demo');
    const r = resolveHarnessMemoryDir({ repoRoot: repo, env: { CLAUDE_CONFIG_DIR: path.resolve('/acct-b') } });
    assert.equal(r.source, 'derived');
    assert.equal(r.dir, path.join(path.resolve('/acct-b'), 'projects', harnessProjectSlug(repo), 'memory'));
  });
  it('FRICTION_MEMORY_DIR keeps precedence', () => {
    const r = resolveHarnessMemoryDir({ repoRoot: 'C:\\GIT\\demo', env: { FRICTION_MEMORY_DIR: path.resolve('/explicit'), CLAUDE_CONFIG_DIR: path.resolve('/acct-b') } });
    assert.deepEqual([r.source, r.dir], ['env', path.resolve('/explicit')]);
  });
});

describe('samePath', () => {
  it('is case-insensitive on win32 (C--GIT-storyline vs c--GIT-storyline) and exact elsewhere', () => {
    assert.equal(samePath('/x/C--GIT-storyline', '/x/c--GIT-storyline', 'win32'), true);
    assert.equal(samePath('/x/C--GIT-storyline', '/x/c--GIT-storyline', 'linux'), false);
    assert.equal(samePath('/x/a/', '/x/a', 'linux'), true);
    assert.equal(samePath('/x/a\\b', '/x/a/b', 'linux'), false, 'a POSIX backslash is a filename character, not a separator');
    assert.equal(samePath('C:\\x\\a', 'c:/x/a', 'win32'), true);
  });
});
