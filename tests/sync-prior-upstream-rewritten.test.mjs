/**
 * @fileoverview Prior-upstream recognition (2221) for REWRITTEN destinations (fleet proposal p-20261118050838-b759).
 *
 * A consumer holding an EARLIER upstream version of a file the sync rewrites (`node scripts/x.mjs` -> `node scripts/.claude-skills/x.mjs`)
 * was refused as "diverged", because the resolver hashed RAW source blobs and a rewritten destination never holds raw bytes. The fix renders
 * each earlier blob through the SAME outbound renderer and compares rendered-to-rendered.
 *
 * Tier 3 (consumer sync contract). Sections: (1) the resolver on a deterministic disposable repository, (2) the wiring end to end through
 * the real CLI on the most recent older version of a live rewritten file, (3) the same for an unmanifested orphan, (4) storyline's exact
 * f3b37321 case as a labelled, history-dependent diagnostic.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import { createPriorUpstreamResolver } from '../scripts/lib/sync-divergence.mjs';
import { decideUnmanifested, renderOutbound } from '../scripts/lib/sync-outbound.mjs';
import { buildOwnedSourceTailsFromConsumerManifest } from '../scripts/lib/sync-rewriter.mjs';
import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const stripAnsi = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');
const rm = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

// ───────────────────────── 1. the resolver, deterministic ─────────────────────────
describe('createPriorUpstreamResolver - rendered earlier versions (rewritten destinations)', () => {
  const SRC = 'docs/a.md';
  const cfgFor = (tails) => ({ ownedSourceTails: new Set(tails) });
  const renderWith = (cfg) => (text) => renderOutbound({ srcRel: SRC, dstRel: SRC, srcContent: text, existingContent: null, rewriteConfig: cfg }).content;
  const V1 = '# a\nrun `node scripts/x.mjs --go` first\n';
  const V2 = '# a\nrun `node scripts/x.mjs --go` then `node scripts/y.mjs`\n';
  const V3 = '# a\nrun `node scripts/x.mjs --go`, `node scripts/y.mjs`, `node scripts/z.mjs`\n';
  const cfg = cfgFor(['x.mjs', 'y.mjs', 'z.mjs']);

  const makeSource = (versions, file = SRC) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prior-up-rw-'));
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf-8' });
    g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@example.com'); g('config', 'user.name', 't'); g('config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    for (const [i, v] of versions.entries()) {
      fs.writeFileSync(path.join(dir, file), v);
      g('add', '-A'); g('commit', '-q', '-m', `v${i}`);
    }
    return dir;
  };
  let dir;
  before(() => { dir = makeSource([V1, V2, V3]); });
  after(() => rm(dir));

  it('fixture control: today\'s renderer really rewrites these blobs, and the render differs from the raw bytes', () => {
    const r = renderOutbound({ srcRel: SRC, dstRel: SRC, srcContent: V1, existingContent: null, rewriteConfig: cfg });
    assert.ok(r.rewrite.hits > 0, 'the fixture must exercise a rewrite');
    assert.notEqual(r.content, V1);
  });

  it('disk == render(v1): OLD behaviour (no render) is false, with render it is true', () => {
    const disk = sha(renderWith(cfg)(V1));
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    assert.equal(r.matches(SRC, disk), false, 'negative control: the raw-only resolver cannot see a rendered earlier version');
    assert.equal(r.matches(SRC, disk, { render: renderWith(cfg), acceptRaw: false }), true);
  });

  it('a CRLF copy of the rendered earlier version matches too', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    const crlf = renderWith(cfg)(V1).replace(/\r?\n/g, '\r\n');
    assert.equal(r.matches(SRC, sha(crlf), { render: renderWith(cfg), acceptRaw: false }), true);
  });

  it('a hand edit of the rendered earlier version is NOT a match', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    const edited = `${renderWith(cfg)(V1)}my own note\n`;
    assert.equal(r.matches(SRC, sha(edited), { render: renderWith(cfg), acceptRaw: false }), false);
  });

  it('RAW historical bytes at a rewritten destination: refused with acceptRaw:false, accepted with acceptRaw:true (today\'s rule, unchanged)', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    assert.equal(r.matches(SRC, sha(V1), { render: renderWith(cfg), acceptRaw: false }), false, 'a consumer who removed the rewrites by hand made an edit');
    assert.equal(r.matches(SRC, sha(V1), { render: renderWith(cfg), acceptRaw: true }), true);
    assert.equal(r.matches(SRC, sha(V1)), true, 'no options at all is exactly the pre-existing raw behaviour');
  });

  it('two consumers with different rewrite configs share one resolver without sharing evidence', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    const cfgB = cfgFor(['x.mjs']); // consumer B owns fewer tails: y and z are left alone
    const diskA = sha(renderWith(cfg)(V3));
    const diskB = sha(renderWith(cfgB)(V3));
    assert.notEqual(diskA, diskB, 'fixture control: the two renders must differ');
    assert.equal(r.matches(SRC, diskA, { render: renderWith(cfg), acceptRaw: false }), true);
    assert.equal(r.matches(SRC, diskA, { render: renderWith(cfgB), acceptRaw: false }), false, 'A\'s bytes are not an earlier version under B\'s config');
    assert.equal(r.matches(SRC, diskB, { render: renderWith(cfgB), acceptRaw: false }), true);
  });

  it('a render that throws for ONE blob does not hide a genuine match on another, but turns "no match" into null', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    const flaky = (text) => { if (text === V2) throw new Error('boom'); return renderWith(cfg)(text); };
    assert.equal(r.matches(SRC, sha(renderWith(cfg)(V1)), { render: flaky, acceptRaw: false }), true);
    assert.equal(r.matches(SRC, sha('something else\n'), { render: flaky, acceptRaw: false }), null, 'v2 could not be rendered: unanswered, never false');
  });

  it('a render that throws for every blob -> null', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    assert.equal(r.matches(SRC, sha(renderWith(cfg)(V1)), { render: () => { throw new Error('boom'); }, acceptRaw: false }), null);
  });

  it('a render that returns a non-string -> null (never a match)', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir });
    assert.equal(r.matches(SRC, sha('x'), { render: () => undefined, acceptRaw: false }), null);
  });

  it('per-blob byte cap: a blob over maxRenderBlobBytes is not retained, so its rendered question is unanswered (null)', () => {
    const r = createPriorUpstreamResolver({ sourceRoot: dir, maxRenderBlobBytes: 8 });
    assert.equal(r.matches(SRC, sha(renderWith(cfg)(V1)), { render: renderWith(cfg), acceptRaw: false }), null);
    assert.equal(r.stats.retainedBytes, 0);
  });

  it('run-wide byte cap: once exhausted, later blobs answer null; the cap is never exceeded by the last body', () => {
    const cap = Buffer.byteLength(V1) + Buffer.byteLength(V2) + 1; // v3 (longest) would cross it
    const r = createPriorUpstreamResolver({ sourceRoot: dir, maxRetainedBytes: cap });
    assert.equal(r.matches(SRC, sha('nope'), { render: renderWith(cfg), acceptRaw: false }), null);
    assert.ok(r.stats.retainedBytes <= cap, `retained ${r.stats.retainedBytes} > cap ${cap}`);
  });

  it('retained bodies are COPIES: each owns exactly its own bytes, never a view into the (larger) batch buffer', () => {
    // 3 bodies of 5000 bytes in ONE batch buffer (15 KB+): a subarray view would report buffer.byteLength > its own length
    const bodies = ['a', 'b', 'c'].map((ch) => Buffer.from(`${ch.repeat(4999)}\n`));
    const oids = bodies.map((_, i) => String(i + 1).padStart(40, 'c'));
    const fakeGit = (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: Buffer.from('false\n') };
      if (args[0] === 'log') return { status: 0, stdout: Buffer.from(`${oids.map((o) => `:100644 100644 ${'0'.repeat(39)}1 ${o} M\tx`).join('\n')}\n`) };
      return { status: 0, stdout: Buffer.concat(bodies.map((b, i) => Buffer.concat([Buffer.from(`${oids[i]} blob ${b.length}\n`), b, Buffer.from('\n')]))) };
    };
    const r = createPriorUpstreamResolver({ sourceRoot: '.', git: fakeGit });
    r.matches('x', sha('nope'), { render: (t) => t, acceptRaw: false });
    const kept = [...r._retained.values()].map((e) => e.body).filter(Boolean);
    assert.equal(kept.length, 3);
    for (const b of kept) assert.equal(b.buffer.byteLength, b.length, 'a retained body pinned a larger allocation (a view into the batch buffer)');
    assert.equal(r.stats.retainedBytes, 3 * 5000);
  });

  it('a binary (NUL) blob: raw match still works; with acceptRaw:false the rendered question is unanswered (null)', () => {
    const bin = makeSource([`a\0b\n`, `c\0d\n`], 'bin/x.dat');
    try {
      const r = createPriorUpstreamResolver({ sourceRoot: bin });
      const render = (t) => t;
      assert.equal(r.matches('bin/x.dat', sha('a\0b\n'), { render, acceptRaw: true }), true);
      assert.equal(r.matches('bin/x.dat', sha('zzz'), { render, acceptRaw: false }), null);
    } finally { rm(bin); }
  });

  it('a shallow source stays null with render supplied (history incomplete)', () => {
    const shallow = path.join(os.tmpdir(), `prior-up-rw-shallow-${process.pid}-${Date.now()}`);
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', `file:///${dir.replace(/\\/g, '/')}`, shallow]);
      assert.equal(createPriorUpstreamResolver({ sourceRoot: shallow }).matches(SRC, sha(renderWith(cfg)(V1)), { render: renderWith(cfg), acceptRaw: false }), null);
    } finally { rm(shallow); }
  });
});

// ───────────────────────── decideUnmanifested wiring ─────────────────────────
describe('decideUnmanifested - the oracle is asked acceptRaw:false for a rewritten destination', () => {
  const SRC = 'docs/a.md';
  const cfg = { ownedSourceTails: new Set(['x.mjs']) };
  const base = { srcRel: SRC, dstRel: SRC, rewriteConfig: cfg, bannerMarker: 'UPSTREAM-OWNED-MARKER' };

  it('a rewriting file with an affirmative oracle is owned (RED on e93ccd78, where a rewrite disabled the question)', () => {
    const asked = [];
    const v = decideUnmanifested({ ...base, destContent: 'an older rendered version\n', sourceText: 'run `node scripts/x.mjs`\n', priorUpstreamMatches: (o) => { asked.push(o); return true; } });
    assert.deepEqual([v.disposition, v.evidence], ['owned', 'prior-upstream']);
    assert.deepEqual(asked, [{ acceptRaw: false }]);
  });

  it('a non-rewriting file is asked acceptRaw:true', () => {
    const asked = [];
    decideUnmanifested({ ...base, destContent: 'older\n', sourceText: 'no commands here\n', priorUpstreamMatches: (o) => { asked.push(o); return false; } });
    assert.deepEqual(asked, [{ acceptRaw: true }]);
  });

  it('false and null are never evidence', () => {
    for (const answer of [false, null]) {
      const v = decideUnmanifested({ ...base, destContent: 'mine\n', sourceText: 'run `node scripts/x.mjs`\n', priorUpstreamMatches: () => answer });
      assert.equal(v.disposition, 'collision');
    }
  });
});

// ───────────────────────── 2-4. the real CLI ─────────────────────────
const SOURCE_IS_SHALLOW = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf-8' }).trim() === 'true';
const FLEET_REL = '.claude/skills/fleet/references/chip-preamble.md';
const sourceBlob = (rev, rel = FLEET_REL) => execFileSync('git', ['-C', REPO_ROOT, 'show', `${rev}:${rel}`], { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

function makeConsumer(label) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `ces-prior-rw-${label}-`)));
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer, { recursive: true });
  git(['init', '--initial-branch=main'], consumer);
  git(['config', 'user.email', 'test@example.invalid'], consumer);
  git(['config', 'user.name', 'Prior Upstream Rewritten Test'], consumer);
  fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ name: `prior-rw-${label}`, type: 'module' }, null, 2));
  seedInstalledDeps(consumer);
  fs.writeFileSync(path.join(consumer, '.gitignore'), '');
  git(['add', '-A'], consumer);
  git(['commit', '-m', 'init', '--no-gpg-sign'], consumer);
  return { tmp, consumer };
}

/** Run the e2e flow for one earlier source revision of FLEET_REL. `check` receives helpers once the stale render is committed. */
function describeFlow(title, { pickRev, skip }) {
  describe(title, { skip }, () => {
    let tmp; let consumer; let rev; let current; let staleRender;
    const sync = () => runSyncCli(['--target-path', consumer, '--no-prompt']);
    const read = (rel = FLEET_REL) => fs.readFileSync(path.join(consumer, rel), 'utf-8');
    const commit = (msg) => { git(['add', '-A'], consumer); git(['commit', '-m', msg, '--no-gpg-sign'], consumer); };
    const manifestPath = () => path.join(consumer, 'scripts', '.sync-manifest.json');
    const renderFor = (srcContent) => {
      const tails = buildOwnedSourceTailsFromConsumerManifest(JSON.parse(fs.readFileSync(manifestPath(), 'utf-8').replace(/^﻿/, '')));
      return renderOutbound({ srcRel: FLEET_REL, dstRel: FLEET_REL, srcContent, existingContent: null, rewriteConfig: { ownedSourceTails: tails } });
    };

    before(async () => {
      ({ tmp, consumer } = makeConsumer(title.slice(0, 8).replace(/\W/g, '')));
      const r = await sync();
      assert.equal(r.code, 0, whySyncFailed(r));
      current = read();
      commit('first sync');
    });
    after(() => rm(tmp));

    it('fixture: an earlier version exists whose RENDER differs from the current outbound and which IS rewritten (positive controls)', () => {
      rev = pickRev();
      assert.ok(rev, 'no earlier rewritten version of the fleet reference file in this checkout - the test cannot be meaningful');
      const r = renderFor(sourceBlob(rev));
      assert.ok(r.rewrite.hits > 0, `the ${rev.slice(0, 8)} version must be a REWRITTEN file (hits ${r.rewrite.hits})`);
      assert.notEqual(r.content, current.replace(/\r\n/g, '\n'), 'the earlier render must differ from the current outbound');
      staleRender = r.content;
    });

    it('the consumer holds the earlier RENDERED version, committed: the sync updates it, loudly, without a refusal', async () => {
      fs.writeFileSync(path.join(consumer, FLEET_REL), staleRender);
      commit('stale rendered snapshot');
      const r = await sync();
      const out = stripAnsi(r.out);
      assert.equal(r.code, 0, whySyncFailed(r));
      assert.doesNotMatch(out, /REFUSED/, out.slice(-2500));
      assert.equal(read().replace(/\r\n/g, '\n'), current.replace(/\r\n/g, '\n'), 'the stale rendered snapshot was not brought up to date');
      assert.match(out, /equals an earlier upstream version/, 'the replacement must be visible: it may have been a deliberate rollback');
      commit('after sync');
    });

    it('NEGATIVE: a hand edit of the earlier rendered version is refused and survives', async () => {
      const edited = `${staleRender}\nmy own local note\n`;
      fs.writeFileSync(path.join(consumer, FLEET_REL), edited);
      commit('consumer edit');
      const r = await sync();
      assert.match(stripAnsi(r.out), /REFUSED/, stripAnsi(r.out).slice(-2500));
      assert.equal(read(), edited, 'the consumer edit must survive the refusal');
      fs.writeFileSync(path.join(consumer, FLEET_REL), current);
      commit('restore');
    });

    it('NEGATIVE: the RAW (unrewritten) earlier blob committed at the rewritten path is a divergence, refused', async () => {
      const raw = sourceBlob(rev);
      assert.notEqual(raw, staleRender, 'fixture control: raw and rendered differ');
      fs.writeFileSync(path.join(consumer, FLEET_REL), raw);
      commit('raw blob');
      const r = await sync();
      assert.match(stripAnsi(r.out), /REFUSED/, stripAnsi(r.out).slice(-2500));
      assert.equal(read(), raw);
      fs.writeFileSync(path.join(consumer, FLEET_REL), current);
      commit('restore 2');
    });

    it('an UNMANIFESTED orphan holding the earlier rendered version is proved ours by content (the real scan and resolver)', async () => {
      const m = JSON.parse(fs.readFileSync(manifestPath(), 'utf-8').replace(/^﻿/, ''));
      assert.ok(m.files[FLEET_REL], 'fixture control: the path is in the manifest before we remove it');
      delete m.files[FLEET_REL];
      fs.writeFileSync(manifestPath(), `${JSON.stringify(m, null, 2)}\n`);
      fs.writeFileSync(path.join(consumer, FLEET_REL), staleRender);
      commit('orphan: stale rendered snapshot');
      const r = await sync();
      const out = stripAnsi(r.out);
      assert.equal(r.code, 0, whySyncFailed(r));
      assert.match(out, /proved ours by content/, out.slice(-2500));
      assert.match(out, /EARLIER upstream version/, out.slice(-2500));
      assert.equal(read().replace(/\r\n/g, '\n'), current.replace(/\r\n/g, '\n'));
    });
  });
}

const shallowReason = SOURCE_IS_SHALLOW && 'the source checkout is shallow: its history cannot answer the prior-upstream question (CI uses fetch-depth: 0)';

// 2: the mandatory regression. The most recent OLDER rewritten version is always far inside the resolver's 100-version bound.
describeFlow('a rewritten stale snapshot (most recent older version) is updated, not refused', {
  skip: shallowReason,
  pickRev: () => {
    const revs = execFileSync('git', ['-C', REPO_ROOT, 'log', '--format=%H', '-n', '40', '--', FLEET_REL], { encoding: 'utf-8' }).split('\n').filter(Boolean);
    const cur = fs.readFileSync(path.join(REPO_ROOT, FLEET_REL), 'utf-8').replace(/\r\n/g, '\n');
    return revs.find((r) => sourceBlob(r).replace(/\r\n/g, '\n') !== cur);
  },
});

// 3a: storyline's exact case. History-dependent BY DESIGN: it fails with a named operational signal if f3b37321 leaves the resolver's bound.
describe('DIAGNOSTIC (history-dependent): storyline\'s f3b37321 version is still inside the resolver\'s history bound', { skip: shallowReason }, () => {
  it('f3b37321 is among the last 100 versions of the path', () => {
    const oids = execFileSync('git', ['-C', REPO_ROOT, 'log', '-n', '100', '--no-renames', '--raw', '--no-abbrev', '--format=', '--', `:(literal)${FLEET_REL}`], { encoding: 'utf-8' })
      .split('\n').map((l) => /^:\d+ \d+ [0-9a-f]{40} ([0-9a-f]{40}) \w\t/.exec(l)?.[1]).filter(Boolean);
    const target = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', `f3b37321:${FLEET_REL}`], { encoding: 'utf-8' }).trim();
    assert.ok(oids.includes(target), 'storyline\'s f3b37321 version is now BEYOND the resolver\'s history bound: production would no longer recognise storyline\'s case (operational signal, not a regression in this change)');
  });
});
describeFlow('storyline\'s case: the f3b37321-era rewritten render is updated, not refused', {
  skip: shallowReason,
  pickRev: () => 'f3b37321',
});
