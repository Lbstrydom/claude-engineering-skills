import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CROSS_SKILL = path.join(__dirname, '..', 'scripts', 'cross-skill.mjs');

function runCrossSkill(subcmd, payload, cwd) {
  return spawnSync('node', [CROSS_SKILL, subcmd, '--json', JSON.stringify(payload)], {
    cwd: cwd || process.cwd(),
    encoding: 'utf-8',
  });
}

describe('cross-skill compute-target-domains', () => {
  // Set up a temp repo with a domain-map.json so the test is hermetic.
  function setupTempRepo() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tgt-dom-'));
    fs.mkdirSync(path.join(tmp, '.audit-loop'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.audit-loop', 'domain-map.json'),
      JSON.stringify({
        rules: [
          { pattern: 'src/wine-shop/**', domain: 'wine-shop' },
          { pattern: 'src/pairing/**',   domain: 'pairing' },
          { pattern: 'tests/**',         domain: 'tests' },
        ],
      }),
    );
    return tmp;
  }

  it('single domain → not crossDomain', () => {
    const tmp = setupTempRepo();
    try {
      const r = runCrossSkill('compute-target-domains', {
        targetPaths: ['src/wine-shop/index.js', 'src/wine-shop/items.js'],
      }, tmp);
      assert.equal(r.status, 0, `stderr: ${r.stderr}`);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ok, true);
      assert.deepEqual(out.domains, ['wine-shop']);
      assert.equal(out.crossDomain, false);
      assert.deepEqual(out.untaggedPaths, []);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('multiple domains → crossDomain true, sorted', () => {
    const tmp = setupTempRepo();
    try {
      const r = runCrossSkill('compute-target-domains', {
        targetPaths: ['src/pairing/x.js', 'src/wine-shop/y.js', 'tests/z.test.mjs'],
      }, tmp);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.domains, ['pairing', 'tests', 'wine-shop']);
      assert.equal(out.crossDomain, true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('untagged paths surfaced separately (R2-M4)', () => {
    const tmp = setupTempRepo();
    try {
      const r = runCrossSkill('compute-target-domains', {
        targetPaths: ['src/wine-shop/x.js', 'random-utility.js'],
      }, tmp);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.deepEqual(out.domains, ['wine-shop']);
      assert.deepEqual(out.untaggedPaths, ['random-utility.js']);
      assert.equal(out.crossDomain, false, 'one tagged + one untagged is not cross-domain');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('missing targetPaths → exit 1', () => {
    const r = runCrossSkill('compute-target-domains', {});
    assert.equal(r.status, 1);
    // Match BOTH streams: the BAD_INPUT JSON goes to stdout, while stderr may
    // carry the informational `[config] loaded shared cloud config …` line when
    // the shared env sets a var not already in the spawn env. `stderr || stdout`
    // would mask the error whenever that notice is present.
    assert.match(`${r.stderr || ''}\n${r.stdout || ''}`, /BAD_INPUT|targetPaths/);
  });

  it('exposes ruleCount for visibility into config state', () => {
    const tmp = setupTempRepo();
    try {
      const r = runCrossSkill('compute-target-domains', {
        targetPaths: ['src/wine-shop/x.js'],
      }, tmp);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ruleCount, 3);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });

  it('handles repo with no domain-map.json (ruleCount=0, all paths untagged)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-tgt-norules-'));
    try {
      const r = runCrossSkill('compute-target-domains', {
        targetPaths: ['anything.js'],
      }, tmp);
      assert.equal(r.status, 0);
      const out = JSON.parse(r.stdout);
      assert.equal(out.ruleCount, 0);
      assert.deepEqual(out.domains, []);
      assert.deepEqual(out.untaggedPaths, ['anything.js']);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
