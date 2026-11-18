/**
 * @fileoverview The optional load of the CES-only full-suite verdict by `ship-batch.mjs` (docs/plans/ship-batch-member-outcomes.md, "CI fix").
 *
 * The edge is a computed-specifier dynamic import, invisible to the closure walk on purpose (a consumer must never receive the CES default).
 * That is honest only if it FAILS CLOSED: absent is told apart from broken, a declared workflow that cannot be evaluated refuses, and in the
 * source repo the real verdict is what judges a member. Each half is pinned here; the consumer half in a relocated layout is pinned in
 * `tests/sync-ship-batch-closure.test.mjs`.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ciAndIdentityReasons, declaredFullSuite, loadCiVerdict } from '../scripts/lib/fleet/ship-batch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
let tmp;
before(() => { fs.mkdirSync(path.join(ROOT, '.claude', 'tmp'), { recursive: true }); tmp = fs.mkdtempSync(path.join(ROOT, '.claude', 'tmp', 'ciload-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });
const write = (name, body) => { const f = path.join(tmp, name); fs.writeFileSync(f, body); return pathToFileURL(f).href; };

describe('loadCiVerdict: absent, loaded and broken are three different things', () => {
  it('a module that does not exist is ABSENT (a consumer)', async () => {
    assert.deepEqual(await loadCiVerdict(pathToFileURL(path.join(tmp, 'not-there.mjs')).href), { impl: null, absent: true });
  });
  it('a module that loads and exports ciVerdict is returned', async () => {
    const r = await loadCiVerdict(write('good.mjs', 'export const ciVerdict = () => ({ verdict: "full" });'));
    assert.equal(r.absent, false);
    assert.equal(r.impl().verdict, 'full');
  });
  it('a SYNTAX ERROR is rethrown, never read as absent', async () => {
    await assert.rejects(loadCiVerdict(write('syntax.mjs', 'export const ciVerdict = ;')), (e) => e instanceof SyntaxError);
  });
  it('a missing TRANSITIVE dependency is rethrown, never read as absent', async () => {
    await assert.rejects(loadCiVerdict(write('transitive.mjs', 'import "./nope-not-here.mjs"; export const ciVerdict = () => 1;')), (e) => e.code === 'ERR_MODULE_NOT_FOUND' && /nope-not-here/.test(e.message));
  });
  it('an initialisation error is rethrown', async () => {
    await assert.rejects(loadCiVerdict(write('init.mjs', 'throw new Error("boom at import"); export const ciVerdict = () => 1;')), /boom at import/);
  });
  it('a module that does not export a ciVerdict function is rejected', async () => {
    await assert.rejects(loadCiVerdict(write('wrong.mjs', 'export const other = 1;')), /does not export a ciVerdict function/);
  });
});

describe('declaredFullSuite: where the verifier is absent, a declaration still counts', () => {
  const dirWith = (body) => { const d = fs.mkdtempSync(path.join(tmp, 'repo-')); if (body !== null) fs.writeFileSync(path.join(d, '.test-tiers.json'), body); return d; };
  it('no .test-tiers.json, or one without a ciVerdict workflow, declares nothing', () => {
    assert.deepEqual(declaredFullSuite(dirWith(null)), { declared: false });
    assert.deepEqual(declaredFullSuite(dirWith('{"heavy":[]}')), { declared: false });
  });
  it('a ciVerdict workflow is a declaration, and so is a file that cannot be read as JSON', () => {
    assert.match(declaredFullSuite(dirWith('{"ciVerdict":{"workflow":".github/workflows/full-suite.yml"}}')).reason, /declares the full-suite workflow ".github\/workflows\/full-suite.yml"/);
    const bad = declaredFullSuite(dirWith('{ not json'));
    assert.equal(bad.declared, true);
    assert.match(bad.reason, /not valid JSON/);
  });
});

describe('the source repo runs the REAL verdict: a declared workflow decides the member re-check', () => {
  const HEAD = 'a'.repeat(40);
  const BASE = 'b'.repeat(40);
  const DEFAULT = 'c'.repeat(40);
  const BLOB = 'd'.repeat(40);
  const WF = JSON.parse(fs.readFileSync(path.join(ROOT, '.test-tiers.json'), 'utf8')).ciVerdict.workflow;
  const ok = (doc) => ({ ok: true, status: 0, stdout: JSON.stringify(doc), stderr: '' });
  const deps = { gh: (args) => {
    if (args[0] === 'pr' && args[1] === 'view') return ok({ state: 'OPEN', isDraft: false, headRefOid: HEAD, baseRefName: 'main' });
    if (args[0] === 'api') return ok(/rules\/branches/.test(args[1]) ? [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'ci' }] } }] : { protected: false });
    if (args[0] === 'pr' && args[1] === 'checks') return ok([{ name: 'ci', bucket: 'pass', state: 'SUCCESS', completedAt: '2026-10-09T10:00:00Z' }]);
    return { ok: false, status: 1, stdout: '', stderr: 'unexpected', reason: 'unexpected' };
  } };
  /** A controlled GitHub for `ciVerdict`: the repo's own `.test-tiers.json` declares WF, and the run for HEAD concluded `conclusion`. */
  const runFor = (conclusion) => (cmd, args) => {
    const t = (s) => ({ status: 0, stdout: s, stderr: '' });
    const j = (v) => t(JSON.stringify(v));
    const a = args.join(' ');
    if (cmd === 'gh' && a.startsWith('repo view')) return j({ nameWithOwner: 'o/n', defaultBranchRef: { name: 'main' } });
    if (cmd === 'git' && args[0] === 'fetch') return t('');
    if (cmd === 'git' && a === 'rev-parse FETCH_HEAD') return t(DEFAULT);
    if (cmd === 'git' && args[0] === 'show') return t(fs.readFileSync(path.join(ROOT, '.test-tiers.json'), 'utf8'));
    if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') return j({ number: 7, headRefOid: HEAD, baseRefName: 'main', state: 'OPEN', mergeable: 'MERGEABLE' });
    if (cmd === 'gh' && args[0] === 'api' && /contents\//.test(args[1])) return t(BLOB);
    if (cmd === 'gh' && args[0] === 'api' && /actions\/permissions/.test(args[1])) return j({ enabled: true });
    if (cmd === 'gh' && args[0] === 'api' && /actions\/runs/.test(args[1])) {
      return j({ workflow_runs: [{ id: 1, path: WF, head_sha: HEAD, event: 'pull_request', status: 'completed', conclusion, run_attempt: 1, head_branch: 'feat', pull_requests: [{ number: 7, base: { ref: 'main', sha: BASE } }] }] });
    }
    return { status: 1, stdout: '', stderr: `unexpected ${cmd} ${a}` };
  };
  const member = { id: 'm', prNumber: 7, repo: 'o/n', oid: HEAD };
  const re = (conclusion) => ciAndIdentityReasons({ cwd: ROOT, member, base: 'main', deps, runFn: runFor(conclusion) });

  it('a FAILED full-suite run refuses the member, and a successful one lets it through (no ciFn injected: the loaded verifier decides)', () => {
    const failed = re('failure');
    assert.ok(failed.some((r) => /^ci: the full-suite run is failed/.test(r)), failed.join(' | '));
    assert.deepEqual(re('success'), []);
  });
  it('an unavailable GitHub is unverified, not a pass', () => {
    const r = ciAndIdentityReasons({ cwd: ROOT, member, base: 'main', deps, runFn: () => ({ status: 1, stdout: '', stderr: 'no gh' }) });
    assert.ok(r.some((x) => /^ci: the full-suite run is unverified/.test(x)), r.join(' | '));
  });
});
