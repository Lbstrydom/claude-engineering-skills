/**
 * @fileoverview 2221 end to end, through the real `sync-to-repos.mjs` against a real git repository: a consumer whose tracked
 * `.audit-loop/expected-schema.json` is merely an OLDER upstream version (a stale snapshot) is brought up to date, while a
 * consumer who edited it is still refused. Tier 3 (consumer sync contract): the decision table is unit-tested next door; this
 * proves the WIRING in the sync loop, which is where `priorUpstream` is asked and handed to `decideAction`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_REL = 'tests/fixtures/expected-schema.json';
const DST_REL = '.audit-loop/expected-schema.json';
const stripAnsi = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');

let tmp;
let consumer;
const sync = () => runSyncCli(['--target-path', consumer, '--no-prompt']);
const read = (rel) => fs.readFileSync(path.join(consumer, rel), 'utf-8');
const sourceBlob = (rev) => execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${SRC_REL}`], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

before(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-stale-snap-')));
  consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid'], consumer);
  git(['config', 'user.name', 'Stale Snapshot Test'], consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: 'stale-snapshot-fixture', type: 'module' }, null, 2));
  seedInstalledDeps(consumer);
  fs.writeFileSync(path.join(consumer, '.gitignore'), '');
  git(['add', '-A'], consumer);
  git(['commit', '-m', 'init', '--no-gpg-sign'], consumer);
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('a stale snapshot of a generated artifact is updated, not refused (2221)', () => {
  let current;
  let olderRev;
  it('fixture: the source holds several versions of the file and an OLDER one differs from the current', () => {
    current = fs.readFileSync(path.join(REPO_ROOT, SRC_REL), 'utf-8').replace(/\r\n/g, '\n');
    const revs = execFileSync('git', ['-C', REPO_ROOT, 'log', '--format=%H', '-n', '40', '--', SRC_REL], { encoding: 'utf-8' }).split('\n').filter(Boolean);
    olderRev = revs.find((r) => sourceBlob(r).replace(/\r\n/g, '\n') !== current);
    assert.ok(olderRev, 'positive control: no older version of the fixture exists in this checkout - the test cannot be meaningful (shallow clone?)');
  });

  it('first sync writes the current file; the consumer commits it', async () => {
    const r = await sync();
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.equal(read(DST_REL).replace(/\r\n/g, '\n'), current);
    git(['add', '-A'], consumer);
    git(['commit', '-m', 'sync', '--no-gpg-sign'], consumer);
  });

  it('the consumer holds an OLDER upstream version, committed: the next sync replaces it, loudly, without a refusal', async () => {
    fs.writeFileSync(path.join(consumer, DST_REL), sourceBlob(olderRev));
    git(['add', '-A'], consumer);
    git(['commit', '-m', 'stale snapshot', '--no-gpg-sign'], consumer);
    const r = await sync();
    const out = stripAnsi(r.out);
    assert.equal(r.code, 0, whySyncFailed(r));
    assert.doesNotMatch(out, /REFUSED/, out.slice(-2500));
    assert.equal(read(DST_REL).replace(/\r\n/g, '\n'), current, 'the stale snapshot was not brought up to date');
    assert.match(out, /equals an earlier upstream version/, 'the replacement must be visible: it may have been a deliberate rollback');
  });

  it('NEGATIVE CONTROL: a consumer EDIT of that file (matches no upstream version) is still refused and left intact', async () => {
    const edited = `${current.replace(/\n$/, '')}\n`.replace(/\{/, '{ "consumerEdit": true,');
    fs.writeFileSync(path.join(consumer, DST_REL), edited);
    git(['add', '-A'], consumer);
    git(['commit', '-m', 'consumer edit', '--no-gpg-sign'], consumer);
    const r = await sync();
    const out = stripAnsi(r.out);
    assert.match(out, /REFUSED/, out.slice(-2500));
    assert.equal(read(DST_REL), edited, 'the consumer edit must survive the refusal');
  });
});
