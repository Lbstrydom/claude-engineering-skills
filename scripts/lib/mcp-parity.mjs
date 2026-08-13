/**
 * @fileoverview The single oracle for MCP cross-host config parity.
 *
 * This repo ships two MCP configuration files with deliberately different
 * schemas, one per agent host:
 *
 *   `.mcp.json`        root key `mcpServers`  — read by Claude Code
 *   `.vscode/mcp.json` root key `servers`     — read by VS Code / Copilot
 *
 * AGENTS.md has required them to stay mirrored since they were introduced.
 * Nothing enforced it, and on 2026-08-13 they had drifted: `.mcp.json` passed
 * `-y` to `@playwright/mcp` and `.vscode/mcp.json` did not, so on a machine
 * without the package cached `npx` prompts for install — with no interactive
 * terminal the MCP process never starts and the tools silently never appear.
 * Both consumer repos were carrying the broken form.
 *
 * **This module VALIDATES; it does not project.** An earlier design compared a
 * projection onto `{type, command, args, envKeys}`. That is unsafe: any field
 * outside the projection — `url`, `headers`, `cwd`, a future transport option —
 * would be dropped *before* comparison, so the two files could differ in a
 * launch-critical value while this reported equality. The whole point of the
 * gate is to protect servers that do not exist yet, so the contract is
 * closed-world and fails loudly on anything it does not recognise.
 *
 * **Secrets never reach a diagnostic.** `env` values ARE compared (they select
 * endpoints, auth modes and feature flags), but MCP env entries routinely carry
 * credentials, so a mismatch reports the server and the VARIABLE NAME only —
 * never a value, and never a truncated prefix, which is still secret material.
 * Same discipline as `formatSkipLog` in `sensitive-paths.mjs`.
 *
 * Pure: no fs, no process, no env. The CLI wrapper (`check-mcp-parity.mjs`)
 * owns all I/O so these functions can be tested directly on parsed objects.
 *
 * Design: `docs/plans/cross-agent-delivery-parity.md` KD-2 / KD-3.
 *
 * @module scripts/lib/mcp-parity
 */

/** The two hosts, as used in exception declarations and diagnostics. */
export const HOSTS = Object.freeze(['claude', 'vscode']);

/** Root key per host. `mcpServers` ≡ `servers` is the one tolerated schema difference. */
const ROOT_KEY = Object.freeze({ claude: 'mcpServers', vscode: 'servers' });

/** Fields a `stdio` descriptor may carry. Anything else is unknown ⇒ hard failure. */
const STDIO_FIELDS = Object.freeze(['type', 'command', 'args', 'env']);

/** Result codes, highest precedence first. Order is the precedence order. */
export const CODES = Object.freeze([
  'mcp/unreadable-config',
  'mcp/unreadable-contract',
  'mcp/invalid-exception',
  'mcp/unsupported-descriptor',
  'mcp/parity-drift',
  'mcp/nothing-compared',
]);

/**
 * Normalise one host's parsed config into a canonical server map, validating
 * strictly on the way. Never coerces and never skips: a violation is returned
 * as a diagnostic, not repaired.
 *
 * @param {unknown} parsed — the parsed JSON of one config file
 * @param {'claude'|'vscode'} host
 * @returns {{servers: Map<string, object>, diagnostics: string[]}}
 */
export function normalizeMcpConfig(parsed, host) {
  const diagnostics = [];
  const servers = new Map();
  const rootKey = ROOT_KEY[host];
  if (!rootKey) {
    diagnostics.push(`unknown host "${host}"`);
    return { servers, diagnostics };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    diagnostics.push(`${host}: config root must be an object`);
    return { servers, diagnostics };
  }

  // No root-level fields other than the server map (KD-2 rule 2).
  for (const key of Object.keys(parsed)) {
    if (key !== rootKey) {
      diagnostics.push(`${host}: unexpected root field "${key}" (only "${rootKey}" is permitted)`);
    }
  }

  const map = parsed[rootKey];
  if (map === undefined) {
    diagnostics.push(`${host}: missing root field "${rootKey}"`);
    return { servers, diagnostics };
  }
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    diagnostics.push(`${host}: "${rootKey}" must be an object`);
    return { servers, diagnostics };
  }

  for (const [name, raw] of Object.entries(map)) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      diagnostics.push(`${host}: server "${name}" must be a plain object`);
      continue;
    }
    const desc = /** @type {Record<string, unknown>} */ (raw);

    // Unknown field, or a remote/unsupported descriptor variant, is a hard error —
    // never a silent pass. Adding a variant is then a deliberate act with its own
    // declared parity semantics (KD-2 rule 4).
    for (const field of Object.keys(desc)) {
      if (!STDIO_FIELDS.includes(field)) {
        diagnostics.push(`${host}: server "${name}" has unsupported field "${field}" (only stdio descriptors are supported)`);
      }
    }

    if (desc.type !== undefined && desc.type !== 'stdio') {
      diagnostics.push(`${host}: server "${name}" has type "${String(desc.type)}"; only "stdio" is supported`);
    }
    if (typeof desc.command !== 'string' || desc.command.length === 0) {
      diagnostics.push(`${host}: server "${name}" requires a non-empty string "command"`);
    }

    let args = [];
    if (desc.args !== undefined) {
      if (!Array.isArray(desc.args) || desc.args.some(a => typeof a !== 'string' || a.length === 0)) {
        diagnostics.push(`${host}: server "${name}" "args" must be an array of non-empty strings`);
      } else {
        args = desc.args;
      }
    }

    let env = {};
    if (desc.env !== undefined) {
      if (desc.env === null || typeof desc.env !== 'object' || Array.isArray(desc.env)) {
        diagnostics.push(`${host}: server "${name}" "env" must be an object`);
      } else if (Object.values(desc.env).some(v => typeof v !== 'string')) {
        diagnostics.push(`${host}: server "${name}" "env" values must be strings`);
      } else {
        env = desc.env;
      }
    }

    // Absent `type` ⇒ stdio; absent `args` ⇒ []; absent `env` ⇒ {}.
    servers.set(name, { type: 'stdio', command: desc.command, args, env });
  }

  return { servers, diagnostics };
}

/**
 * Validate the declared exception allowlist against what the two configs
 * actually look like. Every exception must be ACTIVE — one that does not
 * correspond to a real, current asymmetry silently pre-authorises a FUTURE
 * divergence at that coordinate, so a dormant entry is rejected rather than
 * tolerated. This makes the allowlist self-pruning.
 *
 * @returns {{valid: object[], diagnostics: string[]}}
 */
export function validateExceptions(exceptions, claudeServers, vscodeServers) {
  const diagnostics = [];
  const valid = [];
  const seen = new Set();

  if (exceptions === undefined) return { valid, diagnostics };
  if (!Array.isArray(exceptions)) {
    diagnostics.push('contract "exceptions" must be an array');
    return { valid, diagnostics };
  }

  for (const [i, ex] of exceptions.entries()) {
    const at = `exception[${i}]`;
    if (ex === null || typeof ex !== 'object' || Array.isArray(ex)) {
      diagnostics.push(`${at}: must be an object`);
      continue;
    }
    for (const key of Object.keys(ex)) {
      if (!['kind', 'server', 'presentIn', 'var', 'reason'].includes(key)) {
        diagnostics.push(`${at}: unknown field "${key}"`);
      }
    }
    if (typeof ex.reason !== 'string' || ex.reason.trim() === '') {
      diagnostics.push(`${at}: "reason" must be a non-empty string`);
      continue;
    }
    if (typeof ex.server !== 'string' || ex.server === '') {
      diagnostics.push(`${at}: "server" must be a non-empty string`);
      continue;
    }

    const inClaude = claudeServers.has(ex.server);
    const inVscode = vscodeServers.has(ex.server);

    if (ex.kind === 'presence') {
      // A single host string, not an array: a presence asymmetry has exactly one
      // present side, and an array invites ["claude","vscode"] — not an asymmetry.
      if (!HOSTS.includes(ex.presentIn)) {
        diagnostics.push(`${at}: "presentIn" must be one of ${HOSTS.join('|')}`);
        continue;
      }
      const key = `presence:${ex.server}`;
      if (seen.has(key)) { diagnostics.push(`${at}: duplicate presence exception for "${ex.server}"`); continue; }
      seen.add(key);

      const actuallyPresentIn = inClaude && !inVscode ? 'claude' : (!inClaude && inVscode ? 'vscode' : null);
      if (actuallyPresentIn === null) {
        diagnostics.push(`${at}: stale — "${ex.server}" is ${inClaude ? 'present in both' : 'absent from both'}; a presence exception needs a real asymmetry`);
        continue;
      }
      if (actuallyPresentIn !== ex.presentIn) {
        diagnostics.push(`${at}: declares presentIn "${ex.presentIn}" but "${ex.server}" is present in "${actuallyPresentIn}"`);
        continue;
      }
      valid.push(ex);
      continue;
    }

    if (ex.kind === 'env-value') {
      if (typeof ex.var !== 'string' || ex.var === '') {
        diagnostics.push(`${at}: "var" must be a non-empty string`);
        continue;
      }
      const key = `env-value:${ex.server}:${ex.var}`;
      if (seen.has(key)) { diagnostics.push(`${at}: duplicate env-value exception for "${ex.server}"/"${ex.var}"`); continue; }
      seen.add(key);

      if (!inClaude || !inVscode) {
        diagnostics.push(`${at}: stale — env-value exception requires "${ex.server}" in BOTH configs`);
        continue;
      }
      const cEnv = claudeServers.get(ex.server).env;
      const vEnv = vscodeServers.get(ex.server).env;
      if (!(ex.var in cEnv) || !(ex.var in vEnv)) {
        diagnostics.push(`${at}: stale — "${ex.var}" is not declared on "${ex.server}" in both configs`);
        continue;
      }
      if (cEnv[ex.var] === vEnv[ex.var]) {
        diagnostics.push(`${at}: stale — "${ex.var}" on "${ex.server}" has the same value in both configs; nothing to excuse`);
        continue;
      }
      valid.push(ex);
      continue;
    }

    diagnostics.push(`${at}: "kind" must be "presence" or "env-value"`);
  }

  return { valid, diagnostics };
}

/**
 * Composite key for an env-value exception. Encoded rather than string-joined:
 * a separator character has to be one that cannot occur in a server or variable
 * name, and the obvious choice (NUL) makes this source file BINARY to git, which
 * this repo gates against. JSON encoding sidesteps the separator problem
 * entirely — there is nothing to collide.
 */
function envKeyOf(server, varName) {
  return JSON.stringify([server, varName]);
}

/**
 * Compare two hosts' configs for semantic equivalence.
 *
 * `compared` is the vacuous-pass guard: a run reporting `compared: 0` has
 * examined nothing and is a failure, not a clean pass.
 *
 * @returns {{ok: boolean, code: string|null, compared: number, drifted: string[],
 *            exceptionsUsed: object[], diagnostics: string[]}}
 */
export function compareMcpSurfaces({ claude, vscode, exceptions } = {}) {
  const c = normalizeMcpConfig(claude, 'claude');
  const v = normalizeMcpConfig(vscode, 'vscode');
  const descriptorDiagnostics = [...c.diagnostics, ...v.diagnostics];

  const ex = validateExceptions(exceptions, c.servers, v.servers);

  const diagnostics = [];
  const drifted = [];
  const names = [...new Set([...c.servers.keys(), ...v.servers.keys()])].sort();
  let compared = 0;

  const presenceExcused = new Set(ex.valid.filter(e => e.kind === 'presence').map(e => e.server));
  const envExcused = new Set(ex.valid.filter(e => e.kind === 'env-value').map(e => envKeyOf(e.server, e.var)));

  for (const name of names) {
    const inC = c.servers.has(name);
    const inV = v.servers.has(name);

    if (!inC || !inV) {
      if (presenceExcused.has(name)) continue;
      drifted.push(name);
      diagnostics.push(`server "${name}" is present only in ${inC ? 'claude (.mcp.json)' : 'vscode (.vscode/mcp.json)'}`);
      continue;
    }

    compared += 1;
    const cs = c.servers.get(name);
    const vs = v.servers.get(name);
    let differs = false;

    if (cs.command !== vs.command) {
      differs = true;
      diagnostics.push(`server "${name}" command differs: claude "${cs.command}" vs vscode "${vs.command}"`);
    }
    if (JSON.stringify(cs.args) !== JSON.stringify(vs.args)) {
      differs = true;
      diagnostics.push(`server "${name}" args differ: claude ${JSON.stringify(cs.args)} vs vscode ${JSON.stringify(vs.args)}`);
    }

    const envKeys = [...new Set([...Object.keys(cs.env), ...Object.keys(vs.env)])].sort();
    for (const k of envKeys) {
      const inCEnv = k in cs.env;
      const inVEnv = k in vs.env;
      if (!inCEnv || !inVEnv) {
        differs = true;
        diagnostics.push(`server "${name}" env key "${k}" is declared only in ${inCEnv ? 'claude' : 'vscode'}`);
        continue;
      }
      if (cs.env[k] !== vs.env[k]) {
        if (envExcused.has(envKeyOf(name, k))) continue;
        differs = true;
        // Value deliberately omitted — env values routinely carry credentials.
        diagnostics.push(`server "${name}" env value differs for "${k}"`);
      }
    }

    if (differs) drifted.push(name);
  }

  // VACUOUS-PASS GUARD, enforced and not merely reported. Two configs that both
  // declare zero servers compare "equal" and would otherwise exit 0 having
  // examined nothing — a gate reporting success for a run that checked nothing is
  // the exact false green this module exists to refuse. An earlier version
  // surfaced `compared` in the output and left the enforcement to a test, which
  // only ever exercised the live config where it is non-zero.
  if (compared === 0 && drifted.length === 0) {
    diagnostics.push('no servers were compared — both configs declare none, so this run verified nothing');
  }

  // Precedence: an unreadable/invalid input makes every later judgement
  // meaningless, and an invalid exception must never be masked by the drift it
  // was (wrongly) trying to excuse.
  let code = null;
  if (ex.diagnostics.length > 0) code = 'mcp/invalid-exception';
  else if (descriptorDiagnostics.length > 0) code = 'mcp/unsupported-descriptor';
  else if (drifted.length > 0) code = 'mcp/parity-drift';
  else if (compared === 0) code = 'mcp/nothing-compared';

  return {
    ok: code === null,
    code,
    compared,
    drifted,
    exceptionsUsed: ex.valid,
    diagnostics: [...descriptorDiagnostics, ...ex.diagnostics, ...diagnostics],
  };
}
