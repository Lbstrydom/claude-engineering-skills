/**
 * @fileoverview The storyline scenario, end to end, through the REAL orchestrator with a stubbed model client
 * (the same Tier-2 harness as run-multi-pass-code-audit-harness.test.mjs: canned responses, invariants only).
 *
 *   "a .cs file in a diff is admitted, gets boundaries, and is audited; a diff with only unrecognised files
 *    produces an explicit `uncovered` report, never a silent zero."
 *
 * docs/plans/file-coverage-contract-and-csharp.md, Phases 1-4.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { defaultResponses, EMPTY_STRUCTURE } from './helpers/multi-pass-audit-fixtures.mjs';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';

const audit = await import('../scripts/openai-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;
const { partitionDiffScope } = await import('../scripts/lib/diff-scope-admission.mjs');

const CS = 'tests/fixtures/csharp/Sample.Legacy.cs';
const CS2 = 'tests/fixtures/csharp/Sample.Layout.cs';
const PLAN = `# Fixture plan\n\nModify \`${CS}\` and \`${CS2}\`.\n`;

function stub(responses) {
  return {
    responses: {
      parse: async (params) => {
        const name = params?.text?.format?.name;
        if (!(name in responses)) throw new Error(`unstubbed pass ${name}`);
        return {
          status: 'completed', output: [], output_parsed: responses[name],
          usage: { input_tokens: 100, output_tokens: 50, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 10 } },
        };
      },
    },
  };
}

const OPTS = {
  passFilter: ['structure', 'wiring', 'backend', 'sustainability', 'quickfix'],
  noTools: true, noDebtLedger: true, noLedger: true, scopeMode: 'plan',
};
const file = (cov, p) => cov.files.find((f) => f.path === p);

describe('a C# diff through the orchestrator', () => {
  it('admits the .cs files, reads them, and records them as audited profiled files — coverage complete', async () => {
    const res = await runMultiPassCodeAudit(
      stub(defaultResponses({ structure_pass: { ...EMPTY_STRUCTURE, files_planned: 2, files_found: 2 } })),
      PLAN, '', false, null, '',
      { ...OPTS, coverageChanged: [{ path: CS, changeKind: 'modified' }, { path: CS2, changeKind: 'modified' }] },
    );
    assert.ok(res.code_files.includes(CS) && res.code_files.includes(CS2), 'the .cs files reached the audit (they were dropped as "non-code" before)');
    const cov = res._coverage;
    assert.ok(cov, 'a `_coverage` ledger is on the result');
    assert.equal(cov.changedTotal, 2);
    for (const p of [CS, CS2]) {
      const f = file(cov, p);
      assert.equal(f.class, 'profiled');
      assert.equal(f.language, 'cs');
      assert.equal(f.outcome, 'audited', `${p}: ${f.reason}`);
      assert.ok(['full', 'head-cut'].includes(f.read.state));
      assert.ok(Object.keys(f.read.byPass).length >= 2, 'read by more than one pass, each recorded');
    }
    assert.notEqual(res.verdict, 'INCOMPLETE');
    assert.equal(cov.gate, 'pass', JSON.stringify(cov.counts));
  });

  it('a diff with .cs AND unrecognised files: the verdict is not bare — partial coverage, the .xyz named', async () => {
    const res = await runMultiPassCodeAudit(
      stub(defaultResponses()), PLAN, '', false, null, '',
      { ...OPTS, coverageChanged: [{ path: CS, changeKind: 'modified' }, { path: 'svc/notes.xyz', changeKind: 'added' }, { path: 'svc/blob.qqq', changeKind: 'added' }] },
    );
    const cov = res._coverage;
    assert.equal(cov.status, 'partial');
    assert.equal(cov.gate, 'warn');
    assert.deepEqual(cov.uncoveredByExtension, { xyz: 1, qqq: 1 });
    assert.equal(file(cov, 'svc/notes.xyz').outcome, 'not-admitted');
    assert.equal(file(cov, CS).outcome, 'audited');
    assert.notEqual(res.verdict, 'INCOMPLETE', 'partial coverage warns; it does not block');
  });

  it('EVERY changed file unrecognised: the round is INCOMPLETE with an explicit uncovered report — never a silent zero', async () => {
    const res = await runMultiPassCodeAudit(
      stub(defaultResponses()), PLAN, '', false, null, '',
      { ...OPTS, coverageChanged: [{ path: 'svc/a.xyz', changeKind: 'added' }, { path: 'svc/b.xyz', changeKind: 'modified' }] },
    );
    const cov = res._coverage;
    assert.equal(cov.status, 'none');
    assert.equal(cov.gate, 'fail');
    assert.equal(res.verdict, 'INCOMPLETE', 'the change was not measured, so the round cannot read as clean');
    assert.deepEqual(cov.uncoveredByExtension, { xyz: 2 });
  });

  it('a policy-excluded source file is counted, forces a warn, and is never silently dropped', async () => {
    const res = await runMultiPassCodeAudit(
      stub(defaultResponses()), PLAN, '', false, null, '',
      { ...OPTS, coverageChanged: [{ path: CS }, { path: CS2 }], coverageExcluded: { infra: [], user: [CS2] } },
    );
    const cov = res._coverage;
    assert.equal(file(cov, CS2).outcome, 'excluded-user');
    assert.equal(cov.counts.excludedRequired, 1);
    assert.equal(cov.gate, 'warn');
  });

  it('a pass that FAILS contributes no read evidence: the ledger cannot claim it examined the file', async () => {
    const responses = defaultResponses({ structure_pass: { ...EMPTY_STRUCTURE } });
    const res = await runMultiPassCodeAudit(
      { responses: { parse: async (p) => {
        if (p?.text?.format?.name === 'structure_pass') throw new Error('provider exploded');
        return stub(responses).responses.parse(p);
      } } },
      PLAN, '', false, null, '',
      { ...OPTS, passFilter: ['structure'], coverageChanged: [{ path: CS }] },
    );
    const f = file(res._coverage, CS);
    assert.notEqual(f.outcome, 'audited', 'the only pass that rendered it failed');
    assert.equal(f.read.byPass.structure?.passCompleted ?? false, false);
    assert.equal(res.verdict, 'INCOMPLETE');
  });
});

// ── Upstream report 58f4e3a5 through the real orchestrator (docs/plans/audit-hunk-window-coverage.md) ──
describe('changed lines past maxPerFile: the reporter\'s shape, end to end', () => {
  const BIG = 'tests/fixtures/hunk-window/big-module.js';
  const BIG_B = 'tests/fixtures/hunk-window/big-module-b.js';
  const BIG_PLAN = `# Fixture plan\n\nModify \`${BIG}\` and \`${BIG_B}\`.\n`;
  const seen = {};
  const capturing = (responses) => ({
    responses: {
      parse: async (params) => {
        const name = params?.text?.format?.name;
        seen[name] = (seen[name] ?? '') + JSON.stringify(params);
        return stub(responses).responses.parse(params);
      },
    },
  });

  it('R1 --scope diff: hunks past the 4000-char quickfix head are rendered, measured, and the round converges', async () => {
    const res = await runMultiPassCodeAudit(
      capturing(defaultResponses()), BIG_PLAN, '', false, null, '',
      { ...OPTS, passFilter: ['quickfix'], coverageChanged: [{ path: BIG, changeKind: 'modified', hunks: [{ startLine: 300, lineCount: 4 }, { startLine: 400, lineCount: 3 }] }] },
    );
    for (const n of [300, 303, 400, 402]) assert.ok(seen.quickfix_pass.includes(`MARK_${n} `), `quickfix was shown changed line ${n}`);
    const f = file(res._coverage, BIG);
    assert.equal(f.outcome, 'audited');
    assert.equal(f.read.state, 'windowed');
    assert.equal(f.changedLinesUnread, 0, 'measured in R1 (it was null: R1 had no hunks)');
    assert.deepEqual(res._convergence, { converged: true, reason: 'converged' });
  });

  it('changed text no budget can hold: a clean PASS is NOT convergence (changed-lines-unread), and says so', async () => {
    // Two wholly-changed ~21 KB files through the structure pass alone (2000 per file / 30000 total): both get a base
    // window, the first grows to every changed line, the second cannot — its unread lines are measured and block.
    const whole = [{ startLine: 1, lineCount: 420 }];
    const res = await runMultiPassCodeAudit(
      capturing(defaultResponses({ structure_pass: { ...EMPTY_STRUCTURE } })), BIG_PLAN, '', false, null, '',
      { ...OPTS, passFilter: ['structure'], coverageChanged: [{ path: BIG, changeKind: 'modified', hunks: whole }, { path: BIG_B, changeKind: 'modified', hunks: whole }] },
    );
    assert.notEqual(res.verdict, 'INCOMPLETE');
    const unread = res._coverage.files.map((f) => f.changedLinesUnread);
    assert.ok(unread.some((u) => u > 0), JSON.stringify(unread));
    assert.deepEqual(res._convergence, { converged: false, reason: 'changed-lines-unread' });
  });
});

describe('pass limits are sized from what is sent (plan D11)', () => {
  // Behavioural (code audit R1 M5/M6): the SAME file, once head-cut (no hunks) and once grown to every changed line
  // (whole-file hunk), must reach the model with different output-token limits. Sized from a pre-render per-file
  // estimate (`measureContextChars(files, maxPerFile)` — file size and cap only) the two would be identical.
  const BIG = 'tests/fixtures/hunk-window/big-module.js';
  const plan = `# Fixture plan\n\nModify \`${BIG}\`.\n`;
  const limitFor = async (hunks) => {
    let tokens = null;
    const client = { responses: { parse: async (params) => {
      if (params?.text?.format?.name === 'quickfix_pass') tokens = params.max_output_tokens;
      return stub(defaultResponses()).responses.parse(params);
    } } };
    await runMultiPassCodeAudit(client, plan, '', false, null, '',
      { ...OPTS, passFilter: ['quickfix'], coverageChanged: [{ path: BIG, changeKind: 'modified', hunks }] });
    return tokens;
  };
  it('a grown context is given a larger output budget than the same file head-cut', async () => {
    // hunks: [] = a measured "no changed text line" → no window, today's head cut. (Absent hunks would be the
    // wholly-changed fallback, which grows too.)
    const headCut = await limitFor([]);
    const grown = await limitFor([{ startLine: 1, lineCount: 420 }]);
    assert.ok(Number.isFinite(headCut) && Number.isFinite(grown), `limits captured: ${headCut} / ${grown}`);
    assert.ok(grown > headCut, `grown ${grown} must exceed head-cut ${headCut}`);
  });
});

describe('the diff-scope admission that feeds it (the original silent drop)', () => {
  it('a C# diff is admitted; the operator notice names an unrecognised type as NOT audited, not "non-code"', () => {
    const p = partitionDiffScope({ files: [CS, 'a.png', 'x.xyz'] });
    assert.deepEqual(p.auditable, [CS]);
    assert.deepEqual(p.nonCode, ['a.png']);
    assert.deepEqual(p.uncovered, ['x.xyz']);
  });
});
