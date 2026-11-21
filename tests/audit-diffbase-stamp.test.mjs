/**
 * A round audited with an explicit `--files` allowlist AND `--base` records `_diffBase`, so the final reviewer can rebuild the
 * round's hunks (CES verification-lessons: /cycle's documented cluster command passes `--files`, and its rounds reached the final
 * gate with no diff base, reading `Code: PARTIAL … no diff evidence`).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffBaseToStamp, resolveAllowlistBase, stampAuditRound } from '../scripts/lib/finalize-outcomes.mjs';

const SHA = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);

describe('diffBaseToStamp — which base a round records', () => {
  it('a scope-diff round records its base (unchanged behaviour)', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: ['x.mjs'], auditBaseCommit: SHA }), SHA);
  });
  it('an --files round with a validated --base records it', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: null, explicitBaseResolved: true, auditBaseCommit: SHA }), SHA);
  });
  it('negative control: an --files round WITHOUT --base records nothing (the provisional HEAD~1 is never a base)', () => {
    assert.equal(diffBaseToStamp({ coverageChanged: null, explicitBaseResolved: false, auditBaseCommit: 'HEAD~1' }), null);
    assert.equal(diffBaseToStamp({ coverageChanged: null, auditBaseCommit: SHA }), null);
  });
  it('a non-sha base is never stamped, whatever the flags', () => {
    assert.equal(diffBaseToStamp({ explicitBaseResolved: true, auditBaseCommit: 'origin/main' }), null);
  });
  it('end to end through stampAuditRound: the result carries _diffBase', () => {
    const r = stampAuditRound({}, 3, diffBaseToStamp({ explicitBaseResolved: true, auditBaseCommit: SHA }));
    assert.equal(r._diffBase, SHA);
    assert.equal(r.round, 3);
  });
});

describe('resolveAllowlistBase — an explicit base beside --files is validated and resolved', () => {
  const ok = () => ({ ok: true, baseSha: OTHER });
  it('allowlist + explicit base resolves to the full sha the snapshot validated', () => {
    assert.equal(resolveAllowlistBase({ source: 'allowlist', explicitBase: 'origin/main', resolve: ok }), OTHER);
  });
  it('is a no-op for a non-allowlist round or with no explicit base (the scope-diff block owns those)', () => {
    let called = false;
    const spy = () => { called = true; return ok(); };
    assert.equal(resolveAllowlistBase({ source: 'scope-diff', explicitBase: 'origin/main', resolve: spy }), null);
    assert.equal(resolveAllowlistBase({ source: 'allowlist', explicitBase: null, resolve: spy }), null);
    assert.equal(called, false);
  });
  it('an explicit base that cannot be validated STOPS the run, never demotes to no base', () => {
    assert.throws(
      () => resolveAllowlistBase({ source: 'allowlist', explicitBase: 'nope', resolve: () => ({ ok: false, reason: 'not an ancestor of HEAD' }) }),
      (e) => e.auditScopeFatal === true && /not an ancestor/.test(e.message),
    );
    assert.throws(() => resolveAllowlistBase({ source: 'allowlist', explicitBase: 'x', resolve: () => ({ ok: true, baseSha: 'HEAD' }) }), /AGENT FIX/);
  });
});

describe('resolveAllowlistBase against a REAL repository (the resolver openai-audit wires in)', () => {
  it('an ancestor base resolves to its full sha; a non-ancestor base stops the run', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const { spawnSync, execFileSync } = await import('node:child_process');
    const { resolveRangeSnapshot, makeGitRunner } = await import('../scripts/lib/worktree-identity.mjs');
    // a hook-exported GIT_DIR must not retarget the fixture
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.toUpperCase().startsWith('GIT_')));
    Object.assign(env, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diffbase-stamp-'));
    try {
      const g = (...a) => execFileSync('git', ['-c', 'commit.gpgsign=false', ...a], { cwd: dir, env, encoding: 'utf8' }).trim();
      g('init', '-q', '-b', 'main');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n'); g('add', 'a.txt'); g('commit', '-q', '-m', 'one');
      const base = g('rev-parse', 'HEAD');
      fs.writeFileSync(path.join(dir, 'a.txt'), 'b\n'); g('commit', '-q', '-am', 'two');
      g('checkout', '-q', '-b', 'side', base); fs.writeFileSync(path.join(dir, 's.txt'), 's\n'); g('add', 's.txt'); g('commit', '-q', '-m', 'side');
      const side = g('rev-parse', 'HEAD');
      g('checkout', '-q', 'main');
      const run = makeGitRunner(dir, { spawn: (cmd, args, o) => spawnSync(cmd, args, { ...o, env }) });
      const resolve = (a) => resolveRangeSnapshot({ ...a, run });
      assert.equal(resolveAllowlistBase({ source: 'allowlist', explicitBase: base.slice(0, 10), resolve }), base);
      assert.throws(() => resolveAllowlistBase({ source: 'allowlist', explicitBase: side, resolve }), (e) => e.auditScopeFatal === true);
      assert.throws(() => resolveAllowlistBase({ source: 'allowlist', explicitBase: 'no-such-ref', resolve }), (e) => e.auditScopeFatal === true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('openai-audit.mjs uses the ONE decision at every stamp site', () => {
  const src = fs.readFileSync(new URL('../scripts/openai-audit.mjs', import.meta.url), 'utf8');
  it('both stampAuditRound call sites for code rounds go through diffBaseToStamp, and the old coverage-only ternary is gone', () => {
    assert.equal((src.match(/stampAuditRound\([^\n]*diffBaseToStamp\(opts\)/g) || []).length, 2);
    assert.doesNotMatch(src, /opts\.coverageChanged \? opts\.auditBaseCommit : null/);
  });
  it('the allowlist base is resolved and handed on as explicitBaseResolved', () => {
    assert.match(src, /resolveAllowlistBase\(\{ source: scopeResolution\.source, explicitBase,/);
    assert.match(src, /explicitBaseResolved: Boolean\(allowlistBase\)/);
  });
});
