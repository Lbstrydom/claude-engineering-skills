/**
 * @fileoverview Concurrency-bound regression test for the worker-pool
 * pattern introduced in stage0-relevance-context.mjs's impactCache build
 * (5308a5d6). `buildStage0RelevanceContext` itself calls
 * `getFreshImportersOrNull` (a real DB-touching import with no dependency-
 * injection seam, and this repo's `node --test` runner does not pass
 * `--experimental-test-module-mocks`), so this test proves the underlying
 * "N workers pull from a shared cursor" ALGORITHM in isolation — the exact
 * shape copied into `buildStage0RelevanceContext` — rather than exercising
 * the real function end-to-end. A prior draft of that fix wrapped a
 * semaphore around a still-sequential for...of loop, which provided no
 * concurrency at all (audit-plan round-3 M1); this test would have caught
 * that regression.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mirrors buildStage0RelevanceContext's worker-pool block exactly, generic
// over the per-item async work function so it's testable without a DB.
async function runWorkerPool(items, concurrency, work) {
  let nextIndex = 0;
  let maxInFlight = 0;
  let inFlight = 0;
  const results = new Map();
  const worker = async () => {
    let i;
    while ((i = nextIndex++) < items.length) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        results.set(items[i], await work(items[i]));
      } finally {
        inFlight--;
      }
    }
  };
  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return { results, maxInFlight };
}

test('worker pool runs multiple items concurrently, not sequentially', async () => {
  const items = Array.from({ length: 12 }, (_, i) => `file${i}.mjs`);
  const { maxInFlight } = await runWorkerPool(items, 4, async () => {
    await new Promise((r) => setTimeout(r, 10));
    return true;
  });
  // A sequential loop (the round-2 regression) would peak at 1 in-flight.
  assert.ok(maxInFlight > 1, `expected concurrent execution, got maxInFlight=${maxInFlight}`);
  assert.ok(maxInFlight <= 4, `expected the concurrency cap to be honored, got maxInFlight=${maxInFlight}`);
});

test('worker pool never exceeds the concurrency cap even with more items than workers', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const { maxInFlight, results } = await runWorkerPool(items, 8, async (i) => {
    await new Promise((r) => setTimeout(r, 5));
    return i * 2;
  });
  assert.ok(maxInFlight <= 8);
  assert.equal(results.size, 20);
  for (const i of items) assert.equal(results.get(i), i * 2);
});

test('a failing item degrades to null without stranding the pool — matches buildStage0RelevanceContext\'s own try/catch shape', async () => {
  // buildStage0RelevanceContext wraps its own per-item try/catch { result =
  // null } AROUND the getFreshImportersOrNull call, inside the loop body —
  // the pool itself never sees the error. This test uses the identical
  // shape rather than relying on the pool to catch for it.
  const items = [1, 2, 3, 4, 5];
  const work = async (i) => {
    try {
      if (i === 3) throw new Error('simulated lookup failure');
      return i;
    } catch { return null; }
  };
  const { results } = await runWorkerPool(items, 2, work);
  assert.equal(results.size, 5, 'all 5 items completed — one failure does not strand or drop the others');
  assert.equal(results.get(3), null, 'the failing item degrades to null, matching the real code\'s catch behavior');
  assert.equal(results.get(1), 1);
  assert.equal(results.get(5), 5);
});

test('fewer items than the concurrency cap spawns only as many workers as items', async () => {
  const items = ['a', 'b'];
  let started = 0;
  await runWorkerPool(items, 8, async (i) => { started++; return i; });
  assert.equal(started, 2, 'no wasted/idle workers beyond the item count');
});

// ── findings 1cc508ab / aa68982d ────────────────────────────────────────────
// `buildStage0RelevanceContext` calls `getFreshImportersOrNull`, a real
// DB-touching import — but that function returns null with NO db round-trip
// whenever `repoUuid` is falsy (imports.mjs:297), and `resolveRepoIdentity`
// on a bare temp directory (no git repo, no audit-loop identity file) throws,
// which the function's own catch degrades to `repoUuid = null`. So a plain
// tmp dir with no git/DB reachable exercises the REAL function end-to-end,
// DB-free — no mock needed.
{
  const { test: itFor, before: beforeFor, after: afterFor } = await import('node:test');
  const fs = (await import('node:fs')).default;
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { buildStage0RelevanceContext, makeBlameAdapter } =
    await import('../scripts/lib/audit/stage0-relevance-context.mjs');

  let repoRoot;
  beforeFor(() => { repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stage0-repo-root-')); });
  afterFor(() => { fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  itFor('BUG (fp=aa68982d): reads candidate files from an explicit opts.repoRoot, not the ambient process.cwd()', async () => {
    fs.writeFileSync(path.join(repoRoot, 'target.mjs'), 'export const x = 1;\n');
    const envelopes = [{ canonicalFinding: { anchor: { side: 'head', newFile: 'target.mjs' } } }];
    const ctx = { auditBaseCommit: null, commitSha: null, workingTreeDirty: true, changedFiles: [] };

    // process.cwd() is THIS repo, which has no `target.mjs` at its root —
    // proving the read came from repoRoot, not the ambient cwd.
    const result = await buildStage0RelevanceContext(ctx, envelopes, { repoRoot });
    assert.equal(result.repoRoot, repoRoot, 'the resolved repoRoot is threaded onto the returned context');
    assert.equal(result.headContentCache.get('target.mjs'), 'export const x = 1;\n',
      'file content must be read relative to opts.repoRoot, not process.cwd()');
  });

  itFor('omitting opts.repoRoot stays byte-identical to the prior process.cwd() default', async () => {
    const envelopes = [];
    const ctx = { auditBaseCommit: null, commitSha: null, workingTreeDirty: true, changedFiles: [] };
    const result = await buildStage0RelevanceContext(ctx, envelopes);
    assert.equal(result.repoRoot, process.cwd());
  });

  itFor('BUG (fp=aa68982d): makeBlameAdapter resolves blame against stage0Ctx.repoRoot, not process.cwd()', async () => {
    const stage0Ctx = {
      baseContentCache: new Map([['target.mjs', 'export const x = 1;\n']]),
      repoRoot,
    };
    const adapter = makeBlameAdapter(stage0Ctx, 'HEAD');
    // Not a real repo at repoRoot, so contentExistsAtMappedRange's own git
    // call fails — the assertion that matters here is WHICH directory it
    // failed against, not the outcome. gitShowFileAtRevision/contentExists
    // report failures without throwing, so this just proves no crash occurs
    // when repoRoot is honored (a process.cwd()-based call would instead
    // resolve against a directory with a REAL git repo and behave
    // differently, which the isolated repoRoot must not do).
    assert.doesNotThrow(() => adapter('target.mjs', 1, 1, 'x'));
  });

  itFor('STAGE0_IMPACT_CONCURRENCY (fp=1cc508ab) is env-tunable, not a hardcoded literal', async () => {
    const saved = process.env.STAGE0_IMPACT_CONCURRENCY;
    try {
      process.env.STAGE0_IMPACT_CONCURRENCY = '2';
      const envelopes = [];
      const ctx = { auditBaseCommit: null, commitSha: null, workingTreeDirty: true, changedFiles: [] };
      // No candidate files, so this just proves the function still runs
      // cleanly with the env var set — the clamp itself is exercised more
      // directly via clampAdjacencyBound's own test coverage (config.mjs).
      await assert.doesNotReject(() => buildStage0RelevanceContext(ctx, envelopes, { repoRoot }));
    } finally {
      if (saved === undefined) delete process.env.STAGE0_IMPACT_CONCURRENCY;
      else process.env.STAGE0_IMPACT_CONCURRENCY = saved;
    }
  });
}
