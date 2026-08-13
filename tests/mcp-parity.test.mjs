/**
 * @fileoverview Guards MCP cross-host config parity and the merge contract it rests on.
 *
 * Plan: `docs/plans/cross-agent-delivery-parity.md` (Cluster A).
 *
 * The defect this exists for: at `4b54f3e2` the two MCP configs had drifted —
 * `.mcp.json` passed `-y` to `@playwright/mcp`, `.vscode/mcp.json` did not — so
 * on a cold machine `npx` prompts for install, and with no interactive terminal
 * the VS Code MCP process never starts. Both consumer repos were shipping the
 * broken form. AGENTS.md required the files stay mirrored; nothing enforced it.
 *
 * The RED test reads the committed historical fixture PAIR, never the working
 * tree, so it reproduces on a clean checkout and cannot be quietly satisfied by
 * someone editing a config.
 *
 * Gate contract: `scripts/gate-contracts/mcp-parity-gate.json`, gate id
 * `mcp-parity-rejects-missing-dash-y` — whose poison pill overlays the VS Code
 * config with `-y` stripped and requires `mcp/parity-drift` on stderr.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { deepMerge } from '../scripts/lib/json-merge.mjs';
import { compareMcpSurfaces, normalizeMcpConfig, validateExceptions } from '../scripts/lib/mcp-parity.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const readJson = p => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, p), 'utf8'));

const HIST_CLAUDE = 'tests/fixtures/mcp-historical-4b54f3e2/claude.json';
const HIST_VSCODE = 'tests/fixtures/mcp-historical-4b54f3e2/vscode.json';

/** A minimal well-formed pair, for edge cases that should not trip anything else. */
const pair = (claudeServers, vscodeServers) => ({
  claude: { mcpServers: claudeServers },
  vscode: { servers: vscodeServers },
});
const stdio = (extra = {}) => ({ type: 'stdio', command: 'npx', args: ['-y', 'x'], ...extra });

describe('mcp-parity — red then green against the real historical bytes', () => {
  it('RED: flags the 4b54f3e2 pair, naming playwright args as the drift', () => {
    const r = compareMcpSurfaces({ claude: readJson(HIST_CLAUDE), vscode: readJson(HIST_VSCODE) });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'mcp/parity-drift');
    assert.deepEqual(r.drifted, ['playwright']);
    assert.ok(r.diagnostics.some(d => d.includes('playwright') && d.includes('args')));
  });

  it('GREEN (negative control): the current committed pair compares equal', () => {
    // Without this, an oracle that threw on every input would "detect" the drift
    // above by crashing rather than by comparing.
    const r = compareMcpSurfaces({ claude: readJson('.mcp.json'), vscode: readJson('.vscode/mcp.json') });
    assert.equal(r.ok, true, `expected parity, got: ${r.diagnostics.join('; ')}`);
    assert.equal(r.code, null);
  });

  it('vacuous-pass guard: compared equals the number of servers declared in both', () => {
    // `compared: 0` with `ok: true` is the false green this guards. A normaliser
    // returning an empty map would otherwise read as "no drift".
    const live = { claude: readJson('.mcp.json'), vscode: readJson('.vscode/mcp.json') };
    const expected = Object.keys(live.claude.mcpServers).length;
    const r = compareMcpSurfaces(live);
    assert.ok(expected > 0, 'fixture sanity: the live config must declare servers');
    assert.equal(r.compared, expected);
  });
});

describe('mcp-parity — KD-2 strict validation (closed-world, fails loudly)', () => {
  it('flags a server present in only one host', () => {
    const r = compareMcpSurfaces(pair({ a: stdio(), b: stdio() }, { a: stdio() }));
    assert.equal(r.code, 'mcp/parity-drift');
    assert.deepEqual(r.drifted, ['b']);
  });

  it('flags an env KEY declared in only one host', () => {
    const r = compareMcpSurfaces(pair({ a: stdio({ env: { A: '1' } }) }, { a: stdio() }));
    assert.equal(r.code, 'mcp/parity-drift');
    assert.ok(r.diagnostics.some(d => d.includes('env key "A"')));
  });

  it('flags a differing env VALUE when no exception declares it', () => {
    const r = compareMcpSurfaces(pair({ a: stdio({ env: { A: '1' } }) }, { a: stdio({ env: { A: '2' } }) }));
    assert.equal(r.code, 'mcp/parity-drift');
  });

  it('SECURITY: an env value mismatch never emits either value', () => {
    // MCP env entries routinely carry credentials. A diagnostic that diffs them
    // would place a secret in stderr, --json output and CI logs.
    const secretA = 'sk-live-AAAAAAAAAAAAAAAAAAAA';
    const secretB = 'sk-live-BBBBBBBBBBBBBBBBBBBB';
    const r = compareMcpSurfaces(pair(
      { a: stdio({ env: { TOKEN: secretA } }) },
      { a: stdio({ env: { TOKEN: secretB } }) },
    ));
    assert.equal(r.code, 'mcp/parity-drift');
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes(secretA), 'claude-side env value leaked into the result');
    assert.ok(!blob.includes(secretB), 'vscode-side env value leaked into the result');
    // A prefix of a secret is still secret material — assert no partial either.
    assert.ok(!blob.includes(secretA.slice(0, 12)), 'a truncated env value leaked');
    assert.ok(r.diagnostics.some(d => d.includes('TOKEN')), 'the variable NAME must still be reported');
  });

  it('absent env is equivalent to {} (the one tolerated schema difference)', () => {
    const r = compareMcpSurfaces(pair({ a: stdio({ env: {} }) }, { a: stdio() }));
    assert.equal(r.ok, true, r.diagnostics.join('; '));
  });

  it('rejects an unknown field rather than ignoring it', () => {
    const r = compareMcpSurfaces(pair({ a: stdio({ cwd: '/x' }) }, { a: stdio({ cwd: '/x' }) }));
    assert.equal(r.code, 'mcp/unsupported-descriptor');
    assert.ok(r.diagnostics.some(d => d.includes('cwd')));
  });

  it('rejects a remote (url) descriptor rather than silently ignoring it', () => {
    const r = compareMcpSurfaces(pair(
      { a: { type: 'http', url: 'https://example.test' } },
      { a: { type: 'http', url: 'https://example.test' } },
    ));
    assert.equal(r.code, 'mcp/unsupported-descriptor');
  });

  it('rejects a malformed known field rather than coercing it', () => {
    const r = compareMcpSurfaces(pair({ a: stdio({ args: 'not-an-array' }) }, { a: stdio() }));
    assert.equal(r.code, 'mcp/unsupported-descriptor');
  });

  it('rejects a non-object server descriptor and an unexpected root field', () => {
    assert.equal(compareMcpSurfaces(pair({ a: 'nope' }, { a: stdio() })).code, 'mcp/unsupported-descriptor');
    const extraRoot = { claude: { mcpServers: {}, stray: 1 }, vscode: { servers: {} } };
    assert.equal(compareMcpSurfaces(extraRoot).code, 'mcp/unsupported-descriptor');
  });

  it('reports a missing root key rather than reading it as "no servers"', () => {
    const { diagnostics } = normalizeMcpConfig({}, 'vscode');
    assert.ok(diagnostics.some(d => d.includes('missing root field')));
  });
});

describe('mcp-parity — KD-3 exceptions are narrow, active, and never suppress drift', () => {
  const both = () => normalizeMcpConfig({ mcpServers: { a: stdio() } }, 'claude').servers;

  it('an ACTIVE presence exception excuses a one-host server', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio(), only: stdio() }, { a: stdio() }),
      exceptions: [{ kind: 'presence', server: 'only', presentIn: 'claude', reason: 'claude-only tool' }],
    });
    assert.equal(r.ok, true, r.diagnostics.join('; '));
    assert.equal(r.exceptionsUsed.length, 1);
  });

  it('rejects a STALE presence exception naming a server present in both', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio() }, { a: stdio() }),
      exceptions: [{ kind: 'presence', server: 'a', presentIn: 'claude', reason: 'stale' }],
    });
    assert.equal(r.code, 'mcp/invalid-exception');
    assert.ok(r.diagnostics.some(d => d.includes('stale')));
  });

  it('rejects a presence exception naming the WRONG host', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio(), only: stdio() }, { a: stdio() }),
      exceptions: [{ kind: 'presence', server: 'only', presentIn: 'vscode', reason: 'wrong side' }],
    });
    assert.equal(r.code, 'mcp/invalid-exception');
  });

  it('an ACTIVE env-value exception excuses exactly one variable', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio({ env: { A: '1', B: 'same' } }) }, { a: stdio({ env: { A: '2', B: 'same' } }) }),
      exceptions: [{ kind: 'env-value', server: 'a', var: 'A', reason: 'host-specific path' }],
    });
    assert.equal(r.ok, true, r.diagnostics.join('; '));
  });

  it('an env-value exception does NOT excuse a different variable', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio({ env: { A: '1', B: '1' } }) }, { a: stdio({ env: { A: '1', B: '2' } }) }),
      exceptions: [{ kind: 'env-value', server: 'a', var: 'A', reason: 'unrelated' }],
    });
    // A is identical so its exception is stale; B's drift must not be excused either.
    assert.equal(r.code, 'mcp/invalid-exception');
  });

  it('an exception NEVER suppresses a descriptor (args) mismatch', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio({ args: ['-y', 'x'] }), only: stdio() }, { a: stdio({ args: ['x'] }) }),
      exceptions: [{ kind: 'presence', server: 'only', presentIn: 'claude', reason: 'legit' }],
    });
    assert.equal(r.code, 'mcp/parity-drift');
    assert.ok(r.drifted.includes('a'));
  });

  it('rejects an empty reason, a duplicate, and an unknown kind', () => {
    const c = both(); const v = both();
    assert.ok(validateExceptions([{ kind: 'presence', server: 'a', presentIn: 'claude', reason: '  ' }], c, v)
      .diagnostics.some(d => d.includes('reason')));
    assert.ok(validateExceptions([
      { kind: 'presence', server: 'a', presentIn: 'claude', reason: 'x' },
      { kind: 'presence', server: 'a', presentIn: 'claude', reason: 'y' },
    ], c, v).diagnostics.some(d => d.includes('duplicate')));
    assert.ok(validateExceptions([{ kind: 'nope', server: 'a', reason: 'x' }], c, v)
      .diagnostics.some(d => d.includes('kind')));
  });

  it('PRECEDENCE: an invalid exception is never masked by the drift it tried to excuse', () => {
    const r = compareMcpSurfaces({
      ...pair({ a: stdio({ args: ['-y', 'x'] }) }, { a: stdio({ args: ['x'] }) }),
      exceptions: [{ kind: 'presence', server: 'ghost', presentIn: 'claude', reason: 'names nothing' }],
    });
    assert.equal(r.code, 'mcp/invalid-exception');
    assert.ok(r.diagnostics.some(d => d.includes('args')), 'the drift must still be listed in diagnostics');
  });
});

describe('check-mcp-parity CLI — one JSON value on stdout for every outcome', () => {
  // The CLI takes NO path arguments and derives its root from its own location
  // (so the poison-pill runner cannot be pointed at a decoy). A CLI test therefore
  // cannot vary inputs by argument and must not mutate the checkout: each case
  // rewrites the configs inside a tmpdir copy and runs the COPIED script.
  let sandbox;
  const run = (argv = []) => {
    const res = execFileSync(process.execPath,
      [path.join(sandbox, 'scripts', 'check-mcp-parity.mjs'), ...argv],
      { cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe' , timeout: 60_000 });
    return { stdout: res, status: 0, stderr: '' };
  };
  /** Run tolerating a non-zero exit, capturing both streams. */
  const runAllowFail = (argv = []) => {
    try { return { ...run(argv), status: 0 }; } catch (err) {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? -1 };
    }
  };
  const write = (rel, value) => {
    const abs = path.join(sandbox, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  const parseSoleJson = out => {
    const trimmed = out.trim();
    assert.ok(trimmed.length > 0, 'expected JSON on stdout, got nothing');
    return JSON.parse(trimmed); // throws if prose leaked onto stdout alongside it
  };

  before(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-parity-cli-'));
    fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(sandbox, 'scripts'), { recursive: true });
  });
  // Retry-hardened per the repo convention: on Windows a just-exited child can
  // still hold a handle, so a bare recursive rmSync flakes with EPERM/EBUSY.
  after(() => { if (sandbox) fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); });

  it('clean → exit 0, ok:true', () => {
    write('.mcp.json', { mcpServers: { a: stdio() } });
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 0);
    assert.equal(parseSoleJson(r.stdout).ok, true);
  });

  it('drift → exit 1, code mcp/parity-drift, prose on stderr only', () => {
    write('.mcp.json', { mcpServers: { a: stdio({ args: ['-y', 'x'] }) } });
    write('.vscode/mcp.json', { servers: { a: stdio({ args: ['x'] }) } });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 1);
    assert.equal(parseSoleJson(r.stdout).code, 'mcp/parity-drift');
    assert.match(r.stderr, /mcp\/parity-drift/);
  });

  it('the FAILURE path terminates cleanly — no uncaught throw after the diagnostic', () => {
    // Regression: the AGENT FIX line interpolated a renamed constant, so the
    // failure path printed its diagnostic and THEN died with a ReferenceError.
    // Exit stayed 1 and the stderr token was already emitted, so both the drift
    // test above and the poison pill passed while the gate was crashing. A
    // substring assertion cannot see this — assert the absence of a stack.
    write('.mcp.json', { mcpServers: { a: stdio({ args: ['-y', 'x'] }) } });
    write('.vscode/mcp.json', { servers: { a: stdio({ args: ['x'] }) } });
    for (const argv of [[], ['--json']]) {
      const r = runAllowFail(argv);
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stderr, /ReferenceError|TypeError|is not defined/,
        `failure path threw instead of reporting (argv: ${JSON.stringify(argv)})`);
      assert.doesNotMatch(r.stderr, /^\s+at .+:\d+:\d+$/m, 'a stack trace reached stderr');
    }
  });

  it('a typo alongside --selfcheck-relocation is rejected, not silently accepted', () => {
    // Flag validation must precede the selfcheck short-circuit, or a typo'd
    // flag exits 0 — accepted and inert.
    const r = runAllowFail(['--selfcheck-relocation', '--typo']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag/);
  });

  it('malformed JSON → mcp/unreadable-config, never a skip', () => {
    write('.mcp.json', '{ not json');
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 1);
    assert.equal(parseSoleJson(r.stdout).code, 'mcp/unreadable-config');
  });

  it('missing input → mcp/unreadable-config', () => {
    fs.rmSync(path.join(sandbox, '.mcp.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 1);
    assert.equal(parseSoleJson(r.stdout).code, 'mcp/unreadable-config');
  });

  it('unsupported descriptor → mcp/unsupported-descriptor', () => {
    write('.mcp.json', { mcpServers: { a: stdio({ cwd: '/x' }) } });
    write('.vscode/mcp.json', { servers: { a: stdio({ cwd: '/x' }) } });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 1);
    assert.equal(parseSoleJson(r.stdout).code, 'mcp/unsupported-descriptor');
  });

  it('unreadable contract → mcp/unreadable-contract, NOT a silent "no exceptions"', () => {
    write('.mcp.json', { mcpServers: { a: stdio() } });
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    const contract = path.join(sandbox, 'scripts', 'gate-contracts', 'mcp-parity-exceptions.json');
    try {
      fs.writeFileSync(contract, '{ broken');
      const r = runAllowFail(['--json']);
      assert.equal(r.status, 1);
      assert.equal(parseSoleJson(r.stdout).code, 'mcp/unreadable-contract');
    } finally { fs.rmSync(contract, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('invalid exception outranks the drift it tried to excuse', () => {
    write('.mcp.json', { mcpServers: { a: stdio({ args: ['-y', 'x'] }) } });
    write('.vscode/mcp.json', { servers: { a: stdio({ args: ['x'] }) } });
    const contract = path.join(sandbox, 'scripts', 'gate-contracts', 'mcp-parity-exceptions.json');
    try {
      fs.writeFileSync(contract, JSON.stringify({
        exceptions: [{ kind: 'presence', server: 'ghost', presentIn: 'claude', reason: 'names nothing' }],
      }, null, 2));
      const r = runAllowFail(['--json']);
      assert.equal(parseSoleJson(r.stdout).code, 'mcp/invalid-exception');
    } finally { fs.rmSync(contract, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('an ABSENT exceptions file means "none declared", not an error', () => {
    // Absent is the current, legitimate state. Only a file that EXISTS and
    // cannot be read may fail — degrading that to "no exceptions" would waive
    // the very drift the operator was trying to excuse.
    write('.mcp.json', { mcpServers: { a: stdio() } });
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    fs.rmSync(path.join(sandbox, 'scripts', 'gate-contracts', 'mcp-parity-exceptions.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    const r = runAllowFail(['--json']);
    assert.equal(r.status, 0);
    assert.deepEqual(parseSoleJson(r.stdout).exceptionsUsed, []);
  });

  it('an exceptions file present but declaring no array is an error, not empty', () => {
    write('.mcp.json', { mcpServers: { a: stdio() } });
    write('.vscode/mcp.json', { servers: { a: stdio() } });
    const contract = path.join(sandbox, 'scripts', 'gate-contracts', 'mcp-parity-exceptions.json');
    try {
      fs.writeFileSync(contract, JSON.stringify({ note: 'oops, wrong key' }, null, 2));
      const r = runAllowFail(['--json']);
      assert.equal(r.status, 1);
      assert.equal(parseSoleJson(r.stdout).code, 'mcp/unreadable-contract');
    } finally { fs.rmSync(contract, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); }
  });

  it('--selfcheck-relocation prints OK and reads no config', () => {
    fs.rmSync(path.join(sandbox, '.mcp.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    fs.rmSync(path.join(sandbox, '.vscode', 'mcp.json'), { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    assert.match(runAllowFail(['--selfcheck-relocation']).stdout, /^OK/);
  });
});

describe('poison pill must not decay as the live config evolves', () => {
  it('the pill overlay differs from the live .vscode/mcp.json ONLY by -y', () => {
    // A frozen overlay would eventually fail for the WRONG reason — a server
    // added later would be missing from it, still satisfying expectExit/
    // expectStderr while no longer proving that stripping `-y` is what fires.
    const live = readJson('.vscode/mcp.json');
    const pill = readJson('tests/fixtures/poison/mcp-vscode-missing-dash-y.json');
    const repaired = JSON.parse(JSON.stringify(pill));
    repaired.servers.playwright.args = ['-y', ...repaired.servers.playwright.args];
    assert.deepEqual(repaired, live,
      'the poison overlay has drifted from the live config beyond the removed -y — regenerate it');
  });

  it('the immutable 4b54f3e2 pair is kept separately and still reproduces the defect', () => {
    const vscode = readJson(HIST_VSCODE);
    assert.ok(!vscode.servers.playwright.args.includes('-y'),
      'the historical fixture must retain the defect; it is a record, not a config');
  });
});

describe('deepMerge — KD-1 leaf-path authority (the gate\'s load-bearing premise)', () => {
  // If this suite fails, the gate's justification for comparing only the two
  // SOURCE files is void — see cross-agent-delivery-parity.md KD-1.
  const ours = { servers: { p: { type: 'stdio', command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } } } };

  it('a source LEAF (scalar or array) is authoritative at its path', () => {
    const consumer = { servers: { p: { command: 'OLD', args: ['stale'] } } };
    const m = deepMerge(consumer, ours);
    assert.deepEqual(m.servers.p.args, ['-y', 'pkg'], 'arrays replace wholesale, never concatenate');
    assert.equal(m.servers.p.command, 'npx');
  });

  it('consumer-only servers survive untouched', () => {
    const consumer = { servers: { theirs: { command: 'foo' } } };
    assert.deepEqual(deepMerge(consumer, ours).servers.theirs, { command: 'foo' });
  });

  it('consumer-only paths at ANY depth survive', () => {
    const consumer = { servers: { p: { cwd: '/theirs', env: { B: '2' } } } };
    const m = deepMerge(consumer, ours);
    assert.equal(m.servers.p.cwd, '/theirs');
    assert.equal(m.servers.p.env.B, '2');
  });

  it('EXPLICITLY FALSE: a declared OBJECT-valued key is not authoritative — it unions', () => {
    // Pinned deliberately. Draft 1 of the plan claimed descriptor identity and
    // draft 2 claimed top-level key authority; both were falsified by running
    // this function. Asserting the false direction stops the distinction rotting
    // back into the weaker, wrong claim.
    const consumer = { servers: { p: { env: { B: '2' } } } };
    const m = deepMerge(consumer, ours);
    assert.deepEqual(m.servers.p.env, { B: '2', A: '1' });
    assert.notDeepEqual(m.servers.p.env, ours.servers.p.env);
  });

  it('an empty source object merges as a no-op, not a clear', () => {
    const consumer = { servers: { p: { env: { B: '2' } } } };
    assert.deepEqual(deepMerge(consumer, { servers: { p: { env: {} } } }).servers.p.env, { B: '2' });
  });

  it('neither input is mutated', () => {
    const consumer = { servers: { p: { command: 'OLD' } } };
    const before = JSON.stringify(consumer);
    deepMerge(consumer, ours);
    assert.equal(JSON.stringify(consumer), before);
  });
});

describe('deepMerge — production wiring (the seam Phase 0 created)', () => {
  it('sync-to-repos.mjs imports deepMerge and declares no local copy', () => {
    // Secondary DRY guard, in the shape of anthropic-client-migration.test.mjs.
    // The behavioural proof is the integration test below — this only catches a
    // future refactor reintroducing a second spelling of the merge rule.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'), 'utf8');
    assert.match(src, /import\s*\{[^}]*\bdeepMerge\b[^}]*\}\s*from\s*'\.\/lib\/json-merge\.mjs'/);
    assert.doesNotMatch(src, /^\s*function\s+deepMerge\s*\(/m, 'a local deepMerge copy was reintroduced');
  });

  it('INTEGRATION: the real sync write path preserves consumer keys and overwrites leaves', () => {
    // Observes the PRODUCTION merge, not the library in isolation. The Gemini
    // gate corrected an earlier draft that claimed this was unobservable:
    // `sync-to-repos.mjs --target-path` runs the actual co-owned-JSON write.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-parity-sync-'));
    try {
      fs.mkdirSync(path.join(tmp, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.vscode', 'mcp.json'), JSON.stringify({
        servers: {
          playwright: { command: 'STALE', args: ['STALE'], env: { CONSUMER_FLAG: '1' } },
          consumerOwn: { command: 'their-tool' },
        },
      }, null, 2));

      execFileSync(process.execPath, [
        path.join(REPO_ROOT, 'scripts', 'sync-to-repos.mjs'),
        '--target-path', tmp, '--no-prompt', '--adopt-orphans',
      ], { cwd: REPO_ROOT, encoding: 'utf8', stdio: 'pipe', timeout: 240_000 });

      const merged = JSON.parse(fs.readFileSync(path.join(tmp, '.vscode', 'mcp.json'), 'utf8'));
      const ours = readJson('.vscode/mcp.json');

      // Leaves we declare win — this is why fixing `-y` at source reaches consumers.
      assert.deepEqual(merged.servers.playwright.args, ours.servers.playwright.args);
      assert.equal(merged.servers.playwright.command, ours.servers.playwright.command);
      // Consumer-only nested field and consumer-only server both survive.
      assert.equal(merged.servers.playwright.env.CONSUMER_FLAG, '1');
      assert.deepEqual(merged.servers.consumerOwn, { command: 'their-tool' });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});

describe('mcp-parity — the vacuous-pass guard is ENFORCED, not merely reported', () => {
  // The plan named `compared: 0 is a failure, not a clean pass` as a requirement.
  // The first implementation surfaced `compared` in the output and left enforcement
  // to a test that only ever ran against the live config, where it is non-zero —
  // so two empty configs compared "equal" and exited 0 having verified nothing.
  // Caught by the consolidated gate.
  it('two empty configs FAIL with mcp/nothing-compared, not ok:true', () => {
    const r = compareMcpSurfaces({ claude: { mcpServers: {} }, vscode: { servers: {} } });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'mcp/nothing-compared');
    assert.equal(r.compared, 0);
    assert.ok(r.diagnostics.some(d => /verified nothing/.test(d)));
  });

  it('a real drift still outranks it — the guard does not mask a finding', () => {
    const r = compareMcpSurfaces({
      claude: { mcpServers: { a: { command: 'npx' } } },
      vscode: { servers: {} },
    });
    assert.equal(r.code, 'mcp/parity-drift');
  });
});

describe('mcp-parity CLI — a non-object exceptions file is reported, not a crash', () => {
  it('JSON `null` is valid JSON but not a contract', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-parity-null-'));
    try {
      fs.cpSync(path.join(REPO_ROOT, 'scripts'), path.join(tmp, 'scripts'), { recursive: true });
      fs.mkdirSync(path.join(tmp, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(tmp, '.mcp.json'), JSON.stringify({ mcpServers: { a: { command: 'npx' } } }));
      fs.writeFileSync(path.join(tmp, '.vscode', 'mcp.json'), JSON.stringify({ servers: { a: { command: 'npx' } } }));
      fs.writeFileSync(path.join(tmp, 'scripts', 'gate-contracts', 'mcp-parity-exceptions.json'), 'null');
      let out = '', err = '', status = 0;
      try {
        out = execFileSync(process.execPath, [path.join(tmp, 'scripts', 'check-mcp-parity.mjs'), '--json'],
          { cwd: os.tmpdir(), encoding: 'utf8', stdio: 'pipe', timeout: 60_000 });
      } catch (e) { out = e.stdout ?? ''; err = e.stderr ?? ''; status = e.status ?? -1; }
      assert.equal(status, 1);
      assert.equal(JSON.parse(out.trim()).code, 'mcp/unreadable-contract');
      assert.doesNotMatch(err, /TypeError|Cannot read properties/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    }
  });
});
