/**
 * @fileoverview 2221 - the divergence guard must tell a STALE snapshot (disk equals an earlier upstream version) from a consumer EDIT.
 * A Copilot consumer's sync was refused on an out-of-date `expected-schema.json` that nobody had touched; the guard worked but
 * called stale content "changed since our last sync". The source repo's history answers the question.
 *
 * Both directions are pinned: a stale snapshot is written, and a real edit - or anything git could not answer - still refuses.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BASE_STATE, ACTION, decideAction, describeReason, createPriorUpstreamResolver,
} from '../scripts/lib/sync-divergence.mjs';

const sha = (s) => createHash('sha256').update(s).digest('hex');
const diverged = { baseState: BASE_STATE.DIVERGED, overrideActive: false, allowOverwriteDiverged: false };
const committed = { tracked: true, matchesHead: true, staleSyncRef: null };

describe('decideAction - prior upstream version', () => {
  test('a diverged file equal to an earlier upstream version is WRITTEN quietly (not write-loud: nothing of the consumer is replaced)', () => {
    const d = decideAction({ ...diverged, vcs: { ...committed, priorUpstream: true } });
    assert.equal(d.action, ACTION.WRITE);
    assert.equal(d.reason, 'diverged-prior-upstream');
    assert.match(describeReason(d.reason), /earlier upstream version/);
  });

  test('NEGATIVE CONTROLS: false, null and absent all still refuse', () => {
    for (const priorUpstream of [false, null, undefined]) {
      const d = decideAction({ ...diverged, vcs: { ...committed, priorUpstream } });
      assert.equal(d.action, ACTION.REFUSE, String(priorUpstream));
      assert.equal(d.reason, 'diverged-committed');
    }
  });

  test('the stale-checkout remedy (pull) is not overridden: writing there would block the very pull that fixes it', () => {
    const d = decideAction({ ...diverged, vcs: { ...committed, staleSyncRef: 'chore/sync-abc', priorUpstream: true } });
    assert.equal(d.action, ACTION.REFUSE);
    assert.equal(d.reason, 'diverged-stale-checkout');
  });

  test('an override still wins over everything', () => {
    const d = decideAction({ ...diverged, overrideActive: true, vcs: { ...committed, priorUpstream: true } });
    assert.equal(d.action, ACTION.HOLD);
  });
});

describe('createPriorUpstreamResolver - on a real source repository', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
  const makeSource = (versions, file = 'tests/fixtures/expected-schema.json') => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-up-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.email', 't@example.com');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'core.autocrlf', 'false');
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(require('path').dirname(${JSON.stringify(join(dir, file))}),{recursive:true})`]);
    for (const [i, v] of versions.entries()) {
      writeFileSync(join(dir, file), v);
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', `v${i}`);
    }
    return dir;
  };
  const SRC = 'tests/fixtures/expected-schema.json';

  test('disk equal to v1 of three upstream versions -> true; to an unrelated edit -> false', () => {
    const dir = makeSource(['{"v":1}\n', '{"v":2}\n', '{"v":3}\n']);
    try {
      const r = createPriorUpstreamResolver({ sourceRoot: dir });
      assert.equal(r.matches(SRC, sha('{"v":1}\n')), true);
      assert.equal(r.matches(SRC, sha('{"v":2}\n')), true);
      assert.equal(r.matches(SRC, sha('{"v":1,"mine":true}\n')), false, 'a consumer edit matches no upstream version');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('a CRLF copy of an earlier version (a Windows consumer) matches too', () => {
    const dir = makeSource(['a\nb\n', 'c\n']);
    try {
      const r = createPriorUpstreamResolver({ sourceRoot: dir });
      assert.equal(r.matches(SRC, sha('a\r\nb\r\n')), true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  test('git unable to answer -> null (today\'s refusal), never false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prior-up-nogit-'));
    try {
      const r = createPriorUpstreamResolver({ sourceRoot: dir });
      assert.equal(r.matches(SRC, sha('x')), null);
      assert.equal(r.matches(SRC, null), null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('createPriorUpstreamResolver - bounded work (audit R1 M2)', () => {
  /** An instrumented git: N blobs per path, every path shares the same history blobs. */
  const fakeGit = (blobsPerPath, calls) => (args, { input } = {}) => {
    calls.push(args[0]);
    if (args[0] === 'log') {
      const lines = Array.from({ length: blobsPerPath }, (_, i) => `:100644 100644 ${'0'.repeat(39)}1 ${String(i + 1).padStart(40, 'a')} M\tx`);
      return { status: 0, stdout: Buffer.from(`${lines.join('\n')}\n`) };
    }
    const oids = String(input).trim().split('\n');
    const out = oids.map((o) => `${o} blob 3\nabc\n`).join('');
    return { status: 0, stdout: Buffer.from(out) };
  };

  test('100 diverged paths sharing history: one log per path, ONE batch call in total (cache reuse), blobs read once', () => {
    const calls = [];
    const r = createPriorUpstreamResolver({ sourceRoot: '.', git: fakeGit(5, calls) });
    for (let i = 0; i < 100; i++) assert.equal(r.matches(`p${i}`, sha('nope')), false);
    assert.equal(r.stats.logCalls, 100);
    assert.equal(r.stats.batchCalls, 1, 'the shared blobs are fetched once and cached');
    assert.equal(r.stats.blobsRead, 5);
    assert.equal(calls.filter((c) => c === 'cat-file').length, 1);
  });

  test('the total budget cuts the lookup off: later paths answer null, exhausted is flagged', () => {
    const calls = [];
    const r = createPriorUpstreamResolver({ sourceRoot: '.', totalBudget: 4, git: fakeGit(5, calls) });
    assert.equal(r.matches('p0', sha('nope')), null, 'five blobs exceed a budget of four');
    assert.equal(r.stats.exhausted, true);
    assert.equal(r.stats.blobsRead, 0);
  });

  test('NEGATIVE CONTROL: within budget the same input answers false, not null', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: '.', totalBudget: 5, git: fakeGit(5, []) });
    assert.equal(r.matches('p0', sha('nope')), false);
    assert.equal(r.stats.exhausted, false);
  });
});
