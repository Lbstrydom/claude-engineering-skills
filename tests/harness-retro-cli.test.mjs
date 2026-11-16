/**
 * Harness retro CLI — end to end, cross-process, over a synthetic account config
 * dir (plan docs/plans/harness-retro.md §9 Proof plan).
 *
 * Every run is hermetic: a temp git repo (with an origin, so it has a stable
 * identity) is the checkout, a temp CLAUDE_CONFIG_DIR holds fixture transcripts,
 * FRICTION_MEMORY_DIR points at a temp memory dir, and an EMPTY AUDIT_DB_URL is
 * the air-gap signal — cloud off, so nothing can reach a store.
 *
 * Tier-3 egress: a planted secret and a planted user sentence must not appear in
 * any artifact the CLI writes.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'harness-retro.mjs');
const SECRET = `sk-ant-api03-${'Z9'.repeat(24)}`;
const USER_SENTENCE = 'no, my private plan is codename-bluefinch';

function gitRepo(origin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-repo-'));
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', windowsHide: true });
  g('init', '-q'); g('remote', 'add', 'origin', origin);
  return fs.realpathSync(dir);
}

const now = Date.now();
const ts = (minsAgo) => new Date(now - minsAgo * 60_000).toISOString();
function session({ cwd, error = 'Error: Cannot find module X', extra = [], minsAgo = 60 }) {
  return [
    { type: 'user', origin: { kind: 'human' }, cwd, timestamp: ts(minsAgo), version: '2.1.322', message: { content: 'do the thing' } },
    { type: 'assistant', cwd, timestamp: ts(minsAgo - 1), message: { content: [{ type: 'tool_use', id: 'toolu_aaaaaaaa1', name: 'Bash', input: { command: 'x' } }] } },
    { type: 'user', cwd, timestamp: ts(minsAgo - 2), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_aaaaaaaa1', is_error: true, content: error }] } },
    ...extra,
  ];
}
function writeSession(configDir, slug, id, records) {
  const d = path.join(configDir, 'projects', slug);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${id}.jsonl`), `${records.map((r) => JSON.stringify(r)).join('\n')}\n`);
}

function run(args, { cwd, configDir, memoryDir, stdin } = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    cwd, input: stdin, encoding: 'utf8', windowsHide: true, timeout: 120_000,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir, FRICTION_MEMORY_DIR: memoryDir, AUDIT_DB_URL: '', CLAUDE_BACKEND: 'sdk' },
  });
  let json = null;
  try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

describe('harness-retro CLI', () => {
  let repo; let other; let configDir; let memoryDir;
  before(() => {
    repo = gitRepo('https://github.com/example/retro-fixture.git');
    other = gitRepo('https://github.com/example/other-repo.git');
    configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-cfg-'));
    memoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-mem-'));
    fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), '- [Missing module](feedback_missing_module.md) — cannot find module X keeps recurring\n');
    fs.writeFileSync(path.join(memoryDir, 'feedback_missing_module.md'), '---\nname: feedback_missing_module\ndescription: Error Cannot find module X when a hook path is relative\nmetadata:\n  type: feedback\n---\nbody\n');
  });

  it('an empty account is UNMEASURED with a reason — never a clean result', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-empty-'));
    const r = run(['scan', '--json'], { cwd: repo, configDir: empty, memoryDir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.measured, false);
    assert.equal(r.json.reason, 'no-transcripts');
  });

  it('detects the recurring failure, excludes other-repo and unresolved sessions, and persists nothing cloud-off', () => {
    const slug = 'C--fixture';
    for (const id of ['s1', 's2', 's3']) {
      writeSession(configDir, slug, id, session({
        cwd: repo,
        extra: id === 's1' ? [
          { type: 'user', origin: { kind: 'human' }, cwd: repo, timestamp: ts(50), message: { content: USER_SENTENCE } },
          { type: 'assistant', cwd: repo, timestamp: ts(49), message: { content: [{ type: 'tool_use', id: 'toolu_bbbbbbbb2', name: 'Bash', input: {} }] } },
          { type: 'user', cwd: repo, timestamp: ts(48), message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bbbbbbbb2', is_error: true, content: `Error: auth failed with ${SECRET}` }] } },
        ] : [],
      }));
    }
    writeSession(configDir, slug, 's4', session({ cwd: repo, error: 'Error: a one-off thing broke' }));
    writeSession(configDir, 'C--other', 's5', session({ cwd: other }));
    writeSession(configDir, 'C--tmp', 's6', session({ cwd: path.join(os.tmpdir(), 'not-a-repo-xyz') }));

    const r = run(['scan', '--json', '--persist'], { cwd: repo, configDir, memoryDir });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json.measured, true);
    assert.equal(r.json.candidates.length, 1);
    assert.equal(r.json.candidates[0].sessions, 3);
    assert.equal(r.json.excluded.otherRepo, 1);
    assert.equal(r.json.excluded.unresolved, 1);
    // one-offs: s4's error, s1's secret-bearing error, and s1's correction (kind kept, words dropped)
    assert.equal(r.json.summary.oneOffs, 3);
    assert.equal(r.json.persisted, false);
    assert.equal(r.json.persistReason, 'cloud-off');
    assert.equal(r.json.promotionCandidates[0]?.identity, 'tripwire:feedback_missing_module');

    // Egress: nothing the CLI wrote carries the planted secret or the human's words.
    const dir = path.join(repo, '.audit', 'harness-retro');
    for (const f of fs.readdirSync(dir)) {
      const body = fs.readFileSync(path.join(dir, f), 'utf8');
      assert.ok(!body.includes('Z9Z9Z9Z9'), `${f} leaked the secret`);
      assert.ok(!body.includes('bluefinch'), `${f} leaked user text`);
    }
    assert.ok(!r.stdout.includes('bluefinch'));
  });

  it('record (a second process) validates proposals against the scan', () => {
    const scan = JSON.parse(fs.readFileSync(path.join(repo, '.audit', 'harness-retro',
      fs.readdirSync(path.join(repo, '.audit', 'harness-retro')).filter((f) => f.startsWith('scan-')).sort().pop()), 'utf8'));
    const c = scan.candidates[0];
    const proposal = (sessions) => JSON.stringify({ scanId: scan.scanId, proposals: [{
      identity: c.identity, verdict: 'propose',
      failurePrevented: { summary: 'a missing module recurs across sessions', sessions, occurrences: c.occurrences },
      layer: 'gate', change: { files: ['scripts/x.mjs'], description: 'resolve the module path from the project dir' },
      positiveControl: { test: 'tests/x.test.mjs', assertion: 'a relative module path fails the test' },
      coordinatorChore: false,
    }] });
    const bad = run(['record', '--scan', 'latest'], { cwd: repo, configDir, memoryDir, stdin: proposal(99) });
    assert.equal(bad.code, 1);
    assert.match(bad.json.problems[0], /claims 99 sessions, scan has 3/);
    const good = run(['record', '--scan', 'latest'], { cwd: repo, configDir, memoryDir, stdin: proposal(3) });
    assert.equal(good.code, 0, good.stderr);
    assert.equal(good.json.recorded, 1);
    assert.ok(fs.existsSync(path.join(repo, good.json.report)));
  });

  it('a transcript that parses but holds no conversation is format-unrecognised', () => {
    const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'retro-cli-fmt-'));
    writeSession(cfg, 'C--x', 'm1', [{ type: 'queue-operation', operation: 'enqueue', timestamp: ts(5) }]);
    const r = run(['scan', '--json'], { cwd: repo, configDir: cfg, memoryDir });
    assert.equal(r.json.measured, false);
    assert.equal(r.json.reason, 'format-unrecognised');
  });

  it('effect with no enforced decision says so (unmeasured), and status reports the heartbeat', () => {
    const e = run(['effect'], { cwd: repo, configDir, memoryDir });
    assert.equal(e.json.measured, false);
    assert.match(e.json.reason, /no enforced decisions/);
    const s = run(['status'], { cwd: repo, configDir, memoryDir });
    assert.equal(s.json.ok, true);
    assert.equal(s.json.heartbeat.stale, false);
  });

  it('the STORE payload carries exactly the allowlisted keys and no transcript text', async () => {
    const { buildSessionSnapshot } = await import('../scripts/harness-retro.mjs');
    const { SNAPSHOT_KEYS, OCCURRENCE_KEYS, SessionSnapshotSchema } = await import('../scripts/lib/store/harness-retro.mjs');
    const dir = path.join(repo, '.audit', 'harness-retro');
    const scan = JSON.parse(fs.readFileSync(path.join(dir, fs.readdirSync(dir).filter((f) => f.startsWith('scan-')).sort()[0]), 'utf8'));
    for (const s of scan.sessions) {
      const snap = buildSessionSnapshot(scan, s);
      assert.deepEqual(Object.keys(snap).sort(), [...SNAPSHOT_KEYS].sort());
      for (const o of snap.occurrences) assert.deepEqual(Object.keys(o).sort(), [...OCCURRENCE_KEYS].sort());
      assert.ok(SessionSnapshotSchema.safeParse(snap).success);
      const body = JSON.stringify(snap);
      assert.ok(!body.includes('Z9Z9Z9Z9') && !body.includes('bluefinch') && !body.includes('Cannot find module'), body);
    }
  });

  it('usage errors exit 2', () => {
    assert.equal(run(['nope'], { cwd: repo, configDir, memoryDir }).code, 2);
    assert.equal(run(['scan', '--since', 'yesterday'], { cwd: repo, configDir, memoryDir }).code, 2);
  });
});
