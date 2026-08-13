#!/usr/bin/env node
/**
 * @fileoverview `mcp:parity:gate` — the two MCP configs must stay semantically
 * equivalent, and until now nothing checked that they did.
 *
 * `.mcp.json` (root `mcpServers`, read by Claude Code) and `.vscode/mcp.json`
 * (root `servers`, read by VS Code / Copilot) differ in schema deliberately, and
 * AGENTS.md has required them mirrored since they were introduced. On 2026-08-13
 * they had drifted: `.mcp.json` passed `-y` to `@playwright/mcp` and
 * `.vscode/mcp.json` did not. On a machine without the package cached `npx`
 * prompts for install; with no interactive terminal the MCP process never starts
 * and the tools silently never appear. **Both consumer repos were shipping the
 * broken form** — `.vscode/mcp.json` is in the sync bundle, `.mcp.json` is not.
 *
 * Why only the two SOURCE files are compared, with no merge simulation: the
 * consumer write is a deep merge whose LEAF paths (scalars and arrays) our
 * source wins. `args` is an array, so a parity fix here reaches every consumer.
 * That premise is not assumed — it is asserted in `tests/mcp-parity.test.mjs`,
 * and if it ever breaks that suite fails and this gate's justification is void.
 *
 * All comparison logic lives in `lib/mcp-parity.mjs` (the single oracle, shared
 * with the tests). This file is I/O and exit codes only.
 *
 * Usage:
 *   node scripts/check-mcp-parity.mjs                    # human summary
 *   node scripts/check-mcp-parity.mjs --json             # one JSON value on stdout
 *   node scripts/check-mcp-parity.mjs --selfcheck-relocation
 *
 * Exit codes: 0 — equivalent · 1 — a failure (code on stderr) · 2 — usage error.
 *
 * Design: `docs/plans/cross-agent-delivery-parity.md` KD-3b.
 *
 * @module scripts/check-mcp-parity
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, hasFlag } from './lib/cli-io.mjs';
import { compareMcpSurfaces } from './lib/mcp-parity.mjs';

// Root is derived from THIS FILE's location, never process.cwd(): the poison-pill
// runner executes a copy of the repo in a tmpdir, and a cwd-derived root would
// read the real working tree and pass while the overlay went unexamined.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CLAUDE_CONFIG = '.mcp.json';
const VSCODE_CONFIG = '.vscode/mcp.json';

// The declared exception allowlist. The plan (KD-3) placed this inside
// `scripts/gate-contracts/mcp-parity-gate.json`, but that file's schema is
// `.strict()` and owned by the gate-honesty subsystem — it rejects any key
// outside {version, gate, guards, gates, ignoredCandidates}. Widening a
// deliberately-closed contract for one gate's convenience is worse than a
// sibling file, so exceptions live here instead. Absent file ⇒ no exceptions
// declared, which is the current state; the file becomes necessary only when a
// real asymmetry appears. `lib/mcp-parity.mjs` validates entries either way.
const EXCEPTIONS = 'scripts/gate-contracts/mcp-parity-exceptions.json';

/** Read + parse one JSON file. Returns `{ok:false}` rather than throwing. */
function readJsonFile(rel) {
  const abs = path.join(REPO_ROOT, rel);
  let raw;
  try {
    raw = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return { ok: false, reason: `${rel}: unreadable (${err.code || err.message})` };
  }
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch (err) {
    return { ok: false, reason: `${rel}: malformed JSON (${err.message})` };
  }
}

function main() {
  // Validate BEFORE the selfcheck short-circuit: handling the selfcheck first
  // makes `--selfcheck-relocation --typo` exit 0, so a typo'd flag is accepted
  // and inert — the class `cli:flags:gate` exists to catch.
  assertKnownFlags(process.argv, ['--json', '--selfcheck-relocation'], { cli: 'check-mcp-parity' });
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  // `hasFlag` prefixes the name itself; `assertKnownFlags` takes the prefixed
  // form. Passing '--json' here searched for `----json` and was silently false —
  // accepted-and-inert, the class `cli:flags:gate` exists for. Caught by running
  // it, not by reading it.
  const asJson = hasFlag('json');
  const finish = (result) => {
    if (asJson) {
      // Exactly one JSON value on stdout for EVERY outcome, success or failure,
      // so a caller can parse stdout unconditionally. Prose goes to stderr only.
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else if (result.ok) {
      console.log(`✓ mcp:parity — ${result.servers.compared} server(s) compared, no drift`
        + (result.exceptionsUsed.length ? ` (${result.exceptionsUsed.length} declared exception(s))` : ''));
    }
    if (!result.ok) {
      console.error(`${result.code}: MCP config parity check failed`);
      for (const d of result.diagnostics) console.error(`  ${d}`);
      console.error(`  AGENT FIX: reconcile ${CLAUDE_CONFIG} and ${VSCODE_CONFIG}, or declare an exception in ${EXCEPTIONS}`);
    }
    process.exit(result.ok ? 0 : 1);
  };

  const shape = (code, diagnostics, extra = {}) => ({
    ok: code === null,
    code,
    servers: { compared: 0, drifted: [] },
    exceptionsUsed: [],
    diagnostics,
    ...extra,
  });

  // Precedence: an unreadable input makes every later judgement meaningless, so
  // it outranks everything. Never a skip — a gate that goes green on an
  // unreadable input is a false pass, and a fresh worktree is where that bites.
  const claude = readJsonFile(CLAUDE_CONFIG);
  const vscode = readJsonFile(VSCODE_CONFIG);
  const unreadable = [claude, vscode].filter(r => !r.ok).map(r => r.reason);
  if (unreadable.length > 0) finish(shape('mcp/unreadable-config', unreadable));

  // ABSENT is a legitimate state meaning "no exceptions declared" — that is the
  // current reality and must not be an error. But a file that EXISTS and cannot
  // be read must never degrade to "no exceptions": that silently changes the
  // verdict, waving through the very drift the operator was trying to excuse.
  let exceptions;
  if (fs.existsSync(path.join(REPO_ROOT, EXCEPTIONS))) {
    const contract = readJsonFile(EXCEPTIONS);
    if (!contract.ok) finish(shape('mcp/unreadable-contract', [contract.reason]));
    exceptions = contract.value.exceptions;
    if (exceptions === undefined) {
      finish(shape('mcp/unreadable-contract', [`${EXCEPTIONS}: present but declares no "exceptions" array`]));
    }
  }

  const result = compareMcpSurfaces({
    claude: claude.value,
    vscode: vscode.value,
    exceptions,
  });

  finish({
    ok: result.ok,
    code: result.code,
    servers: { compared: result.compared, drifted: result.drifted },
    exceptionsUsed: result.exceptionsUsed,
    diagnostics: result.diagnostics,
  });
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) {
  try {
    main();
  } catch (err) {
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
