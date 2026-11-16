/**
 * Harness retro — the committed decision registry (plan §2 c12).
 *
 * The first block validates the REAL `.harness-retro/decisions.json`: every
 * `enforced` entry's test must exist, be collected by `npm test`, and reference
 * the entry's identity — the mechanical form of "a fix ships with a check proving
 * it fires". The rest are red-then-green controls proving that validation bites.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readRegistry, validateRegistry, appendDecision, activationFor, summaryProblems, RegistrySchema, decisionIndex,
} from '../scripts/lib/friction/retro/registry.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FP = 'abcdef0123456789';
const entry = (over = {}) => ({
  identity: `fingerprint:${FP}`, evidenceFingerprints: [FP], fingerprintVersion: 1, kind: 'hook_error', tool: 'UserPromptSubmit',
  decision: 'enforced', layer: 'gate', test: 'tests/fake-guard.test.mjs', summary: 'hook commands must not use a relative path', decidedAt: '2026-11-16', ...over,
});
function tempRepo(testBody) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-reg-'));
  fs.mkdirSync(path.join(dir, 'tests'));
  if (testBody !== undefined) fs.writeFileSync(path.join(dir, 'tests', 'fake-guard.test.mjs'), testBody);
  return dir;
}

describe('the committed registry', () => {
  it('parses and validates (every enforced entry has a collected test naming its identity)', () => {
    const reg = readRegistry(REPO);
    assert.deepEqual(validateRegistry({ registry: reg, repoRoot: REPO }), []);
  });
});

describe('validateRegistry — controls', () => {
  it('green: a test that references the fingerprint', () => {
    const dir = tempRepo(`it('fires on ${FP}', () => {});\n`);
    assert.deepEqual(validateRegistry({ registry: { version: 1, decisions: [entry()] }, repoRoot: dir }), []);
  });
  it('red: the test does not reference the fingerprint', () => {
    const dir = tempRepo('// nothing here\nit(\'x\', () => {});\n');
    assert.match(validateRegistry({ registry: { version: 1, decisions: [entry()] }, repoRoot: dir })[0], /string literal/);
  });
  it('red: a comment-only mention of the fingerprint does not count', () => {
    const dir = tempRepo(`// guards ${FP}\nit('x', () => {});\n`);
    assert.match(validateRegistry({ registry: { version: 1, decisions: [entry()] }, repoRoot: dir })[0], /string literal/);
  });
  it('red: a file with no executable case', () => {
    const dir = tempRepo(`const id = '${FP}';\n`);
    assert.match(validateRegistry({ registry: { version: 1, decisions: [entry()] }, repoRoot: dir })[0], /no it\(\)\/test\(\) case/);
  });
  it('red: the test is missing', () => {
    assert.match(validateRegistry({ registry: { version: 1, decisions: [entry()] }, repoRoot: tempRepo() })[0], /does not exist/);
  });
  it('red: the test is outside what npm test collects', () => {
    assert.match(validateRegistry({ registry: { version: 1, decisions: [entry({ test: 'scripts/x.mjs' })] }, repoRoot: tempRepo('x') })[0], /npm test collects/);
  });
  it('red: a public summary carrying a path or email', () => {
    assert.ok(summaryProblems('fails at C:\\Users\\bob\\x').length > 0);
    assert.ok(summaryProblems('ask bob@corp.com').length > 0);
    assert.deepEqual(summaryProblems('hook commands use a relative path'), []);
  });
  it('a tripwire identity must be named by its test', () => {
    const dir = tempRepo("it('tripwire:feedback_hook_path fires', () => {});\n");
    const t = entry({ identity: 'tripwire:feedback_hook_path', evidenceFingerprints: [FP, 'bbbbbbbbbbbbbbbb'], memory: 'feedback_hook_path' });
    assert.deepEqual(validateRegistry({ registry: { version: 1, decisions: [t] }, repoRoot: dir }), []);
  });
});

describe('schema', () => {
  it('an enforced decision without a layer or test is refused', () => {
    assert.equal(RegistrySchema.safeParse({ version: 1, decisions: [entry({ layer: undefined })] }).success, false);
  });
  it('a fingerprint identity must be its own first evidence fingerprint', () => {
    assert.equal(RegistrySchema.safeParse({ version: 1, decisions: [entry({ evidenceFingerprints: ['bbbbbbbbbbbbbbbb'] })] }).success, false);
  });
  it('decisionIndex maps every evidence fingerprint', () => {
    const idx = decisionIndex({ version: 1, decisions: [entry({ identity: 'tripwire:m', evidenceFingerprints: [FP, 'bbbbbbbbbbbbbbbb'] })] });
    assert.equal(idx.byFingerprint.get('bbbbbbbbbbbbbbbb').identity, 'tripwire:m');
  });
});

describe('appendDecision', () => {
  it('refuses an entry whose test does not qualify — the write boundary enforces the rules too', async () => {
    await assert.rejects(appendDecision(tempRepo(), entry()), { code: 'REGISTRY_INVALID' });
    await assert.rejects(appendDecision(tempRepo(`it('${FP}', () => {});\n`), entry({ summary: 'mail bob@corp.com about it' })), { code: 'REGISTRY_INVALID' });
  });

  it('appends once, idempotent on identity, and concurrent appends serialise', async () => {
    const dir = tempRepo(`it('${FP} bbbbbbbbbbbbbbbb', () => {});\n`);
    const [a, b] = await Promise.all([
      appendDecision(dir, entry()),
      appendDecision(dir, entry({ identity: 'fingerprint:bbbbbbbbbbbbbbbb', evidenceFingerprints: ['bbbbbbbbbbbbbbbb'] })),
    ]);
    assert.ok(a.appended && b.appended);
    assert.equal((await appendDecision(dir, entry())).appended, false);
    assert.equal(readRegistry(dir).decisions.length, 2);
  });
});

describe('activationFor — landing time only', () => {
  const log = (line) => () => line;
  it('a GitHub-created merge/squash commit is its own landing time', () => {
    const r = activationFor('fingerprint:x', { runGit: log('sha1\t2026-11-01T10:00:00Z\tnoreply@github.com\n') });
    assert.deepEqual(r, { status: 'active', at: '2026-11-01T10:00:00Z', provenance: 'github-merge-commit', commit: 'sha1' });
  });
  it('a locally-created commit needs the PR merged_at', () => {
    const r = activationFor('fingerprint:x', { runGit: log('sha2\t2026-10-01T00:00:00Z\tdev@x.y\n'), runGh: () => '2026-11-02T09:00:00Z\n', repoSlug: 'o/r' });
    assert.equal(r.provenance, 'pr-merged-at'); assert.equal(r.at, '2026-11-02T09:00:00Z');
  });
  it('a rebased commit with no PR lookup is unknown — never its commit date', () => {
    assert.equal(activationFor('fingerprint:x', { runGit: log('sha3\t2026-10-01T00:00:00Z\tdev@x.y\n') }).status, 'unknown');
  });
  it('not on main yet → pending-merge; git unavailable → unknown', () => {
    assert.equal(activationFor('fingerprint:x', { runGit: log('') }).status, 'pending-merge');
    assert.equal(activationFor('fingerprint:x', { runGit: () => null }).status, 'unknown');
  });
});
