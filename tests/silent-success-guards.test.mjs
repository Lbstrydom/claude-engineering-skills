/**
 * @fileoverview Guards for the "silent success" cluster — four places that
 * reported success without establishing it.
 *
 * Plan: docs/plans/silent-success-cluster.md.
 *
 * The unifying class is one this repo already gates for elsewhere (the
 * `durableWrite` seam, the capture-honesty rule "can this return green without
 * having checked anything?"). Each assertion below was written against the
 * PRE-fix code and seen to fail first; a guard never observed red is
 * indistinguishable from one asserting the wrong thing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';
import { recordSymbolEmbeddings } from '../scripts/lib/store/arch/symbols.mjs';
import { UPSERT_CHUNK_SIZE } from '../scripts/lib/store/arch/_shared.mjs';
import { buildTimeoutRecovery } from '../scripts/symbol-index/refresh-subprocess.mjs';
import { handleRenderFailure } from '../scripts/symbol-index/render-mermaid.mjs';

const traverse = _traverse.default ?? _traverse;
const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const read = p => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');

const vec = (id, v) => ({
  definitionId: id, embeddingModel: 'm', dimension: 2, vector: v, signatureHash: `h-${id}`,
});

describe('KD-2 — no statement is issued until every vector is validated', () => {
  it('a malformed vector in a LATER CHUNK issues ZERO queries', async () => {
    // The ordering invariant. Pre-fix, vectorLiteral ran inside the chunk loop,
    // so chunk N committed before chunk N+1 threw — leaving the embedding space
    // partially written with nothing recording that it was partial.
    //
    // The batch MUST span more than one chunk (UPSERT_CHUNK_SIZE = 500), or this
    // asserts nothing: with a single chunk the throw happens while building that
    // chunk's placeholders, before its only query, so the assertion passes even
    // against the unfixed code. Caught by red-proofing this guard and watching
    // it stay green — a check not seen failing is not evidence.
    const rows = [];
    for (let i = 0; i < UPSERT_CHUNK_SIZE + 10; i += 1) rows.push(vec(`ok-${i}`, [1, 2]));
    rows.push(vec('bad', [1, 'nope']));           // lands in the SECOND chunk
    assert.ok(rows.length > UPSERT_CHUNK_SIZE, 'fixture must span >1 chunk to exercise the defect');

    let calls = 0;
    const query = async () => { calls += 1; return { rowCount: UPSERT_CHUNK_SIZE }; };
    await assert.rejects(() => recordSymbolEmbeddings(rows, { query }), TypeError);
    assert.equal(calls, 0, 'a chunk was committed before validation finished — partial write with no marker');
  });

  it('the happy path still writes, and reports the DB rowCount', async () => {
    // Negative control: an implementation that threw on every input would pass
    // the assertion above by crashing rather than by ordering.
    let calls = 0;
    const query = async () => { calls += 1; return { rowCount: 1 }; };
    assert.equal(await recordSymbolEmbeddings([vec('a', [1, 2])], { query }), 1);
    assert.equal(calls, 1);
  });

  it('the injected seam is optional — production resolves its own pool', () => {
    // Guards the ReferenceError shape an earlier draft had: the default path
    // must not reference an unbound `pool` in its own initialiser.
    const src = read('scripts/lib/store/arch/symbols.mjs');
    assert.doesNotMatch(src, /query\s*\?\?\s*\(await getPool\(\)\)\?\.query\.bind\(pool\)/);
    assert.match(src, /export async function recordSymbolEmbeddings\(rows, \{ query \} = \{\}\)/);
  });
});

describe('KD-3 — the recovered touched-set is what extraction REACHED', () => {
  const prior = { refreshId: 'r1' };

  it('a file processed to ZERO symbols is still counted as reached', () => {
    // The defect: finalSymbols is the embed stage's output, so an empty file or
    // one of only type declarations never appears — and copy-forward then
    // resurrects its stale prior-refresh rows.
    const r = buildTimeoutRecovery({
      priorForRecovery: prior,
      finalSymbols: [{ filePath: 'a.mjs' }],
      reachedFiles: ['a.mjs', 'zero-symbols.mjs'],
    });
    assert.ok(r.recoveredTouchedSet.has('zero-symbols.mjs'));
  });

  it('a file never reached is NOT counted (negative control)', () => {
    const r = buildTimeoutRecovery({
      priorForRecovery: prior, finalSymbols: [{ filePath: 'a.mjs' }], reachedFiles: ['a.mjs'],
    });
    assert.ok(!r.recoveredTouchedSet.has('never-touched.mjs'));
  });

  it('an older extract child (no `processed` records) degrades to today\'s behaviour', () => {
    // Fail-OPEN direction: an empty reachedFiles must mean "no extra information",
    // never "nothing was reached".
    const r = buildTimeoutRecovery({ priorForRecovery: prior, finalSymbols: [{ filePath: 'a.mjs' }] });
    assert.deepEqual([...r.recoveredTouchedSet], ['a.mjs']);
  });

  it('a malformed record without a string `file` is skipped, not inserted as undefined', () => {
    const r = buildTimeoutRecovery({
      priorForRecovery: prior, finalSymbols: [], reachedFiles: [undefined, '', null, 'ok.mjs'],
    });
    assert.deepEqual([...r.recoveredTouchedSet], ['ok.mjs']);
  });

  it('no prior snapshot still returns null (unchanged)', () => {
    const r = buildTimeoutRecovery({ priorForRecovery: null, finalSymbols: [], reachedFiles: ['x'] });
    assert.equal(r.recoveredTouchedSet, null);
  });

  it('extract.mjs emits `processed` only on the success path, AFTER classification', () => {
    // The producer half. `progress{file}` is the parse-START marker — it fires
    // before loadAndParseFile, and a parse failure `continue`s having emitted
    // it. Deriving "reached" from that marks parse-FAILED files as reached.
    const src = read('scripts/symbol-index/extract.mjs');
    const emitIdx = src.indexOf("emit({ type: 'processed', file: rel })");
    const classifyIdx = src.indexOf('redactAndEmit(candidates');
    assert.ok(emitIdx > 0, 'the processed record is not emitted');
    assert.ok(classifyIdx > 0 && emitIdx > classifyIdx,
      'the processed record must come AFTER classification, not before the parse');
  });
});

describe('KD-1 — a failed render leaves no stale envelope, and still fails', () => {
  // These EXECUTE handleRenderFailure with injected fakes. An earlier version
  // read render-mermaid.mjs as a string and asserted token ORDER — the
  // consolidated gate flagged that as unable to verify runtime behaviour, and
  // it was right: it could neither confirm nor refute the same gate's claim
  // that a throwing writeAbortStub masks the original error. Branch 3 settles
  // it by running the code.
  const orig = () => new Error('ORIGINAL-RENDER-FAILURE');

  it('both succeed → envelope cleared, stub written, ORIGINAL error re-thrown', () => {
    const err = orig(); let cleaned = 0, stubbed = 0;
    assert.throws(
      () => handleRenderFailure(err, {
        repoRoot: '/r', outPath: '/o', identityName: 'n',
        cleanup: () => { cleaned += 1; return true; },
        writeStub: () => { stubbed += 1; }, log: () => {},
      }),
      (e) => e === err,
    );
    assert.equal(cleaned, 1); assert.equal(stubbed, 1);
  });

  it('cleanup FAILS → stub deliberately SKIPPED, ORIGINAL error re-thrown', () => {
    // A stub beside a live stale envelope is worse than the untouched pair: it
    // asserts "no map" while the envelope still claims coverage.
    const err = orig(); let stubbed = 0;
    assert.throws(
      () => handleRenderFailure(err, {
        repoRoot: '/r', outPath: '/o', identityName: 'n',
        cleanup: () => false, writeStub: () => { stubbed += 1; }, log: () => {},
      }),
      (e) => e === err,
    );
    assert.equal(stubbed, 0, 'the stub must not be written when cleanup failed');
  });

  it('stub write THROWS → the original error still wins, not the stub error', () => {
    // The gate raised this as a HIGH. Executing it shows the inner catch holds.
    const err = orig();
    assert.throws(
      () => handleRenderFailure(err, {
        repoRoot: '/r', outPath: '/o', identityName: 'n',
        cleanup: () => true,
        writeStub: () => { throw new Error('DISK FULL'); }, log: () => {},
      }),
      (e) => e === err && e.message === 'ORIGINAL-RENDER-FAILURE',
    );
  });

  it('never returns normally — that would be the silent success it exists to stop', () => {
    let returned = false;
    try {
      handleRenderFailure(orig(), {
        repoRoot: '/r', outPath: '/o', identityName: 'n',
        cleanup: () => true, writeStub: () => {}, log: () => {},
      });
      returned = true;
    } catch { /* expected */ }
    assert.equal(returned, false);
  });

  it('the window opens AFTER the last early-return guard, not at main() entry', () => {
    // Structural by necessity: this is about WHERE the try begins, which no
    // amount of injection can express. A catch placed too early would delete a
    // still-valid envelope on an argv error — data loss from a usage mistake.
    const src = read('scripts/symbol-index/render-mermaid.mjs');
    assert.ok(src.indexOf("'no-active-snapshot'") < src.indexOf('Artifact-consistency window'));
  });
});

describe('KD-4 — every fixture git command goes through the checked runner', () => {
  it('fixtures.mjs has exactly ONE spawnSync call site, inside makeGitRunner', () => {
    // AST, not a text count: `spawnSync (`, an import alias or
    // `child_process.spawnSync` all defeat a literal match, and harmless
    // reformatting breaks it. Follows scripts/lib/find-rmsync-sites.mjs.
    const src = read('tests/helpers/fixtures.mjs');
    const ast = parse(src, { sourceType: 'module', plugins: [] });
    const sites = [];
    traverse(ast, {
      CallExpression(p) {
        const callee = p.node.callee;
        const name = callee.type === 'Identifier' ? callee.name
          : (callee.type === 'MemberExpression' && callee.property?.name) || null;
        if (name !== 'spawnSync') return;
        let fn = p.getFunctionParent();
        let enclosing = null;
        while (fn && !enclosing) {
          const id = fn.node.id?.name
            ?? (fn.parentPath?.node?.type === 'VariableDeclarator' ? fn.parentPath.node.id?.name : null);
          if (id) enclosing = id;
          fn = fn.getFunctionParent();
        }
        sites.push(enclosing);
      },
    });
    assert.equal(sites.length, 1, `expected 1 spawnSync call site, found ${sites.length} — a raw one was reintroduced`);
    assert.equal(sites[0], 'makeGitRunner', 'the only spawnSync must live in the checked runner');
  });

  it('a failing git command makes the fixture fail loudly', async () => {
    // The behaviour the census protects. Pre-fix, `stdio:'ignore'` plus no
    // status read meant a failed `git init` produced a fixture that LOOKED
    // constructed — every suite built on it asserted against a broken repo.
    const { gitInit } = await import('../tests/helpers/fixtures.mjs');
    const missing = path.join(os.tmpdir(), `ssc-not-a-dir-${process.pid}`);
    fs.rmSync(missing, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    assert.throws(() => gitInit(missing), /git init/,
      'gitInit swallowed a failure against a non-existent directory');
  });

  it('gitInit still works on a real directory (negative control)', async () => {
    const { gitInit } = await import('../tests/helpers/fixtures.mjs');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssc-ok-'));
    try {
      gitInit(dir);
      assert.ok(fs.existsSync(path.join(dir, '.git')), 'the repo was not initialised');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
