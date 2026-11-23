/**
 * @fileoverview Structured line anchors on audit findings
 * (docs/plans/structured-finding-lines.md): the producer schema, the prompt block, the resolver, its
 * snapshot contract, the identity pin, and the end-to-end positive control through the REAL `assembleFindings`
 * and `computeRoundSignals` against a deterministic temp git repo.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';

const {
  ProducerFindingSchema, PersistedFindingSchema, zodToGeminiSchema,
} = await import('../scripts/lib/schemas.mjs');
const { LINE_ANCHOR_BLOCK } = await import('../scripts/lib/prompt-seeds.mjs');
const { FinalReviewFindingSchema, GeminiFinalReviewJsonSchema } = await import('../scripts/lib/final-review/output-schemas.mjs');
const { ShadowPassSchema } = await import('../scripts/lib/audit-shadow.mjs');
const {
  locateQuote, resolveFindingLines, createSnapshotReader, applyLineResolution, llmPassPrefixes, NON_PRODUCER_PASSES,
} = await import('../scripts/lib/audit/finding-lines.mjs');
const { semanticId } = await import('../scripts/lib/findings.mjs');
const { generateTopicId, populateFindingMetadata } = await import('../scripts/lib/ledger.mjs');
const { assembleFindings } = await import('../scripts/lib/audit/finding-assembly.mjs');
const { computeRoundSignals, makeGitRunner, citedLocation } = await import('../scripts/lib/audit/round-signals.mjs');
const { minimalFinalizationData } = await import('./helpers/multi-pass-audit-fixtures.mjs');

const BASE_FINDING = {
  id: 'H1', severity: 'HIGH', category: 'Test', section: 'src/a.mjs', detail: 'swallows the error',
  risk: 'r', recommendation: 'x', is_quick_fix: false, is_mechanical: false, principle: 'Test',
  classification: { sonarType: 'BUG', effort: 'MEDIUM', sourceKind: 'MODEL', sourceName: 'test' },
  is_reopened: false, importance: 'important', pre_existing: false, newly_reachable: false,
};

describe('emitted schema (the contract the provider sees), not the Zod source', () => {
  it('lineQuote is a nullable, optional string capped at 400 on the producer schema', () => {
    const j = z.toJSONSchema(ProducerFindingSchema);
    assert.ok(j.properties.lineQuote, 'lineQuote is a property');
    assert.equal(j.required.includes('lineQuote'), false, 'not forced required in the raw JSON schema');
    assert.deepEqual(j.properties.lineQuote.anyOf.map((a) => a.type).sort(), ['null', 'string']);
    assert.equal(j.properties.lineQuote.anyOf.find((a) => a.type === 'string').maxLength, 400);
    assert.equal('lineStart' in j.properties, false, 'the model can never emit a line number');
    assert.equal('lineEnd' in j.properties, false);
  });

  it('a producer finding parses with the key absent, null, or a string; 400 chars ok, 401 rejected', () => {
    assert.ok(ProducerFindingSchema.safeParse(BASE_FINDING).success);
    assert.ok(ProducerFindingSchema.safeParse({ ...BASE_FINDING, lineQuote: null }).success);
    assert.ok(ProducerFindingSchema.safeParse({ ...BASE_FINDING, lineQuote: 'x'.repeat(400) }).success);
    assert.equal(ProducerFindingSchema.safeParse({ ...BASE_FINDING, lineQuote: 'x'.repeat(401) }).success, false);
  });

  it('the persisted schema keeps the three fields and still accepts a row without them', () => {
    const old = PersistedFindingSchema.parse(BASE_FINDING);
    assert.equal('lineStart' in old, false);
    const withLines = PersistedFindingSchema.parse({ ...BASE_FINDING, lineQuote: 'a', lineStart: 3, lineEnd: 4 });
    assert.deepEqual([withLines.lineQuote, withLines.lineStart, withLines.lineEnd], ['a', 3, 4]);
    assert.ok(PersistedFindingSchema.safeParse({ ...BASE_FINDING, lineStart: null, lineEnd: null }).success);
    assert.equal(PersistedFindingSchema.safeParse({ ...BASE_FINDING, lineStart: 0 }).success, false);
  });

  it('OpenAI strict mode forces the key into `required` (the model answers null), Gemini keeps it optional', async () => {
    const { zodTextFormat } = await import('openai/helpers/zod');
    const wrapped = z.object({ findings: z.array(ProducerFindingSchema) });
    const item = zodTextFormat(wrapped, 'x').schema.properties.findings.items;
    assert.ok(item.required.includes('lineQuote'));
    assert.deepEqual(item.properties.lineQuote.anyOf.map((a) => a.type).sort(), ['null', 'string']);
    const g = zodToGeminiSchema(wrapped).properties.findings.items;
    assert.equal(g.required.includes('lineQuote'), false);
  });

  it('the final-review and shadow schemas are byte-identical in shape: lineQuote is omitted there', () => {
    assert.equal('lineQuote' in FinalReviewFindingSchema.shape, false);
    assert.equal(JSON.stringify(GeminiFinalReviewJsonSchema).includes('lineQuote'), false, 'the Gemini final gate schema carries no anyOf field');
    assert.equal('lineQuote' in ShadowPassSchema.shape.findings.element.shape, false);
  });
});

describe('prose-to-code seam: the prompt asks only for what the emitted schema can carry', () => {
  it('LINE_ANCHOR_BLOCK names lineQuote (a real producer property) and never asks for a line number field', () => {
    assert.ok(LINE_ANCHOR_BLOCK.includes('lineQuote'));
    assert.ok(Object.keys(z.toJSONSchema(ProducerFindingSchema).properties).includes('lineQuote'));
    assert.equal(/lineStart|lineEnd/.test(LINE_ANCHOR_BLOCK), false);
    assert.ok(/AFTER THE CHANGE/.test(LINE_ANCHOR_BLOCK) && /never include a diff marker/.test(LINE_ANCHOR_BLOCK));
  });

  it('it is appended at exactly the ProducerFindingSchema pass call sites, not the architecture/duplication/adjacency ones', () => {
    const src = fs.readFileSync(new URL('../scripts/lib/audit/legacy-production-audit.mjs', import.meta.url), 'utf8');
    assert.equal((src.match(/focusBlock: lineFocusBlock,/g) || []).length, 13, 'structure, wiring, 6 backend, 2 frontend, 2 sustainability, quickfix');
    assert.equal((src.match(/^\s*focusBlock,/gm) || []).length, 2, 'only the duplication and adjacency wave calls keep a bare focusBlock');
    for (const fn of ['runArchitecturePass', 'runDuplicationPass', 'runAdjacencyPass']) {
      const at = src.indexOf(`await ${fn}(`);
      assert.ok(at > 0, fn);
      const call = src.slice(at, at + 260);
      assert.ok(/focusBlock[,\s]/.test(call) && !/lineFocusBlock/.test(call), `${fn} keeps the plain focusBlock`);
    }
  });

  it('PASS_PROMPTS seeds are untouched by the line anchor', async () => {
    const { PASS_PROMPTS } = await import('../scripts/lib/prompt-seeds.mjs');
    for (const p of Object.values(PASS_PROMPTS)) assert.equal(p.includes('lineQuote'), false);
  });
});

describe('locateQuote — exact, unique-or-null', () => {
  const lines = ['const a = 1;', '  if (x) {', '    return `  pad`;', '  }', 'const a = 1;', 'tail'];
  it('anchors a unique single line and a unique multi-line quote', () => {
    assert.deepEqual(locateQuote(lines, '  if (x) {'), { status: 'anchored', lineStart: 2, lineEnd: 2 });
    assert.deepEqual(locateQuote(lines, '  if (x) {\n    return `  pad`;'), { status: 'anchored', lineStart: 2, lineEnd: 3 });
  });
  it('CRLF in the quote is folded; a trailing newline is not a line', () => {
    assert.deepEqual(locateQuote(lines, '  if (x) {\r\n    return `  pad`;\r\n'), { status: 'anchored', lineStart: 2, lineEnd: 3 });
  });
  it('ambiguous and not-found are unlocated, never a guess', () => {
    assert.equal(locateQuote(lines, 'const a = 1;').status, 'ambiguous');
    assert.equal(locateQuote(lines, 'missing line').status, 'not-found');
  });
  it('EXACT: a dropped indent, trailing space or different internal whitespace does not match', () => {
    assert.equal(locateQuote(lines, 'if (x) {').status, 'not-found', 'indentation dropped');
    assert.equal(locateQuote(lines, '  if (x) { ').status, 'not-found', 'trailing space');
    assert.equal(locateQuote(lines, '    return `    pad`;').status, 'not-found', 'whitespace inside a template literal differs');
  });
  it('a standalone CR is NOT a line break (git counts LF-delimited lines); CRLF still is', () => {
    // CRLF folds, a lone CR does not: 'a<CR>b' is ONE file line, so a quote of 'b' must not anchor to a phantom line 2
    const CR = String.fromCharCode(13);
    assert.equal(locateQuote([`a${CR}b`, 'c'], 'b').status, 'not-found');
    assert.deepEqual(locateQuote([`a${CR}b`, 'c'], `a${CR}b`), { status: 'anchored', lineStart: 1, lineEnd: 1 });
    assert.deepEqual(locateQuote(['x', 'y'], `x${CR}
y`), { status: 'anchored', lineStart: 1, lineEnd: 2 });
  });
  it('empty, blank, non-string and over-long quotes are no-quote', () => {
    for (const q of ['', '   ', '\n', null, undefined, 7, 'a\nb\nc\nd']) assert.equal(locateQuote(lines, q).status, 'no-quote', String(q));
  });
});

describe('snapshot contract + resolver + identity, against a real temp git repo', () => {
  let repo; let shaA; let shaB; let cwd0;
  const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  const v1 = ['export function f(a) {', '  const x = a + 1;', '  return x;', '}', '', 'export const KEEP = 1;', ''].join('\n');
  const v2 = ['export function f(a) {', '  const x = a + 2;', '  const y = x * 2;', '  return y;', '}', '', 'export const KEEP = 1;', ''].join('\n');

  before(() => {
    cwd0 = process.cwd();
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'finding-lines-'));
    git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'core.autocrlf', 'false');
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), v1);
    git('add', '.'); git('commit', '-q', '-m', 'v1'); shaA = git('rev-parse', 'HEAD');
    fs.writeFileSync(path.join(repo, 'src', 'a.mjs'), v2);
    git('commit', '-q', '-am', 'v2'); shaB = git('rev-parse', 'HEAD');
    process.chdir(repo);
  });
  after(() => { process.chdir(cwd0); fs.rmSync(repo, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  const finding = (extra = {}) => ({ ...BASE_FINDING, _primaryFile: 'src/a.mjs', _pass: 'Backend', ...extra });

  it('clean file at the audited commit: anchored with file-relative lines', () => {
    const reader = createSnapshotReader({ cwd: repo, auditedSha: shaB });
    assert.deepEqual(resolveFindingLines(finding({ lineQuote: '  const y = x * 2;' }), reader), { status: 'anchored', lineStart: 3, lineEnd: 3 });
  });

  it('a file dirty relative to the audited commit is `dirty`, a missing sha or blob is `no-basis`, a missing file `no-file`', () => {
    const reader = createSnapshotReader({ cwd: repo, auditedSha: shaA });
    assert.equal(resolveFindingLines(finding({ lineQuote: '  const y = x * 2;' }), reader).status, 'dirty', 'working tree is v2, audited commit is v1');
    assert.equal(resolveFindingLines(finding({ lineQuote: 'x' }), createSnapshotReader({ cwd: repo, auditedSha: null })).status, 'no-basis');
    assert.equal(resolveFindingLines(finding({ lineQuote: 'x' }), createSnapshotReader({ cwd: repo, auditedSha: 'f'.repeat(40) })).status, 'no-basis');
    assert.equal(resolveFindingLines(finding({ lineQuote: 'x', _primaryFile: 'src/nope.mjs' }), createSnapshotReader({ cwd: repo, auditedSha: shaB })).status, 'no-file');
    assert.equal(resolveFindingLines(finding({ lineQuote: 'x', _primaryFile: '../outside.mjs' }), createSnapshotReader({ cwd: repo, auditedSha: shaB })).status, 'no-file');
    assert.equal(resolveFindingLines(finding({ lineQuote: 'x', _primaryFile: undefined }), createSnapshotReader({ cwd: repo, auditedSha: shaB })).status, 'no-file');
  });

  it('only _primaryFile is searched: a quote that lives in another affected file is not-found', () => {
    fs.writeFileSync(path.join(repo, 'src', 'b.mjs'), 'export const ONLY_IN_B = 1;\n');
    const reader = createSnapshotReader({ cwd: repo, auditedSha: shaB });
    const r = resolveFindingLines(finding({ lineQuote: 'export const ONLY_IN_B = 1;', affectedFiles: ['src/a.mjs', 'src/b.mjs'] }), reader);
    assert.equal(r.status, 'not-found');
    fs.rmSync(path.join(repo, 'src', 'b.mjs'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('round-scoped reader: three findings on one file cause ONE read and ONE blob lookup; a new reader starts empty', () => {
    let shows = 0;
    const showText = (...a) => { shows++; return fs.readFileSync(path.join(repo, 'src', 'a.mjs'), 'utf8') && execFileSync('git', ['show', `${a[1]}:${a[2]}`], { cwd: repo }).toString(); };
    const reader = createSnapshotReader({ cwd: repo, auditedSha: shaB, showText });
    for (const q of ['  const x = a + 2;', '  const y = x * 2;', '  return y;']) assert.equal(resolveFindingLines(finding({ lineQuote: q }), reader).status, 'anchored');
    assert.equal(shows, 1);
    createSnapshotReader({ cwd: repo, auditedSha: shaB, showText }).read('src/a.mjs');
    assert.equal(shows, 2, 'a second round builds a fresh reader and re-checks');
  });

  it('applyLineResolution: sole writer for LLM-pass findings (replace on anchor, clear otherwise), tool/mechanical untouched, coverage line', () => {
    const reader = createSnapshotReader({ cwd: repo, auditedSha: shaB });
    const fs_ = [
      finding({ lineQuote: '  return y;', lineStart: 99, lineEnd: 120 }),            // stale pair is REPLACED
      finding({ lineQuote: null, lineStart: 7, lineEnd: 7 }),                       // no quote: stale pair CLEARED
      finding({ lineQuote: 'not in the file', lineStart: 5 }),                       // partial stale value CLEARED
      finding({ _pass: 'tool', lineQuote: '  return y;', lineStart: 1, lineEnd: 1 }), // tool finding untouched
      finding({ _pass: 'Duplication', lineStart: 2, lineEnd: 2 }),                  // mechanical wave untouched
    ];
    const prefixes = llmPassPrefixes([{ name: 'backend', _displayPrefix: 'Backend' }, { name: 'duplication', _displayPrefix: 'Duplication' }, { name: 'architecture', _displayPrefix: 'Architecture' }]);
    assert.deepEqual([...prefixes], ['Backend']);
    const out = applyLineResolution(fs_, { llmPrefixes: prefixes, reader });
    assert.deepEqual([fs_[0].lineStart, fs_[0].lineEnd], [4, 4]);
    assert.deepEqual([fs_[1].lineStart, fs_[1].lineEnd], [null, null]);
    assert.deepEqual([fs_[2].lineStart, fs_[2].lineEnd], [null, null]);
    assert.deepEqual([fs_[3].lineStart, fs_[3].lineEnd], [1, 1]);
    assert.deepEqual([fs_[4].lineStart, fs_[4].lineEnd], [2, 2]);
    assert.equal(out.total, 3);
    assert.match(out.line, /\[lines\] 3 findings: anchored 1, no-quote 1, not-found 1, ambiguous 0, dirty 0, no-basis 0, no-file 0/);
  });

  it('every static registry pass in finding-assembly is classified as producer or non-producer (a new pass must be classified)', async () => {
    const { PRODUCER_PASSES } = await import('../scripts/lib/audit/finding-lines.mjs');
    const src = fs.readFileSync(new URL('../scripts/lib/audit/finding-assembly.mjs', import.meta.url), 'utf8');
    const names = [...src.matchAll(/{ name: '([a-z-]+)', ran:/g)].map((m) => m[1]);
    assert.ok(names.length >= 10, 'found the registry entries');
    for (const n of names) assert.ok(PRODUCER_PASSES.includes(n) || NON_PRODUCER_PASSES.includes(n), n + ' is unclassified');
  });

  it('NON_PRODUCER_PASSES names the waves that cannot carry the field (quickfix is NOT one of them)', () => {
    assert.equal(NON_PRODUCER_PASSES.includes('quickfix'), false);
    assert.ok(['duplication', 'adjacency', 'architecture', 'orphan-introduced', 'event-wiring-symmetry'].every((n) => NON_PRODUCER_PASSES.includes(n)));
  });

  it('identity pin: semanticId, generateTopicId and the section/detail bytes are identical with and without the new fields', () => {
    const a = populateFindingMetadata({ ...BASE_FINDING }, 'Backend');
    const b = populateFindingMetadata({ ...BASE_FINDING, lineQuote: '  return y;', lineStart: 4, lineEnd: 4 }, 'Backend');
    assert.equal(semanticId(a), semanticId(b));
    assert.equal(generateTopicId(a), generateTopicId(b));
    assert.equal(a._hash, b._hash);
    // negative control: the pin can fail — changing a hashed field DOES change the id
    assert.notEqual(semanticId(a), semanticId({ ...BASE_FINDING, detail: 'something else' }));
  });

  it('END TO END: producer parse -> assembleFindings -> JSON round trip -> computeRoundSignals reopenRate measured', async () => {
    // Round 3 findings, as a provider response parsed by the real producer schema.
    const wire = [
      { ...BASE_FINDING, id: 'H1', lineQuote: '  const y = x * 2;', detail: 'changed line re-flagged' },     // inside the fix hunk (v1 -> v2)
      { ...BASE_FINDING, id: 'H2', lineQuote: 'export const KEEP = 1;', detail: 'unchanged line flagged' },  // outside every hunk
      { ...BASE_FINDING, id: 'H3', lineQuote: null, detail: 'plan level concern with no line' },            // no quote
    ].map((f) => ProducerFindingSchema.parse(f));
    const old = { ...BASE_FINDING, id: 'M9', detail: 'a row from before this change', severity: 'MEDIUM' };
    const data = minimalFinalizationData({
      ctx: { auditedSha: shaB },
      backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: [...wire, old], quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
    });
    const assembled = await assembleFindings(data);
    const byDetail = (d) => assembled.allFindings.find((f) => f.detail === d);
    assert.deepEqual([byDetail('changed line re-flagged').lineStart, byDetail('changed line re-flagged').lineEnd], [3, 3]);
    assert.deepEqual([byDetail('unchanged line flagged').lineStart], [7]);
    assert.equal(byDetail('plan level concern with no line').lineStart, null);
    assert.equal(byDetail('a row from before this change').lineStart, null, 'an old, quote-less row stays valid and unlocated');

    // persistence: serialise as a round result, reload, then compute the signal exactly as step-back-card does
    const reloaded = JSON.parse(JSON.stringify(assembled.allFindings));
    const parsed = reloaded.map((f) => PersistedFindingSchema.parse(f));
    assert.deepEqual(parsed.map((f) => f.lineStart), assembled.allFindings.map((f) => f.lineStart), 'the persisted schema does not strip the pair');
    const rounds = [
      { round: 2, auditedSha: shaA, findings: [] },
      { round: 3, auditedSha: shaB, findings: reloaded },
    ];
    const sig = computeRoundSignals({ round: 3, rounds, ledgerEntries: null, git: makeGitRunner(repo) });
    assert.equal(sig.signals.reopenRate.measured, true);
    assert.equal(sig.signals.reopenRate.located, 2);
    assert.equal(sig.signals.reopenRate.hits, 1, 'only the line inside the fix-range hunk counts');
    assert.equal(sig.signals.reopenRate.value, 0.5);
    // consumer contract unchanged: citedLocation reads the structured pair
    assert.deepEqual(citedLocation(byDetail('changed line re-flagged')).ranges, [[3, 3]]);
  });

  it('control: the same findings WITHOUT a quote leave reopenRate unmeasured (the pre-change state)', async () => {
    const wire = [{ ...BASE_FINDING, id: 'H1', detail: 'no quote given' }].map((f) => ProducerFindingSchema.parse(f));
    const assembled = await assembleFindings(minimalFinalizationData({
      ctx: { auditedSha: shaB }, backendPassNames: ['backend'],
      backendResults: [{ result: { pass_name: 'backend', findings: wire, quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
    }));
    const sig = computeRoundSignals({ round: 3, rounds: [{ round: 2, auditedSha: shaA, findings: [] }, { round: 3, auditedSha: shaB, findings: JSON.parse(JSON.stringify(assembled.allFindings)) }], ledgerEntries: null, git: makeGitRunner(repo) });
    assert.equal(sig.signals.reopenRate.measured, false);
    assert.match(sig.signals.reopenRate.reason, /cite no lines/);
  });

  it('dirty working tree at assembly: the quote is NOT anchored (no line the commit range could map)', async () => {
    fs.appendFileSync(path.join(repo, 'src', 'a.mjs'), '// local edit\n');
    try {
      const wire = [ProducerFindingSchema.parse({ ...BASE_FINDING, lineQuote: '  const y = x * 2;' })];
      const assembled = await assembleFindings(minimalFinalizationData({
        ctx: { auditedSha: shaB }, backendPassNames: ['backend'],
        backendResults: [{ result: { pass_name: 'backend', findings: wire, quick_fix_warnings: [] }, usage: {}, latencyMs: 0 }],
      }));
      assert.equal(assembled.allFindings[0].lineStart, null);
    } finally { git('checkout', '--', 'src/a.mjs'); }
  });
});

describe('historical positive control (needs the real commits)', () => {
  it('66b91739..c2d62f6b scripts/lib/llm-budget.mjs: a quote from a line INSIDE a real post-image hunk anchors and counts as a reopenRate hit; one outside does not', (t) => {
    const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
    const rev = (r) => { try { return execFileSync('git', ['rev-parse', '--verify', '--quiet', r + '^{commit}'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return null; } };
    const base = rev('66b91739'); const head = rev('c2d62f6b');
    if (!base || !head) {
      if (process.env.REQUIRE_HISTORICAL_RANGE === '1') assert.fail('historical commits absent and REQUIRE_HISTORICAL_RANGE=1');
      t.skip('skipped (objects absent): 66b91739 / c2d62f6b not in this checkout');
      return;
    }
    const FILE = 'scripts/lib/llm-budget.mjs';
    const lines = execFileSync('git', ['show', head + ':' + FILE], { cwd: root }).toString().split('\n');
    const hunks = execFileSync('git', ['diff', '-U0', base, head, '--', FILE], { cwd: root }).toString().split('\n')
      .map((l) => /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(l)).filter(Boolean)
      .map((m) => [Number(m[1]), Number(m[1]) + (m[2] === undefined ? 1 : Number(m[2])) - 1]).filter(([a, b]) => b >= a);
    assert.ok(hunks.length > 0, 'the range changes the file with non-empty post-image hunks');
    const inHunk = (n) => hunks.some(([a, b]) => n >= a && n <= b);
    const unique = (n) => lines[n - 1].trim() !== '' && lines.filter((x) => x === lines[n - 1]).length === 1;
    const inside = lines.map((_, k) => k + 1).find((n) => inHunk(n) && unique(n));
    const outside = lines.map((_, k) => k + 1).find((n) => !inHunk(n) && n < lines.length && unique(n));
    assert.ok(inside && outside, 'a unique line exists inside and outside the hunks');
    const mk = (n, detail) => ({ ...BASE_FINDING, id: 'H' + n, detail, _primaryFile: FILE, _pass: 'Backend', lineQuote: lines[n - 1] });
    const found = [mk(inside, 'inside'), mk(outside, 'outside')];
    // the file at HEAD of that range is not this checkout's working tree: resolve against the committed text directly
    const reader = { read: () => ({ status: 'ok', lines }) };
    for (const f of found) Object.assign(f, resolveFindingLines(f, reader));
    assert.deepEqual([found[0].lineStart, found[1].lineStart], [inside, outside]);
    assert.ok(inHunk(found[0].lineStart) && !inHunk(found[1].lineStart), 'the resolved line is the one inside the hunk bounds');
    const sig = computeRoundSignals({ round: 3, ledgerEntries: null, git: makeGitRunner(root), rounds: [{ round: 2, auditedSha: base, findings: [] }, { round: 3, auditedSha: head, findings: found.map(({ status, ...f }) => f) }] });
    assert.equal(sig.signals.reopenRate.measured, true);
    assert.equal(sig.signals.reopenRate.hits, 1, 'exactly the inside-hunk finding is a reopen hit');
    assert.equal(sig.signals.reopenRate.located, 2);
  });
});
