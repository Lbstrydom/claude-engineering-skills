/**
 * `tool_sha` in a hydrated linked worktree that has the bundle but no sync manifest.
 *
 * Field report 5 (measured 2026-11-23): 7 of 9 linked worktrees in one consumer had
 * `scripts/.claude-skills/` but not `scripts/.sync-manifest.json`, so every audit run
 * from them stamped `tool_sha = NULL`, silently. `toolSha()` now borrows the main
 * checkout's manifest, but only when that manifest describes the bytes running here,
 * and a NULL says why once. This is the consumer sync / relocation seam (AGENTS.md
 * Tier 3), so the test lands with the code.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decideBundleToolSha, resolveBundleToolSha, toolSha, _resetProvenanceCache,
  SELF_MANIFEST_KEY, SYNC_MANIFEST_REL,
} from '../scripts/lib/telemetry/provenance.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { SYNCED_MANIFEST_PATH } from '../scripts/skills-hydrate.mjs';
import { toolShaFor } from '../scripts/lib/fleet/telemetry.mjs';

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const SELF = 'sha:self';
const manifest = (o) => JSON.stringify({ commitSha: SHA, files: { [SELF_MANIFEST_KEY]: SELF }, ...o });

describe('decideBundleToolSha (pure)', () => {
  it('the bundle\'s own manifest wins, and is never second-guessed by the main one', () => {
    const d = decideBundleToolSha({ localManifestText: manifest(), mainManifestText: undefined, mainIsSelf: false, selfHash: null });
    assert.deepEqual(d, { sha: SHA, source: 'bundle-manifest', reason: null });
  });

  it('no local manifest: borrows the main worktree\'s when its entry for this module matches the running bytes', () => {
    const d = decideBundleToolSha({ localManifestText: null, mainManifestText: manifest(), mainIsSelf: false, selfHash: SELF });
    assert.deepEqual(d, { sha: SHA, source: 'main-worktree-manifest', reason: null });
  });

  it('NEGATIVE CONTROL: a main manifest for a different bundle (re-synced since hydration) is not borrowed', () => {
    const d = decideBundleToolSha({ localManifestText: null, mainManifestText: manifest(), mainIsSelf: false, selfHash: 'sha:other' });
    assert.equal(d.sha, null);
    assert.match(d.reason, /describes a different bundle/);
  });

  it('a main manifest that does not list this module at all is unverifiable, so null', () => {
    const d = decideBundleToolSha({ localManifestText: null, mainManifestText: JSON.stringify({ commitSha: SHA, files: {} }), mainIsSelf: false, selfHash: SELF });
    assert.equal(d.sha, null);
  });

  it('every null carries a reason naming what was missing', () => {
    for (const facts of [
      { localManifestText: null, mainManifestText: undefined, mainIsSelf: false, selfHash: SELF },
      { localManifestText: null, mainManifestText: null, mainIsSelf: true, selfHash: SELF },
      { localManifestText: null, mainManifestText: null, mainIsSelf: false, selfHash: SELF },
      { localManifestText: '{nope', mainManifestText: null, mainIsSelf: false, selfHash: SELF },
      { localManifestText: JSON.stringify({ files: {} }), mainManifestText: undefined, mainIsSelf: false, selfHash: SELF },
    ]) {
      const d = decideBundleToolSha(facts);
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

describe('resolveBundleToolSha (filesystem + injected git)', () => {
  const layout = () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsha-'));
    const main = path.join(base, 'main');
    const wt = path.join(base, 'wt');
    for (const r of [main, wt]) fs.mkdirSync(path.join(r, 'scripts', '.claude-skills', 'lib', 'telemetry'), { recursive: true });
    const selfPath = path.join(wt, 'scripts', '.claude-skills', 'lib', 'telemetry', 'provenance.mjs');
    fs.writeFileSync(selfPath, 'export const x = 1;\n');
    const selfHash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(selfPath)).digest('hex');
    const run = () => `${path.join(main, '.git')}\n`;
    return { main, wt, selfPath, selfHash, run };
  };

  it('a worktree with the bundle and no manifest gets the main checkout\'s commit', () => {
    const { main, wt, selfPath, selfHash, run } = layout();
    fs.writeFileSync(path.join(main, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA, files: { [SELF_MANIFEST_KEY]: selfHash } }));
    const d = resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { run, selfPath });
    assert.deepEqual(d, { sha: SHA, source: 'main-worktree-manifest', reason: null });
  });

  it('NEGATIVE CONTROL: the same layout with a stale main manifest is null', () => {
    const { main, wt, selfPath, run } = layout();
    fs.writeFileSync(path.join(main, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA, files: { [SELF_MANIFEST_KEY]: 'sha256:00' } }));
    assert.equal(resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { run, selfPath }).sha, null);
  });

  it('git is not asked when the bundle has its own manifest', () => {
    const { wt, selfPath } = layout();
    fs.writeFileSync(path.join(wt, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA }));
    const run = () => { throw new Error('git must not run'); };
    assert.equal(resolveBundleToolSha(path.join(wt, 'scripts', '.claude-skills'), { run, selfPath }).sha, SHA);
  });

  it('fleet telemetry reads the bundle commit through the same resolver', () => {
    const { wt } = layout();
    fs.writeFileSync(path.join(wt, SYNC_MANIFEST_REL), JSON.stringify({ commitSha: SHA }));
    assert.equal(toolShaFor(path.join(wt, 'scripts', '.claude-skills')), SHA);
  });
});

describe('toolSha logs a NULL once, with its reason', () => {
  it('a source tree git cannot read is null and says so exactly once', () => {
    _resetProvenanceCache();
    const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'toolsha-nogit-'));
    const writes = [];
    const orig = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try {
      assert.equal(toolSha(notGit), null);
      assert.equal(toolSha(notGit), null);
    } finally { process.stderr.write = orig; _resetProvenanceCache(); }
    const lines = writes.filter((w) => w.includes('tool_sha not recorded'));
    assert.equal(lines.length, 1, writes.join(''));
    assert.match(lines[0], /git rev-parse HEAD failed/);
  });
});
