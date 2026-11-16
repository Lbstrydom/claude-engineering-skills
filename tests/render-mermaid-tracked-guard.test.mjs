/**
 * Upstream c9ebd9f9 — render-mermaid.mjs must not rewrite a docs/architecture-map.md
 * the consumer TRACKS. Real git temp repos (no mocks) for the ownership check, plus a
 * cloud-off CLI run (no DB needed) for the end-to-end write behaviour.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  isTrackedByGit, resolveMapOutput, writeMapOutput, writeAbortStub, handleRenderFailure,
} from '../scripts/symbol-index/render-mermaid.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'symbol-index', 'render-mermaid.mjs');
const MAP_REL = 'docs/architecture-map.md';
const TRACKED_BODY = '# consumer-curated map\n';

// Fixture git must never be steered by GIT_* variables inherited from a hook or
// runner (pre-push runs the suite with GIT_DIR set): a temp repo's init/add/commit
// would otherwise land in the REAL repository.
const cleanEnv = () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM'].includes(k)) delete env[k];
  return env;
};

const git = (cwd, ...a) => {
  const r = spawnSync('git', a, { cwd, encoding: 'utf8', env: cleanEnv() });
  assert.equal(r.status, 0, `git ${a.join(' ')} failed: ${r.stderr}`);
};

/** A temp git repo; `track` decides whether the map is committed, ignored or absent. */
function makeRepo(root, name, mode) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@example.invalid');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  git(dir, 'add', 'README.md');
  if (mode === 'tracked') {
    fs.writeFileSync(path.join(dir, MAP_REL), TRACKED_BODY);
    git(dir, 'add', MAP_REL);
  } else if (mode === 'ignored') {
    fs.writeFileSync(path.join(dir, '.gitignore'), 'docs/architecture-map.md\n');
    git(dir, 'add', '.gitignore');
    fs.writeFileSync(path.join(dir, MAP_REL), TRACKED_BODY);
  } else if (mode === 'untracked') {
    fs.writeFileSync(path.join(dir, MAP_REL), TRACKED_BODY);
  }
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function runCli(cwd, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, ...extra], {
    cwd, encoding: 'utf8',
    // Empty AUDIT_DB_URL = air-gap: the store is off, so the cloud-off stub path runs.
    env: { ...cleanEnv(), AUDIT_DB_URL: '', AUDIT_ALLOW_FOREIGN_CWD: '1' },
  });
}

describe('render-mermaid tracked-output guard (c9ebd9f9)', () => {
  let tmp;
  const savedGitEnv = {};
  before(() => {
    // The ownership check reads process.env GIT_DIR/GIT_WORK_TREE (it refuses to
    // PROVE "no repo" when they are set), so a hook-exported value would flip the
    // not-a-repo expectations. Tests that need them set them explicitly.
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('GIT_')) { savedGitEnv[k] = process.env[k]; delete process.env[k]; }
    }
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-guard-'));
  });
  after(() => {
    Object.assign(process.env, savedGitEnv);
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  describe('isTrackedByGit — real git', () => {
    it('tracked / untracked / ignored are told apart', () => {
      for (const [mode, want] of [['tracked', 'tracked'], ['untracked', 'untracked'], ['ignored', 'untracked']]) {
        const dir = makeRepo(tmp, `own-${mode}`, mode);
        assert.equal(isTrackedByGit(path.join(dir, MAP_REL)).state, want, mode);
      }
    });

    it('a directory with no repository above it is not-a-repo', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-norepo-'));
      try {
        // Only meaningful when the OS temp dir is itself outside any repo.
        const r = isTrackedByGit(path.join(dir, MAP_REL));
        assert.equal(r.state, 'not-a-repo');
      } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    });

    it('each path is classified by ITS OWN absolute path (subdirectory repoRoot)', () => {
      const dir = makeRepo(tmp, 'subdir', 'untracked');
      const sub = path.join(dir, 'sub');
      fs.mkdirSync(path.join(sub, 'docs'), { recursive: true });
      fs.writeFileSync(path.join(sub, MAP_REL), TRACKED_BODY);
      git(dir, 'add', 'sub/docs/architecture-map.md');
      assert.equal(isTrackedByGit(path.join(sub, MAP_REL)).state, 'tracked');
      assert.equal(isTrackedByGit(path.join(dir, MAP_REL)).state, 'untracked');
    });

    it('the repo that OWNS the destination answers: a nested repo tracking the map is tracked', () => {
      const outer = makeRepo(tmp, 'outer', 'untracked');
      const inner = path.join(outer, 'vendor', 'inner');
      fs.mkdirSync(path.join(inner, 'docs'), { recursive: true });
      git(inner, 'init', '-q');
      git(inner, 'config', 'user.email', 't@example.invalid');
      git(inner, 'config', 'user.name', 't');
      git(inner, 'config', 'commit.gpgsign', 'false');
      fs.writeFileSync(path.join(inner, MAP_REL), TRACKED_BODY);
      git(inner, 'add', MAP_REL);
      git(inner, 'commit', '-q', '-m', 'i');
      assert.equal(isTrackedByGit(path.join(inner, MAP_REL)).state, 'tracked');
    });

    it('a symlinked docs/ is resolved to the real destination', (t) => {
      const target = makeRepo(tmp, 'symtarget', 'tracked');
      const other = makeRepo(tmp, 'symother', 'none');
      try { fs.symlinkSync(path.join(target, 'docs'), path.join(other, 'docs2'), 'junction'); }
      catch { t.skip('symlinks unavailable'); return; }
      assert.equal(isTrackedByGit(path.join(other, 'docs2', 'architecture-map.md')).state, 'tracked');
    });

    it('an alternate GIT_INDEX_FILE in the environment cannot hide a tracked map', () => {
      const dir = makeRepo(tmp, 'altindex', 'tracked');
      const empty = path.join(tmp, 'empty-index');
      const prev = process.env.GIT_INDEX_FILE;
      process.env.GIT_INDEX_FILE = empty;
      try { assert.equal(isTrackedByGit(path.join(dir, MAP_REL)).state, 'tracked'); }
      finally { if (prev === undefined) delete process.env.GIT_INDEX_FILE; else process.env.GIT_INDEX_FILE = prev; }
    });

    it('a dangling .git or an env-selected repo is indeterminate, not not-a-repo', (t) => {
      const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rm-dangling-'));
      try {
        fs.mkdirSync(path.join(base, 'docs'));
        const fail = () => ({ status: 128, stdout: '', stderr: 'fatal', error: null });
        try { fs.symlinkSync(path.join(base, 'nowhere'), path.join(base, '.git'), 'junction'); }
        catch { t.skip('symlinks unavailable'); return; }
        assert.equal(isTrackedByGit(path.join(base, MAP_REL), fail).state, 'indeterminate');
        fs.rmSync(path.join(base, '.git'), { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
        assert.equal(isTrackedByGit(path.join(base, MAP_REL), fail).state, 'not-a-repo');
        process.env.GIT_DIR = path.join(base, 'elsewhere');
        try { assert.equal(isTrackedByGit(path.join(base, MAP_REL), fail).state, 'indeterminate'); }
        finally { delete process.env.GIT_DIR; }
      } finally { fs.rmSync(base, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
    });

    it('a tracked map whose docs/ is missing from the working tree is still tracked', () => {
      const dir = makeRepo(tmp, 'nodocsdir', 'tracked');
      fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      assert.equal(isTrackedByGit(path.join(dir, MAP_REL)).state, 'tracked');
    });

    it('inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE for ANOTHER repo cannot redirect the query', () => {
      const outer = makeRepo(tmp, 'envouter', 'untracked');
      const inner = makeRepo(path.join(outer, 'vendor'), 'inner', 'tracked');
      const saved = {};
      const set = { GIT_DIR: path.join(outer, '.git'), GIT_WORK_TREE: outer, GIT_INDEX_FILE: path.join(tmp, 'no-index') };
      for (const [k, v] of Object.entries(set)) { saved[k] = process.env[k]; process.env[k] = v; }
      try {
        // GIT_DIR in the env means absence of a repo can never be PROVEN, but a
        // successful query answers authoritatively and must be the inner repo's.
        assert.equal(isTrackedByGit(path.join(inner, MAP_REL)).state, 'tracked');
      } finally {
        for (const k of Object.keys(set)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
      }
    });

    it('git missing (spawn error) is indeterminate, never a licence to write', () => {
      const dir = makeRepo(tmp, 'enoent', 'tracked');
      const r = isTrackedByGit(path.join(dir, MAP_REL), () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT') }));
      assert.equal(r.state, 'indeterminate');
    });

    it('a failing query INSIDE a repo is indeterminate whatever the stderr says', () => {
      const dir = makeRepo(tmp, 'dubious', 'tracked');
      for (const stderr of ['fatal: detected dubious ownership', "fatal: Besitzer unbekannt (localised)", '']) {
        const r = isTrackedByGit(path.join(dir, MAP_REL), () => ({ status: 128, stdout: '', stderr, error: null }));
        assert.equal(r.state, 'indeterminate', stderr);
      }
    });
  });

  describe('resolveMapOutput', () => {
    const outPath = '/r/docs/architecture-map.md';
    it('tracked → null path and a warning naming BOTH remedies', () => {
      const r = resolveMapOutput({ outPath, outExplicit: false, ownership: () => ({ state: 'tracked' }) });
      assert.equal(r.outPath, null);
      assert.match(r.warning, /SKIPPED map write/);
      assert.match(r.warning, /git rm --cached/);
      assert.match(r.warning, /\.gitignore/);
      assert.match(r.warning, /arch:render -- --out/);
    });
    it('indeterminate → null path and the git detail', () => {
      const r = resolveMapOutput({ outPath, outExplicit: false, ownership: () => ({ state: 'indeterminate', detail: 'boom' }) });
      assert.equal(r.outPath, null);
      assert.match(r.warning, /boom/);
    });
    it('untracked / not-a-repo → writes as today, no warning (positive control)', () => {
      for (const state of ['untracked', 'not-a-repo']) {
        const r = resolveMapOutput({ outPath, outExplicit: false, ownership: () => ({ state }) });
        assert.deepEqual(r, { outPath, warning: null });
      }
    });
    it('explicit --out overrides even a tracked path, without consulting git', () => {
      const r = resolveMapOutput({ outPath, outExplicit: true, ownership: () => { throw new Error('must not be called'); } });
      assert.deepEqual(r, { outPath, warning: null });
    });
  });

  describe('write seams honour a null path', () => {
    it('writeMapOutput / writeAbortStub write nothing for null and write for a path', () => {
      const f = path.join(tmp, 'seam.md');
      assert.equal(writeMapOutput(null, 'x'), false);
      writeAbortStub(null, 'n', 'r', 'h');
      assert.equal(fs.existsSync(f), false);
      assert.equal(writeMapOutput(f, 'x'), true);
      assert.equal(fs.readFileSync(f, 'utf8'), 'x');
      writeAbortStub(f, 'n', 'r', 'h');
      assert.match(fs.readFileSync(f, 'utf8'), /Status: r/);
    });
    it('render-failure path with a null path re-throws the ORIGINAL error and touches nothing', () => {
      const dir = makeRepo(tmp, 'failpath', 'tracked');
      const file = path.join(dir, MAP_REL);
      const orig = new Error('render died');
      assert.throws(() => handleRenderFailure(orig, {
        repoRoot: dir, outPath: null, identityName: 'x', cleanup: () => true, log: () => {},
      }), (e) => e === orig);
      assert.equal(fs.readFileSync(file, 'utf8'), TRACKED_BODY);
    });
  });

  describe('CLI end-to-end (cloud-off)', () => {
    it('tracked default → bytes unchanged, exit 0, SKIPPED warning', () => {
      const dir = makeRepo(tmp, 'cli-tracked', 'tracked');
      const r = runCli(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /SKIPPED map write/);
      assert.equal(fs.readFileSync(path.join(dir, MAP_REL), 'utf8'), TRACKED_BODY);
      assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf8', env: cleanEnv() }).stdout.trim(), '');
    });
    it('tracked map with docs/ deleted from the working tree → still skipped, not recreated', () => {
      const dir = makeRepo(tmp, 'cli-nodocs', 'tracked');
      fs.rmSync(path.join(dir, 'docs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      const r = runCli(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stderr, /SKIPPED map write/);
      assert.equal(fs.existsSync(path.join(dir, 'docs')), false);
    });
    it('observed-deps cleanup still runs when the map is skipped', () => {
      const dir = makeRepo(tmp, 'cli-observed', 'tracked');
      const obs = path.join(dir, '.audit-loop', 'domain-deps-observed.json');
      fs.mkdirSync(path.dirname(obs), { recursive: true });
      fs.writeFileSync(obs, '{}');
      const r = runCli(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(fs.existsSync(obs), false);
    });
    it('untracked default → stub written as today (positive control)', () => {
      const dir = makeRepo(tmp, 'cli-untracked', 'untracked');
      const r = runCli(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /SKIPPED/);
      assert.match(fs.readFileSync(path.join(dir, MAP_REL), 'utf8'), /audit-loop:architectural-map/);
    });
    it('ignored default → stub written as today (CES shape)', () => {
      const dir = makeRepo(tmp, 'cli-ignored', 'ignored');
      const r = runCli(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.match(fs.readFileSync(path.join(dir, MAP_REL), 'utf8'), /audit-loop:architectural-map/);
    });
    it('explicit --out overrides the guard on a tracked map', () => {
      const dir = makeRepo(tmp, 'cli-override', 'tracked');
      const r = runCli(dir, ['--out', MAP_REL]);
      assert.equal(r.status, 0, r.stderr);
      assert.doesNotMatch(r.stderr, /SKIPPED/);
      assert.match(fs.readFileSync(path.join(dir, MAP_REL), 'utf8'), /audit-loop:architectural-map/);
    });
  });
});
