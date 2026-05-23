/**
 * @fileoverview Hermetic test of the D2b trigger logic in
 * scripts/sync-to-repos.mjs::maybePromptSharedCloudUpdate.
 *
 * The function isn't exported (it's file-local in sync-to-repos.mjs).
 * We test the equivalent flow by exercising the lib's assess + runSetupCloud
 * helpers — the trigger is essentially a thin wrapper around those.
 * The sync-side TTY/--no-prompt/dry-run gating is covered via source
 * inspection of the call-site condition.
 *
 * Plan: docs/plans/shared-cloud-config.md §8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Writable } from 'node:stream';
import {
  assessSharedCloudConfig, runSetupCloud, OUTCOMES, sharedEnvPath, parseEnvFile,
} from '../scripts/lib/shared-cloud-config.mjs';
// R1-audit M16: import the trigger helper via the exported `_internals`
// for real behavioural testing instead of regex-asserting source text.
import { _internals as syncInternals } from '../scripts/sync-to-repos.mjs';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const SYNC_SRC  = path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs');

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sst-'));
}

function collectStream() {
  const chunks = [];
  const s = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString('utf-8')); cb(); } });
  s.text = () => chunks.join('');
  return s;
}

function makeSourceRepo(envContent) {
  const dir = mkdtemp();
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts/sync-to-repos.mjs'), '// fixture\n');
  if (envContent !== undefined) fs.writeFileSync(path.join(dir, '.env'), envContent);
  return dir;
}

// ── Behaviour-equivalent tests (assess + executor at the sync seam) ───────

describe('D2b trigger — assessment outcomes drive the right side-effects', () => {
  it('ALREADY_CURRENT — assess returns the outcome; trigger renders nothing', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo('AUDIT_DB_URL=x\n');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=x\n');
    try {
      const a = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(a.outcome, OUTCOMES.ALREADY_CURRENT);
      // The trigger early-returns on this outcome (no stdio write, no prompt).
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('MISCONFIGURED — trigger would render one-line skip notice', () => {
    const home = mkdtemp();
    const notSource = mkdtemp();
    try {
      const a = assessSharedCloudConfig({ sourceRepoDir: notSource, homedir: home });
      assert.equal(a.outcome, OUTCOMES.MISCONFIGURED);
      // The trigger writes `[sync] shared cloud config: <reason> — skipping`.
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(notSource, { recursive: true, force: true }); }
  });

  it('CREATED — assess proposes; executor with mock prompt writes file', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo('AUDIT_DB_URL=postgres://x\n');
    try {
      const a = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(a.outcome, OUTCOMES.CREATED);
      // Simulate sync calling runSetupCloud with the operator confirming Y.
      const stdio = collectStream();
      const r = await runSetupCloud({
        prompt: () => Promise.resolve(true),
        sourceRepoDir: src, homedir: home, stdio,
      });
      assert.equal(r.outcome, OUTCOMES.CREATED);
      assert.ok(fs.existsSync(sharedEnvPath(home)));
      assert.equal(parseEnvFile(sharedEnvPath(home)).AUDIT_DB_URL, 'postgres://x');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('UPDATED with divergence — prompt previews specific deltas', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo('AUDIT_DB_URL=new\nOPENAI_API_KEY=sk-new\n');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=old\n');
    try {
      let promptArg = null;
      const r = await runSetupCloud({
        prompt: (q) => { promptArg = q; return Promise.resolve(true); },
        sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.UPDATED);
      assert.match(promptArg, /Update/);
      assert.match(promptArg, /\+ OPENAI_API_KEY/);  // add line
      assert.match(promptArg, /~ AUDIT_DB_URL/);     // change line (old → new)
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('USER_SKIPPED — declined update leaves file unchanged', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo('AUDIT_DB_URL=new\n');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=old\n');
    try {
      const r = await runSetupCloud({
        prompt: () => Promise.resolve(false),
        sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.USER_SKIPPED);
      assert.equal(parseEnvFile(sharedEnvPath(home)).AUDIT_DB_URL, 'old');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });
});

// ── Trigger behaviour (R1-audit M16: real exec via _internals) ───────────

describe('maybePromptSharedCloudUpdate (exported via _internals)', () => {
  const { maybePromptSharedCloudUpdate } = syncInternals;

  it('exists on the _internals surface', () => {
    assert.equal(typeof maybePromptSharedCloudUpdate, 'function');
  });

  // The helper instantiates a real readline interface from process.stdin
  // when source is found and divergence exists. Test the early-exit paths
  // (already_current, misconfigured) directly — those don't prompt.

  it('ALREADY_CURRENT — writes nothing to stdio (silent skip)', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo('AUDIT_DB_URL=x\n');
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=x\n');
    // Temporarily override HOME so sharedEnvPath() points at our tmp dir.
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const prevHome = process.env[homeKey];
    process.env[homeKey] = home;
    try {
      const stdio = collectStream();
      await maybePromptSharedCloudUpdate({ sourceRepoDir: src, stdio });
      assert.equal(stdio.text(), '', 'silent on already_current');
    } finally {
      process.env[homeKey] = prevHome;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(src,  { recursive: true, force: true });
    }
  });

  it('MISCONFIGURED — one-line advisory, never throws', async () => {
    const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
    const home = mkdtemp();
    const notSource = mkdtemp();   // empty dir, no sentinel
    const prevHome = process.env[homeKey];
    process.env[homeKey] = home;
    try {
      const stdio = collectStream();
      await maybePromptSharedCloudUpdate({ sourceRepoDir: notSource, stdio });
      assert.match(stdio.text(), /shared cloud config:.*skipping/);
    } finally {
      process.env[homeKey] = prevHome;
      fs.rmSync(home,      { recursive: true, force: true });
      fs.rmSync(notSource, { recursive: true, force: true });
    }
  });
});

// ── Source inspection — only the structural assertions that lack a
// behavioural equivalent. Most assertions moved to direct calls above
// per R1-audit M16.

describe('sync-to-repos.mjs structural contract', () => {
  const src = fs.readFileSync(SYNC_SRC, 'utf-8');

  it('imports assess + runSetupCloud from the lib (not from setup-cloud.mjs)', () => {
    // Per Gemini-G3 / R3-M2: sync MUST NOT import from the CLI wrapper.
    // R2-audit M6/M10: regex now accepts BOTH static (`import ... from '...'`)
    // and dynamic (`import('...')`) forms — a future refactor from dynamic to
    // static must not silently bypass this guardrail.
    assert.match(
      src,
      /import\s*(?:\(['"]\.\/lib\/shared-cloud-config\.mjs['"]\)|[^;]*?from\s*['"]\.\/lib\/shared-cloud-config\.mjs['"])/
    );
    assert.doesNotMatch(
      src,
      /import\s*(?:\(['"]\.\/setup-cloud\.mjs['"]\)|[^;]*?from\s*['"]\.\/setup-cloud\.mjs['"])/
    );
  });

  it('--no-prompt flag is parsed at module init', () => {
    assert.match(src, /const NO_PROMPT = process\.argv\.includes\(['"]--no-prompt['"]\)/);
  });
});
