/**
 * @fileoverview The bundle's OWN generated stores are data the tooling owns, not code under review (upstream 3b84d8bb).
 *
 * Since CES #247 the tech-debt ledger is one committed file per entry, so a migration PR touches hundreds of them; the
 * adjacency preflight counted every one against `maxChangedFiles` and forced INPUT_BOUND / PARTIAL.
 * Plan: docs/plans/audit-unadmitted-files.md D4-D6 (PR 2).
 *
 * Real `git` in a temp repo for everything that depends on git's own partitioning (pathspecs, rename detection):
 * a mocked numstat would only prove the mock.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  DEBT_LEDGER_STEM, SYNC_RECEIPT_PATH, BUNDLE_GENERATED_STORES, isBundleGeneratedStore, bundleStorePathspecs,
} from '../scripts/lib/bundle-generated-stores.mjs';
import { DEFAULT_DEBT_LEDGER_PATH } from '../scripts/lib/debt-ledger.mjs';
import { resolveLedgerLocation } from '../scripts/lib/debt-ledger-files.mjs';
import { RECEIPT_PATH } from '../scripts/lib/sync-receipt.mjs';
import { matchFileKind } from '../scripts/lib/file-taxonomy.mjs';
import { gitNumstatWithWorkingTree, gitUnifiedDiffWithWorkingTree } from '../scripts/lib/vcs.mjs';
import { runAdjacencyAnalysis } from '../scripts/lib/audit/adjacency-detector.mjs';
import { INCOMPLETENESS_KINDS } from '../scripts/lib/audit/adjacency-state.mjs';
import { adjacencyConfig } from '../scripts/lib/config.mjs';
import { gitInitWithEmptyCommit, gitFixtureEnv } from './helpers/fixtures.mjs';

const ENTRY = '.audit/tech-debt/entries/topic-1.json';

describe('the registry', () => {
  it('recognises every form the ledger and the receipt take, in either slash style and any case', () => {
    for (const p of [ENTRY, '.audit/tech-debt.json', '.audit/tech-debt/budgets.json', '.sync-receipt.json',
      '.audit\\tech-debt\\entries\\x.json', './.audit/tech-debt/entries/x.json', '.AUDIT/Tech-Debt.JSON', '.audit/tech-debt/ENTRIES/X.JSON']) {
      assert.equal(isBundleGeneratedStore(p), true, p);
    }
  });
  it('control: near-misses are NOT stores (anchored at the repo root, exact names)', () => {
    for (const p of ['.audit/tech-debt-notes.md', 'src/.audit/tech-debt.json', '.audit/other/entries/x.json',
      'docs/.sync-receipt.json', '.audit/tech-debt.json.bak', 'tech-debt.json', '',
      // audit-code R1-H1: only the writers' real layout is owned, never the directory around it
      '.audit/tech-debt/migrate.mjs', '.audit/tech-debt/notes.md', '.audit/tech-debt/entries/helper.mjs',
      '.audit/tech-debt/entries/sub/x.json', '.audit/tech-debt/other.json', '.audit/tech-debt/entries/']) {
      assert.equal(isBundleGeneratedStore(p), false, p);
    }
  });
  it('drift detection: the writers resolve into the registry, not merely to equal constants', () => {
    assert.equal(DEFAULT_DEBT_LEDGER_PATH, `${DEBT_LEDGER_STEM}.json`);
    assert.equal(RECEIPT_PATH, SYNC_RECEIPT_PATH);
    const loc = resolveLedgerLocation(DEFAULT_DEBT_LEDGER_PATH);
    const rel = (abs) => path.relative(process.cwd(), abs).replaceAll('\\', '/');
    assert.equal(isBundleGeneratedStore(rel(loc.legacyFile)), true, 'legacy file');
    assert.equal(isBundleGeneratedStore(`${rel(loc.entriesDir)}/any-topic.json`), true, 'an entry');
    assert.equal(isBundleGeneratedStore(rel(loc.budgetsFile)), true, 'budgets');
    assert.ok(BUNDLE_GENERATED_STORES.length >= 3 && Object.isFrozen(BUNDLE_GENERATED_STORES));
  });
  it('exposes exclude and include pathspecs for the same set', () => {
    const ex = bundleStorePathspecs({ exclude: true });
    const inc = bundleStorePathspecs({ exclude: false });
    assert.equal(ex.length, inc.length);
    assert.ok(ex.every((s) => s.startsWith(':(top,') && s.includes('exclude')));
    assert.ok(inc.every((s) => s.startsWith(':(top,') && !s.includes('exclude')));
  });
});

describe('the taxonomy treats a generated store as an expected exclusion', () => {
  it('non-code, with a reason that names the rule — not `uncovered`, so no unrecognised-file warning', () => {
    const m = matchFileKind(ENTRY);
    assert.equal(m.kind, 'non-code');
    assert.match(m.rule, /^generated-store/);
    assert.equal(matchFileKind('.sync-receipt.json').kind, 'non-code');
  });
  it('control: an ordinary json file, and a near-miss, keep their kind', () => {
    assert.equal(matchFileKind('src/data.json').kind, 'declarative');
    assert.equal(matchFileKind('src/.audit/tech-debt.json').kind, 'declarative');
  });
});

// ── real git ────────────────────────────────────────────────────────────────

function repo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-stores-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));
  gitInitWithEmptyCommit(dir);
  return dir;
}
const git = (dir, args) => execFileSync('git', args, { cwd: dir, env: gitFixtureEnv(), encoding: 'utf8' }).trim();
const write = (dir, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
const EXCLUDE = ['.', ...bundleStorePathspecs({ exclude: true })];
// A source with a conditional container, so "analysed" is observable: runAdjacencyAnalysis reports containersEnumerated.
const WITH_BRANCH = (n) => [`export function f${n}(x) {`, '  if (x) {', '    const a = 1;', '    const b = 2;', '    return a + b;', '  }', '  return 0;', '}', ''].join('\n');

describe('vcs pathspecs', () => {
  it('no `pathspecs` ⇒ the unchanged command: a store file is counted like any other', (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    write(dir, ENTRY, '{}\n'); write(dir, 'a.mjs', 'export const a = 1;\n');
    git(dir, ['add', '-A']);
    const ns = gitNumstatWithWorkingTree(dir, base);
    assert.deepEqual(ns.files.map((f) => f.path).sort(), [ENTRY, 'a.mjs']);
  });
  it('with the exclude pathspecs, numstat AND the unified diff carry no store hunk', (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    write(dir, ENTRY, '{"big":"' + 'x'.repeat(5000) + '"}\n'); write(dir, 'a.mjs', 'export const a = 1;\n');
    git(dir, ['add', '-A']);
    const ns = gitNumstatWithWorkingTree(dir, base, { pathspecs: EXCLUDE });
    assert.deepEqual(ns.files.map((f) => f.path), ['a.mjs']);
    const ud = gitUnifiedDiffWithWorkingTree(dir, base, { pathspecs: EXCLUDE });
    assert.ok(ud.diffText.includes('a.mjs') && !ud.diffText.includes('tech-debt'), 'the patch never carried the store');
  });
  it('audit-code R1-H1 negative control: a script or note under .audit/tech-debt/ stays visible in numstat and the patch', (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    write(dir, ENTRY, '{}\n');
    write(dir, '.audit/tech-debt/migrate.mjs', 'export const m = 1;\n');
    write(dir, '.audit/tech-debt/notes.md', 'hand-written\n');
    write(dir, '.audit/tech-debt/entries/helper.mjs', 'export const h = 1;\n');
    write(dir, '.audit/tech-debt/entries/sub/x.json', '{}\n');
    git(dir, ['add', '-A']);
    const ns = gitNumstatWithWorkingTree(dir, base, { pathspecs: EXCLUDE });
    assert.deepEqual(ns.files.map((f) => f.path).sort(), [
      '.audit/tech-debt/entries/helper.mjs', '.audit/tech-debt/entries/sub/x.json', '.audit/tech-debt/migrate.mjs', '.audit/tech-debt/notes.md']);
    const ud = gitUnifiedDiffWithWorkingTree(dir, base, { pathspecs: EXCLUDE });
    assert.ok(ud.diffText.includes('migrate.mjs') && !ud.diffText.includes('entries/topic-1'));
  });
  it('rename endpoints: git sees only visible paths', (t) => {
    const dir = repo(t);
    write(dir, 'src/moved-in.mjs', 'export const moveIn = "unique content line one\\nline two\\nline three\\nline four";\n');
    write(dir, '.audit/tech-debt/entries/was-here.json', '{"unique":"content line one\\nline two\\nline three\\nline four"}\n');
    write(dir, 'src/visible-a.mjs', 'export const keep = "a rename candidate\\nwith several\\nlines of text\\nto match";\n');
    git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base']);
    const base = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['mv', 'src/visible-a.mjs', 'src/visible-b.mjs']);                     // visible -> visible
    git(dir, ['mv', 'src/moved-in.mjs', '.audit/tech-debt/entries/moved-out.json']); // visible -> store
    git(dir, ['mv', '.audit/tech-debt/entries/was-here.json', 'src/came-out.mjs']);  // store -> visible
    git(dir, ['add', '-A']);
    const ns = gitNumstatWithWorkingTree(dir, base, { pathspecs: EXCLUDE });
    const paths = ns.files.map((f) => f.path).join('\n');
    assert.match(paths, /visible-a\.mjs.*visible-b\.mjs|visible-b\.mjs/, 'visible->visible stays a (rename) record');
    assert.match(paths, /moved-in\.mjs/, 'visible->store is a deletion of the visible file');
    assert.match(paths, /came-out\.mjs/, 'store->visible is an addition of the visible file');
    assert.doesNotMatch(paths, /tech-debt/, 'no store endpoint survives');
  });
});

describe('the adjacency bound counts only what it bounds', () => {
  const bounds = { ...adjacencyConfig, maxChangedFiles: 5, maxChangedLines: 100000 };
  const inputBound = (r) => r.incompleteness.filter((i) => i.kind === INCOMPLETENESS_KINDS.INPUT_BOUND);

  it('70 store files + 3 source files does not trip maxChangedFiles=5', async (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 70; i++) write(dir, `.audit/tech-debt/entries/t${i}.json`, `{"i":${i}}\n`);
    for (let i = 0; i < 3; i++) write(dir, `src/s${i}.mjs`, WITH_BRANCH(i));
    write(dir, '.audit/tech-debt/migrate.mjs', WITH_BRANCH(9));   // audit-code R1-H1: a real script in the ledger dir is analysed too
    git(dir, ['add', '-A']);
    const r = await runAdjacencyAnalysis({ repoRoot: dir, auditBaseCommit: base, bounds });
    assert.deepEqual(inputBound(r), [], JSON.stringify(r.incompleteness));
    assert.ok(r.coverage.containersEnumerated >= 4, `the 4 visible sources were enumerated, got ${r.coverage.containersEnumerated}`);
  });

  it('control (negative): 6 source files still trip it, naming that no stores were counted away', async (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 6; i++) write(dir, `src/s${i}.mjs`, `export const s${i} = ${i};\n`);
    git(dir, ['add', '-A']);
    const r = await runAdjacencyAnalysis({ repoRoot: dir, auditBaseCommit: base, bounds });
    const hit = inputBound(r);
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /6 changed files exceeds maxChangedFiles=5/);
    assert.doesNotMatch(hit[0].detail, /bundle-generated/);
  });

  it('when it does fire, the message says how many store files were not counted', async (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    for (let i = 0; i < 12; i++) write(dir, `.audit/tech-debt/entries/t${i}.json`, `{"i":${i}}\n`);
    for (let i = 0; i < 6; i++) write(dir, `src/s${i}.mjs`, `export const s${i} = ${i};\n`);
    git(dir, ['add', '-A']);
    const r = await runAdjacencyAnalysis({ repoRoot: dir, auditBaseCommit: base, bounds });
    const hit = inputBound(r);
    assert.equal(hit.length, 1);
    assert.match(hit[0].detail, /6 changed files exceeds maxChangedFiles=5/, 'the count excludes the 12 stores');
    assert.match(hit[0].detail, /12 further changed file\(s\) are bundle-generated stores and were not counted/);
  });

  it('store hunks larger than maxDiffBytes do not trip the byte bound; a control with source alone over it does', async (t) => {
    const dir = repo(t);
    const base = git(dir, ['rev-parse', 'HEAD']);
    write(dir, ENTRY, `{"blob":"${'x'.repeat(20000)}"}\n`);
    write(dir, 'src/small.mjs', WITH_BRANCH(1));
    git(dir, ['add', '-A']);
    const tight = { ...bounds, maxChangedFiles: 60, maxDiffBytes: 4096 };
    const ok = await runAdjacencyAnalysis({ repoRoot: dir, auditBaseCommit: base, bounds: tight });
    assert.deepEqual(inputBound(ok), [], JSON.stringify(ok.incompleteness));
    assert.ok(ok.coverage.containersEnumerated >= 1, 'the small source was enumerated although the store patch alone exceeds maxDiffBytes');
    write(dir, 'src/huge.mjs', `export const huge = "${'y'.repeat(20000)}";\n`);
    git(dir, ['add', '-A']);
    const over = await runAdjacencyAnalysis({ repoRoot: dir, auditBaseCommit: base, bounds: tight });
    assert.ok(inputBound(over).length >= 1, 'source alone over the byte bound must still fire');
  });
});
