/**
 * @fileoverview `"upstreamReachable": false` in `.audit-loop/store-setup.json` — the
 * consumer's own declaration that its store must never be queried from outside.
 *
 * What must NOT happen: a non-boolean coerced into an answer (a typo in a privacy
 * declaration read as "reachable"), and the doctor staying silent about a declaration
 * that took effect.
 */
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STORE_VERDICT, STORE_SETUP_POINTER_PATH, readStoreSetupPointer, renderStoreDetail,
} from '../scripts/lib/doctor/store-reachability.mjs';

const roots = [];
afterEach(() => { for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

function repoWithPointer(body) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
  fs.writeFileSync(path.join(root, STORE_SETUP_POINTER_PATH), body);
  return root;
}

describe('readStoreSetupPointer — upstreamReachable', () => {
  it('reads false and true as booleans', () => {
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": false}')).upstreamReachable, false);
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": true}')).upstreamReachable, true);
  });

  it('a file carrying ONLY upstreamReachable is valid', () => {
    const p = readStoreSetupPointer(repoWithPointer('{"upstreamReachable": false}'));
    assert.deepEqual(p.problems, []);
    assert.equal(p.check, null);
  });

  it('is null when absent, and an empty object still reports the three-key problem', () => {
    const p = readStoreSetupPointer(repoWithPointer('{"check": "x"}'));
    assert.equal(p.upstreamReachable, null);
    const empty = readStoreSetupPointer(repoWithPointer('{}'));
    assert.match(empty.problems.join(';'), /none of "check", "docs", "upstreamReachable"/);
  });

  it('a non-boolean is a problem and is NEVER coerced', () => {
    for (const bad of ['"no"', '"false"', '0', '1', 'null', '[]', '{}']) {
      const p = readStoreSetupPointer(repoWithPointer(`{"upstreamReachable": ${bad}}`));
      assert.equal(p.upstreamReachable, null, bad);
      assert.match(p.problems.join(';'), /upstreamReachable/, bad);
    }
  });

  it('absent pointer file stays { present: false }', () => {
    assert.deepEqual(readStoreSetupPointer(fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-none-'))), { present: false, policy: 'absent' });
  });
});

describe('readStoreSetupPointer — the structured policy field', () => {
  const policyOf = (body) => readStoreSetupPointer(repoWithPointer(body)).policy;

  it('private / reachable / absent', () => {
    assert.equal(policyOf('{"upstreamReachable": false}'), 'private');
    assert.equal(policyOf('{"upstreamReachable": true}'), 'reachable');
    assert.equal(policyOf('{"check": "x"}'), 'absent');
    assert.equal(policyOf('{}'), 'absent');
    assert.equal(readStoreSetupPointer(fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-none-'))).policy, 'absent');
  });

  it('undeterminable: invalid JSON, not an object, non-boolean', () => {
    for (const body of ['{not json', '[]', '"x"', 'null', '{"upstreamReachable": "no"}', '{"upstreamReachable": 0}', '{"upstreamReachable": null}']) {
      assert.equal(policyOf(body), 'undeterminable', body);
    }
  });

  it('an unreadable file is undeterminable (not absent)', () => {
    const p = readStoreSetupPointer('.', { readFileSync: () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } });
    assert.equal(p.policy, 'undeterminable');
  });

  it('private wins over an unrelated bad field', () => {
    assert.equal(policyOf(JSON.stringify({ upstreamReachable: false, check: 5 })), 'private');
  });
});

describe('readStoreSetupPointer — lookalike keys and dangling links', () => {
  const read = (body) => readStoreSetupPointer(repoWithPointer(body));

  it('a typo of the policy key (upstream|reach) with the real key absent is undeterminable, naming the key', () => {
    for (const body of ['{"upstreamReachble": false}', '{"check":"x","upstream_reachable":false}', '{"reachable": false}', '{"UpstreamReach": true}']) {
      const p = read(body);
      assert.equal(p.policy, 'undeterminable', body);
      assert.match(p.problems.join(';'), /looks like a policy declaration/, body);
    }
    assert.match(read('{"upstreamReachble": false}').problems.join(';'), /"upstreamReachble"/);
  });

  it('negative controls: the real key wins over a lookalike; other unknown keys are reported but change nothing', () => {
    assert.equal(read('{"upstreamReachable": false, "reachable": 1}').policy, 'private');
    const c = read('{"check":"x","_comment":"y"}');
    assert.equal(c.policy, 'absent');
    assert.equal(c.check, 'x');
    assert.match(c.problems.join(';'), /unknown key "_comment" is ignored/);
    assert.equal(read('{"check":"x"}').problems.length, 0);
  });

  it('an unknown key is printed JSON-quoted and truncated (no control characters reach a terminal)', () => {
    const p = read(JSON.stringify({ check: 'x', ['k\u001b[31m' + 'z'.repeat(80)]: 1 }));
    assert.equal(/[\u0000-\u001f]/.test(p.problems.join(';')), false);
    assert.ok(p.problems.join(';').length < 200);
  });

  it('a DANGLING link is undeterminable; a missing file is still absent', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-link-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, '.audit-loop'), { recursive: true });
    try {
      fs.symlinkSync(path.join(root, 'nowhere.json'), path.join(root, STORE_SETUP_POINTER_PATH));
    } catch (err) {
      t.skip('symlink creation is not permitted on this machine (' + err.code + ')');
      return;
    }
    const p = readStoreSetupPointer(root);
    assert.equal(p.policy, 'undeterminable');
    assert.match(p.problems.join(';'), /dangling link/);
    assert.equal(readStoreSetupPointer(fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-none2-'))).policy, 'absent');
  });

  it('the dangling-link rule works through an injected fs (lstat succeeds, read is ENOENT)', () => {
    const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
    const dangling = readStoreSetupPointer('/r', { readFileSync: () => { throw enoent; }, lstatSync: () => ({ isSymbolicLink: () => true }) });
    assert.equal(dangling.policy, 'undeterminable');
    const missing = readStoreSetupPointer('/r', { readFileSync: () => { throw enoent; }, lstatSync: () => { throw enoent; } });
    assert.deepEqual(missing, { present: false, policy: 'absent' });
    assert.deepEqual(readStoreSetupPointer('/r', { readFileSync: () => { throw enoent; } }), { present: false, policy: 'absent' });
  });
});

describe('readStoreSetupPointer — a link anywhere on the path, and duplicate keys', () => {
  const enoent = Object.assign(new Error('x'), { code: 'ENOENT' });
  const link = { isSymbolicLink: () => true };
  const plain = { isSymbolicLink: () => false };
  const withLstat = (lstat) => readStoreSetupPointer('/r', { readFileSync: () => { throw enoent; }, lstatSync: lstat });

  it('a dangling .audit-loop DIRECTORY link is undeterminable (injected fs)', () => {
    const p = readStoreSetupPointer('/r', {
      readFileSync: () => { throw enoent; },
      lstatSync: (x) => { if (x.endsWith('.audit-loop')) return link; throw enoent; },
      statSync: () => { throw enoent; },   // the link target does not exist
    });
    assert.equal(p.policy, 'undeterminable');
    assert.match(p.problems.join(';'), /dangling link/);
  });

  it('a .audit-loop LINK to an EXISTING directory with no pointer file is absent (injected fs)', () => {
    const p = readStoreSetupPointer('/r', {
      readFileSync: () => { throw enoent; },
      lstatSync: (x) => { if (x.endsWith('.audit-loop')) return link; throw enoent; },
      statSync: () => ({ isDirectory: () => true }),
    });
    assert.deepEqual(p, { present: false, policy: 'absent' });
    // a link to something that is not a directory is not "present and empty"
    const notDir = readStoreSetupPointer('/r', {
      readFileSync: () => { throw enoent; },
      lstatSync: (x) => { if (x.endsWith('.audit-loop')) return link; throw enoent; },
      statSync: () => ({ isDirectory: () => false }),
    });
    assert.equal(notDir.policy, 'undeterminable');
  });

  it('any lstat/stat failure other than ENOENT is undeterminable', () => {
    const eacces = Object.assign(new Error('x'), { code: 'EACCES' });
    assert.equal(withLstat(() => { throw eacces; }).policy, 'undeterminable', 'lstat of the directory');
    assert.equal(withLstat((x) => { if (x.endsWith('.audit-loop')) return plain; throw eacces; }).policy, 'undeterminable', 'lstat of the file');
    const statFails = readStoreSetupPointer('/r', {
      readFileSync: () => { throw enoent; },
      lstatSync: (x) => { if (x.endsWith('.audit-loop')) return link; throw enoent; },
      statSync: () => { throw eacces; },
    });
    assert.equal(statFails.policy, 'undeterminable', 'stat of the link target');
    // negative control: a genuinely missing directory is absent
    assert.deepEqual(withLstat(() => { throw enoent; }), { present: false, policy: 'absent' });
  });

  it('only "no .audit-loop at all" and "directory present, file truly absent" are absent', () => {
    assert.deepEqual(withLstat(() => { throw enoent; }), { present: false, policy: 'absent' });
    assert.deepEqual(withLstat((x) => { if (x.endsWith('.audit-loop')) return plain; throw enoent; }), { present: false, policy: 'absent' });
  });

  it('a dangling .audit-loop directory link on a real disk is undeterminable', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-dirlink-'));
    roots.push(root);
    try {
      fs.symlinkSync(path.join(root, 'nowhere'), path.join(root, '.audit-loop'), 'dir');
    } catch (err) {
      t.skip('symlink creation is not permitted on this machine (' + err.code + ')');
      return;
    }
    assert.equal(readStoreSetupPointer(root).policy, 'undeterminable');
  });

  it('a .audit-loop link to an EXISTING directory with no file is absent on a real disk; a dangling one is not', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'store-policy-dirlink2-'));
    roots.push(root);
    const real = path.join(root, 'real-dir');
    fs.mkdirSync(real);
    try {
      fs.symlinkSync(real, path.join(root, '.audit-loop'), 'dir');
    } catch (err) {
      t.skip('symlink creation is not permitted on this machine (' + err.code + ')');
      return;
    }
    assert.deepEqual(readStoreSetupPointer(root), { present: false, policy: 'absent' });
    fs.rmSync(real, { recursive: true, maxRetries: 3, retryDelay: 50 });   // now the link dangles
    assert.equal(readStoreSetupPointer(root).policy, 'undeterminable');
  });

  it('an escaped spelling of the key counts as the same key (decoded counting)', () => {
    const escaped = '{"upstreamReachable": false, "upstream\\u0052eachable": true}';
    const p = readStoreSetupPointer(repoWithPointer(escaped));
    assert.equal(p.policy, 'undeterminable');
    assert.match(p.problems.join(';'), /appears more than once/);
  });

  it('a key-shaped fragment INSIDE a string value is not a key', () => {
    assert.equal(readStoreSetupPointer(repoWithPointer(JSON.stringify({ docs: 'see "upstreamReachable": x', upstreamReachable: true }))).policy, 'reachable');
  });

  it('only TOP-LEVEL keys count: a nested same-named key leaves the policy to the root key', () => {
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": false, "extra": {"upstreamReachable": true}}')).policy, 'private');
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": true, "list": [{"upstreamReachable": false}]}')).policy, 'reachable');
    // negative control: two ROOT keys are still a duplicate
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": true, "x": {"a": 1}, "upstreamReachable": false}')).policy, 'undeterminable');
  });

  it('a duplicate-key pointer prints NO unreachable-by-policy line, and its problems are shown', () => {
    const dup = readStoreSetupPointer(repoWithPointer('{"upstreamReachable": false, "upstreamReachable": false}'));
    assert.equal(dup.policy, 'undeterminable');
    assert.equal(dup.upstreamReachable, false, 'the raw value is false; the structured policy is what counts');
    for (const v of Object.values(STORE_VERDICT)) {
      const detail = renderStoreDetail(v, dup);
      assert.doesNotMatch(detail, /unreachable-by-policy/, v);
      assert.match(detail, /appears more than once/, v);
    }
  });

  it('a duplicated "upstreamReachable" key is undeterminable, whichever value wins', () => {
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable":false,"upstreamReachable":true}')).policy, 'undeterminable');
    for (const body of ['{"upstreamReachable": true, "upstreamReachable": false}', '{"upstreamReachable": false, "upstreamReachable": true}', '{"upstreamReachable":false,\n"check":"x","upstreamReachable":false}']) {
      const p = readStoreSetupPointer(repoWithPointer(body));
      assert.equal(p.policy, 'undeterminable', body);
      assert.match(p.problems.join(';'), /appears more than once/, body);
    }
  });

  it('negative control: a single key is read as usual', () => {
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": false}')).policy, 'private');
    assert.equal(readStoreSetupPointer(repoWithPointer('{"upstreamReachable": true, "docs": "a"}')).policy, 'reachable');
  });
});

describe('renderStoreDetail — the declaration is visible to the consumer operator', () => {
  const declared = { present: true, check: null, docs: null, upstreamReachable: false, policy: 'private', problems: [] };

  it('says unreachable-by-policy on every verdict', () => {
    for (const v of Object.values(STORE_VERDICT)) {
      assert.match(renderStoreDetail(v, declared), /upstream: unreachable-by-policy \(declared in \.audit-loop\/store-setup\.json\)/, v);
    }
  });

  it('an undeterminable pointer reports its problems EVEN when the store is reachable', () => {
    const bad = { present: true, check: null, docs: null, upstreamReachable: null, policy: 'undeterminable', problems: ['"upstreamReachable" must be a boolean'] };
    for (const v of Object.values(STORE_VERDICT)) {
      assert.match(renderStoreDetail(v, bad), /ignored in part: "upstreamReachable" must be a boolean/, v);
    }
    assert.equal((renderStoreDetail(STORE_VERDICT.UNREACHABLE, bad).match(/ignored in part/g) || []).length, 1, 'never printed twice');
    // negative control: a reachable store with a merely cosmetic problem stays quiet
    const cosmetic = { ...bad, policy: 'absent', problems: ['"check" must be a non-empty string'] };
    assert.doesNotMatch(renderStoreDetail(STORE_VERDICT.REACHABLE, cosmetic), /ignored in part/);
  });

  it('negative control: true, null and an absent pointer print no such line', () => {
    for (const p of [{ ...declared, upstreamReachable: true, policy: 'reachable' }, { ...declared, upstreamReachable: null, policy: 'absent' }, { ...declared, policy: 'undeterminable' }, { present: false }]) {
      assert.doesNotMatch(renderStoreDetail(STORE_VERDICT.REACHABLE, p), /unreachable-by-policy/);
    }
  });
});
