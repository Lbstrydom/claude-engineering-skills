/**
 * @fileoverview Tier-1 (deterministic seam) tests for the harness-memory path
 * resolver + friction-frontmatter parser. Plan: friction-feedback-loop.md C1/C4.
 * Pure (no DB, no cloud): slug pinning, FRICTION_MEMORY_DIR override, `type:friction`
 * filtering, schema-validate-or-skip, absent-dir graceful, symlink refusal, and the
 * derived row fields (trgm_text / signature_text / fingerprint).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  harnessProjectSlug,
  resolveHarnessMemoryDir,
  parseFrictionMemories,
} from '../scripts/lib/memory-paths.mjs';

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'friction-mp-'));
}
function writeFm(dir, name, fm, body = 'why and how-to-avoid') {
  const yaml = (typeof fm === 'string') ? fm : require_yaml(fm);
  fs.writeFileSync(path.join(dir, `${name}.md`), `---\n${yaml}\n---\n\n${body}\n`);
}
// tiny inline yaml emitter to avoid importing yaml in the test (keep it black-box)
function require_yaml(obj) {
  // good enough for our flat frontmatter fixtures
  const lines = [];
  lines.push(`name: ${obj.name}`);
  lines.push(`description: ${obj.description}`);
  lines.push('metadata:');
  lines.push('  node_type: memory');
  lines.push(`  type: ${obj.type}`);
  if (obj.schema_version != null) lines.push(`  schema_version: ${obj.schema_version}`);
  if (obj.friction) {
    lines.push('  friction:');
    if (obj.friction.cost) lines.push(`    cost: ${obj.friction.cost}`);
    if (obj.friction.scope_tags) lines.push(`    scope_tags: [${obj.friction.scope_tags.join(', ')}]`);
    if (obj.friction.files) lines.push(`    files: [${obj.friction.files.join(', ')}]`);
  }
  return lines.join('\n');
}

// ── slug pinning (C4) ────────────────────────────────────────────────────────
test('harnessProjectSlug pins the verified live example', () => {
  assert.equal(
    harnessProjectSlug('C:\\GIT\\claude-engineering-skills'),
    'c--GIT-claude-engineering-skills',
  );
});

test('resolveHarnessMemoryDir honours the FRICTION_MEMORY_DIR override', () => {
  const tmp = mkTmp();
  const r = resolveHarnessMemoryDir({ env: { FRICTION_MEMORY_DIR: tmp } });
  assert.equal(r.dir, tmp);
  assert.equal(r.exists, true);
  assert.equal(r.source, 'env');
});

test('resolveHarnessMemoryDir is graceful on an absent dir (never throws)', () => {
  const r = resolveHarnessMemoryDir({ env: { FRICTION_MEMORY_DIR: path.join(os.tmpdir(), 'does-not-exist-xyz') } });
  assert.equal(r.exists, false);
});

// ── parse contract (C1/C5) ───────────────────────────────────────────────────
test('parseFrictionMemories: filters to type:friction, skips schema-invalid, ignores others', () => {
  const dir = mkTmp();
  // valid friction
  writeFm(dir, 'friction-good', {
    name: 'friction-good', description: 'A real papercut', type: 'friction',
    schema_version: 1, friction: { cost: 'L', scope_tags: ['consumer-sync'], files: ['scripts/x.mjs'] },
  });
  // friction but schema-invalid (no scope_tags)
  writeFm(dir, 'friction-bad', {
    name: 'friction-bad', description: 'missing tags', type: 'friction',
    schema_version: 1, friction: { cost: 'M' },
  });
  // a feedback note (ignored)
  writeFm(dir, 'feedback-note', { name: 'feedback-note', description: 'durable rule', type: 'feedback' });
  // MEMORY.md + a non-md file (ignored)
  fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- index\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'nope');

  const r = parseFrictionMemories(dir);
  assert.equal(r.scanComplete, true);
  assert.deepEqual(r.validRows.map((x) => x.memory_name), ['friction-good']);
  // both friction files are observed (so neither is tombstoned), feedback is not
  assert.ok(r.observedNames.includes('friction-good'));
  assert.ok(r.observedNames.includes('friction-bad'));
  assert.ok(!r.observedNames.includes('feedback-note'));
  assert.equal(r.skipped.find((s) => s.name === 'friction-bad')?.reason, 'schema-invalid');
});

test('parseFrictionMemories: derived fields (trgm/signature/fingerprint)', () => {
  const dir = mkTmp();
  writeFm(dir, 'friction-derived', {
    name: 'friction-derived', description: 'Cache Bug', type: 'friction',
    schema_version: 1, friction: { cost: 'M', scope_tags: ['false-green', 'X'] },
  }, 'Body Text Here');
  const r = parseFrictionMemories(dir);
  const row = r.validRows[0];
  assert.equal(row.title, 'Cache Bug');
  // trgm_text lowercased: title + body + tags
  assert.match(row.trgm_text, /cache bug/);
  assert.match(row.trgm_text, /body text here/);
  assert.match(row.trgm_text, /false-green/);
  // signature_text = title + tags (no body), lowercased
  assert.match(row.signature_text, /cache bug/);
  assert.match(row.signature_text, /false-green/);
  assert.ok(!row.signature_text.includes('body text here'));
  assert.equal(typeof row.fingerprint, 'string');
  assert.equal(row.fingerprint.length, 16);
});

test('parseFrictionMemories: absent dir → scanComplete:false, empty (graceful, no throw)', () => {
  const r = parseFrictionMemories(path.join(os.tmpdir(), 'no-such-friction-dir-zzz'));
  assert.equal(r.scanComplete, false);
  assert.deepEqual(r.validRows, []);
  assert.deepEqual(r.observedNames, []);
});
