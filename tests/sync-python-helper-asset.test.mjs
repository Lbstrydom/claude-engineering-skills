/**
 * Tier 3 (consumer sync): the Python parser stage's helper must REACH
 * consumers, land next to the module that runs it, and still parse with the
 * upstream-owned banner injected. A missing helper is reported as
 * `helper-missing` (unparseable) rather than crashing, but it would leave every
 * consumer's .py files unindexed.
 *
 * Plan: docs/plans/python-arch-memory-indexing.md Phase 3.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bundleForRepo, versionContractBundle } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { injectUpstreamBanner, bannerTokenFor } from '../scripts/lib/sync-banner.mjs';
import { probePythonParser } from '../scripts/lib/symbol-index/python-extract.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = 'scripts/lib/symbol-index/python-ast-helper.py';
const DRIVER = 'scripts/lib/symbol-index/python-extract.mjs';

function requirePython() {
  const probe = probePythonParser();
  if (!probe.available) {
    throw new Error(`Python >= 3.9 is required for this suite (install it on PATH, or set ARCH_INDEX_PYTHON): ${probe.reason}`);
  }
  return probe;
}

describe('python-ast-helper.py ships to consumers', () => {
  it('is in every consumer bundle and the version-contract bundle', () => {
    assert.ok(bundleForRepo().files.includes(HELPER), 'bundleForRepo() must include the helper');
    assert.ok(versionContractBundle().files.includes(HELPER), 'versionContractBundle() must include the helper');
    assert.ok(bundleForRepo().files.includes(DRIVER), 'and the driver module that runs it');
  });

  it('lands as a SIBLING of python-extract.mjs (the invariant new URL(\'./python-ast-helper.py\') relies on)', () => {
    const h = sourceRelToDestRel(HELPER);
    const d = sourceRelToDestRel(DRIVER);
    assert.equal(h, 'scripts/.claude-skills/lib/symbol-index/python-ast-helper.py');
    assert.equal(path.posix.dirname(h), path.posix.dirname(d));
  });

  it('gets a # banner, and the bannered helper still parses and runs from a relocated layout', () => {
    const probe = requirePython();
    const dest = sourceRelToDestRel(HELPER);
    assert.equal(bannerTokenFor(dest), '#');
    const bannered = injectUpstreamBanner(fs.readFileSync(path.join(REPO, HELPER), 'utf8'), dest);
    assert.match(bannered.split('\n')[0], /^# .*UPSTREAM-OWNED/);

    // Relocate the PAIR into a consumer-shaped tree and run the real probe +
    // a real request through the bannered helper.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'py-helper-relocated-'));
    try {
      const dir = path.join(root, path.posix.dirname(dest));
      fs.mkdirSync(dir, { recursive: true });
      const helperPath = path.join(dir, 'python-ast-helper.py');
      fs.writeFileSync(helperPath, bannered);
      const relocated = probePythonParser({ helperPath });
      assert.equal(relocated.available, true, relocated.reason);
      const req = [
        JSON.stringify({ v: 1, hello: true }),
        JSON.stringify({ v: 1, id: 1, rel: 'm.py', b64: Buffer.from('def ping():\n    """Pong."""\n').toString('base64'), wantSymbols: true }),
      ].join('\n') + '\n';
      const r = spawnSync(probe.interpreter.command, [...probe.interpreter.prefix, '-I', '-B', helperPath], { input: req, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      const [hello, res] = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(hello.hello, true);
      assert.equal(res.ok, true);
      assert.equal(res.symbols[0].symbolName, 'ping');
      assert.equal(fs.existsSync(path.join(dir, '__pycache__')), false, '-B: no bytecode written into the tooling tree');
    } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('the driver resolves its helper relative to ITSELF, so the relocation carries it', async () => {
    const mod = await import(pathToFileURL(path.join(REPO, DRIVER)).href);
    assert.equal(path.dirname(mod.DEFAULT_HELPER_PATH), path.join(REPO, path.dirname(DRIVER)));
  });
});
