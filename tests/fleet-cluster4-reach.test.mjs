/**
 * @fileoverview Cluster 4 (#5), the part that makes the recommendation actionable: WHICH tests load the changed shared files,
 * and saying so when that (or the changed-file list itself) could not be worked out. See fleet-cluster4.test.mjs.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, writeFile } from './helpers/fleet-repo.mjs';
import { REACH_NAME_CAP, sharedSurfaceLine, testsLoading } from '../scripts/lib/fleet/shared-surface.mjs';
import { deriveObligations } from '../scripts/lib/fleet/obligations.mjs';

after(cleanupFleetRoots);
const NOW = new Date('2026-11-22T10:00:00.000Z');
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m'];

describe('which tests load the shared files', () => {
  const files = {
    'tests/helpers/fx.mjs': 'export const fx = 1;\n',
    'tests/helpers/wrap.mjs': "import { fx } from './fx.mjs'; export const w = fx;\n",
    'tests/fixtures/data.json': '{}\n',
    'tests/direct.test.mjs': "import { fx } from './helpers/fx.mjs';\n",
    'tests/via-wrapper.test.mjs': "import { w } from './helpers/wrap.mjs';\n",
    'tests/reads-fixture.test.mjs': "const p = 'tests/fixtures/data.json';\n",
    'tests/unrelated.test.mjs': "import fs from 'node:fs';\n",
    'tests/dynamic.test.mjs': "await import('./helpers/fx.mjs');\n",
  };
  const io = (over = {}) => ({ repoFiles: Object.keys(files), readFile: (f) => { if (over.fail?.includes(f)) throw new Error('EACCES'); return files[f]; } });

  it('finds direct importers, importers through another helper, literal dynamic imports and tests that name a fixture path', () => {
    const r = testsLoading(['tests/helpers/fx.mjs', 'tests/fixtures/data.json'], io());
    assert.deepEqual(r.tests, ['tests/direct.test.mjs', 'tests/dynamic.test.mjs', 'tests/reads-fixture.test.mjs', 'tests/via-wrapper.test.mjs']);
    assert.equal(r.unread, 0);
  });
  it('walks through PRODUCTION modules (a shared contract under scripts/) and through a helper that names an asset by path', () => {
    const f = {
      'scripts/lib/contract.mjs': 'export const c = 1;\n',
      'scripts/lib/user.mjs': "import { c } from './contract.mjs'; export const u = c;\n",
      'tests/uses-user.test.mjs': "import { u } from '../scripts/lib/user.mjs';\n",
      'tests/fixtures/a.json': '{}\n',
      'tests/helpers/loads-a.mjs': "export const p = 'tests/fixtures/a.json';\n",
      'tests/via-helper.test.mjs': "import { p } from './helpers/loads-a.mjs';\n",
      'tests/other.test.mjs': "export {};\n",
    };
    const io2 = { repoFiles: Object.keys(f), readFile: (x) => f[x] };
    assert.deepEqual(testsLoading(['scripts/lib/contract.mjs'], io2).tests, ['tests/uses-user.test.mjs']);
    assert.deepEqual(testsLoading(['tests/fixtures/a.json'], io2).tests, ['tests/via-helper.test.mjs']);
  });
  it('recognises every name Node discovers as a test, not only *.test.*', () => {
    const f = {
      'tests/helpers/h.mjs': 'export {};\n',
      'tests/a.test.mjs': "import './helpers/h.mjs';\n", 'tests/b-test.mjs': "import './helpers/h.mjs';\n", 'tests/c_test.mjs': "import './helpers/h.mjs';\n",
      'tests/test-d.mjs': "import './helpers/h.mjs';\n", 'tests/test.mjs': "import './helpers/h.mjs';\n", 'tests/latest.mjs': "import './helpers/h.mjs';\n",
    };
    const r = testsLoading(['tests/helpers/h.mjs'], { repoFiles: Object.keys(f), readFile: (x) => f[x] });
    assert.deepEqual(r.tests, ['tests/a.test.mjs', 'tests/b-test.mjs', 'tests/c_test.mjs', 'tests/test-d.mjs', 'tests/test.mjs']);
  });
  it('matches a fixture named relative to the reading file (new URL(...)), not only by its repo-relative path', () => {
    const f = {
      'tests/fixtures/d.json': '{}\n',
      'tests/reads.test.mjs': "const u = new URL('./fixtures/d.json', import.meta.url);\n",
      'tests/sub/deeper.test.mjs': "const u = new URL('../fixtures/d.json', import.meta.url);\n",
      'tests/no.test.mjs': "const u = new URL('./fixtures/other.json', import.meta.url);\n",
    };
    const r = testsLoading(['tests/fixtures/d.json'], { repoFiles: Object.keys(f), readFile: (x) => f[x] });
    assert.deepEqual(r.tests, ['tests/reads.test.mjs', 'tests/sub/deeper.test.mjs']);
  });
  it('a helper that was DELETED (absent from the tracked files) still links the tests that import its old path', () => {
    const f = { 'tests/old.test.mjs': "import './helpers/gone.mjs';\n" };
    const r = testsLoading(['tests/helpers/gone.mjs'], { repoFiles: Object.keys(f), readFile: (x) => f[x] });
    assert.deepEqual(r.tests, ['tests/old.test.mjs']);
  });
  it('the line says so with NO tests found, reports unread independently, always labels the reach best-effort, and names a generic fast tier when none is configured', () => {
    const none = sharedSurfaceLine(['tests/helpers/a.mjs'], {}, 'fleet', { ok: true, tests: [], unread: 3 });
    assert.ok(none.includes('no test file was found that loads them statically, which does not mean none does'), none);
    assert.ok(none.includes('3 test/source file(s) could not be read'));
    assert.ok(none.includes('static and best-effort'));
    assert.ok(none.includes('the fast tier this repo defines'));
    const found = sharedSurfaceLine(['tests/helpers/a.mjs'], {}, 'fleet', { ok: true, tests: ['tests/x.test.mjs'], unread: 0 });
    assert.ok(found.includes('all 1 of the 1 test file(s) found loading them: `node --test tests/x.test.mjs`'), found);
    assert.ok(found.includes('and the fast tier this repo defines'), 'tests found but no run configured: the generic fast tier is still named');
  });
  it('next carries the complete reach in the obligation evidence', () => {
    const r = deriveObligations({ item: { id: 's1', branch: 's1', state: 'working', overlaps: [], paths: [] }, session: { id: 's1', state: 'working', paths: [] }, myFiles: ['tests/helpers/x.mjs'], sharedReach: { ok: true, tests: ['tests/a.test.mjs', 'tests/b.test.mjs'], unread: 1 }, cmd: 'fleet', now: NOW });
    const o = r.obligations.find((x) => x.kind === 'shared-surface');
    assert.deepEqual(o.evidence.reach, { ok: true, tests: ['tests/a.test.mjs', 'tests/b.test.mjs'], unread: 1, reason: null });
  });
  it('an unrelated test is not listed (the control), and a shared file nobody loads yields none', () => {
    assert.equal(testsLoading(['tests/helpers/fx.mjs'], io()).tests.includes('tests/unrelated.test.mjs'), false);
    assert.deepEqual(testsLoading(['tests/helpers/orphan.mjs'], io()).tests, []);
  });
  it('an unreadable test file is COUNTED, never read as "does not load it"', () => {
    const r = testsLoading(['tests/helpers/fx.mjs'], io({ fail: ['tests/direct.test.mjs'] }));
    assert.equal(r.unread, 1);
    assert.equal(r.tests.includes('tests/direct.test.mjs'), false);
  });
  it('the line names the tests as one quoted command, caps the list with the exact count, and says what it could not read', () => {
    const many = Array.from({ length: REACH_NAME_CAP + 4 }, (_, i) => `tests/t${i}.test.mjs`);
    const line = sharedSurfaceLine(['tests/helpers/a.mjs'], { run: ['npm', 'run', 'fast'] }, 'fleet', { ok: true, tests: many, unread: 2 });
    assert.ok(line.includes(`the first ${REACH_NAME_CAP} of the ${many.length} test file(s) found loading them: \`node --test `), line);
    assert.ok(line.includes(`that command is PARTIAL — all ${many.length} are in the JSON as sharedSurface.tests`));
    assert.ok(line.includes('2 test/source file(s) could not be read'));
    assert.ok(line.includes('and the fast tier `npm run fast`'));
    assert.ok(line.includes('static and best-effort'));
  });
  it('an unavailable reach is said, and the generic sentence still stands when there is nothing else to name', () => {
    const line = sharedSurfaceLine(['tests/helpers/a.mjs'], {}, 'fleet', { ok: false, reason: 'git ls-files failed' });
    assert.ok(line.includes('which tests load them could not be worked out (git ls-files failed)'), line);
  });
});

describe('through the real CLI', () => {
  it('ready names the tests that import the changed helper, as a runnable command', () => {
    const fx = makeFleetRepo();
    git(['checkout', '-q', '-b', 'feat'], fx.repo);
    writeFile(fx.repo, 'tests/helpers/shared.mjs', 'export const x = 1;\n');
    writeFile(fx.repo, 'tests/uses-shared.test.mjs', "import { x } from './helpers/shared.mjs';\n");
    git(['add', '--', 'tests/helpers/shared.mjs', 'tests/uses-shared.test.mjs'], fx.repo);
    git([...COMMIT, 'work'], fx.repo);
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    assert.equal(runFleet(['claim', '--id', 'feat', '--intent', 'work', '--paths', 'tests/**'], { cwd: fx.repo, env }).status, 0);
    const r = runFleet(['ready', '--json'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.json.sharedSurface.checked, true);
    assert.deepEqual(r.json.sharedSurface.tests, ['tests/uses-shared.test.mjs']);
    assert.ok(r.json.text.includes('node --test tests/uses-shared.test.mjs'), r.json.text);
  });
});

describe('next says so when it could not look', () => {
  const item = { id: 's1', branch: 's1', state: 'working', overlaps: [], paths: [] };
  const session = { id: 's1', state: 'working', paths: [] };
  it('unreadable changed files raise an info note (never "checked, none"); off means off', () => {
    const r = deriveObligations({ item, session, myFiles: [], filesUnknown: ['committed files: base not measured'], cmd: 'fleet', now: NOW });
    const o = r.obligations.find((x) => x.kind === 'shared-surface-unmeasured');
    assert.ok(o && o.act === 'info');
    assert.match(o.text, /shared test files were not checked \(committed files: base not measured\)/);
    const off = deriveObligations({ item, session, myFiles: [], filesUnknown: ['x'], sharedSurfaces: { globs: [] }, cmd: 'fleet', now: NOW });
    assert.equal(off.obligations.some((x) => x.kind === 'shared-surface-unmeasured'), false);
  });
  it('a shared file with a reach names the tests in the obligation text', () => {
    const reach = { ok: true, tests: ['tests/a.test.mjs'], unread: 0 };
    const r = deriveObligations({ item, session, myFiles: ['tests/helpers/x.mjs'], sharedReach: reach, cmd: 'fleet', now: NOW });
    assert.ok(r.obligations.find((x) => x.kind === 'shared-surface').text.includes('node --test tests/a.test.mjs'));
  });
});
