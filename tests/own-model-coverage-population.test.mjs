/**
 * @fileoverview `own-model-coverage snapshot` carries the same `population` as `check --live`, derived from the
 * measurement outcome: a snapshot in which no entry was measured is "measured from 0 stores", never a store-wide claim.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { main } from '../scripts/own-model-coverage.mjs';
import { storeFingerprint } from '../scripts/lib/db/client.mjs';
import { parsePopulationLine } from '../scripts/lib/population.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const DSN = 'postgres://u:pw@population-test.example.invalid:5432/audit_loop';
const FP8 = storeFingerprint(DSN).slice(0, 8);

async function snapshot(measure) {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'omc-pop-')), 'snap.json');
  const before = process.env.AUDIT_DB_URL;
  process.env.AUDIT_DB_URL = DSN;
  const realStderr = process.stderr.write.bind(process.stderr);
  const lines = [];
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true; };
  try {
    const code = await main(['node', 'own-model-coverage.mjs', 'snapshot', '--out', out], { initStore: async () => true, measureLive: measure });
    return { code, doc: JSON.parse(fs.readFileSync(out, 'utf8')), stderr: lines.join('') };
  } finally {
    process.stderr.write = realStderr;
    if (before === undefined) delete process.env.AUDIT_DB_URL; else process.env.AUDIT_DB_URL = before;
    fs.rmSync(path.dirname(out), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

describe('own-model-coverage snapshot — population', () => {
  it('a measured snapshot carries the store as measured, and prints the line', async () => {
    const { code, doc, stderr } = await snapshot(async (entries) => entries.map((e) => ({ table: e.table, column: e.column, status: 'ok' })));
    assert.equal(code, 0);
    assert.equal(doc.population.schema, 'population/v1');
    assert.deepEqual(doc.population.measured.map((m) => [m.store, m.scope]), [[FP8, 'store']]);
    assert.ok(parsePopulationLine(stderr));
  });

  it('negative control: with NO entry measured the population is measured from 0 stores', async () => {
    const { doc } = await snapshot(async (entries) => entries.map((e) => ({ table: e.table, column: e.column, status: 'unmeasured:store' })));
    assert.deepEqual(doc.population.measured, []);
    assert.ok(doc.population.notMeasured.length >= 1, 'the store is named as not measured');
    assert.ok(doc.population.notMeasured.some((n) => n.reason === 'store-unreachable'), 'the unanswered store is the one named store-unreachable');
  });

  it('offline (empty DSN is the air-gap signal): exit 3, nothing written', () => {
    const out = path.join(os.tmpdir(), `omc-pop-offline-${process.pid}.json`);
    try {
      execFileSync(process.execPath, ['scripts/own-model-coverage.mjs', 'snapshot', '--out', out], {
        cwd: ROOT, encoding: 'utf8', env: { ...process.env, AUDIT_DB_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      assert.fail('should exit 3');
    } catch (err) {
      assert.equal(err.status, 3);
      assert.equal(fs.existsSync(out), false);
    }
  });
});
