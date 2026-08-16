// Tier 1: the D3a declarative arm manifest CLI contract — §9a acceptance
// checklist case 5 (--candidate + --manifest exclusivity) and case 6 (a
// sensitive subject path refuses at load, zero provider calls).
//
// Real subprocess, real CLI — but every case here fails BEFORE any provider
// call (argv validation, manifest schema, path refusal), so this needs no
// API key and spends nothing. A case that reaches provider resolution
// belongs in a manual/live verification, not this suite.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'model-eval-auditor.mjs');

const VALID_CONTROLS = {
  reasoningEffort: 'medium', promptTemplateId: 'auditor-v1', outputSchemaId: 'auditor-v1',
  maxOutputTokens: 4096, toolPolicy: 'none', temperature: 0,
  passes: ['structure'], scope: 'diff', rounds: 1,
};

function manifest(overrides = {}) {
  return {
    schemaVersion: 1, id: 'test-manifest', role: 'auditor',
    decision: { type: 'select_default', incumbent: 'latest-gpt' },
    arms: [
      { id: 'gpt', model: 'latest-gpt', mode: 'primary' },
      { id: 'other', model: 'latest-sonnet', mode: 'shadow' },
    ],
    controls: VALID_CONTROLS,
    ...overrides,
  };
}

const dirs = [];
after(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ } }
});

function writeManifest(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-manifest-'));
  dirs.push(dir);
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

function run(args, opts = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000, ...opts,
  });
}

describe('model-eval-auditor.mjs --manifest — CLI contract (§9a case 5)', () => {
  it('--candidate and --manifest together exit 2, before any provider call', () => {
    const mPath = writeManifest(manifest());
    const r = run(['--candidate', '{"kind":"sentinel","value":"latest-gpt"}', '--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /mutually exclusive/);
  });

  it('NEGATIVE CONTROL: --manifest alone (no --candidate) does not hit that refusal', () => {
    // Proves the check above fires on the COMBINATION, not on --manifest's
    // mere presence — otherwise the exclusivity test would be vacuous.
    // Deliberately a manifest that fails schema validation (1 scored arm, not
    // 2) so this stays a free, pre-provider-call check like every other case
    // in this file; a manifest that PASSED validation would reach the real
    // arm loop and spend money, which this suite must never do.
    //
    // Cluster B fix-gate (R2): asserting ONLY the absence of "mutually
    // exclusive" was too weak — an unrelated crash (an import failure, an
    // arg-parser regression) would satisfy it just as well, so it could not
    // actually distinguish "the exclusivity check correctly did not fire"
    // from "something else broke first". Pinning the SAME exit code and
    // failure reason the dedicated cardinality test above already expects
    // makes this a real assertion about reaching manifest validation, not
    // just an absence check.
    const mPath = writeManifest(manifest({ arms: [{ id: 'solo', model: 'latest-gpt', mode: 'primary' }] }));
    const r = run(['--manifest', mPath, '--tier', 'screen']);
    assert.doesNotMatch(r.stderr, /mutually exclusive/);
    assert.equal(r.status, 2, `expected the cardinality refusal to fire, got status ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, />= 2 scored arms/, 'must fail for the cardinality reason specifically, not any other early error');
  });

  it('a manifest with the WRONG role reaches the role check, not just schema validation', () => {
    // Distinct from the manifest-schema-invalid case below: this manifest's
    // `controls` block is VALID for final_review_shadow (its own schema), so
    // parseComparisonManifest succeeds and the failure is specifically this
    // CLI's own "wrong role for THIS driver" refusal, not a generic parse error.
    const mPath = writeManifest(manifest({
      role: 'final_review_shadow',
      decision: { type: 'select_default', incumbent: 'latest-gpt' },
      controls: {
        reasoningEffort: 'medium', promptTemplateId: 'x', outputSchemaId: 'x',
        maxOutputTokens: 100, toolPolicy: 'none', temperature: 0, envelopeScope: 'thin',
      },
    }));
    const r = run(['--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
    // D7a (plan: comparison-tooling-consolidation.md) made the manifest
    // driver role-generic — the refusal is now against the EXECUTORS
    // registry, not a hardcoded 'auditor' literal. final_review_shadow has a
    // registry entry (for SUPPORTED_ROLES <-> EXECUTORS coverage) but
    // deliberately no executeArm, and must refuse AT LOAD — before minting
    // any model_eval_comparisons row — not per-arm after one is minted.
    assert.match(r.stderr, /no synchronous executor/);
    assert.match(r.stderr, /final_review_shadow/);
  });

  it('neither --candidate nor --manifest: exit 1 with a usage line naming BOTH forms', () => {
    const r = run(['--tier', 'screen']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--candidate/);
    assert.match(r.stderr, /--manifest/);
  });

  it('--manifest naming a nonexistent file: preflight failure, exit 2', () => {
    const r = run(['--manifest', path.join(os.tmpdir(), 'definitely-does-not-exist.json'), '--tier', 'screen']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /preflight failed \(bad_manifest\)/);
  });

  it('--manifest with malformed JSON: preflight failure, exit 2', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-manifest-'));
    dirs.push(dir);
    const p = path.join(dir, 'bad.json');
    fs.writeFileSync(p, '{ not json');
    const r = run(['--manifest', p, '--tier', 'screen']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /bad_manifest/);
  });

  // Cluster B fix-gate (R5) — a second wrong-role test used to live here
  // ('a manifest declaring the WRONG role refuses by name, not a generic
  // parse error'), constructing a near-identical final_review_shadow
  // manifest and asserting the exact same status/stderr pair as the test
  // above ('a manifest with the WRONG role reaches the role check, not just
  // schema validation'). Unlike the R3 pair this finding was first mistaken
  // for (one hitting schema validation, one hitting the role check — a real
  // distinction), BOTH of these used a schema-VALID final_review_shadow
  // controls block and hit the SAME role-check code path — genuinely
  // redundant, not a deliberate two-layer pin. Removed rather than kept as
  // apparent extra coverage that verifies nothing extra.

  it('a manifest with fewer than 2 scored arms refuses at schema validation, zero provider calls', () => {
    const mPath = writeManifest(manifest({
      arms: [{ id: 'solo', model: 'latest-gpt', mode: 'primary' }],
      decision: { type: 'select_default', incumbent: 'latest-gpt' },
    }));
    const r = run(['--manifest', mPath, '--tier', 'screen']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, />= 2 scored arms/);
  });

  // §9a acceptance case 6 — "A manifest naming a symlink into a sensitive
  // target — refused at load, zero provider calls, non-zero exit."
  //
  // Two tests, because they check different facts. The first is the LEXICAL
  // case (the manifest names the sensitive path directly) — cheap, but it
  // does not exercise symlink resolution at all, so it cannot tell "we refuse
  // sensitive names" apart from "we refuse sensitive TARGETS", which is what
  // the acceptance criterion actually says and what INC-001 was about (a link
  // named innocently, resolving somewhere else). A Cluster B fix-gate audit
  // caught this gap directly: mirroring the fix already made once for this
  // exact class in tests/comparison-paths.test.mjs (the INC-001 regression
  // test that, pre-fix, also only asserted the error CLASS against a
  // developer's own possibly-absent ~/.ssh).
  it('§9a case 6a: a manifest declaring a LEXICALLY sensitive subject.corpusPath refuses at load, zero provider calls', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-manifest-sensitive-'));
    dirs.push(dir);
    // The target need not even exist to classify as sensitive — the pattern
    // match is on the NAME. This also means the assertion cannot be confused
    // with "file not found": a distinct, later preflight class.
    const mPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(mPath, JSON.stringify(manifest({ subject: { corpusPath: '.ssh/id_rsa' } })));
    const r = run(['--manifest', mPath, '--tier', 'screen', '--repo-roots', REPO_ROOT]);
    assert.equal(r.status, 2, `expected refusal before any provider call, got status ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /manifest_path_refused/);
    assert.match(r.stderr, /sensitive/i);
    // Zero provider calls: nothing in stderr indicates an arm was spawned —
    // the refusal happens before the scored-arm loop even starts.
    assert.doesNotMatch(r.stderr, /running arm/);
  });

  it('§9a case 6b: a manifest declaring an INNOCENTLY-NAMED symlink INTO a sensitive target refuses on the target, not the visible name', (t) => {
    // The actual INC-001 shape: the manifest names something ordinary; only
    // resolving the link reveals where it really points. Must live INSIDE the
    // repo (resolveLocalPath's containment check), so the target's basename —
    // not its directory — is what carries the sensitive classification.
    const targetDir = fs.mkdtempSync(path.join(REPO_ROOT, '.audit', `auditor-manifest-target-${process.pid}-`));
    dirs.push(targetDir);
    const targetAbs = path.join(targetDir, 'id_rsa');
    fs.writeFileSync(targetAbs, 'not a real key');
    const linkDir = fs.mkdtempSync(path.join(REPO_ROOT, '.audit', `auditor-manifest-link-${process.pid}-`));
    dirs.push(linkDir);
    const linkAbs = path.join(linkDir, 'innocent-corpus.json');
    try {
      fs.symlinkSync(targetAbs, linkAbs);
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }
    const linkRel = path.relative(REPO_ROOT, linkAbs).split(path.sep).join('/');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-manifest-sensitive-link-'));
    dirs.push(dir);
    const mPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(mPath, JSON.stringify(manifest({ subject: { corpusPath: linkRel } })));
    const r = run(['--manifest', mPath, '--tier', 'screen', '--repo-roots', REPO_ROOT]);
    assert.equal(r.status, 2, `expected refusal before any provider call, got status ${r.status}\nstderr: ${r.stderr}`);
    assert.match(r.stderr, /manifest_path_refused/);
    assert.match(r.stderr, /sensitive/i, 'must refuse on the resolved TARGET, not the innocent visible name');
    assert.doesNotMatch(r.stderr, /running arm/);
  });

  it('a manifest declaring an ABSOLUTE subject path refuses — manifest paths are repo-relative', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-manifest-abs-'));
    dirs.push(dir);
    const mPath = path.join(dir, 'manifest.json');
    const absPath = path.join(dir, 'x.json').split(path.sep).join('/');
    fs.writeFileSync(mPath, JSON.stringify(manifest({ subject: { corpusPath: absPath } })));
    const r = run(['--manifest', mPath, '--tier', 'screen', '--repo-roots', REPO_ROOT]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /manifest_path_refused/);
  });
});
