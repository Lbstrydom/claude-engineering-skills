/**
 * @fileoverview Fleet feedback cluster 4 (#5, docs/plans/fleet-feedback-cluster4-shared-surface.md): a session marked `ready` on a
 * test SUBSET while its branch changed shared test files, then the train went red. `ready` and `next` now recommend the fast
 * tier when a branch touches a shared surface. Advice only: `ready` carries no test evidence, so nothing could honestly be required.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { git } from './helpers/git.mjs';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv, writeFile } from './helpers/fleet-repo.mjs';
import { DEFAULT_SHARED_GLOBS, SHARED_NAME_CAP, sharedSurfaceLine, sharedSurfaceTouched } from '../scripts/lib/fleet/shared-surface.mjs';
import { parseFleetConfig } from '../scripts/lib/fleet/config.mjs';
import { deriveObligations } from '../scripts/lib/fleet/obligations.mjs';

after(cleanupFleetRoots);
const COMMIT = ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m'];
const NOW = new Date('2026-11-22T10:00:00.000Z');

describe('which files are shared surfaces', () => {
  it('defaults to test helpers and fixtures, and the two helpers the coordinator named are in the set', () => {
    assert.deepEqual([...DEFAULT_SHARED_GLOBS], ['tests/helpers/**', 'tests/fixtures/**']);
    const got = sharedSurfaceTouched(['tests/helpers/fleet-serial-fx.mjs', 'tests/helpers/git-fixture-env.mjs', 'scripts/lib/x.mjs', 'tests/fixtures/poison/a.txt', 'tests/a.test.mjs'], undefined);
    assert.deepEqual(got, ['tests/fixtures/poison/a.txt', 'tests/helpers/fleet-serial-fx.mjs', 'tests/helpers/git-fixture-env.mjs']);
  });
  it('configured globs replace the defaults; an empty list turns the advice off', () => {
    assert.deepEqual(sharedSurfaceTouched(['contracts/a.json', 'tests/helpers/x.mjs'], { globs: ['contracts/**'] }), ['contracts/a.json']);
    assert.deepEqual(sharedSurfaceTouched(['tests/helpers/x.mjs'], { globs: [] }), []);
    assert.deepEqual(sharedSurfaceTouched([], undefined), []);
    assert.deepEqual(sharedSurfaceTouched(undefined, undefined), []);
  });
  it('the CES .fleet.json parses and names both helpers', () => {
    const cfg = JSON.parse(fs.readFileSync('.fleet.json', 'utf8'));
    const r = parseFleetConfig(cfg);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(sharedSurfaceTouched(['tests/helpers/fleet-serial-fx.mjs', 'tests/helpers/git-fixture-env.mjs'], r.value.sharedSurfaces).length, 2);
    assert.deepEqual(r.value.sharedSurfaces.run, ['npm', 'run', 'guards:preflight']);
  });
});

describe('the recommendation line', () => {
  it('is null when nothing shared was touched; otherwise names the files, the fast tier command, and that fleet cannot verify it ran', () => {
    assert.equal(sharedSurfaceLine([], undefined), null);
    const line = sharedSurfaceLine(['tests/helpers/a.mjs'], { run: ['npm', 'run', 'guards:preflight'] }, 'node scripts/fleet.mjs');
    assert.match(line, /^recommend: this branch changes 1 shared test file\(s\) \(tests\/helpers\/a\.mjs\)/);
    assert.ok(line.includes('`npm run guards:preflight`'), line);
    assert.match(line, /cannot tell whether you did/);
    assert.match(sharedSurfaceLine(['tests/helpers/a.mjs'], {}), /the fast tier this repo defines \(\.fleet\.json sharedSurfaces\.run names it\)/);
  });
  it('caps the names (the count stays exact) and renders control characters visibly', () => {
    const many = Array.from({ length: SHARED_NAME_CAP + 3 }, (_, i) => `tests/helpers/f${i}.mjs`);
    assert.match(sharedSurfaceLine(many, {}), new RegExp(`changes ${many.length} shared test file\\(s\\).*… 3 more`));
    assert.ok(!sharedSurfaceLine(['tests/helpers/a\nb.mjs'], {}).includes('a\nb'));
  });
});

describe('the config key', () => {
  it('accepts {globs, run}, and resolves the defaults when absent', () => {
    const none = parseFleetConfig({});
    assert.deepEqual(none.value.sharedSurfaces, { globs: [...DEFAULT_SHARED_GLOBS], run: null });
    const ok = parseFleetConfig({ sharedSurfaces: { globs: ['a/**'], run: ['npm', 'run', 'fast'] } });
    assert.deepEqual(ok.value.sharedSurfaces, { globs: ['a/**'], run: ['npm', 'run', 'fast'] });
    assert.deepEqual(parseFleetConfig({ sharedSurfaces: { globs: [] } }).value.sharedSurfaces.globs, []);
  });
  it('rejects an unknown inner key, a bad glob, and a shell-string run (argv only)', () => {
    assert.match(JSON.stringify(parseFleetConfig({ sharedSurfaces: { glob: ['a'] } })), /unknown key/);
    assert.match(JSON.stringify(parseFleetConfig({ sharedSurfaces: { globs: ['/abs/**'] } })), /sharedSurfaces\.globs\.0/);
    assert.equal(parseFleetConfig({ sharedSurfaces: { run: 'npm run fast' } }).ok, false);
  });
});

describe('fleet ready recommends the fast tier (through the real CLI)', () => {
  const world = (extra = null) => {
    const fx = makeFleetRepo({ fleetConfig: extra });
    git(['checkout', '-q', '-b', 'feat'], fx.repo);
    return fx;
  };
  const commit = (fx, files) => {
    for (const [f, body] of Object.entries(files)) { writeFile(fx.repo, f, body); git(['add', '--', f], fx.repo); }
    git([...COMMIT, 'work'], fx.repo);
  };
  const ready = (fx) => {
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off' });
    assert.equal(runFleet(['claim', '--id', 'feat', '--intent', 'work', '--paths', 'tests/helpers/**,src/**'], { cwd: fx.repo, env }).status, 0);
    const r = runFleet(['ready', '--json'], { cwd: fx.repo, env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return r.json;
  };
  it('a branch that changes a shared helper gets the recommendation, with the configured command, and is still marked ready', () => {
    const fx = world({ sharedSurfaces: { run: ['npm', 'run', 'fast'] } });
    commit(fx, { 'tests/helpers/shared.mjs': 'export const x = 1;\n' });
    const j = ready(fx);
    assert.equal(j.record.state, 'ready', 'advice only');
    assert.deepEqual(j.sharedSurface.touched, ['tests/helpers/shared.mjs']);
    assert.deepEqual(j.sharedSurface.run, ['npm', 'run', 'fast']);
    assert.ok(j.text.includes('recommend: this branch changes 1 shared test file(s) (tests/helpers/shared.mjs)'), j.text);
    assert.ok(j.text.includes('`npm run fast`'));
  });
  it('a branch that changes only ordinary source gets no recommendation (the control)', () => {
    const fx = world();
    commit(fx, { 'src/a.mjs': 'export const a = 1;\n' });
    const j = ready(fx);
    assert.deepEqual(j.sharedSurface.touched, []);
    assert.doesNotMatch(j.text, /recommend:/);
  });
  it('sharedSurfaces.globs: [] turns it off even for a helper change', () => {
    const fx = world({ sharedSurfaces: { globs: [] } });
    commit(fx, { 'tests/helpers/shared.mjs': 'export const x = 1;\n' });
    const j = ready(fx);
    assert.deepEqual(j.sharedSurface.touched, []);
    assert.doesNotMatch(j.text, /recommend:/);
  });
});

describe('fleet next carries it as an info obligation', () => {
  const item = (state = 'working') => ({ id: 's1', branch: 's1', state, overlaps: [], paths: [] });
  const derive = (myFiles, sharedSurfaces, state) => deriveObligations({ item: item(state), session: { id: 's1', state: state ?? 'working', paths: [] }, myFiles, sharedSurfaces, cmd: 'fleet', now: NOW });
  it('is raised for a shared file, as INFO (never a DO nobody can clear), naming the files', () => {
    const r = derive(['tests/helpers/fleet-serial-fx.mjs', 'src/a.mjs'], { globs: [...DEFAULT_SHARED_GLOBS], run: ['npm', 'run', 'guards:preflight'] });
    const o = r.obligations.find((x) => x.kind === 'shared-surface');
    assert.ok(o);
    assert.equal(o.act, 'info');
    assert.deepEqual(o.evidence.files, ['tests/helpers/fleet-serial-fx.mjs']);
    assert.ok(o.text.includes('npm run guards:preflight'));
  });
  it('is absent for ordinary files, when turned off, and for a retired session', () => {
    assert.equal(derive(['src/a.mjs'], undefined).obligations.some((x) => x.kind === 'shared-surface'), false);
    assert.equal(derive(['tests/helpers/a.mjs'], { globs: [] }).obligations.some((x) => x.kind === 'shared-surface'), false);
    assert.equal(derive(['tests/helpers/a.mjs'], undefined, 'done').obligations.some((x) => x.kind === 'shared-surface'), false);
  });
  it('an old caller that passes no sharedSurfaces still gets the defaults', () => {
    assert.equal(derive(['tests/fixtures/x.json'], undefined).obligations.some((x) => x.kind === 'shared-surface'), true);
  });
});
