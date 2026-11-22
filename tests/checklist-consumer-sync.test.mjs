/**
 * @fileoverview Tier 3 (AGENTS.md): the consumer sync / relocation contract for the diff-triggered checklist.
 *
 * `.audit-loop/checklist.json` is CONSUMER-OWNED. This repo's own entries are CES's incident history (its gates, its paths,
 * its commits); shipping them would hand a consumer tripwires for files it does not have and a `gateContract` for gates it
 * does not run. A consumer receives the TOOL and starts with no file, which `loadChecklist` reads as an empty checklist.
 *
 * The sync ships an allowlist (entry points + their import closure + named assets), so the property to pin is that nothing
 * names the file, and that the managed gitignore block and the untrack list cannot swallow the consumer's own copy.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { getSyncClosure } from '../scripts/lib/sync-inventory.mjs';
import { sourceRelToDestRel } from '../scripts/lib/sync-path-map.mjs';
import { CORE_ENTRY } from '../scripts/lib/sync-entry-lists.mjs';
import { sanitizeGitEnv } from '../scripts/lib/git-env-sanitize.mjs';

// Every temp dir this file makes is removed when it finishes.
const TMP_DIRS = [];
function mkTmp(prefix) { const d = fs.mkdtempSync(prefix); TMP_DIRS.push(d); return d; }
after(() => { for (const d of TMP_DIRS) fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });


const REPO = path.resolve(import.meta.dirname, '..');
const CHECKLIST = '.audit-loop/checklist.json';

test('the tool ships: the CLI, the matcher, the schema and the audit-side block are all in the bundle closure', () => {
  const { files } = getSyncClosure();
  for (const f of ['scripts/checklist.mjs', 'scripts/lib/checklist/match.mjs', 'scripts/lib/checklist/schema.mjs', 'scripts/lib/checklist/context.mjs']) {
    assert.ok(files.includes(f), `${f} is not in the consumer bundle: the audit would import a module the consumer never received`);
  }
  assert.ok(CORE_ENTRY.includes('scripts/checklist.mjs'));
});

test('CES\'s own rules never ship: no bundle file is, or lands as, the consumer\'s checklist', () => {
  const { files } = getSyncClosure();
  assert.ok(fs.existsSync(path.join(REPO, CHECKLIST)), 'precondition: this repo has its own checklist, so the absence below is a decision and not an accident');
  assert.equal(files.filter((f) => /(^|\/)checklist\.json$/.test(f)).length, 0, 'a checklist.json is in the sync closure');
  assert.equal(files.filter((f) => sourceRelToDestRel(f) === CHECKLIST).length, 0, 'a bundle file would land at the consumer\'s checklist path');
  assert.equal(files.some((f) => f.startsWith('.audit-loop/') && !f.startsWith('.audit-loop/migrations/')), false, 'only migrations ship from .audit-loop/ (the sync is an allowlist)');
});

test('nothing in the sync layout names the file: the checklist is neither a shipped asset nor a remapped destination', () => {
  for (const f of ['scripts/lib/sync-inventory.mjs', 'scripts/lib/sync-entry-lists.mjs', 'scripts/lib/sync-path-map.mjs']) {
    const src = fs.readFileSync(path.join(REPO, f), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*')).join('\n');
    assert.equal(/checklist\.json/.test(src), false, `${f} names checklist.json in code`);
  }
});

/** Evaluate a `const NAME = [ ... ];` array literal out of sync-to-repos.mjs (it is not exported, and the CLI cannot be imported to run). */
function arrayLiteral(name) {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'sync-to-repos.mjs'), 'utf8');
  const start = src.indexOf(`const ${name} = [`);
  assert.ok(start >= 0, `${name} not found`);
  const end = src.indexOf('\n];', start);
  return new Function(`return ${src.slice(start + `const ${name} = `.length, end + 2)};`)();
}

test('the managed gitignore block and the untrack list cannot swallow a consumer\'s own checklist', () => {
  const dir = mkTmp(path.join(os.tmpdir(), 'checklist-ignore-'));
  const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env: sanitizeGitEnv(dir) });
  git('init', '-q');
  for (const name of ['MANAGED_IGNORE_PATTERNS', 'UNTRACK_PATTERNS']) {
    const patterns = arrayLiteral(name);
    assert.ok(patterns.length > 5, `${name} parsed to something plausible`);
    fs.writeFileSync(path.join(dir, '.gitignore'), `${patterns.join('\n')}\n`);
    // Positive control: the same machinery DOES ignore a path the block names, so "not ignored" below is a finding.
    assert.equal(git('check-ignore', '-q', '.audit-loop/last-maintenance.json').status, 0, `${name}: control path should be ignored`);
    assert.equal(git('check-ignore', '-q', CHECKLIST).status, 1, `${name} would ignore or untrack the consumer's ${CHECKLIST}`);
  }
});

test('a consumer starts with no checklist and the synced CLI reads that as empty, exit 0', () => {
  const dir = mkTmp(path.join(os.tmpdir(), 'checklist-consumer-'));
  execFileSync('git', ['init', '-q'], { cwd: dir, env: sanitizeGitEnv(dir) });
  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'checklist.mjs'), '--files', 'src/a.mjs', '--json', '--no-record'], { cwd: dir, encoding: 'utf8', env: sanitizeGitEnv(dir) });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.absent, out.evaluated, out.fired.length], [true, 0, 0]);
});
