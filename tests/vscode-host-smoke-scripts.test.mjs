/**
 * Tests for the two scripts embedded in docs/runbooks/vscode-host-smoke.md (capture.mjs, project.mjs).
 *
 * The scripts are EXTRACTED from the runbook, the same way the runbook's own PowerShell step extracts them, so this
 * tests the bytes Louis will run, not a copy. project.mjs is a fail-closed projection that decides what may be
 * committed from a raw capture; a leak there ships a prompt, a path or a secret into a public repo.
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

/** Same pattern as the runbook's PowerShell extraction (§1.3). */
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

function runProject(payload, extra = [], { raw } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'p-'));
  const input = path.join(dir, 'raw.json');
  fs.writeFileSync(input, raw ?? JSON.stringify(payload));
  const root = path.join(dir, 'out');
  const r = spawnSync(process.execPath, [projectJs, '--host', 'copilot', '--root', root, '--in', input, ...extra],
    { encoding: 'utf8' });
  const files = fs.existsSync(path.join(root, 'copilot')) ? fs.readdirSync(path.join(root, 'copilot')) : [];
  const text = files.map((f) => fs.readFileSync(path.join(root, 'copilot', f), 'utf8')).join('\n');
  return { ...r, files, text, root };
}

const HOME = 'C:\\Users\\louis\\secret-project';
const leaky = () => ({
  hook_event_name: 'PostToolUse',
  session_id: 'real-session-abc123',
  timestamp: '2026-11-23T08:15:00.123Z',
  cwd: HOME,
  transcript_path: HOME + '\\transcript.jsonl',
  tool_name: 'Write',
  tool_use_id: 'toolu_REAL_ID',
  unexpected_top: 'UNEXPECTED_TOP_VALUE',
  nested_secret: { token: 'sk-NESTED-SECRET-9999', deeper: { password: 'hunter2' } },
  tool_input: {
    file_path: HOME + '\\src\\app.mjs',
    content: 'const apiKey = "sk-LIVE-KEY-1234";',
    description: 'my private non-path string about Contoso',
    nested_edit: { path: HOME + '\\x.mjs' },
    edits: [{ old: 'PRIVATE_OLD' }],
    'C:\\Users\\louis\\odd key': 'v',
    count: 41,
    replace_all: true,
  },
  tool_response: { stdout: 'RESPONSE_SECRET ' + HOME },
});

describe('runbook scripts exist and parse', () => {
  it('both fences are extractable and are valid ESM', () => {
    for (const f of [captureJs, projectJs]) {
      assert.ok(fs.statSync(f).size > 200, f + ' was not extracted');
      const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    }
  });
});

describe('project.mjs — fail-closed projection', () => {
  it('drops every leak: nested secret, unexpected field, private string, home path', () => {
    const r = runProject(leaky());
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.files.length, 1);
    for (const needle of ['sk-NESTED-SECRET', 'hunter2', 'UNEXPECTED_TOP_VALUE', 'Contoso', 'private non-path',
      'C:\\\\Users', 'Users', 'louis', 'secret-project', 'sk-LIVE-KEY', 'PRIVATE_OLD', 'RESPONSE_SECRET',
      'real-session-abc123', 'toolu_REAL_ID', '2026-11-23', 'odd key']) {
      assert.ok(!r.text.includes(needle), 'leaked: ' + needle + '\n' + r.text);
    }
    assert.doesNotMatch(r.text, /[A-Za-z]:[\\/]/);
  });

  it('names every dropped key on stderr, and nothing on stdout but the written path', () => {
    const r = runProject(leaky());
    for (const key of ['unexpected_top', 'nested_secret', 'tool_response', 'tool_input.nested_edit', 'tool_input.edits']) {
      assert.match(r.stderr, new RegExp('dropped key: ' + key.replace('.', '\\.')), key);
    }
    assert.match(r.stdout, /^wrote .*posttooluse\.write\.json\n$/);
  });

  it('keeps the identifying fields, the tool_input key set, and substitutes synthetic values', () => {
    const r = runProject(leaky());
    const out = JSON.parse(r.text);
    assert.deepEqual(out, {
      hook_event_name: 'PostToolUse',
      session_id: 'fixture-session',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: '/fixture/repo',
      transcript_path: 'fixture-transcript.jsonl',
      tool_name: 'Write',
      tool_use_id: 'fixture-tool-use',
      tool_input: {
        file_path: 'src/fixture.mjs',
        content: 'try { x() } catch {}',
        description: 'fixture-value',
        count: 0,
        replace_all: true,
      },
    });
  });

  it('control: a prompt event keeps its shape and a replaced prompt', () => {
    const r = runProject({ hook_event_name: 'UserPromptSubmit', session_id: 's', timestamp: 't', cwd: HOME,
      prompt: 'please fix ' + HOME });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.text), { hook_event_name: 'UserPromptSubmit', session_id: 'fixture-session',
      timestamp: '2026-01-01T00:00:00.000Z', cwd: '/fixture/repo', prompt: 'fix the fixture bug' });
    assert.deepEqual(r.files, ['userpromptsubmit.json']);
  });

  it('shell commands become the synthetic command', () => {
    const r = runProject({ hook_event_name: 'PreToolUse', tool_name: 'powershell',
      tool_input: { command: 'rg SECRET ' + HOME, description: 'x' } });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(JSON.parse(r.text).tool_input.command, 'rg fixturePattern src');
    assert.ok(!r.text.includes('SECRET'));
  });

  it('refuses an unsupported event: exit 2, no file, no stdout', () => {
    const r = runProject({ hook_event_name: 'SessionEnd', session_id: 'x' });
    assert.equal(r.status, 2);
    assert.equal(r.stdout, '');
    assert.deepEqual(r.files, []);
  });

  it('refuses an unknown tool name, and a missing one on a tool event', () => {
    for (const payload of [{ hook_event_name: 'PreToolUse', tool_name: 'SomethingNew', tool_input: {} },
      { hook_event_name: 'PreToolUse', tool_input: {} }]) {
      const r = runProject(payload);
      assert.equal(r.status, 2);
      assert.deepEqual(r.files, []);
    }
  });

  it('refuses non-JSON, a non-object payload and a non-object tool_input', () => {
    assert.equal(runProject(null, [], { raw: 'not json' }).status, 2);
    assert.equal(runProject([1, 2]).status, 2);
    const r = runProject({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: 'rg x' });
    assert.equal(r.status, 2);
    assert.deepEqual(r.files, []);
  });

  it('refuses an unknown host and a malformed --name', () => {
    const dir = fs.mkdtempSync(path.join(tmp, 'h-'));
    const input = path.join(dir, 'raw.json');
    fs.writeFileSync(input, JSON.stringify({ hook_event_name: 'UserPromptSubmit' }));
    const bad = spawnSync(process.execPath, [projectJs, '--host', 'evil', '--root', dir, '--in', input], { encoding: 'utf8' });
    assert.equal(bad.status, 2);
    assert.equal(runProject({ hook_event_name: 'UserPromptSubmit' }, ['--name', '../escape']).status, 2);
  });

  it('skips an existing fixture instead of overwriting, unless --name is given', () => {
    const first = runProject({ hook_event_name: 'UserPromptSubmit', prompt: 'a' });
    const input = path.join(path.dirname(first.root), 'raw.json');
    const again = spawnSync(process.execPath, [projectJs, '--host', 'copilot', '--root', first.root, '--in', input],
      { encoding: 'utf8' });
    assert.equal(again.status, 0);
    assert.match(again.stdout, /^exists, skipped /);
  });
});

describe('capture.mjs — raw capture stays outside the repo and never blocks', () => {
  function runCapture(stdin, env, cwd) {
    return spawnSync(process.execPath, [captureJs], {
      input: stdin, encoding: 'utf8', cwd,
      env: { ...process.env, LOCALAPPDATA: '', CES_CAPTURE_DIR: '', ...env },
    });
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

  it('records a null disable flag when the variable did not reach the hook', () => {
    const base = fs.mkdtempSync(path.join(tmp, 'cap-'));
    const env = { CES_CAPTURE_DIR: base };
    const clean = { ...process.env, ...env, LOCALAPPDATA: '' };
    delete clean.ARCH_MEMORY_HOOK_DISABLE;
    const r = spawnSync(process.execPath, [captureJs], { input: '{}', encoding: 'utf8', env: clean });
    assert.equal(r.status, 0);
    const dir = path.join(base, 'unknown');
    const meta = fs.readdirSync(dir).find((f) => f.endsWith('.meta.json'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, meta), 'utf8')).archMemoryHookDisable, null);
  });

  it('fails closed with no absolute dir: writes nothing anywhere, exits 0', () => {
    const cwd = fs.mkdtempSync(path.join(tmp, 'cwd-'));
    for (const env of [{}, { CES_CAPTURE_DIR: 'relative-dir' }]) {
      const r = runCapture('{}', env, cwd);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.deepEqual(fs.readdirSync(cwd), []);
    }
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
    ['LOCALAPPDATA', 'raw captures live outside the repo'],
    ["Test-Path '.github\\hooks\\payload-capture.json'", 'checks the hook config removal'],
    ["Test-Path (Join-Path $capture 'capture.mjs')", 'checks the capture script removal'],
    ['Test-Path $capture', 'checks the capture dir removal'],
    ['git status --porcelain --ignored -- .github/hooks', 'checks .github/hooks is empty'],
    ['tests/fixtures/hook-payloads/copilot/', 'names the fixture destination Cluster D reads'],
    ['Tier 2 deferred: no recorded fixtures', 'states the fallback'],
    ['cleanup failed', 'says cleanup failure is a stop'],
  ];
  for (const [needle, why] of must) {
    it('contains ' + needle + ' (' + why + ')', () => {
      assert.ok(runbook.includes(needle), needle);
    });
  }

  it('has no angle-bracket placeholder inside a powershell block', () => {
    const blocks = [...runbook.matchAll(/```powershell\r?\n([\s\S]*?)```/g)].map((m) => m[1]);
    assert.ok(blocks.length >= 8);
    for (const b of blocks) assert.doesNotMatch(b, /<[A-Za-z][A-Za-z -]*>/, b);
  });

  it('the capture hook config is never left in the tree', () => {
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, '.github', 'hooks', 'payload-capture.json')));
  });
});
