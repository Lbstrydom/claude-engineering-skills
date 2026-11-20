/**
 * Unit tests for the Python parser stage (scripts/lib/symbol-index/python-extract.mjs).
 *
 * Tier 3 (sensitive-path egress): the stage reads only admitted files, bound
 * to the admission identity, and never hands the helper a path. Every helper
 * failure mode is driven through a controllable fake helper so each candidate
 * is shown to end in exactly one terminal outcome.
 *
 * Plan: docs/plans/python-arch-memory-indexing.md §2.2–2.10.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  probePythonParser, readAdmittedSource, toSymbolCandidates, runPythonHelper,
  bucketPythonImports, guardedMetaReader, OUTCOME, DEFAULT_HELPER_PATH, PYTHON_ENV_VAR,
} from '../scripts/lib/symbol-index/python-extract.mjs';

const FAKE = fileURLToPath(new URL('./helpers/fake-python-helper.mjs', import.meta.url));
const fake = (...args) => ({ command: process.execPath, args: [FAKE, ...args] });
const reqs = (k) => Array.from({ length: k }, (_, i) => ({
  id: i + 1, rel: `m${i + 1}.py`, bytes: Buffer.from(`x = ${i}\n`), wantSymbols: true,
}));
const outcomes = (results) => [...results.values()].map((r) => r.outcome);

let tmp;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'py-extract-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

describe('probePythonParser', () => {
  const ok = () => ({ status: 0, stdout: '3.11.4\n' });

  it('reports helper-missing (never available) when the helper file is absent', () => {
    const r = probePythonParser({ env: {}, helperPath: path.join(tmp, 'nope.py'), run: ok });
    assert.equal(r.available, false);
    assert.equal(r.reason, 'helper-missing');
  });

  it('accepts the first interpreter reporting >= 3.9 and runs it isolated (-I)', () => {
    const calls = [];
    const r = probePythonParser({
      env: {}, platform: 'linux', helperPath: DEFAULT_HELPER_PATH,
      run: (cmd, args) => { calls.push([cmd, ...args]); return ok(); },
    });
    assert.equal(r.available, true);
    assert.equal(r.version, '3.11.4');
    assert.deepEqual(calls[0].slice(0, 2), ['python3', '-I']);
  });

  it('rejects an interpreter below 3.9 and a Store-stub non-zero exit', () => {
    const r = probePythonParser({
      env: {}, platform: 'win32', helperPath: DEFAULT_HELPER_PATH,
      run: (cmd) => (cmd === 'py' ? { status: 0, stdout: '3.8.10' } : { status: 9009, stdout: '' }),
    });
    assert.equal(r.available, false);
    assert.match(r.reason, /3\.8\.10/);
  });

  it(`an explicit ${PYTHON_ENV_VAR} is the ONLY interpreter tried — no silent fall-through`, () => {
    const tried = [];
    const r = probePythonParser({
      env: { [PYTHON_ENV_VAR]: '/does/not/exist/python' }, platform: 'linux', helperPath: DEFAULT_HELPER_PATH,
      run: (cmd) => { tried.push(cmd); return { status: null, error: Object.assign(new Error('x'), { code: 'ENOENT' }) }; },
    });
    assert.equal(r.available, false);
    assert.deepEqual(tried, ['/does/not/exist/python']);
    assert.match(r.reason, new RegExp(PYTHON_ENV_VAR));
  });
});

describe('readAdmittedSource — read bound to the admission (Tier 3)', () => {
  const admitted = (p) => ({ canonicalPath: fs.realpathSync(p) });

  it('reads an admitted file', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'def f():\n    return 1\n');
    const r = readAdmittedSource(admitted(p), { maxBytes: 1024 });
    assert.equal(r.ok, true);
    assert.equal(r.bytes.toString(), 'def f():\n    return 1\n');
  });

  it('fails closed with identity-changed when the file is swapped between admission and read', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'def f(): pass\n');
    const adm = admitted(p);
    const r = readAdmittedSource(adm, {
      maxBytes: 1024,
      beforeRead: () => { fs.rmSync(p); fs.writeFileSync(p, 'SECRET = "swapped in"\n'); },
    });
    assert.equal(r.ok, false);
    assert.equal(r.outcome, OUTCOME.IDENTITY_CHANGED);
  });

  it('refuses growth of the same inode past the cap (bounded read)', () => {
    const p = path.join(tmp, 'a.py');
    fs.writeFileSync(p, 'x = 1\n');
    const r = readAdmittedSource(admitted(p), { maxBytes: 8, beforeRead: () => fs.appendFileSync(p, 'y = 2\n') });
    assert.equal(r.ok, false);
    assert.ok([OUTCOME.IDENTITY_CHANGED, OUTCOME.SIZE_CAP].includes(r.outcome), r.outcome);
  });

  it('refuses a file over the cap without reading it', () => {
    const p = path.join(tmp, 'big.py');
    fs.writeFileSync(p, 'x'.repeat(100));
    const r = readAdmittedSource(admitted(p), { maxBytes: 10 });
    assert.equal(r.outcome, OUTCOME.SIZE_CAP);
  });
});

describe('toSymbolCandidates — explicit field allowlist', () => {
  const good = { symbolName: 'f', kind: 'function', startLine: 1, endLine: 2, signature: 'def f()', bodyText: 'def f(): pass', isExported: true };

  it('keeps only allowlisted fields (an unknown key such as a docstring field never survives)', () => {
    const r = toSymbolCandidates([{ ...good, docstring: 'AKIA...', extra: 1 }]);
    assert.equal(r.ok, true);
    assert.deepEqual(Object.keys(r.candidates[0]).sort(),
      ['bodyText', 'endLine', 'isExported', 'kind', 'signature', 'startLine', 'symbolName']);
  });

  it('fails the whole file closed on a missing or ill-typed field', () => {
    assert.equal(toSymbolCandidates([{ ...good, startLine: '1' }]).ok, false);
    assert.equal(toSymbolCandidates([{ ...good, kind: 'component' }]).ok, false);
    assert.equal(toSymbolCandidates([good, { ...good, bodyText: undefined }]).ok, false);
    assert.equal(toSymbolCandidates('nope').ok, false);
  });
});

describe('runPythonHelper — protocol and failure accounting (fake helper)', () => {
  const fast = { fileTimeoutMs: 1500, helloTimeoutMs: 1500, heartbeatMs: 100 };

  it('parses every request and beats per response', async () => {
    let beats = 0;
    const { results } = await runPythonHelper(reqs(3), { ...fake('ok'), ...fast, onBeat: () => beats++ });
    assert.deepEqual(outcomes(results), [OUTCOME.PARSED, OUTCOME.PARSED, OUTCOME.PARSED]);
    assert.ok(beats >= 3);
  });

  it('a malformed line is counted and never attributed; the file it would have answered fails closed', async () => {
    const { results, protocolErrors } = await runPythonHelper(reqs(2), { ...fake('malformed'), ...fast });
    assert.ok(protocolErrors >= 1);
    assert.equal(results.get(1).outcome, OUTCOME.TIMEOUT);
    assert.equal(results.get(2).outcome, OUTCOME.PARSED);
  });

  it('duplicate and unknown ids are protocol errors, never another file\'s answer', async () => {
    const dup = await runPythonHelper(reqs(2), { ...fake('dup-id'), ...fast });
    assert.deepEqual(outcomes(dup.results), [OUTCOME.PARSED, OUTCOME.PARSED]);
    assert.ok(dup.protocolErrors >= 1);
    const wrong = await runPythonHelper(reqs(2), { ...fake('wrong-id'), ...fast });
    assert.equal(wrong.results.get(1).outcome, OUTCOME.TIMEOUT);
    assert.ok(wrong.protocolErrors >= 1);
  });

  it('a hang before hello restarts, then exhausts, and every candidate is helper-died', async () => {
    const { results, restarts } = await runPythonHelper(reqs(2), { ...fake('hang-hello'), ...fast, helloTimeoutMs: 200, maxRestarts: 1 });
    assert.deepEqual(outcomes(results), [OUTCOME.HELPER_DIED, OUTCOME.HELPER_DIED]);
    assert.ok(restarts >= 1);
  });

  it('a hang on a file is a timeout for THAT file only', async () => {
    const { results } = await runPythonHelper(reqs(2), { ...fake('hang-file'), ...fast, fileTimeoutMs: 200, maxRestarts: 0 });
    assert.equal(results.get(1).outcome, OUTCOME.TIMEOUT);
    assert.equal(results.get(2).outcome, OUTCOME.HELPER_DIED, 'restarts exhausted: the queued file is terminal too');
  });

  it('a slow-but-in-deadline helper succeeds and the heartbeat keeps beating', async () => {
    let beats = 0;
    const { results } = await runPythonHelper(reqs(1), { ...fake('slow', '450'), ...fast, onBeat: () => beats++ });
    assert.equal(results.get(1).outcome, OUTCOME.PARSED);
    assert.ok(beats >= 3, `expected periodic beats during the slow parse, got ${beats}`);
  });

  it('an oversize line fails the in-flight file and is counted', async () => {
    const { results, protocolErrors } = await runPythonHelper(reqs(2), { ...fake('oversize'), ...fast, maxLineBytes: 1024 });
    assert.equal(results.get(1).outcome, OUTCOME.HELPER_DIED);
    assert.equal(results.get(2).outcome, OUTCOME.PARSED, 'the restarted helper serves the rest');
    assert.ok(protocolErrors >= 1);
  });

  it('a helper that dies permanently after file 2 leaves files 3..5 helper-died — never-sent ones included', async () => {
    const mark = path.join(tmp, 'dead.mark');
    process.env.FAKE_HELPER_MARK = mark;
    try {
      const { results } = await runPythonHelper(reqs(5), { ...fake('die-after', '2'), ...fast, maxRestarts: 2 });
      assert.deepEqual(outcomes(results),
        [OUTCOME.PARSED, OUTCOME.PARSED, OUTCOME.HELPER_DIED, OUTCOME.HELPER_DIED, OUTCOME.HELPER_DIED]);
      assert.equal(results.size, 5, 'every candidate has exactly one terminal outcome');
    } finally { delete process.env.FAKE_HELPER_MARK; }
  });

  it('a command that cannot spawn is helper-died for every candidate', async () => {
    const { results } = await runPythonHelper(reqs(2), { command: path.join(tmp, 'no-such-binary'), args: [], ...fast, maxRestarts: 0 });
    assert.deepEqual(outcomes(results), [OUTCOME.HELPER_DIED, OUTCOME.HELPER_DIED]);
  });
});

describe('bucketPythonImports — every offered edge lands in exactly one bucket', () => {
  const ref = (module, { kind = 'import', names = [], dots = 0 } = {}) => ({
    kind, module, names, isRelative: dots > 0, dotCount: dots, line: 1,
  });
  const indexFiles = ['src/shop/__init__.py', 'src/shop/orders/__init__.py', 'src/shop/orders/service.py',
    'src/shop/orders/pricing.py', 'tools/cli.py'];

  it('resolves src-layout relative and absolute imports, and buckets the rest', () => {
    const importsByFile = new Map([
      ['src/shop/orders/service.py', [
        ref('pricing', { kind: 'from', names: ['total_price'], dots: 1 }), // relative → persisted
        ref('os'), ref('os'),                                                // stdlib, deduped → 1 external
        ref('requests'),                                                     // third-party → external
        ref('nowhere', { kind: 'from', names: ['x'], dots: 1 }),             // relative miss → unresolved
      ]],
      ['tools/cli.py', [
        ref('shop.orders.service', { kind: 'from', names: ['OrderService'] }), // absolute → persisted
        ref('shop.missing', { kind: 'from', names: ['nope'] }),               // known local package → unresolved
      ]],
    ]);
    const { edges, buckets, offered } = bucketPythonImports({ importsByFile, indexFiles, repoRoot: tmp });
    assert.deepEqual(edges.map((e) => `${e.importer}->${e.imported}`).sort(), [
      'src/shop/orders/service.py->src/shop/orders/pricing.py',
      'tools/cli.py->src/shop/orders/service.py',
    ]);
    assert.deepEqual(buckets, { external: 2, selfEdge: 0, escaping: 0, unresolved: 2, disowned: 0, persisted: 2 });
    assert.equal(offered, 6);
  });

  it('a refused file is absent from the index, so no edge can name it', () => {
    const importsByFile = new Map([['tools/cli.py', [ref('shop.orders.secret_store', { kind: 'from', names: ['KEY'] })]]]);
    const { edges, buckets } = bucketPythonImports({ importsByFile, indexFiles, repoRoot: tmp });
    assert.equal(edges.length, 0);
    assert.equal(buckets.unresolved, 1);
  });

  it('a disowned endpoint is bucketed disowned, not persisted', () => {
    const importsByFile = new Map([['tools/cli.py', [ref('shop.orders.service', { kind: 'from', names: ['X'] })]]]);
    const { edges, buckets } = bucketPythonImports({
      importsByFile, indexFiles, repoRoot: tmp, disowned: new Set(['src/shop/orders/service.py']),
    });
    assert.equal(edges.length, 0);
    assert.equal(buckets.disowned, 1);
  });
});

describe('guardedMetaReader — root discovery never opens a refused metadata file (Tier 3)', () => {
  function trySymlink(t, target, link) {
    try { fs.symlinkSync(target, link); return true; } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') { t.skip(`symlinks unavailable here (${err.code})`); return false; }
      throw err;
    }
  }

  it('reads an ordinary pyproject.toml', () => {
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), '[tool.setuptools]\npackage-dir = {"" = "lib"}\n');
    assert.match(guardedMetaReader(tmp, 1024)('pyproject.toml'), /package-dir/);
    assert.equal(guardedMetaReader(tmp, 1024)('setup.cfg'), null, 'absent → null, not a read');
  });

  it('refuses a setup.cfg symlinked outside the repo and a pyproject.toml symlinked at a secret', (t) => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'py-meta-out-'));
    try {
      fs.writeFileSync(path.join(outside, 'setup.cfg'), '[options]\npackage_dir = =stolen\n');
      if (!trySymlink(t, path.join(outside, 'setup.cfg'), path.join(tmp, 'setup.cfg'))) return;
      fs.mkdirSync(path.join(tmp, 'secrets'));
      fs.writeFileSync(path.join(tmp, 'secrets', 'pyproject.toml'), 'token = "x"\n');
      fs.symlinkSync(path.join(tmp, 'secrets', 'pyproject.toml'), path.join(tmp, 'pyproject.toml'));
      const read = guardedMetaReader(tmp, 1024);
      assert.equal(read('setup.cfg'), null);
      assert.equal(read('pyproject.toml'), null);
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('discoverPythonRoots routes EVERY metadata read — mapped and root probe — through readMeta', async () => {
    const { discoverPythonRoots } = await import('../scripts/lib/arch-intent/adapters/python.mjs');
    fs.writeFileSync(path.join(tmp, 'pyproject.toml'), 'x');
    const seen = [];
    discoverPythonRoots(tmp, new Map([['svc/setup.cfg', 'd'], ['svc/m.py', 'd']]), {
      readMeta: (rel) => { seen.push(rel); return null; },
    });
    assert.deepEqual(seen.sort(), ['pyproject.toml', 'setup.cfg', 'svc/setup.cfg']);
  });
});
