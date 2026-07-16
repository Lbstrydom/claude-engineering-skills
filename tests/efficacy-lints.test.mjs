/**
 * @fileoverview Tier-1 tests for the deterministic efficacy lints (Cluster A of the
 * GREEN ≠ REALIZED plan). Locks the audited contracts: per-rule status, `unverified` ≠ `clean`,
 * the scannedFiles:0 (couldn't look) vs applicableSites:0 (genuinely nothing) split,
 * detection-via-stripped-source (no comment/string false-matches), degrade-to-yellow on
 * unknown model, and config-driven cross-repo behaviour. Pure, no LLM, no network.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEfficacyLints, estimateTokens, modelFamily, stripForDetection, loadEfficacyConfig, _internals } from '../scripts/lib/efficacy-lints.mjs';

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}
const rule = (r, id) => r.ruleResults[id];

test('estimateTokens + modelFamily basics', () => {
  assert.equal(estimateTokens('x'.repeat(400)), 100);
  assert.equal(modelFamily('claude-haiku-4-5'), 'claude-haiku');
  assert.equal(modelFamily('not-a-model-zzz'), null);   // unknown → null → unable-to-prove
});

test('stripForDetection blanks comments + strings but preserves offsets', () => {
  const src = 'const a = "cache_control"; // cache_control\nconst b = cache_control;';
  const out = stripForDetection(src);
  assert.equal(out.length, src.length, 'offsets preserved');
  assert.ok(!/cache_control/.test(out.split('\n')[0]), 'the string + comment occurrences are blanked');
  assert.ok(/cache_control/.test(out.split('\n')[1]), 'the real code occurrence survives');
});

test('stripForDetection: non-JS comment grammar (# for py/yaml, <!-- --> for html)', () => {
  const py = _internals.stripForDetection('x = 1  # cache_control\ny = cache_control', _internals.stylesFor('a.py'));
  assert.ok(!/cache_control/.test(py.split('\n')[0]), '# comment blanked');
  assert.ok(/cache_control/.test(py.split('\n')[1]), 'real py code survives');
  const html = _internals.stripForDetection('<!-- cache_control --><div>cache_control</div>', _internals.stylesFor('a.html'));
  assert.equal((html.match(/cache_control/g) || []).length, 1, 'only the non-comment html occurrence survives');
});

test('AST detection: a cache_control marker inside a JS comment/string is NOT a breakpoint', () => {
  // regex-only would false-match the string + comment; the AST sees only the real property.
  const m = _internals.extractMarkers(
    'const s = "has cache_control word"; // cache_control\nconst real = { text: "hi", cache_control: { type: "ephemeral" } };',
    'p.mjs', { canaryPattern: null, canaryTestPattern: null });
  assert.equal(m.mode, 'ast');
  assert.equal(m.cacheBlocks.length, 1, 'exactly one real cache_control property');
});

test('AST detection: a regex literal containing quotes does not corrupt canary detection', () => {
  const m = _internals.extractMarkers(
    "const re = /it's a \"quote\"/; if (isInCanary('feat_x')) run();",
    'p.mjs', { canaryPattern: 'isInCanary', canaryTestPattern: null });
  assert.equal(m.mode, 'ast');
  assert.deepEqual(m.gates.map((g) => g.key), ['feat_x'], 'regex literal did not desync string tracking');
});

test('cache-inertness: a small cached prefix below the model min is PROVABLY INERT (high)', () => {
  const dir = tmpRepo({ 'src/prompt.mjs': 'const sys = { type:"text", text: "You are a tiny helper.", cache_control: { type:"ephemeral" } };' });
  const r = runEfficacyLints({ root: dir, modelHint: 'claude-sonnet-4-6', config: { enabled: true, promptSourceGlobs: ['src/**'], modelMinTokens: { 'claude-sonnet': 1024 } } });
  const hit = r.findings.find((f) => f.ruleId === 'cache-inertness');
  assert.ok(hit && hit.confidence === 'high', 'flags the tiny prefix as inert');
  assert.match(hit.id, /^[0-9a-f]{8}$/, 'finding carries a stable semanticId');
  assert.equal(rule(r, 'cache-inertness').status, 'findings');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('cache-inertness: a large prefix is clean; unknown model degrades to unverified', () => {
  const big = 'word '.repeat(2000); // ~10k chars ≈ 2500 tokens > 1024
  const dirBig = tmpRepo({ 'src/p.mjs': `const sys = { text: "${big}", cache_control: { type:"ephemeral" } };` });
  const rBig = runEfficacyLints({ root: dirBig, modelHint: 'claude-sonnet-4-6', config: { enabled: true, promptSourceGlobs: ['src/**'], modelMinTokens: { 'claude-sonnet': 1024 } } });
  assert.equal(rBig.findings.filter((f) => f.ruleId === 'cache-inertness' && f.confidence === 'high').length, 0, 'big prefix not flagged');
  fs.rmSync(dirBig, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

  const dirUnk = tmpRepo({ 'src/p.mjs': 'const s = { text:"hi", cache_control:{type:"ephemeral"} };' });
  const rUnk = runEfficacyLints({ root: dirUnk, modelHint: 'who-knows', config: { enabled: true, promptSourceGlobs: ['src/**'], modelMinTokens: { 'claude-sonnet': 1024 } } });
  assert.equal(rule(rUnk, 'cache-inertness').status, 'unverified', 'unknown model → unverified, never a fake clean');
  fs.rmSync(dirUnk, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('cache-instability: cache_control near a per-request-varying value is flagged', () => {
  const dir = tmpRepo({ 'src/p.mjs': 'const turnId = Date.now();\nconst block = { text: summary, cache_control: { type:"ephemeral" } };' });
  const r = runEfficacyLints({ root: dir, config: { enabled: true, promptSourceGlobs: ['src/**'] } });
  assert.ok(r.findings.some((f) => f.ruleId === 'cache-instability'), 'flags the unstable prefix');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('canary-no-test: an uncovered gate is flagged; a covered one is clean', () => {
  const files = {
    'src/feature.mjs': "if (isInCanary('sommelier_chat')) { doNewThing(); }",
    'tests/a.test.mjs': "setCanary('other', true);",
  };
  const dir = tmpRepo(files);
  const cfg = { enabled: true, canaryPattern: 'isInCanary', canaryTestPattern: 'setCanary', canarySourceGlobs: ['src/**'], canaryTestGlobs: ['tests/**'] };
  let r = runEfficacyLints({ root: dir, config: cfg });
  assert.ok(r.findings.some((f) => f.ruleId === 'canary-no-test' && /sommelier_chat/.test(f.message)), 'uncovered canary flagged');

  fs.writeFileSync(path.join(dir, 'tests/a.test.mjs'), "setCanary('sommelier_chat', true);");
  r = runEfficacyLints({ root: dir, config: cfg });
  assert.ok(!r.findings.some((f) => f.ruleId === 'canary-no-test'), 'covered canary not flagged');
  assert.equal(rule(r, 'canary-no-test').status, 'clean');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('a canary mention inside a comment/string does NOT count as a gate (stripped detection)', () => {
  const dir = tmpRepo({ 'src/f.mjs': "// isInCanary('ghost')\nconst x = \"isInCanary('also_ghost')\";" });
  const r = runEfficacyLints({ root: dir, config: { enabled: true, canaryPattern: 'isInCanary', canaryTestPattern: 'setCanary', canarySourceGlobs: ['src/**'], canaryTestGlobs: ['tests/**'] } });
  assert.equal(r.findings.filter((f) => f.ruleId === 'canary-no-test').length, 0, 'commented/stringy mentions are not real gates');
  assert.equal(rule(r, 'canary-no-test').status, 'clean', 'scanned a file, found no real gate → clean');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('contract: scannedFiles:0 → unverified (couldn\'t look), NOT clean', () => {
  const dir = tmpRepo({ 'src/x.mjs': 'export const a = 1;' });
  // globs match nothing → couldn't look
  const r = runEfficacyLints({ root: dir, modelHint: 'claude-sonnet-4-6', config: { enabled: true, promptSourceGlobs: ['no-such-dir/**'], modelMinTokens: { 'claude-sonnet': 1024 } } });
  assert.equal(rule(r, 'cache-inertness').status, 'unverified');
  assert.match(rule(r, 'cache-inertness').skipReason || '', /no-files-matched/);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('contract: enabled but genuinely no sites → clean (NOT a false build failure — Gemini-R3)', () => {
  const dir = tmpRepo({ 'src/f.mjs': 'export const noCanaryHere = 1;' });
  const r = runEfficacyLints({ root: dir, config: { enabled: true, canaryPattern: 'isInCanary', canaryTestPattern: 'setCanary', canarySourceGlobs: ['src/**'], canaryTestGlobs: ['tests/**'] } });
  assert.equal(rule(r, 'canary-no-test').status, 'clean', 'scanned files, no gates exist → clean, not unverified');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('contract: disabled → all rules skipped; no canaryPattern → canary skipped', () => {
  const dir = tmpRepo({ 'src/p.mjs': 'cache_control' });
  const off = runEfficacyLints({ root: dir, config: { enabled: false } });
  assert.equal(off.status, 'skipped');
  assert.ok(Object.values(off.ruleResults).every((r) => r.status === 'skipped'));
  const noCanary = runEfficacyLints({ root: dir, config: { enabled: true, promptSourceGlobs: ['src/**'] } });
  assert.equal(rule(noCanary, 'canary-no-test').status, 'skipped');
  assert.match(rule(noCanary, 'canary-no-test').skipReason || '', /no-canaryPattern/);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('loadEfficacyConfig: absent → off-defaults; MALFORMED → throws (never silent-disable)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-cfg-'));
  // absent → defaults (off)
  assert.equal(loadEfficacyConfig(dir).enabled, false);
  // malformed JSON → throws loudly (the green≠realized trap: a broken config must not silently disable)
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), '{ enabled: true, oops');
  assert.throws(() => loadEfficacyConfig(dir), /malformed JSON/);
  // schema-invalid → throws
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), JSON.stringify({ enabled: 'yes' }));
  assert.throws(() => loadEfficacyConfig(dir), /invalid/);
  // literal `null` / non-object JSON → throws (not an unhandled TypeError — Gemini gate LOW)
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), 'null');
  assert.throws(() => loadEfficacyConfig(dir), /must be a JSON object/);
  // valid → merged over defaults
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), JSON.stringify({ enabled: true, canaryPattern: 'isInCanary' }));
  const ok = loadEfficacyConfig(dir);
  assert.equal(ok.enabled, true);
  assert.equal(ok.modelMinTokens['claude-haiku'], 2048); // default preserved through the merge
  // `_`-prefixed keys are comments — stripped, NOT rejected by the strict schema.
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), JSON.stringify({ _note: 'hi', enabled: true }));
  assert.equal(loadEfficacyConfig(dir).enabled, true, '_note comment key tolerated');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('the shipped example template loads cleanly through loadEfficacyConfig', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eff-ex-'));
  const example = fs.readFileSync(path.join(import.meta.dirname, '..', 'defaults', 'efficacy-lints.config.example.json'), 'utf8');
  fs.writeFileSync(path.join(dir, 'efficacy-lints.config.json'), example);
  const cfg = loadEfficacyConfig(dir);          // must not throw (it carries a _note)
  assert.equal(cfg.enabled, false, 'example ships OFF by default');
  assert.equal(cfg.canaryPattern, 'isInCanary');
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

test('aggregate status is the worst per-rule status', () => {
  assert.equal(_internals.ruleStatus({ enabled: true, scannedFiles: 0, findings: [] }), 'unverified');
  assert.equal(_internals.ruleStatus({ enabled: true, scannedFiles: 3, findings: [] }), 'clean');
  assert.equal(_internals.ruleStatus({ enabled: true, scannedFiles: 3, findings: [{ confidence: 'high' }] }), 'findings');
  assert.equal(_internals.ruleStatus({ enabled: false, scannedFiles: 3, findings: [] }), 'skipped');
});
