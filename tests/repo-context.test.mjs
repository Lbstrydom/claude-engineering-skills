/**
 * Tests for scripts/lib/repo-context.mjs — the blast-radius context layer.
 * Plan: docs/plans/adaptive-context-blast-radius.md — Phase 2.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getRepoContext, INTENT_SECTION_MAP, fitSections, renderCoverage, escapeForBlock } from '../scripts/lib/repo-context.mjs';
import { listRepoFiles } from '../scripts/lib/repo-inventory.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'repo-ctx-'));
}

describe('getRepoContext — tiers against the real repo', () => {
  it('T0 returns a commit-stamped inventory block', () => {
    // NO maxTokens override (2026-08-21). This case used to lift the budget to
    // 100_000 because repo-context.mjs sorts late and fell past the cut. That
    // made the test pass while production shipped a 34% list — see the budget
    // honesty block at the bottom of this file.
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, false);
    assert.match(r.block, /<repo_inventory generated-at=[0-9a-f]{7}>/);
    // CONTRACT-DERIVED, not a hardcoded filename (audit M2). Asserting on a
    // late-sorting path asserts the repo's file count (that is why the old case
    // needed maxTokens: 100_000); asserting on an early-sorting one just moves
    // the hardcoding. The contract is "an alphabetical PREFIX of the canonical
    // inventory", so derive the expectation from the inventory itself — true
    // for any repo, at any size, and still fails on a fabricated list.
    const inv = listRepoFiles({ baseDir: process.cwd() });
    const listed = r.block.split('\n').filter((l) => inv.files.includes(l));
    assert.ok(listed.length > 0, 'the block must list real inventory entries');
    assert.deepEqual(listed, inv.files.slice(0, listed.length),
      'listed entries must be the inventory prefix, in inventory order');
    // ...and the block must SAY it is a prefix rather than presenting as whole.
    assert.match(r.block, /showing \d+ of \d+ files/);
    assert.equal(r.truncated, true);
    assert.ok(r.tokensEst > 0);
  });

  it('T1 lists public exports of imported-unchanged modules', () => {
    // repo-context.mjs imports repo-inventory / module-graph / arch-context.
    // NO maxTokens override: adjacency is now fitted BEFORE the inventory, so
    // it survives the production default. Lifting the budget here is exactly
    // how the regression stayed invisible for 1214 commits.
    const r = getRepoContext({
      tier: 'T1', targetPaths: ['scripts/lib/repo-context.mjs'], baseDir: process.cwd(),
    });
    assert.equal(r.resolvedTier, 'T1');
    assert.match(r.block, /<adjacency_context/);
    // STRUCTURAL, not nominal (audit M5, applied to both T1 cases): pinning
    // `repo-inventory.mjs: listRepoFiles` asserts this module's import graph
    // AND another module's export names — implementation details a valid
    // refactor may change while adjacency generation keeps working. Assert the
    // contract instead: at least two resolved `path: exports` rows, which is
    // what T1 promises and still fails on an empty adjacency element.
    const target = 'scripts/lib/repo-context.mjs';
    const body = r.block.slice(r.block.indexOf('<adjacency_context'));
    const rows = body.split('\n').filter((l) => /^[\w./-]+\.mjs: \S/.test(l));
    assert.ok(rows.length > 0, 'adjacency must carry at least one resolved module row');
    // Audit M3: `rows.length >= 2` proved SHAPE, not the contract — an
    // implementation emitting two fixed rows would have passed. Assert the
    // RELATIONSHIP instead: every row must name a module the target actually
    // imports, and never the target itself. The expected set is computed from
    // the target's source here, so a refactor that changes its imports keeps
    // this test honest rather than failing it spuriously (audit M2).
    const src = fs.readFileSync(target, 'utf-8');
    const imported = new Set([...src.matchAll(/from '(\.[^']+)'/g)]
      .map((m) => path.posix.normalize(path.posix.join(path.posix.dirname(target), m[1]))));
    for (const row of rows) {
      const file = row.slice(0, row.indexOf(':'));
      assert.ok(imported.has(file), `adjacency row "${file}" is not imported by ${target}`);
      assert.notEqual(file, target, 'adjacency must exclude the changed file itself');
      assert.ok(row.slice(row.indexOf(':') + 1).trim().length > 0, `row "${file}" lists no exports`);
    }
  });

  it('T1 with no changed files degrades to T0', () => {
    const r = getRepoContext({ tier: 'T1', targetPaths: [], baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, true);
    assert.equal(r.fallbackReason, 't1_no_resolvable_adjacency');
  });

  it('T2 selects the AGENTS.md section by intent', () => {
    const arch = getRepoContext({ tier: 'T2', intent: 'architecture', baseDir: process.cwd() });
    assert.equal(arch.resolvedTier, 'T2');
    assert.match(arch.block, /<repo_doc_section heading="## Architecture"/);

    const audit = getRepoContext({ tier: 'T2', intent: 'audit-subsystem', baseDir: process.cwd() });
    // audit-subsystem maps to a different heading (or degrades if it drifted)
    if (audit.resolvedTier === 'T2') {
      assert.match(audit.block, /R2\+ Audit Mode/);
    } else {
      assert.equal(audit.fallbackReason, 't2_section_unavailable');
    }
  });

  it('T3 returns the symbol map when docs/architecture-map.md exists', () => {
    const r = getRepoContext({ tier: 'T3', baseDir: process.cwd() });
    // The repo generates architecture-map.md; if present → T3, else degrades.
    if (r.resolvedTier === 'T3') {
      assert.match(r.block, /<symbol_map source="docs\/architecture-map\.md"/);
    } else {
      assert.ok(['T1', 'T0'].includes(r.resolvedTier));
      assert.equal(r.fallbackReason, 't3_symbol_map_unavailable');
    }
  });

  it('every block is token-estimated and SHA-stamped', () => {
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.equal(typeof r.commitSha, 'string');
    assert.equal(r.gitAvailable, true);
  });
});

describe('getRepoContext — degradation in a bare directory', () => {
  it('T2 degrades to T0 when there is no AGENTS.md', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    const r = getRepoContext({ tier: 'T2', intent: 'architecture', baseDir: dir });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.fallbackReason, 't2_section_unavailable');
    assert.match(r.block, /<repo_inventory/);
  });

  it('T3 degrades through T1 to T0 with no symbol map and no diff', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    const r = getRepoContext({ tier: 'T3', targetPaths: [], baseDir: dir });
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.degraded, true);
  });

  it('T3 degrades to T0 when the symbol map EXISTS but cannot fit any budget', () => {
    // Real regression (found live 2026-08-21): `docs/architecture-map.md`
    // reached 1.4MB in this repo, and T3's symbol-map section is a
    // whole-or-nothing wholeSection (never truncatable) — so at ANY budget
    // that section alone was unfittable, and the OLD tier-selection loop
    // treated "the artifact exists" as sufficient to lock in T3, never
    // trying T1/T0, both of which fit easily. Result: `resolvedTier:'empty'`,
    // `block:''`, even at maxTokens:100000 — the exact silent-empty failure
    // this whole file exists to eliminate, one level up. This fixture
    // reproduces it deterministically (a synthetic oversized file, not the
    // real repo's ambient size) so the regression can't hide behind an
    // environment where the artifact happens to be small or absent.
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), 'export const a = 1;');
    fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'docs', 'architecture-map.md'),
      '# huge\n'.repeat(2_000_000), // ~16MB — unfittable at any realistic budget
    );
    const r = getRepoContext({ tier: 'T3', targetPaths: [], baseDir: dir });
    assert.notEqual(r.resolvedTier, 'empty', 'must degrade, not go silently empty');
    assert.equal(r.resolvedTier, 'T0');
    assert.equal(r.fallbackReason, 't3_symbol_map_unavailable');
    assert.equal(r.degraded, true);
    assert.match(r.block, /<repo_inventory/, 'T0 inventory must actually be present');
    assert.ok(r.tokensEst > 0, 'a real, non-empty block was produced');
  });

  it('git-unavailable directory still produces a block (SHA is null)', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.mjs'), '1');
    const r = getRepoContext({ tier: 'T0', baseDir: dir });
    assert.equal(r.gitAvailable, false);
    assert.equal(r.commitSha, null);
    assert.ok(r.block.includes('a.mjs'), 'block still valid without git');
  });

  it('an oversized block is truncated within the token budget', () => {
    const dir = mkTmp();
    for (let i = 0; i < 400; i++) {
      fs.writeFileSync(path.join(dir, `file-with-a-fairly-long-name-${i}.mjs`), '1');
    }
    const r = getRepoContext({ tier: 'T0', baseDir: dir, maxTokens: 200 });
    assert.ok(r.tokensEst <= 200, `tokensEst ${r.tokensEst} within budget`);
    // The budgeted path states the shortfall structurally instead of appending
    // a `[truncated]` marker to a sliced string — and unlike that marker, the
    // element it emits is still closed.
    assert.equal(r.truncated, true);
    assert.match(r.block, /showing \d+ of \d+ files/);
    assert.match(r.block, /<\/repo_inventory>/);
    // The `[truncated — exceeded context budget]` marker belonged to the
    // string-slicing composition, retired 2026-08-21 along with its pin. There
    // is no path that emits it any more, so asserting its absence pins the
    // replacement rather than leaving a dead expectation behind.
    assert.ok(!r.block.includes('[truncated'), 'the slice marker must not come back');
  });
});

describe('INTENT_SECTION_MAP', () => {
  it('maps known intents to H2 headings', () => {
    assert.equal(INTENT_SECTION_MAP.architecture, '## Architecture');
    assert.ok(INTENT_SECTION_MAP['audit-subsystem'].startsWith('## '));
  });
});

/**
 * Regression: `fallbackReason` must name why the REQUESTED tier failed, not the
 * last rung of the degrade chain. Requesting T3 in a tree with no symbol map
 * used to report `t1_no_resolvable_adjacency` — the chain falls T3 → T1 → T0
 * and the T1 failure clobbered the real cause, pointing the reader at adjacency
 * when the fix is `npm run arch:render`. Latent until architecture-map.md
 * became Category A and stopped existing in a fresh clone.
 */
describe('fallbackReason names the requested tier’s failure', () => {
  it('T3 without a symbol map blames the symbol map, not adjacency', async () => {
    const os = await import('node:os');
    const fsp = await import('node:fs/promises');
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'repoctx-'));
    try {
      // An AGENTS.md so the tree is not so bare that T0 is the only option.
      fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# x\n\n## R2+ Audit Mode\n\nbody\n');
      const r = getRepoContext({ tier: 'T3', baseDir: dir });
      assert.notEqual(r.resolvedTier, 'T3', 'precondition: no map in this tree');
      assert.equal(r.fallbackReason, 't3_symbol_map_unavailable');
    } finally {
      await fsp.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

// ── Budget honesty — sections fitted by priority, coverage reported ─────────
//
// Plan: docs/plans/repo-context-budget-honesty.md §9.
//
// WHY THIS BLOCK EXISTS. The two real-repo cases above used to pass
// `maxTokens: 100_000`, with a comment explaining that the adjacency block
// would otherwise be truncated away. That observation was correct and the
// response was to move the test out of its way — so for 1214 commits
// (2026-05-30 → 2026-08-21) production delivered 749 of 2202 files, no
// adjacency at all, an unterminated element, and `degraded:false`. The suite
// tested content at an unrealistic budget and budget at unrealistic content,
// and never the configuration that actually ships.
//
// So: the selection algebra is pinned on a SYNTHETIC fixture (deterministic,
// constant-size, immune to repo growth), and the real repo is asserted only on
// the property that must hold at the PRODUCTION default.

describe('fitSections — selection algebra (synthetic, deterministic)', () => {
  // A section whose size is exactly `size`, so budgets can be reasoned about.
  const mk = (id, priority, order, size, truncatable = false) => {
    const body = 'x'.repeat(Math.max(0, size - `<${id}>`.length - `</${id}>`.length - 2));
    const full = `<${id}>\n${body}\n</${id}>`;
    return {
      id, priority, order, truncatable,
      measure: () => full.length,
      minSize: () => (truncatable ? `<${id}>\n</${id}>`.length + 1 : full.length),
      counts: () => ({ total: 10 }),
      render: (budget) => {
        if (!truncatable || budget >= full.length) {
          return { text: full, shown: 10, total: 10, partial: false };
        }
        const room = Math.max(0, budget - `<${id}>\n</${id}>`.length);
        return {
          text: `<${id}>\n${'x'.repeat(room)}</${id}>`,
          shown: Math.min(10, room), total: 10, partial: true,
        };
      },
    };
  };

  it('fits everything when the budget allows — and then says NOTHING', () => {
    // The control that stops the coverage line becoming background noise: a
    // complete block must gain zero tokens from this feature.
    const r = fitSections([mk('adjacency', 0, 2, 100), mk('inventory', 2, 1, 200, true)], 100_000);
    assert.deepEqual(r.omitted, []);
    assert.deepEqual(r.partial, []);
    assert.equal(r.coverage.complete, true);
    assert.ok(!r.text.includes('<context_coverage>'), 'a complete block carries no coverage line');
  });

  it('spends the budget on PRIORITY, not on emission order — the whole fix', () => {
    // Budget fits adjacency plus a slice of inventory. Pre-fix, inventory was
    // concatenated first and consumed everything.
    const r = fitSections([mk('adjacency', 0, 2, 100), mk('inventory', 2, 1, 100_000, true)], 800);
    assert.ok(r.included.includes('adjacency'), 'the small high-priority section survives');
    assert.deepEqual(r.partial, ['inventory']);
    assert.equal(r.coverage.complete, false);
  });

  it('emits in ORDER even though it selected by PRIORITY', () => {
    // Gemini plan gate, MEDIUM: fitting by priority and emitting in that same
    // order would invert the prompt's layout as a side effect of a budget fix.
    const r = fitSections([mk('adjacency', 0, 2, 100), mk('inventory', 2, 1, 100)], 100_000);
    assert.ok(r.text.indexOf('<inventory>') < r.text.indexOf('<adjacency>'),
      'inventory (order 1) must precede adjacency (order 2) despite adjacency being fitted first');
  });

  it('omits a NON-truncatable section whole rather than slicing it', () => {
    const r = fitSections([mk('adjacency', 0, 2, 100_000), mk('inventory', 2, 1, 100, true)], 900);
    assert.deepEqual(r.omitted, ['adjacency']);
    assert.ok(r.text.includes('adjacency: OMITTED'), 'and names it in coverage');
  });

  it('no section fits → empty text, and NEVER a throw', () => {
    // A configurable budget must not turn a normal condition into an exception
    // whose handling differs per call site.
    const r = fitSections([mk('adjacency', 0, 2, 5000), mk('inventory', 2, 1, 5000)], 10);
    assert.equal(r.text, '');
    assert.deepEqual(r.included, []);
    assert.equal(r.coverage.complete, false);
  });

  it('equal priorities resolve by declared order — deterministically', () => {
    const a = fitSections([mk('first', 1, 1, 100), mk('second', 1, 2, 100)], 100_000);
    const b = fitSections([mk('first', 1, 1, 100), mk('second', 1, 2, 100)], 100_000);
    assert.equal(a.text, b.text, 'same input, same bytes');
  });

  it('charges the coverage statement to the budget BEFORE selecting', () => {
    const secs = [mk('inventory', 2, 1, 300, true)];
    const r = fitSections(secs, 320);
    assert.ok(r.text.length <= 320, `emitted ${r.text.length} chars against a 320 budget`);
  });

  it('every emitted block is well-formed at every budget on the ladder', () => {
    // Bounded on purpose: a constant-size synthetic fixture over a fixed
    // ladder. "Every budget against the real repo" would be O(n^2) in repo
    // size and grow every month.
    for (const budget of [0, 1, 10, 50, 100, 200, 400, 800, 1600, 3200, 6400, 100_000]) {
      const r = fitSections([mk('adjacency', 0, 2, 300), mk('inventory', 2, 1, 4000, true)], budget);
      for (const id of ['adjacency', 'inventory']) {
        const opens = (r.text.match(new RegExp(`<${id}>`, 'g')) || []).length;
        const closes = (r.text.match(new RegExp(`</${id}>`, 'g')) || []).length;
        assert.equal(opens, closes, `budget ${budget}: <${id}> unbalanced`);
      }
      assert.ok(r.text.length <= Math.max(budget, 0), `budget ${budget}: emitted ${r.text.length}`);
    }
  });
});

describe('getRepoContext — the PRODUCTION configuration, real repo', () => {
  it('delivers adjacency at the DEFAULT budget — the regression that shipped for 1214 commits', () => {
    // Deliberately NO maxTokens override. This is the assertion the old suite
    // bought its way out of; it fails on every commit from c38f93bd (2026-05-30)
    // to 2d6157f0. Asserts only the size-independent property — the selection
    // algebra is pinned synthetically above, so repo growth cannot weaken it.
    const r = getRepoContext({
      tier: 'T1', targetPaths: ['scripts/lib/repo-context.mjs'], baseDir: process.cwd(),
    });
    assert.equal(r.resolvedTier, 'T1');
    assert.match(r.block, /<adjacency_context/);
    // STRUCTURAL, not nominal (audit M5): asserting on
    // `repo-inventory.mjs: listRepoFiles` pins this module's import graph and
    // another module's export names — implementation details a valid refactor
    // may change while adjacency generation keeps working. Assert instead that
    // the element carries at least one real `path: exports` row, which is the
    // actual T1 contract and still fails on an empty adjacency element.
    const body = r.block.slice(r.block.indexOf('<adjacency_context'));
    assert.match(body, /\n[\w./-]+\.mjs: \S/, 'adjacency must carry at least one resolved module row');
  });

  it('reports truncation instead of reporting health', () => {
    // The old object said degraded:false / fallbackReason:null while carrying
    // 34% of a file list and no closing tag.
    const r = getRepoContext({
      tier: 'T1', targetPaths: ['scripts/lib/repo-context.mjs'], baseDir: process.cwd(),
    });
    assert.equal(r.truncated, true, 'the inventory does not fit — say so');
    assert.equal(r.coverage.complete, false);
    assert.match(r.block, /<context_coverage>/);
    assert.match(r.block, /NOT evidence/);
  });

  it('never emits an unterminated element, and never exceeds its budget', () => {
    const r = getRepoContext({
      tier: 'T1', targetPaths: ['scripts/lib/repo-context.mjs'], baseDir: process.cwd(),
    });
    assert.match(r.block, /<\/repo_inventory>/, 'closing tag survives — a string slice used to drop it');
    assert.ok(r.tokensEst <= 8000, `tokensEst ${r.tokensEst} over the 8000 default`);
  });

  it('a partial inventory SAYS it is partial, inline, not only in coverage', () => {
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.match(r.block, /showing \d+ of \d+ files/);
  });
});

describe('getRepoContext — per-tier acceptance (§2.2 table)', () => {
  it('T0 keeps its value: a bounded, explicitly-partial inventory, not an empty block', () => {
    // The regression the plan audit caught: making the inventory
    // non-truncatable would have left openai-audit.mjs with no structure at all.
    const r = getRepoContext({ tier: 'T0', baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0');
    assert.ok(r.block.length > 0, 'T0 must not degrade to an empty block at the production budget');
    assert.match(r.block, /<\/repo_inventory>/);
  });

  it('T2 doc_section is non-truncatable: omitted whole rather than sliced', () => {
    const r = getRepoContext({ tier: 'T2', intent: 'architecture', baseDir: process.cwd(), maxTokens: 20 });
    assert.equal(r.resolvedTier, 'empty', 'its only section cannot fit, so the tier is empty');
    assert.equal(r.block, '');
    assert.equal(r.truncated, true);
  });

  it('tier fallback still selects on ARTIFACT availability, never on budget', () => {
    // A budget miss must not cascade T1 -> T0: T0's inventory is the largest
    // section there is, so that fallback would be incoherent.
    const r = getRepoContext({ tier: 'T1', targetPaths: [], baseDir: process.cwd() });
    assert.equal(r.resolvedTier, 'T0', 'no resolvable adjacency is an ARTIFACT reason');
    assert.equal(r.fallbackReason, 't1_no_resolvable_adjacency');
  });
});
