/**
 * @fileoverview Tier 3(b), the consumer sync contract, for the read-only re-check of a shipped head
 * (docs/plans/coordinator-aggregate-ship.md section 9). A break here ships silently to repos nobody can observe, so the test is
 * same-commit with the code.
 *
 * (1) Every new module is IN the sync closure, so a consumer receives it. (2) In a RELOCATED layout (`scripts/.claude-skills/`),
 * built by copying the closure through the real path map: the relocated CLI answers `--selfcheck-relocation`, and
 * `--check-shipped-head` answers its v1 envelope, refusing the evidence row when the store is off.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const norm = (p) => String(p).replace(/\\/g, '/');
const GENERATED_ABSENT_OK = new Set(['scripts/.sync-manifest.json']);
const missing = [];
const NEW_MODULES = [
  'scripts/lib/ship-shipped-head.mjs',
  'scripts/lib/store/ship-run-facts.mjs',
  'scripts/ship-commit.mjs',
];
// scripts/lib/fleet/coordinator-grant.mjs is deliberately NOT here: nothing imports it until `fleet land --ship-batch` (a follow-up PR)
// does, and the sync closure is built from entry points, so it enters the closure with its first caller.

describe('the new modules are in the sync closure', () => {
  const closure = new Set(getSyncClosure().files.map(norm));
  for (const rel of NEW_MODULES) {
    it(`${rel} ships to consumers`, () => {
      assert.ok(closure.has(rel), `${rel} is not in the sync closure`);
    });
  }
});

describe('in a relocated layout', () => {
  let tmp;
  let repo;
  const reloc = (rel) => path.join(tmp, sourceRelToDestRel(rel));
  before(() => {
    // Inside the repo so node resolves the repo's node_modules (zod, pg) exactly as a consumer's own would be.
    fs.mkdirSync(path.join(ROOT, '.claude', 'tmp'), { recursive: true });
    tmp = fs.mkdtempSync(path.join(ROOT, '.claude', 'tmp', 'reloc-'));
    for (const f of getSyncClosure().files.map(norm)) {
      if (!f.startsWith('scripts/') || !/\.(mjs|js|json)$/.test(f)) continue;
      // ONLY the documented generated artifacts may be absent; any other missing closure file is a broken checkout, and a relocated
      // test over it would prove nothing.
      if (!fs.existsSync(path.join(ROOT, f))) { if (GENERATED_ABSENT_OK.has(f)) continue; missing.push(f); continue; }
      const dest = path.join(tmp, sourceRelToDestRel(f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), dest);
    }
    assert.deepEqual(missing, [], 'closure files absent from this checkout (only generated artifacts may be)');
    repo = fs.mkdtempSync(path.join(tmp, 'consumer-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const run = (script, args, cwd = repo) => spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf-8', windowsHide: true, timeout: 120_000,
    // An empty DSN is the air-gap signal: the store is off whatever ~/.audit-loop.env says.
    env: { ...process.env, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', AZURE_OPENAI_ENDPOINT: '' },
  });

  it('the destination layout is the isolated one', () => {
    assert.match(norm(reloc('scripts/ship-commit.mjs')), /scripts\/\.claude-skills\/ship-commit\.mjs$/);
    assert.ok(fs.existsSync(reloc('scripts/ship-commit.mjs')));
  });

  it('the relocated ship-commit answers --selfcheck-relocation', () => {
    const r = run(reloc('scripts/ship-commit.mjs'), ['--selfcheck-relocation']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /OK/);
  });

  it('the relocated --check-shipped-head answers its v1 envelope (a correctable argument error is exit 2, not a pass)', () => {
    const r = run(reloc('scripts/ship-commit.mjs'), ['--check-shipped-head', '--json']);
    assert.equal(r.status, 2, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.schema, 'shipped-head/v1');
    assert.equal(env.ok, false);
  });

  it('with the store off, the relocated check refuses the evidence row instead of passing', () => {
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T'); g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', 'a.txt'); g('commit', '-q', '-m', 'one');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    const r = run(reloc('scripts/ship-commit.mjs'), ['--check-shipped-head', '--head', head, '--offline', '--json']);
    assert.equal(r.status, 2, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false);
    assert.ok(env.conditions.some((c) => c.id === 'evidence' && !c.ok), 'the evidence row must refuse');
  });
});
