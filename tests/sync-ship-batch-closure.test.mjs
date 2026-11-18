/**
 * @fileoverview Tier 3(b), the consumer sync contract, for the coordinator batch landing
 * (docs/plans/coordinator-aggregate-ship.md section 9). A break here ships silently to repos nobody can observe, so the test
 * is same-commit with the code.
 *
 * (1) Every new module is IN the sync closure, so a consumer receives it. (2) In a RELOCATED layout (`scripts/.claude-skills/`),
 * built by copying the closure through the real path map: fleet's child-path resolution finds `ship-commit.mjs`, the relocated
 * CLI answers `--selfcheck-relocation`, `--check-shipped-head` answers its v1 envelope, and the relocated `fleet land
 * --ship-batch` refuses without the grant (exit 3) before it looks at a single session.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const norm = (p) => String(p).replace(/\\/g, '/');
const NEW_MODULES = [
  'scripts/lib/fleet/coordinator-grant.mjs',
  'scripts/lib/fleet/ship-batch.mjs',
  'scripts/lib/ship-shipped-head.mjs',
  'scripts/lib/store/ship-run-facts.mjs',
  'scripts/ship-commit.mjs',
  'scripts/fleet.mjs',
];

describe('the new modules are in the sync closure', () => {
  const closure = new Set(getSyncClosure().files.map(norm));
  for (const rel of NEW_MODULES) {
    it(`${rel} ships to consumers (a consumer's \`--ship-batch\` would otherwise die on MODULE_NOT_FOUND)`, () => {
      assert.ok(closure.has(rel), `${rel} is not in the sync closure`);
    });
  }
  it('the skill reference the SKILL.md index names ships too', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'skills/fleet/references/ship-batch.md')));
    assert.ok(fs.existsSync(path.join(ROOT, '.claude/skills/fleet/references/ship-batch.md')), 'the generated copy must be committed (npm run skills:regenerate)');
  });
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
      // A closure entry may be a generated file this checkout has not produced (`.sync-manifest.json`): the code is what matters.
      if (!fs.existsSync(path.join(ROOT, f))) continue;
      const dest = path.join(tmp, sourceRelToDestRel(f));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, f), dest);
    }
    repo = fs.mkdtempSync(path.join(tmp, 'consumer-'));
    spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
  });
  after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const run = (script, args, cwd = repo) => spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf-8', windowsHide: true, timeout: 120_000,
    // An empty HOME holds no grant; an empty DSN is the air-gap signal (the store is off whatever ~/.audit-loop.env says).
    env: { ...process.env, HOME: repo, USERPROFILE: repo, AUDIT_DB_URL: '', LEARNING_DISABLE: '1', AZURE_OPENAI_ENDPOINT: '', FLEET_TELEMETRY: 'off' },
  });

  it('the destination layout is the isolated one', () => {
    assert.match(norm(reloc('scripts/ship-commit.mjs')), /scripts\/\.claude-skills\/ship-commit\.mjs$/);
    assert.ok(fs.existsSync(reloc('scripts/ship-commit.mjs')));
  });

  it('fleet\'s child-path resolution finds ship-commit.mjs next to it, not the pre-isolation scripts/ path', async () => {
    const mod = await import(pathToFileURL(reloc('scripts/lib/fleet/ship-batch.mjs')).href);
    const resolved = mod.shipCommitPath();
    assert.equal(norm(resolved), norm(reloc('scripts/ship-commit.mjs')));
    assert.ok(fs.existsSync(resolved));
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

  it('the relocated `fleet land --ship-batch` refuses without the grant (exit 3, grant-absent) and builds nothing', () => {
    const r = run(reloc('scripts/fleet.mjs'), ['land', '--ship-batch', '--json']);
    assert.equal(r.status, 3, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout + r.stderr, /grant-absent/);
    assert.match(r.stdout + r.stderr, /declaration check, not verified authority/);
  });

  it('with the store off, the relocated child refuses the evidence row instead of passing', () => {
    // A throwaway repo with one commit: HEAD is the head, there is no marker and no store, so the verdict is a refusal.
    const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf-8' });
    g('config', 'user.email', 't@example.com'); g('config', 'user.name', 'T'); g('config', 'commit.gpgsign', 'false');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    g('add', 'a.txt'); g('commit', '-q', '-m', 'one');
    g('branch', '-M', 'main');
    g('update-ref', 'refs/remotes/origin/main', g('rev-parse', 'HEAD').stdout.trim()); // the child measures the change against a base first
    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    g('add', 'b.txt'); g('commit', '-q', '-m', 'two');
    const head = g('rev-parse', 'HEAD').stdout.trim();
    const r = run(reloc('scripts/ship-commit.mjs'), ['--check-shipped-head', '--head', head, '--base', 'main', '--offline', '--json']);
    assert.equal(r.status, 2, r.stderr);
    const env = JSON.parse(r.stdout);
    assert.equal(env.ok, false);
    assert.ok(env.conditions.some((c) => c.id === 'evidence' && !c.ok), 'the evidence row must refuse');
  });
});

describe('ship-batch has no edge to the CES-only tier machinery, static or computed', () => {
  it('its source never names ci-verdict, and the sync closure carries neither ci-verdict.mjs nor test-tier.mjs', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/lib/fleet/ship-batch.mjs'), 'utf8');
    assert.equal(/ci-verdict|ciVerdict|test-tier/.test(src), false, 'ship-batch.mjs must not import (or compute an import of) the CES-only full-suite verdict');
    const closure = new Set(getSyncClosure().files.map(norm));
    for (const f of ['scripts/lib/ci-verdict.mjs', 'scripts/lib/test-tier.mjs']) assert.equal(closure.has(f), false, `${f} must not reach a consumer`);
  });
});
