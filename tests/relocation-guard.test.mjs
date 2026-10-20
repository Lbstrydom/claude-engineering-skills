/**
 * @fileoverview Inventory-driven guard against relocation-breaking patterns.
 *
 * For every script that ships to consumers under `scripts/.claude-skills/`,
 * scan for two anti-patterns that would silently break after relocation:
 *   1. `path.resolve(import.meta.{url|dirname}, '..')` going up beyond `scripts/`.
 *      Allowed pattern: `findRepoRootFromScript(import.meta.url)` or
 *      `assertRepoRoot(import.meta.url)`.
 *   2. Hardcoded `spawn('node', 'scripts/X.mjs')` / `execSync('node scripts/...')`
 *      that bake in the pre-isolation path.
 *
 * Plan §2 KD #10 + Audit R1 H4.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAllConsumerInventories } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { _internals as verifyInternals } from '../scripts/lib/sync-isolation-verify.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const PARENT_RESOLVE_RE = /path\.(resolve|join)\(\s*import\.meta\.(dirname|url)\s*,\s*['"]\.\.['"]/;
// R2 M4 fix: also match execFile / execFileSync / spawnFile forms.
const SPAWN_HARDCODED_RE = /(?:spawn|exec|fork)(?:File)?(?:Sync)?\s*\(\s*['"]node['"]\s*,\s*\[\s*['"]scripts\//;
const EXEC_HARDCODED_RE = /exec(?:Sync|File|FileSync)?\s*\(\s*[`'"]node\s+scripts\//;

function scanFile(absPath) {
  let content;
  try { content = fs.readFileSync(absPath, 'utf-8'); }
  catch { return null; }
  return {
    parentResolve: PARENT_RESOLVE_RE.test(content),
    spawnHardcoded: SPAWN_HARDCODED_RE.test(content),
    execHardcoded: EXEC_HARDCODED_RE.test(content),
  };
}

// R2 M5 fix: iterate ALL consumer inventories (not hardcoded 'ai'). A
// wine-only entry like the DEBT_ENTRY bundle would otherwise escape
// this guard.
function* allSyncedScripts() {
  const seen = new Set();
  for (const [, inv] of getAllConsumerInventories()) {
    for (const srcRel of inv.files) {
      if (seen.has(srcRel)) continue;
      seen.add(srcRel);
      if (!srcRel.endsWith('.mjs') && !srcRel.endsWith('.js')) continue;
      const dst = sourceRelToDestRel(srcRel);
      if (!dst.startsWith('scripts/.claude-skills/')) continue;
      const abs = path.join(REPO_ROOT, srcRel);
      if (!fs.existsSync(abs)) continue;
      yield { srcRel, abs };
    }
  }
}

test('no synced script uses path.resolve(import.meta.dirname, "..") (relocation-breaking)', () => {
  const offenders = [];
  for (const { srcRel, abs } of allSyncedScripts()) {
    const r = scanFile(abs);
    if (r && r.parentResolve) offenders.push(srcRel);
  }
  assert.deepEqual(
    offenders,
    [],
    'Relocation-breaking parent-resolve pattern found.\n' +
    'Replace `path.resolve(import.meta.dirname, "..")` with\n' +
    '`findRepoRootFromScript(import.meta.url)` (in scripts/lib/assert-repo-root.mjs).\n' +
    'Offenders:\n  ' + offenders.join('\n  '),
  );
});

test('no synced script hardcodes spawn/exec/fork of scripts/...', () => {
  const offenders = [];
  for (const { srcRel, abs } of allSyncedScripts()) {
    const r = scanFile(abs);
    if (r && (r.spawnHardcoded || r.execHardcoded)) offenders.push(srcRel);
  }
  assert.deepEqual(offenders, [], 'Hardcoded child-process spawn of scripts/... found in synced scripts');
});

test('every script in CLI_SMOKE_SET has the --selfcheck-relocation handler', async () => {
  // R2 M5 fix: source the CLI list from sync-isolation-verify's _internals
  // rather than hardcoding it again here. One source of truth.
  for (const rel of verifyInternals.CLI_SMOKE_SET) {
    const abs = path.join(REPO_ROOT, 'scripts', rel);
    const content = fs.readFileSync(abs, 'utf-8');
    assert.match(
      content,
      /--selfcheck-relocation/,
      `${rel} is in CLI_SMOKE_SET but lacks a --selfcheck-relocation handler`,
    );
  }
});

test('every library in LIB_IMPORT_SET resolves to an importable module exporting its required symbols', async () => {
  // R2 M5 fix: source LIB_IMPORT_SET from the verifier (one source of truth).
  for (const { rel, mustExport } of verifyInternals.LIB_IMPORT_SET) {
    const abs = path.join(REPO_ROOT, 'scripts', rel);
    assert.ok(fs.existsSync(abs), `LIB_IMPORT_SET entry missing on disk: scripts/${rel}`);
    const mod = await import(`file://${abs.replace(/\\/g, '/')}`);
    for (const sym of mustExport) {
      assert.equal(typeof mod[sym], 'function', `scripts/${rel} must export ${sym}`);
    }
  }
});

// Tier 3(b) for the machine lease (docs/plans/fleet-machine-lease.md): the two modules behind `fleet lease` must be IN
// the synced inventory (so the scans above cover them and a consumer receives them) and must import cleanly. fleet.mjs
// imports lease-cmd.mjs statically, so a broken import also fails fleet.mjs's own --selfcheck-relocation smoke.
test('the fleet lease modules ship to consumers, are scanned by the guards above, and import cleanly', async () => {
  const shipped = new Set([...allSyncedScripts()].map((s) => s.srcRel.replace(/\\/g, '/')));
  for (const rel of ['scripts/lib/fleet/lease.mjs', 'scripts/lib/fleet/lease-cmd.mjs']) {
    assert.ok(shipped.has(rel), `${rel} is not in any consumer inventory: a consumer's \`fleet lease\` would die on MODULE_NOT_FOUND`);
    const abs = path.join(REPO_ROOT, rel);
    const r = scanFile(abs);
    assert.deepEqual(r, { parentResolve: false, spawnHardcoded: false, execHardcoded: false }, `${rel} holds a relocation-breaking pattern`);
    const mod = await import(pathToFileURL(abs).href);
    assert.ok(Object.keys(mod).length > 0, `${rel} exports nothing`);
  }
  const lease = await import(pathToFileURL(path.join(REPO_ROOT, 'scripts/lib/fleet/lease.mjs')).href);
  for (const fn of ['machineDir', 'readLease', 'transactLease', 'decideAcquire', 'decideRelease', 'nextLines']) {
    assert.equal(typeof lease[fn], 'function', `lease.mjs must export ${fn}`);
  }
});

// Tier 3(b) for test-evidence (docs/plans/copilot-feedback-item4.md Cluster C): the CLI, its library and the shared
// spawn resolver must be IN the synced inventory (so the scans above cover them and a consumer receives
// them) and must import cleanly. The CLI is also in CLI_SMOKE_SET, whose relocated --selfcheck-relocation smoke runs it.
test('the test-evidence CLI and library ship to consumers, are scanned by the guards above, and import cleanly', async () => {
  const shipped = new Set([...allSyncedScripts()].map((s) => s.srcRel.replace(/\\/g, '/')));
  const need = {'scripts/test-evidence.mjs': ['run', 'parseArgs'], 'scripts/lib/test-evidence.mjs': ['recordRun', 'checkRun', 'decideReuse', 'recordKey', 'parseJunitCounts'], 'scripts/lib/spawn-target.mjs': ['resolveSpawnTarget', 'describeSpawnFailure'] };
  for (const [rel, symbols] of Object.entries(need)) {
    assert.ok(shipped.has(rel), `${rel} is not in any consumer inventory: a consumer's test-evidence would die on MODULE_NOT_FOUND`);
    const abs = path.join(REPO_ROOT, rel);
    assert.deepEqual(scanFile(abs), { parentResolve: false, spawnHardcoded: false, execHardcoded: false }, `${rel} holds a relocation-breaking pattern`);
    const mod = await import(pathToFileURL(abs).href);
    for (const sym of symbols) assert.equal(typeof mod[sym], 'function', `${rel} must export ${sym}`);
  }
  assert.ok(verifyInternals.CLI_SMOKE_SET.includes('test-evidence.mjs'), 'test-evidence.mjs must be in CLI_SMOKE_SET');
});
