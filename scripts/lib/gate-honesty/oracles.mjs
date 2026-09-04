/**
 * @fileoverview The oracle registry (plan §F2.3 — the H5 design). A plain
 * `Map` + four adapter functions, deliberately bounded (Gemini's
 * over-engineering flag, recorded in the plan): no plugin loading, no
 * config indirection. Each adapter imports or spawns the REAL production
 * seam named by the contract's `implementation` field — same-module
 * identity, not a lookalike — and returns a normalized tri-state result.
 *
 * @module scripts/lib/gate-honesty/oracles
 */

import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { atomicWriteFileSync } from '../file-io.mjs';

/**
 * @typedef {{state: 'ok'} | {state: 'divergent', stated: string, found: string} | {state: 'env-skipped', skipReason: string}} OracleResult
 */

// ── Hermetic execution boundary (docs/plans/gate-contract-expansion.md D1a) ──
//
// The v1 recipe targeted `visual-audit --gate`, which is deterministic and
// touches nothing outside its cwd. Recipes for `ship` / `cycle` / `nav-audit`
// resolve git state, `~/.audit-loop.env`, the cloud store and providers — so a
// tmpdir `cwd` plus a filtered env is NOT isolation: the child still reaches the
// real HOME, the real global git config, and real credentials.
//
// Two properties are load-bearing, and both were audit findings:
//   1. ALLOWLIST, never filter (fail-closed). A filter is fail-open — a
//      credential variable added to the repo later leaks in silently. An
//      allowlist cannot leak a variable nobody listed.
//   2. Redirect the state ROOTS, not just cwd (Gemini G1/G3): HOME, XDG_*,
//      TMPDIR and the git config paths all point into the fixture, and PATH
//      MUST be carried or the child cannot resolve `node`/`git` at all and
//      every recipe dies for a reason unrelated to the gate under test.

/** Variables carried through verbatim. Everything else is absent by construction. */
const ENV_ALLOWLIST = Object.freeze([
  'PATH', 'Path',                      // Gemini G3 — without these nothing resolves
  'SystemRoot', 'COMSPEC', 'windir',   // Windows needs these for process creation
  'LANG', 'LC_ALL', 'TZ',
  // NODE_OPTIONS is deliberately ABSENT (audit H1/H2 — found by two independent
  // passes). It is interpreted by Node BEFORE the CLI's first line runs, and
  // `--require`/`--import` in it preload arbitrary modules that execute outside
  // the fixture contract: they can read real filesystem state, use parent
  // config, or make network calls. Inheriting it would have made the boundary
  // decorative — a hermetic harness that isn't, which is precisely the
  // unverified-claim defect this suite exists to catch. The child is spawned
  // with `process.execPath` directly, so no Node flags are needed; a recipe
  // genuinely requiring one must pass it as an explicit argv flag, where it is
  // visible in the recipe rather than ambient.
]);

/**
 * Build a hermetic child environment rooted at `fixtureDir`.
 *
 * Exported for its own test: the whole point is that a credential CANNOT reach
 * the child, and an isolation guarantee asserted only in prose is exactly the
 * unverified claim this suite exists to remove.
 *
 * @param {string} fixtureDir  the run's tmpdir — becomes HOME/XDG/TMPDIR
 * @param {NodeJS.ProcessEnv} [source]  defaults to the real environment
 */
export function buildHermeticEnv(fixtureDir, source = process.env) {
  const env = Object.create(null);
  for (const k of ENV_ALLOWLIST) {
    if (source[k] !== undefined) env[k] = source[k];
  }
  const home = path.join(fixtureDir, 'home');
  // HOME/USERPROFILE relocate `~/.audit-loop.env` and any provider config;
  // GIT_CONFIG_* neutralise global/system git config and credential helpers.
  env.HOME = home;
  env.USERPROFILE = home;
  env.XDG_CONFIG_HOME = path.join(home, '.config');
  env.XDG_CACHE_HOME = path.join(home, '.cache');
  // TMPDIR alone is a POSIX-only redirect. On Windows `os.tmpdir()` and native
  // child processes read TEMP/TMP FIRST, so setting only TMPDIR leaves the
  // child writing to the real temp dir — the isolation reads correct on Linux
  // and silently does nothing on the platform this repo is developed on
  // (Gemini, re-raising audit M4 as wrongly dismissed).
  const tmp = path.join(fixtureDir, 'tmp');
  env.TMPDIR = tmp;
  env.TEMP = tmp;
  env.TMP = tmp;
  env.GIT_CONFIG_GLOBAL = path.join(home, '.gitconfig-absent');
  env.GIT_CONFIG_SYSTEM = path.join(home, '.gitconfig-absent');
  env.GIT_TERMINAL_PROMPT = '0';
  // Belt and braces: a recipe must never reach a real store even if a future
  // edit widens the allowlist. Empty-string is distinguishable from unset for
  // code that checks presence, so delete instead.
  for (const k of Object.keys(env)) {
    if (/_API_KEY$|^AUDIT_DB_/.test(k)) delete env[k];
  }
  return env;
}

async function importImplementation(gate, repoRoot) {
  const abs = path.resolve(repoRoot, gate.implementation);
  return import(pathToFileURL(abs).href);
}

/** @returns {Promise<OracleResult>} */
async function convergenceThreshold(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const { high, medium, quickFix } = gate.params;
  const constants = mod.CONVERGENCE_THRESHOLDS;
  if (!constants || constants.high !== high || constants.medium !== medium || constants.quickFix !== quickFix) {
    return {
      state: 'divergent',
      stated: `params ${JSON.stringify(gate.params)}`,
      found: `CONVERGENCE_THRESHOLDS ${JSON.stringify(constants ?? null)} (${gate.implementation})`,
    };
  }
  const cases = [
    [{ high, medium, quickFix }, true],
    [{ high: high + 1, medium, quickFix }, false],
    [{ high, medium: medium + 1, quickFix }, false],
    [{ high, medium, quickFix: quickFix + 1 }, false],
  ];
  for (const [counts, expected] of cases) {
    const actual = mod.evaluateConvergence(counts);
    if (actual !== expected) {
      return {
        state: 'divergent',
        stated: `evaluateConvergence(${JSON.stringify(counts)}) === ${expected}`,
        found: `evaluateConvergence returned ${actual}`,
      };
    }
  }
  return { state: 'ok' };
}

/** @returns {Promise<OracleResult>} */
async function tieredShadowWindow(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const rows = gate.fixture.rows;
  // Mirrors `summarize()`'s CURRENT decision-grade predicate exactly
  // (docs/plans/stage0-evidence-relevance-split.md round-3 M1, with the
  // 2026-07-16 one-sided correction): `complete` is necessary but no longer
  // sufficient — a decision-grade comparison additionally requires both
  // eligible-count fields to be confirmed numbers AND at least ONE side's
  // population non-empty (`||`, not `&&` — the symmetric form silently
  // dropped one-sided recall-failure/value-add runs, biasing the overlap
  // rate upward). Deriving `expectedCompared` from `complete` alone would
  // encode the SUPERSEDED contract here and read as divergent for any
  // fixture with a complete-but-degenerate row.
  const expectedCompared = rows.filter((r) => {
    const c = r.comparison;
    return c?.tieredRunStatus === 'complete'
      && typeof c.tieredEligibleCount === 'number'
      && typeof c.legacyEligibleCount === 'number'
      && (c.tieredEligibleCount > 0 || c.legacyEligibleCount > 0);
  }).length;
  const summary = mod.summarize(rows);
  if (summary.comparedRuns !== expectedCompared) {
    return {
      state: 'divergent',
      stated: `comparedRuns requires 'complete' AND a non-empty eligible population on at least one side (expected ${expectedCompared})`,
      found: `comparedRuns === ${summary.comparedRuns}`,
    };
  }
  const progress = mod.windowProgress(summary.comparedRuns);
  const allFallback = rows.every((r) => r.comparison?.tieredRunStatus === 'fallback_legacy');
  if (allFallback && progress.met) {
    return {
      state: 'divergent',
      stated: 'an all-fallback_legacy window never reads "met"',
      found: `windowProgress(${summary.comparedRuns}).met === true`,
    };
  }
  return { state: 'ok' };
}

/** @returns {Promise<OracleResult>} */
async function visualGateUnverified(gate, { repoRoot }) {
  const mod = await importImplementation(gate, repoRoot);
  const fn = mod.gateUnverifiedReason;
  const cases = [
    { input: { integrity: { noSurfaces: true }, isFull: true, changedPathsResolved: true }, mustBeNonNull: true, contains: 'no surfaces' },
    { input: { integrity: { degraded: true, total: 3 }, isFull: true, changedPathsResolved: true }, mustBeNonNull: true, contains: 'unverifiable' },
    { input: { integrity: { noSurfaces: false, degraded: false }, isFull: false, changedPathsResolved: false }, mustBeNonNull: true, contains: 'merge-base' },
    { input: { integrity: { noSurfaces: false, degraded: false, total: 3 }, isFull: true, changedPathsResolved: true }, mustBeNonNull: false },
  ];
  for (const c of cases) {
    const result = fn(c.input);
    if (c.mustBeNonNull && (typeof result !== 'string' || (c.contains && !result.includes(c.contains)))) {
      return {
        state: 'divergent',
        stated: `gateUnverifiedReason(${JSON.stringify(c.input)}) is non-null and mentions "${c.contains}"`,
        found: `returned ${JSON.stringify(result)}`,
      };
    }
    if (!c.mustBeNonNull && result !== null) {
      return {
        state: 'divergent',
        stated: `gateUnverifiedReason(${JSON.stringify(c.input)}) === null (nothing wrong)`,
        found: `returned ${JSON.stringify(result)}`,
      };
    }
  }
  return { state: 'ok' };
}

/** Registry-owned cli-exit scenario recipes (§F2.3 — closed set, right-sized to v1 usage). */
const CLI_EXIT_RECIPES = {
  'visual-static-gate-refusal': {
    args: ['--gate'],
    fixture(dir) {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      atomicWriteFileSync(path.join(dir, 'visual-contract.json'), JSON.stringify({
        version: 1, surfaces: [{ id: 'app', selector: 'body', sourceGlobs: ['src/**'] }],
        tokenSources: [], globalStyleGlobs: [], themes: [],
      }));
    },
    expectExit: 2,
    expectStderrContains: '--gate requires --verify',
    envPrereq: null, // deterministic everywhere — no browser involved
  },
  // ai-context-management exit-map gate (gate-contract-authoring.md, exemplar).
  // ONE scenario per exit outcome (plan R3-H1) so each gate's `stated` quotes
  // exactly the outcome it exercises, never the whole 0/1/2 table. Both run the
  // REAL check-context-drift.mjs against a fixture repo written into the tmpdir;
  // it resolves the repo from cwd (`args.repo || '.'`), so cwd=tmpDir isolates
  // it from the real repo. Deterministic, no network/browser — feasibility
  // proven 2026-07-20 before this was authored.
  'ctx-drift-clean': {
    args: [],
    fixture(dir) {
      atomicWriteFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE\n\n@./AGENTS.md\n');
      atomicWriteFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS\n');
    },
    expectExit: 0, // "0 = no findings" — an aligned CLAUDE.md imports AGENTS.md
    expectStderrContains: null,
    envPrereq: null,
  },
  'ctx-drift-high': {
    args: [],
    fixture(dir) {
      // No @import → ctx/missing-import, a HIGH finding.
      atomicWriteFileSync(path.join(dir, 'CLAUDE.md'), '# CLAUDE\n\nno import here\n');
      atomicWriteFileSync(path.join(dir, 'AGENTS.md'), '# AGENTS\n');
    },
    expectExit: 1, // "1 = HIGH (blocking)"
    expectStderrContains: null,
    envPrereq: null,
  },
  // brainstorm exit contract (Phase C). The stderr match on "Unknown flag" is
  // load-bearing: it proves the exit 1 came from the ARGV validator, not a
  // wrong-reason failure (e.g. a missing key), so the gate asserts exactly the
  // "exit 1 means an argv error" claim. Needs no providers — argv is validated
  // before any provider is touched — and buildHermeticEnv strips the keys, so
  // it is deterministic anywhere.
  'brainstorm-argv-error': {
    args: ['--bogus-flag-xyz'],
    fixture() { /* no fixture files needed — argv is rejected before anything else */ },
    expectExit: 1,
    expectStderrContains: 'Unknown flag',
    envPrereq: null,
  },
  // nav-audit tool-error: an invalid nav-contract.json → exit 2. A bare `git
  // init` (no commit needed) makes `git ls-files` succeed trivially, isolating
  // this scenario to the contract check rather than the (also exit-2, but
  // differently worded) discovery-failure gate a bare non-repo dir now trips.
  'nav-invalid-contract': {
    args: [],
    fixture(dir) {
      spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf-8', windowsHide: true });
      atomicWriteFileSync(path.join(dir, 'nav-contract.json'), '{ not valid json');
    },
    expectExit: 2,
    expectStderrContains: 'present but invalid',
    envPrereq: null,
  },
  // nav-audit refuse-to-clobber: --bootstrap over an existing contract without
  // --force → exit 2. A distinct behaviour from the tool-error above (different
  // stated, different stderr) that also exits 2. Same git-init isolation as above.
  'nav-bootstrap-refuse-clobber': {
    args: ['--bootstrap'],
    fixture(dir) {
      spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf-8', windowsHide: true });
      atomicWriteFileSync(path.join(dir, 'nav-contract.json'),
        JSON.stringify({ version: 1, navLayers: {}, personaIntents: [] }));
    },
    expectExit: 2,
    expectStderrContains: 'refusing to overwrite',
    envPrereq: null,
  },
  // persona-consistency fatal-rig: a missing surfaces.json manifest → exit 3.
  // Deterministic and hermetic — no browser is reached; the manifest is
  // resolved (and found absent) first.
  'persona-fatal-rig-no-manifest': {
    args: ['--canary', 'nonexistent', '--url', 'http://127.0.0.1:1'],
    fixture() { /* the ABSENCE of surfaces.json is the fixture */ },
    expectExit: 3,
    expectStderrContains: 'fatal-rig',
    envPrereq: null,
  },
  // ux-lock --strict-selectors fails the run on an unjustified structural
  // selector. The selector-policy lint is a PRE-RUN scan (before Playwright),
  // so no browser is reached — deterministic. The bad spec is scanned as text;
  // its require() never executes. Exit 6 is the strict-mode violation code.
  'uxlock-strict-selector-violation': {
    args: ['spec', '--strict-selectors', '--spec', 'bad.spec.js', '--commit', 'x'],
    fixture(dir) {
      atomicWriteFileSync(path.join(dir, 'bad.spec.js'),
        "const { test } = require('@playwright/test');\n"
        + "test('t', async ({ page }) => { await page.locator('.unmarked-structural-class').click(); });\n");
    },
    expectExit: 6,
    expectStderrContains: null, // the violation is on stdout as JSON; exit 6 is the gate
    envPrereq: null,
  },

  // ── worktree-identity guards (docs/plans/worktree-identity-guards.md) ─────
  //
  // These two are genuinely bindable where the sibling migration-realization
  // gate is not: that gate's trigger is DATABASE state (a ledger missing a
  // bundled filename), which no filesystem recipe can construct, so it stays
  // uncontracted rather than claim an oracle that does not hold. Guard A and
  // guard B trigger on GIT INDEX and HEAD state — both constructible right here
  // in the fixture directory, with no store, no network and no browser.
  'ship-unscoped-index-refusal': {
    args: ['--message-file', 'msg.txt', '--skill', 'ship', '--models', 'claude', '--gate', 'not-run', '--no-run-id'],
    fixture(dir) {
      const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
      g(['init', '-q', '-b', 'main']);
      g(['config', 'user.email', 'gate@example.com']);
      g(['config', 'user.name', 'Gate']);
      g(['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(dir, 'skills', 'ship'), { recursive: true });
      atomicWriteFileSync(path.join(dir, 'msg.txt'), 'test: fixture\n');
      // UNBORN HEAD — deliberately no seed commit. Guard B runs BEFORE guard A
      // (identity is a precondition, checked before the index is inspected), so
      // a fixture with a real HEAD would refuse on `no-expectation` and this
      // recipe would go green having proven the OTHER gate fires. An unborn HEAD
      // takes guard B's one documented skip, leaving guard A as the only thing
      // that can refuse — which is what the contract claims.
      atomicWriteFileSync(path.join(dir, 'staged.txt'), 'someone else\n');
      g(['add', 'staged.txt']);
    },
    expectExit: 2,
    expectStderrContains: 'refusing to commit the whole index',
    envPrereq: null, // deterministic: git only, no store/network/browser
  },

  'ship-identity-absent-refusal': {
    // Same fixture shape, but scoped with --path so guard A is satisfied and
    // guard B is the ONLY thing that can refuse. Without that isolation the
    // recipe would pass for the wrong reason — a green test proving the other
    // gate fired.
    args: ['--message-file', 'msg.txt', '--skill', 'ship', '--models', 'claude', '--gate', 'not-run', '--no-run-id', '--path', 'work.txt'],
    fixture(dir) {
      const g = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf-8', windowsHide: true });
      g(['init', '-q', '-b', 'main']);
      g(['config', 'user.email', 'gate@example.com']);
      g(['config', 'user.name', 'Gate']);
      g(['config', 'commit.gpgsign', 'false']);
      fs.mkdirSync(path.join(dir, 'skills', 'ship'), { recursive: true });
      atomicWriteFileSync(path.join(dir, 'msg.txt'), 'test: fixture\n');
      atomicWriteFileSync(path.join(dir, 'seed.txt'), 'seed\n');
      g(['add', 'seed.txt']);
      g(['commit', '-qm', 'seed']);
      atomicWriteFileSync(path.join(dir, 'work.txt'), 'mine\n');
    },
    expectExit: 2,
    expectStderrContains: 'no-expectation',
    envPrereq: null,
  },

  // debt-auto-capture: a PARTIAL capture must not report success. The ledger
  // below holds two `ruling: defer` entries, one of which carries a rationale
  // over PersistedDebtEntrySchema's 4000-char cap. The good entry is written
  // and the over-cap one is rejected, so the run is partial -- the exact shape
  // that exited 0 until 2026-09-04, because the old predicate only fired when
  // EVERY entry was rejected. Isolating on the stderr line rather than the exit
  // code alone is load-bearing here: exit 1 is also this CLI's code for a
  // missing arg or an unreadable ledger, so a bare exit check could go green
  // having proven a completely different refusal.
  'debt-capture-partial-refusal': {
    args: ['--ledger', '.audit/gate-ledger.json', '--run', 'gate-honesty'],
    fixture(dir) {
      fs.mkdirSync(path.join(dir, '.audit'), { recursive: true });
      const rationale = (n) => 'Root cause R. Minimal in-scope fix rejected: F. Residual risk K. '
        .repeat(Math.ceil(n / 62)).slice(0, n);
      const entry = (topicId, chars) => ({
        topicId,
        ruling: 'defer',
        severity: 'HIGH',
        category: 'god-module',
        section: 'src/x.js:1',
        detailSnapshot: 'a sufficiently descriptive detail snapshot',
        rulingRationale: rationale(chars),
        affectedFiles: ['src/x.js'],
      });
      atomicWriteFileSync(path.join(dir, '.audit', 'gate-ledger.json'), JSON.stringify({
        version: 1,
        entries: [entry('lands', 500), entry('over-cap', 4500)],
      }));
    },
    expectExit: 1,
    expectStderrContains: 'PARTIAL CAPTURE',
    envPrereq: null, // deterministic: filesystem only, no store/network/browser
  },
};

/** @returns {Promise<OracleResult>} */
async function cliExit(gate, { repoRoot }) {
  const recipe = CLI_EXIT_RECIPES[gate.scenario];
  const cliAbs = path.resolve(repoRoot, gate.implementation);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-honesty-cli-'));
  try {
    if (recipe.envPrereq && !recipe.envPrereq()) {
      return { state: 'env-skipped', skipReason: `scenario "${gate.scenario}" prerequisite unavailable` };
    }
    // Fixture-owned state roots must exist before the child looks for them —
    // ALL of them, not just home/tmp (audit M3). A CLI that resolves
    // XDG_CONFIG_HOME/XDG_CACHE_HOME and finds them absent can error for a
    // reason unrelated to the gate under test. Derive the dirs from the same
    // env buildHermeticEnv produced, so the two can't drift.
    const provisionEnv = buildHermeticEnv(tmpDir);
    for (const key of ['HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
      fs.mkdirSync(provisionEnv[key], { recursive: true });
    }
    recipe.fixture(tmpDir);
    const r = spawnSync(process.execPath, [cliAbs, ...recipe.args], {
      cwd: tmpDir,
      encoding: 'utf-8',
      env: provisionEnv,
      timeout: recipe.timeoutMs ?? 60_000,
    });
    // A killed child has a null status; treating that as "not the expected
    // exit" would report a divergence the gate did not actually have.
    if (r.error || r.signal) {
      return { state: 'divergent', stated: `exit ${recipe.expectExit}`, found: `child did not complete (${r.signal || r.error?.message})` };
    }
    if (r.status !== recipe.expectExit) {
      return { state: 'divergent', stated: `exit ${recipe.expectExit}`, found: `exit ${r.status}` };
    }
    if (recipe.expectStderrContains && !r.stderr.includes(recipe.expectStderrContains)) {
      return { state: 'divergent', stated: `stderr contains "${recipe.expectStderrContains}"`, found: `stderr: ${r.stderr.slice(0, 200)}` };
    }
    return { state: 'ok' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** The registry — oracle id → adapter. Unknown ids are a schema-time divergence (schema.mjs), never reach here. */
export const ORACLES = new Map([
  ['convergence-threshold', convergenceThreshold],
  ['tiered-shadow-window', tieredShadowWindow],
  ['visual-gate-unverified', visualGateUnverified],
  ['cli-exit', cliExit],
]);

/**
 * Run the oracle named by `gate.oracle` against the real implementation.
 * @param {object} gate — a validated executable gate
 * @param {{repoRoot: string}} ctx
 * @returns {Promise<OracleResult>}
 */
export async function runOracle(gate, ctx) {
  const adapter = ORACLES.get(gate.oracle);
  if (!adapter) return { state: 'divergent', stated: `registered oracle "${gate.oracle}"`, found: 'unknown oracle id' };
  try {
    return await adapter(gate, ctx);
  } catch (e) {
    return { state: 'divergent', stated: 'oracle runs without throwing', found: `threw: ${e.message}` };
  }
}
