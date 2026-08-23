/**
 * @fileoverview Phase C — linter.mjs tests.
 * Parsers use captured fixtures; runTool uses mocked execFileSync.
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  runTool,
  parseEslintOutput,
  parseRuffOutput,
  parseTscOutput,
  parseFlake8PylintOutput,
  normalizeExternalFinding,
  normalizeToolResults,
  formatLintSummary,
  setExecFileSync,
  resetExecFileSync,
  setExistsSync,
  resetExistsSync,
} from '../scripts/lib/linter.mjs';
import { ProducerFindingSchema } from '../scripts/lib/schemas.mjs';
import { semanticId } from '../scripts/lib/findings.mjs';

// ── Parser fixtures ──────────────────────────────────────────────────────────

describe('parseEslintOutput', () => {
  test('parses ESLint JSON output with messages', () => {
    const fixture = JSON.stringify([
      {
        filePath: path.resolve('src/foo.js'),
        messages: [
          { ruleId: 'no-unused-vars', line: 10, column: 5, message: "'x' is defined but never used.", fix: null },
          { ruleId: 'no-console', line: 22, column: 3, message: 'Unexpected console statement.', endLine: 22 },
        ],
      },
    ]);
    const findings = parseEslintOutput(fixture);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].rule, 'no-unused-vars');
    assert.equal(findings[0].line, 10);
    assert.ok(findings[0].file.endsWith('src/foo.js'));
    assert.equal(findings[0].fixable, false);
    assert.equal(findings[1].rule, 'no-console');
  });

  test('handles empty stdout', () => {
    assert.deepEqual(parseEslintOutput(''), []);
    assert.deepEqual(parseEslintOutput('   '), []);
  });

  test('handles file with no messages', () => {
    const fixture = JSON.stringify([{ filePath: path.resolve('src/ok.js'), messages: [] }]);
    assert.deepEqual(parseEslintOutput(fixture), []);
  });

  test('flags fixable findings', () => {
    const fixture = JSON.stringify([
      { filePath: path.resolve('a.js'), messages: [{ ruleId: 'prefer-const', line: 1, message: 'm', fix: { range: [0, 3] } }] },
    ]);
    assert.equal(parseEslintOutput(fixture)[0].fixable, true);
  });

  test('falls back to unknown rule when ruleId is null (non-fatal)', () => {
    const fixture = JSON.stringify([
      { filePath: path.resolve('a.js'), messages: [{ ruleId: null, line: 1, message: 'weird thing' }] },
    ]);
    assert.equal(parseEslintOutput(fixture)[0].rule, 'unknown');
  });

  test('promotes fatal parse/config errors to fatal-parse-error rule', () => {
    // ESLint emits { fatal: true, ruleId: null, severity: 2 } when it cannot parse a file.
    // Without promotion these fall through to LOW CODE_SMELL (the eslint _default) and
    // hide real breakage — they must surface as HIGH.
    const fixture = JSON.stringify([
      { filePath: path.resolve('a.js'), messages: [{ fatal: true, ruleId: null, severity: 2, line: 1, message: 'Parsing error: Unexpected token' }] },
    ]);
    const findings = parseEslintOutput(fixture);
    assert.equal(findings[0].rule, 'fatal-parse-error');
  });
});

describe('parseRuffOutput', () => {
  test('parses ruff JSON', () => {
    const fixture = JSON.stringify([
      {
        filename: path.resolve('pkg/foo.py'),
        code: 'F401',
        message: "'os' imported but unused",
        location: { row: 3, column: 1 },
        end_location: { row: 3, column: 10 },
        fix: null,
      },
      {
        filename: path.resolve('pkg/bar.py'),
        code: 'E722',
        message: 'do not use bare except',
        location: { row: 15, column: 4 },
      },
    ]);
    const findings = parseRuffOutput(fixture);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].rule, 'F401');
    assert.equal(findings[0].line, 3);
    assert.ok(findings[0].file.endsWith('pkg/foo.py'));
    assert.equal(findings[1].rule, 'E722');
    assert.equal(findings[1].line, 15);
  });

  test('handles empty output', () => {
    assert.deepEqual(parseRuffOutput(''), []);
    assert.deepEqual(parseRuffOutput('[]'), []);
  });

  test('detects fixable flag', () => {
    const fixture = JSON.stringify([
      { filename: 'a.py', code: 'F401', message: 'x', location: { row: 1 }, fix: { applicability: 'safe' } },
    ]);
    assert.equal(parseRuffOutput(fixture)[0].fixable, true);
  });
});

describe('parseTscOutput', () => {
  test('parses tsc --pretty false error lines', () => {
    const fixture = [
      "src/foo.ts(10,5): error TS2304: Cannot find name 'foo'.",
      "src/bar.ts(42,12): error TS2322: Type 'string' is not assignable to type 'number'.",
      "src/bar.ts(43,1): error TS7006: Parameter 'x' implicitly has an 'any' type.",
    ].join('\n');
    const findings = parseTscOutput(fixture);
    assert.equal(findings.length, 3);
    assert.equal(findings[0].rule, 'TS2304');
    assert.equal(findings[0].line, 10);
    assert.equal(findings[0].column, 5);
    assert.equal(findings[0].file, 'src/foo.ts');
    assert.match(findings[0].message, /Cannot find name/);
    assert.equal(findings[1].rule, 'TS2322');
    assert.equal(findings[2].rule, 'TS7006');
  });

  test('ignores non-matching lines', () => {
    const fixture = 'Some info\nAnother line without location\n\n';
    assert.deepEqual(parseTscOutput(fixture), []);
  });

  test('normalizes backslash paths to forward slashes', () => {
    const fixture = "src\\nested\\x.ts(1,1): error TS2304: Cannot find name 'x'.";
    assert.equal(parseTscOutput(fixture)[0].file, 'src/nested/x.ts');
  });
});

describe('parseFlake8PylintOutput', () => {
  test('parses pylint-format lines', () => {
    const fixture = [
      'src/foo.py:10: [F401] imported but unused',
      'src/bar.py:22: [E722] do not use bare except',
    ].join('\n');
    const findings = parseFlake8PylintOutput(fixture);
    assert.equal(findings.length, 2);
    assert.equal(findings[0].rule, 'F401');
    assert.equal(findings[0].line, 10);
    assert.equal(findings[1].rule, 'E722');
  });
});

// ── Normalization ───────────────────────────────────────────────────────────

describe('normalizeExternalFinding', () => {
  const result = { toolId: 'eslint', toolKind: 'linter', status: 'ok' };
  const raw = { file: 'src/foo.js', line: 10, rule: 'no-undef', message: 'x is not defined', fixable: false };

  test('produces a FindingSchema-shaped object with classification', () => {
    const f = normalizeExternalFinding(raw, result, 1);
    assert.equal(f.id, 'T1');
    assert.equal(f.severity, 'HIGH'); // no-undef is HIGH BUG
    assert.equal(f.section, 'src/foo.js:10');
    assert.equal(f.is_mechanical, true);
    assert.equal(f.classification.sourceKind, 'LINTER');
    assert.equal(f.classification.sourceName, 'eslint');
    assert.equal(f.classification.sonarType, 'BUG');
  });

  test('passes ProducerFindingSchema validation (classification required)', () => {
    const f = normalizeExternalFinding(raw, result, 1);
    const parsed = ProducerFindingSchema.safeParse(f);
    assert.equal(parsed.success, true, parsed.error?.message);
  });

  test('maps typeChecker toolKind to TYPE_CHECKER sourceKind', () => {
    const tsResult = { toolId: 'tsc', toolKind: 'typeChecker', status: 'ok' };
    const tsRaw = { file: 'a.ts', line: 1, rule: 'TS2304', message: 'x', fixable: false };
    const f = normalizeExternalFinding(tsRaw, tsResult, 1);
    assert.equal(f.classification.sourceKind, 'TYPE_CHECKER');
    assert.equal(f.classification.sourceName, 'tsc');
  });

  test('unknown rules fall back to tool _default', () => {
    const f = normalizeExternalFinding(
      { ...raw, rule: 'totally-fake-rule' },
      result,
      1
    );
    assert.equal(f.severity, 'LOW'); // eslint _default
    assert.equal(f.classification.sonarType, 'CODE_SMELL');
  });

  test('truncates overlong detail to 600 chars', () => {
    const longMsg = 'x'.repeat(1000);
    const f = normalizeExternalFinding({ ...raw, message: longMsg }, result, 1);
    assert.equal(f.detail.length, 600);
  });
});

describe('normalizeToolResults', () => {
  test('skips non-ok results', () => {
    const results = [
      { status: 'ok', toolId: 'eslint', toolKind: 'linter', findings: [{ file: 'a.js', line: 1, rule: 'no-undef', message: 'x', fixable: false }] },
      { status: 'no_tool', toolId: 'tsc', toolKind: 'typeChecker', findings: [] },
      { status: 'failed', toolId: 'ruff', toolKind: 'linter', findings: [{ file: 'a.py', line: 1, rule: 'F401', message: 'x', fixable: false }] },
    ];
    const normalized = normalizeToolResults(results);
    assert.equal(normalized.length, 1);
    assert.equal(normalized[0].classification.sourceName, 'eslint');
  });

  test('assigns sequential T-prefixed IDs across results', () => {
    const results = [
      { status: 'ok', toolId: 'eslint', toolKind: 'linter', findings: [
        { file: 'a.js', line: 1, rule: 'no-undef', message: 'x', fixable: false },
        { file: 'b.js', line: 2, rule: 'no-console', message: 'y', fixable: false },
      ] },
      { status: 'ok', toolId: 'ruff', toolKind: 'linter', findings: [
        { file: 'a.py', line: 1, rule: 'F401', message: 'z', fixable: false },
      ] },
    ];
    const normalized = normalizeToolResults(results);
    assert.deepEqual(normalized.map(f => f.id), ['T1', 'T2', 'T3']);
  });
});

// ── formatLintSummary ───────────────────────────────────────────────────────

describe('formatLintSummary', () => {
  const makeFinding = (severity, rule, detail = 'msg') => ({
    id: 'T1', severity, category: `[${rule}]`, section: 'x.js:1', detail, principle: rule,
  });

  test('returns empty string for empty input', () => {
    assert.equal(formatLintSummary([]), '');
  });

  test('lists findings directly when set is small', () => {
    const findings = [
      makeFinding('LOW', 'no-unused-vars', 'x unused'),
      makeFinding('LOW', 'no-console', 'console.log'),
    ];
    const out = formatLintSummary(findings);
    assert.match(out, /no-unused-vars/);
    assert.match(out, /Do NOT re-raise/);
  });

  test('summarizes by rule when set is large', () => {
    const findings = Array.from({ length: 50 }, (_, i) =>
      makeFinding(i % 3 === 0 ? 'HIGH' : 'LOW', i % 2 ? 'no-unused-vars' : 'no-console')
    );
    const out = formatLintSummary(findings);
    assert.match(out, /Summary/);
    assert.match(out, /Top rules/);
    assert.match(out, /no-unused-vars: \d+x/);
  });

  test('output stays within budget for large sets', () => {
    const findings = Array.from({ length: 500 }, (_, i) => makeFinding('LOW', `rule-${i}`));
    const out = formatLintSummary(findings, 2000);
    assert.ok(out.length <= 2000 * 4 + 500, `output ${out.length} exceeds budget`);
  });
});

// ── runTool (mocked execFileSync) ───────────────────────────────────────────

describe('runTool with mocked execFileSync', () => {
  beforeEach(() => {
    // default: deny everything; individual tests override
    setExecFileSync(() => { throw new Error('not mocked'); });
  });
  afterEach(() => resetExecFileSync());

  const eslintConfig = {
    id: 'eslint',
    kind: 'linter',
    command: 'npx',
    args: ['eslint', '--format', 'json', '.'],
    scope: 'project',
    availabilityProbe: ['npx', ['eslint', '--version']],
    parser: 'parseEslintOutput',
  };

  test('status=ok when tool runs successfully', () => {
    const fixture = JSON.stringify([
      { filePath: path.resolve('src/foo.js'), messages: [{ ruleId: 'no-unused-vars', line: 1, message: 'x' }] },
    ]);
    setExecFileSync((cmd, args) => {
      // availability probe vs actual invocation — use args to distinguish
      if (args.includes('--version')) return 'v8.0.0';
      return fixture;
    });
    const result = runTool(eslintConfig, ['src/foo.js'], 'js');
    assert.equal(result.status, 'ok');
    assert.equal(result.findings.length, 1);
    assert.equal(result.toolId, 'eslint');
    assert.equal(result.toolKind, 'linter');
  });

  test('status=no_tool when availability probe fails (no fallback)', () => {
    setExecFileSync(() => { throw new Error('ENOENT'); });
    const result = runTool(eslintConfig, ['src/foo.js'], 'js');
    assert.equal(result.status, 'no_tool');
    assert.equal(result.findings.length, 0);
  });

  test('falls back to fallback tool when primary unavailable', () => {
    const withFallback = {
      ...eslintConfig,
      id: 'ruff',
      availabilityProbe: ['ruff', ['--version']],
      parser: 'parseRuffOutput',
      fallback: {
        id: 'flake8',
        kind: 'linter',
        command: 'flake8',
        args: ['--format', 'pylint', '.'],
        availabilityProbe: ['flake8', ['--version']],
        parser: 'parseFlake8PylintOutput',
      },
    };
    let firstCalled = false;
    setExecFileSync((cmd) => {
      if (cmd === 'ruff') { firstCalled = true; throw new Error('ENOENT'); }
      if (cmd === 'flake8') {
        // availability probe succeeds; actual invocation returns no findings
        return '';
      }
      throw new Error('unexpected command: ' + cmd);
    });
    const result = runTool(withFallback, ['a.py'], 'py');
    assert.ok(firstCalled);
    assert.equal(result.toolId, 'flake8');
    assert.equal(result.status, 'ok');
  });

  test('parses stdout on non-zero exit (findings present case)', () => {
    const fixture = JSON.stringify([
      { filePath: path.resolve('src/x.js'), messages: [{ ruleId: 'no-undef', line: 1, message: 'x' }] },
    ]);
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      const err = new Error('tool exited 1');
      err.status = 1;
      err.stdout = Buffer.from(fixture);
      err.stderr = Buffer.from('');
      throw err;
    });
    const result = runTool(eslintConfig, ['src/x.js'], 'js');
    assert.equal(result.status, 'ok');
    assert.equal(result.findings.length, 1);
  });

  test('post-filters findings to audited file set', () => {
    const fixture = JSON.stringify([
      { filePath: path.resolve('src/in-scope.js'), messages: [{ ruleId: 'no-undef', line: 1, message: 'x' }] },
      { filePath: path.resolve('src/out-of-scope.js'), messages: [{ ruleId: 'no-undef', line: 1, message: 'x' }] },
    ]);
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      return fixture;
    });
    const result = runTool(eslintConfig, ['src/in-scope.js'], 'js');
    assert.equal(result.status, 'ok');
    assert.equal(result.findings.length, 1);
    assert.ok(result.findings[0].file.endsWith('src/in-scope.js'));
  });

  test('status=timeout on ETIMEDOUT', () => {
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      const err = new Error('timeout');
      err.code = 'ETIMEDOUT';
      throw err;
    });
    const result = runTool(eslintConfig, ['src/foo.js'], 'js');
    assert.equal(result.status, 'timeout');
  });

  test('status=failed for unknown parser', () => {
    const bad = { ...eslintConfig, parser: 'parseNonExistent' };
    setExecFileSync((cmd, args) => 'v8.0.0');
    const result = runTool(bad, ['src/foo.js'], 'js');
    assert.equal(result.status, 'failed');
  });
});

// ── runTool with scopeToFiles (per-file invocation instead of whole-repo) ───

describe('runTool with scopeToFiles', () => {
  beforeEach(() => {
    setExecFileSync(() => { throw new Error('not mocked'); });
    setExistsSync(() => true); // default: everything exists
  });
  afterEach(() => {
    resetExecFileSync();
    resetExistsSync();
  });

  const scopedEslintConfig = {
    id: 'eslint',
    kind: 'linter',
    command: 'npx',
    args: ['eslint', '--format', 'json', '--no-error-on-unmatched-pattern', '.'],
    scope: 'project',
    scopeToFiles: true,
    availabilityProbe: ['npx', ['eslint', '--version']],
    parser: 'parseEslintOutput',
  };

  test('invokes with -- separator + audited files instead of the whole-repo "."', () => {
    let capturedArgs = null;
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      capturedArgs = args;
      return '[]';
    });
    runTool(scopedEslintConfig, ['a.js', '-rf.js'], 'js');
    assert.deepEqual(
      capturedArgs.slice(-3),
      ['--', 'a.js', '-rf.js'],
    );
    assert.ok(!capturedArgs.includes('.'), 'the whole-repo "." positional must not survive scoping');
  });

  test('drops deleted files (not on disk) instead of passing them to the tool', () => {
    setExistsSync((f) => f !== 'deleted.js');
    let capturedArgs = null;
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      capturedArgs = args;
      return '[]';
    });
    runTool(scopedEslintConfig, ['a.js', 'deleted.js'], 'js');
    assert.deepEqual(capturedArgs.slice(-2), ['--', 'a.js']);
  });

  test('skips invocation entirely when every audited file is deleted', () => {
    setExistsSync(() => false);
    let invoked = false;
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      invoked = true;
      return '[]';
    });
    const result = runTool(scopedEslintConfig, ['deleted.js'], 'js');
    assert.equal(result.status, 'no_tool');
    assert.equal(result.findings.length, 0);
    assert.equal(invoked, false, 'execFileSync must not run the tool with an empty scoped file set');
  });

  test('throws a clear error above the scoping ceiling instead of risking E2BIG', () => {
    setExecFileSync((cmd, args) => (args.includes('--version') ? 'v8.0.0' : '[]'));
    const tooMany = Array.from({ length: 2001 }, (_, i) => `f${i}.js`);
    assert.throws(
      () => runTool(scopedEslintConfig, tooMany, 'js'),
      /2000-file scoping ceiling/,
    );
  });

  test('a non-scoped tool (tsc) still runs project-wide, unaffected', () => {
    const tscConfig = {
      id: 'tsc',
      kind: 'typeChecker',
      command: 'npx',
      args: ['tsc', '--noEmit', '--pretty', 'false'],
      scope: 'project',
      availabilityProbe: ['npx', ['tsc', '--version']],
      parser: 'parseTscOutput',
    };
    let capturedArgs = null;
    setExecFileSync((cmd, args) => {
      if (args.includes('--version')) return 'v8.0.0';
      capturedArgs = args;
      return '';
    });
    runTool(tscConfig, ['a.ts'], 'ts');
    assert.deepEqual(capturedArgs, ['tsc', '--noEmit', '--pretty', 'false']);
  });
});

// ── semanticId dispatch (Phase C) ────────────────────────────────────────────

describe('semanticId dispatch on classification.sourceKind', () => {
  test('tool finding uses file:rule:message identity', () => {
    const toolFinding = {
      category: '[BUG] no-undef',
      section: 'src/foo.js:10',
      detail: "'x' is not defined",
      principle: 'no-undef',
      classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'LINTER', sourceName: 'eslint' },
    };
    const id1 = semanticId(toolFinding);
    // Line-number drift should NOT change identity
    const shifted = { ...toolFinding, section: 'src/foo.js:47' };
    const id2 = semanticId(shifted);
    assert.equal(id1, id2, 'tool finding identity must be stable across line-number shifts');
  });

  test('tool finding with different rule gets different id', () => {
    const a = {
      category: '[BUG] no-undef', section: 'src/foo.js:10', detail: 'x',
      principle: 'no-undef',
      classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'LINTER', sourceName: 'eslint' },
    };
    const b = { ...a, principle: 'no-console', category: '[CODE_SMELL] no-console' };
    assert.notEqual(semanticId(a), semanticId(b));
  });

  test('TYPE_CHECKER kind also uses file:rule:message identity', () => {
    const a = {
      category: '[BUG] TS2304', section: 'x.ts:5', detail: 'Cannot find name foo',
      principle: 'TS2304',
      classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'TYPE_CHECKER', sourceName: 'tsc' },
    };
    const id = semanticId(a);
    assert.equal(typeof id, 'string');
    assert.equal(id.length, 8);
  });

  test('model finding (no classification) uses content-hash identity', () => {
    const modelFinding = { category: 'DRY', section: 'src/x.js', detail: 'duplicate logic' };
    const id1 = semanticId(modelFinding);
    // Content change → different id
    const id2 = semanticId({ ...modelFinding, detail: 'totally different' });
    assert.notEqual(id1, id2);
  });

  test('model finding with MODEL sourceKind still uses content-hash', () => {
    const modelFinding = {
      category: 'DRY', section: 'src/x.js', detail: 'duplicate logic',
      classification: { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'gpt-5.4' },
    };
    const id1 = semanticId(modelFinding);
    const id2 = semanticId({ ...modelFinding, detail: 'completely different issue' });
    assert.notEqual(id1, id2, 'MODEL findings should use content hash (vary with detail)');
  });

  test('same defect produces DIFFERENT ids for tool vs model source (known limitation)', () => {
    const tool = {
      category: '[BUG] no-undef', section: 'src/foo.js:10', detail: "'x' is not defined",
      principle: 'no-undef',
      classification: { sonarType: 'BUG', effort: 'EASY', sourceKind: 'LINTER', sourceName: 'eslint' },
    };
    const model = {
      category: 'Undefined reference', section: 'src/foo.js:10', detail: "'x' is not defined",
    };
    assert.notEqual(semanticId(tool), semanticId(model), 'tool + model findings are tracked separately by design');
  });
});
