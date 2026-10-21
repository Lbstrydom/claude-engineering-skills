/**
 * @fileoverview `fleet lease` through the REAL CLI: two throwaway repos sharing ONE machine directory (the point of
 * the verb). Windows, peak hours, the unreadable file, argv and test hygiene. Plan: docs/plans/fleet-machine-lease.md.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { FLEET_CLI, cleanupFleetRoots, runFleet, scrubbedEnv, tmpRoot } from './helpers/fleet-repo.mjs';
import { T0, world } from './helpers/fleet-lease-world.mjs';

after(cleanupFleetRoots);

const rmDir = (d) => fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

describe('announced windows', () => {
  it('another repo\'s window refuses an overlapping acquire until it is shortened, or the window is cleared', () => {
    const w = world();
    const ann = w.runA(['lease', 'announce', '--kind', 'ci', '--until', '+60m', '--note', 'ci timing run']);
    assert.equal(ann.status, 0, ann.stderr + ann.stdout);
    const id = /window (w-\d{14}-[0-9a-f]{4})/.exec(ann.stdout)[1];
    const blocked = w.runB(['lease', 'acquire', '--for', '30']);
    assert.equal(blocked.status, 3); assert.match(blocked.stdout, /shorten --for/);
    assert.equal(w.runA(['lease', 'acquire', '--for', '30']).status, 0, 'a repo is not blocked by its own window');
    assert.equal(w.runA(['lease', 'release', '--end-turn']).status, 0, 'A has nothing further, so it yields its turn; B was queued by the refusal');
    assert.match(w.runB(['lease', 'status']).stdout, new RegExp(`window ${id}: ci for`));
    const cleared = w.runB(['lease', 'announce', '--clear-window', id]);
    assert.equal(cleared.status, 0); assert.match(cleared.stdout, /another repo/);
    assert.equal(w.read().events.at(-1).kind, 'window-cleared');
    assert.equal(w.runB(['lease', 'acquire', '--for', '30']).status, 0);
  });

  it('refuses a bad window with an argument error, and an over-limit one as refused', () => {
    const w = world();
    assert.equal(w.runA(['lease', 'announce', '--kind', 'ci']).status, 2);
    assert.equal(w.runA(['lease', 'announce', '--kind', 'bogus', '--until', '+5m']).status, 2);
    assert.equal(w.runA(['lease', 'announce', '--kind', 'ci', '--until', '+1500m']).status, 3, 'longer than 24 hours');
    assert.equal(w.runA(['lease', 'announce', '--clear-window', 'w-x', '--kind', 'ci']).status, 2, 'clear cannot be combined');
  });
});

describe('peak hours', () => {
  it('stores machine-local ranges, warns on a gate during peak without refusing, and clears', () => {
    const w = world();
    // @daily: the run must not depend on the weekday it executes on (a bare range is Mon-Fri, so it would flip at weekends).
    assert.equal(w.runA(['lease', 'peak', '--hours', '00:00-23:59@daily']).status, 0);
    assert.match(w.runA(['lease', 'status']).stdout, /peak hours \(machine-local\): 00:00-23:59@daily — PEAK NOW/);
    const g = w.runA(['lease', 'acquire']);
    assert.equal(g.status, 0); assert.match(g.stdout, /WARNING: this is a peak-cost hour/);
    assert.match(w.runB(['next']).stdout, /peak-cost hours now/);
    assert.equal(w.runA(['lease', 'peak', '--clear']).status, 0);
    assert.match(w.runA(['lease', 'status']).stdout, /peak hours: none set/);
    assert.equal(w.runA(['lease', 'peak']).status, 2, 'neither --hours nor --clear');
    assert.equal(w.runA(['lease', 'peak', '--hours', '9-12']).status, 2);
    assert.equal(w.runA(['lease', 'peak', '--hours', '09:00-12:00@someday']).status, 2, 'unknown day name');
  });
  it('a bare range is stored without days and printed as Mon-Fri; named days print back as given', () => {
    const w = world();
    const bare = w.runA(['lease', 'peak', '--hours', '14:00-20:00']);
    assert.equal(bare.status, 0, bare.stderr + bare.stdout);
    assert.match(bare.stdout, /14:00-20:00@mon-fri/);
    assert.deepEqual(w.read().peakHours, [{ from: '14:00', to: '20:00' }]);
    const wk = w.runA(['lease', 'peak', '--hours', '10:00-12:00@sat+sun', '--json']);
    assert.deepEqual(wk.json.peakHours, [{ from: '10:00', to: '12:00', days: [0, 6] }]);
    assert.match(w.runA(['lease', 'status']).stdout, /10:00-12:00@sat\+sun/);
  });
});

describe('an unreadable or newer file is never read as free', () => {
  it('malformed JSON: status and next say UNMEASURED, acquire is an error, release --force --reason keeps a copy and starts fresh', () => {
    const w = world();
    fs.mkdirSync(w.machine, { recursive: true });
    fs.writeFileSync(w.leaseFile, '{broken');
    const st = w.runA(['lease', 'status']);
    assert.equal(st.status, 1, 'an unmeasured lease must not exit 0: a script would read it as free (audit H5)');
    assert.match(st.stdout, /UNMEASURED: malformed JSON/);
    assert.equal(w.runA(['lease', 'status', '--json']).json.lease.measured, false);
    assert.match(w.runA(['next']).stdout, /machine lease unmeasured \(malformed JSON/);
    const acq = w.runA(['lease', 'acquire']);
    assert.equal(acq.status, 1); assert.match(acq.stderr + acq.stdout, /unreadable/);
    assert.equal(fs.readFileSync(w.leaseFile, 'utf8'), '{broken', 'nothing was changed');
    assert.equal(w.runA(['lease', 'release', '--force']).status, 2, 'needs --reason');
    const fix = w.runA(['lease', 'release', '--force', '--reason', 'hand edit broke it']);
    assert.equal(fix.status, 0, fix.stdout + fix.stderr);
    const copies = fs.readdirSync(w.machine).filter((n) => n.startsWith('lease.json.corrupt-'));
    assert.equal(copies.length, 1);
    assert.equal(fs.readFileSync(path.join(w.machine, copies[0]), 'utf8'), '{broken');
    assert.match(w.runA(['lease', 'status']).stdout, /heavy slot: FREE/);
    assert.equal(w.read().events[0].kind, 'corrupt-recovered');
  });

  it('a newer schemaVersion is read-only for this checkout: named as such, every mutation refused, the file untouched', () => {
    const w = world();
    fs.mkdirSync(w.machine, { recursive: true });
    const body = JSON.stringify({ schemaVersion: 9, anything: 'new' });
    fs.writeFileSync(w.leaseFile, body);
    const newer = w.runA(['lease', 'status']);
    assert.equal(newer.status, 1);
    assert.match(newer.stdout, /UNMEASURED: schemaVersion 9 is newer/);
    for (const args of [['lease', 'acquire'], ['lease', 'release', '--force', '--reason', 'x'], ['lease', 'peak', '--clear']]) {
      const r = w.runA(args);
      assert.equal(r.status, 1, args.join(' ')); assert.match(r.stderr + r.stdout, /newer fleet/);
    }
    assert.equal(fs.readFileSync(w.leaseFile, 'utf8'), body);
  });

  it('a lease file that is a symbolic link is refused, not followed', (t) => {
    const w = world();
    fs.mkdirSync(w.machine, { recursive: true });
    const real = path.join(w.machine, 'real.json'); fs.writeFileSync(real, '{}');
    try { fs.symlinkSync(real, w.leaseFile); } catch (e) { t.skip(`cannot create a symlink here (${e.code})`); return; }
    assert.match(w.runA(['lease', 'status']).stdout, /symbolic link/);
    assert.equal(w.runA(['lease', 'status']).status, 1);
    assert.equal(w.runA(['lease', 'acquire']).status, 1);
    assert.equal(fs.readFileSync(real, 'utf8'), '{}');
  });
});

describe('argv and configuration', () => {
  it('requires a known sub-command and refuses flags that sub-command does not take', () => {
    const w = world();
    assert.equal(w.runA(['lease']).status, 2);
    assert.equal(w.runA(['lease', 'bogus']).status, 2);
    assert.equal(w.runA(['lease', 'release', 'status']).status, 2, 'an extra positional must not run the first (audit M2)');
    assert.equal(w.runA(['lease', 'status', 'acquire']).status, 2);
    assert.ok(!fs.existsSync(w.leaseFile), 'nothing was written by the refused calls');
    assert.equal(w.runA(['lease', 'status', '--token', 'x']).status, 2);
    assert.equal(w.runA(['lease', 'acquire', '--hours', '09:00-10:00']).status, 2);
    assert.equal(w.runA(['lease', 'acquire', '--for', 'abc']).status, 2);
    assert.equal(w.runA(['lease', 'acquire', '--for', '0']).status, 2);
    assert.equal(w.runA(['lease', 'acquire', '--for', '181']).status, 2);
    assert.equal(w.runA(['lease', 'acquire', '--kind', 'bogus']).status, 2);
    assert.equal(w.runA(['lease', 'attach']).status, 2, 'attach needs --pid');
    // A zero pid is an argument error, not a schema crash (Gemini round 2 G2).
    for (const args of [['lease', 'attach', '--pid', '0'], ['lease', 'acquire', '--pid', '0'], ['lease', 'acquire', '--pid', '00']]) {
      const r = w.runA(args);
      assert.equal(r.status, 2, args.join(' ') + r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /unexpected error|ZodError/);
    }
    // A session id over 80 characters (a long branch name) is an argument error that names --id, never a schema crash (Gemini G1).
    const longId = 'feature/' + 'x'.repeat(90);
    for (const args of [['lease', 'acquire', '--id', longId], ['lease', 'release', '--id', longId], ['lease', 'announce', '--kind', 'ci', '--until', '+5m', '--id', longId]]) {
      const r = w.runA(args);
      assert.equal(r.status, 2, args[1] + r.stdout + r.stderr);
      assert.match(r.stderr, /1 to 80 characters/);
      assert.doesNotMatch(r.stderr, /unexpected error|ZodError/);
    }
    assert.equal(w.runA(['lease', 'acquire', '--id', 'x'.repeat(80)]).status, 0, 'exactly 80 is accepted');
    assert.equal(w.runA(['lease', 'release', '--reason', 'x']).status, 2, '--reason is only for --force');
  });

  it('a machine directory that is a file is an error naming it, not a stack trace and not an empty lease (audit H4)', () => {
    const w = world();
    const file = path.join(w.machine, 'imafile');
    fs.mkdirSync(w.machine, { recursive: true });
    fs.writeFileSync(file, 'x');
    for (const args of [['lease', 'status'], ['lease', 'acquire'], ['lease', 'peak', '--clear']]) {
      const r = w.runA(args, { FLEET_MACHINE_DIR: file });
      assert.equal(r.status, 1, args.join(' ') + r.stdout + r.stderr);
      assert.doesNotMatch(r.stderr, /unexpected error|at .*\.mjs/, 'a reported failure, not a stack trace');
    }
    assert.match(w.runA(['next'], { FLEET_MACHINE_DIR: file }).stdout, /machine lease unmeasured/);
  });

  it('a relative FLEET_MACHINE_DIR is a configuration error, not a silent default', () => {
    const w = world();
    const r = w.runA(['lease', 'status'], { FLEET_MACHINE_DIR: 'relative/dir' });
    assert.equal(r.status, 1); assert.match(r.stderr + r.stdout, /FLEET_MACHINE_DIR must be an absolute path/);
    assert.match(w.runA(['next'], { FLEET_MACHINE_DIR: 'relative/dir' }).stdout, /machine lease unmeasured \(FLEET_MACHINE_DIR must be an absolute path/);
  });

  it('with no FLEET_MACHINE_DIR the lease lives in <home>/.claude-fleet', () => {
    const w = world();
    const home = tmpRoot('fleet-home-');
    const env = scrubbedEnv({ FLEET_TELEMETRY: 'off', FLEET_NOW: T0, HOME: home, USERPROFILE: home });
    delete env.FLEET_MACHINE_DIR;
    const r = spawnSync(process.execPath, [FLEET_CLI, 'lease', 'acquire', '--for', '5'], { cwd: w.a.repo, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(path.join(home, '.claude-fleet', 'lease.json')), 'under the home directory');
    assert.equal(os.homedir() === home, false, 'the test process itself is untouched');
    rmDir(home);
  });
});

describe('test hygiene', () => {
  it('runFleet refuses an env that did not come from scrubbedEnv, so no test reads the real machine lease', () => {
    const w = world();
    assert.throws(() => runFleet(['status'], { cwd: w.a.repo, env: { ...process.env } }), /FLEET_MACHINE_DIR/);
  });
});
