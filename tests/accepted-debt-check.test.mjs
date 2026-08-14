import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  parseAgentsDebtTable,
  computeRowFingerprint,
  checkRegistryParity,
  runPredicate,
  checkAll,
} from '../scripts/lib/accepted-debt-check.mjs';
import { ACCEPTED_DEBT_ROWS, loadRegistry } from '../scripts/lib/accepted-debt-registry.mjs';
import { executeCheck } from '../scripts/check-accepted-debt.mjs';

// Design + contract: docs/plans/accepted-debt-table-verification.md §4/§6.

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const FIXTURE_TABLE = [
  '## Accepted Technical Debt',
  '',
  'These items were evaluated and deliberately accepted:',
  '',
  '| Item | Rationale | Revisit trigger |',
  '|------|-----------|-----------------|',
  '| `fooBar` no cache | Rationale one. | Trigger one |',
  '| `bazQux` weird thing | Rationale two. | Trigger two |',
  '',
  '## Some Other Section',
  '',
  'unrelated content',
].join('\n');

// ── (a) parser — fixture ────────────────────────────────────────────────

describe('parseAgentsDebtTable — fixture table', () => {
  it('parses a well-formed table into rows with fingerprints', () => {
    const r = parseAgentsDebtTable(FIXTURE_TABLE);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[0].anchor, '`fooBar` no cache');
    assert.equal(typeof r.rows[0].fingerprint, 'string');
    assert.ok(r.rows[0].fingerprint.length > 0);
  });

  it('missing heading → hard parse error', () => {
    const r = parseAgentsDebtTable('# Nothing here\n\nno table');
    assert.equal(r.ok, false);
    assert.match(r.error, /heading/);
  });

  it('missing header row → hard parse error', () => {
    const r = parseAgentsDebtTable('## Accepted Technical Debt\n\nno table follows');
    assert.equal(r.ok, false);
    assert.match(r.error, /header row/);
  });

  it('the section ends at a level-1 heading (# ), not just another level-2 (## ) — Gemini gate G1', () => {
    const md = [
      '## Accepted Technical Debt',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `real` | the actual row | trigger |',
      '',
      '# A Top-Level Section',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `unrelated` | not part of the debt table | never |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].anchor, '`real`');
  });

  it('duplicate anchor → hard parse error, not a silently-dropped row', () => {
    const md = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `dup` | R1 | T1 |',
      '| `dup` | R2 | T2 |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, false);
    assert.match(r.error, /duplicate/);
  });

  it('a heading-shaped line INSIDE a fenced code block is not mistaken for the real heading (GPT Sustainability M4, round 2)', () => {
    const md = [
      '## Some Other Doc',
      '',
      'Example of what NOT to write:',
      '```markdown',
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `fake` | should not be read | never |',
      '```',
      '',
      '## Accepted Technical Debt',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `real` | the actual row | trigger |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].anchor, '`real`');
  });

  it('a header-row-shaped line inside a fence AFTER the real heading is not mistaken for the real header row (GPT Sustainability M8, round 3 — the round-2 fix made the heading fence-aware but not this)', () => {
    const md = [
      '## Accepted Technical Debt',
      '',
      'Example of the table shape:',
      '```markdown',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `fake` | should not be read | never |',
      '```',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `real` | the actual row | trigger |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].anchor, '`real`');
  });

  it('a mismatched fence delimiter (~~~ inside a ``` fence) does not prematurely close it (GPT be-services M1 / Sustainability M6, round 4)', () => {
    const md = [
      '## Accepted Technical Debt',
      '',
      '```markdown',
      'Some fenced content mentioning ~~~ as an example of a DIFFERENT fence style,',
      'which must NOT close this backtick fence.',
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `fake` | should not be read | never |',
      '```',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `real` | the actual row | trigger |',
    ].join('\n');
    const r2 = parseAgentsDebtTable(md);
    assert.equal(r2.ok, true);
    assert.equal(r2.rows.length, 1);
    assert.equal(r2.rows[0].anchor, '`real`');
  });

  it('a closing fence line with extra content (e.g. "```js") does not close the fence — only a bare fence-char line does', () => {
    const md2 = [
      '## Accepted Technical Debt',
      '',
      '```markdown',
      '```js',
      '## Accepted Technical Debt (still inside the outer fence)',
      '```',
      '',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `real` | the actual row | trigger |',
    ].join('\n');
    const r3 = parseAgentsDebtTable(md2);
    assert.equal(r3.ok, true);
    assert.equal(r3.rows.length, 1);
    assert.equal(r3.rows[0].anchor, '`real`');
  });

  it('missing cell (wrong column count) → hard parse error', () => {
    const md = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `only-two` | Rationale only |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, false);
    assert.match(r.error, /expected 3 cells/);
  });

  it('empty cell → hard parse error', () => {
    const md = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `empty-trigger` | Some rationale | |',
    ].join('\n');
    const r = parseAgentsDebtTable(md);
    assert.equal(r.ok, false);
    assert.match(r.error, /empty cell/);
  });
});

// ── (b) parser — real AGENTS.md, parity baseline derived from the real file ─

describe('parseAgentsDebtTable — real AGENTS.md (live parity baseline)', () => {
  const agentsMarkdown = fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8');
  const parsed = parseAgentsDebtTable(agentsMarkdown);

  it('parses cleanly', () => {
    assert.equal(parsed.ok, true);
  });

  it('yields exactly 6 rows matching ACCEPTED_DEBT_ROWS 1:1 by anchor AND fingerprint', () => {
    assert.equal(parsed.rows.length, ACCEPTED_DEBT_ROWS.length);
    const byAnchor = new Map(parsed.rows.map((r) => [r.anchor, r]));
    for (const regRow of ACCEPTED_DEBT_ROWS) {
      const liveRow = byAnchor.get(regRow.agentsTableAnchor);
      assert.ok(liveRow, `registry anchor not found in live table: ${regRow.agentsTableAnchor}`);
      assert.equal(liveRow.fingerprint, regRow.rowFingerprint, `fingerprint drift for ${regRow.agentsTableAnchor} — the registry is out of sync with the real AGENTS.md table`);
    }
  });
});

// ── computeRowFingerprint ───────────────────────────────────────────────

describe('computeRowFingerprint', () => {
  it('is stable for identical content', () => {
    const row = { item: 'X', rationale: 'Y', trigger: 'Z' };
    assert.equal(computeRowFingerprint(row), computeRowFingerprint({ ...row }));
  });

  it('changes when any cell changes', () => {
    const a = computeRowFingerprint({ item: 'X', rationale: 'Y', trigger: 'Z' });
    const b = computeRowFingerprint({ item: 'X', rationale: 'Y changed', trigger: 'Z' });
    assert.notEqual(a, b);
  });

  it('normalizes whitespace so re-wrapped prose does not spuriously drift', () => {
    const a = computeRowFingerprint({ item: 'X', rationale: 'Hello  world', trigger: 'Z' });
    const b = computeRowFingerprint({ item: 'X', rationale: 'Hello world', trigger: 'Z' });
    assert.equal(a, b);
  });
});

// ── (c) runPredicate — call-shape resolution ────────────────────────────

const PREDICATE = {
  type: 'no-invocation-outside-scope',
  symbol: 'readFileOrDie',
  provenanceModules: ['scripts/lib/file-io.mjs', 'scripts/shared.mjs'],
  allowedGlobs: ['scripts/*.mjs', 'tests/**'],
};

function fixtureDeps({ analyzed = [], unsupportedFormat = [], sources = {}, hasSymbol } = {}) {
  return {
    enumerateTrackedSources: () => ({ ok: true, analyzed, unsupportedFormat }),
    readTrackedSource: (f) => {
      if (!(f in sources)) throw new Error(`fixture: unexpected read of ${f}`);
      return sources[f];
    },
    hasSymbol: hasSymbol ?? (() => true),
  };
}

describe('runPredicate — call-shape resolution', () => {
  it('plain named-import call → contradicted', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "import { readFileOrDie } from './file-io.mjs';\nreadFileOrDie('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'contradicted');
    assert.equal(r.evidence[0].file, file);
    assert.equal(r.evidence[0].line, 2);
  });

  it('aliased named-import call → contradicted', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "import { readFileOrDie as rfod } from './file-io.mjs';\nrfod('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'contradicted');
  });

  it('shadowing local declaration → holds (must NOT match)', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "function readFileOrDie(x) { return x; }\nreadFileOrDie('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'holds');
  });

  it('namespace-import member call → contradicted', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "import * as fileIo from './file-io.mjs';\nfileIo.readFileOrDie('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'contradicted');
  });

  it('namespace-import member call on an UNRELATED object with the same property name → holds', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "import * as somethingElse from './other.mjs';\nconst obj = { readFileOrDie() {} };\nobj.readFileOrDie('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'holds');
  });

  it('a call resolved only through the scripts/shared.mjs barrel entry → contradicted', () => {
    const file = 'scripts/lib/consumer.mjs';
    const src = "import { readFileOrDie } from '../shared.mjs';\nreadFileOrDie('x');\n";
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'contradicted', 'the barrel provenance entry must close this gap');
  });

  it('a provenance module reporting the symbol missing → unknown', () => {
    const r = runPredicate(PREDICATE, fixtureDeps({ hasSymbol: () => false }));
    assert.equal(r.state, 'unknown');
    assert.match(r.evidence[0].reason, /no longer exports/);
  });

  it('a candidate file that fails to parse (hard failure) → unknown, never holds', () => {
    const file = 'scripts/lib/broken.mjs';
    const src = 'function ( { this is not valid js at all @@@';
    const r = runPredicate(PREDICATE, fixtureDeps({ analyzed: [file], sources: { [file]: src } }));
    assert.equal(r.state, 'unknown');
  });

  it('an injected readTrackedSource that throws for one file → that file alone contributes unknown; rest unaffected', () => {
    const goodFile = 'scripts/lib/consumer.mjs';
    const badFile = 'scripts/lib/unreadable.mjs';
    const goodSrc = "import { readFileOrDie } from './file-io.mjs';\nconsole.log('no call here');\n";
    const deps = {
      enumerateTrackedSources: () => ({ ok: true, analyzed: [badFile, goodFile], unsupportedFormat: [] }),
      readTrackedSource: (f) => {
        if (f === badFile) throw new Error('EACCES simulated');
        if (f === goodFile) return goodSrc;
        throw new Error(`fixture: unexpected read of ${f}`);
      },
      hasSymbol: () => true,
    };
    const r = runPredicate(PREDICATE, deps);
    assert.equal(r.state, 'unknown');
    assert.equal(r.evidence.length, 1);
    assert.equal(r.evidence[0].file, badFile);
  });

  it('an unsupported-format (.cjs) file among the enumerated candidates → named in unknown evidence, never silently absent', () => {
    const r = runPredicate(PREDICATE, fixtureDeps({ unsupportedFormat: ['scripts/lib/legacy.cjs'] }));
    assert.equal(r.state, 'unknown');
    assert.equal(r.evidence[0].file, 'scripts/lib/legacy.cjs');
  });

  it('no candidates at all → holds', () => {
    const r = runPredicate(PREDICATE, fixtureDeps());
    assert.equal(r.state, 'holds');
    assert.deepEqual(r.evidence, []);
  });

  it('enumeration failure (e.g. git unavailable) → unknown, never a silent pass', () => {
    const r = runPredicate(PREDICATE, {
      enumerateTrackedSources: () => ({ ok: false, error: 'git not found' }),
      readTrackedSource: () => { throw new Error('should not be called'); },
      hasSymbol: () => true,
    });
    assert.equal(r.state, 'unknown');
  });
});

// ── (d) checkRegistryParity ──────────────────────────────────────────────

describe('checkRegistryParity', () => {
  const tableRows = [
    { anchor: 'A', rationale: 'ra', trigger: 'ta', fingerprint: 'fp-a' },
    { anchor: 'B', rationale: 'rb', trigger: 'tb', fingerprint: 'fp-b' },
  ];
  const registryRows = [
    { agentsTableAnchor: 'A', rowFingerprint: 'fp-a' },
    { agentsTableAnchor: 'C', rowFingerprint: 'fp-c' },
  ];

  it('reports unregistered (table row with no registry entry), registered, and orphaned all distinctly', () => {
    const results = checkRegistryParity(tableRows, registryRows);
    const byAnchor = Object.fromEntries(results.map((r) => [r.anchor, r.registryStatus]));
    assert.equal(byAnchor.A, 'registered');
    assert.equal(byAnchor.B, 'unregistered');
    assert.equal(byAnchor.C, 'orphaned');
  });

  it('a fingerprint mismatch on a matched anchor is registry-stale, not registered', () => {
    const staleRegistry = [{ agentsTableAnchor: 'A', rowFingerprint: 'fp-a-OLD' }];
    const results = checkRegistryParity([tableRows[0]], staleRegistry);
    assert.equal(results[0].registryStatus, 'registry-stale');
  });

  it('a duplicate agentsTableAnchor in the (unvalidated) registry never silently shadows — reported registry-stale, not registered (GPT be-services M3, round 2, defense-in-depth against a caller that bypasses loadRegistry)', () => {
    const dupRegistry = [
      { agentsTableAnchor: 'A', rowFingerprint: 'fp-a' },
      { agentsTableAnchor: 'A', rowFingerprint: 'fp-a-DIFFERENT' },
    ];
    const results = checkRegistryParity([tableRows[0]], dupRegistry);
    assert.equal(results[0].registryStatus, 'registry-stale');
  });
});

// ── checkAll orchestration + execution precondition ─────────────────────

describe('checkAll — execution precondition for stale/unregistered/orphaned rows', () => {
  it('a registry-stale row gets predicateState:null and runPredicate is NEVER invoked for it', () => {
    const agentsMarkdown = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `foo` | Rationale changed | Trigger |',
    ].join('\n');
    const staleFingerprint = computeRowFingerprint({ item: '`foo`', rationale: 'OLD rationale', trigger: 'Trigger' });
    const registry = [{
      agentsTableAnchor: '`foo`',
      rowFingerprint: staleFingerprint,
      verification: { mode: 'checked', predicate: { ...PREDICATE, symbol: 'foo' } },
    }];

    let predicateInvoked = false;
    const result = checkAll({
      agentsMarkdown,
      registry,
      runPredicate: () => { predicateInvoked = true; return { state: 'holds', evidence: [] }; },
    });

    assert.equal(result.ok, true);
    assert.equal(predicateInvoked, false, 'runPredicate must not execute against a stale premise');
    assert.equal(result.summary.rows[0].registryStatus, 'registry-stale');
    assert.equal(result.summary.rows[0].predicateState, null);
    assert.equal(result.triggered, true);
  });

  it('an unverifiable row never runs a predicate and carries its reason', () => {
    const agentsMarkdown = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `foo` | Some rationale | Trigger |',
    ].join('\n');
    const registry = [{
      agentsTableAnchor: '`foo`',
      rowFingerprint: computeRowFingerprint({ item: '`foo`', rationale: 'Some rationale', trigger: 'Trigger' }),
      verification: { mode: 'unverifiable', reason: 'external fact' },
    }];
    const result = checkAll({ agentsMarkdown, registry });
    assert.equal(result.summary.rows[0].verificationMode, 'unverifiable');
    assert.equal(result.summary.rows[0].reason, 'external fact');
    assert.equal(result.summary.rows[0].predicateState, null);
    assert.equal(result.triggered, false);
  });

  it('malformed table → {ok:false} with the parse error', () => {
    const result = checkAll({ agentsMarkdown: '# no table here', registry: [] });
    assert.equal(result.ok, false);
    assert.match(result.error, /heading/);
  });

  it('empty registry against a real table → every row reported unregistered, never a silent 0-checked clean pass', () => {
    const agentsMarkdown = [
      '## Accepted Technical Debt',
      '| Item | Rationale | Revisit trigger |',
      '|------|-----------|-----------------|',
      '| `foo` | R | T |',
    ].join('\n');
    const result = checkAll({ agentsMarkdown, registry: [] });
    assert.equal(result.ok, true);
    assert.equal(result.summary.rows.length, 1);
    assert.equal(result.summary.rows[0].registryStatus, 'unregistered');
    assert.equal(result.triggered, true);
  });
});

// ── (e) loadRegistry ─────────────────────────────────────────────────────

describe('loadRegistry', () => {
  const VALID_FP = 'abcdef0123456789';

  it('a Zod-valid fixture array → {ok:true, rows}', () => {
    const r = loadRegistry([{
      id: 'x',
      agentsTableAnchor: '`x`',
      rowFingerprint: VALID_FP,
      verification: { mode: 'unverifiable', reason: 'because' },
    }]);
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 1);
  });

  it('a Zod-invalid fixture (missing field) → {ok:false, error}, never throws', () => {
    assert.doesNotThrow(() => {
      const r = loadRegistry([{ id: 'x' }]);
      assert.equal(r.ok, false);
      assert.equal(typeof r.error, 'string');
    });
  });

  it('a Zod-invalid fixture (wrong verification.mode) → {ok:false}, never throws', () => {
    const r = loadRegistry([{
      id: 'x', agentsTableAnchor: '`x`', rowFingerprint: VALID_FP,
      verification: { mode: 'bogus-mode' },
    }]);
    assert.equal(r.ok, false);
  });

  it('a malformed rowFingerprint (not 16-char hex) → {ok:false}, never throws', () => {
    const r = loadRegistry([{
      id: 'x', agentsTableAnchor: '`x`', rowFingerprint: 'not-hex!',
      verification: { mode: 'unverifiable', reason: 'r' },
    }]);
    assert.equal(r.ok, false);
  });

  it('duplicate id → {ok:false, error mentions duplicate id}', () => {
    const row = (id, anchor) => ({ id, agentsTableAnchor: anchor, rowFingerprint: VALID_FP, verification: { mode: 'unverifiable', reason: 'r' } });
    const r = loadRegistry([row('dup', 'A'), row('dup', 'B')]);
    assert.equal(r.ok, false);
    assert.match(r.error, /duplicate id/);
  });

  it('duplicate agentsTableAnchor → {ok:false, error mentions duplicate anchor}', () => {
    const row = (id, anchor) => ({ id, agentsTableAnchor: anchor, rowFingerprint: VALID_FP, verification: { mode: 'unverifiable', reason: 'r' } });
    const r = loadRegistry([row('a', 'SAME'), row('b', 'SAME')]);
    assert.equal(r.ok, false);
    assert.match(r.error, /duplicate agentsTableAnchor/);
  });

  it('the real ACCEPTED_DEBT_ROWS loads cleanly', () => {
    const r = loadRegistry();
    assert.equal(r.ok, true);
    assert.equal(r.rows.length, 6);
  });
});

// ── (f) executeCheck envelope tests ──────────────────────────────────────

describe('executeCheck — envelope', () => {
  const VALID_AGENTS_LOAD = { ok: true, markdown: FIXTURE_TABLE.replace('`bazQux` weird thing', '`fooBar` no cache 2') };
  const VALID_REGISTRY_LOAD = loadRegistry([
    { id: 'a', agentsTableAnchor: '`fooBar` no cache', rowFingerprint: computeRowFingerprint({ item: '`fooBar` no cache', rationale: 'Rationale one.', trigger: 'Trigger one' }), verification: { mode: 'unverifiable', reason: 'r1' } },
    { id: 'b', agentsTableAnchor: '`fooBar` no cache 2', rowFingerprint: computeRowFingerprint({ item: '`fooBar` no cache 2', rationale: 'Rationale two.', trigger: 'Trigger two' }), verification: { mode: 'unverifiable', reason: 'r2' } },
  ]);

  it('clean path: ok:true, code:clean, exitCode:0', () => {
    const result = executeCheck({ agentsLoadResult: VALID_AGENTS_LOAD, registryLoadResult: VALID_REGISTRY_LOAD });
    assert.equal(result.code, 'clean');
    assert.equal(result.exitCode, 0);
    assert.equal(result.ok, true);
  });

  it('agents_unreadable: agentsLoadResult:{ok:false} → main() cannot bypass the seam on a read failure', () => {
    const result = executeCheck({ agentsLoadResult: { ok: false, errorClass: 'Error' }, registryLoadResult: VALID_REGISTRY_LOAD });
    assert.equal(result.code, 'agents_unreadable');
    assert.equal(result.exitCode, 2);
    assert.equal(result.ok, false);
    assert.equal(result.summary, null);
  });

  it('registry_invalid: registryLoadResult:{ok:false}', () => {
    const result = executeCheck({ agentsLoadResult: VALID_AGENTS_LOAD, registryLoadResult: { ok: false, error: 'bad' } });
    assert.equal(result.code, 'registry_invalid');
    assert.equal(result.exitCode, 2);
  });

  it('table_malformed: valid loads, but the table itself does not parse', () => {
    const result = executeCheck({ agentsLoadResult: { ok: true, markdown: 'no table here' }, registryLoadResult: VALID_REGISTRY_LOAD });
    assert.equal(result.code, 'table_malformed');
    assert.equal(result.exitCode, 2);
  });

  it('attention: a real row is unregistered', () => {
    const oneRowRegistry = loadRegistry([]);
    const result = executeCheck({ agentsLoadResult: VALID_AGENTS_LOAD, registryLoadResult: oneRowRegistry });
    assert.equal(result.code, 'attention');
    assert.equal(result.exitCode, 1);
  });

  it('summary.rows carries every registry row with reason intact — the real 6-row registry against the real AGENTS.md, all 5 unverifiable rows visible, not collapsed into a count', () => {
    const realAgents = { ok: true, markdown: fs.readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf-8') };
    const realRegistry = loadRegistry();
    const result = executeCheck({ agentsLoadResult: realAgents, registryLoadResult: realRegistry });
    assert.equal(result.code, 'clean');
    const unverifiable = result.summary.rows.filter((r) => r.verificationMode === 'unverifiable');
    assert.equal(unverifiable.length, 5);
    for (const r of unverifiable) {
      assert.equal(typeof r.reason, 'string');
      assert.ok(r.reason.length > 0);
    }
    const checked = result.summary.rows.filter((r) => r.verificationMode === 'checked');
    assert.equal(checked.length, 1);
    assert.equal(checked[0].predicateState, 'holds');
  });
});

// ── (g) small spawnSync CLI suite — the true process-boundary contract ──

describe('check-accepted-debt.mjs — CLI process boundary', () => {
  const CLI = path.join(REPO_ROOT, 'scripts', 'check-accepted-debt.mjs');

  it('--help exits 0', () => {
    const r = spawnSync('node', [CLI, '--help'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 0);
  });

  it('an unknown flag is rejected with exit 2', () => {
    const r = spawnSync('node', [CLI, '--bogus'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 2);
  });

  it('--out with no following value errors (exit 2) rather than silently writing to stdout instead (GPT be-services M2, round 3)', () => {
    const r = spawnSync('node', [CLI, '--json', '--out'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--out requires a file path/);
  });

  it('--out= (explicit empty assignment) also errors, not just a bare --out (Gemini gate G1, round 2)', () => {
    const r = spawnSync('node', [CLI, '--json', '--out='], { cwd: REPO_ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--out requires a file path/);
  });

  it('running from a subdirectory still finds the real repo-root AGENTS.md (GPT be-services M1, round 3)', () => {
    const r = spawnSync('node', [CLI, '--json'], { cwd: path.join(REPO_ROOT, 'scripts'), encoding: 'utf-8' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.code, 'clean');
  });

  it('--json emits exactly one valid JSON line on stdout, nothing else', () => {
    const r = spawnSync('node', [CLI, '--json'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    const lines = r.stdout.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]));
  });

  it('smoke run against the real repo: main() wires executeCheck() up correctly (exit code + top-level shape)', () => {
    const r = spawnSync('node', [CLI, '--json'], { cwd: REPO_ROOT, encoding: 'utf-8' });
    assert.equal(r.status, 0);
    const parsed = JSON.parse(r.stdout.trim());
    assert.equal(parsed.code, 'clean');
    assert.ok(parsed.summary);
    assert.ok(typeof parsed.rendering === 'string');
  });
});
