/**
 * @fileoverview Unit tests for the ownership-aware command-invocation rewriter.
 * Plan §2 KD #4. Idempotency N=10, ownership-aware semantics, JSON walking,
 * exception path-map round-trip.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  rewriteTextCommandInvocations,
  rewriteJsonCommandInvocations,
  rewriteCommandSurface,
  buildOwnedSourceTails,
  buildOwnedSourceTailsFromConsumerManifest,
} from '../scripts/lib/sync-rewriter.mjs';

const OWNED = new Set([
  'openai-audit.mjs',
  'cross-skill.mjs',
  'lib/redact.mjs',
  'symbol-index/drift.mjs',
]);

const CFG = { ownedSourceTails: OWNED };

test('rewriter rewrites a known owned invocation', () => {
  const input = 'Run `node scripts/openai-audit.mjs --out foo.json`';
  const out = rewriteTextCommandInvocations(input, CFG);
  assert.equal(out, 'Run `node scripts/.claude-skills/openai-audit.mjs --out foo.json`');
});

test('rewriter handles subdir invocation', () => {
  const out = rewriteTextCommandInvocations('node scripts/lib/redact.mjs --selfcheck', CFG);
  assert.equal(out, 'node scripts/.claude-skills/lib/redact.mjs --selfcheck');
});

test('rewriter preserves consumer-owned invocations', () => {
  const input = 'node scripts/automated-tests.js';
  assert.equal(rewriteTextCommandInvocations(input, CFG), input);
});

test('rewriter no-ops on already-isolated path', () => {
  const input = 'node scripts/.claude-skills/openai-audit.mjs';
  assert.equal(rewriteTextCommandInvocations(input, CFG), input);
});

test('idempotency N=10: rewriter(rewriter(content)) === rewriter(content)', () => {
  const input = `
    Pipeline:
    1. node scripts/openai-audit.mjs --out foo.json
    2. node scripts/symbol-index/drift.mjs --json
    3. node scripts/automated-tests.js  (consumer file — must not rewrite)
    See scripts/lib/redact.mjs:42 for details (prose ref, must not rewrite)
  `;
  let current = input;
  for (let i = 0; i < 10; i++) {
    const next = rewriteTextCommandInvocations(current, CFG);
    if (i > 0) assert.equal(next, current, `instability at iteration ${i + 1}`);
    current = next;
  }
});

test('rewriter does NOT rewrite documentation references in prose', () => {
  // No "node" prefix → not a command. Stays as documentation reference.
  const input = 'See scripts/openai-audit.mjs:42 for the implementation';
  assert.equal(rewriteTextCommandInvocations(input, CFG), input);
});

test('rewriter handles multiple invocations on one line', () => {
  const input = 'node scripts/openai-audit.mjs && node scripts/symbol-index/drift.mjs';
  const out = rewriteTextCommandInvocations(input, CFG);
  assert.equal(out, 'node scripts/.claude-skills/openai-audit.mjs && node scripts/.claude-skills/symbol-index/drift.mjs');
});

test('R3 H2: trailing quote does not get glued onto the rewritten tail', () => {
  // Shell or embedded-code form: `cmd "node scripts/X.mjs"` — the regex must
  // stop at the closing quote, not consume it.
  assert.equal(
    rewriteTextCommandInvocations('echo "node scripts/openai-audit.mjs"', CFG),
    'echo "node scripts/.claude-skills/openai-audit.mjs"',
  );
  assert.equal(
    rewriteTextCommandInvocations("alias x='node scripts/openai-audit.mjs'", CFG),
    "alias x='node scripts/.claude-skills/openai-audit.mjs'",
  );
});

test('rewriter throws TypeError when config is missing', () => {
  assert.throws(() => rewriteTextCommandInvocations('foo', {}), TypeError);
  assert.throws(() => rewriteTextCommandInvocations('foo', { ownedSourceTails: [] }), TypeError);
});

test('rewriter throws TypeError when content is not a string', () => {
  assert.throws(() => rewriteTextCommandInvocations(42, CFG), TypeError);
});

test('JSON rewriter walks nested structures', () => {
  const tree = {
    hooks: {
      preCommit: { command: 'node scripts/openai-audit.mjs --quick' },
      ignored: ['node scripts/automated-tests.js'],
    },
  };
  const out = rewriteJsonCommandInvocations(tree, CFG);
  assert.equal(out.hooks.preCommit.command, 'node scripts/.claude-skills/openai-audit.mjs --quick');
  // Consumer-owned path: untouched.
  assert.equal(out.hooks.ignored[0], 'node scripts/automated-tests.js');
});

test('JSON rewriter does not mutate input', () => {
  const tree = { cmd: 'node scripts/openai-audit.mjs' };
  const orig = JSON.stringify(tree);
  rewriteJsonCommandInvocations(tree, CFG);
  assert.equal(JSON.stringify(tree), orig);
});

test('rewriteCommandSurface dispatches .md to text', () => {
  const result = rewriteCommandSurface({
    relPath: 'foo/bar.md',
    content: 'node scripts/openai-audit.mjs',
    config: CFG,
  });
  assert.equal(result.changed, true);
  assert.equal(result.hits, 1);
  assert.match(String(result.rewritten), /\.claude-skills\/openai-audit\.mjs/);
});

test('rewriteCommandSurface dispatches .json to JSON', () => {
  const result = rewriteCommandSurface({
    relPath: 'foo/config.json',
    content: '{"cmd":"node scripts/openai-audit.mjs"}',
    config: CFG,
  });
  assert.equal(result.changed, true);
  assert.match(String(result.rewritten), /\.claude-skills\/openai-audit\.mjs/);
});

test('rewriteCommandSurface passthrough on unknown extension', () => {
  const result = rewriteCommandSurface({
    relPath: 'foo/bar.bin',
    content: 'node scripts/openai-audit.mjs',
    config: CFG,
  });
  assert.equal(result.changed, false);
  assert.equal(result.rewritten, 'node scripts/openai-audit.mjs');
});

test('rewriteCommandSurface handles Buffer content', () => {
  const buf = Buffer.from('node scripts/openai-audit.mjs', 'utf-8');
  const result = rewriteCommandSurface({
    relPath: 'foo.md',
    content: buf,
    config: CFG,
  });
  assert.equal(Buffer.isBuffer(result.rewritten), true);
  assert.match(result.rewritten.toString('utf-8'), /\.claude-skills\/openai-audit\.mjs/);
});

test('rewriteCommandSurface passthrough on malformed JSON', () => {
  const result = rewriteCommandSurface({
    relPath: 'foo.json',
    content: '{ malformed',
    config: CFG,
  });
  assert.equal(result.changed, false);
});

test('buildOwnedSourceTails from source-relative paths', () => {
  const tails = buildOwnedSourceTails([
    'scripts/openai-audit.mjs',
    'scripts/lib/redact.mjs',
    'scripts/.claude-skills/openai-audit.mjs',  // already isolated — should be filtered
    '.claude/skills/audit-code/SKILL.md',         // not scripts/ — filtered
  ]);
  assert.deepEqual([...tails].sort(), ['lib/redact.mjs', 'openai-audit.mjs']);
});

test('buildOwnedSourceTailsFromConsumerManifest (isolated layout)', () => {
  const manifest = {
    layout: 'isolated',
    files: {
      'scripts/.claude-skills/openai-audit.mjs': 'sha256:aaa',
      'scripts/.claude-skills/lib/redact.mjs': 'sha256:bbb',
      '.claude/skills/audit-code/SKILL.md': 'sha256:ccc',
    },
  };
  const tails = buildOwnedSourceTailsFromConsumerManifest(manifest);
  assert.deepEqual([...tails].sort(), ['lib/redact.mjs', 'openai-audit.mjs']);
});

test('buildOwnedSourceTailsFromConsumerManifest (legacy layout)', () => {
  const manifest = {
    layout: 'legacy',
    files: {
      'scripts/openai-audit.mjs': 'sha256:aaa',
      'scripts/lib/redact.mjs': 'sha256:bbb',
      '.claude/skills/audit-code/SKILL.md': 'sha256:ccc',
    },
  };
  const tails = buildOwnedSourceTailsFromConsumerManifest(manifest);
  assert.deepEqual([...tails].sort(), ['lib/redact.mjs', 'openai-audit.mjs']);
});

test('verifier consumer-derivation equals source-derivation (round-trip invariant)', () => {
  const sourcePaths = [
    'scripts/openai-audit.mjs',
    'scripts/lib/redact.mjs',
    'scripts/symbol-index/drift.mjs',
  ];
  const sourceSide = buildOwnedSourceTails(sourcePaths);
  const manifest = {
    layout: 'isolated',
    files: Object.fromEntries(sourcePaths.map((p) => [
      p.replace('scripts/', 'scripts/.claude-skills/'),
      'sha256:x',
    ])),
  };
  const consumerSide = buildOwnedSourceTailsFromConsumerManifest(manifest);
  assert.deepEqual([...sourceSide].sort(), [...consumerSide].sort());
});
