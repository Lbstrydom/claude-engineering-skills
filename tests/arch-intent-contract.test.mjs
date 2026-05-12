import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import {
  EMPTY_REPORT,
  isArchIntentReportClean,
  deriveArchState,
  inventoryFiles,
  computeDeadIntent,
} from '../scripts/lib/arch-intent/adapter-contract.mjs';

const MAP = {
  rules: [
    { pattern: 'src/core/**', domain: 'core' },
    { pattern: 'src/app/**', domain: 'app' },
    { pattern: 'tests/**', domain: 'tests' },
  ],
  allowedDeps: { app: ['core'], tests: ['core', 'app'] },
  description: {},
};

describe('isArchIntentReportClean', () => {
  it('empty report is clean', () => {
    assert.equal(isArchIntentReportClean(EMPTY_REPORT), true);
  });

  it('any violation breaks clean', () => {
    const r = { ...EMPTY_REPORT, violations: [{ fromFile: 'a', toFile: 'b', fromDomain: 'app', toDomain: 'core', ruleViolated: 'not-in-allowedDeps' }] };
    assert.equal(isArchIntentReportClean(r), false);
  });

  it('unmappedFiles breaks clean', () => {
    const r = { ...EMPTY_REPORT, unmappedFiles: ['src/orphan.mjs'] };
    assert.equal(isArchIntentReportClean(r), false);
  });

  it('deadIntent breaks clean', () => {
    const r = { ...EMPTY_REPORT, deadIntent: ['unused-domain'] };
    assert.equal(isArchIntentReportClean(r), false);
  });

  it('per-stack error breaks clean even with zero violations (Gemini-R2/H1 fix)', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [
        { stackKind: 'js-ts', status: 'error', error: { message: 'crash', kind: 'analyzer' } },
      ],
    };
    assert.equal(isArchIntentReportClean(r), false);
  });

  it('per-stack unsupported is OK (no analyzer = no opinion, not a violation)', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [
        { stackKind: 'rust', status: 'unsupported' },
      ],
    };
    assert.equal(isArchIntentReportClean(r), true);
  });
});

describe('deriveArchState', () => {
  it('no per-stack results → SKIPPED_UNSUPPORTED_STACK', () => {
    assert.equal(deriveArchState(EMPTY_REPORT), 'SKIPPED_UNSUPPORTED_STACK');
  });

  it('all stacks errored → ERROR_ALL_STACKS_FAILED', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [{ stackKind: 'js-ts', status: 'error', error: { message: 'x', kind: 'analyzer' } }],
    };
    assert.equal(deriveArchState(r), 'ERROR_ALL_STACKS_FAILED');
  });

  it('only unsupported stacks → SKIPPED_UNSUPPORTED_STACK', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [{ stackKind: 'rust', status: 'unsupported' }],
    };
    assert.equal(deriveArchState(r), 'SKIPPED_UNSUPPORTED_STACK');
  });

  it('mixed success+error → ANALYZED_PARTIAL', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [
        { stackKind: 'js-ts', status: 'ok', report: { violations: [], _meta: {} } },
        { stackKind: 'python', status: 'error', error: { message: 'x', kind: 'analyzer' } },
      ],
    };
    assert.equal(deriveArchState(r), 'ANALYZED_PARTIAL');
  });

  it('all ok + clean → ANALYZED_CLEAN', () => {
    const r = {
      ...EMPTY_REPORT,
      perStackResults: [{ stackKind: 'js-ts', status: 'ok', report: { violations: [], _meta: {} } }],
    };
    assert.equal(deriveArchState(r), 'ANALYZED_CLEAN');
  });

  it('all ok + violations → ANALYZED_WITH_FINDINGS', () => {
    const r = {
      violations: [{ fromFile: 'a', toFile: 'b', fromDomain: 'app', toDomain: 'core', ruleViolated: 'not-in-allowedDeps' }],
      unmappedFiles: [],
      deadIntent: [],
      analyzerVersion: 'test',
      perStackResults: [{ stackKind: 'js-ts', status: 'ok', report: { violations: [], _meta: {} } }],
      _meta: {},
    };
    assert.equal(deriveArchState(r), 'ANALYZED_WITH_FINDINGS');
  });
});

describe('inventoryFiles + computeDeadIntent (synthetic fixture)', () => {
  let tmpDir;

  it('builds inventory from a synthetic repo (no git)', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-test-'));
    fs.mkdirSync(path.join(tmpDir, 'src/core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'src/app'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src/core/a.mjs'), '// core a');
    fs.writeFileSync(path.join(tmpDir, 'src/app/b.mjs'), '// app b');
    fs.writeFileSync(path.join(tmpDir, 'tests/c.test.mjs'), '// test c');
    fs.writeFileSync(path.join(tmpDir, 'src/orphan.mjs'), '// orphan');

    const { mapped, unmappedFiles } = await inventoryFiles(tmpDir, MAP);
    assert.equal(mapped.size, 3, `expected 3 mapped, got ${mapped.size}: ${[...mapped.entries()]}`);
    assert.equal(unmappedFiles.length, 1);
    assert.match(unmappedFiles[0], /orphan/);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('computeDeadIntent reports declared-but-empty domains', () => {
    const mapped = new Map([['src/core/a.mjs', 'core']]);
    const mapWithDead = { ...MAP, allowedDeps: { core: [], app: [], 'unused-dead': [] } };
    const dead = computeDeadIntent(mapped, mapWithDead);
    assert.ok(dead.includes('app'));
    assert.ok(dead.includes('tests'));
    assert.ok(dead.includes('unused-dead'));
    assert.equal(dead.includes('core'), false, 'core has a mapped file');
    assert.equal(dead.includes('vendor'), false, 'vendor pseudo-domain must be excluded');
  });
});
