/**
 * @fileoverview Tier-3 e2e: a path the sync REFUSES as diverged keeps its PRIOR manifest base — never the hash of the
 * content it planned to write, never the consumer's bytes (fleet proposals p-20261118013554-3260 / p-20261118010446-6353).
 *
 * The CLI always syncs from this checkout, so "upstream moved" cannot be staged by editing source. Instead the consumer's
 * manifest entry is seeded with a third value P, so the three candidates are distinguishable: P (prior base), V (what the
 * sync would write), Y (what the consumer holds).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const SUBJECT = '.claude/skills/fleet/references/chip-preamble.md'; // a rewritten destination, as in storyline
const MANIFEST = 'scripts/.sync-manifest.json';
const h = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

let tmp; let consumer;
const abs = (rel) => path.join(consumer, rel);
const readManifest = () => JSON.parse(fs.readFileSync(abs(MANIFEST), 'utf-8'));
const lastSync = () => JSON.parse(fs.readFileSync(abs('.sync-receipt.json'), 'utf-8')).recentSyncs[0];
const sync = () => runSyncCli(['--target-path', consumer, '--no-prompt']);
const commitAll = (msg) => { git(['add', '-A'], consumer); git(['commit', '-q', '-m', msg, '--no-gpg-sign', '--allow-empty'], consumer); };

before(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-refused-base-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid'], consumer);
  git(['config', 'user.name', 'Refused Base Test'], consumer);
  git(['config', 'core.autocrlf', 'false'], consumer);
  fs.writeFileSync(abs('package.json'), JSON.stringify({ name: 'refused-base-fixture', type: 'module' }, null, 2));
  seedInstalledDeps(consumer);
  fs.writeFileSync(abs('.gitignore'), '');
  commitAll('init');
});
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('a refused path keeps its prior manifest base', () => {
  let V; let P; let Pbody;
  it('sync 1 writes the subject and records the written hash', async () => {
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    V = h(fs.readFileSync(abs(SUBJECT)));
    assert.equal(readManifest().files[SUBJECT], V, 'a written path records the hash of the bytes written');
    commitAll('sync 1');
  });

  it('refusal carries the seeded prior base P, not the planned V nor the disk Y', async () => {
    Pbody = `${fs.readFileSync(abs(SUBJECT), 'utf-8')}\n<!-- an earlier upstream version we wrote -->\n`;
    P = h(Pbody);
    const m = readManifest(); m.files[SUBJECT] = P;
    fs.writeFileSync(abs(MANIFEST), JSON.stringify(m, null, 2) + '\n');
    const Ybody = `${fs.readFileSync(abs(SUBJECT), 'utf-8')}\n<!-- consumer edit -->\n`;
    fs.writeFileSync(abs(SUBJECT), Ybody);
    commitAll('consumer edit');
    const Y = h(Ybody);
    assert.ok(new Set([P, V, Y]).size === 3, 'positive control: the three candidates must differ');

    const r = await sync();
    assert.notEqual(r.code, 0, 'a refusal fails the run');
    assert.ok(lastSync().divergenceRefused.some((d) => d.path === SUBJECT), 'subject must be refused');
    assert.equal(fs.readFileSync(abs(SUBJECT), 'utf-8'), Ybody, 'consumer content untouched');
    const base = readManifest().files[SUBJECT];
    assert.notEqual(base, V, 'BUG: refused path recorded the PLANNED hash');
    assert.notEqual(base, Y, 'BUG: refused path recorded the CONSUMER bytes as our base');
    assert.equal(base, P);
  });

  it('a second refusal is stable (the guard is not inert on its second run)', async () => {
    const r = await sync();
    assert.notEqual(r.code, 0);
    assert.equal(readManifest().files[SUBJECT], P);
  });

  it('once disk equals the prior base, the next sync updates it normally', async () => {
    fs.writeFileSync(abs(SUBJECT), Pbody);
    commitAll('consumer back on our prior write');
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.ok(!lastSync().divergenceRefused.some((d) => d.path === SUBJECT));
    assert.equal(h(fs.readFileSync(abs(SUBJECT))), V);
    assert.equal(readManifest().files[SUBJECT], V);
  });
});
