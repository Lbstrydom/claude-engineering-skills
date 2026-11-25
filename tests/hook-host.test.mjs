/**
 * @fileoverview Cluster D (docs/plans/vscode-compatibility.md §7b Phase 4-5, §9): the hook-host oracle and the four hooks
 * that consume it.
 *
 * Three layers, each with its own reason to exist:
 *   1. PURE — `detectHookHost`, `normaliseToolEvent`, `formatHookOutput`.
 *   2. SPAWNED — a real hook process fed the payload on stdin, asserting what the PROCESS did with it (stdout, stderr, exit,
 *      stub calls). A pure normaliser can be right while a hook still reads the wrong field, so the pure layer is never
 *      the only evidence.
 *   3. TIER 2 — Copilot `tool_input` keys are unpublished and mapped only from recorded fixtures (cluster A smoke run). Those
 *      tests are SKIPPED with that reason while the fixtures are absent, never passing vacuously.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { copyLibClosure } from './helpers/lib-closure.mjs';
import { detectHookHost, normaliseToolEvent, formatHookOutput } from '../scripts/lib/hook-host.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const HOOKS = path.join(REPO_ROOT, '.claude', 'hooks');
const HOST_MODULE = path.join(REPO_ROOT, 'scripts', 'lib', 'hook-host.mjs');
const COPILOT_FIXTURE_DIR = path.join(TEST_DIR, 'fixtures', 'hook-payloads', 'copilot');
// Tier 2 is TOOL-EVENT recordings (`pretooluse.*` / `posttooluse.*`, runbook §6.5). The recorded prompt fixture
// (`userpromptsubmit.json`, smoke run 2026-11-23/24) is Tier 1 evidence and must not switch these tests on.
const isToolEventFixture = (name) => /^(pre|post)tooluse\..+\.json$/i.test(name);
const copilotFixtures = fs.existsSync(COPILOT_FIXTURE_DIR) ? fs.readdirSync(COPILOT_FIXTURE_DIR) : [];
const TIER2_SKIP = copilotFixtures.some(isToolEventFixture)
  ? false
  : 'Tier 2 deferred: no recorded Copilot tool-event fixtures (cluster A smoke run, docs/runbooks/vscode-host-smoke.md)';
const RECORDED_PROMPT_FIXTURE = path.join(COPILOT_FIXTURE_DIR, 'userpromptsubmit.json');

// ── Fixtures ────────────────────────────────────────────────────────────────
// Claude Code's envelope carries `transcript_path`; Copilot's documented envelope carries a string `timestamp` and none.
const CLAUDE_ENV = { session_id: 's', transcript_path: 't.jsonl', cwd: '/x', permission_mode: 'default' };
const COPILOT_ENV = { session_id: 's', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/x' };

const claude = (event, extra) => ({ ...CLAUDE_ENV, hook_event_name: event, ...extra });
const copilot = (event, extra) => ({ ...COPILOT_ENV, hook_event_name: event, ...extra });

// ── 1. Pure ─────────────────────────────────────────────────────────────────

describe('detectHookHost', () => {
  it('classifies the documented Copilot envelope as copilot', () => {
    assert.equal(detectHookHost(copilot('PreToolUse', { tool_name: 'Bash' })), 'copilot');
  });
  it('classifies the RECORDED Copilot prompt envelope (smoke run 2026-11-23/24) as copilot', () => {
    const recorded = JSON.parse(fs.readFileSync(RECORDED_PROMPT_FIXTURE, 'utf8'));
    assert.equal(recorded.hook_event_name, 'UserPromptSubmit');
    assert.equal(detectHookHost(recorded), 'copilot');
  });
  it('the Tier 2 trigger counts tool-event fixtures only, never the prompt fixture', () => {
    assert.equal(isToolEventFixture('userpromptsubmit.json'), false);
    assert.equal(isToolEventFixture('pretooluse.bash.json'), true);
    assert.equal(isToolEventFixture('posttooluse.str_replace_editor-v2.json'), true);
  });
  it('control: the Claude envelope is claude-code, not copilot', () => {
    assert.equal(detectHookHost(claude('PreToolUse', { tool_name: 'Bash' })), 'claude-code');
  });
  it('a timestamp does not outrank transcript_path (an envelope with both is not copilot)', () => {
    assert.equal(detectHookHost({ ...CLAUDE_ENV, ...COPILOT_ENV, hook_event_name: 'PreToolUse' }), 'claude-code');
  });
  for (const [name, payload] of [
    ['null', null], ['a string', 'x'], ['an array', []], ['an empty object', {}],
    ['a bare test payload', { tool_name: 'Edit', tool_input: { file_path: 'a.mjs' } }],
    ['a non-string timestamp', { hook_event_name: 'PreToolUse', timestamp: 1767225600000 }],
    ['a missing event name', { timestamp: COPILOT_ENV.timestamp }],
    ['a non-string transcript_path with a timestamp', { hook_event_name: 'x', timestamp: 'y', transcript_path: 5 }],
  ]) {
    it(`malformed (${name}) is unknown, which behaves as the Claude shape`, () => {
      assert.equal(detectHookHost(payload), 'unknown');
    });
  }
});

describe('normaliseToolEvent', () => {
  it('maps Bash to a shell event with no path', () => {
    assert.deepEqual(normaliseToolEvent({ tool_name: 'Bash', tool_input: { command: 'rg x' } }), { kind: 'shell', shell: 'bash', command: 'rg x' });
  });
  it('maps PowerShell to a shell event that names its dialect', () => {
    assert.deepEqual(
      normaliseToolEvent({ tool_name: 'PowerShell', tool_input: { command: 'sls x a.txt' } }),
      { kind: 'shell', shell: 'powershell', command: 'sls x a.txt' });
    assert.equal(normaliseToolEvent({ tool_name: 'PowerShell', tool_input: { command: '  ' } }), null);
  });
  it('merges Edit and Write into ONE file kind, discriminated by op', () => {
    assert.deepEqual(
      normaliseToolEvent({ tool_name: 'Edit', tool_input: { file_path: 'a.mjs', new_string: 'n' } }),
      { kind: 'file', op: 'edit', filePath: 'a.mjs', text: 'n' });
    assert.deepEqual(
      normaliseToolEvent({ tool_name: 'Write', tool_input: { filePath: 'b.mjs', content: 'c' } }),
      { kind: 'file', op: 'write', filePath: 'b.mjs', text: 'c' });
  });
  it('a path-only file event is VALID: text is absent, not null (syntax-check needs only the path)', () => {
    const ev = normaliseToolEvent({ tool_name: 'Edit', tool_input: { file_path: 'a.mjs' } });
    assert.deepEqual(ev, { kind: 'file', op: 'edit', filePath: 'a.mjs' });
    assert.equal(Object.hasOwn(ev, 'text'), false);
  });
  it('a variant missing a REQUIRED field is null', () => {
    assert.equal(normaliseToolEvent({ tool_name: 'Edit', tool_input: { new_string: 'n' } }), null);
    assert.equal(normaliseToolEvent({ tool_name: 'Bash', tool_input: {} }), null);
    assert.equal(normaliseToolEvent({ tool_name: 'Bash', tool_input: { command: '   ' } }), null);
    assert.equal(normaliseToolEvent({ tool_name: 'Edit' }), null);
  });
  it('unmapped and multi-file tools are null, never a partial event', () => {
    for (const tool_name of ['Read', 'MultiEdit', 'apply_patch', 'Grep']) {
      assert.equal(normaliseToolEvent({ tool_name, tool_input: { file_path: 'a.mjs', command: 'x' } }), null, tool_name);
    }
  });
  it('malformed input is null', () => {
    for (const p of [null, 'x', [], 7]) assert.equal(normaliseToolEvent(p), null);
  });
  it('the Claude envelope maps exactly like a bare payload', () => {
    const ti = { file_path: 'a.mjs', new_string: 'n' };
    assert.deepEqual(
      normaliseToolEvent(claude('PostToolUse', { tool_name: 'Edit', tool_input: ti })),
      normaliseToolEvent({ tool_name: 'Edit', tool_input: ti }));
  });
  it('Tier 1: a Copilot-envelope tool event is null even with Claude-named keys (keys are unpublished; never guessed)', () => {
    assert.equal(normaliseToolEvent(copilot('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.mjs', new_string: 'n' } })), null);
    assert.equal(normaliseToolEvent(copilot('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rg x' } })), null);
  });
});

describe('formatHookOutput', () => {
  it('claude-code and unknown reproduce today\'s envelopes byte for byte', () => {
    for (const host of ['claude-code', 'unknown']) {
      assert.equal(
        JSON.stringify(formatHookOutput(host, 'PreToolUse', 'deny', 'r')),
        '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"r"}}');
      assert.equal(JSON.stringify(formatHookOutput(host, 'PostToolUse', 'context', 'm')), '{"systemMessage":"m"}');
    }
  });
  it('copilot emits top-level permissionDecision / additionalContext', () => {
    assert.deepEqual(formatHookOutput('copilot', 'PreToolUse', 'deny', 'r'), { permissionDecision: 'deny', permissionDecisionReason: 'r' });
    assert.deepEqual(formatHookOutput('copilot', 'PostToolUse', 'context', 'm'), { additionalContext: 'm' });
  });
  it('an unsupported (event, kind) pair emits nothing', () => {
    for (const host of ['claude-code', 'copilot', 'unknown']) {
      assert.equal(formatHookOutput(host, 'PreToolUse', 'context', 'x'), null);
      assert.equal(formatHookOutput(host, 'PostToolUse', 'deny', 'x'), null);
      assert.equal(formatHookOutput(host, 'UserPromptSubmit', 'context', 'x'), null);
    }
  });
});

// ── 2. Spawned ──────────────────────────────────────────────────────────────

/** Run a real hook process with the payload on stdin. `cwd` defaults to the repo. */
function spawnHook(hookFile, payload, { env = {}, cwd = REPO_ROOT, hooksDir = HOOKS } = {}) {
  const isSh = hookFile.endsWith('.sh');
  const r = spawnSync(isSh ? 'bash' : process.execPath, [path.join(hooksDir, hookFile)], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    env: { ...process.env, ...env },
    cwd,
    encoding: 'utf-8',
    timeout: 20000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

const GREP_DENY_REASON = [
  'Bash leading command is `rg` — use the Grep tool instead.',
  'Grep wraps ripgrep with correct permissions and supports',
  'output_mode/head_limit/context/-A/-B/-C/glob/type filters,',
  'which removes the need for `| head` and similar pipe shaping.',
  'Pipe-filter uses (e.g. `ps aux | grep node`) are fine — only',
  'leading-command file-content search is blocked.',
  'Disable per-session: BASH_GREP_NUDGE_DISABLE=1',
].join(' ');
// Snapshot taken from the pre-change hook (4b778e70 behaviour): the bytes a Claude host must keep receiving.
const GREP_DENY_SNAPSHOT = JSON.stringify({
  hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: GREP_DENY_REASON },
});

describe('spawned hook: what the process receives and does', () => {
  let tmp;
  let work; // repo-internal: resolveAndClassify treats a repo-escaping path as sensitive
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-host-'));
    work = path.join(REPO_ROOT, '.claude', 'tmp', `hook-host-test-${process.pid}`);
    fs.mkdirSync(work, { recursive: true });
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
  const write = (name, content) => { const p = path.join(work, name); fs.writeFileSync(p, content); return p; };

  it('the oracle sees the same bytes a real spawn delivers (probe process)', () => {
    const probe = `
      let s = ''; process.stdin.on('data', d => s += d);
      process.stdin.on('end', async () => {
        const m = await import(${JSON.stringify(pathToFileURL(HOST_MODULE).href)});
        const p = JSON.parse(s);
        process.stdout.write(JSON.stringify({ host: m.detectHookHost(p), ev: m.normaliseToolEvent(p) }));
      });`;
    const payload = claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a.mjs' } });
    const r = spawnSync(process.execPath, ['-e', probe], { input: JSON.stringify(payload), encoding: 'utf-8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { host: 'claude-code', ev: { kind: 'file', op: 'edit', filePath: 'a.mjs' } });
  });

  describe('syntax-check', () => {
    it('REGRESSION: a path-only Claude Edit (no new_string) still runs node --check', () => {
      const file = write('broken.mjs', 'export const a = ;\n');
      const r = spawnHook('syntax-check.mjs', { tool_name: 'Edit', tool_input: { file_path: file } });
      assert.equal(r.status, 0);
      assert.match(JSON.parse(r.stdout).systemMessage, /Syntax error — .*broken\.mjs/);
    });
    it('the same under the full Claude envelope', () => {
      const file = write('broken2.mjs', 'export const a = ;\n');
      const r = spawnHook('syntax-check.mjs', claude('PostToolUse', { tool_name: 'Write', tool_input: { file_path: file, content: 'x' } }));
      assert.match(JSON.parse(r.stdout).systemMessage, /Syntax error/);
    });
    it('a valid file is silent', () => {
      const file = write('ok.mjs', 'export const a = 1;\n');
      const r = spawnHook('syntax-check.mjs', { tool_name: 'Edit', tool_input: { file_path: file } });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
    it('INC-001: a sensitive path short-circuits before any read, under the Claude envelope', () => {
      const dir = path.join(work, 'secrets');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'leak.mjs');
      fs.writeFileSync(file, 'export const SECRET = ;\n');
      const r = spawnHook('syntax-check.mjs', claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }));
      assert.deepEqual([r.status, r.stdout], [0, '']);
      assert.doesNotMatch(r.stderr, /SECRET/);
    });
    it('Tier 1: a Copilot-envelope edit event is silent (tool_input keys unpublished)', () => {
      const file = write('broken3.mjs', 'export const a = ;\n');
      const r = spawnHook('syntax-check.mjs', copilot('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: file } }));
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
  });

  describe('quickfix-scan', () => {
    const env = () => ({ QUICKFIX_TELEMETRY_PATH: path.join(tmp, 'hits.jsonl'), LEARNING_DISABLE: '1' });
    const TRIGGER = 'try { x() } catch {}';
    it('Claude Edit with a trigger emits the byte-identical systemMessage', () => {
      const r = spawnHook('quickfix-scan.mjs', { tool_name: 'Edit', tool_input: { file_path: 'src/a.mjs', new_string: TRIGGER } }, { env: env() });
      assert.equal(r.status, 0);
      // Whole-stdout snapshot (pre-change bytes, path separator normalised): exact whitespace and trailing newline.
      const rel = path.join('src', 'a.mjs');
      const expected = JSON.stringify({ systemMessage: [
        `⚠ Quick-fix patterns matched in ${rel}:`,
        '  • [medium] empty-catch',
        '    Snippet: "catch {}"',
        '    Suggest: Empty catch swallows errors silently. Either log + rethrow, fix the underlying cause, or annotate why ignoring is safe.',
        '(Disable for this line: append // quickfix-hook:ignore | session: QUICKFIX_HOOK_DISABLE=1)',
      ].join('\n') }) + '\n';
      assert.equal(r.stdout, expected);
    });
    it('REGRESSION: a path-only Edit exits 0 with no output', () => {
      const r = spawnHook('quickfix-scan.mjs', { tool_name: 'Edit', tool_input: { file_path: 'src/a.mjs' } }, { env: env() });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
    it('Tier 1: a Copilot-envelope edit with a trigger is silent', () => {
      const r = spawnHook('quickfix-scan.mjs', copilot('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: 'src/a.mjs', new_string: TRIGGER } }), { env: env() });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
    it('INC-001: a sensitive path is never scanned or logged, under the Claude envelope', () => {
      const r = spawnHook('quickfix-scan.mjs', claude('PostToolUse', { tool_name: 'Edit', tool_input: { file_path: '.env', new_string: TRIGGER } }), { env: env() });
      assert.deepEqual([r.status, r.stdout], [0, '']);
      assert.equal(fs.existsSync(path.join(tmp, 'hits.jsonl')) && /\.env/.test(fs.readFileSync(path.join(tmp, 'hits.jsonl'), 'utf-8')), false);
    });
  });

  describe('bash-grep-nudge', () => {
    it('Claude: byte-identical deny envelope (snapshot)', () => {
      const r = spawnHook('bash-grep-nudge.mjs', { tool_name: 'Bash', tool_input: { command: 'rg foo src' } });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, GREP_DENY_SNAPSHOT);
    });
    it('Claude: a non-grep command and a pipe-filter are silent', () => {
      for (const command of ['git status', 'ps aux | grep node']) {
        const r = spawnHook('bash-grep-nudge.mjs', claude('PreToolUse', { tool_name: 'Bash', tool_input: { command } }));
        assert.deepEqual([r.status, r.stdout], [0, ''], command);
      }
    });
    const runShell = (tool_name, command, options) =>
      spawnHook('bash-grep-nudge.mjs', claude('PreToolUse', { tool_name, tool_input: { command, description: 'd' } }), options);
    const reasonOf = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

    it('PowerShell: a leading file search is denied with a PowerShell-accurate message', () => {
      const r = runShell('PowerShell', 'Select-String -Pattern foo -Path src\\*.mjs');
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
      assert.equal(reasonOf(r), [
        'PowerShell leading command is `Select-String` — use the Grep tool instead.',
        'Grep wraps ripgrep with correct permissions and supports',
        'output_mode/head_limit/context/-A/-B/-C/glob/type filters,',
        'which removes the need for `| Select-Object -First` and similar pipe shaping.',
        'Pipe-filter uses (e.g. `Get-Process | Select-String node`) are fine — only',
        'file-content search is blocked.',
        'Disable per-session: BASH_GREP_NUDGE_DISABLE=1',
      ].join(' '));
    });
    it('PowerShell: Get-ChildItem piped to Select-String is named as a file-content search', () => {
      const r = runShell('PowerShell', 'Get-ChildItem -Recurse -Filter *.mjs | Select-String foo');
      assert.match(reasonOf(r), /^PowerShell `Get-ChildItem \| Select-String` is a file-content search — use the Grep tool/);
    });
    for (const command of [
      // Leading search command: the first word decides, as for Bash.
      'sls foo src/a.mjs', 'SELECT-STRING foo a.txt', 'findstr /s foo *.js', 'findstr.exe foo a.txt', 'rg foo src', 'rg.exe foo', 'grep -r foo .',
      '& rg foo', '\n  rg foo', 'Select-String `\n  -Pattern foo -Path a.txt', 'Select-String -Pattern " -InputObject" -Path a.txt',
      'Select-String -InputObject $out -Pattern foo',
      // The strict listing-to-search shape.
      'gci -r src | sls foo', 'ls -Recurse | Select-String foo', 'dir *.cs | sls foo', 'gci $root -r | sls foo',
      'Get-ChildItem -Name:$false | Select-String foo', 'gci C:\\env -r | sls foo', 'gci .\\variable -r | sls foo',
      // A single-quoted value is literal in PowerShell, and the search side's arguments are not restricted.
      "gci -Filter 'report`*$.txt' | sls error", 'gci | sls (Get-Content patterns.txt)', 'gci | sls "$env:SEARCH_PATTERN"',
      'Get-ChildItem -r |\n  Select-String foo', 'Get-ChildItem C:\\src -Filter "*.mjs" | Select-String -Pattern \'a|b\'',
      // A plain quoted value is not read: switch-like or pipe-like text inside it changes nothing.
      "Get-ChildItem -Filter ' -Name' | Select-String foo", "gci | sls -Pattern 'x -InputObject y'", 'gci | sls foo; Write-Output $("bar")',
    ]) {
      it(`PowerShell nudged: ${JSON.stringify(command)}`, () => {
        const r = runShell('PowerShell', command);
        assert.equal(r.status, 0);
        assert.notEqual(r.stdout, '', command);
        assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, 'deny');
      });
    }
    for (const command of [
      'Get-Process | Select-String node', 'git log --oneline | sls fix', 'Get-Content a.log | Select-String error',
      'npm test 2>&1 | findstr fail', 'Get-ChildItem src', 'gci | findstr foo', 'Write-Output "rg foo"', 'grep-report --all', 'git grep foo',
      '$hits = rg foo', 'Get-ChildItem; $x | Select-String foo', 'Get-ChildItem\n$x | Select-String foo', 'gci && git log | sls foo',
      'gci || sls foo', "Get-ChildItem -Filter 'a | sls x'", 'gci # | sls foo', 'ls.exe | sls foo',
      // The listing emits names, or the search reads a value in memory.
      'Get-ChildItem -Name | Select-String foo', 'gci -Name:$true | sls foo', 'Get-ChildItem -Directory | Select-String node_modules',
      'gci -dir -r | sls foo','gci | sls -InputObject $out -Pattern foo',
      'gci | Select-String -inp $out foo',
      // A non-file provider drive lists objects, not files.
      'Get-ChildItem Env: | Select-String PATH', 'gci -Path variable: | sls foo', 'ls alias:\\ | sls git', 'dir HKCU:\\Software | sls foo',
      'gci -Path:Function: | sls foo',
      // Anything beyond the strict shape is allowed, never parsed.
      'gci | Where-Object Name | sls foo', 'gci | sort.exe | sls foo', 'gci | ForEach-Object Name | sls foo',
      'gci -Path (Get-Location) | sls foo', 'gci "$env:TEMP" | sls foo', 'Get-ChildItem -Filter "$("x | Select-String y")"',
      'gci `\n| sls foo', '# find it\nrg foo', 'Get-ChildItem > files.txt | Select-String foo', 'gci -r 2>$null | sls foo',
    ]) {
      it(`PowerShell allowed: ${JSON.stringify(command)}`, () => {
        const r = runShell('PowerShell', command);
        assert.deepEqual([r.status, r.stdout], [0, ''], command);
      });
    }
    it('PowerShell syntax is not applied to Bash: Select-String and findstr under Bash stay silent', () => {
      for (const command of ['Select-String foo a.txt', 'findstr foo a.txt', 'ls | sls foo']) {
        const r = runShell('Bash', command);
        assert.deepEqual([r.status, r.stdout], [0, ''], command);
      }
    });
    it('the disable env var covers PowerShell', () => {
      const r = runShell('PowerShell', 'rg foo', { env: { BASH_GREP_NUDGE_DISABLE: '1' } });
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
    it('Tier 1: a Copilot-envelope Bash event is silent', () => {
      const r = spawnHook('bash-grep-nudge.mjs', copilot('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'rg foo' } }));
      assert.deepEqual([r.status, r.stdout], [0, '']);
    });
  });

  describe('arch-memory-check.sh', () => {
    // A relocated copy whose cross-skill.mjs is a STUB that logs every call, so "zero egress" is a count, not an inference.
    function relocatedRoot(name, { withHostLib = true, libDir = ['scripts', 'lib'] } = {}) {
      const root = path.join(tmp, name);
      fs.mkdirSync(path.join(root, '.claude', 'hooks'), { recursive: true });
      fs.copyFileSync(path.join(HOOKS, 'arch-memory-check.sh'), path.join(root, '.claude', 'hooks', 'arch-memory-check.sh'));
      const log = path.join(root, 'stub-calls.log');
      const stubDir = libDir[1] === '.claude-skills' ? path.join(root, 'scripts', '.claude-skills') : path.join(root, 'scripts');
      fs.mkdirSync(stubDir, { recursive: true });
      fs.writeFileSync(path.join(stubDir, 'cross-skill.mjs'),
        `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2, 3).join(' ') + '\\n'); process.stdout.write('{}');\n`);
      if (withHostLib) copyLibClosure('scripts/lib/hook-host.mjs', path.join(root, ...libDir));
      return { root, hooksDir: path.join(root, '.claude', 'hooks'), calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').trim().split('\n').filter(Boolean) : []) };
    }
    const hermetic = { ARCH_MEMORY_HOOK_DISABLE: '0' };
    const PROMPT = 'add a retry wrapper around fetch';

    it('Copilot envelope: empty stdout, ZERO stub calls, one stderr line, exit 0', () => {
      const t = relocatedRoot('arch-copilot');
      const r = spawnHook('arch-memory-check.sh', copilot('UserPromptSubmit', { prompt: PROMPT }), { cwd: t.root, hooksDir: t.hooksDir, env: hermetic });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.deepEqual(t.calls(), []);
      assert.equal(r.stderr.trim().split('\n').length, 1);
      assert.match(r.stderr, /Copilot host detected/);
    });
    it('Claude envelope (control): the query RUNS — the stub is called', () => {
      const t = relocatedRoot('arch-claude');
      const r = spawnHook('arch-memory-check.sh', claude('UserPromptSubmit', { prompt: PROMPT }), { cwd: t.root, hooksDir: t.hooksDir, env: hermetic });
      assert.equal(r.status, 0);
      assert.ok(t.calls().includes('get-neighbourhood'), `calls: ${t.calls()}`);
      assert.doesNotMatch(r.stderr, /Copilot host detected|hook-host unavailable/);
    });
    it('unknown envelope (bare prompt) still runs the query: only a POSITIVE copilot detection skips', () => {
      const t = relocatedRoot('arch-unknown');
      spawnHook('arch-memory-check.sh', { prompt: PROMPT }, { cwd: t.root, hooksDir: t.hooksDir, env: hermetic });
      assert.ok(t.calls().includes('get-neighbourhood'));
    });
    it('no intent verb under a Copilot envelope: unchanged — silent, no calls', () => {
      const t = relocatedRoot('arch-noverb');
      const r = spawnHook('arch-memory-check.sh', copilot('UserPromptSubmit', { prompt: 'thanks, looks good' }), { cwd: t.root, hooksDir: t.hooksDir, env: hermetic });
      assert.deepEqual([r.status, r.stdout, t.calls()], [0, '', []]);
    });
    it('load failure (module absent): one stderr line, and the query runs as it does today even for a Copilot envelope', () => {
      const t = relocatedRoot('arch-noload', { withHostLib: false });
      const r = spawnHook('arch-memory-check.sh', copilot('UserPromptSubmit', { prompt: PROMPT }), { cwd: t.root, hooksDir: t.hooksDir, env: hermetic });
      assert.equal(r.status, 0);
      assert.match(r.stderr, /hook-host unavailable — legacy Claude path/);
      assert.ok(t.calls().includes('get-neighbourhood'));
    });
    it('consumer layout: the module under scripts/.claude-skills/lib is found from a non-repo cwd', () => {
      const t = relocatedRoot('arch-consumer', { libDir: ['scripts', '.claude-skills', 'lib'] });
      const r = spawnHook('arch-memory-check.sh', copilot('UserPromptSubmit', { prompt: PROMPT }), { cwd: os.tmpdir(), hooksDir: t.hooksDir, env: hermetic });
      assert.equal(r.status, 0);
      assert.deepEqual(t.calls(), []);
      assert.match(r.stderr, /Copilot host detected/);
    });
  });

  describe('load-failure contract (node hooks): legacy path, one stderr line, byte-identical stdout, exit 0', () => {
    function relocatedHooks(name, { withHostLib }) {
      const root = path.join(tmp, name);
      const hooksDir = path.join(root, '.claude', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      for (const f of ['bash-grep-nudge.mjs', 'syntax-check.mjs']) fs.copyFileSync(path.join(HOOKS, f), path.join(hooksDir, f));
      copyLibClosure('scripts/lib/sensitive-paths.mjs', path.join(root, 'scripts', '.claude-skills', 'lib'));
      if (withHostLib) copyLibClosure('scripts/lib/hook-host.mjs', path.join(root, 'scripts', '.claude-skills', 'lib'));
      return { root, hooksDir };
    }
    it('bash-grep-nudge', () => {
      const withLib = relocatedHooks('nudge-with', { withHostLib: true });
      const without = relocatedHooks('nudge-without', { withHostLib: false });
      const payload = { tool_name: 'Bash', tool_input: { command: 'rg foo src' } };
      const a = spawnHook('bash-grep-nudge.mjs', payload, { cwd: os.tmpdir(), hooksDir: withLib.hooksDir });
      const b = spawnHook('bash-grep-nudge.mjs', payload, { cwd: os.tmpdir(), hooksDir: without.hooksDir });
      assert.equal(a.stdout, GREP_DENY_SNAPSHOT);
      assert.equal(a.stderr, '');
      assert.equal(b.stdout, GREP_DENY_SNAPSHOT);
      assert.deepEqual([a.status, b.status], [0, 0]);
      assert.match(b.stderr, /\[bash-grep-nudge\] hook-host unavailable — legacy Claude path/);
      const ps = { tool_name: 'PowerShell', tool_input: { command: 'gci -r | sls foo' } };
      const c = spawnHook('bash-grep-nudge.mjs', ps, { cwd: os.tmpdir(), hooksDir: withLib.hooksDir });
      const d = spawnHook('bash-grep-nudge.mjs', ps, { cwd: os.tmpdir(), hooksDir: without.hooksDir });
      assert.notEqual(c.stdout, '');
      assert.equal(d.stdout, c.stdout);
    });
    it('syntax-check', () => {
      const withLib = relocatedHooks('syn-with', { withHostLib: true });
      const without = relocatedHooks('syn-without', { withHostLib: false });
      const file = path.join(withLib.root, 'broken.mjs');
      fs.writeFileSync(file, 'export const a = ;\n');
      const payload = { tool_name: 'Edit', tool_input: { file_path: file } };
      const a = spawnHook('syntax-check.mjs', payload, { cwd: os.tmpdir(), hooksDir: withLib.hooksDir });
      fs.copyFileSync(file, path.join(without.root, 'broken.mjs'));
      const b = spawnHook('syntax-check.mjs', { tool_name: 'Edit', tool_input: { file_path: path.join(without.root, 'broken.mjs') } }, { cwd: os.tmpdir(), hooksDir: without.hooksDir });
      assert.equal(a.status, 0);
      assert.equal(b.status, 0);
      assert.match(JSON.parse(a.stdout).systemMessage, /Syntax error/);
      assert.match(JSON.parse(b.stdout).systemMessage, /Syntax error/);
      assert.match(b.stderr, /\[syntax-check\] hook-host unavailable — legacy Claude path/);
      assert.doesNotMatch(a.stderr, /hook-host unavailable/);
    });
  });
});

// ── 3. Tier 2 — recorded Copilot fixtures (SKIPPED until cluster A's capture lands) ──

describe('Tier 2: recorded Copilot tool_input mapping', () => {
  const rows = [
    'normaliseToolEvent maps the recorded Copilot shell event to {kind:"shell"}',
    'normaliseToolEvent maps the recorded Copilot edit/str_replace_editor/create event to {kind:"file"}',
    'bash-grep-nudge: a leading rg on Copilot gives a top-level permissionDecision:"deny"; a non-grep command is silent',
    'quickfix-scan: a trigger edit on Copilot gives a top-level additionalContext; a clean edit is silent',
    'syntax-check: a broken .mjs on Copilot gives a top-level additionalContext; a valid one is silent',
    'syntax-check / quickfix-scan: a sensitive path in a Copilot payload still short-circuits (INC-001)',
  ];
  for (const row of rows) {
    // If fixtures ARRIVE, this fails loudly: a skipped placeholder must not turn into a silent pass.
    it(row, { skip: TIER2_SKIP }, () => assert.fail('Tier 2 fixtures are present but this test is not implemented yet — implement it from the recorded payloads'));
  }
});
