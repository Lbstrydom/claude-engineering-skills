/**
 * Integration tests for .claude/hooks/quickfix-scan.mjs
 * Plan ACs: AC17, AC18, AC19, AC20, AC21, AC45, AC46.
 *
 * The hook reads JSON from stdin and emits {systemMessage} to stdout on hits.
 * Tests spawn the hook as a subprocess and feed stdin payloads.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Audit R1-M17: resolve hook path relative to THIS test file, not cwd.
const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.resolve(TEST_DIR, '..', '.claude', 'hooks', 'quickfix-scan.mjs');

// The hook resolves its telemetry path from REPO_ROOT, so spawning it here
// appended a real hit per fixture per run to .audit/quickfix-hits.jsonl —
// 96% of the recorded corpus was this suite. Redirect to a temp file.
const TMP_TELEMETRY = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'quickfix-hook-test-')),
  'quickfix-hits.jsonl',
);

function runHook(stdinJson, env = {}) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify(stdinJson),
    env: { ...process.env, QUICKFIX_TELEMETRY_PATH: TMP_TELEMETRY, ...env },
    encoding: 'utf-8',
    timeout: 5000,
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

describe('quickfix-hook integration', () => {
  it('AC17 — fires on Edit with empty-catch + emits systemMessage with file + Snippet', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: {
        file_path: 'src/test-fixture-quickfix-edit.js',
        new_string: 'try { x } catch {}\n',
      },
    });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.length > 0, 'expected stdout output on hit');
    const out = JSON.parse(r.stdout);
    assert.ok(out.systemMessage, 'systemMessage required');
    assert.match(out.systemMessage, /empty-catch/);
    assert.match(out.systemMessage, /Snippet:/);
    assert.match(out.systemMessage, /test-fixture-quickfix-edit\.js/);
  });

  it('fires on Write with TODO comment', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: 'src/test-fixture-quickfix-write.js',
        content: '// TODO: implement this\nfunction foo() {}\n',
      },
    });
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.match(out.systemMessage, /todo-fixme-hack/);
  });

  it('AC18 — never sets continue:false', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'a.js', new_string: 'try { x } catch {}' },
    });
    if (r.stdout.length > 0) {
      const out = JSON.parse(r.stdout);
      assert.notEqual(out.continue, false, 'hook must never block tool execution');
    }
  });

  it('AC19 — QUICKFIX_HOOK_DISABLE=1 short-circuits silently', () => {
    const r = runHook(
      {
        tool_name: 'Edit',
        tool_input: { file_path: 'src/disabled.js', new_string: 'try { x } catch {}' },
      },
      { QUICKFIX_HOOK_DISABLE: '1' },
    );
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'no stdout when disabled');
  });

  it('no output on clean code', () => {
    const r = runHook({
      tool_name: 'Edit',
      tool_input: { file_path: 'src/clean.js', new_string: 'function foo() { return 42 }\n' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'no stdout when no patterns match');
  });

  it('AC45 §13.A — sensitive .env path → silent exit (no scan)', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: '.env',
        content: 'API_KEY=sk-test\n// TODO: rotate this\n',
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '', 'sensitive file should produce no scan output');
  });

  it('AC45 — sensitive secrets/ path → silent exit', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: {
        file_path: 'secrets/api-keys.json',
        content: '{"key": "sk-test"}\n// TODO\n',
      },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  // Audit R1-M15: full sensitive-path matrix coverage matches the policy
  for (const sensitivePath of [
    '.aws/credentials',
    '.ssh/id_rsa',
    'foo.pem',
    'foo.key',
    'foo.crt',
    'creds/foo.p12',
    '/Users/me/repo/.env',                    // absolute Posix
    'credentials.json',
  ]) {
    it(`R1-M15 — sensitive path "${sensitivePath}" → silent exit`, () => {
      const r = runHook({
        tool_name: 'Write',
        tool_input: {
          file_path: sensitivePath,
          content: '// TODO some content\ntry { x } catch {}\n',
        },
      });
      assert.equal(r.status, 0);
      assert.equal(r.stdout.trim(), '', `${sensitivePath} should be silent`);
    });
  }

  it('handles malformed stdin gracefully (exit 0, no stdout)', () => {
    const r = spawnSync('node', [HOOK], {
      input: '{not json',
      encoding: 'utf-8',
      timeout: 5000,
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('non-Edit/Write tool → silent exit', () => {
    const r = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  it('binary extension → silent exit', () => {
    const r = runHook({
      tool_name: 'Write',
      tool_input: { file_path: 'image.png', content: 'binary-content // TODO' },
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });
});
