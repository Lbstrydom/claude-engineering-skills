/**
 * @fileoverview Second work-consumer report (2026-11-15), item 8: `fleet <verb> --help` printed nothing useful (it was refused
 * as an unknown flag), and a claim bound to a worktree without the gitignored synced tooling gave no hint before the
 * session's first command died on MODULE_NOT_FOUND.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cleanupFleetRoots, makeFleetRepo, runFleet, scrubbedEnv } from './helpers/fleet-repo.mjs';
import { VERBS, knownFlagsFor, verbHelp } from '../scripts/lib/fleet/argv.mjs';
import { missingToolingWarning } from '../scripts/lib/fleet/bundle-stamp.mjs';

after(cleanupFleetRoots);

describe('per-verb --help', () => {
  const fx = makeFleetRepo();
  const run = (args) => runFleet(args, { cwd: fx.repo, env: scrubbedEnv() });

  it('claim --help exits 0 and lists its flags (it used to be refused as an unknown flag)', () => {
    const r = run(['claim', '--help']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^usage: fleet claim/);
    assert.match(r.stdout, /--intent <value>/);
    assert.match(r.stdout, /--waiting-on <value> {3}\(repeatable\)/);
  });

  it('every verb answers --help and -h with exit 0', () => {
    for (const verb of Object.keys(VERBS)) {
      const r = run([verb, verb === 'lease' ? '-h' : '--help']);
      assert.equal(r.status, 0, `${verb}: ${r.stdout}${r.stderr}`);
      assert.match(r.stdout, new RegExp(`^usage: fleet ${verb}`), verb);
    }
  });

  it('lease <sub> --help names that sub-command\'s flags; a --help after -- belongs to the command, not to fleet', () => {
    const r = run(['lease', 'run', '--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /sub-command run accepts: --json, --kind, --for, --wait, --timeout/);
    // The flag list is run's own: no flag of another sub-command (audit R1 M7).
    assert.match(r.stdout, /^usage: fleet lease run \[flags\]/);
    assert.doesNotMatch(r.stdout, /^ {2}--force$/m);
    assert.doesNotMatch(r.stdout, /^ {2}--pid <value>$/m);
    const passthrough = run(['lease', 'run', '--json', '--', 'node', '--help']);
    assert.equal(passthrough.status, 2, 'the run is refused for --json, not answered with help');
    assert.doesNotMatch(passthrough.stdout, /^usage:/);
  });

  it('the help lists exactly the flags the parser accepts', () => {
    for (const verb of Object.keys(VERBS)) {
      const listed = [...verbHelp(verb).matchAll(/^ {2}(--[a-z-]+)/gm)].map((m) => m[1]).sort();
      assert.deepEqual(listed, [...knownFlagsFor(verb)].sort(), verb);
    }
  });
});

describe('claim names the hydrate command when the worktree lacks the synced tooling', () => {
  const consumerDir = path.join('C:', 'consumer', 'scripts', '.claude-skills');
  it('consumer layout + missing tooling → the exact command', () => {
    const w = missingToolingWarning({ scriptDir: consumerDir, worktree: 'C:/wt/chip-a' }, { exists: () => false });
    assert.match(w, /C:\/wt\/chip-a has no synced tooling .*run `npm run skills:hydrate` in that worktree/);
  });
  it('silent when the tooling is there, outside the consumer layout, or with no worktree', () => {
    assert.equal(missingToolingWarning({ scriptDir: consumerDir, worktree: 'C:/wt/chip-a' }, { exists: () => true }), null);
    assert.equal(missingToolingWarning({ scriptDir: path.join('C:', 'ces', 'scripts'), worktree: 'C:/wt/x' }, { exists: () => false }), null);
    assert.equal(missingToolingWarning({ scriptDir: consumerDir, worktree: null }, { exists: () => false }), null);
  });
});
