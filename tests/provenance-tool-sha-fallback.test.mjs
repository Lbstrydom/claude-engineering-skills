/**
 * `tool_sha` in a hydrated linked worktree that has the bundle but no sync manifest.
 *
 * Field report 5 (measured 2026-11-23): 7 of 9 linked worktrees in one consumer had
 * `scripts/.claude-skills/` but not `scripts/.sync-manifest.json`, so every audit run
 * from them stamped `tool_sha = NULL`, silently. `toolSha()` now borrows the main
 * checkout's manifest, but only when every bundle file it lists matches the bytes in
 * this tree, and a NULL says why once. This is the consumer sync / relocation seam
 * (AGENTS.md Tier 3), so the test lands with the code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideBundleToolSha, resolveBundleToolSha, toolSha, policyVersion, _resetProvenanceCache,
  SELF_MANIFEST_KEY, SYNC_MANIFEST_REL,
} from '../scripts/lib/telemetry/provenance.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { SYNCED_MANIFEST_PATH } from '../scripts/skills-hydrate.mjs';
import { toolShaFor } from '../scripts/lib/fleet/telemetry.mjs';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const OTHER_KEY = 'scripts/.claude-skills/lib/other.mjs';
const FILES = { [SELF_MANIFEST_KEY]: 'sha:self', [OTHER_KEY]: 'sha:other-file', 'skills/x/SKILL.md': 'sha:not-bundle' };
const manifest = (o = {}) => JSON.stringify({ commitSha: SHA, files: FILES, ...o });
/** This tree's hashes: by default every file matches the manifest; `over` changes some. */
const tree = (over = {}) => (k) => (Object.hasOwn(over, k) ? over[k] : FILES[k] ?? null);
const borrow = (hashOf, text = manifest()) => decideBundleToolSha({ localManifestText: null, mainManifestText: text, mainIsSelf: false, hashOf });

describe('decideBundleToolSha (pure)', () => {
  it('the bundle\'s own manifest wins, and is never second-guessed by the main one', () => {
    const d = decideBundleToolSha({ localManifestText: manifest(), mainManifestText: undefined, mainIsSelf: false, hashOf: () => null });
    assert.deepEqual(d, { sha: SHA, source: 'bundle-manifest', reason: null });
  });

  it('no local manifest: borrows the main worktree\'s when EVERY bundle file it lists matches this tree', () => {
    assert.deepEqual(borrow(tree()), { sha: SHA, source: 'main-worktree-manifest', reason: null });
  });

  it('NEGATIVE CONTROL: this module differing refuses the borrow', () => {
    const d = borrow(tree({ [SELF_MANIFEST_KEY]: 'sha:changed' }));
    assert.equal(d.sha, null);
    assert.match(d.reason, /describes a different bundle \(1 of 2 files differ/);
  });

  it('NEGATIVE CONTROL: this module matching is not enough; ANOTHER bundle file that differs or is missing refuses it', () => {
    for (const v of ['sha:changed', null]) {
      const d = borrow(tree({ [OTHER_KEY]: v }));
      assert.equal(d.sha, null, String(v));
      assert.match(d.reason, /1 of 2 files differ/);
    }
  });

  it('NEGATIVE CONTROL: a bundle file present here but not listed (left behind by an overlay-only hydration) refuses it', () => {
    const d = decideBundleToolSha({ localManifestText: null, mainManifestText: manifest(), mainIsSelf: false, hashOf: tree(),
      presentKeys: [SELF_MANIFEST_KEY, OTHER_KEY, 'scripts/.claude-skills/removed-upstream.mjs'] });
    assert.equal(d.sha, null);
    assert.match(d.reason, /1 file\(s\) the main worktree's manifest does not list/);
    // control: exactly the listed set borrows.
    assert.equal(decideBundleToolSha({ localManifestText: null, mainManifestText: manifest(), mainIsSelf: false, hashOf: tree(), presentKeys: [SELF_MANIFEST_KEY, OTHER_KEY] }).sha, SHA);
    // The sync's own bookkeeping lives in the bundle but is never in a manifest (found by the real-sync test, 2026-11-24).
    assert.equal(decideBundleToolSha({ localManifestText: null, mainManifestText: manifest(), mainIsSelf: false, hashOf: tree(),
      presentKeys: [SELF_MANIFEST_KEY, OTHER_KEY, 'scripts/.claude-skills/.sync-watermark.json', 'scripts/.claude-skills/.sync.lock'] }).sha, SHA);
  });

  it('files outside the bundle (e.g. a skill copy) are not part of the comparison', () => {
    assert.equal(borrow(tree({ 'skills/x/SKILL.md': 'sha:edited-locally' })).sha, SHA);
  });

  it('a main manifest that does not list this bundle is unverifiable, so null', () => {
    const d = borrow(tree(), JSON.stringify({ commitSha: SHA, files: { [OTHER_KEY]: 'sha:other-file' } }));
    assert.equal(d.sha, null);
    assert.match(d.reason, /does not list this bundle/);
  });

  it('every null carries a reason naming what was missing', () => {
    for (const facts of [
      { localManifestText: null, mainManifestText: undefined, mainIsSelf: false },
      { localManifestText: null, mainManifestText: null, mainIsSelf: true },
      { localManifestText: null, mainManifestText: null, mainIsSelf: false },
      { localManifestText: '{nope', mainManifestText: null, mainIsSelf: false },
      { localManifestText: JSON.stringify({ files: {} }), mainManifestText: undefined, mainIsSelf: false },
      { localManifestText: null, mainManifestText: JSON.stringify({ files: FILES }), mainIsSelf: false },
    ]) {
      const d = decideBundleToolSha({ ...facts, hashOf: tree() });
      assert.equal(d.sha, null);
      assert.ok(typeof d.reason === 'string' && d.reason.length > 10, JSON.stringify(facts));
    }
  });
});

describe('the constants agree with the sync and the hydrator', () => {
  it('SELF_MANIFEST_KEY is where the sync writes this module in a consumer', () => {
    assert.equal(SELF_MANIFEST_KEY, sourceRelToDestRel('scripts/lib/telemetry/provenance.mjs'));
  });
  it('the manifest path is the one skills:hydrate copies', () => {
    assert.equal(SYNC_MANIFEST_REL, SYNCED_MANIFEST_PATH);
  });
});

describe('resolveBundleToolSha (filesystem + injected main-checkout oracle)', () => {
  const layout = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsha-'));
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    const files = {};
    for (const [key, body] of [[SELF_MANIFEST_KEY, 'export const x = 1;\n'], [OTHER_KEY, 'export const y = 2;\n']]) {
      const abs = path.join(wt, ...key.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
      files[key] = 'sha256:' + crypto.createHash('sha256').update(body).digest('hex');
    }
    fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
    return { main, wt, files, mainRootOf: () => main };
  };

  it('a worktree with the bundle and no manifest gets the main checkout\'s commit', () => {
    const { main, wt, files, mainRootOf } = layout();
    fs.writeFileSync(path.join(main, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA, files }));
    const d = resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { mainRootOf });
    assert.deepEqual(d, { sha: SHA, source: 'main-worktree-manifest', reason: null });
  });

  it('NEGATIVE CONTROL: a bundle file other than this module changed in the worktree is null', () => {
    const { main, wt, files, mainRootOf } = layout();
    fs.writeFileSync(path.join(main, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA, files }));
    fs.appendFileSync(path.join(wt, ...OTHER_KEY.split('/')), '// edited\n');
    assert.equal(resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { mainRootOf }).sha, null);
  });

  it('NEGATIVE CONTROL: an extra bundle file on disk that the main manifest does not list is null', () => {
    const { main, wt, files, mainRootOf } = layout();
    fs.writeFileSync(path.join(main, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA, files }));
    fs.writeFileSync(path.join(wt, 'scripts', '.claude-skills', 'stale-cli.mjs'), '// removed upstream\n');
    const d = resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { mainRootOf });
    assert.equal(d.sha, null);
    assert.match(d.reason, /does not list/);
  });

  it('the main checkout is not asked when the bundle has its own manifest', () => {
    const { wt } = layout();
    fs.writeFileSync(path.join(wt, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA }));
    const mainRootOf = () => { throw new Error('the main checkout must not be asked'); };
    assert.equal(resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { mainRootOf }).sha, SHA);
  });

  it('fleet telemetry reads the bundle commit through the same resolver', () => {
    const { wt } = layout();
    fs.writeFileSync(path.join(wt, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA }));
    assert.equal(toolShaFor(path.join(wt, 'scripts', '.claude-skills')), SHA);
  });
});

describe('a NULL stamp logs once, with its reason', () => {
  const capture = (fn) => {
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try { fn(); } finally { process.stderr.write = orig; _resetProvenanceCache(); }
    return writes;
  };

  it('toolSha: a source tree git cannot read is null and says so exactly once', () => {
    _resetProvenanceCache();
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsha-nogit-'));
    const writes = capture(() => { assert.equal(toolSha(notGit), null); assert.equal(toolSha(notGit), null); });
    const lines = writes.filter((w) => w.includes('tool_sha not recorded'));
    assert.equal(lines.length, 1, writes.join(''));
    assert.match(lines[0], /git rev-parse HEAD failed/);
  });

  it('policyVersion: a repo with no AGENTS.md is null and says so once; one with it is not (control)', () => {
    _resetProvenanceCache();
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-none-'));
    const writes = capture(() => { assert.equal(policyVersion(bare), null); assert.equal(policyVersion(bare), null); });
    const lines = writes.filter((w) => w.includes('policy_version not recorded'));
    assert.equal(lines.length, 1, writes.join(''));
    assert.match(lines[0], /no AGENTS\.md at the repo root/);
    const withPolicy = fs.mkdtempSync(path.join(os.tmpdir(), 'policy-yes-'));
    fs.writeFileSync(path.join(withPolicy, 'AGENTS.md'), '# rules\n');
    const quiet = capture(() => assert.match(policyVersion(withPolicy), /^[0-9a-f]{16}$/));
    assert.equal(quiet.filter((w) => w.includes('not recorded')).length, 0);
  });
});
