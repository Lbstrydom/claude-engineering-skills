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
import { execFileSync } from 'node:child_process';

import { renderOutbound, decideUnmanifested } from '../scripts/lib/sync-outbound.mjs';
import { isCoOwnedJsonDest, sourceRelToDestRel, isExplicitException } from '../scripts/lib/sync-path-map.mjs';
import { _internals as inventory } from '../scripts/lib/sync-inventory.mjs';
import { EOL_PIN_GLOBS } from '../scripts/lib/sync-eol-pins.mjs';
import { compareManagedMcpSurfaces, managedServerNames } from '../scripts/lib/mcp-parity.mjs';

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

describe('compareManagedMcpSurfaces — parity over MANAGED servers only', () => {
  const mergedPair = (theirClaude, theirVscode) => ({
    claude: JSON.parse(render(SRC, theirClaude).content),
    vscode: JSON.parse(render(SRC_VSCODE, theirVscode, '.vscode/mcp.json').content),
  });

  it('negative control: the unmodified merged pair passes and actually compared both servers', () => {
    const r = compareManagedMcpSurfaces({ ...mergedPair(null, null), managed: MANAGED });
    assert.equal(r.ok, true);
    assert.equal(r.compared, MANAGED.length);
  });

  it("1. an extra server on ONE side only passes (the consumer's own, even if unmodelled)", () => {
    const p = mergedPair(JSON.stringify({ mcpServers: { corp: { type: 'http', url: 'https://x.example/mcp' } } }), null);
    const r = compareManagedMcpSurfaces({ ...p, managed: MANAGED });
    assert.equal(r.ok, true, r.diagnostics.join('; '));
    assert.equal(r.compared, MANAGED.length);
  });

  it('2. a DECLARED divergent managed value passes, reported as excused', () => {
    const p = mergedPair(null, null);
    p.claude.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1'];
    const r = compareManagedMcpSurfaces({ ...p, managed: MANAGED, overriddenPaths: ['.mcp.json'] });
    assert.equal(r.ok, true);
    assert.equal(r.excused, true);
  });

  it('3. an UNDECLARED managed mismatch fails', () => {
    const p = mergedPair(null, null);
    p.claude.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1'];
    const r = compareManagedMcpSurfaces({ ...p, managed: MANAGED });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'mcp/parity-drift');
    assert.deepEqual(r.drifted, ['playwright']);
  });

  it("a managed server missing from one file fails (not the consumer's own)", () => {
    const p = mergedPair(null, null);
    delete p.vscode.servers.mermaid;
    assert.equal(compareManagedMcpSurfaces({ ...p, managed: MANAGED }).ok, false);
  });

  it('an override does not excuse an unrecognisable shape', () => {
    const r = compareManagedMcpSurfaces({ claude: [], vscode: {}, managed: MANAGED, overriddenPaths: ['.mcp.json'] });
    assert.equal(r.ok, false);
  });
});

describe('INTEGRATION: the real sync writes .mcp.json into a temporary consumer', () => {
  it('merges into an existing file and a second run is byte-stable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'root-mcp-sync-'));
    const run = () => execFileSync(process.execPath, [
      path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), '--target-path', tmp, '--no-prompt', '--adopt-orphans',
    ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 });
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { corp: { command: 'their-tool' }, playwright: { command: 'STALE', note: 'kept' } } }, null, 2));
      run();
      const f = path.join(tmp, '.mcp.json');
      const merged = JSON.parse(fs.readFileSync(f, 'utf8'));
      assert.deepEqual(merged.mcpServers.corp, { command: 'their-tool' });
      assert.equal(merged.mcpServers.playwright.command, ours.mcpServers.playwright.command);
      assert.equal(merged.mcpServers.playwright.note, 'kept');
      assert.deepEqual(merged.mcpServers.mermaid, ours.mcpServers.mermaid);
      const before = fs.readFileSync(f);
      run();
      assert.ok(before.equals(fs.readFileSync(f)), 'second sync changed .mcp.json bytes');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
