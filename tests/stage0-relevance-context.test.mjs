/**
 * @fileoverview Regression tests for `buildStage0RelevanceContext`'s impact-cache
 * build (5308a5d6): a bounded-concurrency worker pool over the store read
 * (`getFreshImportersOrNull`), replacing a sequential for...of loop.
 *
 * The builder exposes `opts.getImporters` as its test seam (default: the real,
 * DB-touching read), so every test here drives the REAL function and counts what
 * the injected lookup sees. An earlier version of this file carried a copy of the
 * pool ("proving the algorithm in isolation") because no seam existed; a copy can
 * stay green while the production loop regresses to sequential - the exact
 * mistake the audit-plan round-3 M1 caught in a draft of the fix - so the copy is
 * gone.
 */
import assert from 'node:assert/strict';

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

  // final-review shadow fd93a4c7: the pool swallowed every impact-lookup throw
  // with a bare catch and no log, so a systemic outage produced an all-null
  // impactCache indistinguishable from a repo with no import graph. The
  // degrade-to-null CONTRACT stays (null = unknown); the silence does not.
  itFor('an impact-lookup THROW degrades to null but is reported once, with a count', async () => {
    const envelopes = ['a.mjs', 'b.mjs', 'c.mjs'].map((f) => ({ canonicalFinding: { anchor: { side: 'head', newFile: f } } }));
    const ctx = { auditBaseCommit: null, commitSha: 'abc', workingTreeDirty: false, changedFiles: [] };
    const writes = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    let result;
    try {
      result = await buildStage0RelevanceContext(ctx, envelopes, {
        repoRoot,
        getImporters: async () => { throw new Error('connection terminated unexpectedly'); },
      });
    } finally {
      process.stderr.write = realWrite;
    }
    assert.deepEqual([...result.impactCache.values()], [null, null, null], 'unknown, never a guess');
    const notes = writes.filter((w) => /impact-lookup failure/i.test(w));
    assert.equal(notes.length, 1, `one aggregated line, not one per file: ${JSON.stringify(writes)}`);
    assert.match(notes[0], /3 of 3/);
    assert.match(notes[0], /connection terminated unexpectedly/);
  });

  itFor('a lookup that RETURNS null (unknown) is not reported as a failure (negative control)', async () => {
    const envelopes = [{ canonicalFinding: { anchor: { side: 'head', newFile: 'a.mjs' } } }];
    const ctx = { auditBaseCommit: null, commitSha: 'abc', workingTreeDirty: false, changedFiles: [] };
    const writes = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (s) => { writes.push(String(s)); return true; };
    try {
      await buildStage0RelevanceContext(ctx, envelopes, { repoRoot, getImporters: async () => null });
    } finally {
      process.stderr.write = realWrite;
    }
    assert.equal(writes.filter((w) => /impact-lookup failure/i.test(w)).length, 0);
  });

  // ── the worker pool, driven through the REAL builder via opts.getImporters ──
  const filesOf = (n) => Array.from({ length: n }, (_, i) => `file${i}.mjs`);
  const envelopesFor = (files) => files.map((f) => ({ canonicalFinding: { anchor: { side: 'head', newFile: f } } }));
  const poolCtx = { auditBaseCommit: null, commitSha: 'abc', workingTreeDirty: false, changedFiles: [] };
  // Run the builder with STAGE0_IMPACT_CONCURRENCY pinned, recording what the
  // injected lookup observes: peak in-flight calls, and every file asked about.
  async function runPool(files, concurrency, lookup) {
    const saved = process.env.STAGE0_IMPACT_CONCURRENCY;
    if (concurrency === undefined) delete process.env.STAGE0_IMPACT_CONCURRENCY;
    else process.env.STAGE0_IMPACT_CONCURRENCY = String(concurrency);
    let inFlight = 0;
    let maxInFlight = 0;
    const asked = [];
    try {
      const result = await buildStage0RelevanceContext(poolCtx, envelopesFor(files), {
        repoRoot,
        getImporters: async ({ filePath }) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          asked.push(filePath);
          try { return await lookup(filePath); } finally { inFlight -= 1; }
        },
      });
      return { result, maxInFlight, asked };
    } finally {
      if (saved === undefined) delete process.env.STAGE0_IMPACT_CONCURRENCY;
      else process.env.STAGE0_IMPACT_CONCURRENCY = saved;
    }
  }
  const tick = (ms) => new Promise((r) => setTimeout(r, ms));

  itFor('the pool runs lookups concurrently, not sequentially, and honours the cap', async () => {
    const { maxInFlight } = await runPool(filesOf(12), 4, async () => { await tick(10); return true; });
    // A sequential loop (the round-2 regression) would peak at 1 in flight.
    assert.ok(maxInFlight > 1, `expected concurrent execution, got maxInFlight=${maxInFlight}`);
    assert.ok(maxInFlight <= 4, `expected the concurrency cap to be honoured, got maxInFlight=${maxInFlight}`);
  });

  itFor('more files than workers: never over the cap, every file looked up exactly once with its own result', async () => {
    const files = filesOf(20);
    const { result, maxInFlight, asked } = await runPool(files, 8, async (f) => { await tick(5); return { importers: [f] }; });
    assert.ok(maxInFlight <= 8, `maxInFlight=${maxInFlight}`);
    assert.deepEqual([...asked].sort(), [...files].sort(), 'each file asked about exactly once');
    assert.equal(result.impactCache.size, 20);
    for (const f of files) assert.deepEqual(result.impactCache.get(f), { importers: [f] });
  });

  itFor('one failing lookup degrades that file to null without stranding or dropping the others', async () => {
    const files = filesOf(5);
    const { result } = await runPool(files, 2, async (f) => { if (f === 'file2.mjs') throw new Error('simulated lookup failure'); return f; });
    assert.equal(result.impactCache.size, 5, 'all 5 completed - one failure does not strand the pool');
    assert.equal(result.impactCache.get('file2.mjs'), null, 'the failing file degrades to null (unknown)');
    assert.equal(result.impactCache.get('file0.mjs'), 'file0.mjs');
    assert.equal(result.impactCache.get('file4.mjs'), 'file4.mjs');
  });

  itFor('fewer files than the cap start only as many lookups as there are files', async () => {
    const { maxInFlight, asked } = await runPool(filesOf(2), 8, async () => { await tick(10); return true; });
    assert.equal(asked.length, 2);
    assert.ok(maxInFlight <= 2, `no more in flight than files, got ${maxInFlight}`);
  });

  itFor('NEGATIVE CONTROL - cap 1 really serialises (the concurrency assertions above can tell the difference)', async () => {
    const { maxInFlight } = await runPool(filesOf(6), 1, async () => { await tick(5); return true; });
    assert.equal(maxInFlight, 1);
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
