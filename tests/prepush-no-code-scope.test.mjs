/**
 * Cluster A, Phase 4 (fleet 70b5): a push with no implementation files is a distinct MEASURED outcome, NO_CODE_IN_SCOPE - never PASS, never
 * UNMEASURED. docs/plans/prepush-convergence-cluster-a.md ("One subject predicate" and "NO_CODE_IN_SCOPE bypass contract").
 *
 * Two directions are tested on purpose: a bypass that fires on code is a green-without-measuring; a bypass that never fires leaves the
 * package.json-only push refused, which is the defect.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { classifyNoCodePush, buildNoCodeRecord, noCodeLine, codeLine, NO_CODE_OUTCOME } from '../scripts/lib/prepush-audit-gate.mjs';
import { classifyFiles, isAuditInfraFile, auditSubjectFileGuard } from '../scripts/lib/audit-scope.mjs';
import { classifyFileCoverage } from '../scripts/lib/language-profiles.mjs';
import { resolveReferenceExtension } from '../scripts/lib/plan-paths.mjs';
import { noCodeStepLine, CAPABILITIES } from '../scripts/prepush-step.mjs';

const deps = {
  isInfra: (f) => isAuditInfraFile(f),
  taxonomyClass: (f) => classifyFileCoverage(f).class,
  bucketOf: (f) => { const b = classifyFiles([f]); return b.shared.length ? 'shared' : (b.frontend.length ? 'frontend' : 'backend'); },
};
const classify = (files) => classifyNoCodePush({ files, ...deps });

describe('classifyNoCodePush - the per-file table', () => {
  for (const f of ['package.json', 'tsconfig.json', 'package-lock.json', 'logo.png', 'src/config/x.yml', 'src/schemas/a.json', 'manifest.json']) {
    test(`${f} alone is no-code`, () => assert.equal(classify([f]).noCode, true, JSON.stringify(classify([f]))));
  }
  for (const f of ['src/a.mjs', 'src/config/x.ts', 'src/schemas/a.ts', 'src/types/t.ts', 'src/shared/h.mjs', 'README.md', 'Dockerfile', 'a.jsonl', 'styles.css', '.github/workflows/ci.yml']) {
    test(`${f} alone is CODE (the audit reads it as a subject today)`, () => assert.equal(classify([f]).noCode, false, f));
  }
  test('sync bookkeeping alone is NOT relabelled (its own handling stays); alongside a manifest it is no-code', () => {
    assert.equal(classify(['.sync-receipt.json']).noCode, false);
    assert.equal(classify(['.sync-receipt.json', 'scripts/.sync-owned.json']).noCode, false);
    assert.equal(classify(['.sync-receipt.json', 'package.json']).noCode, true);
  });
  test('one code file among many non-code files makes the whole push code', () => {
    assert.equal(classify(['package.json', 'package-lock.json', 'src/a.mjs']).noCode, false);
  });
  test('an audit-infrastructure path is never bypassed (today it aborts UNMEASURED; that is preserved)', () => {
    assert.equal(classify(['scripts/lib/schemas.mjs']).noCode, false);
  });
  test('an unrecognised type is never bypassed', () => {
    assert.equal(classify(['data.zzzunknown']).noCode, false);
  });
  test('an UNEXPECTED taxonomy class never qualifies for the shared-bucket exemption (only an explicit `declarative` does)', () => {
    for (const cls of ['profiled', 'model-only', 'mystery', undefined, null]) {
      assert.equal(classifyNoCodePush({ files: ['src/config/x.thing'], ...deps, taxonomyClass: () => cls, bucketOf: () => 'shared' }).noCode, false, String(cls));
    }
    assert.equal(classifyNoCodePush({ files: ['src/config/x.yml'], ...deps, taxonomyClass: () => 'declarative', bucketOf: () => 'shared' }).noCode, true);
  });
  test('fail closed: unknown list, empty list, junk entries, a throwing classifier', () => {
    assert.equal(classifyNoCodePush({ files: null, ...deps }).noCode, false);
    assert.equal(classify([]).noCode, false);
    assert.equal(classify(['package.json', '']).noCode, false);
    assert.equal(classifyNoCodePush({ files: ['package.json'], ...deps, bucketOf: () => { throw new Error('boom'); }, taxonomyClass: () => 'declarative' }).noCode, false);
  });
});

describe('PARITY with the audit\'s own refusal (the two cannot drift apart)', () => {
  // The audit counts backend+frontend files among those it admits (extension recognised, not vendored, not infra). Re-derive that here
  // from the same functions and demand: no-code  =>  the guard would refuse (the safe implication), and guard-would-accept => not no-code.
  const auditWouldRefuse = (files) => {
    const admitted = files.filter((p) => !isAuditInfraFile(p) && resolveReferenceExtension(p) !== null);
    const { backend, frontend } = classifyFiles(admitted);
    return auditSubjectFileGuard({ scopeMode: 'diff', subjectFileCount: backend.length + frontend.length, hasFileFilter: true, foundCount: admitted.length }) !== null;
  };
  const TABLE = [
    ['package.json'], ['package.json', 'package-lock.json'], ['logo.png', 'a.woff2'], ['src/config/a.yml'], ['src/config/a.ts'], ['tsconfig.json', 'src/types/t.ts'],
    ['src/a.mjs'], ['README.md'], ['Dockerfile'], ['package.json', 'src/a.mjs'], ['a.jsonl'], ['styles.css'], ['x.yml'],
  ];
  for (const files of TABLE) {
    test(`${files.join(' + ')}`, () => {
      const noCode = classify(files).noCode;
      const refuse = auditWouldRefuse(files);
      if (noCode) assert.equal(refuse, true, 'no-code must only be claimed where the audit would refuse for lack of a subject');
      if (!refuse) assert.equal(noCode, false, 'a push the audit can read must not be bypassed');
    });
  }
  test('the table is not vacuous: it contains both a bypassed and a non-bypassed push', () => {
    assert.ok(TABLE.some((f) => classify(f).noCode) && TABLE.some((f) => !classify(f).noCode));
  });
});

describe('record and protocol line', () => {
  test('buildNoCodeRecord carries the outcome token, the tree and the evidence', () => {
    const r = buildNoCodeRecord({ tree: 'a'.repeat(40), base: 'b'.repeat(40), head: 'c'.repeat(40), files: ['package.json'], now: () => 'T' });
    assert.deepEqual(r, { outcome: NO_CODE_OUTCOME, tree: 'a'.repeat(40), base: 'b'.repeat(40), head: 'c'.repeat(40), fileCount: 1, files: ['package.json'], classifiedAt: 'T' });
  });
  test('protocol lines are one line each', () => {
    assert.equal(noCodeLine(2, '.audit/prepush/t.no-code.json'), 'no-code 2 .audit/prepush/t.no-code.json');
    assert.equal(codeLine('a\nb'), 'code a b');
  });
  test('the capability is advertised so the hook can ask before relying on it', () => assert.ok(CAPABILITIES.includes('no-code')));
});

// ── The real CLI against a real repository (Tier 3: the hook trusts this output) ─────────────────────────────────────────────────────────
const run = (cwd, args, env = {}) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', ...env } }).trim();
function repoWith(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nocode-'));
  run(dir, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(dir, 'README.txt'), 'x\n');
  run(dir, ['add', '.']); run(dir, ['commit', '-qm', 'base']);
  const base = run(dir, ['rev-parse', 'HEAD']);
  for (const [f, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), body); }
  run(dir, ['add', '.']); run(dir, ['commit', '-qm', 'push']);
  return { dir, base, head: run(dir, ['rev-parse', 'HEAD']) };
}
const STEP = path.resolve(import.meta.dirname, '../scripts/prepush-step.mjs');
const cli = (cwd, base, head, extra = {}) => spawnSync(process.execPath, [STEP, 'no-code'], {
  cwd, encoding: 'utf8', env: { ...process.env, AUDIT_PUSH_RANGE_BASE: base, AUDIT_PUSH_RANGE_HEAD: head, ...extra },
});

describe('prepush-step.mjs no-code against a real repository', () => {
  test('package.json-only push: `no-code`, rc 0, and the atomic record exists keyed to the pushed tree', () => {
    const { dir, base, head } = repoWith({ 'package.json': '{"name":"x"}\n' });
    const r = cli(dir, base, head);
    assert.equal(r.status, 0, r.stderr);
    const m = /^no-code (\d+) (\S+)\n$/.exec(r.stdout);
    assert.ok(m, `unexpected stdout ${JSON.stringify(r.stdout)}`);
    const tree = run(dir, ['rev-parse', `${head}^{tree}`]);
    assert.equal(m[2].replaceAll('\\', '/'), `.audit/prepush/${tree}.no-code.json`);
    const rec = JSON.parse(fs.readFileSync(path.join(dir, m[2]), 'utf8'));
    assert.equal(rec.outcome, 'NO_CODE_IN_SCOPE');
    assert.equal(rec.tree, tree);
    assert.deepEqual(rec.files, ['package.json']);
    assert.deepEqual(fs.readdirSync(path.join(dir, '.audit/prepush')).filter((e) => e.endsWith('.tmp')), [], 'no temp file left behind');
  });

  test('a push with one code file: `code <reason>` and NO record', () => {
    const { dir, base, head } = repoWith({ 'package.json': '{}\n', 'src/a.mjs': 'export const a = 1;\n' });
    const r = cli(dir, base, head);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^code .*implementation file/);
    assert.equal(fs.existsSync(path.join(dir, '.audit/prepush')), false);
  });

  test('no range handed over by git: `code`, never `no-code`', () => {
    const { dir } = repoWith({ 'package.json': '{}\n' });
    const r = spawnSync(process.execPath, [STEP, 'no-code'], { cwd: dir, encoding: 'utf8', env: { ...process.env, AUDIT_PUSH_RANGE_BASE: '', AUDIT_PUSH_RANGE_HEAD: '' } });
    assert.match(r.stdout, /^code /);
  });

  test('record-write failure: `code record...`, the bypass is refused (a directory squats on the record path)', () => {
    const { dir, base, head } = repoWith({ 'package.json': '{}\n' });
    const tree = run(dir, ['rev-parse', `${head}^{tree}`]);
    fs.mkdirSync(path.join(dir, '.audit/prepush', `${tree}.no-code.json`), { recursive: true });
    const r = cli(dir, base, head);
    assert.match(r.stdout, /^code the no-code record could not be written/);
  });

  test('an in-process call with a throwing git yields `code`, not a rejection', async () => {
    const line = await noCodeStepLine({ env: { AUDIT_PUSH_RANGE_BASE: 'a'.repeat(40), AUDIT_PUSH_RANGE_HEAD: 'b'.repeat(40) }, gitFn: () => { throw new Error('git gone'); }, deps });
    assert.match(line, /^code /);
  });
});
