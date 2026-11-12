/**
 * @fileoverview Hook v18 (Tier 3: the consumer hook contract, and the gate verdict it prints), from the 2026-11-12 field reports:
 *
 *   A. A DEGRADED OWNERSHIP SCAN IS NOT A PASS (wine #1336). Cause: the duplication wave extracts the base revision in a scratch dir that is
 *      not a work tree, so `git check-ignore` exits 128 there. Fixed at the cause (`extract.mjs --materialised`) AND carried to the verdict
 *      (`OWNERSHIP_UNVERIFIED` marker -> `unmeasured`), both directions.
 *   B. The final review on the Azure work profile (see tests/final-review-provider.test.mjs for the selection itself; the sdk pin is here).
 *   C. HIGH/MEDIUM finding titles are printed.
 *   D. A killed run leaves a progressive step trail.
 *
 * The hook cases run the REAL hook body under bash with the real step runner and a scriptable fake audit.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { _internals } from '../scripts/install-prepush-hook.mjs';
import { PREPUSH_HOOK_VERSION } from '../scripts/lib/prepush-hook-version.mjs';
import { classifyAuditOutcome, decideAuditGate, formatFindingTitles, FINDING_TITLES_CAP } from '../scripts/lib/prepush-audit-gate.mjs';
import { isControlMarkerFinding, isMeasurementDegradingDetail, CONTROL_MARKER_PREFIXES } from '../scripts/lib/audit/control-markers.mjs';
import { stampOwnershipUnverified, buildOwnershipUnverifiedFinding } from '../scripts/lib/audit/run-notices.mjs';
import { noteDegradedScan, degradedScanNotesSoFar, _resetDegradedScanNotes } from '../scripts/lib/disowned-paths.mjs';
import { makeTrail, CAPABILITIES } from '../scripts/prepush-step.mjs';
import { runDuplicationAnalysis } from '../scripts/lib/audit/duplication-detector.mjs';
import { hasBash, git } from './lib/hook-test-helpers.mjs';
import { writeStepRunnerStub } from './lib/prepush-step-stub.mjs';

const { HOOK_BODY } = _internals;
const HAS_BASH = hasBash();
const tmpDir = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
const EXTRACT = fileURLToPath(new URL('../scripts/symbol-index/extract.mjs', import.meta.url));
const MARKER = buildOwnershipUnverifiedFinding('[disowned-paths] WARN: could not determine gitignore status (git exit 128)');
const PASS = { verdict: 'PASS', findings: [] };

describe('hook v18 - version', () => {
  it('is 18 and the runner offers the trail capability the hook requires', () => {
    assert.equal(PREPUSH_HOOK_VERSION, 18);
    assert.match(HOOK_BODY, /# hook-version: 18/);
    assert.ok(CAPABILITIES.includes('trail'));
    assert.match(HOOK_BODY, /for cap in [^;]* trail; do/);
  });
});

describe('A - the 128 cause: a scratch root is not a work tree', () => {
  const run = (extra) => {
    const root = tmpDir('v18-scratch-');
    try {
      fs.mkdirSync(path.join(root, 'src'));
      fs.writeFileSync(path.join(root, 'src', 'a.js'), 'export function foo() { return 1; }\n');
      fs.writeFileSync(path.join(root, 'm.txt'), 'src/a.js\0');
      const r = spawnSync(process.execPath, [EXTRACT, '--root', root, '--mode', 'full', '--files-from', path.join(root, 'm.txt'), ...extra], { encoding: 'utf8', timeout: 120_000 });
      return { r, lines: r.stdout.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) };
    } finally { rmrf(root); }
  };
  it('RED (no flag): a non-git root makes git exit 128 and the child reports the degraded scan on the wire', () => {
    const { r, lines } = run([]);
    assert.match(r.stderr, /could not determine gitignore status \(git exit 128\)/);
    assert.ok(lines.some((l) => l.type === 'ownership' && l.degraded === true && /128/.test(l.warning)), r.stdout.slice(0, 400));
  });
  it('GREEN (--materialised): the ownership question is not asked - no warning, no degraded line, symbols still extracted', () => {
    const { r, lines } = run(['--materialised']);
    assert.doesNotMatch(r.stderr, /gitignore status/);
    assert.equal(lines.some((l) => l.type === 'ownership'), false);
    assert.ok(lines.some((l) => l.type === 'symbol' && l.symbolName === 'foo'), 'the scratch side still yields its symbols');
  });
  it('the duplication detector asks for --materialised on the base (scratch) side only', async () => {
    const seen = [];
    await runDuplicationAnalysis({
      repoRoot: '/repo', changedFiles: [{ status: 'modified', currentPath: 'a.mjs' }], auditBaseCommit: 'HEAD',
      adapters: {
        async getRepoId() { return 'r'; },
        async getActiveSnapshot() { return { refreshId: 'x', activeEmbeddingModel: 'm', activeEmbeddingDim: 4 }; },
        async extractSymbolsForFiles(root, files, opts) { seen.push({ root, opts }); return []; },
        async gitShowAtRevision() { return { ok: true, content: 'old' }; },
        async embedText() { return [0, 0, 0, 0]; },
        async callNeighbourhoodRpc() { return []; },
        gateSymbolForEgress() { return { category: null }; },
        readFileSync() { return ''; },
      },
    });
    assert.equal(seen.length, 2);
    assert.equal(seen[0].root, '/repo');
    assert.ok(!seen[0].opts?.materialised, 'the real repo is asked normally');
    assert.notEqual(seen[1].root, '/repo');
    assert.equal(seen[1].opts?.materialised, true);
  });
});

describe('A - a degraded scan reaches the verdict', () => {
  it('the registry dedups and the stamp appends one marker per note; no notes -> the same object back', () => {
    _resetDegradedScanNotes();
    const r = { verdict: 'PASS', findings: [] };
    assert.equal(stampOwnershipUnverified(r), r);
    noteDegradedScan('git exit 128');
    noteDegradedScan('git exit   128');
    assert.deepEqual(degradedScanNotesSoFar(), ['git exit 128']);
    const out = stampOwnershipUnverified(r);
    assert.equal(degradedScanNotesSoFar().length, 0, 'the stamp CONSUMES the notes: a second audit in one process starts clean');
    assert.equal(out.findings.length, 1);
    assert.match(out.findings[0].detail, /^OWNERSHIP_UNVERIFIED: git exit 128/);
    assert.equal(r.findings.length, 0, 'the input is not mutated');
    _resetDegradedScanNotes();
  });
  it('the marker is a control marker (one predicate) but NOT in the SQL-mirrored list', () => {
    assert.equal(isControlMarkerFinding(MARKER), true);
    assert.equal(isMeasurementDegradingDetail(MARKER.detail), true);
    assert.deepEqual(CONTROL_MARKER_PREFIXES, ['ADJACENCY_INCOMPLETE']);
    assert.equal(isMeasurementDegradingDetail('ADJACENCY_INCOMPLETE (x): y'), false, 'a coverage notice stays a clean-with-notice');
  });
  it('RED/GREEN: PASS + the marker is UNMEASURED with a tooling line and a refusal; PASS alone is clean', () => {
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: PASS }).kind, 'clean');
    const o = classifyAuditOutcome({ exitCode: 0, report: { ...PASS, findings: [MARKER] } });
    assert.equal(o.kind, 'unmeasured');
    assert.match(o.cause, /UNVERIFIED input/);
    assert.equal(o.tooling.length, 1);
    const d = decideAuditGate({ outcome: o, env: {} });
    assert.equal(d.allow, false);
    assert.ok(d.lines.some((l) => /tooling: OWNERSHIP_UNVERIFIED/.test(l)), d.lines.join('\n'));
    const forced = decideAuditGate({ outcome: o, env: { AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' } });
    assert.equal(forced.allow, true);
    assert.ok(forced.lines.some((l) => /tooling: OWNERSHIP_UNVERIFIED/.test(l)));
  });
  it('a coverage-only marker next to PASS stays clean-with-notice (the OTHER direction: nothing new is refused)', () => {
    const adj = { severity: 'MEDIUM', detail: 'ADJACENCY_INCOMPLETE (input-bound): 91 files' };
    assert.equal(classifyAuditOutcome({ exitCode: 0, report: { verdict: 'PASS', findings: [adj] } }).kind, 'clean');
  });
});

describe('B - the Azure final reviewer is pinned to the sdk backend', () => {
  it('the azure-claude descriptor passes backend:"sdk" with the route (the cli backend drops tool_choice)', () => {
    const src = fs.readFileSync(new URL('../scripts/lib/final-review/providers.mjs', import.meta.url), 'utf8');
    assert.match(src, /createAnthropicClient\(\{ backend: 'sdk', azureRoute: route \}\)/);
  });
});

describe('C - finding titles', () => {
  const F = (sev, cat, extra = {}) => ({ severity: sev, category: cat, detail: `${cat} detail`, ...extra });
  it('HIGH first, then MEDIUM, audit order inside a severity; LOW and markers are not listed', () => {
    const lines = formatFindingTitles([F('MEDIUM', 'm1'), F('LOW', 'l1'), F('HIGH', 'h1', { affectedFiles: ['a.js'] }), MARKER, F('MEDIUM', 'm2')]);
    assert.equal(lines.length, 3);
    assert.match(lines[0], /^ {3}H {2}h1 - h1 detail {2}\[a\.js\]$/);
    assert.match(lines[1], /M {2}m1/);
    assert.match(lines[2], /M {2}m2/);
  });
  it('caps at 10 and says how many more; nothing to show -> no lines; an unreadable list -> no lines', () => {
    const many = Array.from({ length: 13 }, (_, i) => F('MEDIUM', `m${i}`));
    const lines = formatFindingTitles(many);
    assert.equal(lines.length, FINDING_TITLES_CAP + 1);
    assert.match(lines.at(-1), /and 3 more/);
    assert.deepEqual(formatFindingTitles([F('LOW', 'x')]), []);
    assert.deepEqual(formatFindingTitles(undefined), []);
  });
  it('terminal control sequences in model- or file-controlled text never reach the terminal (audit R1)', () => {
    const out = formatFindingTitles([{ severity: 'HIGH', category: 'a' + String.fromCharCode(27) + '[31mred', detail: 'x' + String.fromCharCode(7) + 'y', affectedFiles: ['f' + String.fromCharCode(27) + 'g.js'] }]).join('\n');
    assert.doesNotMatch(out, /[\u0000-\u0008\u000b-\u001f\u007f]/);
    assert.match(out, /a .31mred - x y/);
  });
});

describe('D - the trail writer', () => {
  it('appends timestamped lines immediately, and a missing file path is a no-op that never throws', () => {
    const dir = tmpDir('v18-trail-');
    try {
      const f = path.join(dir, 't.log');
      const t = makeTrail(f, { now: () => 'T0', pid: 7 });
      t('one');
      assert.equal(fs.readFileSync(f, 'utf8'), 'T0 [7] one\n');
      t('two');
      assert.equal(fs.readFileSync(f, 'utf8'), 'T0 [7] one\nT0 [7] two\n');
      assert.doesNotThrow(() => makeTrail(path.join(dir, 'no', 'such', 'dir', 't.log'))('x'));
      assert.doesNotThrow(() => makeTrail(null)('x'));
    } finally { rmrf(dir); }
  });
});

// ── the real hook ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sourceRepo(ws) {
  const scripts = path.join(ws, 'source-repo', 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.writeFileSync(path.join(scripts, 'sync-to-repos.mjs'), '// fixture\n');
  writeStepRunnerStub(scripts);
  fs.writeFileSync(path.join(scripts, 'check-plan-status.mjs'), [
    "import fs from 'node:fs';", 'const a = process.argv.slice(2);',
    "if (a.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }",
    "if (a.includes('--select')) { if (fs.existsSync('docs/plans/active.md')) console.log('docs/plans/active.md'); process.exit(0); }",
    'process.exit(0);', '',
  ].join('\n'));
  // The fake audit: records the trail AS IT WAS while the audit ran (proving it is progressive), then emits the scripted envelope.
  fs.writeFileSync(path.join(scripts, 'openai-audit.mjs'), [
    "import fs from 'node:fs';", "import path from 'node:path';",
    "const a = process.argv.slice(2); const o = a.indexOf('--out'); const out = o >= 0 ? a[o + 1] : null;",
    "const root = path.resolve(out, '..', '..', '..');",
    "const trail = path.join(root, '.audit', 'prepush', 'last-run.steps.log');",
    "fs.writeFileSync(path.join(root, 'TRAIL_DURING_AUDIT.txt'), fs.existsSync(trail) ? fs.readFileSync(trail, 'utf8') : 'NO TRAIL');",
    "if (out) fs.writeFileSync(out, process.env.AUDIT_ENVELOPE || '{\"verdict\":\"PASS\",\"findings\":[]}');",
    'process.exit(0);', '',
  ].join('\n'));
  return path.join(ws, 'source-repo');
}
function consumer(ws) {
  const bare = path.join(ws, 'origin.git');
  const local = path.join(ws, 'local');
  git(['init', '--bare', '-q', '-b', 'main', bare]);
  git(['clone', '-q', bare, local]);
  git(['config', 'user.email', 'a@example.invalid'], local);
  git(['config', 'user.name', 'A'], local);
  fs.writeFileSync(path.join(local, '.gitignore'), '.audit/\nTRAIL_DURING_AUDIT.txt\n');
  fs.mkdirSync(path.join(local, 'src'), { recursive: true });
  fs.mkdirSync(path.join(local, 'docs', 'plans'), { recursive: true });
  fs.writeFileSync(path.join(local, 'src', 'app.mjs'), 'export const app = 0;\n');
  fs.writeFileSync(path.join(local, 'docs', 'plans', 'active.md'), '# Plan\n\n- **Status**: In Progress\n');
  git(['add', '.'], local);
  git(['commit', '-q', '-m', 'seed'], local);
  git(['push', '-q', 'origin', 'main'], local);
  const base = git(['rev-parse', 'HEAD'], local);
  fs.writeFileSync(path.join(local, 'src', 'app.mjs'), 'export const app = 1;\n');
  git(['add', '-f', 'src/app.mjs'], local);
  git(['commit', '-q', '-m', 'feat: work'], local);
  const head = git(['rev-parse', 'HEAD'], local);
  return { bare, local, stdin: `refs/heads/main ${head} refs/heads/main ${base}\n` };
}
function hook(envelope, extra = {}) {
  const ws = tmpDir('hook-v18-');
  try {
    const source = sourceRepo(ws);
    const c = consumer(ws);
    const script = path.join(c.local, '.hook.sh');
    fs.writeFileSync(script, HOOK_BODY);
    const env = {
      ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AZURE_') && !k.startsWith('AUDIT_PREPUSH_'))),
      CLAUDE_AUDIT_LOOP_DIR: source, AUDIT_ENVELOPE: JSON.stringify(envelope), ...extra,
    };
    const r = spawnSync('bash', [script, 'origin', c.bare], { cwd: c.local, encoding: 'utf-8', input: c.stdin, timeout: 240_000, env });
    const read = (...p) => { const f = path.join(c.local, ...p); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null; };
    return { r, trail: read('.audit', 'prepush', 'last-run.steps.log'), during: read('TRAIL_DURING_AUDIT.txt') };
  } finally { rmrf(ws); }
}

describe('the real hook', () => {
  it('A: PASS carrying the ownership marker REFUSES UNMEASURED with a tooling line; PASS alone passes with none', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const bad = hook({ ...PASS, findings: [MARKER] });
    assert.equal(bad.r.status, 1, bad.r.stderr);
    assert.match(bad.r.stderr, /UNMEASURED: the code audit did NOT run to a verdict/);
    assert.match(bad.r.stderr, /tooling: OWNERSHIP_UNVERIFIED/);
    const forced = hook({ ...PASS, findings: [MARKER] }, { AUDIT_PREPUSH_ALLOW_UNMEASURED: '1' });
    assert.equal(forced.r.status, 0, forced.r.stderr);
    assert.match(forced.r.stderr, /ALLOWED UNMEASURED/);
    const ok = hook(PASS);
    assert.equal(ok.r.status, 0, ok.r.stderr);
    assert.doesNotMatch(ok.r.stderr, /tooling:/);
    assert.match(ok.r.stderr, /ran clean/);
  });
  it('C: a findings run prints its HIGH/MEDIUM titles (HIGH first) in the push output', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const env = {
      verdict: 'SIGNIFICANT_ISSUES',
      findings: [
        { severity: 'MEDIUM', category: 'Retry storm', detail: 'no backoff' }, { severity: 'HIGH', category: 'Race on write', detail: 'lost update' },
        { severity: 'MEDIUM', category: 'Dead branch', detail: 'unreachable' }, { severity: 'MEDIUM', category: 'Naming', detail: 'unclear' },
      ],
    };
    const { r } = hook(env);
    assert.equal(r.status, 0, r.stderr);
    const i = r.stderr.indexOf('HIGH/MEDIUM findings');
    assert.ok(i >= 0, r.stderr);
    const block = r.stderr.slice(i);
    assert.ok(block.indexOf('Race on write') < block.indexOf('Retry storm'), 'HIGH before MEDIUM');
    assert.match(block, /Dead branch/);
    assert.match(block, /Naming/);
  });
  it('D: the trail is APPENDED progressively - it already names the audit step while the audit is still running - and closes with the exit', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const { r, trail, during } = hook(PASS);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(during, 'NO TRAIL');
    assert.match(during, /hook v18 started/);
    assert.match(during, /step code-audit: start \(budget \d+s, output streams to /);
    assert.match(during, /audit starting: snapshot /);
    assert.doesNotMatch(during, /audit finished/, 'the end was not yet written while the audit ran');
    assert.match(trail, /step code-audit: end exit=0/);
    assert.match(trail, /audit outcome: clean/);
    assert.match(trail, /hook exit rc=0 outcome=clean/);
    assert.match(trail, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[\d+\] /m, 'timestamped, with a pid');
  });
});

describe('E - first write to a fresh .audit/prepush (WCA first v17 push)', () => {
  it('RED instrument: the old shape prints the redirect error on a missing file; the guarded shape does not', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const dir = tmpDir('v18-wc-');
    try {
      const run = (cmd) => spawnSync('bash', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
      assert.match(run('x="$(wc -c < nofile 2>/dev/null | tr -d " ")"').stderr, /No such file/, 'the instrument can see the bug');
      assert.equal(run('x=0; [ -f nofile ] && x="$(wc -c < nofile 2>/dev/null | tr -d " ")"').stderr, '');
    } finally { rmrf(dir); }
  });
  it('the first invocation-log write is silent and the record lands (kill-switch path, no prior file)', (t) => {
    if (!HAS_BASH) return t.skip('bash is required');
    const dir = tmpDir('v18-first-');
    try {
      const script = path.join(dir, 'h.sh');
      fs.writeFileSync(script, HOOK_BODY);
      const r = spawnSync('bash', [script, 'origin', 'x'], { cwd: dir, encoding: 'utf8', input: '', env: { ...process.env, AUDIT_PREPUSH_DISABLE: '1' } });
      assert.equal(r.status, 0);
      assert.equal(r.stderr, '', 'no redirect noise on the first write');
      assert.match(fs.readFileSync(path.join(dir, '.audit', 'prepush', 'invocations.log'), 'utf8'), /outcome=disabled/);
    } finally { rmrf(dir); }
  });
});
