/**
 * @fileoverview The audit-snapshot INPUT CENSUS (docs/plans/prepush-gate-consumer-feedback-theme1.md D2, "How the census is observed").
 *
 * The consumer hook runs the audit with its cwd in a snapshot worktree, which holds only TRACKED files. Every input the audit reads from
 * cwd therefore needs a declared policy, or a gitignored input silently goes missing - the sandbox-honesty failure. The REAL
 * `openai-audit.mjs code --planless` runs inside a real snapshot with every provider credential emptied, under an fs-trace preload, and
 * exits at the credential gate: that covers every input read before the first model call. The test fails on any cwd-relative path the
 * census does not declare.
 *
 * What it cannot see (stated, not hidden): inputs read only AFTER a model call (the domain map in the architecture pass, debt
 * suppression). Those have direct contracts in prepush-hook-v17.test.mjs (--debt-ledger absolute + read-only) and are tracked in the
 * three consumers (.audit-loop/domain-map.json).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createSnapshot, removeSnapshot, snapshotPath, CONSUMER_SNAPSHOT_PREFIX } from '../scripts/lib/prepush-snapshot.mjs';
import { resolveRepoIdentity } from '../scripts/lib/repo-identity.mjs';
import { git } from './lib/hook-test-helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const rmrf = (p) => fs.rmSync(p, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });

/**
 * D2's census table, as data: every cwd-relative input the audit may read, and its policy in the snapshot. A path matches an entry
 * exactly, or by prefix when the entry ends in '/'.
 */
const CENSUS = Object.freeze([
  { path: '.auditignore', policy: 'tracked -> present; untracked -> copied in by `snapshot create` (it narrows scope)' },
  { path: '.env', policy: 'not copied: lib/load-env.mjs resolves the MAIN worktree\'s .env from a linked worktree' },
  { path: 'package.json', policy: 'tracked in every consumer -> present (pushed bytes); stack detection' },
  { path: '.requirements/ledger.json', policy: 'present when tracked; absent -> rubric off, as today' },
  { path: '.audit-loop/domain-map.json', policy: 'tracked in all three consumers -> present (pushed bytes)' },
  { path: '.audit-loop/arm-eval-toggle.json', policy: 'not copied: absent -> enabled:false (fail-closed, spend off)' },
  { path: '.audit/', policy: 'local learning state (prompt revisions, FP patterns, bandit, session cache, tech-debt): not copied; a hook audit starts fresh and its writes die with the snapshot; the debt ledger is passed by absolute path, read-only' },
]);
const declared = (p) => CENSUS.some((e) => (e.path.endsWith('/') ? p.startsWith(e.path) : p === e.path));

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.email', 'a@example.invalid'], dir);
  git(['config', 'user.name', 'A'], dir);
  git(['remote', 'add', 'origin', 'https://github.com/example-owner/census-fixture.git'], dir);
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"census-fixture","type":"module"}\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'seed'], dir);
  fs.writeFileSync(path.join(dir, 'src', 'a.mjs'), 'export const a = 2;\n');
  git(['add', '.'], dir);
  git(['commit', '-q', '-m', 'feat: two'], dir);
  return { dir, head: git(['rev-parse', 'HEAD'], dir), base: git(['rev-parse', 'HEAD~1'], dir) };
}

describe('audit snapshot - input census (real openai-audit.mjs under an fs-trace preload)', () => {
  it('every cwd-relative path the audit touches before its first model call is declared in the census', () => {
    const f = fixture();
    const snap = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'census', tmpDir: os.tmpdir() });
    const trace = path.join(f.dir, 'trace.json');
    try {
      assert.equal(createSnapshot({ repoRoot: f.dir, sha: f.head, dir: snap }).ok, true);
      fs.writeFileSync(path.join(snap, '.auditignore'), 'vendor/**\n'); // as `snapshot create` copies an untracked one in
      const intent = path.join(f.dir, 'intent.md');
      fs.writeFileSync(intent, '# Stated intent\n\nfeat: two\n');
      // EMPTY, not deleted: the CLI refills an unset variable from .env / ~/.audit-loop.env and would start a paid audit.
      const env = {
        ...process.env, FS_TRACE_OUT: trace, LEARNING_DISABLE: '1', MODEL_CATALOG_REFRESH: 'skip', AUDIT_DB_URL: '', AUDIT_NO_PREFLIGHT: '1',
        AUDIT_ALLOW_FOREIGN_CWD: '1', OPENAI_API_KEY: '', AZURE_OPENAI_ENDPOINT: '', AZURE_OPENAI_API_KEY: '', GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '',
      };
      const r = spawnSync(process.execPath, [
        '--import', pathToFileURL(path.join(ROOT, 'tests', 'helpers', 'fs-trace.mjs')).href,
        path.join(ROOT, 'scripts', 'openai-audit.mjs'), 'code', '--planless', intent, '--scope', 'diff', '--base', f.base,
      ], { cwd: snap, env, encoding: 'utf8', timeout: 120_000 });
      assert.equal(r.status, 1, r.stderr);
      assert.match(r.stderr, /OPENAI_API_KEY environment variable required/, 'stopped at the credential gate, before any model call');
      const touched = JSON.parse(fs.readFileSync(trace, 'utf8'));
      // Positive control: the tracer saw the one input this fixture planted, so an empty undeclared list is not a blind tracer.
      assert.ok(touched.includes('.auditignore'), `the tracer must see .auditignore: ${touched.join(', ')}`);
      const undeclared = touched.filter((p) => !declared(p));
      assert.deepEqual(undeclared, [], 'an input read from cwd with no declared snapshot policy - add it to D2\'s census');
    } finally { removeSnapshot({ repoRoot: f.dir, dir: snap }); rmrf(f.dir); }
  });
  it('NEGATIVE CONTROL: the matcher rejects a path the census does not declare', () => {
    assert.equal(declared('secrets/creds.json'), false);
    assert.equal(declared('.audit-loop/domain-deps-observed.json'), false);
    assert.equal(declared('.audit/anything'), true);
  });
  it('repository identity survives the snapshot: the same owner/repo and uuid as the checkout (no second repo row)', () => {
    const f = fixture();
    const snap = snapshotPath({ prefix: CONSUMER_SNAPSHOT_PREFIX, tag: 'identity', tmpDir: os.tmpdir() });
    try {
      assert.equal(createSnapshot({ repoRoot: f.dir, sha: f.head, dir: snap }).ok, true);
      const inCheckout = resolveRepoIdentity(f.dir);
      const inSnapshot = resolveRepoIdentity(snap);
      assert.equal(inCheckout.source, 'origin-url');
      assert.deepEqual({ uuid: inSnapshot.repoUuid, name: inSnapshot.name }, { uuid: inCheckout.repoUuid, name: inCheckout.name });
    } finally { removeSnapshot({ repoRoot: f.dir, dir: snap }); rmrf(f.dir); }
  });
});
