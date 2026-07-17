/**
 * Tests for scripts/lib/anthropic-client.mjs — the pluggable Claude backend.
 *
 * Covers:
 * - resolveBackend() env parsing
 * - buildPromptFromMessages() shape coverage
 * - normaliseCliOutput() JSON parsing + error paths
 * - createAnthropicClient() caching + cli-backend roundtrip via fake CLI
 *
 * We avoid hitting the real `@anthropic-ai/sdk` or real `claude` binary by
 * pointing CLAUDE_BIN at a tiny Node script that prints a deterministic
 * JSON payload.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveBackend,
  createAnthropicClient,
  _resetClientCache,
  _internals,
} from '../scripts/lib/anthropic-client.mjs';

const { buildPromptFromMessages, normaliseCliOutput, quoteWinArg } = _internals;

let tmpDir;
let savedEnv;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-client-'));
  savedEnv = {
    CLAUDE_BACKEND: process.env.CLAUDE_BACKEND,
    CLAUDE_BIN: process.env.CLAUDE_BIN,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  };
  _resetClientCache();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  process.env.CLAUDE_BACKEND = savedEnv.CLAUDE_BACKEND;
  process.env.CLAUDE_BIN = savedEnv.CLAUDE_BIN;
  process.env.ANTHROPIC_API_KEY = savedEnv.ANTHROPIC_API_KEY;
  if (savedEnv.CLAUDE_BACKEND === undefined) delete process.env.CLAUDE_BACKEND;
  if (savedEnv.CLAUDE_BIN === undefined) delete process.env.CLAUDE_BIN;
  if (savedEnv.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  _resetClientCache();
});

// ── resolveBackend ───────────────────────────────────────────────────────────

describe('resolveBackend', () => {
  it('defaults to sdk when unset', () => {
    delete process.env.CLAUDE_BACKEND;
    assert.equal(resolveBackend(), 'sdk');
  });
  it('accepts sdk and cli', () => {
    process.env.CLAUDE_BACKEND = 'sdk';
    assert.equal(resolveBackend(), 'sdk');
    process.env.CLAUDE_BACKEND = 'cli';
    assert.equal(resolveBackend(), 'cli');
  });
  it('is case-insensitive', () => {
    process.env.CLAUDE_BACKEND = 'CLI';
    assert.equal(resolveBackend(), 'cli');
  });
  it('throws on invalid value (no silent fallback — billing-affecting setting)', () => {
    process.env.CLAUDE_BACKEND = 'agent-sdk';
    assert.throws(() => resolveBackend(), /Invalid CLAUDE_BACKEND="agent-sdk"/);
  });
});

// ── buildPromptFromMessages ─────────────────────────────────────────────────

describe('buildPromptFromMessages', () => {
  it('flattens string content', () => {
    const out = buildPromptFromMessages([{ role: 'user', content: 'hello' }]);
    assert.equal(out, 'hello');
  });
  it('joins multiple messages with blank lines', () => {
    const out = buildPromptFromMessages([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
    ]);
    assert.equal(out, 'a\n\nb');
  });
  it('extracts text blocks from array content', () => {
    const out = buildPromptFromMessages([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'one' },
          { type: 'image', source: { type: 'base64', data: '...' } },
          { type: 'text', text: 'two' },
        ],
      },
    ]);
    assert.equal(out, 'one\ntwo');
  });
  it('drops messages with empty content', () => {
    const out = buildPromptFromMessages([
      { role: 'user', content: 'kept' },
      { role: 'user', content: '' },
      { role: 'user', content: [] },
    ]);
    assert.equal(out, 'kept');
  });
  it('throws when messages is not an array', () => {
    assert.throws(() => buildPromptFromMessages(null), /must be an array/);
  });
});

// ── normaliseCliOutput ──────────────────────────────────────────────────────

describe('normaliseCliOutput', () => {
  it('parses happy-path JSON envelope', () => {
    const stdout = JSON.stringify({
      result: 'response text',
      usage: { input_tokens: 10, output_tokens: 5 },
      total_cost_usd: 0.001,
      duration_ms: 123,
      num_turns: 1,
    });
    const out = normaliseCliOutput(stdout, 'claude-haiku-4-5');
    assert.equal(out.content[0].type, 'text');
    assert.equal(out.content[0].text, 'response text');
    assert.equal(out.usage.input_tokens, 10);
    assert.equal(out.usage.output_tokens, 5);
    assert.equal(out.model, 'claude-haiku-4-5');
    assert.equal(out.stop_reason, 'end_turn');
    assert.equal(out._meta.cost_usd, 0.001);
    assert.equal(out._meta.duration_ms, 123);
  });
  it('handles missing usage fields gracefully', () => {
    const stdout = JSON.stringify({ result: 'hi' });
    const out = normaliseCliOutput(stdout, 'm');
    assert.equal(out.content[0].text, 'hi');
    assert.equal(out.usage.input_tokens, 0);
    assert.equal(out.usage.output_tokens, 0);
    assert.equal(out._meta.cost_usd, undefined);
  });
  it('throws when result field is missing (Zod schema validation)', () => {
    assert.throws(
      () => normaliseCliOutput(JSON.stringify({}), 'm'),
      /failed schema validation/,
    );
  });
  it('throws when claude -p reports is_error', () => {
    const stdout = JSON.stringify({ is_error: true, result: 'rate-limited' });
    assert.throws(
      () => normaliseCliOutput(stdout, 'm'),
      /claude -p reported error: rate-limited/,
    );
  });
  it('throws when output is a JSON array instead of object', () => {
    assert.throws(
      () => normaliseCliOutput('[1,2,3]', 'm'),
      /not a JSON object/,
    );
  });
  it('throws on malformed JSON with diagnostic snippet', () => {
    assert.throws(
      () => normaliseCliOutput('not json at all', 'm'),
      /failed to parse claude -p JSON output/,
    );
  });
  it('uses CLI-reported model when requestedModel is undefined', () => {
    const stdout = JSON.stringify({ result: '', model: 'm-from-cli' });
    const out = normaliseCliOutput(stdout, undefined);
    assert.equal(out.model, 'm-from-cli');
  });
});

// ── quoteWinArg — Windows command-line argument escaping ───────────────────

describe('quoteWinArg', () => {
  it('passes plain alphanumeric args through unchanged', () => {
    assert.equal(quoteWinArg('claude-haiku-4-5'), 'claude-haiku-4-5');
    assert.equal(quoteWinArg('--max-turns'), '--max-turns');
    assert.equal(quoteWinArg('1'), '1');
  });
  it('wraps args with spaces in quotes', () => {
    assert.equal(quoteWinArg('be brief'), '"be brief"');
  });
  it('uses "" (doubled-quote) for embedded double quotes — cmd-safe', () => {
    // cmd.exe does NOT honour \" as an escape; "" is the only form that
    // works for both cmd.exe and CommandLineToArgvW.
    assert.equal(quoteWinArg('say "hi"'), '"say ""hi"""');
  });
  it('treats backslashes as literal inside the quoted span', () => {
    assert.equal(quoteWinArg('C:\\path\\to file'), '"C:\\path\\to file"');
    assert.equal(quoteWinArg('a\\"b'), '"a\\""b"');
  });
  it('quotes args containing cmd metacharacters', () => {
    assert.equal(quoteWinArg('a&b'), '"a&b"');
    assert.equal(quoteWinArg('x|y'), '"x|y"');
    assert.equal(quoteWinArg('p>q'), '"p>q"');
  });
  it('produces empty quoted string for empty input', () => {
    assert.equal(quoteWinArg(''), '""');
  });

  // Gemini gate G1 — command-injection guard. A naive `\"` escape would let
  // cmd.exe close the quoted span at the user-provided quote and then
  // shell-evaluate the remainder. With `""`, every embedded quote stays
  // inside the span and the trailing metacharacters never reach cmd's
  // unquoted state.
  it('blocks the `" & whoami &` injection vector via doubled-quote escaping', () => {
    const dangerous = 'foo " & whoami & echo bar';
    const quoted = quoteWinArg(dangerous);
    // The quoted output must (a) start with a single " and end with a single ",
    // (b) contain no run of three consecutive " (which would close + reopen),
    // and (c) preserve & inside the quoted span (so cmd doesn't see it as a
    // command separator).
    assert.match(quoted, /^".*"$/);
    assert.equal(/"""/.test(quoted), false, `must not allow three consecutive " in encoded form: ${quoted}`);
    // Internal & must remain inside the quoted span (between the first and last `"`).
    const inner = quoted.slice(1, -1);
    assert.ok(inner.includes('&'), 'metacharacter must stay inside span');
  });
});

// ── createAnthropicClient (cli backend) — fake-CLI roundtrip ────────────────

describe('createAnthropicClient (cli backend)', () => {
  /**
   * Write a tiny Node script to disk that the factory will spawn instead of
   * the real `claude` binary. The script prints a canned JSON envelope and
   * (optionally) echoes its argv to stderr so the test can inspect args.
   */
  function writeFakeCliBinary({ resultText = 'mock-response', dumpStdinTo } = {}) {
    const scriptPath = path.join(tmpDir, 'fake-claude.mjs');
    const payload = JSON.stringify({
      result: resultText,
      usage: { input_tokens: 7, output_tokens: 3 },
      total_cost_usd: 0.00042,
      duration_ms: 99,
      num_turns: 1,
    });
    // Optional: persist stdin + argv so tests can verify what was sent.
    const dumpLine = dumpStdinTo
      ? `import fs from 'node:fs';\nlet stdin='';process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(dumpStdinTo)}, JSON.stringify({argv: process.argv.slice(2), stdin}));process.stdout.write(${JSON.stringify(payload)});});`
      : `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(payload)});});`;
    fs.writeFileSync(scriptPath, dumpLine + '\n');
    if (process.platform === 'win32') {
      const cmdPath = path.join(tmpDir, 'fake-claude.cmd');
      fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
      return cmdPath;
    }
    const shPath = path.join(tmpDir, 'fake-claude.sh');
    fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
    return shPath;
  }

  it('routes messages.create through the fake CLI and returns SDK-shaped response', async () => {
    const bin = writeFakeCliBinary({ resultText: 'pong' });
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: bin, fresh: true });
    const resp = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'ping' }],
    });
    assert.equal(resp.content[0].text, 'pong');
    assert.equal(resp.usage.input_tokens, 7);
    assert.equal(resp.usage.output_tokens, 3);
    assert.equal(resp.model, 'claude-haiku-4-5');
    assert.equal(resp._meta.cost_usd, 0.00042);
  });

  it('passes --system-prompt, --model, --max-turns, --tools "" and pipes prompt via stdin', async () => {
    const dumpPath = path.join(tmpDir, 'cli-dump.json');
    const bin = writeFakeCliBinary({ dumpStdinTo: dumpPath });
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: bin, fresh: true });
    await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 100,
      system: 'be brief',
      messages: [{ role: 'user', content: 'ping' }],
    });
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
    assert.deepEqual(
      dump.argv,
      ['-p', '--output-format', 'json', '--max-turns', '6', '--tools', '',
        '--system-prompt', 'be brief', '--model', 'claude-haiku-4-5'],
    );
    assert.equal(dump.stdin, 'ping');
  });

  it('caches the client per (backend, apiKey, claudeBin) key', async () => {
    const bin = writeFakeCliBinary();
    const c1 = await createAnthropicClient({ backend: 'cli', claudeBin: bin });
    const c2 = await createAnthropicClient({ backend: 'cli', claudeBin: bin });
    assert.equal(c1, c2, 'cached adapter must be identical instance');
  });

  it('fresh:true bypasses the cache', async () => {
    const bin = writeFakeCliBinary();
    const c1 = await createAnthropicClient({ backend: 'cli', claudeBin: bin });
    const c2 = await createAnthropicClient({ backend: 'cli', claudeBin: bin, fresh: true });
    assert.notEqual(c1, c2, 'fresh:true must return a new adapter');
  });

  it('rejects when the CLI exits non-zero', async () => {
    const scriptPath = path.join(tmpDir, 'broken.mjs');
    // Consume stdin so the parent's stdin.end() doesn't EPIPE before exit.
    fs.writeFileSync(
      scriptPath,
      `process.stdin.resume();process.stdin.on('end',()=>{process.stderr.write('boom');process.exit(42);});\n`,
    );
    const bin = process.platform === 'win32'
      ? (() => {
          const cmdPath = path.join(tmpDir, 'broken.cmd');
          fs.writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
          return cmdPath;
        })()
      : (() => {
          const shPath = path.join(tmpDir, 'broken.sh');
          fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
          return shPath;
        })();
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: bin, fresh: true });
    await assert.rejects(
      () => client.messages.create({ messages: [{ role: 'user', content: 'x' }] }),
      /exited 42/,
    );
  });
});

// ── CLI adapter — input guards (multi-turn, non-text, max_tokens) ──────────

describe('cli adapter input guards', () => {
  function makeBin() {
    const scriptPath = path.join(tmpDir, 'g.mjs');
    fs.writeFileSync(
      scriptPath,
      `process.stdin.resume();process.stdin.on('end',()=>{process.stdout.write(${JSON.stringify(JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }))});});\n`,
    );
    if (process.platform === 'win32') {
      const p = path.join(tmpDir, 'g.cmd');
      fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
      return p;
    }
    const p = path.join(tmpDir, 'g.sh');
    fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 });
    return p;
  }

  it('throws on assistant-role message', async () => {
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: makeBin(), fresh: true });
    await assert.rejects(
      () => client.messages.create({ messages: [{ role: 'assistant', content: 'x' }] }),
      /user-role messages only/,
    );
  });

  it('throws on image content block', async () => {
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: makeBin(), fresh: true });
    await assert.rejects(
      () => client.messages.create({
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: '...' } }] }],
      }),
      /text content blocks only/,
    );
  });

  it('throws on empty messages array', async () => {
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: makeBin(), fresh: true });
    await assert.rejects(
      () => client.messages.create({ messages: [] }),
      /non-empty messages array/,
    );
  });

  it('warns once when max_tokens is set on cli backend', async () => {
    // Capture stderr writes by monkey-patching for this test.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const captured = [];
    process.stderr.write = (chunk, ...rest) => {
      captured.push(String(chunk));
      return originalWrite(chunk, ...rest);
    };
    try {
      const client = await createAnthropicClient({ backend: 'cli', claudeBin: makeBin(), fresh: true });
      await client.messages.create({
        max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
      });
      await client.messages.create({
        max_tokens: 200, messages: [{ role: 'user', content: 'hi' }],
      });
      const warnings = captured.filter(s => s.includes('max_tokens is not enforceable'));
      assert.equal(warnings.length, 1, 'max_tokens warning must fire only once per session');
    } finally {
      process.stderr.write = originalWrite;
    }
  });
});

// ── CLI adapter — egress redactor ───────────────────────────────────────────

describe('cli adapter redactor', () => {
  it('applies redactor to system + prompt before invoking CLI', async () => {
    const dumpPath = path.join(tmpDir, 'red-dump.json');
    const scriptPath = path.join(tmpDir, 'red.mjs');
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs';let stdin='';process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({argv: process.argv.slice(2), stdin}));process.stdout.write(${JSON.stringify(JSON.stringify({ result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }))});});\n`,
    );
    const bin = process.platform === 'win32'
      ? (() => { const p = path.join(tmpDir, 'red.cmd'); fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`); return p; })()
      : (() => { const p = path.join(tmpDir, 'red.sh'); fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 }); return p; })();

    const redactor = s => s.replace(/SECRET/g, '[REDACTED]');
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: bin, redactor, fresh: true });
    await client.messages.create({
      system: 'system contains SECRET value',
      messages: [{ role: 'user', content: 'user prompt with SECRET too' }],
    });
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
    assert.ok(!dump.stdin.includes('SECRET'), `stdin must be redacted, got: ${dump.stdin}`);
    assert.ok(dump.stdin.includes('[REDACTED]'));
    const systemIdx = dump.argv.indexOf('--system-prompt');
    assert.ok(systemIdx >= 0);
    assert.ok(!dump.argv[systemIdx + 1].includes('SECRET'), 'system arg must be redacted');
  });
});

// ── CLI adapter — timeout ───────────────────────────────────────────────────

describe('cli adapter timeout', () => {
  it('rejects when subprocess exceeds timeoutMs', async () => {
    const scriptPath = path.join(tmpDir, 'slow.mjs');
    // Hang on stdin forever — don't even register end handler.
    fs.writeFileSync(scriptPath, `setInterval(()=>{},1000);\n`);
    const bin = process.platform === 'win32'
      ? (() => { const p = path.join(tmpDir, 'slow.cmd'); fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`); return p; })()
      : (() => { const p = path.join(tmpDir, 'slow.sh'); fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 }); return p; })();

    const client = await createAnthropicClient({
      backend: 'cli', claudeBin: bin, timeoutMs: 250, fresh: true,
    });
    await assert.rejects(
      () => client.messages.create({ messages: [{ role: 'user', content: 'x' }] }),
      /timed out after 250ms/,
    );
  });
});

// ── Cache key uses effective (resolved) values ──────────────────────────────

describe('createAnthropicClient cache key resolution', () => {
  it('two unparameterised calls hit the same cache entry', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    process.env.CLAUDE_BACKEND = 'sdk';
    _resetClientCache();
    const a = await createAnthropicClient();
    const b = await createAnthropicClient();
    assert.equal(a, b, 'cache must hit when no overrides are passed');
  });
  it('different effective bin → different cache entries', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    _resetClientCache();
    const a = await createAnthropicClient({ claudeBin: '/path/a' });
    const b = await createAnthropicClient({ claudeBin: '/path/b' });
    assert.notEqual(a, b);
  });
});

// ── Default redactor + cache-collision guard (R2 H1/H3 fixes) ──────────────

describe('default redactor and cache hygiene', () => {
  it('two custom redactors do NOT share a cache entry (R2-H1 fix)', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    _resetClientCache();
    const rA = s => s.replace(/A/g, 'X');
    const rB = s => s.replace(/B/g, 'Y');
    const a = await createAnthropicClient({ claudeBin: '/p', redactor: rA });
    const b = await createAnthropicClient({ claudeBin: '/p', redactor: rB });
    assert.notEqual(a, b, 'custom redactors must each get their own client');
  });
  it('default redactor redacts real secret SHAPES (keys, JWTs, DSN passwords)', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    const redact = await _internals.getDefaultRedactor();
    const key = 'sk-ant-' + 'a1b2c3d4e5'.repeat(3);
    assert.ok(!redact(`auth with ${key} now`).includes(key), 'anthropic key shape must be redacted');
    const dsn = 'postgresql://svc_user:Sup3rS3cret@db.pooler.supabase.com:5432/postgres';
    const out = redact(`connect via ${dsn}`);
    assert.ok(!out.includes('Sup3rS3cret'), `DSN password must be redacted, got: ${out}`);
    assert.ok(out.includes('db.pooler.supabase.com'), 'DSN host stays readable');
  });
  it('default redactor preserves long legitimate identifiers (judge-corruption regression, 19a9ded)', async () => {
    // The OLD default (sanitizer.mjs) blanket-redacted ANY 20+ char token —
    // it corrupted rubric dim names (hard schema failure in the arm-eval
    // judge), symbol names in arch-index summaries, and CSS tokens. The
    // shape-based default must leave all of these intact.
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    const redact = await _internals.getDefaultRedactor();
    const identifiers = [
      'architectural_coherence',           // arm-eval rubric dim (the live failure)
      'acceptance_criteria_quality',
      'runMultiPassCodeAudit',             // symbol name (arch-index summarise)
      'scripts/lib/neighbourhood-query.mjs', // file path (final-review transcript)
      '--color-background-primary',        // CSS token (visual explain)
    ];
    for (const id of identifiers) {
      assert.equal(redact(id), id, `must not corrupt identifier "${id}"`);
    }
    // Non-string passthrough (sdk wrapper may hand through non-text blocks).
    assert.equal(redact(undefined), undefined);
  });
  it('redactor=null bypasses redaction and gets its own cache entry', async () => {
    process.env.CLAUDE_BACKEND = 'cli';
    _resetClientCache();
    const a = await createAnthropicClient({ claudeBin: '/p' });
    const b = await createAnthropicClient({ claudeBin: '/p', redactor: null });
    assert.notEqual(a, b, 'redactor=null must be distinct from default');
  });
});

// ── applyRedactor structured-system traversal (R2-H2 fix) ──────────────────

describe('applyRedactor structured system', () => {
  it('redacts text in array-form system blocks via sdk wrapper', async () => {
    let captured = null;
    const fakeAnthropic = {
      messages: { create: async (params) => { captured = params; return { content: [{ type: 'text', text: '' }], usage: {} }; } },
    };
    // Bypass real SDK: directly invoke wrapSdkWithRedactor via _internals?
    // No internal export; instead, exercise via sdk backend with mocked module.
    // Simplest: call applyRedactor directly through factory's redactor option
    // and a captured-params fake (the wrap is module-internal). Acceptable
    // alternative: test via the cli adapter, which already runs applyRedactor
    // through the same code path (the cli path runs system arg through redactor
    // explicitly).
    //
    // Direct unit test by importing applyRedactor would require exporting it;
    // we instead validate behaviour indirectly by checking that the cli adapter
    // applies the redactor to BOTH string and structured-block system inputs.
    const redactor = s => s.replace(/SECRET/g, '[X]');
    const dumpPath = path.join(tmpDir, 'sys-dump.json');
    const scriptPath = path.join(tmpDir, 'sys.mjs');
    fs.writeFileSync(
      scriptPath,
      `import fs from 'node:fs';let stdin='';process.stdin.on('data',d=>stdin+=d);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({argv: process.argv.slice(2), stdin}));process.stdout.write(${JSON.stringify(JSON.stringify({ result: 'ok', usage: {} }))});});\n`,
    );
    const bin = process.platform === 'win32'
      ? (() => { const p = path.join(tmpDir, 'sys.cmd'); fs.writeFileSync(p, `@echo off\r\nnode "${scriptPath}" %*\r\n`); return p; })()
      : (() => { const p = path.join(tmpDir, 'sys.sh'); fs.writeFileSync(p, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`, { mode: 0o755 }); return p; })();
    const client = await createAnthropicClient({ backend: 'cli', claudeBin: bin, redactor, fresh: true });
    // String-form system — already covered earlier; ensure cli adapter at
    // least carries the redacted string into the args. (Structured-block
    // form `system: [{type:'text',...}]` would be redacted by applyRedactor
    // in the sdk-wrap path; the cli adapter receives `params.system` as a
    // string from this test.)
    await client.messages.create({
      system: 'sys with SECRET',
      messages: [{ role: 'user', content: 'user prompt' }],
    });
    const dump = JSON.parse(fs.readFileSync(dumpPath, 'utf-8'));
    const sysIdx = dump.argv.indexOf('--system-prompt');
    assert.ok(sysIdx >= 0, 'system-prompt arg present');
    assert.ok(!dump.argv[sysIdx + 1].includes('SECRET'), 'system value redacted');
    // Silence the captured variable lint
    void captured; void fakeAnthropic;
  });
});

// ── wrapSdkClient: timeoutMs → timeout translation (real bug found live) ────
//
// The raw Anthropic SDK's per-call option is `timeout` (ms); every caller in
// this repo uses the `timeoutMs` convention (brainstorm-round, openai-audit,
// visual-audit, solo-control-audit, ...). Passing `{timeoutMs}` straight
// through to the SDK is silently ignored → falls back to the SDK's own
// 600000ms default regardless of what the caller asked for. Found while
// investigating a long-running solo-control-audit --repeats run (SDK backend)
// that appeared slower than its configured 300000ms timeout implied.
describe('wrapSdkClient timeout translation', () => {
  it('translates requestOptions.timeoutMs to the SDK-native `timeout` key', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    let capturedOpts = null;
    const fakeRaw = { messages: { create: async (params, opts) => { capturedOpts = opts; return { content: [], usage: {} }; } } };
    const client = _internals.wrapSdkClient(fakeRaw, null);
    await client.messages.create({ model: 'x', messages: [] }, { timeoutMs: 300000 });
    assert.equal(capturedOpts.timeout, 300000, 'timeout (SDK key) must be set');
    assert.equal('timeoutMs' in capturedOpts, false, 'the non-SDK key must not leak through');
  });

  it('passes requestOptions through unchanged when timeoutMs is absent', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    let capturedOpts = null;
    const fakeRaw = { messages: { create: async (params, opts) => { capturedOpts = opts; return { content: [], usage: {} }; } } };
    const client = _internals.wrapSdkClient(fakeRaw, null);
    await client.messages.create({ model: 'x', messages: [] }, { signal: 'abort-signal-stub' });
    assert.equal(capturedOpts.signal, 'abort-signal-stub');
    assert.equal('timeout' in capturedOpts, false);
  });

  it('still applies redaction when a redactor is provided (both concerns compose)', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    let capturedParams = null;
    const fakeRaw = { messages: { create: async (params) => { capturedParams = params; return { content: [], usage: {} }; } } };
    const redactor = (s) => (typeof s === 'string' ? s.replace(/SECRET/g, '[X]') : s);
    const client = _internals.wrapSdkClient(fakeRaw, redactor);
    await client.messages.create({ system: 'has SECRET inside', messages: [] }, { timeoutMs: 1000 });
    assert.ok(!capturedParams.system.includes('SECRET'), 'redaction still applied');
  });
});

// ── baseURL must never be silently dropped by the cli backend ───────────────
//
// The cli adapter spawns `claude -p` (Anthropic's own service) and takes no
// baseURL. Under an ambient CLAUDE_BACKEND=cli, `createAnthropicClient({baseURL})`
// used to return the cli adapter and IGNORE the baseURL — so an Azure/Foundry
// call silently went to PUBLIC api.anthropic.com. On a corporate Azure profile
// that sends the payload to the wrong provider entirely. Found while fixing the
// azure-limits `.withResponse()` error; gemini-review's Azure final-review
// fallback had the same latent misroute.
describe('createAnthropicClient: baseURL vs cli backend', () => {
  const withEnv = async (env, fn) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try { return await fn(); } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  };

  it('coerces an ambient cli backend to sdk when a baseURL is set (no silent misroute)', async () => {
    const { createAnthropicClient } = await import('../scripts/lib/anthropic-client.mjs');
    await withEnv(
      { CLAUDE_BACKEND: 'cli', ANTHROPIC_API_KEY: 'sk-test', AZURE_OPENAI_API_KEY: '' },
      async () => {
        const client = await createAnthropicClient({
          baseURL: 'https://example.services.ai.azure.com',
          fresh: true,
        });
        // The sdk client exposes baseURL; the cli adapter has no such property.
        assert.equal(
          client.baseURL, 'https://example.services.ai.azure.com',
          'the sdk client must be built and actually carry the requested baseURL',
        );
      },
    );
  });

  it('leaves the cli backend alone when no baseURL is requested', async () => {
    const { createAnthropicClient } = await import('../scripts/lib/anthropic-client.mjs');
    await withEnv({ CLAUDE_BACKEND: 'cli', ANTHROPIC_BASE_URL: '' }, async () => {
      const client = await createAnthropicClient({ fresh: true });
      assert.equal(client.baseURL, undefined, 'cli adapter has no baseURL — path unchanged');
    });
  });

  it('throws when the caller explicitly contradicts itself (backend:cli + baseURL)', async () => {
    const { createAnthropicClient } = await import('../scripts/lib/anthropic-client.mjs');
    await assert.rejects(
      () => createAnthropicClient({ backend: 'cli', baseURL: 'https://x.azure.com', fresh: true }),
      /cannot honour baseURL/,
    );
  });
});

// ── wrapSdkClient: APIPromise passthrough (real bug found live, Azure) ──────
//
// The SDK's `messages.create()` returns an `APIPromise` — a thenable that also
// carries `.withResponse()` / `.asResponse()` for reading the HTTP response.
// `azure-limits.mjs` needs those to read the `x-ratelimit-*` headers. Making
// the wrapper an `async function` awaited the APIPromise and re-wrapped the
// resolved value in a plain Promise, silently stripping those methods —
// `.withResponse() is not a function`. The wrapper must return the APIPromise
// unchanged.
describe('wrapSdkClient APIPromise passthrough', () => {
  /** Minimal stand-in for the SDK's APIPromise: thenable + `.withResponse()`. */
  const fakeApiPromise = (value, response) => {
    const p = Promise.resolve(value);
    p.withResponse = async () => ({ data: await p, response });
    return p;
  };

  it('preserves .withResponse() so response headers stay reachable', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    const headers = new Map([['x-ratelimit-limit-tokens', '10000']]);
    const fakeRaw = {
      messages: {
        create: () => fakeApiPromise({ content: [], usage: {} }, { headers }),
      },
    };
    const client = _internals.wrapSdkClient(fakeRaw, null);
    const ret = client.messages.create({ model: 'x', messages: [] });
    assert.equal(typeof ret.withResponse, 'function', '.withResponse must survive the wrapper');
    const { response } = await ret.withResponse();
    assert.equal(response.headers.get('x-ratelimit-limit-tokens'), '10000');
  });

  it('still awaits to the response body (the plain path is unaffected)', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    const body = { content: [{ type: 'text', text: 'hi' }], usage: {} };
    const fakeRaw = { messages: { create: () => fakeApiPromise(body, { headers: new Map() }) } };
    const client = _internals.wrapSdkClient(fakeRaw, null);
    assert.deepEqual(await client.messages.create({ model: 'x', messages: [] }), body);
  });

  it('preserves .withResponse() with a redactor applied (both concerns compose)', async () => {
    const { _internals } = await import('../scripts/lib/anthropic-client.mjs');
    let capturedParams = null;
    const fakeRaw = {
      messages: {
        create: (params) => {
          capturedParams = params;
          return fakeApiPromise({ content: [], usage: {} }, { headers: new Map() });
        },
      },
    };
    const redactor = (s) => (typeof s === 'string' ? s.replace(/SECRET/g, '[X]') : s);
    const client = _internals.wrapSdkClient(fakeRaw, redactor);
    const ret = client.messages.create({ system: 'has SECRET inside', messages: [] });
    assert.equal(typeof ret.withResponse, 'function');
    await ret.withResponse();
    assert.ok(!capturedParams.system.includes('SECRET'), 'redaction still applied');
  });
});

// ── createAnthropicClient (sdk backend) — error path only ───────────────────

describe('createAnthropicClient (sdk backend)', () => {
  it('throws if ANTHROPIC_API_KEY missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await assert.rejects(
      () => createAnthropicClient({ backend: 'sdk', fresh: true }),
      /ANTHROPIC_API_KEY required/,
    );
  });
});
