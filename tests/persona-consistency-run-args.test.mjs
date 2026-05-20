/**
 * @fileoverview Phase 4 runner — argument parsing + fatal exit paths.
 *
 * Tests the CLI argument parser and the early-exit paths that don't require
 * Playwright (fatal-rig on missing canary/manifest, exit 5 on Playwright
 * missing, exit 4 on ledger-persist failure). The full end-to-end Playwright
 * integration test lives in a separate slow suite (gated by the runner
 * pre-flight check in CI).
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseArgs, runConsistency, EXIT }
  from '../scripts/persona-consistency-run.mjs';

// ────────────────────────────────────────────────────────────────────────────
// parseArgs
// ────────────────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  it('parses --canary, --url, --out', () => {
    const a = parseArgs(['--canary', 'oliver', '--url', 'http://x', '--out', 'path.json']);
    assert.equal(a.canary, 'oliver');
    assert.equal(a.url,    'http://x');
    assert.equal(a.out,    'path.json');
  });
  it('parses --help', () => {
    assert.equal(parseArgs(['--help']).help, true);
    assert.equal(parseArgs(['-h']).help,     true);
  });
  it('defaults repoRoot to cwd', () => {
    assert.equal(parseArgs([]).repoRoot, process.cwd());
  });
  it('overrides repoRoot via --repo-root', () => {
    assert.equal(parseArgs(['--repo-root', '/tmp/x']).repoRoot, '/tmp/x');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// runConsistency — early-exit paths
// ────────────────────────────────────────────────────────────────────────────

let tmpDir;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'consistency-run-'));
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(dir, manifest) {
  fs.mkdirSync(path.join(dir, '.persona-test'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.persona-test', 'surfaces.json'),
    JSON.stringify(manifest),
  );
}
function writeCanary(dir, name, canary) {
  fs.mkdirSync(path.join(dir, '.persona-test', 'canaries'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.persona-test', 'canaries', `${name}.json`),
    JSON.stringify(canary),
  );
}

const MIN_MANIFEST = {
  version: 1,
  surfaces: [{
    id: 'status-chip',
    locator: { kind: 'role', role: 'status' },
    severityFloor: 'P0',
    engineFields: [{ field: 'cellarOrganised', type: 'boolean' }],
  }],
};
const MIN_CANARY = {
  name: 'demo',
  personaId: 'pieter',
  fixtureSeed: null,
  journeySteps: [{ action: 'navigate', label: 'open', url: 'http://example.test' }],
  expectedContradictions: { min: 0 },
};

describe('runConsistency — early exits (no Playwright session needed)', () => {
  it('returns FATAL_RIG when --canary or --url missing', async () => {
    const r = await runConsistency({ help: false, canary: null, url: 'x', repoRoot: tmpDir });
    assert.equal(r.exitCode, EXIT.FATAL_RIG);
  });

  it('returns LEDGER_PERSIST when sessions/ is not writable', async () => {
    // Force the sessions path to be a FILE not a directory — fs.mkdirSync
    // will throw on the subsequent ledger write.
    fs.mkdirSync(path.join(tmpDir, '.persona-test'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.persona-test', 'sessions'), 'not-a-dir');
    const r = await runConsistency({ canary: 'demo', url: 'http://x', repoRoot: tmpDir });
    assert.equal(r.exitCode, EXIT.LEDGER_PERSIST);
  });

  it('returns PLAYWRIGHT_MISSING when factory throws', async () => {
    writeManifest(tmpDir, MIN_MANIFEST);
    writeCanary(tmpDir, 'demo', MIN_CANARY);
    const r = await runConsistency(
      { canary: 'demo', url: 'http://x', repoRoot: tmpDir },
      { playwrightFactory: () => { throw new Error('Cannot find module \'playwright\''); } },
    );
    assert.equal(r.exitCode, EXIT.PLAYWRIGHT_MISSING);
    assert.ok(fs.existsSync(r.ledgerPath), 'fatal ledger must be persisted before exit 5');
    const ledger = JSON.parse(fs.readFileSync(r.ledgerPath, 'utf-8'));
    assert.equal(ledger.rigVerdict, 'fatal');
    assert.equal(ledger.failureReason, 'playwright-missing');
  });

  it('returns FATAL_RIG when manifest is missing (resolves R6 ledger persistence)', async () => {
    writeCanary(tmpDir, 'demo', MIN_CANARY);
    const r = await runConsistency(
      { canary: 'demo', url: 'http://x', repoRoot: tmpDir },
      { playwrightFactory: async () => ({ chromium: { launch: async () => ({ close: async () => {} }) } }) },
    );
    assert.equal(r.exitCode, EXIT.FATAL_RIG);
    const ledger = JSON.parse(fs.readFileSync(r.ledgerPath, 'utf-8'));
    assert.equal(ledger.rigVerdict, 'fatal');
    assert.equal(ledger.failureReason, 'manifest-missing');
  });

  it('returns FATAL_RIG when canary is missing (file not in canaries/)', async () => {
    writeManifest(tmpDir, MIN_MANIFEST);
    // Create canaries/ dir but no canary file — R2-H1 fix added an explicit
    // canaries/ dir check that fires first when the dir is also absent.
    fs.mkdirSync(path.join(tmpDir, '.persona-test', 'canaries'), { recursive: true });
    const r = await runConsistency(
      { canary: 'demo', url: 'http://x', repoRoot: tmpDir },
      { playwrightFactory: async () => ({ chromium: { launch: async () => ({ close: async () => {} }) } }) },
    );
    assert.equal(r.exitCode, EXIT.FATAL_RIG);
    const ledger = JSON.parse(fs.readFileSync(r.ledgerPath, 'utf-8'));
    assert.equal(ledger.rigVerdict, 'fatal');
    assert.equal(ledger.failureReason, 'canary-not-found');
  });

  it('returns FATAL_RIG with canary-dir-missing when canaries/ dir is absent (R2-H1)', async () => {
    writeManifest(tmpDir, MIN_MANIFEST);
    // Don't create canaries/ dir.
    const r = await runConsistency(
      { canary: 'demo', url: 'http://x', repoRoot: tmpDir },
      { playwrightFactory: async () => ({ chromium: { launch: async () => ({ close: async () => {} }) } }) },
    );
    assert.equal(r.exitCode, EXIT.FATAL_RIG);
    const ledger = JSON.parse(fs.readFileSync(r.ledgerPath, 'utf-8'));
    assert.equal(ledger.failureReason, 'canary-dir-missing');
  });

  it('returns FATAL_RIG when canary schema is invalid', async () => {
    writeManifest(tmpDir, MIN_MANIFEST);
    writeCanary(tmpDir, 'demo', { name: 'demo', personaId: 'p' });  // missing journeySteps
    const r = await runConsistency(
      { canary: 'demo', url: 'http://x', repoRoot: tmpDir },
      { playwrightFactory: async () => ({ chromium: { launch: async () => ({ close: async () => {} }) } }) },
    );
    assert.equal(r.exitCode, EXIT.FATAL_RIG);
    const ledger = JSON.parse(fs.readFileSync(r.ledgerPath, 'utf-8'));
    assert.equal(ledger.failureReason, 'canary-schema-invalid');
  });

  it('--help returns exit code 0 without touching the filesystem', async () => {
    const r = await runConsistency({ help: true });
    assert.equal(r.exitCode, 0);
    assert.equal(r.ledgerPath, '');
  });
});

describe('EXIT constants', () => {
  it('exposes the documented six exit codes', () => {
    assert.deepEqual(EXIT, {
      HEALTHY: 0, CANARY_BROKEN: 2, FATAL_RIG: 3,
      LEDGER_PERSIST: 4, PLAYWRIGHT_MISSING: 5, APP_ERROR: 6,
    });
  });
});
