/**
 * @fileoverview Run-level propagation of per-pass REDUCE degradation.
 *
 * `reduceStatus` was emitted on the PASS result and dropped at the merge:
 * `mergedResult._executionMeta` was built from suppression state alone, so a
 * degraded REDUCE reached the run only as prose inside `overall_reasoning`.
 * Nothing else carried it — `mapReduceFailureReason` flags only
 * `total_failure` and partial-with-zero-findings, so a pass whose REDUCE
 * parse-errored while its raw MAP findings survived reports `succeeded` with a
 * null `failureReason`.
 *
 * Separate FILE, not a describe block in the harness, because triggering
 * map-reduce cheaply needs `OPENAI_AUDIT_HIGH_REASONING_MAP_REDUCE_THRESHOLD=0`
 * and `openaiConfig` is a module-load snapshot — the override has to be in place
 * before the first import, and setting it inside the shared harness would push
 * every pass there through map-reduce.
 *
 * Companion to tests/legacy-production-audit-hardening.test.mjs, which proves
 * the pass-level statuses themselves.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env.AUDIT_EXPORTS_FOR_TESTS = '1';
// 1 file > 0 triggers shouldMapReduceHighReasoning, so the existing
// single-frontend-file fixture exercises the map-reduce path with no new
// fixtures. safeInt() parses '0' as 0 (only NaN falls back), so this really
// does take effect.
process.env.OPENAI_AUDIT_HIGH_REASONING_MAP_REDUCE_THRESHOLD = '0';
process.env.MODEL_CATALOG_REFRESH = 'skip';
process.env.LEARNING_DISABLE = '1';
process.env.AUDIT_DB_URL = '';
process.env.AUDIT_NO_PREFLIGHT = '1';

const audit = await import('../scripts/openai-audit.mjs');
const lpa = await import('../scripts/lib/audit/legacy-production-audit.mjs');
const { runMultiPassCodeAudit } = audit.__testExports;
const { collectReducePassStatuses } = lpa.__testExports;
const { ReduceStatus, ExecutionMetaSchema } = await import('../scripts/lib/schemas.mjs');

const FIXTURE_DIR = 'tests/fixtures/harness-plan';
const BACKEND_FILE = `${FIXTURE_DIR}/src/service.mjs`;
const FRONTEND_FILE = `${FIXTURE_DIR}/src/components/Widget.jsx`;
const PLAN_CONTENT = `# Harness Fixture Plan\n\nImplement \`${BACKEND_FILE}\` and \`${FRONTEND_FILE}\`.\n`;

const BASE_OPTS = {
  passFilter: ['structure', 'wiring', 'backend', 'frontend', 'sustainability', 'quickfix'],
  noTools: true, noDebtLedger: true, scopeMode: 'plan', noLedger: true,
};

const CLASSIFICATION = { sonarType: 'CODE_SMELL', effort: 'EASY', sourceKind: 'MODEL', sourceName: 'test-stub' };
const mkFinding = (o = {}) => ({
  id: 'H1', severity: 'HIGH', category: 'Test', section: `${FRONTEND_FILE}:1`, detail: 'a finding',
  risk: 'risk', recommendation: 'rec', is_quick_fix: false, is_mechanical: false, principle: 'p',
  classification: CLASSIFICATION, ...o,
});
const OK_USAGE = {
  input_tokens: 10, output_tokens: 5,
  prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 1 },
};
const ok = (parsed) => ({ status: 'completed', output: [], usage: OK_USAGE, output_parsed: parsed });

const EMPTY = {
  structure_pass: { pass_name: 'structure', files_planned: 2, files_found: 2, files_missing: 0, missing_files: [], export_mismatches: [], findings: [], summary: 'ok' },
  wiring_pass: { pass_name: 'wiring', wiring_issues: [], findings: [], summary: 'ok' },
  backend_pass: { pass_name: 'backend', findings: [], quick_fix_warnings: [], summary: 'ok' },
  sustainability_pass: { pass_name: 'sustainability', findings: [], dead_code: [], quick_fix_warnings: [], summary: 'ok' },
  quickfix_pass: { pass_name: 'quickfix', findings: [], summary: 'ok' },
};

/**
 * Frontend goes through map-reduce (`map_frontend_*` then `reduce_frontend`);
 * `reduceResponse` decides what the REDUCE call does. Everything else answers
 * normally, so only the frontend pass degrades — which is also what makes the
 * per-pass KEY meaningful rather than a single run-wide flag.
 */
function makeStub(reduceResponse) {
  return {
    responses: {
      parse: async (params) => {
        const name = params?.text?.format?.name;
        if (name?.startsWith('reduce_')) return reduceResponse();
        if (name?.startsWith('map_')) {
          return ok({ pass_name: 'frontend', quick_fix_warnings: [], summary: 'ok',
            findings: [mkFinding({ detail: 'a finding that survived MAP' })] });
        }
        if (EMPTY[name]) return ok(EMPTY[name]);
        throw new Error(`unexpected schemaName: ${name}`);
      },
    },
  };
}

describe('run-level _executionMeta carries per-pass REDUCE degradation', () => {
  it('a pass whose REDUCE parse-errored surfaces on the RUN result, keyed by pass', async () => {
    const result = await runMultiPassCodeAudit(
      // `findings` non-array makes llm-helpers raise LlmError{category:'schema'}.
      makeStub(() => ok({ pass_name: 'frontend', findings: 'not-an-array', quick_fix_warnings: [], summary: 's' })),
      PLAN_CONTENT, '', false, null, '', BASE_OPTS,
    );
    assert.ok(ExecutionMetaSchema.safeParse(result._executionMeta).success,
      `run block must satisfy its schema, got ${JSON.stringify(result._executionMeta)}`);
    assert.equal(result._executionMeta?.reducePassStatuses?.frontend, ReduceStatus.PARSE_ERROR);
  });

  it('negative control — a clean run carries no reducePassStatuses', async () => {
    const result = await runMultiPassCodeAudit(
      makeStub(() => ok({ pass_name: 'frontend', findings: [mkFinding({ detail: 'reduced' })], quick_fix_warnings: [], summary: 'reduced' })),
      PLAN_CONTENT, '', false, null, '', BASE_OPTS,
    );
    assert.equal(result._executionMeta?.reducePassStatuses, undefined,
      'absence must keep meaning "no map-reduce pass degraded" — guards an always-on key');
  });
});

describe('collectReducePassStatuses', () => {
  const entry = (name, reduceStatus) => ({
    name, _result: { result: reduceStatus ? { _executionMeta: { reduceStatus } } : {} },
  });

  it('returns undefined rather than {} when nothing degraded', () => {
    assert.equal(collectReducePassStatuses([entry('backend'), entry('frontend')]), undefined);
    assert.equal(collectReducePassStatuses([]), undefined);
    assert.equal(collectReducePassStatuses(undefined), undefined);
  });

  it('keys each degraded pass separately instead of collapsing them', () => {
    // The reason this is a map: two passes can degrade for DIFFERENT reasons in
    // one run, and any single-value field has to discard one of them.
    assert.deepEqual(
      collectReducePassStatuses([
        entry('backend', ReduceStatus.PARSE_ERROR),
        entry('frontend', ReduceStatus.TIMEOUT),
        entry('sustainability'),
      ]),
      { backend: ReduceStatus.PARSE_ERROR, frontend: ReduceStatus.TIMEOUT },
    );
  });

  it('tolerates passes that never ran or produced no result', () => {
    assert.equal(
      collectReducePassStatuses([{ name: 'skipped-pass' }, { name: 'no-result', _result: null }]),
      undefined,
    );
  });
});
