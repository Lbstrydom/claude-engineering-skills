/**
 * The session-start advisory for a retired skill surface.
 *
 * Deliberately an ADVISORY, not a gate — machine state is not commit state, so
 * blocking would stop unrelated work without fixing the shadow
 * (docs/reference/skill-surface-ownership.md). That makes two properties
 * load-bearing, and they pull against each other:
 *
 *   1. SILENT when clean. A hook that speaks on every prompt gets muted, and a
 *      muted hook protects nothing.
 *   2. It must actually FIRE when a retired surface is present — the failure it
 *      exists to catch was previously misdiagnosed as "the tooling is not
 *      installed", costing a whole session its audit gates.
 *
 * And it must NEVER block: exit 0 on every path, including malformed input.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO_ROOT, '.claude', 'hooks', 'legacy-surface-advisory.mjs');

let tmp;
beforeEach(() => { tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-advisory-'))); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

/** Plant a receipt-recorded `.agents/skills/<name>` tree — the retired surface. */
function seedStaleAgentsSkill(root, name = 'ship') {
  const rel = `.agents/skills/${name}/SKILL.md`;
  const abs = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, 'stale copy\n');
  fs.writeFileSync(path.join(root, '.audit-loop-install-receipt.json'), JSON.stringify({
    receiptVersion: 1, bundleVersion: 't', sourceUrl: 't', surface: 'agents',
    installedAt: new Date(0).toISOString(),
    managedFiles: [{
      path: rel,
      sha: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex').slice(0, 12),
      skill: name, scope: 'repo',
    }],
  }, null, 2));
  return abs;
}

function runHook({ root = tmp, sessionId = 's-1', stdin = null, env = {} } = {}) {
  const payload = stdin ?? JSON.stringify({
    hook_event_name: 'UserPromptSubmit', session_id: sessionId, prompt: 'do a thing',
  });
  const r = spawnSync(process.execPath, [HOOK, '--repo-root', root], {
    input: payload, encoding: 'utf-8', env: { ...process.env, ...env },
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

describe('legacy-surface advisory — silent when there is nothing to say', () => {
  it('emits NOTHING on a clean tree', () => {
    const r = runHook();
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'a hook that speaks when clean gets muted, and a muted hook protects nothing');
  });

  it('writes no sentinel noise into a clean tree beyond its own marker', () => {
    runHook();
    // The sentinel dir is the only thing it may create, and it lives under the
    // gitignored `.audit/`.
    const entries = fs.readdirSync(tmp).filter((e) => e !== '.audit');
    assert.deepEqual(entries, []);
  });
});

describe('legacy-surface advisory — fires when a retired surface is present', () => {
  it('reports the surface, the count and the exact remedy', () => {
    seedStaleAgentsSkill(tmp);
    const r = runHook();
    assert.equal(r.code, 0, 'advisory must never block the prompt');
    assert.match(r.out, /Retired skill surface detected/);
    assert.match(r.out, /\.agents\/skills\//);
    assert.match(r.out, /--uninstall-legacy/);
    // The remedy must be safe to run, and say so — otherwise a cautious operator
    // ignores it, which is the same outcome as never printing it.
    assert.match(r.out, /cannot touch a skill you wrote yourself/);
  });

  it('explains WHY it matters, in the terms of the original misdiagnosis', () => {
    seedStaleAgentsSkill(tmp);
    const r = runHook();
    assert.match(r.out, /precedence between roots is undefined/i);
    assert.match(r.out, /not installed/, 'name the failure mode it prevents, not just the state');
  });
});

describe('legacy-surface advisory — once per session', () => {
  it('speaks on the first prompt and stays quiet afterwards', () => {
    seedStaleAgentsSkill(tmp);
    const first = runHook({ sessionId: 'sess-A' });
    const second = runHook({ sessionId: 'sess-A' });
    assert.match(first.out, /Retired skill surface/);
    assert.equal(second.out, '', 'repeating every prompt is how a hook gets disabled');
  });

  it('speaks again in a DIFFERENT session', () => {
    seedStaleAgentsSkill(tmp);
    runHook({ sessionId: 'sess-A' });
    const other = runHook({ sessionId: 'sess-B' });
    assert.match(other.out, /Retired skill surface/, 'a new session has not been told yet');
  });

  it('still advises when no session id is available', () => {
    // Cannot dedupe → advise anyway. A duplicate notice is a far cheaper failure
    // than a silent shadow.
    seedStaleAgentsSkill(tmp);
    const r = runHook({ stdin: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'x' }) });
    assert.match(r.out, /Retired skill surface/);
  });
});

describe('legacy-surface advisory — never blocks, whatever happens', () => {
  for (const [label, stdin] of [
    ['malformed JSON', '{ not json'],
    ['empty stdin', ''],
    ['unexpected shape', JSON.stringify({ hello: 'world' })],
  ]) {
    it(`exits 0 on ${label}`, () => {
      const r = runHook({ stdin });
      assert.equal(r.code, 0);
    });
  }

  it('exits 0 and says nothing when the repo root does not exist', () => {
    const r = runHook({ root: path.join(tmp, 'nope') });
    assert.equal(r.code, 0);
    assert.equal(r.out, '');
  });

  it('honours the opt-out', () => {
    seedStaleAgentsSkill(tmp);
    const r = runHook({ env: { LEGACY_SURFACE_HOOK_DISABLE: '1' } });
    assert.equal(r.code, 0);
    assert.equal(r.out, '', 'an opt-out that still prints is not an opt-out');
  });
});

// -- Tooling-layout resolution ---------------------------------------------
//
// This hook lives at `.claude/hooks/` in BOTH layouts, but its inspector is
// MAPPED: `scripts/lib/install/` here, `scripts/.claude-skills/lib/install/`
// in a consumer. It used to `import('../../scripts/lib/install/...')`, which
// resolves only in this repo; in a consumer it threw, and the call site turns a
// throw into `return`. So the advisory was silently dead in exactly the repos
// whose incident motivated it -- a session concluding 'the tooling is not
// installed' IS the consumer-side scenario this hook exists to prevent.
//
// The inspector is STUBBED rather than copied. The real one pulls in zod via
// schemas-install.mjs, and a scaffold outside the repo has no upward path to
// node_modules -- so a real copy fails to import for a reason that has nothing
// to do with layout resolution (observed while writing this: it failed under
// BOTH layouts, control included, which is the tell). The stub writes a marker
// when loaded, so the assertion is direct evidence that the hook imported THIS
// file at THIS path.

/** Stub inspector: records that it was loaded, then reports a clean tree. */
function stubInspectorSource(markerPath) {
  return [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(markerPath)}, 'loaded');`,
    'export function inspectLegacySurfaces() { return { overall: "absent", surfaces: [] }; }',
    'export function describeLegacySurfaces() { return []; }',
  ].join('\n');
}

function runWithInspectorAt(libRelDir) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lsa-layout-')));
  const hookDir = path.join(root, '.claude', 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  const hook = path.join(hookDir, 'legacy-surface-advisory.mjs');
  fs.copyFileSync(HOOK, hook);
  const marker = path.join(root, 'inspector-loaded.marker');
  if (libRelDir) {
    const dir = path.join(root, ...libRelDir.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'legacy-surfaces.mjs'), stubInspectorSource(marker));
  }
  // `--repo-root` is the documented test seam for the tree being INSPECTED; it
  // must NOT move where the hook loads its own code from, so it points
  // somewhere with no scripts/ tree at all.
  const inspected = path.join(root, 'inspected');
  fs.mkdirSync(inspected, { recursive: true });
  const r = spawnSync(process.execPath, [hook, '--repo-root', inspected], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'layout-probe', prompt: 'x' }),
    encoding: 'utf-8',
    timeout: 15000,
  });
  return { loaded: fs.existsSync(marker), status: r.status, stderr: r.stderr || '' };
}

describe('legacy-surface-advisory tooling-layout resolution', () => {
  it('source layout (scripts/lib/install/) -- loads the inspector', () => {
    const r = runWithInspectorAt('scripts/lib/install');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.loaded, 'inspector was not loaded under the source layout');
  });

  it('consumer layout (scripts/.claude-skills/lib/install/) -- loads the inspector', () => {
    const r = runWithInspectorAt('scripts/.claude-skills/lib/install');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.loaded, 'inspector was not loaded under the consumer layout');
  });

  it('neither layout -- stays silent and never blocks', () => {
    const r = runWithInspectorAt(null);
    assert.equal(r.status, 0);
    assert.equal(r.loaded, false);
  });
});
