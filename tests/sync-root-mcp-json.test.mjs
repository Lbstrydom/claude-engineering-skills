/**
 * @fileoverview Cluster C of docs/plans/vscode-compatibility.md: the root `.mcp.json` ships to consumers through the
 * co-owned JSON merge, and consumer-side parity is judged on the MANAGED servers only.
 *
 * Tier 3 (consumer sync contract): a break ships silently to repos nobody can observe. Cases are the plan's list: first
 * sync, repeated sync (no bytes change), consumer-only server survives, same-name server (our leaves win, their extra
 * key survives), malformed JSON (collision, never overwritten), managed-server parity on the merged pair.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { renderOutbound, decideUnmanifested } from '../scripts/lib/sync-outbound.mjs';
import { isCoOwnedJsonDest, sourceRelToDestRel, isExplicitException } from '../scripts/lib/sync-path-map.mjs';
import { _internals as inventory } from '../scripts/lib/sync-inventory.mjs';
import { EOL_PIN_GLOBS } from '../scripts/lib/sync-eol-pins.mjs';
import { compareMcpSurfaces, managedServerNames } from '../scripts/lib/mcp-parity.mjs';
import { runGates } from '../scripts/lib/sync-isolation-verify.mjs';
import { SyncManifestSchema } from '../scripts/lib/sync-manifest.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf8');
const SRC_VSCODE = fs.readFileSync(path.join(REPO_ROOT, '.vscode', 'mcp.json'), 'utf8');
const cfg = { ownedSourceTails: new Set() };
const render = (srcContent, existingContent = null, rel = '.mcp.json') =>
  renderOutbound({ srcRel: rel, dstRel: rel, srcContent, existingContent, rewriteConfig: cfg });
const ours = JSON.parse(SRC);
const MANAGED = managedServerNames(ours);

describe('.mcp.json is registered on every sync surface', () => {
  it('inventory, canonical path, co-owned merge and EOL pin all name it', () => {
    assert.ok(inventory.EDITOR_FILES.includes('.mcp.json'));
    assert.equal(sourceRelToDestRel('.mcp.json'), '.mcp.json');
    assert.equal(isExplicitException('.mcp.json'), true);
    assert.equal(isCoOwnedJsonDest('.mcp.json'), true);
    assert.ok(EOL_PIN_GLOBS.includes('.mcp.json'));
  });
  it("the managed set is the source file's own server names", () => {
    assert.deepEqual(MANAGED, ['mermaid', 'playwright']);
    assert.deepEqual(managedServerNames(null), []);
  });
});

describe('renderOutbound(.mcp.json) — merge semantics', () => {
  it('first sync (file absent): the consumer receives our servers', () => {
    assert.deepEqual(JSON.parse(render(SRC).content).mcpServers, ours.mcpServers);
  });

  it('repeated sync changes no bytes', () => {
    const first = render(SRC).content;
    assert.equal(render(SRC, first).content, first);
  });

  it('a consumer-only server survives, and a consumer that had entries loses none', () => {
    const theirs = JSON.stringify({ mcpServers: { corp: { type: 'http', url: 'https://x.example/mcp' } }, other: 1 });
    const out = JSON.parse(render(SRC, theirs).content);
    assert.deepEqual(out.mcpServers.corp, { type: 'http', url: 'https://x.example/mcp' });
    assert.equal(out.other, 1);
    for (const name of MANAGED) assert.deepEqual(out.mcpServers[name], ours.mcpServers[name]);
  });

  it('a same-name server gets our leaves; its extra keys survive', () => {
    const theirs = JSON.stringify({ mcpServers: { playwright: { command: 'STALE', args: ['STALE'], env: { FLAG: '1' }, extra: true } } });
    const p = JSON.parse(render(SRC, theirs).content).mcpServers.playwright;
    assert.equal(p.command, ours.mcpServers.playwright.command);
    assert.deepEqual(p.args, ours.mcpServers.playwright.args);
    assert.equal(p.env.FLAG, '1');
    assert.equal(p.extra, true);
  });

  it('malformed consumer JSON is a collision: the sync does not claim the file', () => {
    const bad = decideUnmanifested({
      srcRel: '.mcp.json', dstRel: '.mcp.json', destContent: '{ not json', sourceText: SRC, rewriteConfig: cfg, bannerMarker: 'x',
    });
    assert.equal(bad.disposition, 'collision');
    const ok = decideUnmanifested({
      srcRel: '.mcp.json', dstRel: '.mcp.json', destContent: '{"mcpServers":{}}', sourceText: SRC, rewriteConfig: cfg, bannerMarker: 'x',
    });
    assert.equal(ok.disposition, 'shared-merge');
  });
});

describe('compareMcpSurfaces({managedNames}) — parity over MANAGED servers only', () => {
  const mergedPair = (theirClaude, theirVscode) => ({
    claude: JSON.parse(render(SRC, theirClaude).content),
    vscode: JSON.parse(render(SRC_VSCODE, theirVscode, '.vscode/mcp.json').content),
  });
  const cmp = (p) => compareMcpSurfaces({ ...p, managedNames: MANAGED });

  it('negative control: the unmodified merged pair passes and actually compared both servers', () => {
    const r = cmp(mergedPair(null, null));
    assert.equal(r.ok, true);
    assert.equal(r.compared, MANAGED.length);
  });
  it("an extra server on ONE side only passes (the consumer's own, even if unmodelled)", () => {
    const r = cmp(mergedPair(JSON.stringify({ mcpServers: { corp: { type: 'http', url: 'https://x.example/mcp' } } }), null));
    assert.equal(r.ok, true, r.diagnostics.join('; '));
    assert.equal(r.compared, MANAGED.length);
  });
  it('an undeclared managed mismatch fails, and without managedNames the same extra server is drift (source gate unchanged)', () => {
    const p = mergedPair(null, null);
    p.claude.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1'];
    const r = cmp(p);
    assert.equal(r.code, 'mcp/parity-drift');
    assert.deepEqual(r.drifted, ['playwright']);
    const q = mergedPair(JSON.stringify({ mcpServers: { corp: { command: 'x' } } }), null);
    assert.equal(compareMcpSurfaces(q).ok, false);
  });
  it("a managed server missing from one file fails (not the consumer's own)", () => {
    const p = mergedPair(null, null);
    delete p.vscode.servers.mermaid;
    assert.equal(cmp(p).ok, false);
  });
});

describe('gate 10 + manifest field: real sync, reload through the schema, runGates AND the CLI exit', () => {
  const VERIFY = path.join(REPO_ROOT, 'scripts', 'lib', 'sync-isolation-verify.mjs');
  const manifestPath = (tmp) => path.join(tmp, 'scripts', '.sync-manifest.json');
  const realSync = (tmp) => execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), '--target-path', tmp, '--no-prompt', '--adopt-orphans',
  ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 });
  const exitOf = (tmp) => spawnSync(process.execPath, [VERIFY, '--consumer-root', tmp, '--gates', '10'], { encoding: 'utf8' }).status;
  const withConsumer = (fn, seed) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate10-'));
    try {
      if (seed) seed(tmp);
      realSync(tmp);
      // Reload through the SCHEMA: a non-strict schema would strip an undeclared field here.
      const parsed = SyncManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath(tmp), 'utf8')));
      assert.deepEqual(parsed.mcpManagedServers, MANAGED, 'the manifest carries exactly the source names, sorted');
      const gate = () => runGates({ consumerRoot: tmp, gates: ['10'] })[0];
      return fn({ tmp, gate });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  };
  const editJson = (f, fn) => { const j = JSON.parse(fs.readFileSync(f, 'utf8')); fn(j); fs.writeFileSync(f, JSON.stringify(j, null, 2)); };

  it('pass: a clean sync is green, exit 0', () => withConsumer(({ tmp, gate }) => {
    const g = gate();
    assert.equal(g.result, 'pass');
    assert.equal(g.details.compared, MANAGED.length);
    assert.equal(exitOf(tmp), 0);
  }));

  it("pass: the consumer's own server on one side only is never judged, exit 0", () => withConsumer(({ tmp, gate }) => {
    editJson(path.join(tmp, '.mcp.json'), (j) => { j.mcpServers.corp = { type: 'http', url: 'https://x.example/mcp' }; });
    assert.equal(gate().result, 'pass');
    assert.equal(exitOf(tmp), 0);
  }));

  it('declared: either file claimed in .sync-overrides.json means no compare, exit 0 even with a mismatch', () => withConsumer(({ tmp, gate }) => {
    editJson(path.join(tmp, '.mcp.json'), (j) => { j.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1']; });
    fs.writeFileSync(path.join(tmp, '.sync-overrides.json'), JSON.stringify({ version: 1, overrides: [{ path: '.vscode/mcp.json', reason: 'pinned locally' }] }));
    const g = gate();
    assert.equal(g.result, 'declared', JSON.stringify(g));
    assert.equal(exitOf(tmp), 0);
  }));

  it('fail: an undeclared managed mismatch is MCP_PARITY_MISMATCH and the exit is non-zero', () => withConsumer(({ tmp, gate }) => {
    editJson(path.join(tmp, '.mcp.json'), (j) => { j.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1']; });
    const g = gate();
    assert.equal(g.result, 'fail');
    assert.equal(g.code, 'MCP_PARITY_MISMATCH');
    assert.notEqual(exitOf(tmp), 0);
  }));

  it('unmeasured: .mcp.json in the manifest but the field absent is MCP_PARITY_UNMEASURED with a re-sync diagnostic, non-zero exit', () => withConsumer(({ tmp, gate }) => {
    editJson(manifestPath(tmp), (j) => { delete j.mcpManagedServers; });
    const g = gate();
    assert.equal(g.result, 'unmeasured');
    assert.equal(g.code, 'MCP_PARITY_UNMEASURED');
    assert.match(g.error, /Re-sync/);
    assert.notEqual(exitOf(tmp), 0);
  }));

  it('not-applicable: no .mcp.json in the manifest is green, exit 0; a malformed field is a schema failure', () => withConsumer(({ tmp, gate }) => {
    editJson(manifestPath(tmp), (j) => { delete j.files['.mcp.json']; });
    assert.equal(gate().result, 'not-applicable');
    assert.equal(exitOf(tmp), 0);
    editJson(manifestPath(tmp), (j) => { j.mcpManagedServers = ['playwright', 'mermaid']; });   // unsorted
    const bad = gate();
    assert.equal(bad.gate, 'preflight');
    assert.match(bad.error, /manifest schema invalid/);
    assert.notEqual(exitOf(tmp), 0);
  }));
});
