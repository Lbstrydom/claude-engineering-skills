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

test('rewriter rewrites the /ship SKILL.md helper invocation to the consumer path (R2-H3)', () => {
  const cfg = { ownedSourceTails: new Set([...OWNED, 'ship-commit.mjs']) };
  const input = 'node scripts/ship-commit.mjs --message-file .claude/tmp/msg.txt --skill ship --models claude,gpt --gate passed';
  assert.equal(
    rewriteTextCommandInvocations(input, cfg),
    'node scripts/.claude-skills/ship-commit.mjs --message-file .claude/tmp/msg.txt --skill ship --models claude,gpt --gate passed',
  );
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

// ─────────────────────────────────────────────────────────────────────────────
// Upstream report c446e6c1 (wine-cellar-app, 2026-09-04).
//
// THE REPORTED CLAIM WAS FALSE, and measuring it is what found the real one.
// The report said this doc's runnable `node scripts/persona-consistency-run.mjs`
// examples reach a consumer naming upstream's layout. They do not:
// `rewriteCommandSurface` rewrites all three at sync time (measured 2026-09-06,
// hits: 3). What it does NOT rewrite is a path written as PROSE — COMMAND_REGEX
// requires a literal `node ` prefix — and `docs/reference/consistency-contract.md`
// carried exactly one, `scripts/lib/redact.mjs` at line 694.
//
// That file matters more than its one site suggests: it is the ONLY member of
// the sync closure that lands at a real, tracked, human-read consumer path
// (`docs/reference/consistency-contract.md`, unchanged by sync-path-map). Every
// other synced markdown file becomes `.claude/skills/**`, read by an agent that
// has the tooling dir. So a bare bundle path here is read by a consumer's own
// developers as their own documentation, and it is wrong for them.
//
// SCOPE, deliberately narrow. The same scan over `skills/**` finds 71 sites,
// and they are dominated by provenance prose and link text where naming the
// upstream path is CORRECT — "In the source repo the path is
// `scripts/setup-postgres.mjs`", or `/plan`'s instruction to write paths
// repo-relative. Rewriting those would corrupt true sentences, and ratcheting
// 71 judgement calls to catch ~1 defect is the over-built arm of the
// right-sizing fork. Scoped to the closure's non-skills docs the population is
// driven to ZERO, so this is a plain assertion with no baseline — the same
// reasoning `check-synced-doc-links.mjs` records for shipping at zero.
test('no synced consumer-read doc names a bundle path the sync will not rewrite', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { getSyncClosure } = await import('../scripts/lib/sync-inventory.mjs');
  const { COMMAND_REGEX } = await import('../scripts/lib/sync-rewriter.mjs');
  const ROOT = path.resolve(import.meta.dirname, '..');

  /**
   * Sites in one line that a consumer cannot resolve.
   *
   * Two exclusions, both of which are the PRESCRIBED REMEDY rather than the
   * disease — counting either would push the next author back to the broken
   * form (the trap `check-skill-consumer-refs.mjs` measured at 31% of its own
   * sites on 2026-09-04):
   *   - an absolute upstream URL, reachable by construction;
   *   - the LABEL of a markdown link whose href is such a URL. Detected by
   *     blanking URLs first, so the remedy's href collapses to `(   )` — a
   *     derived test, not a guess at which labels are innocent.
   * Plus spans the rewriter already fixes (`node scripts/…`).
   */
  const unresolvableSites = (raw, owned) => {
    const line = String(raw)
      // `[^\s)]+`, not `\S+`: a greedy match swallows the `)` closing a markdown
      // link, the href then never collapses to `(   )`, and the LABEL below is
      // flagged — a false positive on the very remedy this excludes. Caught by
      // the link negative control, which is why it is there.
      .replace(/https?:\/\/[^\s)]+/g, (u) => ' '.repeat(u.length))
      .replace(/\[[^\]\n]*\]\(\s*\)/g, (m) => ' '.repeat(m.length));
    const covered = [];
    for (const m of line.matchAll(new RegExp(COMMAND_REGEX.source, 'g'))) {
      covered.push([m.index, m.index + m[0].length]);
    }
    const out = [];
    for (const m of line.matchAll(/\bscripts\/([A-Za-z0-9_.\/-]+\.(?:mjs|js|sh|json|sql))/g)) {
      const tail = m[1];
      if (tail.startsWith('.claude-skills/')) continue;
      if (!owned.has(tail)) continue;
      if (covered.some(([s, e]) => m.index >= s && m.index < e)) continue;
      out.push(tail);
    }
    return out;
  };

  // ── Positive control. A detector that cannot fail cannot pass. This is the
  // literal pre-fix line 694; if the exclusions above ever widen enough to
  // swallow it, this fails before the subject scan reports a clean zero.
  assert.deepEqual(
    unresolvableSites(
      'to the external LLM, and content runs through `scripts/lib/redact.mjs`',
      new Set(['lib/redact.mjs']),
    ),
    ['lib/redact.mjs'],
    'detector no longer fires on the site this test exists for',
  );
  // ── Negative controls: each remedy must stay silent.
  for (const [label, text] of [
    ['absolute upstream URL', 'see https://github.com/o/r/blob/main/scripts/lib/redact.mjs for detail'],
    ['link whose href is that URL', '[`scripts/lib/redact.mjs`](https://github.com/o/r/blob/main/scripts/lib/redact.mjs)'],
    ['already-consumer path', 'synced to `scripts/.claude-skills/lib/redact.mjs`'],
    ['a command the rewriter fixes', 'run `node scripts/lib/redact.mjs --check`'],
  ]) {
    assert.deepEqual(unresolvableSites(text, new Set(['lib/redact.mjs'])), [], `false positive on ${label}`);
  }
  // A path this bundle does not own must never be rewritten or flagged.
  assert.deepEqual(unresolvableSites('`scripts/automated-tests.js`', new Set(['lib/redact.mjs'])), []);

  const closure = await getSyncClosure();
  const files = [...(closure.files || closure)].map(String);
  const owned = buildOwnedSourceTails(files);
  const subjects = files.filter(
    (f) => f.endsWith('.md') && !f.startsWith('skills/') && !f.startsWith('.claude/skills/'),
  );

  // ── Vacuous-pass guard. If the closure ever stops shipping a non-skills doc
  // — or stops shipping this one — the loop below passes having read nothing.
  assert.ok(subjects.length > 0, 'closure ships no consumer-read markdown; this test can no longer see its subject');
  assert.ok(
    subjects.includes('docs/reference/consistency-contract.md'),
    'the doc this guard was written for left the closure — re-point it, do not delete it',
  );

  const findings = [];
  for (const rel of subjects) {
    const txt = fs.readFileSync(path.join(ROOT, rel), 'utf-8');
    txt.split('\n').forEach((raw, i) => {
      for (const tail of unresolvableSites(raw, owned)) {
        findings.push(`${rel}:${i + 1} names scripts/${tail}, which a consumer has at scripts/.claude-skills/${tail}`);
      }
    });
  }
  assert.deepEqual(
    findings, [],
    'a consumer-read synced doc names a bundle path that does not exist at their layout.\n'
    + 'Remedy: an absolute upstream URL (plus the `scripts/.claude-skills/…` path in prose),\n'
    + 'as this doc already does at its schemas.mjs reference. Do NOT widen COMMAND_REGEX —\n'
    + 'it would rewrite provenance text that is correct as written.\n  '
    + findings.join('\n  '),
  );
});
