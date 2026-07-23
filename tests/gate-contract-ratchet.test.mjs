/**
 * @fileoverview The Phase-D net-new-skill ratchet (gate-contract-authoring.md
 * §7b). Two layers:
 *   1. PURE unit tests of `computeRatchetDivergences` — every §7b failure mode,
 *      in deterministic order, without touching a repo.
 *   2. `checkRatchet` fs-shell tests — baseline load/validate + symlink
 *      rejection, against temp fixtures.
 *   3. Schema tests for `GateContractBaselineSchema`.
 *   4. ONE worktree INTEGRATION test (R3-M1 non-opt-in, R2-M2 isolation): the
 *      REAL checker binary, run against an otherwise-valid synthetic skill that
 *      declares neither a contract nor a baseline exemption, must FAIL and name
 *      the offending skill — proving the ratchet is wired into the committed
 *      pipeline, not a dead function.
 *   5. A wiring assertion that `npm run check` transitively runs the checker.
 *
 * @module tests/gate-contract-ratchet
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { computeRatchetDivergences } from '../scripts/lib/gate-honesty/ratchet.mjs';
import { checkRatchet, BASELINE_FILENAME } from '../scripts/check-gate-contracts.mjs';
import { GateContractBaselineSchema } from '../scripts/lib/gate-honesty/schema.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';

/** Retry-hardened rm — a concurrent AV/indexer can hold a handle briefly on Windows. */
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/**
 * Find the nearest ancestor (starting at `startDir` itself) that has a
 * node_modules directory — the same directory Node's own module resolver
 * would land on for code running IN that tree. A linked git worktree
 * commonly has no node_modules of its own and relies on exactly this
 * upward walk finding the main checkout's; that walk works for ordinary
 * in-place test runs but NOT for a sandbox relocated under the OS temp
 * directory (an unrelated tree with no such ancestor), which is why the
 * worktree-integration test below can't just junction `repoRoot/node_modules`
 * unconditionally. Returns null if no ancestor has one.
 */
function findNodeModulesUpwards(startDir) {
  let dir = startDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ── 1. Pure set rules ──────────────────────────────────────────────────────
describe('computeRatchetDivergences (§7b set rules)', () => {
  const clean = {
    skillNames: ['alpha', 'beta'],
    uncontractedDirs: [],
    contractSkillByDir: new Map([['alpha', 'alpha'], ['beta', 'beta']]),
    baselineExemptions: [],
  };

  it('is clean when every skill is contracted and the baseline is empty', () => {
    assert.deepEqual(computeRatchetDivergences(clean), []);
  });

  it('rule 1: an uncontracted, unbaselined skill fails', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha', 'beta'],
      uncontractedDirs: ['beta'],
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [],
    });
    assert.equal(out.length, 1);
    assert.match(out[0], /\[ratchet\] skill "beta" has neither a gate-contract\.json nor a baseline exemption/);
  });

  it('rule 1 is satisfied by a baseline exemption (the documented escape hatch)', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha', 'beta'],
      uncontractedDirs: ['beta'],
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [{ skill: 'beta', reason: 'deferred — no CLI yet' }],
    });
    assert.deepEqual(out, []);
  });

  it('rule 2: a contract whose skill field ≠ its directory fails (identity)', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha'],
      uncontractedDirs: [],
      contractSkillByDir: new Map([['alpha', 'not-alpha']]),
      baselineExemptions: [],
    });
    assert.equal(out.length, 1);
    assert.match(out[0], /skills\/alpha\/gate-contract\.json declares skill "not-alpha"/);
  });

  it('rule 3: a stale baseline exemption (root gone) fails', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha'],
      uncontractedDirs: [],
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [{ skill: 'ghost', reason: 'x' }],
    });
    assert.equal(out.length, 1);
    assert.match(out[0], /baseline exempts "ghost", which is no longer a skill root/);
  });

  it('rule 3: a duplicate baseline exemption fails', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha', 'beta'],
      uncontractedDirs: ['beta'],
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [{ skill: 'beta', reason: 'a' }, { skill: 'beta', reason: 'b' }],
    });
    assert.ok(out.some((d) => /duplicate exemption for "beta"/.test(d)), out.join('\n'));
  });

  it('rule 3: a baseline exemption for a NOW-contracted skill fails (Gemini-r2 G1 — redundant exemption)', () => {
    const out = computeRatchetDivergences({
      skillNames: ['alpha'],
      uncontractedDirs: [],
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [{ skill: 'alpha', reason: 'stale — it has a contract now' }],
    });
    assert.equal(out.length, 1);
    assert.match(out[0], /baseline exempts "alpha", which now HAS a gate-contract\.json/);
  });

  it('a present-but-broken contract is NOT double-reported by rule 1 (keyed on file absence)', () => {
    // A dir with a contract FILE present but invalid is absent from both
    // uncontractedDirs and contractSkillByDir — the loader already flags it, so
    // the ratchet must stay silent to avoid a duplicate divergence.
    const out = computeRatchetDivergences({
      skillNames: ['alpha', 'broken'],
      uncontractedDirs: [], // 'broken' has a file, just an invalid one
      contractSkillByDir: new Map([['alpha', 'alpha']]),
      baselineExemptions: [],
    });
    assert.deepEqual(out, []);
  });

  it('emits divergences in deterministic skill-root order', () => {
    const out = computeRatchetDivergences({
      skillNames: ['zeta', 'alpha', 'mid'],
      uncontractedDirs: ['zeta', 'alpha', 'mid'],
      contractSkillByDir: new Map(),
      baselineExemptions: [],
    });
    const order = out.map((d) => d.match(/skill "([^"]+)"/)[1]);
    assert.deepEqual(order, ['alpha', 'mid', 'zeta']);
  });
});

// ── 2. checkRatchet fs shell (baseline load + symlink rejection) ────────────
describe('checkRatchet (fs shell)', () => {
  /** Build a temp repo-root with a skills/ tree + optional baseline file. */
  function fixture({ skills = {}, baseline } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-fx-'));
    const skillsRoot = path.join(root, 'skills');
    for (const [name, spec] of Object.entries(skills)) {
      const dir = path.join(skillsRoot, name);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
      if (spec.contract !== undefined) {
        fs.writeFileSync(path.join(dir, 'gate-contract.json'), spec.contract);
      }
    }
    if (baseline !== undefined) fs.writeFileSync(path.join(root, BASELINE_FILENAME), baseline);
    return { root, skillsRoot };
  }

  it('an ABSENT baseline is treated as empty exemptions (still strict, no error)', () => {
    const { root, skillsRoot } = fixture({ skills: { alpha: { contract: '{}' } } });
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.deepEqual(out, []);
    } finally { rmrf(root); }
  });

  it('a MALFORMED-JSON baseline fails (does not run set rules on garbage)', () => {
    const { root, skillsRoot } = fixture({ skills: { alpha: {} }, baseline: '{ not json' });
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.ok(out.some((d) => /not valid JSON/.test(d)), out.join('\n'));
    } finally { rmrf(root); }
  });

  it('a SCHEMA-INVALID baseline fails (missing reason)', () => {
    const { root, skillsRoot } = fixture({
      skills: { alpha: {} },
      baseline: JSON.stringify({ version: 1, exemptions: [{ skill: 'alpha' }] }),
    });
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.ok(out.some((d) => /invalid/.test(d)), out.join('\n'));
    } finally { rmrf(root); }
  });

  it('a valid baseline exemption clears an uncontracted skill', () => {
    const { root, skillsRoot } = fixture({
      skills: { alpha: {} }, // no contract file
      baseline: JSON.stringify({ version: 1, exemptions: [{ skill: 'alpha', reason: 'no CLI yet' }] }),
    });
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: ['alpha'],
        contractedByDir: new Map(),
      });
      assert.deepEqual(out, []);
    } finally { rmrf(root); }
  });

  it('a NON-REGULAR baseline (a directory) is rejected fail-closed (audit M1)', () => {
    const { root, skillsRoot } = fixture({ skills: { alpha: { contract: '{}' } } });
    fs.mkdirSync(path.join(root, BASELINE_FILENAME)); // baseline path is a DIR, not a file
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.ok(out.some((d) => /baseline.*not a regular file/.test(d)), out.join('\n'));
    } finally { rmrf(root); }
  });

  it('a SYMLINKED baseline is rejected fail-closed', function () {
    const { root, skillsRoot } = fixture({ skills: { alpha: { contract: '{}' } } });
    const realTarget = path.join(root, 'real-baseline.json');
    fs.writeFileSync(realTarget, JSON.stringify({ version: 1, exemptions: [] }));
    try {
      fs.symlinkSync(realTarget, path.join(root, BASELINE_FILENAME), 'file');
    } catch {
      // Windows without symlink privilege — skip rather than false-fail.
      rmrf(root);
      return this.skip?.();
    }
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.ok(out.some((d) => /baseline.*is a symlink/.test(d)), out.join('\n'));
    } finally { rmrf(root); }
  });

  it('a SYMLINKED gate-contract.json is rejected fail-closed', function () {
    const { root, skillsRoot } = fixture({ skills: { alpha: {} } });
    const realTarget = path.join(root, 'real-contract.json');
    fs.writeFileSync(realTarget, '{}');
    try {
      fs.symlinkSync(realTarget, path.join(skillsRoot, 'alpha', 'gate-contract.json'), 'file');
    } catch {
      rmrf(root);
      return this.skip?.();
    }
    try {
      const out = checkRatchet({
        repoRoot: root, skillsRoot, skillNames: ['alpha'], uncontracted: [],
        contractedByDir: new Map([['alpha', 'alpha']]),
      });
      assert.ok(out.some((d) => /gate-contract\.json.*is a symlink/.test(d)), out.join('\n'));
    } finally { rmrf(root); }
  });
});

// ── 3. Baseline schema ─────────────────────────────────────────────────────
describe('GateContractBaselineSchema', () => {
  it('accepts the empty release state', () => {
    assert.ok(GateContractBaselineSchema.safeParse({ version: 1, exemptions: [] }).success);
  });
  it('accepts an exemption with a reason', () => {
    assert.ok(GateContractBaselineSchema.safeParse({
      version: 1, exemptions: [{ skill: 'foo-bar', reason: 'deferred' }],
    }).success);
  });
  it('rejects version ≠ 1', () => {
    assert.equal(GateContractBaselineSchema.safeParse({ version: 2, exemptions: [] }).success, false);
  });
  it('rejects an exemption missing a reason', () => {
    assert.equal(GateContractBaselineSchema.safeParse({
      version: 1, exemptions: [{ skill: 'foo' }],
    }).success, false);
  });
  it('rejects an empty reason', () => {
    assert.equal(GateContractBaselineSchema.safeParse({
      version: 1, exemptions: [{ skill: 'foo', reason: '' }],
    }).success, false);
  });
  it('rejects a non-kebab-case skill id', () => {
    assert.equal(GateContractBaselineSchema.safeParse({
      version: 1, exemptions: [{ skill: 'Foo_Bar', reason: 'x' }],
    }).success, false);
  });
  it('rejects unknown keys (strict)', () => {
    assert.equal(GateContractBaselineSchema.safeParse({
      version: 1, exemptions: [], extra: true,
    }).success, false);
  });
});

// ── 4. Non-opt-in wiring: `npm run check` transitively runs the checker ─────
describe('ratchet wiring (non-opt-in)', () => {
  it('the committed `check` script transitively invokes check-gate-contracts.mjs', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf-8'));
    // Resolve `npm run check` one level: it chains member scripts by name.
    const memberNames = pkg.scripts.check.split('&&').map((s) => s.trim().replace(/^npm run /, ''));
    assert.ok(memberNames.includes('skills:check'), 'check must run skills:check');
    assert.match(pkg.scripts['skills:check'], /check-gate-contracts\.mjs/,
      'skills:check must run check-gate-contracts.mjs — the ratchet cannot be opt-in');
  });

  it('the committed baseline is schema-valid and empty (release state)', () => {
    const baseline = JSON.parse(fs.readFileSync(path.join(repoRoot, BASELINE_FILENAME), 'utf-8'));
    const res = GateContractBaselineSchema.safeParse(baseline);
    assert.ok(res.success, JSON.stringify(res.error?.issues));
    assert.deepEqual(baseline.exemptions, [], 'all 15 skills are contracted — baseline is empty');
  });
});

// ── 5. Worktree INTEGRATION: the real binary fails on an uncontracted skill ─
describe('ratchet integration (real checker binary, isolated worktree)', () => {
  it('an otherwise-valid synthetic skill with no contract and no exemption FAILS the checker', () => {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf-8' }).trim();
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'ratchet-wt-'));
    // git worktree add needs an empty/nonexistent path; remove the mkdtemp dir first.
    rmrf(sandbox);
    let added = false;
    try {
      execFileSync('git', ['worktree', 'add', '--detach', '--quiet', sandbox, headSha],
        { cwd: repoRoot, stdio: 'ignore' });
      added = true;

      // Overlay the LIVE (possibly-uncommitted) SUT files so the test exercises
      // the current working-tree ratchet, not whatever HEAD happens to carry.
      for (const rel of [
        'scripts/check-gate-contracts.mjs',
        'scripts/lib/gate-honesty/ratchet.mjs',
        'scripts/lib/gate-honesty/schema.mjs',
        'scripts/lib/gate-honesty/loader.mjs',
        BASELINE_FILENAME,
      ]) {
        const src = path.join(repoRoot, rel);
        if (fs.existsSync(src)) {
          fs.mkdirSync(path.dirname(path.join(sandbox, rel)), { recursive: true });
          fs.copyFileSync(src, path.join(sandbox, rel));
        }
      }

      // node_modules junction (mirrors prepush-check.mjs's provisionNodeModules)
      // so `zod` resolves. repoRoot itself may have no node_modules of its own
      // (a linked worktree that was never `npm install`'d directly) — walk up
      // for a real ancestor first, same as Node's own resolver would; if none
      // exists anywhere, fall back to a real install rather than silently
      // junctioning to a nonexistent target (confirmed 2026-07-23: that
      // silent-fallthrough is exactly how this failed — junction creation to a
      // missing target doesn't throw on Windows, so the catch never fired, and
      // module resolution failed later with an unhelpful ERR_MODULE_NOT_FOUND).
      const sourceModules = findNodeModulesUpwards(repoRoot);
      if (sourceModules) {
        try {
          fs.symlinkSync(sourceModules, path.join(sandbox, 'node_modules'), 'junction');
        } catch { /* fall through to the real-install fallback below */ }
      }
      if (!fs.existsSync(path.join(sandbox, 'node_modules'))) {
        const install = spawnSync(NPM, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'],
          { cwd: sandbox, stdio: 'ignore', shell: IS_WIN });
        assert.equal(install.status, 0,
          'sandbox node_modules provisioning failed: no ancestor node_modules found and npm ci failed');
      }

      // Otherwise-valid synthetic skill: has a SKILL.md, but no gate-contract.json
      // and no baseline exemption. The ONLY reason the checker should fail.
      const synthName = 'zzz-synthetic-ratchet-fixture';
      const synthDir = path.join(sandbox, 'skills', synthName);
      fs.mkdirSync(synthDir, { recursive: true });
      fs.writeFileSync(path.join(synthDir, 'SKILL.md'), `# ${synthName}\n\nA valid skill body.\n`);

      const run = spawnSync('node', [path.join(sandbox, 'scripts', 'check-gate-contracts.mjs')],
        { cwd: sandbox, encoding: 'utf-8', shell: false });
      const combined = `${run.stdout || ''}${run.stderr || ''}`;

      assert.notEqual(run.status, 0, `checker must FAIL on an uncontracted skill.\n${combined}`);
      assert.match(combined, /check-gate-contracts: FAILED/, combined);
      assert.match(combined, new RegExp(`skill "${synthName}" has neither`), combined);

      // And the escape hatch works: baselining the synthetic skill clears it.
      fs.writeFileSync(path.join(sandbox, BASELINE_FILENAME), JSON.stringify({
        version: 1, exemptions: [{ skill: synthName, reason: 'integration-test fixture' }],
      }));
      const run2 = spawnSync('node', [path.join(sandbox, 'scripts', 'check-gate-contracts.mjs')],
        { cwd: sandbox, encoding: 'utf-8', shell: false });
      assert.equal(run2.status, 0, `baseline exemption must clear it.\n${run2.stdout || ''}${run2.stderr || ''}`);
    } finally {
      if (added) {
        try { execFileSync('git', ['worktree', 'remove', '--force', sandbox], { cwd: repoRoot, stdio: 'ignore' }); }
        catch { /* fall through to manual rm + prune */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: repoRoot, stdio: 'ignore' }); } catch { /* noop */ }
      }
      if (fs.existsSync(sandbox)) { try { rmrf(sandbox); } catch { /* locked on win — prune handled it */ } }
    }
  });
});
