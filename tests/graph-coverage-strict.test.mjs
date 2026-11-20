/**
 * @fileoverview `getGraphCoverage(…, {strict:true})` rethrows a failed read instead of returning the same `null` as
 * "no row". Run against a port nothing listens on, in a child process, so the real store seam is exercised.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const freePort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});

async function probe(call) {
  const port = await freePort();
  const code = `
    import('./scripts/lib/store/arch/coverage.mjs').then(async (m) => {
      let out;
      try { out = { returned: await m.getGraphCoverage('r-1', 'repo-1'${call}) ?? null }; }
      catch (e) { out = { threw: true, code: e.code ?? null }; }
      process.stdout.write('RESULT:' + JSON.stringify(out) + '\\n');
      process.exit(0);
    });`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: ROOT, encoding: 'utf-8', timeout: 60000, windowsHide: true,
    env: { ...process.env, AUDIT_DB_URL: `postgresql://u:p@127.0.0.1:${port}/audit_loop`, AUDIT_DB_SSL_MODE: 'disable' },
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
  assert.ok(line, r.stderr);
  return JSON.parse(line.slice('RESULT:'.length));
}

describe('getGraphCoverage on an unreachable store', () => {
  it('default: degrades to null (the historical contract for callers that can live with unknown)', async () => {
    assert.deepEqual(await probe(''), { returned: null });
  });
  it('strict: the failure is rethrown, so a caller can tell it from "no row"', async () => {
    const r = await probe(', { strict: true }');
    assert.equal(r.threw, true);
  });
});
