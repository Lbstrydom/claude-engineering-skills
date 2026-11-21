/**
 * @fileoverview Every cross-store verdict writer prints the population line.
 *
 * The registry (`STORE_VERDICT_WRITERS`) is the contract; the census below is a
 * backstop that reads the FILESYSTEM, the one side that can see a store-reading CLI no
 * list mentions. Known limit, stated: the census recognises a writer by its imports and
 * its output vocabulary, so one that prints through a helper can evade it.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  STORE_VERDICT_WRITERS, EXEMPT_STORE_CLIS, buildPopulation, renderPopulationLine, parsePopulationLine,
} from '../scripts/lib/population.mjs';
import { collectQueues, renderQueues } from '../scripts/upstream-queues.mjs';
import { collectDrift, renderDrift } from '../scripts/store-drift.mjs';
import { populationFromFanout } from '../scripts/lib/population.mjs';
import { TIERED_SHADOW_CONTRACT_EPOCH } from '../scripts/lib/audit/tiered-shadow-summary.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// Behavioural coverage, by writer. EVERY registered writer except `model-eval-adjudicator` is exercised by
// running its real renderer on controlled input (a pure render function, or the CLI itself on an
// offline path). `model-eval-adjudicator` is the ONE exception: its output only exists after a live
// store read AND a model call, so it has no pure renderer and keeps a source-wiring assertion.
const NO_PURE_RENDERER = ['scripts/model-eval-adjudicator.mjs'];
const BEHAVIOURAL = [
  'scripts/upstream-queues.mjs', 'scripts/store-drift.mjs', 'scripts/tiered-shadow-report.mjs',
  'scripts/bakeoff-collect.mjs', 'scripts/own-model-coverage.mjs',
];
const noAnsi = (t) => String(t).replace(/\u001b\[[0-9;]*m/g, '');
const offline = { ...process.env, AUDIT_DB_URL: '' };   // an EMPTY DSN is the air-gap signal: no store, hermetic
const runCli = (args, { allowFail = false } = {}) => {
  try {
    return { stdout: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8', env: offline, stdio: ['ignore', 'pipe', 'pipe'] }), stderr: '', code: 0 };
  } catch (err) {
    if (!allowFail) throw err;
    return { stdout: String(err.stdout ?? ''), stderr: String(err.stderr ?? ''), code: err.status };
  }
};

describe('STORE_VERDICT_WRITERS — each registered writer is covered, behaviourally where it can be', () => {
  it('every registered writer is accounted for exactly once', () => {
    const covered = [...NO_PURE_RENDERER, ...BEHAVIOURAL].sort();
    assert.deepEqual(STORE_VERDICT_WRITERS.map((w) => w.file).sort(), covered);
  });

  for (const file of NO_PURE_RENDERER) {
    it(`${file} (no pure renderer): imports the population module and renders the line`, () => {
      const src = stripComments(read(file));
      assert.match(src, /from '\.\/lib\/(?:store\/population-ambient|population)\.mjs'/, 'imports the population module');
      assert.match(src, /renderPopulationLine\(/, 'renders the line');
      assert.match(src, /population,/, 'carries the object in its JSON payload');
    });
  }

  const store = { fingerprint: 'd5a9d07b91225a93', url: 'x', sslMode: null, repos: ['r'], aliases: ['wine'] };
  const policy = [{ repo: 'orgx-tools', alias: 'orgx', reason: 'unreachable-by-policy' }];

  it('upstream-queues: a parseable line on the answered path AND the 0-answered path', () => {
    const cases = [
      { answer: { ok: true, rows: [], reason: null }, expect: /0 open/ },
      { answer: { ok: false, rows: [], reason: 'timeout' }, expect: /NOTHING WAS CHECKED/ },
    ];
    for (const { answer, expect } of cases) {
      const collected = collectQueues({ stores: [store], unresolved: [], policyUnreachable: policy, query: () => answer });
      const result = { ...collected, population: populationFromFanout({ ...collected, registry: [] }) };
      const card = noAnsi(renderQueues(result));
      assert.match(card, expect);
      const pop = parsePopulationLine(card);
      assert.deepEqual(pop, result.population, card);
      assert.ok(pop.notMeasured.some((x) => x.alias === 'orgx' && x.reason === 'unreachable-by-policy'));
      assert.equal(pop.measured.length, answer.ok ? 1 : 0, 'a store that did not answer is not measured');
    }
  });

  it('store-drift: a parseable line on the answered path AND the 0-answered path', () => {
    const clean = () => ({ ok: true, reason: null, drift: { drift: { unapplied: [], shaMismatch: [] } } });
    const down = () => ({ ok: false, drift: null, reason: 'timeout' });
    for (const [query, expect, measured] of [[clean, /all current/, 1], [down, /NOTHING WAS CHECKED/, 0]]) {
      const collected = collectDrift({ stores: [store], unresolved: [], policyUnreachable: policy, query });
      const result = { ...collected, population: populationFromFanout({ ...collected, registry: [] }) };
      const card = noAnsi(renderDrift(result));
      assert.match(card, expect);
      const pop = parsePopulationLine(card);
      assert.equal(pop?.measured.length, measured, card);
      assert.deepEqual(pop, result.population);
    }
  });

  it('tiered-shadow-report: human path (empty AND with records) and the JSON path carry the population', () => {
    const missing = path.join(ROOT, 'no-such-log.jsonl');
    const human = parsePopulationLine(runCli(['scripts/tiered-shadow-report.mjs', '--log', missing]).stdout);
    assert.ok(human, 'a population line is printed on the empty human path');
    assert.equal(human.measured.length, 0, 'a local log is not a store');
    const json = JSON.parse(runCli(['scripts/tiered-shadow-report.mjs', '--log', missing, '--json']).stdout);
    assert.deepEqual(json.population, JSON.parse(JSON.stringify(human)));

    const tmp = path.join(os.tmpdir(), `population-writers-shadow-${process.pid}.jsonl`);
    fs.writeFileSync(tmp, `${JSON.stringify({
      legacyOk: true, shadowOk: true,
      comparison: {
        contractEpoch: TIERED_SHADOW_CONTRACT_EPOCH, legacyFindingCount: 2, onlyTieredCount: 0, overlapCount: 2, tieredRunStatus: 'complete',
        legacyEligibleCount: 2, tieredEligibleCount: 2, tieredStage0Verified: 2,
      },
    })}\n`);
    try {
      const withRows = runCli(['scripts/tiered-shadow-report.mjs', '--log', tmp]).stdout;
      assert.match(withRows, /compared runs:\s+1/, 'the full report rendered');
      assert.ok(parsePopulationLine(withRows), 'and carries the population line');
      assert.equal(JSON.parse(runCli(['scripts/tiered-shadow-report.mjs', '--log', tmp, '--json']).stdout).population.schema, 'population/v1');
    } finally { fs.rmSync(tmp, { force: true }); }
  });

  it('bakeoff-collect --progress: prints a parseable line (progress is read from a local log, so 0 stores)', () => {
    const out = runCli(['scripts/bakeoff-collect.mjs', '--progress']).stdout;
    const pop = parsePopulationLine(out);
    assert.ok(pop, out);
    assert.equal(pop.measured.length, 0);
  });

  it('own-model-coverage check --live with NO store: the envelope carries the population and nothing is measured', () => {
    const r = runCli(['scripts/own-model-coverage.mjs', 'check', '--live'], { allowFail: true });
    assert.equal(r.code, 3, 'unmeasured keeps its exit code');
    const envelope = JSON.parse(r.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop());
    assert.equal(envelope.population.schema, 'population/v1');
    assert.deepEqual(envelope.population.measured, [], 'no entry measured => measured from 0 stores');
    assert.ok(parsePopulationLine(r.stderr), r.stderr);
  });

  it('own-model-coverage refuses --static together with --live', () => {
    const r = runCli(['scripts/own-model-coverage.mjs', 'check', '--static', '--live'], { allowFail: true });
    assert.equal(r.code, 2);
  });

  it('a hand-built line for each writer scope grammar round-trips', () => {
    for (const scope of ['store', 'repo']) {
      const pop = buildPopulation({ measured: [{ store: 'aaaaaaaa', scope, consumers: [] }], unknownBeyond: true });
      assert.deepEqual(parsePopulationLine(renderPopulationLine(pop)), pop);
    }
  });
});

describe('census — a store-reading CLI that prints a verdict must be registered or exempt', () => {
  const registered = new Set(STORE_VERDICT_WRITERS.map((w) => w.file));
  const exempt = new Set(EXEMPT_STORE_CLIS.map((w) => w.file));

  /** imports lib/store/ or lib/db/ (static or dynamic) AND prints verdict/window vocabulary in a string literal. */
  function flagged(src) {
    const body = stripComments(src);
    const imports = /from\s+['"]\.\/lib\/(?:store|db)\//.test(body) || /import\(\s*['"]\.\/lib\/(?:store|db)\//.test(body);
    if (!imports) return false;
    const noImports = body.replace(/^\s*import .*$/gm, '');
    return /(['"`])(?!--|\.\/)[^'"`\n]*\b(?:verdict|window)\b[^'"`\n]*\1/i.test(noImports);
  }

  const scripts = fs.readdirSync(path.join(ROOT, 'scripts')).filter((f) => f.endsWith('.mjs')).map((f) => `scripts/${f}`);

  it('the census sees every registered writer family (vacuous-pass guard)', () => {
    const hits = scripts.filter((f) => flagged(read(f)));
    assert.ok(hits.length >= 5, `census flagged only ${hits.length} files — the heuristic went blind`);
    assert.ok(hits.includes('scripts/tiered-shadow-report.mjs'));
  });

  it('every flagged CLI is registered or exempt with a reason', () => {
    const unaccounted = scripts.filter((f) => flagged(read(f)) && !registered.has(f) && !exempt.has(f));
    assert.deepEqual(unaccounted, [], 'register it in STORE_VERDICT_WRITERS (and print the population line) or add it to EXEMPT_STORE_CLIS with a reason');
  });

  it('registered and exempt files exist (a stale entry is a lie)', () => {
    for (const f of [...registered, ...exempt]) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  });

  it('negative control: a synthetic unregistered writer is flagged', () => {
    const fake = "import { many } from './lib/db/query.mjs';\nconsole.log(`window verdict: ${many}`);\n";
    assert.equal(flagged(fake), true);
    assert.equal(flagged("import fs from 'node:fs';\nconsole.log('window verdict');"), false, 'no store import, no flag');
  });
});
