/**
 * @fileoverview End-to-end proof for the write-loop / ownership cluster (D), driving the REAL CLI against real git
 * consumers through `--target-path` only.
 *
 *   ae70a5d51c16  a consumer's OWN file at a managed path was claimed as ours because its path matched
 *   cc838c26f9e4  the EOL repair rewrote a path the consumer declared HELD
 *   489588c47264  gc deleted a retired tooling file the consumer had EDITED
 *   4e0763d54f00  the manifest base is what was WRITTEN (structural pin; the race itself needs a concurrent writer)
 *
 * The first test aborts in preflight (fast). The second runs one real sync and then three more over the same consumer.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { seedInstalledDeps, runSyncCli, whySyncFailed, git } from './helpers/consumer-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = 'scripts/.sync-manifest.json';
const strip = (t) => String(t).replace(/\u001B\[[0-9;]*m/g, '');
const sha = (buf) => `sha256:${createHash('sha256').update(buf).digest('hex')}`;

let tmp;
before(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ces-d-e2e-'))); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function makeConsumer(name) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(['init', '--initial-branch=main'], root);
  git(['config', 'user.email', 'test@example.invalid'], root);
  git(['config', 'user.name', 'Sync D e2e'], root);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: `d-${name}`, type: 'module' }, null, 2));
  seedInstalledDeps(root);
  fs.writeFileSync(path.join(root, '.gitignore'), '');
  return root;
}
const commit = (root) => { git(['add', '-A'], root); git(['commit', '-q', '-m', 'c', '--no-gpg-sign'], root); };
async function sync(root, extra = []) {
  const r = await runSyncCli(['--target-path', root, '--no-prompt', ...extra]);
  return { ...r, text: strip(r.out) };
}
const readJson = (root, rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf-8'));

describe('ae70a5d51c16 — a path match is not ownership', () => {
  it('a consumer\'s own .claude/skills/plan/SKILL.md (no banner, not ours, not in the manifest) ABORTs the target; the file is untouched', async () => {
    const root = makeConsumer('own-skill');
    const own = '# My team\'s own plan skill\nNothing to do with upstream.\n';
    fs.mkdirSync(path.join(root, '.claude/skills/plan'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude/skills/plan/SKILL.md'), own);
    commit(root);
    const r = await sync(root);
    assert.notEqual(r.code, 0, whySyncFailed(r));
    assert.match(r.text, /collide\s+\.claude\/skills\/plan\/SKILL\.md/);
    assert.equal(fs.readFileSync(path.join(root, '.claude/skills/plan/SKILL.md'), 'utf8'), own, 'the consumer\'s file was overwritten (the parent claimed it on its path alone)');
    assert.equal(fs.existsSync(path.join(root, 'scripts', '.claude-skills', 'lib')), false, 'the abort precedes the write loop');
  });
});

describe('the write loop and gc, one consumer, four syncs', () => {
  it('EOL repair respects a declared hold; an edited retired file is held; a malformed base is never deleted; the base is what was written', async () => {
    const root = makeConsumer('loop');
    commit(root);
    const first = await sync(root);
    assert.equal(first.code, 0, whySyncFailed(first));

    // ── 4e0763d54f00: a delivered file's manifest base is the sha256 of exactly the bytes on disk (written == confirmed)
    const delivered = '.claude/hooks/arch-memory-check.sh';
    assert.equal(readJson(root, MANIFEST).files[delivered], sha(fs.readFileSync(path.join(root, delivered))));

    // ── cc838c26f9e4: declared-held path, and its bytes differ from upstream only by line endings
    const held = '.claude/skills/plan/SKILL.md'; // the tooling tree itself may never be overridden, so a tracked skill file
    const heldAbs = path.join(root, held);
    const crlf = fs.readFileSync(heldAbs, 'utf8').replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(heldAbs, crlf);
    fs.writeFileSync(path.join(root, '.sync-overrides.json'), JSON.stringify({ version: 1, overrides: [{ path: held, reason: 'e2e: consumer pins this file' }] }, null, 2));

    // ── 489588c47264: two retired tooling files — one EDITED since we wrote it, one with a malformed ownership record
    const EDITED = 'scripts/.claude-skills/lib/retired-edited.mjs';
    const ODD = 'scripts/.claude-skills/lib/retired-oddbase.mjs';
    const m = readJson(root, MANIFEST);
    for (const [rel, body, base] of [[EDITED, '// the consumer edited this\n', sha(Buffer.from('// as delivered\n'))], [ODD, '// odd\n', 'garbage']]) {
      fs.writeFileSync(path.join(root, rel), body);
      m.files[rel] = base;
    }
    fs.writeFileSync(path.join(root, MANIFEST), JSON.stringify(m, null, 2) + '\n');

    const second = await sync(root);
    assert.equal(fs.readFileSync(heldAbs, 'utf8'), crlf, 'a held path was rewritten by the EOL repair (the parent repaired before consulting the override)');
    assert.match(second.text, /hold\s+\.claude\/skills\/plan\/SKILL\.md/);
    assert.equal(fs.existsSync(path.join(root, EDITED)), true, 'gc deleted a retired file the consumer had edited');
    assert.equal(fs.existsSync(path.join(root, ODD)), true);
    assert.match(second.text, /hold\s+scripts\/\.claude-skills\/lib\/retired-edited\.mjs[^\n]*edited locally/);
    assert.match(second.text, /hold\s+scripts\/\.claude-skills\/lib\/retired-oddbase\.mjs[^\n]*malformed/);
    const receipt = readJson(root, '.sync-receipt.json').recentSyncs[0];
    assert.deepEqual([...receipt.retiredHeld].sort(), [EDITED, ODD].sort(), 'the held retirements are on the record');
    const m2 = readJson(root, MANIFEST).files;
    assert.equal(m2[EDITED], sha(Buffer.from('// as delivered\n')), 'the prior entry is carried forward, not re-hashed from the edit');
    assert.equal(m2[ODD], 'garbage');

    // ── --overwrite-diverged deletes the EDITED one (recorded), and still never the malformed-base one
    const third = await sync(root, ['--overwrite-diverged']);
    assert.equal(fs.existsSync(path.join(root, EDITED)), false, 'the consented deletion did not happen');
    assert.equal(fs.existsSync(path.join(root, ODD)), true, 'a malformed ownership record must never be deleted, flag or not');
    const r3 = readJson(root, '.sync-receipt.json').recentSyncs[0];
    assert.ok(r3.divergedOverwritten.some((d) => d.path === EDITED && d.reason === 'diverged-retired-upstream'), JSON.stringify(r3.divergedOverwritten));
    assert.equal(readJson(root, MANIFEST).files[EDITED], undefined, 'a deleted file leaves the manifest');
    assert.equal(third.text.includes('gc FAILED'), false, third.text.slice(-800));
  });
});

describe('4e0763d54f00 — the manifest is built from what was written, not re-read from disk', () => {
  it('red on the parent: its post-loop re-hash is gone from the manifest build', (t) => {
    const r = spawnSync('git', ['show', '80c2e1db:scripts/sync-to-repos.mjs'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 });
    if (r.error) throw r.error;
    if (r.status !== 0) {
      if (/bad object|unknown revision|invalid object name|not a valid object|bad revision|ambiguous argument/i.test(r.stderr)) return t.skip('80c2e1db not available (shallow clone)');
      assert.fail(`git show failed: ${r.stderr}`);
    }
    const rehash = /const buf = fs\.readFileSync\(abs\);\s*consumerFileMap\[dstRel\] = 'sha256:' \+ crypto\.createHash\('sha256'\)\.update\(buf\)/;
    assert.match(r.stdout, rehash, 'red evidence: the parent hashed the destination AFTER the loop');
    const now = fs.readFileSync(path.join(ROOT, 'scripts/sync-to-repos.mjs'), 'utf8');
    assert.doesNotMatch(now, rehash);
    assert.match(now, /selectManifestBases\(\{/, 'the CLI builds its bases through the pure selector');
    assert.match(fs.readFileSync(path.join(ROOT, 'scripts/lib/sync-gc.mjs'), 'utf8'), /files\[rel\] = writtenHash\.get\(rel\)/);
  });
});
