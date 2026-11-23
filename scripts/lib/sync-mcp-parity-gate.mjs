/**
 * @fileoverview Gate 10 of `sync-isolation-verify` — consumer-side MCP parity, after the write, over the MANAGED servers
 * only (Cluster C of docs/plans/vscode-compatibility.md). A server of the consumer's own is never judged; a managed
 * server must be in both `.mcp.json` and `.vscode/mcp.json` and equal.
 *
 * Results: `pass`, `declared` (either file claimed in `.sync-overrides.json`: no compare) and `not-applicable` (no
 * `.mcp.json` in the manifest) are green. `fail` (MCP_PARITY_MISMATCH) and `unmeasured` (MCP_PARITY_UNMEASURED: the manifest
 * lists `.mcp.json` but carries no `mcpManagedServers`, or the pair cannot be read) are red: a gate that cannot say which
 * servers are ours must not read as "no drift". Its own module so the file-size ratchet on `sync-isolation-verify.mjs`
 * is not raised for it.
 *
 * @module scripts/lib/sync-mcp-parity-gate
 */
import fs from 'node:fs';
import path from 'node:path';
import { compareMcpSurfaces } from './mcp-parity.mjs';
import { loadOverrides, matchOverride, OVERRIDES_PATH } from './sync-overrides.mjs';

/**
 * Gate 10 — consumer-side MCP parity, after the write, over the MANAGED servers only.
 * `pass` and `declared` and `not-applicable` are green; `fail` and `unmeasured` are red (never a skip: a gate that
 * cannot say which servers are ours must not read as "no drift").
 *
 * @param {string} consumerRoot
 * @param {{files?: Record<string, unknown>, mcpManagedServers?: string[]}|null} manifest
 */
export function gate10(consumerRoot, manifest) {
  const CLAUDE = '.mcp.json';
  const VSCODE = '.vscode/mcp.json';
  const files = manifest?.files ?? {};
  if (!(CLAUDE in files)) {
    return { gate: '10', pass: true, result: 'not-applicable', details: { note: `${CLAUDE} is not in the manifest` } };
  }
  const managed = manifest?.mcpManagedServers;
  if (!Array.isArray(managed) || managed.length === 0) {
    return {
      gate: '10', pass: false, result: 'unmeasured', code: 'MCP_PARITY_UNMEASURED',
      error: `MCP_PARITY_UNMEASURED: the manifest lists ${CLAUDE} but carries no mcpManagedServers, so which servers are managed is unknown. `
        + 'Re-sync from the current engineering-skills source: npx github:Lbstrydom/claude-engineering-skills <this-repo>',
    };
  }
  // Declared per FILE: either claimed in the consumer's own `.sync-overrides.json` means the divergence is theirs to keep.
  const { overrides } = loadOverrides(consumerRoot);
  const declaredPaths = [CLAUDE, VSCODE].filter((p) => matchOverride(p, overrides));
  if (declaredPaths.length > 0) {
    return { gate: '10', pass: true, result: 'declared', details: { declared: declaredPaths, managed } };
  }
  const read = (rel) => {
    try { return { ok: true, value: JSON.parse(fs.readFileSync(path.join(consumerRoot, ...rel.split('/')), 'utf-8')) }; }
    catch (err) { return { ok: false, reason: `${rel}: ${err.code === 'ENOENT' ? 'missing' : `unreadable or malformed (${err.message})`}` }; }
  };
  const claude = read(CLAUDE);
  const vscode = read(VSCODE);
  const bad = [claude, vscode].filter((r) => !r.ok).map((r) => r.reason);
  if (bad.length > 0) {
    return { gate: '10', pass: false, result: 'unmeasured', code: 'MCP_PARITY_UNMEASURED', error: `MCP_PARITY_UNMEASURED: cannot read the pair — ${bad.join('; ')}` };
  }
  const r = compareMcpSurfaces({ claude: claude.value, vscode: vscode.value, managedNames: managed });
  if (!r.ok) {
    return {
      gate: '10', pass: false, result: 'fail', code: 'MCP_PARITY_MISMATCH',
      error: `MCP_PARITY_MISMATCH: ${r.diagnostics.join('; ')} — re-sync, or declare the divergence in ${OVERRIDES_PATH}`,
      details: { drifted: r.drifted, managed },
    };
  }
  return { gate: '10', pass: true, result: 'pass', details: { compared: r.compared, managed } };
}
