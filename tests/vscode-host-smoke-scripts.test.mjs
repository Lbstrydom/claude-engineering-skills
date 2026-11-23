/**
 * Tests for the two scripts embedded in docs/runbooks/vscode-host-smoke.md (capture.mjs, project.mjs).
 *
 * The scripts are EXTRACTED from the runbook, the same way the runbook's own PowerShell step extracts them, so this
 * tests the bytes Louis will run, not a copy. project.mjs is a fail-closed, allowlist-driven projection that decides what
 * may be committed from a raw capture; a leak there ships a prompt, a path or a secret into a public repo.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNBOOK = path.join(REPO_ROOT, 'docs', 'runbooks', 'vscode-host-smoke.md');
const SEED_ALLOWLIST = path.join(REPO_ROOT, 'tests', 'fixtures', 'hook-payloads', 'allowlist.json');

/** Same pattern as the runbook's PowerShell extraction (§1.3 step E). */
function extractScript(markdown, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('<!-- smoke-script: ' + escaped + ' -->\\r?\\n```js\\r?\\n([\\s\\S]*?)\\r?\\n```');
  const m = re.exec(markdown);
  return m ? m[1].replace(/\r\n/g, '\n') + '\n' : null;
}

let tmp;
let captureJs;
let projectJs;
const runbook = fs.readFileSync(RUNBOOK, 'utf8');

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-smoke-'));
  captureJs = path.join(tmp, 'capture.mjs');
  projectJs = path.join(tmp, 'project.mjs');
  fs.writeFileSync(captureJs, extractScript(runbook, 'capture.mjs') ?? '');
  fs.writeFileSync(projectJs, extractScript(runbook, 'project.mjs') ?? '');
});
after(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }));

/** Run the projection against a payload with an allowlist (the seed by default, or an override). */
function runProject(payload, { allowlist, extra = [], raw } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
  const input = path.join(dir, 'raw.json');
  fs.writeFileSync(input, raw ?? JSON.stringify(payload));
  const root = path.join(dir, 'out');
  fs.mkdirSync(root, { recursive: true });
  const allowFile = path.join(dir, 'allowlist.json');
  fs.writeFileSync(allowFile, typeof allowlist === 'string' ? allowlist
    : JSON.stringify(allowlist ?? JSON.parse(fs.readFileSync(SEED_ALLOWLIST, 'utf8'))));
  const r = spawnSync(process.execPath,
    [projectJs, '--host', 'copilot', '--root', root, '--in', input, '--allowlist', allowFile, ...extra], { encoding: 'utf8' });
  const hostDir = path.join(root, 'copilot');
  const files = fs.existsSync(hostDir) ? fs.readdirSync(hostDir) : [];
  const text = files.map((f) => fs.readFileSync(path.join(hostDir, f), 'utf8')).join('\n');
  return { ...r, files, text, root, input, allowFile };
}

const HOME = 'C:\\Users\\louis\\secret-project';
const seed = () => JSON.parse(fs.readFileSync(SEED_ALLOWLIST, 'utf8'));
/** A payload whose every key path is on the seed allowlist, with secrets as values. */
const approved = () => ({
  hook_event_name: 'PostToolUse',
  session_id: 'real-session-abc123 sk-NESTED-SECRET-9999',
  timestamp: '2026-11-23T08:15:00.123Z',
  cwd: HOME,
  transcript_path: HOME + '\\transcript.jsonl',
  permission_mode: 'bypassPermissions hunter2',
  tool_name: 'Write',
  tool_use_id: 'toolu_REAL_ID',
});
/** The same payload with unapproved fields carrying secrets. */
const withUnknown = () => ({ ...approved(), unexpected_top: 'UNEXPECTED_VALUE_sk-LIVE-1234',
  tool_input: { file_path: HOME + '\\src\\app.mjs', content: 'const k = "sk-LIVE-KEY-1234"', description: 'Contoso private' } });

describe('runbook scripts exist and parse', () => {
  it('both fences are extractable and are valid ESM', () => {
    for (const f of [captureJs, projectJs]) {
      assert.ok(fs.statSync(f).size > 200, f + ' was not extracted');
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
  });
});

describe('the committed allowlist seed', () => {
  it('is {version >= 1, events} and covers the six supported events', () => {
    const a = seed();
    assert.ok(Number.isInteger(a.version) && a.version >= 1);
    assert.deepEqual(Object.keys(a.events).sort(),
      ['PostToolUse', 'PreToolUse', 'UserPromptSubmit', 'postToolUse', 'preToolUse', 'userPromptSubmitted']);
  });
  it('holds only synthetic values: no drive letter or home path', () => {
    assert.doesNotMatch(fs.readFileSync(SEED_ALLOWLIST, 'utf8'), /[A-Za-z]:[\\/]|Users[\\/]|AppData|\/home\//);
  });
  it('does NOT pre-approve any tool_input path (those are the evidence Tier 2 needs)', () => {
    for (const spec of Object.values(seed().events)) {
      assert.deepEqual(Object.keys(spec).filter((k) => k.startsWith('tool_input') || k === 'tool_response'), []);
    }
  });
});

describe('project.mjs — allowlist-driven, unknown paths REFUSE', () => {
  it('replaces secrets at approved paths: none survive, and the exact synthetic fixture is produced', () => {
    const r = runProject(approved());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.files.length, 1);
    for (const needle of ['sk-NESTED-SECRET', 'hunter2', 'louis', 'secret-project', 'Users', 'real-session', 'toolu_REAL_ID',
      '2026-11-23', 'bypassPermissions']) {
      assert.ok(!r.text.includes(needle), 'leaked: ' + needle + '\n' + r.text);
    }
    assert.doesNotMatch(r.text, /[A-Za-z]:[\\/]/);
    assert.deepEqual(JSON.parse(r.text), {
      hook_event_name: 'PostToolUse',
      session_id: 'fixture-session',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/fixture/repo',
      transcript_path: 'fixture-transcript.jsonl',
      permission_mode: 'default',
      tool_name: 'Write',
      tool_use_id: 'fixture-tool-use',
    });
    assert.match(r.stdout, /^wrote .*posttooluse\.write\.json \(allowlist version 1\)\n$/);
  });

  it('an unknown field REFUSES: exit 2, no file, no stdout, stderr names the PATHS and never a value', () => {
    const r = runProject(withUnknown());
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.files, []);
    for (const p of ['unexpected_top', 'tool_input.file_path', 'tool_input.content', 'tool_input.description']) {
      assert.match(r.stderr, new RegExp('unknown key path: ' + p.replace('.', '\\.')), p);
    }
    for (const value of ['UNEXPECTED_VALUE', 'sk-LIVE', 'Contoso', 'secret-project', 'louis', 'real-session', 'hunter2']) {
      assert.ok(!r.stderr.includes(value), 'stderr leaked a value: ' + value);
    }
    assert.match(r.stderr, /suggested value: "src\/fixture\.mjs"/, 'a name-derived suggestion helps the approver');
  });

  it('the same payload after the paths are approved (version bumped) yields the synthetic values', () => {
    const a = seed();
    a.version = 2;
    for (const p of ['unexpected_top', 'tool_input.file_path', 'tool_input.content', 'tool_input.description']) {
      a.events.PostToolUse[p] = p.endsWith('file_path') ? 'src/fixture.mjs' : p.endsWith('content') ? 'try { x() } catch {}' : 'fixture-value';
    }
    const r = runProject(withUnknown(), { allowlist: a });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.text);
    assert.deepEqual(out.tool_input, { file_path: 'src/fixture.mjs', content: 'try { x() } catch {}', description: 'fixture-value' });
    assert.equal(out.unexpected_top, 'fixture-value');
    for (const needle of ['sk-LIVE', 'Contoso', 'UNEXPECTED_VALUE', 'secret-project']) assert.ok(!r.text.includes(needle), needle);
    assert.match(r.stdout, /allowlist version 2/);
  });

  it('a nested object under an unapproved key refuses by every leaf path, never dropping it', () => {
    const r = runProject({ ...approved(), tool_input: { edits: [{ old: 'PRIVATE_OLD', n: { deep: 'DEEP_SECRET' } }], empty: {}, none: [] } });
    assert.equal(r.status, 2);
    for (const p of ['tool_input.edits[].old', 'tool_input.edits[].n.deep', 'tool_input.empty', 'tool_input.none']) {
      assert.match(r.stderr, new RegExp('unknown key path: ' + p.replace(/[.[\]]/g, '\\$&')), p);
    }
    assert.ok(!r.stderr.includes('PRIVATE_OLD') && !r.stderr.includes('DEEP_SECRET'));
    assert.deepEqual(r.files, []);
  });

  it('approved array paths project element by element and keep the array length', () => {
    const a = seed();
    a.version = 2;
    a.events.PostToolUse['tool_input.edits[].old'] = 'fixture old text';
    const r = runProject({ ...approved(), tool_input: { edits: [{ old: 'A_SECRET' }, { old: 'B_SECRET' }] } }, { allowlist: a });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.text).tool_input, { edits: [{ old: 'fixture old text' }, { old: 'fixture old text' }] });
    assert.ok(!r.text.includes('SECRET'));
  });

  it('an unsafe key name is never echoed: it refuses as (unsafe-key)', () => {
    const r = runProject({ ...approved(), tool_input: { ['C:\\Users\\louis\\odd']: 'v' } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /tool_input\.\(unsafe-key\)/);
    assert.ok(!r.stderr.includes('louis') && !r.stderr.includes('Users'));
  });

  it('the control: UserPromptSubmit with only approved paths gets a synthetic prompt', () => {
    const r = runProject({ hook_event_name: 'UserPromptSubmit', session_id: 's', timestamp: 't', cwd: HOME, prompt: 'please fix ' + HOME });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.text), { hook_event_name: 'UserPromptSubmit', session_id: 'fixture-session',
      timestamp: '2026-01-01T00:00:00.000Z', cwd: '/fixture/repo', prompt: 'fix the fixture bug' });
    assert.deepEqual(r.files, ['userpromptsubmit.json']);
  });

  it('refuses an unsupported event, an event missing from the allowlist, and an unknown or missing tool name', () => {
    const noEvent = seed();
    delete noEvent.events.PreToolUse;
    for (const [payload, allowlist] of [
      [{ hook_event_name: 'SessionEnd', session_id: 'x' }, undefined],
      [{ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, noEvent],
      [{ hook_event_name: 'PreToolUse', tool_name: 'SomethingNew' }, undefined],
      [{ hook_event_name: 'PreToolUse' }, undefined],
    ]) {
      const r = runProject(payload, { allowlist });
      assert.equal(r.status, 2, JSON.stringify(payload));
      assert.equal(r.stdout, '');
      assert.deepEqual(r.files, []);
    }
  });

  it('refuses non-JSON, a non-object payload, and an unreadable or malformed allowlist', () => {
    assert.equal(runProject(null, { raw: 'not json' }).status, 2);
    assert.equal(runProject([1, 2]).status, 2);
    for (const allowlist of ['not json', '{"version":0,"events":{}}', '{"events":{}}', '{"version":1}']) {
      const r = runProject(approved(), { allowlist });
      assert.equal(r.status, 2, allowlist);
      assert.deepEqual(r.files, []);
    }
    const r0 = runProject(approved());
    const missing = spawnSync(process.execPath, [projectJs, '--host', 'copilot', '--root', r0.root, '--in', r0.input,
      '--allowlist', path.join(tmp, 'no-such.json')], { encoding: 'utf8' });
    assert.equal(missing.status, 2);
  });

  it('refuses an unknown host and a malformed --name', () => {
    const r0 = runProject(approved());
    const bad = spawnSync(process.execPath, [projectJs, '--host', 'evil', '--root', r0.root, '--in', r0.input], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(runProject(approved(), { extra: ['--name', '../escape'] }).status, 2);
  });

  it('skips an existing fixture instead of overwriting, unless --name is given', () => {
    const first = runProject(approved());
    const again = spawnSync(process.execPath, [projectJs, '--host', 'copilot', '--root', first.root, '--in', first.input,
      '--allowlist', first.allowFile], { encoding: 'utf8' });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /^exists, skipped /);
  });
});

describe('capture.mjs — raw capture stays in the run folder, outside the repo, and never blocks', () => {
  function runCapture(stdin, env, cwd, script = captureJs) {
    const clean = { ...process.env, CES_CAPTURE_DIR: '', ...env };
    if (env.ARCH_MEMORY_HOOK_DISABLE === undefined) delete clean.ARCH_MEMORY_HOOK_DISABLE;
    return spawnSync(process.execPath, [script], { input: stdin, encoding: 'utf8', cwd, env: clean });
  }

  it('writes the payload and a meta file under the capture dir, prints nothing, exits 0', () => {
    const base = fs.mkdtempSync(path.join(tmp, 'cap-'));
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    fs.writeFileSync(path.join(base, 'current-host.txt'), 'copilot');
    const r = runCapture('{"hook_event_name":"PreToolUse"}', { CES_CAPTURE_DIR: base, ARCH_MEMORY_HOOK_DISABLE: '1' }, cwd);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    const files = fs.readdirSync(path.join(base, 'copilot'));
    const raw = files.find((f) => f.endsWith('.json') && !f.endsWith('.meta.json'));
    assert.equal(fs.readFileSync(path.join(base, 'copilot', raw), 'utf8'), '{"hook_event_name":"PreToolUse"}');
    const meta = JSON.parse(fs.readFileSync(path.join(base, 'copilot', files.find((f) => f.endsWith('.meta.json'))), 'utf8'));
    assert.equal(meta.archMemoryHookDisable, '1');
    assert.deepEqual(fs.readdirSync(cwd), [], 'nothing may be written into the working directory');
  });

  it('with no override it writes beside its own script (the per-run folder), never into the cwd', () => {
    const runDir = fs.mkdtempSync(path.join(tmp, 'run-'));
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const script = path.join(runDir, 'capture.mjs');
    fs.copyFileSync(captureJs, script);
    fs.writeFileSync(path.join(runDir, 'current-host.txt'), 'claude-harness');
    const r = runCapture('{}', {}, cwd, script);
    assert.equal(r.status, 0);
    assert.ok(fs.readdirSync(path.join(runDir, 'claude-harness')).some((f) => f.endsWith('.json')));
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it('records a null disable flag when the variable did not reach the hook', () => {
    const base = fs.mkdtempSync(path.join(tmp, 'cap-'));
    assert.equal(runCapture('{}', { CES_CAPTURE_DIR: base }, tmp).status, 0);
    const dir = path.join(base, 'unknown');
    const meta = fs.readdirSync(dir).find((f) => f.endsWith('.meta.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, meta), 'utf8')).archMemoryHookDisable, null);
  });

  it('fails closed on a relative override: writes nothing anywhere, exits 0', () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    const r = runCapture('{}', { CES_CAPTURE_DIR: 'relative-dir' }, cwd);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.deepEqual(fs.readdirSync(cwd), []);
  });

  it('keeps a non-JSON payload as .txt and survives empty stdin', () => {
    const base = fs.mkdtempSync(path.join(tmp, 'cap-'));
    assert.equal(runCapture('not json', { CES_CAPTURE_DIR: base }, tmp).status, 0);
    assert.equal(runCapture('', { CES_CAPTURE_DIR: base }, tmp).status, 0);
    assert.ok(fs.readdirSync(path.join(base, 'unknown')).some((f) => f.endsWith('.txt')));
  });

  it('rejects a hostile host word and uses unknown', () => {
    const base = fs.mkdtempSync(path.join(tmp, 'cap-'));
    fs.writeFileSync(path.join(base, 'current-host.txt'), '..\\evil');
    runCapture('{}', { CES_CAPTURE_DIR: base }, tmp);
    assert.deepEqual(fs.readdirSync(base).sort(), ['current-host.txt', 'unknown']);
  });
});

describe('runbook contract (what the plan requires it to say)', () => {
  const must = [
    ['ARCH_MEMORY_HOOK_DISABLE', 'sets the arch-memory disable flag before launch'],
    ['REFUSED: $hookConfig already exists', 'preflight refuses rather than overwriting the operator\'s hook config'],
    ['[guid]::NewGuid()', 'a unique run id'],
    ['$env:LOCALAPPDATA', 'raw captures live outside the repo'],
    ['/inheritance:r', 'inheritance removed'],
    ['*S-1-5-18', 'SYSTEM is granted by SID'],
    ['*S-1-5-32-544', 'Administrators is granted by SID'],
    ['AreAccessRulesProtected', 'the ACL is verified, not assumed'],
    ['S-1-5-32-545', 'the Users negative control'],
    ['.created.txt', 'the run record'],
    ['git status --porcelain --ignored --', 'cleanup checks only recorded repo paths'],
    ['tests/fixtures/hook-payloads/allowlist.json', 'the versioned allowlist'],
    ['tests/fixtures/hook-payloads/copilot/', 'names the fixture destination Cluster D reads'],
    ['Tier 2 deferred: no recorded fixtures', 'states the fallback'],
    ['cleanup failed', 'says cleanup failure is a stop'],
  ];
  for (const [needle, why] of must) {
    it('contains ' + needle + ' (' + why + ')', () => {
      assert.ok(runbook.includes(needle), needle);
    });
  }

  it('cleanup removes by run record only: no blanket delete of the capture base or of .github/hooks', () => {
    const blocks = [...runbook.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const b of blocks) {
      assert.doesNotMatch(b, /Remove-Item[^\n]*\$base\s+-Recurse/, 'removes the whole capture base');
      assert.doesNotMatch(b, /Remove-Item[^\n]*['"]\.github\\hooks['"]\s+-Recurse/, 'removes the operator\'s .github\\hooks');
    }
  });

  it('has no angle-bracket placeholder inside a powershell block', () => {
    const blocks = [...runbook.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 8);
    for (const b of blocks) assert.doesNotMatch(b, /<[A-Za-z][A-Za-z -]*>/, b);
  });

  it('the capture hook config is never left in the tree', () => {
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, '.github', 'hooks', 'payload-capture.json')));
  });
});
