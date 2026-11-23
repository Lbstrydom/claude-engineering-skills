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
import { renderConsumerMcp, planRootMcp } from '../scripts/lib/sync-mcp-optin.mjs';
import { validateOverrides } from '../scripts/lib/sync-overrides.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf8');
const SRC_VSCODE = fs.readFileSync(path.join(REPO_ROOT, '.vscode', 'mcp.json'), 'utf8');
const cfg = { ownedSourceTails: new Set() };
const render = (srcContent, existingContent = null, rel = '.mcp.json') =>
  renderOutbound({ srcRel: rel, dstRel: rel, srcContent, existingContent, rewriteConfig: cfg });
const ours = JSON.parse(SRC);
const MANAGED = managedServerNames(ours);

/** An opted-in consumer that pins + has installed @playwright/mcp (and nothing else): only `playwright` is managed there. */
const PINNED_MANAGED = ['playwright'];
const OPT_IN = { version: 1, syncOptIn: [{ feature: 'root-mcp-json', reason: 'test consumer pins @playwright/mcp' }] };
const seedPinnedConsumer = (tmp, { pkg = '@playwright/mcp', version = '0.0.85', bin = { 'playwright-mcp': 'cli.js' }, optIn = true, lock = true } = {}) => {
  fs.mkdirSync(path.join(tmp, 'node_modules', ...pkg.split('/')), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'node_modules', ...pkg.split('/'), 'package.json'), JSON.stringify({ name: pkg, version, bin }));
  fs.writeFileSync(path.join(tmp, 'node_modules', ...pkg.split('/'), typeof bin === 'string' ? bin : Object.values(bin)[0]), '');
  fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ name: 'consumer', devDependencies: { [pkg]: version } }));
  if (lock) fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { [`node_modules/${pkg}`]: { version } } }));
  if (optIn) fs.writeFileSync(path.join(tmp, '.sync-overrides.json'), JSON.stringify(OPT_IN));
};

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
  it('a managed server absent from BOTH files fails (filtering alone would read as parity)', () => {
    const p = mergedPair(null, null);
    delete p.claude.mcpServers.mermaid;
    delete p.vscode.servers.mermaid;
    const r = cmp(p);
    assert.equal(r.ok, false);
    assert.deepEqual(r.drifted, ['mermaid']);
    assert.match(r.diagnostics.join(';'), /absent from both/);
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
  const withConsumer = (fn, seed = seedPinnedConsumer) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gate10-'));
    try {
      if (seed) seed(tmp);
      realSync(tmp);
      // Reload through the SCHEMA: a non-strict schema would strip an undeclared field here.
      const parsed = SyncManifestSchema.parse(JSON.parse(fs.readFileSync(manifestPath(tmp), 'utf8')));
      assert.deepEqual(parsed.mcpManagedServers, PINNED_MANAGED, 'the manifest carries exactly the servers shipped to this consumer, sorted');
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
    assert.equal(g.details.compared, PINNED_MANAGED.length);
    assert.equal(exitOf(tmp), 0);
  }));

  it("pass: the consumer's own server on one side only is never judged, exit 0", () => withConsumer(({ tmp, gate }) => {
    editJson(path.join(tmp, '.mcp.json'), (j) => { j.mcpServers.corp = { type: 'http', url: 'https://x.example/mcp' }; });
    assert.equal(gate().result, 'pass');
    assert.equal(exitOf(tmp), 0);
  }));

  it('declared: either file claimed in .sync-overrides.json means no compare, exit 0 even with a mismatch', () => withConsumer(({ tmp, gate }) => {
    editJson(path.join(tmp, '.mcp.json'), (j) => { j.mcpServers.playwright.args = ['-y', '@playwright/mcp@0.0.1']; });
    fs.writeFileSync(path.join(tmp, '.sync-overrides.json'), JSON.stringify({ ...OPT_IN, overrides: [{ path: '.vscode/mcp.json', reason: 'pinned locally' }] }));
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
    // Field kept, file gone: a delivery that did not land is unmeasured, never not-applicable.
    assert.equal(gate().result, 'unmeasured');
    assert.notEqual(exitOf(tmp), 0);
    editJson(manifestPath(tmp), (j) => { delete j.mcpManagedServers; });
    assert.equal(gate().result, 'not-applicable');
    assert.equal(exitOf(tmp), 0);
    editJson(manifestPath(tmp), (j) => { j.mcpManagedServers = ['playwright', 'mermaid']; });   // unsorted
    const bad = gate();
    assert.equal(bad.gate, 'preflight');
    assert.match(bad.error, /manifest schema invalid/);
    assert.notEqual(exitOf(tmp), 0);
  }));
});

describe('root .mcp.json is OPT-IN per consumer and never launches by a network fetch', () => {
  const run = (tmp) => execFileSync(process.execPath, [
    path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), '--target-path', tmp, '--no-prompt', '--adopt-orphans',
  ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 });
  const withTmp = (seed, fn) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-optin-'));
    try { seed?.(tmp); const out = run(tmp); return fn(tmp, out); }
    finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  };
  const manifest = (tmp) => JSON.parse(fs.readFileSync(path.join(tmp, 'scripts', '.sync-manifest.json'), 'utf8'));
  const gate10 = (tmp) => runGates({ consumerRoot: tmp, gates: ['10'] })[0];
  const OWN = '{"mcpServers":{"corp":{"command":"x"}}}\n';

  it('an opted-OUT consumer gets no .mcp.json, an untouched pre-existing one, and gate 10 reads not-applicable', () => withTmp(
    (tmp) => { seedPinnedConsumer(tmp, { optIn: false }); fs.writeFileSync(path.join(tmp, '.mcp.json'), OWN); },
    (tmp) => {
      assert.equal(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'), OWN, 'the consumer file is never merged into');
      assert.ok(!('.mcp.json' in manifest(tmp).files));
      assert.equal(manifest(tmp).mcpManagedServers, undefined);
      assert.equal(gate10(tmp).result, 'not-applicable');
    },
  ));

  it('an opted-out consumer with no file at all is not handed one', () => withTmp(
    (tmp) => seedPinnedConsumer(tmp, { optIn: false }),
    (tmp) => { assert.ok(!fs.existsSync(path.join(tmp, '.mcp.json'))); assert.equal(gate10(tmp).result, 'not-applicable'); },
  ));

  it('an opted-in consumer pinned to @playwright/mcp@0.0.85 gets `node …/cli.js`, no npx, no mermaid, and parity passes', () => withTmp(
    (tmp) => seedPinnedConsumer(tmp),
    (tmp, out) => {
      const root = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'));
      assert.deepEqual(Object.keys(root.mcpServers), ['playwright']);
      assert.equal(root.mcpServers.playwright.command, 'node');
      assert.deepEqual(root.mcpServers.playwright.args, ['node_modules/@playwright/mcp/cli.js', '--headless']);
      const vs = JSON.parse(fs.readFileSync(path.join(tmp, '.vscode', 'mcp.json'), 'utf8'));
      assert.deepEqual(vs.servers.playwright.args, root.mcpServers.playwright.args);
      assert.ok(!/npx|0\.0\.84|mcp-mermaid/.test(JSON.stringify([root, vs])), 'no fetch launcher, no source pin, no unadmitted package');
      assert.match(out, /mermaid left out: mcp-mermaid is not declared in package\.json/);
      assert.equal(gate10(tmp).result, 'pass');
    },
  ));

  it("the emitted launcher follows the consumer's own pin, never the source's", () => withTmp(
    (tmp) => seedPinnedConsumer(tmp, { version: '0.0.91' }),
    (tmp) => {
      const args = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8')).mcpServers.playwright.args;
      assert.equal(args[0], 'node_modules/@playwright/mcp/cli.js');
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'node_modules/@playwright/mcp/package.json'), 'utf8')).version, '0.0.91');
    },
  ));

  it('an opted-in consumer that also pins mcp-mermaid gets that entry', () => withTmp(
    (tmp) => {
      seedPinnedConsumer(tmp);
      fs.mkdirSync(path.join(tmp, 'node_modules', 'mcp-mermaid'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'mcp-mermaid', 'package.json'), JSON.stringify({ name: 'mcp-mermaid', version: '0.4.1', bin: 'build/index.js' }));
      fs.mkdirSync(path.join(tmp, 'node_modules', 'mcp-mermaid', 'build'), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', 'mcp-mermaid', 'build', 'index.js'), '');
      fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/mcp': { version: '0.0.85' }, 'node_modules/mcp-mermaid': { version: '0.4.1' } } }));
      fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ devDependencies: { '@playwright/mcp': '0.0.85', 'mcp-mermaid': '0.4.1' } }));
    },
    (tmp) => {
      const m = JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8')).mcpServers.mermaid;
      assert.deepEqual([m.command, m.args], ['node', ['node_modules/mcp-mermaid/build/index.js']]);
      assert.deepEqual(manifest(tmp).mcpManagedServers, ['mermaid', 'playwright']);
    },
  ));

  it('every omission is a line in the sync output, including the opt-out itself', () => {
    withTmp((tmp) => seedPinnedConsumer(tmp, { optIn: false }), (_tmp, out) => assert.match(out, /\.mcp\.json not shipped: not opted in/));
  });

  it('a stale CES-managed npx entry left in the consumer file is REPORTED, not silently kept or rewritten', () => withTmp(
    (tmp) => { seedPinnedConsumer(tmp, { optIn: false }); fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { mermaid: { command: 'npx', args: ['-y', 'mcp-mermaid@0.4.1'] } } })); },
    (tmp, out) => {
      assert.match(out, /stale CES-managed server "mermaid" in \.mcp\.json is no longer shipped/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8')).mcpServers.mermaid.command, 'npx', 'reported, never edited');
    },
  ));

  it('a consumer that holds .mcp.json in .sync-overrides.json is not overwritten, opted in or out', () => {
    for (const optIn of [false, true]) {
      withTmp(
        (tmp) => {
          seedPinnedConsumer(tmp, { optIn: false });
          fs.writeFileSync(path.join(tmp, '.mcp.json'), OWN);
          fs.writeFileSync(path.join(tmp, '.sync-overrides.json'), JSON.stringify({ ...(optIn ? OPT_IN : { version: 1 }), overrides: [{ path: '.mcp.json', reason: 'declined locally' }] }));
        },
        (tmp) => assert.equal(fs.readFileSync(path.join(tmp, '.mcp.json'), 'utf8'), OWN),
      );
    }
  });

  it('opted in but nothing pinned: neither MCP file is shipped and gate 10 is not-applicable (never a pass)', () => withTmp(
    (tmp) => fs.writeFileSync(path.join(tmp, '.sync-overrides.json'), JSON.stringify(OPT_IN)),
    (tmp, out) => {
      assert.ok(!fs.existsSync(path.join(tmp, '.mcp.json')));
      assert.ok(!fs.existsSync(path.join(tmp, '.vscode', 'mcp.json')));
      assert.match(out, /\.mcp\.json not shipped: no server is pinned, locked and installed/);
      assert.equal(gate10(tmp).result, 'not-applicable');
    },
  ));
});

describe('renderConsumerMcp — what is left out, and why', () => {
  const tmpWith = (pkgJson, installed, lock = true) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-render-'));
    if (pkgJson) fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify(pkgJson));
    for (const [name, j] of Object.entries(installed ?? {})) {
      fs.mkdirSync(path.join(tmp, 'node_modules', ...name.split('/')), { recursive: true });
      fs.writeFileSync(path.join(tmp, 'node_modules', ...name.split('/'), 'package.json'), JSON.stringify(j));
      if (typeof j.bin === 'object' && Object.keys(j.bin).length === 1) fs.writeFileSync(path.join(tmp, 'node_modules', ...name.split('/'), Object.values(j.bin)[0]), '');
    }
    if (lock) fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: Object.fromEntries(Object.entries(installed ?? {}).map(([n, j]) => [`node_modules/${n}`, { version: j.version }])) }));
    return tmp;
  };
  const render = (tmp) => { try { return renderConsumerMcp({ sourceText: SRC, consumerRoot: tmp }); } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } };
  const pw = (v) => ({ '@playwright/mcp': { version: v, bin: { 'playwright-mcp': 'cli.js' } } });

  it('a range is not a pin: left out', () => {
    const r = render(tmpWith({ devDependencies: { '@playwright/mcp': '^0.0.85' } }, pw('0.0.85')));
    assert.equal(r.text, null);
    assert.match(r.notes.join(';'), /not an exact version/);
  });
  it('declared but installed at another version: left out, never emitted at either version', () => {
    const r = render(tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.84')));
    assert.equal(r.text, null);
    assert.match(r.notes.join(';'), /not installed/);
  });
  it('declared but not installed at all: left out', () => {
    assert.equal(render(tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, {})).text, null);
  });
  it('a bin with several entries and no match is ambiguous: left out; one that escapes the package is refused', () => {
    const amb = render(tmpWith({ dependencies: { '@playwright/mcp': '0.0.85' } }, { '@playwright/mcp': { version: '0.0.85', bin: { a: 'a.js', b: 'b.js' } } }));
    assert.equal(amb.text, null);
    const esc = render(tmpWith({ dependencies: { '@playwright/mcp': '0.0.85' } }, { '@playwright/mcp': { version: '0.0.85', bin: '../../evil.js' } }));
    assert.equal(esc.text, null);
  });
  it('a pin that is installed but absent from the lockfile (or has no lockfile) is not proof: left out', () => {
    const r = render(tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'), false));
    assert.equal(r.text, null);
    assert.match(r.notes.join(';'), /not locked/);
  });
  it('a lockfile that records another version is left out', () => {
    const tmp = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'), false);
    fs.writeFileSync(path.join(tmp, 'package-lock.json'), JSON.stringify({ packages: { 'node_modules/@playwright/mcp': { version: '0.0.84' } } }));
    assert.equal(render(tmp).text, null);
  });
  it('a bin file that does not exist on disk is left out', () => {
    const tmp = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'));
    fs.rmSync(path.join(tmp, 'node_modules', '@playwright', 'mcp', 'cli.js'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = render(tmp);
    assert.equal(r.text, null);
    assert.match(r.notes.join(';'), /does not exist/);
  });
  const withLock = (name, text) => {
    const tmp = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'), false);
    fs.writeFileSync(path.join(tmp, name), text);
    return tmp;
  };
  it('lockfile records are exact: a longer version, a similar name or a comment is not a record (pnpm, yarn, bun)', () => {
    assert.equal(render(withLock('pnpm-lock.yaml', "packages:\n  '@playwright/mcp@0.0.850':\n    resolution: {}\n")).text, null);
    assert.equal(render(withLock('pnpm-lock.yaml', "# @playwright/mcp@0.0.85\npackages:\n  'x@playwright/mcp@0.0.85':\n")).text, null);
    assert.equal(render(withLock('yarn.lock', '"@playwright/mcp@^0.0.850":\n  version "0.0.850"\n')).text, null);
    assert.equal(render(withLock('yarn.lock', '# @playwright/mcp@0.0.85\n\n"@playwright/mcp@^0.0.85":\n  version "0.0.84"\n')).text, null);
    assert.equal(render(withLock('bun.lock', '{"packages":{"x":["@playwright/mcp@0.0.850"]}}')).text, null);
  });
  it('positive control: the exact record IS accepted in each lockfile format', () => {
    for (const [f, t] of [
      ['pnpm-lock.yaml', "packages:\n  '@playwright/mcp@0.0.85':\n    resolution: {}\n"],
      ['yarn.lock', '"@playwright/mcp@^0.0.85", "@playwright/mcp@0.0.85":\n  version "0.0.85"\n'],
      ['yarn.lock', '"@playwright/mcp@npm:0.0.85":\n  version: 0.0.85\n'],
      ['bun.lock', '{"packages":{"@playwright/mcp":["@playwright/mcp@0.0.85"]}}'],
    ]) assert.notEqual(render(withLock(f, t)).text, null, f);
  });
  it('an unversioned or otherwise unresolvable network launcher is left out, never copied as if local', () => {
    const tmp = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'));
    try {
      const src = JSON.stringify({ mcpServers: {
        bare: { command: 'npx', args: ['-y', 'some-pkg'] },
        dlx: { command: 'pnpm', args: ['dlx', 'some-pkg@1.0.0'] },
        floating: { command: 'npx', args: ['-y', 'some-pkg@latest'] },
        local: { command: 'node', args: ['node_modules/x/cli.js'] },
      } });
      const r = renderConsumerMcp({ sourceText: src, consumerRoot: tmp });
      assert.deepEqual(r.names, ['local']);
      assert.equal(r.notes.length, 3);
    } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('optionalDependencies overrides dependencies for the same name (npm precedence)', () => {
    const r = render(tmpWith({ dependencies: { '@playwright/mcp': '0.0.84' }, optionalDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85')));
    assert.notEqual(r.text, null);
  });
  it('a lockfile whose JSON is null is a rejection, not a crash', () => {
    assert.equal(render(withLock('package-lock.json', 'null')).text, null);
  });
  it('an opted-in consumer whose package pin was removed has the old node entry REPORTED as stale', () => {
    const tmp = tmpWith({ devDependencies: {} }, {});
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { playwright: { command: 'node', args: ['node_modules/@playwright/mcp/cli.js'] }, corp: { command: 'x' } } }));
      const plan = planRootMcp({ consumerRoot: tmp, sourceRoot: REPO_ROOT, syncOptIn: OPT_IN.syncOptIn });
      const stale = plan.notes.filter((n) => /stale CES-managed/.test(n));
      assert.equal(stale.length, 1);
      assert.match(stale[0], /"playwright" in \.mcp\.json/);
    } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('a bin that node cannot run is left out; a shebang-node bin without an extension is accepted', () => {
    const sh = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, { '@playwright/mcp': { version: '0.0.85', bin: { 'playwright-mcp': 'cli' } } });
    fs.writeFileSync(path.join(sh, 'node_modules', '@playwright', 'mcp', 'cli'), '#!/bin/sh\necho hi\n');
    const r = render(sh);
    assert.equal(r.text, null);
    assert.match(r.notes.join(';'), /not a node script/);
    const ok = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, { '@playwright/mcp': { version: '0.0.85', bin: { 'playwright-mcp': 'cli' } } });
    fs.writeFileSync(path.join(ok, 'node_modules', '@playwright', 'mcp', 'cli'), '#!/usr/bin/env node\n');
    assert.notEqual(render(ok).text, null);
  });
  it('a malformed package.json or lockfile is reported as BROKEN, not as an absent declaration', () => {
    const bad = tmpWith(null, pw('0.0.85'));
    fs.writeFileSync(path.join(bad, 'package.json'), '{ not json');
    assert.match(render(bad).notes.join(';'), /package\.json is unreadable/);
    const badLock = tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85'), false);
    fs.writeFileSync(path.join(badLock, 'package-lock.json'), '{ not json');
    assert.match(render(badLock).notes.join(';'), /package-lock\.json is unreadable/);
  });
  it('planRootMcp returns the stale-entry diagnostics in notes even when the caller passes no logger', () => {
    const tmp = tmpWith(null, {});
    try {
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { mermaid: { command: 'npx', args: ['-y', 'mcp-mermaid@0.4.1'] } } }));
      const plan = planRootMcp({ consumerRoot: tmp, sourceRoot: REPO_ROOT, syncOptIn: [] });
      assert.ok(plan.notes.some((n) => /stale CES-managed server "mermaid"/.test(n)));
    } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });
  it('no package.json at all: nothing is emitted', () => {
    assert.equal(render(tmpWith(null, pw('0.0.85'))).text, null);
  });
  it('negative control: rendering never touches the source, so CES keeps its own .mcp.json', () => {
    render(tmpWith({ devDependencies: { '@playwright/mcp': '0.0.85' } }, pw('0.0.85')));
    assert.equal(fs.readFileSync(path.join(REPO_ROOT, '.mcp.json'), 'utf8'), SRC);
    assert.deepEqual(ours.mcpServers.playwright.args, ['-y', '@playwright/mcp@0.0.84', '--headless']);
    assert.deepEqual(MANAGED, ['mermaid', 'playwright']);
  });
});

describe('.sync-overrides.json syncOptIn', () => {
  it('accepts the known feature, and rejects an unknown feature, a missing reason and a non-array', () => {
    assert.deepEqual(validateOverrides(OPT_IN).syncOptIn.map((e) => e.feature), ['root-mcp-json']);
    assert.match(validateOverrides({ version: 1, syncOptIn: [{ feature: 'nope', reason: 'x' }] }).errors.join(), /unknown feature/);
    assert.match(validateOverrides({ version: 1, syncOptIn: [{ feature: 'root-mcp-json' }] }).errors.join(), /reason/);
    assert.match(validateOverrides({ version: 1, syncOptIn: {} }).errors.join(), /must be an array/);
  });
  it('planRootMcp: no declaration means the root file is omitted and the source is used for neither', () => {
    const plan = planRootMcp({ consumerRoot: os.tmpdir(), sourceRoot: REPO_ROOT, syncOptIn: [] });
    assert.equal(plan.optedIn, false);
    assert.ok(plan.omit.has('.mcp.json'));
    assert.equal(plan.textFor('.mcp.json'), null);
  });
});
