/**
 * @fileoverview fleetSupports (docs/plans/fleet-handover-winddown.md §2.5, proposal f17b): what a repo's OWN fleet CLI
 * accepts, asked of its flag table. Three answers kept apart — true, false (a LOADED table without it) and 'unknown'
 * (the table could not be read) — each with a control that fires the other way.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupFleetRoots, tmpRoot } from './helpers/fleet-repo.mjs';
import { _resetCapabilityCache, argvModuleFor, fleetSupports } from '../scripts/lib/fleet/fleet-capability.mjs';
import { switchWaitRecipe } from '../scripts/lib/fleet/handover-render.mjs';

after(cleanupFleetRoots);

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONSUMER_CLI = 'node scripts/.claude-skills/fleet.mjs';

/** A consumer whose synced tree carries `argvSource` as its flag table (undefined = no file at all). */
function consumer(argvSource) {
  const repo = tmpRoot('cap-');
  if (argvSource !== undefined) {
    const dir = path.join(repo, 'scripts', '.claude-skills', 'lib', 'fleet');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'argv.mjs'), argvSource);
  }
  return repo;
}
const table = (touchRepeat) => `export const VERBS = { touch: { bool: ['--json'], value: ['--id'], repeat: ${JSON.stringify(touchRepeat)}, positionals: [0, 0] } };\n`;

describe('fleetSupports', () => {
  it('the table is derived from the CLI path: the source repo and a consumer resolve to their own argv.mjs', () => {
    assert.equal(argvModuleFor('/r', 'node scripts/fleet.mjs'), path.join(path.resolve('/r', 'scripts'), 'lib', 'fleet', 'argv.mjs'));
    assert.equal(argvModuleFor('/r', CONSUMER_CLI), path.join(path.resolve('/r', 'scripts', '.claude-skills'), 'lib', 'fleet', 'argv.mjs'));
    assert.equal(argvModuleFor('/r', 'node'), null);
  });

  it('true when the table lists the flag; false when it LOADS and does not (control: the same fixture with the flag)', () => {
    _resetCapabilityCache();
    assert.equal(fleetSupports(consumer(table(['--waiting-on', '--unwait'])), CONSUMER_CLI, 'touch', '--unwait'), true);
    assert.equal(fleetSupports(consumer(table(['--waiting-on'])), CONSUMER_CLI, 'touch', '--unwait'), false, 'a bundle that predates --unwait');
    assert.equal(fleetSupports(consumer(table(['--waiting-on'])), CONSUMER_CLI, 'touch'), true, 'no flag asked: the verb alone');
  });

  it('a verb absent from a LOADED table is false, not unknown (H4)', () => {
    _resetCapabilityCache();
    assert.equal(fleetSupports(consumer(table(['--unwait'])), CONSUMER_CLI, 'propose'), false);
  });

  it("'unknown' when the table cannot be read: no file, a syntax error, or no VERBS export — never false", () => {
    _resetCapabilityCache();
    assert.equal(fleetSupports(consumer(undefined), CONSUMER_CLI, 'touch', '--unwait'), 'unknown');
    assert.equal(fleetSupports(consumer('export const VERBS = {'), CONSUMER_CLI, 'touch', '--unwait'), 'unknown');
    assert.equal(fleetSupports(consumer('export const OTHER = 1;\n'), CONSUMER_CLI, 'touch', '--unwait'), 'unknown');
  });

  it("'unknown' on a timeout or a runner that returns nothing parseable", () => {
    _resetCapabilityCache();
    const repo = consumer(table(['--unwait']));
    assert.equal(fleetSupports(repo, CONSUMER_CLI, 'touch', '--unwait', { spawn: () => ({ status: null, stdout: '', error: new Error('ETIMEDOUT') }) }), 'unknown');
    assert.equal(fleetSupports(repo, CONSUMER_CLI, 'touch', '--unwait', { spawn: () => ({ status: 0, stdout: 'not json' }) }), 'unknown');
  });

  it('this repo\'s own CLI supports --unwait and propose; a nonsense verb is false (control)', () => {
    _resetCapabilityCache();
    assert.equal(fleetSupports(REPO_ROOT, 'node scripts/fleet.mjs', 'touch', '--unwait'), true);
    assert.equal(fleetSupports(REPO_ROOT, 'node scripts/fleet.mjs', 'propose'), true);
    assert.equal(fleetSupports(REPO_ROOT, 'node scripts/fleet.mjs', 'no-such-verb'), false);
  });

  it('the answer is remembered per table and verb (one child process, not one per claim)', () => {
    _resetCapabilityCache();
    const repo = consumer(table(['--unwait']));
    assert.equal(fleetSupports(repo, CONSUMER_CLI, 'touch', '--unwait'), true);
    fs.rmSync(path.join(repo, 'scripts'), { recursive: true });
    assert.equal(fleetSupports(repo, CONSUMER_CLI, 'touch', '--unwait'), true, 'served from the memo');
  });
});

describe('switchWaitRecipe — no branch ever offers a clear-all (H3)', () => {
  const unwait = 'node scripts/.claude-skills/fleet.mjs touch --id w --unwait human:account-switch';
  it('true prints the targeted drop unchanged', () => {
    assert.equal(switchWaitRecipe(unwait, true, '/c/aio'), unwait);
  });
  it('M6: a repo name with spaces or shell characters is quoted in the sync step, never interpolated raw', () => {
    const text = switchWaitRecipe(unwait, false, '/c/my repo; rm -rf x');
    assert.match(text, /--target (['"])my repo; rm -rf x\1\)/);
    assert.doesNotMatch(text, /--target my repo/);
  });
  it('false says to sync first and then run the drop; unknown prints the drop with the same fallback', () => {
    const f = switchWaitRecipe(unwait, false, '/c/aio');
    assert.match(f, /predates --unwait: sync this repo's fleet first \(from the source repo: npm run sync -- --target aio\), then run node scripts/);
    const u = switchWaitRecipe(unwait, 'unknown', '/c/aio');
    assert.ok(u.startsWith(unwait), u);
    assert.match(u, /if it refuses --unwait/);
    for (const text of [f, u]) assert.doesNotMatch(text, /--clear-waiting|--waiting-on/);
  });
});
