/**
 * @fileoverview The Actions BUDGET guard (docs/plans/ci-full-suite-actions.md, constraints B1-B3).
 *
 * This repo is public, so GitHub-hosted STANDARD runners are free for it ("public repositories that use standard
 * GitHub-hosted runners", docs.github.com/en/billing/concepts/product-billing/github-actions). A larger runner, a
 * self-hosted label or a runner group is not, and none of those looks any different from a standard one in review: it
 * is one string in a `runs-on`. So this test reads EVERY workflow and fails on any `runs-on` it cannot prove standard,
 * resolving a `${{ matrix.* }}` expression through the job's own matrix and failing CLOSED on anything else.
 *
 * `full-suite.yml` carries three further obligations: no uploaded artifacts, no cache (storage billing for public
 * repos is not clearly free), and a concurrency group that cancels a superseded run.
 *
 * Two-direction proof: every rule is shown firing on a fixture that breaks it, and quiet on the real workflows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(REPO, '.github', 'workflows');

/** The ONLY labels allowed. Anything else (a `-4-cores` size, `self-hosted`, a group, a custom label) is billed or private. */
const STANDARD_RUNNERS = Object.freeze(['ubuntu-latest', 'windows-latest']);
const MATRIX_REF = /^\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}$/;

/** All values a matrix key can take in `job`, from the key's own list and any `include:` entries. */
function matrixValues(job, key) {
  const m = job?.strategy?.matrix;
  if (!m || typeof m !== 'object') return null;
  const values = [];
  if (Object.hasOwn(m, key)) {
    if (!Array.isArray(m[key])) return null; // an expression (`fromJSON(...)`) cannot be resolved here
    values.push(...m[key]);
  }
  for (const inc of Array.isArray(m.include) ? m.include : []) if (inc && Object.hasOwn(inc, key)) values.push(inc[key]);
  return values.length ? values : null;
}

/**
 * @param {object} workflow a parsed workflow
 * @param {string} file name used in messages
 * @returns {string[]} violations (empty = within budget)
 */
function runnerViolations(workflow, file) {
  const out = [];
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    const ro = job?.['runs-on'];
    const where = `${file} job "${id}"`;
    // A reusable-workflow call hands the work to another file this guard does not read: fail closed rather than let it
    // delegate around the budget (R1 M2). The repo uses none today; adopting one means extending this guard first.
    if (job && typeof job === 'object' && 'uses' in job) { out.push(`${where}: calls a reusable workflow (${job.uses}); its runners and steps are not inspected by this guard`); continue; }
    if (typeof ro !== 'string') { out.push(`${where}: runs-on is ${ro === undefined ? 'missing' : 'not a plain string'} (${JSON.stringify(ro)}); a label list or a group object is not provably standard`); continue; }
    const ref = MATRIX_REF.exec(ro.trim());
    if (ref) {
      const values = matrixValues(job, ref[1]);
      if (!values) { out.push(`${where}: runs-on ${ro} cannot be resolved through this job's matrix (fail closed)`); continue; }
      for (const v of values) if (!STANDARD_RUNNERS.includes(v)) out.push(`${where}: matrix.${ref[1]} includes ${JSON.stringify(v)}, which is not a standard runner`);
      continue;
    }
    if (ro.includes('${{')) { out.push(`${where}: runs-on ${JSON.stringify(ro)} is an expression this guard cannot resolve (fail closed)`); continue; }
    if (!STANDARD_RUNNERS.includes(ro)) out.push(`${where}: runs-on ${JSON.stringify(ro)} is not one of ${STANDARD_RUNNERS.join(', ')}`);
  }
  return out;
}

/** The extra obligations of the full-suite workflow: no artifacts, no cache, a cancelling concurrency group. */
function fullSuiteViolations(workflow, file) {
  const out = [];
  for (const [id, job] of Object.entries(workflow?.jobs ?? {})) {
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      const uses = String(step?.uses ?? '');
      if (/^actions\/upload-artifact@/.test(uses)) out.push(`${file} job "${id}": uploads an artifact (${uses}); artifact storage is not clearly free for public repos`);
      if (/^actions\/cache(?:\/(?:save|restore))?@/.test(uses)) out.push(`${file} job "${id}": uses actions/cache (${uses}); cache storage is not clearly free for public repos`);
      if (/^actions\/setup-[a-z]+@/.test(uses) && step?.with && 'cache' in step.with) out.push(`${file} job "${id}": ${uses} sets cache:, which is actions/cache underneath`);
    }
  }
  const c = workflow?.concurrency;
  if (!c || typeof c !== 'object' || !c.group) out.push(`${file}: no concurrency group, so superseded runs pile up`);
  else if (c['cancel-in-progress'] !== true) out.push(`${file}: concurrency.cancel-in-progress is not true, so superseded runs are not cancelled`);
  return out;
}

const y = (text) => parse(text);

describe('runner labels — the rule fires on every way of leaving the free tier', () => {
  const job = (runsOn, extra = '') => y(`on: push\njobs:\n  j:\n    runs-on: ${runsOn}\n${extra}    steps: []\n`);

  it('accepts the two standard labels', () => {
    assert.deepEqual(runnerViolations(job('ubuntu-latest'), 'w.yml'), []);
    assert.deepEqual(runnerViolations(job('windows-latest'), 'w.yml'), []);
  });

  for (const [what, label] of [
    ['a larger runner size', 'ubuntu-latest-4-cores'],
    ['a pinned larger image', 'ubuntu-24.04-8core'],
    ['self-hosted', 'self-hosted'],
    ['an unknown custom label', 'gpu-runner'],
    ['a label LIST', '[ubuntu-latest, gpu]'],
    ['a runner GROUP object', '{ group: big-runners }'],
    ['an unresolvable expression', "${{ inputs.runner }}"],
  ]) {
    it(`fires on ${what}`, () => {
      const v = runnerViolations(job(label), 'w.yml');
      assert.ok(v.length >= 1, `expected a violation for ${label}`);
    });
  }

  it('fires when runs-on is missing', () => {
    assert.ok(runnerViolations(y('on: push\njobs:\n  j:\n    steps: []\n'), 'w.yml').length >= 1);
  });

  it('resolves a matrix and fires when ANY value (including an include: entry) is not standard', () => {
    const ok = y('on: push\njobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, windows-latest]\n    steps: []\n');
    assert.deepEqual(runnerViolations(ok, 'w.yml'), []);
    const big = y('on: push\njobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest, ubuntu-latest-8-cores]\n    steps: []\n');
    assert.equal(runnerViolations(big, 'w.yml').length, 1);
    const inc = y('on: push\njobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: [ubuntu-latest]\n        include:\n          - os: macos-latest-xlarge\n    steps: []\n');
    assert.equal(runnerViolations(inc, 'w.yml').length, 1);
    const dynamic = y("on: push\njobs:\n  j:\n    runs-on: ${{ matrix.os }}\n    strategy:\n      matrix:\n        os: ${{ fromJSON(needs.x.outputs.os) }}\n    steps: []\n");
    assert.equal(runnerViolations(dynamic, 'w.yml').length, 1, 'a matrix built from an expression cannot be proven standard');
  });

  it('fires on a reusable-workflow call: delegating the work must not bypass the budget (R1 M2)', () => {
    const v = runnerViolations(y('on: push\njobs:\n  j:\n    uses: ./.github/workflows/x.yml\n'), 'w.yml');
    assert.equal(v.length, 1);
    assert.match(v[0], /reusable workflow/);
  });
});

describe('full-suite obligations — the rule fires on artifacts, cache and a missing cancel', () => {
  const wf = (steps, conc = 'concurrency:\n  group: g\n  cancel-in-progress: true\n') => y(`on: push\n${conc}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}`);

  it('accepts a clean workflow', () => {
    assert.deepEqual(fullSuiteViolations(wf('      - run: npm test\n'), 'w.yml'), []);
  });
  it('fires on an uploaded artifact', () => {
    assert.equal(fullSuiteViolations(wf('      - uses: actions/upload-artifact@v7\n        with: { name: x, path: y }\n'), 'w.yml').length, 1);
  });
  it('fires on actions/cache, including save/restore', () => {
    assert.equal(fullSuiteViolations(wf('      - uses: actions/cache@v4\n        with: { path: p, key: k }\n'), 'w.yml').length, 1);
    assert.equal(fullSuiteViolations(wf('      - uses: actions/cache/restore@v4\n        with: { path: p, key: k }\n'), 'w.yml').length, 1);
  });
  it('fires on a cache: input to setup-node', () => {
    assert.equal(fullSuiteViolations(wf("      - uses: actions/setup-node@v7\n        with: { node-version: '22', cache: npm }\n"), 'w.yml').length, 1);
  });
  it('fires when there is no concurrency group, or it does not cancel', () => {
    assert.equal(fullSuiteViolations(wf('      - run: x\n', ''), 'w.yml').length, 1);
    assert.equal(fullSuiteViolations(wf('      - run: x\n', 'concurrency:\n  group: g\n'), 'w.yml').length, 1);
    assert.equal(fullSuiteViolations(wf('      - run: x\n', 'concurrency:\n  group: g\n  cancel-in-progress: false\n'), 'w.yml').length, 1);
  });
});

describe('the real workflows are within budget', () => {
  const files = fs.existsSync(WORKFLOWS) ? fs.readdirSync(WORKFLOWS).filter((f) => /\.ya?ml$/.test(f)).sort() : [];

  it('the corpus is non-empty (a vacuous pass reads nothing)', () => {
    assert.ok(files.length >= 5, `expected the repo's workflows, found ${files.length}`);
    assert.ok(files.includes('full-suite.yml'), 'full-suite.yml must exist: it is the full-suite verdict the merge recipe reads');
  });

  for (const f of files) {
    it(`${f}: every runs-on is a standard runner`, () => {
      const wf = parse(fs.readFileSync(path.join(WORKFLOWS, f), 'utf8'));
      assert.deepEqual(runnerViolations(wf, f), []);
    });
  }

  it('full-suite.yml: no artifacts, no cache, and a cancelling concurrency group', () => {
    const wf = parse(fs.readFileSync(path.join(WORKFLOWS, 'full-suite.yml'), 'utf8'));
    assert.deepEqual(fullSuiteViolations(wf, 'full-suite.yml'), []);
    assert.equal(Object.keys(wf.jobs).length, 1, 'one job: the check name `full-suite` is what the ruleset and the verdict reader pin');
    assert.equal(wf.jobs['full-suite']?.name, 'full-suite');
  });
});
