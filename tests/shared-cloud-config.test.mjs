/**
 * @fileoverview Hermetic tests for scripts/lib/shared-cloud-config.mjs.
 * No real filesystem outside mkdtemp; no real prompts (injected).
 *
 * Plan: docs/plans/shared-cloud-config.md §8.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import {
  SHARED_VARS, REQUIRED_VARS, OUTCOMES, EXIT_CODE_FOR,
  sharedEnvPath, discoverLocalEnvPath,
  parseEnvText, parseEnvFile, serializeEnvValue,
  diffSharedEnv, writeSharedEnv, resolveCloudConfig,
  resolveSourceRepo, assessSharedCloudConfig, runSetupCloud,
  formatDeltaPreview, _internals,
} from '../scripts/lib/shared-cloud-config.mjs';

function mkdtemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scc-'));
}

function collectStream() {
  const chunks = [];
  const s = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString('utf-8')); cb(); } });
  s.text = () => chunks.join('');
  return s;
}

// Build a fake "source repo" — a dir containing scripts/sync-to-repos.mjs
// (the deterministic source-repo sentinel) + optionally a .env file.
function makeSourceRepo(opts = {}) {
  const dir = mkdtemp();
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'sync-to-repos.mjs'), '// fixture\n');
  if (opts.env !== undefined) fs.writeFileSync(path.join(dir, '.env'), opts.env);
  return dir;
}

// ── Constants + exit-code mapping ──────────────────────────────────────────

describe('OUTCOMES + EXIT_CODE_FOR alignment', () => {
  it('every OUTCOMES value has an EXIT_CODE_FOR entry', () => {
    for (const v of Object.values(OUTCOMES)) {
      assert.ok(EXIT_CODE_FOR[v] !== undefined, `missing exit code for outcome ${v}`);
      assert.equal(typeof EXIT_CODE_FOR[v], 'number');
    }
  });
  it('SHARED_VARS contains REQUIRED_VARS', () => {
    for (const k of REQUIRED_VARS) assert.ok(SHARED_VARS.includes(k));
  });
});

// ── Parser + serializer round-trip ────────────────────────────────────────

describe('parseEnvText / serializeEnvValue', () => {
  it('parseEnvText matches dotenv.parse semantics', () => {
    const txt = 'KEY1=plain\nKEY2="quoted value"\n# comment\nKEY3=\n';
    const parsed = parseEnvText(txt);
    assert.equal(parsed.KEY1, 'plain');
    assert.equal(parsed.KEY2, 'quoted value');
    assert.equal(parsed.KEY3, '');
  });

  it('serializeEnvValue passes through plain alphanumerics', () => {
    assert.equal(serializeEnvValue('abc-123_xyz'), 'abc-123_xyz');
    assert.equal(serializeEnvValue('postgres://u:p@host:5432/db?ssl=true'), 'postgres://u:p@host:5432/db?ssl=true');
  });

  it('serializeEnvValue quotes values with whitespace/special chars', () => {
    assert.equal(serializeEnvValue('hello world'), '"hello world"');
    // Values containing `"` use single-quote wrap (dotenv-lossless).
    assert.equal(serializeEnvValue('has"quote'), `'has"quote'`);
    assert.equal(serializeEnvValue('has\nnewline'), '"has\\nnewline"');
    assert.equal(serializeEnvValue('has\\backslash'), '"has\\\\backslash"');
  });

  it('round-trip: write + parse returns original value (cases dotenv supports)', () => {
    // dotenv parses `\n` and `\\` in double-quoted, treats single-quoted as
    // literal. Values containing `"` use single-quote wrap (lossless).
    // Gemini-r3 fix: values with BOTH `"` and `'` now use bare emission
    // (dotenv reads unquoted values verbatim until newline) — see the
    // dedicated mixed-quote round-trip test below.
    for (const v of ['plain', 'has space', 'has"quote', 'multi\nline', 'symbols$#@!', 'mixed-_+/=:?&%@.~']) {
      const serialized = serializeEnvValue(v);
      const parsed = parseEnvText(`X=${serialized}\n`);
      assert.equal(parsed.X, v, `round-trip failed for: ${JSON.stringify(v)} (serialized as: ${serialized})`);
    }
  });

  it('round-trip: mixed-quote values via bare emission (Gemini-r3 fix)', () => {
    // Empirically: dotenv reads unquoted values verbatim until newline,
    // so a value like `has"both'quotes` is losslessly representable as
    // `VAR=has"both'quotes` (no outer quotes). Critical safety: the value
    // must NOT trigger dotenv's quoted-form parser (no leading `"` / `'`),
    // must not contain newlines, and must not have surrounding whitespace.
    for (const v of [
      `mix"and'inside`,
      `pre"and'and"more'end`,
      `has"and'and-dashes`,
    ]) {
      const serialized = serializeEnvValue(v);
      const parsed = parseEnvText(`X=${serialized}\n`);
      assert.equal(parsed.X, v, `mixed-quote round-trip failed for: ${JSON.stringify(v)} (serialized as: ${JSON.stringify(serialized)})`);
    }
  });

  it('throws on mixed-quote values that have bare-form blockers (newline / `#` / leading quote / surrounding WS)', () => {
    // These values are GENUINELY unrepresentable: bare form would be
    // mis-tokenised (truncated at `#`, mis-quoted-form-parsed, or split
    // across lines), and both quote wraps would be lossy.
    assert.throws(() => serializeEnvValue(`has"both'and\nnewline`),       /bare-form blocker/);
    assert.throws(() => serializeEnvValue(`has"both'and#hash`),           /bare-form blocker/);
    assert.throws(() => serializeEnvValue(`"leading-quote-and'inside`),    /bare-form blocker/);
    assert.throws(() => serializeEnvValue(` leading-WS-with"both'quotes`), /bare-form blocker/);
    assert.throws(() => serializeEnvValue(`trailing-WS-with"both'quotes `),/bare-form blocker/);
  });
});

// ── isSourceRepo via _internals + resolveSourceRepo ───────────────────────

describe('resolveSourceRepo', () => {
  // R2-audit M2/M8: tagged-union return contract — every call returns
  // {type: 'resolved'|'invalid-override'|'none'|'ambiguous', ...}. Branches
  // are explicit at the call site; no more null-vs-object polymorphism.
  it('returns {type:"none"} when no candidate has the sentinel', () => {
    const dir = mkdtemp();
    try {
      const r = resolveSourceRepo({ cwd: dir });
      assert.deepEqual(r, { type: 'none' });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('accepts cwd if it has the sentinel file', () => {
    const dir = makeSourceRepo();
    try {
      const r = resolveSourceRepo({ cwd: dir });
      assert.equal(r.type, 'resolved');
      assert.equal(r.path, dir);
      assert.equal(r.source, 'cwd');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('explicit flag pointing at non-source returns {type:"invalid-override"} (R2-audit H3)', () => {
    // H3: an explicit override must NOT silently fall through to cwd/sibling
    // discovery — the operator told us where the source is; if they're wrong
    // we surface that as a distinct misconfiguration reason.
    const notSource = mkdtemp();
    try {
      const r = resolveSourceRepo({ explicitFlag: notSource });
      assert.equal(r.type, 'invalid-override');
      assert.equal(r.source, 'flag');
      assert.equal(r.value, notSource);
    } finally { fs.rmSync(notSource, { recursive: true, force: true }); }
  });

  it('finds sibling source repo when cwd is not source itself', () => {
    const parent = mkdtemp();
    const sibling = path.join(parent, 'source-repo');
    fs.mkdirSync(sibling);
    fs.mkdirSync(path.join(sibling, 'scripts'));
    fs.writeFileSync(path.join(sibling, 'scripts/sync-to-repos.mjs'), '// fixture\n');
    const cwd = path.join(parent, 'consumer-repo');
    fs.mkdirSync(cwd);
    try {
      const r = resolveSourceRepo({ cwd });
      assert.equal(r.type, 'resolved');
      assert.equal(r.path, sibling);
      assert.equal(r.source, 'sibling');
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it('isSourceRepo rejects a consumer-repo with the OTHER synced files but no sync-to-repos.mjs', () => {
    // Consumer repos have scripts/openai-audit.mjs + scripts/install-prepush-hook.mjs
    // but NEVER scripts/sync-to-repos.mjs. Make sure the sentinel rejects them.
    const dir = mkdtemp();
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.writeFileSync(path.join(dir, 'scripts/openai-audit.mjs'), '// synced\n');
    fs.writeFileSync(path.join(dir, 'scripts/install-prepush-hook.mjs'), '// synced\n');
    try {
      assert.equal(_internals.isSourceRepo(dir), false);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── diffSharedEnv ─────────────────────────────────────────────────────────

describe('diffSharedEnv add/change/remove/unchanged', () => {
  it('identical files → all unchanged', () => {
    const a = mkdtemp(), b = mkdtemp();
    try {
      fs.writeFileSync(path.join(a, '.env'), 'AUDIT_DB_URL=x\n');
      fs.writeFileSync(path.join(b, '.env'), 'AUDIT_DB_URL=x\n');
      const r = diffSharedEnv({ sharedPath: path.join(a, '.env'), sourcePath: path.join(b, '.env') });
      assert.deepEqual(r.add, {});
      assert.deepEqual(r.change, {});
      assert.deepEqual(r.remove, {});
      assert.deepEqual(r.unchanged, { AUDIT_DB_URL: 'x' });
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it('add: source has key, shared does not', () => {
    const a = mkdtemp(), b = mkdtemp();
    try {
      fs.writeFileSync(path.join(a, '.env'), '');                        // shared empty
      fs.writeFileSync(path.join(b, '.env'), 'AUDIT_DB_URL=new\n');      // source has it
      const r = diffSharedEnv({ sharedPath: path.join(a, '.env'), sourcePath: path.join(b, '.env') });
      assert.deepEqual(r.add, { AUDIT_DB_URL: 'new' });
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it('change: same key, different value', () => {
    const a = mkdtemp(), b = mkdtemp();
    try {
      fs.writeFileSync(path.join(a, '.env'), 'AUDIT_DB_URL=old\n');
      fs.writeFileSync(path.join(b, '.env'), 'AUDIT_DB_URL=new\n');
      const r = diffSharedEnv({ sharedPath: path.join(a, '.env'), sourcePath: path.join(b, '.env') });
      assert.deepEqual(r.change, { AUDIT_DB_URL: { from: 'old', to: 'new' } });
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it('remove: shared has key, source removed it (revocation propagates)', () => {
    const a = mkdtemp(), b = mkdtemp();
    try {
      fs.writeFileSync(path.join(a, '.env'), 'AUDIT_DB_URL=x\nOPENAI_API_KEY=stale\n');
      fs.writeFileSync(path.join(b, '.env'), 'AUDIT_DB_URL=x\n');
      const r = diffSharedEnv({ sharedPath: path.join(a, '.env'), sourcePath: path.join(b, '.env') });
      assert.deepEqual(r.remove, { OPENAI_API_KEY: 'stale' });
      assert.deepEqual(r.unchanged, { AUDIT_DB_URL: 'x' });
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });

  it('ignores keys outside SHARED_VARS', () => {
    const a = mkdtemp(), b = mkdtemp();
    try {
      fs.writeFileSync(path.join(a, '.env'), 'CUSTOM_X=preserved\n');
      fs.writeFileSync(path.join(b, '.env'), 'CUSTOM_X=different\nAUDIT_DB_URL=x\n');
      const r = diffSharedEnv({ sharedPath: path.join(a, '.env'), sourcePath: path.join(b, '.env') });
      // CUSTOM_X is unmanaged — appears in NONE of the buckets.
      assert.equal(r.add.CUSTOM_X, undefined);
      assert.equal(r.change.CUSTOM_X, undefined);
      assert.equal(r.unchanged.CUSTOM_X, undefined);
      assert.deepEqual(r.add, { AUDIT_DB_URL: 'x' });
    } finally { fs.rmSync(a, { recursive: true, force: true }); fs.rmSync(b, { recursive: true, force: true }); }
  });
});

// ── writeSharedEnv ────────────────────────────────────────────────────────

describe('writeSharedEnv', () => {
  it('writes file and parses back identically', () => {
    const dir = mkdtemp();
    const file = path.join(dir, '.audit-loop.env');
    try {
      writeSharedEnv(file, { AUDIT_DB_URL: 'postgres://a:b@h:5432/d', OPENAI_API_KEY: 'sk-xxx' });
      assert.ok(fs.existsSync(file));
      const parsed = parseEnvFile(file);
      assert.equal(parsed.AUDIT_DB_URL, 'postgres://a:b@h:5432/d');
      assert.equal(parsed.OPENAI_API_KEY, 'sk-xxx');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves unmanaged keys across updates', () => {
    const dir = mkdtemp();
    const file = path.join(dir, '.audit-loop.env');
    try {
      fs.writeFileSync(file, 'AUDIT_DB_URL=old\nMY_CUSTOM_VAR=keepme\n');
      writeSharedEnv(file, { AUDIT_DB_URL: 'new' });
      const parsed = parseEnvFile(file);
      assert.equal(parsed.AUDIT_DB_URL, 'new');
      assert.equal(parsed.MY_CUSTOM_VAR, 'keepme', 'unmanaged key must survive update');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('removes managed keys not in desired set (revocation)', () => {
    const dir = mkdtemp();
    const file = path.join(dir, '.audit-loop.env');
    try {
      fs.writeFileSync(file, 'AUDIT_DB_URL=x\nOPENAI_API_KEY=revokeme\n');
      // Only AUDIT_DB_URL in desired → OPENAI_API_KEY should be dropped.
      writeSharedEnv(file, { AUDIT_DB_URL: 'x' });
      const parsed = parseEnvFile(file);
      assert.equal(parsed.AUDIT_DB_URL, 'x');
      assert.equal(parsed.OPENAI_API_KEY, undefined, 'revoked managed key must be removed');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('chmod 0600 on POSIX', { skip: process.platform === 'win32' && 'POSIX only' }, () => {
    const dir = mkdtemp();
    const file = path.join(dir, '.audit-loop.env');
    try {
      writeSharedEnv(file, { AUDIT_DB_URL: 'x' });
      const mode = fs.statSync(file).mode & 0o777;
      assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ── resolveCloudConfig precedence ─────────────────────────────────────────

describe('resolveCloudConfig (Gemini-G2 differ-check)', () => {
  it('local wins when peSet but peVal === localVal (loader-injected duplication)', () => {
    const dir = mkdtemp(), shared = mkdtemp();
    try {
      fs.writeFileSync(path.join(dir, '.env'), 'AUDIT_DB_URL=fromfile\n');
      const r = resolveCloudConfig({
        processEnv: { AUDIT_DB_URL: 'fromfile' },        // dotenv-copied
        localEnvPath: path.join(dir, '.env'),
        sharedPath: path.join(shared, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'local', 'must attribute to local when peVal matches localVal');
      assert.equal(r.AUDIT_DB_URL.value, 'fromfile');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(shared, { recursive: true, force: true }); }
  });

  it('shared wins when peSet but peVal === sharedVal AND local is unset', () => {
    const cwd = mkdtemp(), home = mkdtemp();
    try {
      fs.writeFileSync(path.join(cwd, '.env'), '');
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=fromshared\n');
      const r = resolveCloudConfig({
        processEnv: { AUDIT_DB_URL: 'fromshared' },
        localEnvPath: path.join(cwd, '.env'),
        sharedPath: path.join(home, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'shared');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('process-env wins when peVal differs from both files (genuine external override)', () => {
    const cwd = mkdtemp(), home = mkdtemp();
    try {
      fs.writeFileSync(path.join(cwd, '.env'), 'AUDIT_DB_URL=fromfile\n');
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=fromshared\n');
      const r = resolveCloudConfig({
        processEnv: { AUDIT_DB_URL: 'fromexport' },
        localEnvPath: path.join(cwd, '.env'),
        sharedPath: path.join(home, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'process-env');
      assert.equal(r.AUDIT_DB_URL.value, 'fromexport');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('process-env wins when files empty + peSet (external-only)', () => {
    const cwd = mkdtemp(), home = mkdtemp();
    try {
      const r = resolveCloudConfig({
        processEnv: { AUDIT_DB_URL: 'fromexport' },
        localEnvPath: path.join(cwd, '.env'),
        sharedPath: path.join(home, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'process-env');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('unset everywhere → source: "unset"', () => {
    const cwd = mkdtemp(), home = mkdtemp();
    try {
      const r = resolveCloudConfig({
        processEnv: {},
        localEnvPath: path.join(cwd, '.env'),
        sharedPath: path.join(home, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'unset');
      assert.equal(r.AUDIT_DB_URL.value, null);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });

  it('explicit empty string in process.env reports source:"process-env", value:"" (Gemini-r3-r4 G2)', () => {
    // `export AUDIT_DB_URL=""` is a deliberate override (e.g. disable cloud
    // for this shell). Previously the helper treated '' as unset and
    // silently fell through to file values, misreporting the source.
    const cwd = mkdtemp(), home = mkdtemp();
    try {
      fs.writeFileSync(path.join(cwd, '.env'), 'AUDIT_DB_URL=fromfile\n');
      fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=fromshared\n');
      const r = resolveCloudConfig({
        processEnv: { AUDIT_DB_URL: '' },
        localEnvPath: path.join(cwd, '.env'),
        sharedPath: path.join(home, '.audit-loop.env'),
      });
      assert.equal(r.AUDIT_DB_URL.source, 'process-env');
      assert.equal(r.AUDIT_DB_URL.value, '');
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// ── assessSharedCloudConfig outcomes ──────────────────────────────────────

describe('assessSharedCloudConfig', () => {
  it('MISCONFIGURED — explicit source repo path is not a source repo (R2-audit H3)', () => {
    // H3: explicit override pointing at non-source repo must surface as
    // `invalid-override`, not the generic `no-source-repo` — the operator
    // gave us a path; we owe them a specific error.
    const home = mkdtemp();
    const notSource = mkdtemp();   // empty dir, no sentinel
    try {
      const r = assessSharedCloudConfig({
        sourceRepoDir: notSource,  // explicit non-source path → invalid override
        homedir: home,
      });
      assert.equal(r.outcome, OUTCOMES.MISCONFIGURED);
      assert.equal(r.reason, 'invalid-override');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(notSource, { recursive: true, force: true }); }
  });

  it('MISCONFIGURED — source repo found but no .env', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo();
    try {
      const r = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(r.outcome, OUTCOMES.MISCONFIGURED);
      assert.equal(r.reason, 'source-env-missing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('MISCONFIGURED — source .env missing REQUIRED_VARS', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'OPENAI_API_KEY=sk\n' });   // no AUDIT_DB_URL
    try {
      const r = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(r.outcome, OUTCOMES.MISCONFIGURED);
      assert.equal(r.reason, 'source-missing-required');
      assert.deepEqual(r.missingRequired, ['AUDIT_DB_URL']);
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('CREATED — shared file absent, source has required vars', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=postgres://x\n' });
    try {
      const r = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(r.outcome, OUTCOMES.CREATED);
      assert.deepEqual(r.deltas.add, { AUDIT_DB_URL: 'postgres://x' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('ALREADY_CURRENT — shared file matches source', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=postgres://x\n' });
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=postgres://x\n');
    try {
      const r = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(r.outcome, OUTCOMES.ALREADY_CURRENT);
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('UPDATED — shared file diverges from source (add/change/remove)', () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=new\nGEMINI_API_KEY=gemini-new\n' });
    fs.writeFileSync(path.join(home, '.audit-loop.env'),
      'AUDIT_DB_URL=old\nOPENAI_API_KEY=stale\n');
    try {
      const r = assessSharedCloudConfig({ sourceRepoDir: src, homedir: home });
      assert.equal(r.outcome, OUTCOMES.UPDATED);
      assert.deepEqual(r.deltas.add, { GEMINI_API_KEY: 'gemini-new' });
      assert.deepEqual(r.deltas.change, { AUDIT_DB_URL: { from: 'old', to: 'new' } });
      assert.deepEqual(r.deltas.remove, { OPENAI_API_KEY: 'stale' });
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });
});

// ── runSetupCloud executor (prompts injected) ─────────────────────────────

describe('runSetupCloud executor', () => {
  it('ALREADY_CURRENT path: no prompt, no write, exit 0', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=x\n' });
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=x\n');
    try {
      let promptCalled = 0;
      const stdio = collectStream();
      const r = await runSetupCloud({
        prompt: () => { promptCalled++; return Promise.resolve(true); },
        sourceRepoDir: src, homedir: home, stdio,
      });
      assert.equal(r.outcome, OUTCOMES.ALREADY_CURRENT);
      assert.equal(r.exitCode, 0);
      assert.equal(promptCalled, 0);
      assert.match(stdio.text(), /in sync/);
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('CREATED with autoYes: no prompt, file written, exit 0', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=postgres://x\nOPENAI_API_KEY=sk\n' });
    try {
      let promptCalled = 0;
      const stdio = collectStream();
      const r = await runSetupCloud({
        prompt: () => { promptCalled++; return Promise.resolve(true); },
        autoYes: true, sourceRepoDir: src, homedir: home, stdio,
      });
      assert.equal(r.outcome, OUTCOMES.CREATED);
      assert.equal(promptCalled, 0);
      const parsed = parseEnvFile(sharedEnvPath(home));
      assert.equal(parsed.AUDIT_DB_URL, 'postgres://x');
      assert.equal(parsed.OPENAI_API_KEY, 'sk');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('UPDATED prompt accepted: file rewritten, exit 0', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=new\n' });
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=old\n');
    try {
      let promptArg = null;
      const r = await runSetupCloud({
        prompt: (q) => { promptArg = q; return Promise.resolve(true); },
        sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.UPDATED);
      assert.match(promptArg, /Update/);
      assert.match(promptArg, /old/);  // delta preview shows old → new
      const parsed = parseEnvFile(sharedEnvPath(home));
      assert.equal(parsed.AUDIT_DB_URL, 'new');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('USER_SKIPPED: prompt rejected, file unchanged, exit 0', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=new\n' });
    fs.writeFileSync(path.join(home, '.audit-loop.env'), 'AUDIT_DB_URL=old\n');
    try {
      const r = await runSetupCloud({
        prompt: () => Promise.resolve(false),
        sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.USER_SKIPPED);
      assert.equal(r.exitCode, 0);
      const parsed = parseEnvFile(sharedEnvPath(home));
      assert.equal(parsed.AUDIT_DB_URL, 'old', 'declined update must not write');
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('dryRun: prompt happens, file unchanged, exit 0', async () => {
    const home = mkdtemp();
    const src  = makeSourceRepo({ env: 'AUDIT_DB_URL=x\n' });
    try {
      const r = await runSetupCloud({
        autoYes: true, dryRun: true, sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.CREATED);
      assert.equal(r.dryRun, true);
      assert.equal(fs.existsSync(sharedEnvPath(home)), false);
    } finally { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(src, { recursive: true, force: true }); }
  });

  it('MISCONFIGURED: exit 4', async () => {
    const home = mkdtemp();
    try {
      const r = await runSetupCloud({
        autoYes: true,
        sourceRepoDir: '/nonexistent/path-xyz-abc',
        homedir: home, stdio: collectStream(),
      });
      assert.equal(r.outcome, OUTCOMES.MISCONFIGURED);
      assert.equal(r.exitCode, 4);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
});

// ── JSON output masking (dogfooding follow-up, post-/ship 2026-05-23) ─────
// `npm run setup:cloud -- --dry-run --yes --format json` was dumping
// cleartext OPENAI_API_KEY / GEMINI_API_KEY / ANTHROPIC_API_KEY values to
// stdout, defeating the chmod 0600 design of `~/.audit-loop.env`. The
// `formatDeltaPreview` human renderer already masked these; the JSON
// emitter did not. Closed by `_internals.maskDeltasForOutput`.

describe('JSON output secret masking (_internals.maskDeltasForOutput)', () => {
  it('masks SHARED_VARS values (LLM keys → ***, DSN → password masked)', () => {
    const masked = _internals.maskDeltasForOutput({
      add: {
        AUDIT_DB_URL:    'postgresql://user:supersecret@h.example:5432/db',
        OPENAI_API_KEY:  'sk-proj-LEAKED',
        GEMINI_API_KEY:  'AIza-LEAKED',
        ANTHROPIC_API_KEY: 'sk-ant-LEAKED',
      },
      change: {
        AUDIT_DB_URL_OTHER: { from: 'sk-old', to: 'sk-new' },  // unknown key → mask
        AUDIT_DB_URL:       { from: 'postgresql://u:oldpw@h:5432/db',
                              to:   'postgresql://u:newpw@h:5432/db' },
      },
      remove: { OLD_KEY: 'value' },
      unchanged: { OPENAI_API_KEY: 'sk-proj-original' },
    });
    // add: AUDIT_DB_URL keeps host + port (diagnostic value); password masked.
    assert.match(masked.add.AUDIT_DB_URL, /postgresql:\/\/user:\*\*\*@h\.example:5432\/db/);
    assert.equal(masked.add.OPENAI_API_KEY,    '***');
    assert.equal(masked.add.GEMINI_API_KEY,    '***');
    assert.equal(masked.add.ANTHROPIC_API_KEY, '***');
    // change: AUDIT_DB_URL from/to both masked.
    assert.match(masked.change.AUDIT_DB_URL.from, /postgresql:\/\/u:\*\*\*@h:5432\/db/);
    assert.match(masked.change.AUDIT_DB_URL.to,   /postgresql:\/\/u:\*\*\*@h:5432\/db/);
    assert.equal(masked.change.AUDIT_DB_URL_OTHER.from, '***');
    assert.equal(masked.change.AUDIT_DB_URL_OTHER.to,   '***');
    // remove: key reported (value not sensitive — it's already invalid in source).
    assert.deepEqual(masked.remove, { OLD_KEY: 'value' });
    // unchanged: masked too — raw secret in JSON stdout is still a leak.
    assert.equal(masked.unchanged.OPENAI_API_KEY, '***');
    // Crucially: no plaintext secret survives anywhere in the serialised form.
    const serialised = JSON.stringify(masked);
    assert.doesNotMatch(serialised, /sk-proj-LEAKED|AIza-LEAKED|sk-ant-LEAKED|supersecret|oldpw|newpw|sk-proj-original/);
  });

  it('runSetupCloud emits masked JSON (end-to-end via captured stdout)', async () => {
    // Hijack process.stdout.write to capture the JSON output, then run the
    // executor in dry-run mode and verify no secrets leak.
    const home = mkdtemp();
    const src  = mkdtemp();
    fs.mkdirSync(path.join(src, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(src, 'scripts/sync-to-repos.mjs'), '// fixture\n');
    fs.writeFileSync(path.join(src, '.env'),
      'AUDIT_DB_URL=postgresql://u:topsecret@h:5432/d\nOPENAI_API_KEY=sk-PLAINTEXT-LEAK\n');
    const captured = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk, ...rest) => {
      captured.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    };
    try {
      await runSetupCloud({
        autoYes: true, dryRun: true, format: 'json',
        sourceRepoDir: src, homedir: home, stdio: collectStream(),
      });
    } finally {
      process.stdout.write = origWrite;
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(src,  { recursive: true, force: true });
    }
    const out = captured.join('');
    // The JSON should parse cleanly.
    const parsed = JSON.parse(out);
    assert.equal(parsed.outcome, OUTCOMES.CREATED);
    assert.equal(parsed.dryRun, true);
    // Critical: no cleartext secret leaks.
    assert.doesNotMatch(out, /topsecret/);
    assert.doesNotMatch(out, /sk-PLAINTEXT-LEAK/);
    // Visible masking shape:
    assert.match(out, /postgresql:\/\/u:\*\*\*@h:5432\/d/);
    assert.match(out, /"OPENAI_API_KEY":\s*"\*\*\*"/);
  });
});
