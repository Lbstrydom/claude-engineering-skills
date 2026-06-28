/**
 * @fileoverview Tier-2 (CLI invariants) + HARD sensitive-egress tests for the
 * friction `quality` commands. Plan: friction-feedback-loop.md §2b, §9.
 *
 * Uses the commands' dependency-injection seam (every command takes `(args, deps)`)
 * so no DB/cloud is required. The HARD egress tests prove the single choke-point
 * `sanitizeFrictionQueryInput` actually gates the DB-write path AND the breadcrumb
 * path: a high-confidence secret REFUSES the DB row; a secret in a returned title
 * is redacted before it reaches the breadcrumb.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  sanitizeFrictionQueryInput,
  frictionAdd,
  frictionMirror,
  frictionDigest,
  frictionLink,
  frictionSessionReview,
  frictionNeighbourhood,
  slugifyTitle,
} from '../scripts/lib/friction/commands.mjs';

const HIGH_CONF_SECRET = 'sk-abc1234567890ABCDEFGHIJKLMNOPQRSTUV';   // openai-key shape → REFUSE
const sampleRow = (over = {}) => ({
  memory_name: 'friction-x', source_hash: 'h', title: 'Cache bug', body_excerpt: 'body',
  scope_tags: ['false-green'], files: [], symbols: [], cost: 'M', fingerprint: 'f',
  trgm_text: 'cache bug body false-green', signature_text: 'cache bug false-green',
  mitigation_refs: [], ...over,
});

// ── §2b HARD: the choke-point itself ─────────────────────────────────────────
test('sanitizeFrictionQueryInput REFUSES a high-confidence secret (DB egress)', () => {
  const r = sanitizeFrictionQueryInput(sampleRow({ body_excerpt: `oops ${HIGH_CONF_SECRET}` }));
  assert.equal(r.ok, false);
  assert.equal(r.kind, 'refused');
  assert.ok(r.refusedFields.includes('body_excerpt'));
  assert.ok(r.events.length >= 1);
});

test('sanitizeFrictionQueryInput auto-redacts low-confidence PII (email)', () => {
  const r = sanitizeFrictionQueryInput(sampleRow({ body_excerpt: 'mail me at user@example.com please' }));
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'redacted');
  assert.match(r.sanitized.body_excerpt, /\[REDACTED-EMAIL\]/);
  assert.ok(!r.sanitized.body_excerpt.includes('user@example.com'));
});

test('sanitizeFrictionQueryInput drops a sensitive file path (.env), keeps normal ones', () => {
  const r = sanitizeFrictionQueryInput(sampleRow({ files: ['.env', 'scripts/ok.mjs'] }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.sanitized.files, ['scripts/ok.mjs']);
});

test('sanitizeFrictionQueryInput REFUSES when a mitigation_refs ref carries a secret', () => {
  const r = sanitizeFrictionQueryInput(sampleRow({
    mitigation_refs: [{ kind: 'doc', ref: `see ${HIGH_CONF_SECRET}` }],
  }));
  assert.equal(r.ok, false);
  assert.ok(r.refusedFields.some((f) => f.startsWith('mitigation_refs')));
});

// ── HARD: the DB-write path routes through the choke-point (mirror) ───────────
test('frictionMirror sends a secret-bearing row to skipped, never to upsert', async () => {
  const upserts = [];
  const r = await frictionMirror({}, {
    isCloudEnabled: async () => true,
    resolveHarnessMemoryDir: () => ({ dir: '/tmp/x', exists: true }),
    parseFrictionMemories: () => ({
      scanComplete: true,
      observedNames: ['friction-secret', 'friction-clean'],
      validRows: [
        sampleRow({ memory_name: 'friction-secret', body_excerpt: `leak ${HIGH_CONF_SECRET}`, source_hash: 's1' }),
        sampleRow({ memory_name: 'friction-clean', source_hash: 's2' }),
      ],
      skipped: [],
    }),
    resolveRepoForStore: async () => ({ repoRowId: 'r1' }),
    listFrictionSourceHashes: async () => new Map(),
    upsertFrictionRow: async (_repo, row) => { upserts.push(row); return { upserted: 1 }; },
    reconcileTombstones: async () => ({ tombstoned: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.upserted, 1);                                  // only the clean row
  assert.deepEqual(upserts.map((u) => u.memory_name), ['friction-clean']);
  assert.equal(r.skipped.find((s) => s.name === 'friction-secret')?.reason, 'secret-refused');
});

// ── HARD: the breadcrumb path routes through redaction (injection) ────────────
test('frictionNeighbourhood redacts the title before the breadcrumb', async () => {
  const crumbs = [];
  const r = await frictionNeighbourhood({ prompt: 'something about cache' }, {
    isCloudEnabled: async () => true,
    resolveRepoIdentity: () => ({ repoUuid: 'u1' }),
    getRepoIdByUuid: async () => ({ id: 'r1' }),
    storeFrictionNeighbourhood: async () => ([
      { memory_name: 'friction-leak', title: `boom ${HIGH_CONF_SECRET}`, cost: 'M' },
    ]),
    appendInjected: (rec) => { crumbs.push(rec); return { ok: true }; },
  });
  assert.equal(r.ok, true);
  assert.equal(crumbs.length, 1);
  assert.ok(!crumbs[0].title.includes(HIGH_CONF_SECRET));        // secret never hits the breadcrumb
  assert.match(crumbs[0].title, /REDACTED/);
});

// ── Tier-2: graceful cloud-off no-ops ────────────────────────────────────────
test('frictionMirror cloud-off → upserted:0, parse still runs', async () => {
  const r = await frictionMirror({}, {
    isCloudEnabled: async () => false,
    resolveHarnessMemoryDir: () => ({ dir: '/tmp/x', exists: true }),
    parseFrictionMemories: () => ({ scanComplete: true, observedNames: ['a'], validRows: [sampleRow()], skipped: [] }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.cloud, false);
  assert.equal(r.upserted, 0);
  assert.equal(r.scanComplete, true);          // parse ran
});

test('frictionMirror absent-dir → graceful, exists:false', async () => {
  const r = await frictionMirror({}, {
    isCloudEnabled: async () => true,
    resolveHarnessMemoryDir: () => ({ dir: '/tmp/none', exists: false }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.exists, false);
  assert.equal(r.upserted, 0);
});

test('frictionDigest cloud-off → clusters:[]', async () => {
  const r = await frictionDigest({}, { isCloudEnabled: async () => false });
  assert.deepEqual(r, { ok: true, cloud: false, clusters: [] });
});

test('frictionNeighbourhood cloud-off → records:[]', async () => {
  const r = await frictionNeighbourhood({ prompt: 'x' }, { isCloudEnabled: async () => false });
  assert.deepEqual(r, { ok: true, cloud: false, records: [] });
});

test('frictionNeighbourhood empty prompt → records:[]', async () => {
  const r = await frictionNeighbourhood({ prompt: '   ' }, { isCloudEnabled: async () => true });
  assert.deepEqual(r, { ok: true, cloud: true, records: [] });
});

// ── Tier-2: link is local-first (appends even cloud-off) ─────────────────────
test('frictionLink cloud-off appends to the file, mirrored:false', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'friction-link-'));
  const name = 'friction-link-me';
  fs.writeFileSync(path.join(dir, `${name}.md`),
    `---\nname: ${name}\ndescription: a bug\nmetadata:\n  node_type: memory\n  type: friction\n  schema_version: 1\n  friction:\n    cost: M\n    scope_tags: [x]\n    mitigation_refs: []\n---\n\nbody\n`);
  const r = await frictionLink({ memory: name, kind: 'commit', ref: 'deadbeef' }, {
    isCloudEnabled: async () => false,
    resolveHarnessMemoryDir: () => ({ dir, exists: true }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.appended, true);
  assert.equal(r.mirrored, false);
  const after = fs.readFileSync(path.join(dir, `${name}.md`), 'utf8');
  assert.match(after, /ref: deadbeef/);
  assert.match(after, /kind: commit/);
});

test('frictionLink rejects an invalid kind', async () => {
  const r = await frictionLink({ memory: 'x', kind: 'bogus', ref: 'y' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_INPUT');
});

// ── Tier-2: session-review reads the breadcrumb only ─────────────────────────
test('frictionSessionReview builds pending list from breadcrumb (cloud-off)', async () => {
  const r = await frictionSessionReview({}, {
    isCloudEnabled: async () => false,
    readRecent: () => ([{ ts: Date.now(), memory_name: 'friction-a', title: 'A', repo_id: 'r1' }]),
  });
  assert.equal(r.ok, true);
  assert.equal(r.pending.length, 1);
  assert.equal(r.pending[0].memory_name, 'friction-a');
  assert.match(r.pending[0].suggested_command, /quality link --memory friction-a/);
});

// ── H9: sanitize is allowlist-based (unlisted fields dropped) ────────────────
test('sanitizeFrictionQueryInput DROPS an unlisted field (allowlist, not copy-mutate)', () => {
  const r = sanitizeFrictionQueryInput(sampleRow({ raw_frontmatter: `secret ${HIGH_CONF_SECRET}`, notes: 'x' }));
  assert.equal(r.ok, true);
  assert.ok(!('raw_frontmatter' in r.sanitized));     // unlisted field never egresses
  assert.ok(!('notes' in r.sanitized));
  assert.ok('title' in r.sanitized);                  // allowlisted field kept
});

// ── H3/H7: path-traversal names rejected ─────────────────────────────────────
test('frictionAdd rejects a traversal --name', async () => {
  const r = await frictionAdd({ title: 'x', scopeTags: ['t'], name: '../../etc/evil' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_INPUT');
});

test('frictionLink rejects a traversal --memory', async () => {
  const r = await frictionLink({ memory: '../../etc/evil', kind: 'commit', ref: 'x' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'BAD_INPUT');
});

// ── H1: the injection prompt is redacted before the RPC ──────────────────────
test('frictionNeighbourhood redacts a secret in the prompt before the RPC', async () => {
  let seenPrompt = null;
  await frictionNeighbourhood({ prompt: `fix cache ${HIGH_CONF_SECRET}` }, {
    isCloudEnabled: async () => true,
    resolveRepoIdentity: () => ({ repoUuid: 'u1' }),
    getRepoIdByUuid: async () => ({ id: 'r1' }),
    storeFrictionNeighbourhood: async ({ prompt }) => { seenPrompt = prompt; return []; },
    appendInjected: async () => ({ ok: true }),
  });
  assert.ok(seenPrompt && !seenPrompt.includes(HIGH_CONF_SECRET));   // secret never reaches the query
  assert.match(seenPrompt, /REDACTED/);
});

// ── slug ─────────────────────────────────────────────────────────────────────
test('slugifyTitle produces a stable friction- prefixed kebab slug', () => {
  assert.equal(slugifyTitle('SW cache  busting!! before verify'), 'friction-sw-cache-busting-before-verify');
  assert.equal(slugifyTitle('   '), 'friction-note');
});
