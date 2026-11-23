/**
 * @fileoverview Root `.mcp.json` is OPT-IN per consumer, and never launches a server by a network fetch.
 *
 * Cluster C (#484) shipped `npx -y <pkg>@<ver>` servers to every consumer. A consumer whose supply-chain guard requires
 * `node` from an installed, exactly-pinned package (storyline) cannot accept that, and a consumer that never admitted
 * `mcp-mermaid` should not receive it. So (2026-11-23, Louis):
 *
 *  - the consumer opts in by declaring `{"syncOptIn": [{"feature": "root-mcp-json", "reason": "…"}]}` in its own
 *    `.sync-overrides.json` (the file that already carries the consumer's per-target choices; no new mechanism). A consumer
 *    that has not opted in is shipped no root `.mcp.json`, so gate 10 reads `not-applicable`, never a pass;
 *  - an opted-in consumer gets a server ONLY where its `package.json` declares the server's package at an EXACT version and
 *    that exact version is installed: the launcher becomes `node node_modules/<pkg>/<bin>` with the bin read from the
 *    installed package's own `bin` field. A package the consumer does not pin is left out (one note), never fetched, and
 *    never emitted at a version other than the consumer's own.
 *
 * Both `.mcp.json` and `.vscode/mcp.json` are rendered through here for an opted-in consumer so the managed servers stay
 * identical (gate 10 compares them). PURE except `planRootMcp`'s reads of the consumer's `package.json` / `node_modules`.
 *
 * @module scripts/lib/sync-mcp-optin
 */
import fs from 'node:fs';
import path from 'node:path';
import { classifyLaunchSpec } from './sync-pin-guard.mjs';

/** The `syncOptIn` feature name that turns the root `.mcp.json` delivery on. */
export const ROOT_MCP_FEATURE = 'root-mcp-json';

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const DEP_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies'];

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/** `["-y", "@scope/pkg@1.2.3", "--flag"]` → `{pkg, rest}`; null when the launcher is not a pinned npx fetch of one package. */
export function parseNpxLaunch(spec) {
  const base = String(spec?.command ?? '').replaceAll('\\', '/').split('/').pop().replace(/\.cmd$/i, '');
  if (base !== 'npx' || !Array.isArray(spec.args)) return null;
  const args = spec.args.filter((a) => typeof a === 'string');
  let i = 0;
  while (i < args.length && (args[i] === '-y' || args[i] === '--yes')) i++;
  const token = args[i];
  const at = typeof token === 'string' ? token.lastIndexOf('@') : -1;
  if (at <= 0) return null;
  return { pkg: token.slice(0, at), rest: args.slice(i + 1) };
}

/** Is exactly `pkg@version` recorded in a lockfile of the consumer? `{ok:true}` or `{ok:false, reason}`. */
function lockfileRecords(consumerRoot, pkg, version) {
  const npmLock = ['package-lock.json', 'npm-shrinkwrap.json'].map((f) => readJson(path.join(consumerRoot, f))).find(Boolean);
  if (npmLock) {
    const v = npmLock.packages?.[`node_modules/${pkg}`]?.version ?? npmLock.dependencies?.[pkg]?.version;
    return v === version ? { ok: true } : { ok: false, reason: `package-lock.json does not record ${pkg}@${version}` };
  }
  for (const f of ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock']) {
    let text;
    try { text = fs.readFileSync(path.join(consumerRoot, f), 'utf-8'); } catch { continue; }
    return text.includes(`${pkg}@${version}`) || text.includes(`${pkg}/${version}`) ? { ok: true } : { ok: false, reason: `${f} does not record ${pkg}@${version}` };
  }
  return { ok: false, reason: 'no lockfile records it' };
}

/** The launcher path of an installed package from its own `bin` field, or a reason string. */
function binPathOf(pkg, installed) {
  const unscoped = pkg.split('/').pop();
  const bin = installed.bin;
  let rel = null;
  if (typeof bin === 'string') rel = bin;
  else if (bin && typeof bin === 'object') {
    const keys = Object.keys(bin);
    const key = keys.includes(unscoped) ? unscoped : (keys.length === 1 ? keys[0] : null);
    rel = key ? bin[key] : null;
  }
  if (typeof rel !== 'string' || !rel) return { reason: 'its package.json has no unambiguous "bin"' };
  const norm = path.posix.normalize(rel.replaceAll('\\', '/'));
  if (norm.startsWith('..') || path.posix.isAbsolute(norm)) return { reason: 'its "bin" escapes the package' };
  return { path: `node_modules/${pkg}/${norm.replace(/^\.\//, '')}` };
}

/**
 * Render one MCP config (`mcpServers` or `servers` root) for a consumer. A server whose launcher is an npx fetch becomes
 * `node <installed bin>` at the consumer's exact pin, or is left out with a note.
 *
 * @param {{sourceText: string, consumerRoot: string}} a
 * @returns {{text: string|null, names: string[], notes: string[]}} `text` null when no server survives
 */
export function renderConsumerMcp({ sourceText, consumerRoot }) {
  const doc = JSON.parse(sourceText);
  const rootKey = doc.mcpServers ? 'mcpServers' : 'servers';
  const pkgJson = readJson(path.join(consumerRoot, 'package.json'));
  const out = {};
  const notes = [];
  for (const [name, spec] of Object.entries(doc[rootKey] ?? {})) {
    const launch = parseNpxLaunch(spec);
    if (!launch) { out[name] = spec; continue; }   // already a local launcher: not ours to rewrite
    const pin = DEP_FIELDS.map((f) => pkgJson?.[f]?.[launch.pkg]).find((v) => typeof v === 'string');
    if (pin === undefined) { notes.push(`${name} left out: ${launch.pkg} is not declared in package.json`); continue; }
    if (!EXACT_VERSION.test(pin)) { notes.push(`${name} left out: ${launch.pkg} is declared as "${pin}", not an exact version`); continue; }
    const installed = readJson(path.join(consumerRoot, 'node_modules', ...launch.pkg.split('/'), 'package.json'));
    if (installed?.version !== pin) { notes.push(`${name} left out: ${launch.pkg}@${pin} is not installed (run the package install first)`); continue; }
    const lock = lockfileRecords(consumerRoot, launch.pkg, pin);
    if (!lock.ok) { notes.push(`${name} left out: ${launch.pkg}@${pin} is not locked (${lock.reason})`); continue; }
    const bin = binPathOf(launch.pkg, installed);
    if (!bin.path) { notes.push(`${name} left out: ${launch.pkg} ${bin.reason}`); continue; }
    if (!fs.existsSync(path.join(consumerRoot, ...bin.path.split('/')))) { notes.push(`${name} left out: ${bin.path} does not exist`); continue; }
    out[name] = { ...spec, command: 'node', args: [bin.path, ...launch.rest] };
  }
  const names = Object.keys(out).sort();
  if (names.length === 0) return { text: null, names, notes };
  return { text: JSON.stringify({ ...doc, [rootKey]: out }, null, 2) + '\n', names, notes };
}

/**
 * CES-managed servers (by name) that the consumer's own config still launches by a network fetch although this sync is not
 * shipping them (opted out, or the package is no longer pinned): the sync never edits a co-owned file to remove them, so it
 * REPORTS them. Judged on the resulting files, not on what this run generates.
 */
export function staleManagedEntries(consumerRoot, managedNames, shippedNames) {
  const out = [];
  for (const [rel, key] of [['.mcp.json', 'mcpServers'], ['.vscode/mcp.json', 'servers']]) {
    const servers = readJson(path.join(consumerRoot, ...rel.split('/')))?.[key] ?? {};
    for (const name of managedNames) {
      if (!shippedNames.includes(name) && Object.hasOwn(servers, name) && classifyLaunchSpec(servers[name]) === 'unpinned') {
        out.push(`stale CES-managed server "${name}" in ${rel} launches by network fetch; remove it, or pin its package and opt in`);
      }
    }
  }
  return out;
}

/**
 * The per-consumer plan for the two MCP files.
 *
 * @param {{consumerRoot: string, sourceRoot: string, syncOptIn: Array<{feature: string}>, log?: (note: string) => void}} a
 * @returns {{optedIn: boolean, omit: Set<string>, names: string[], notes: string[], textFor: (srcRel: string) => string|null}}
 *   `omit`: source paths NOT shipped to this consumer (an opted-out consumer gets no root `.mcp.json`; an opted-in one gets
 *   neither file when none of its servers is pinned). `textFor` returns the rendered replacement for a source path, or
 *   null to use the source file as it is.
 */
export function planRootMcp({ consumerRoot, sourceRoot, syncOptIn, log = () => {} }) {
  const optedIn = (syncOptIn ?? []).some((e) => e.feature === ROOT_MCP_FEATURE);
  const managed = Object.keys(JSON.parse(fs.readFileSync(path.join(sourceRoot, '.mcp.json'), 'utf-8')).mcpServers ?? {});
  // A file no longer shipped (an opted-out consumer's root `.mcp.json`) is the consumer's own from now on: out of the prior
  // manifest so it is not garbage-collected, and out of the new one so gate 10 reads `not-applicable`, never a stale entry.
  const finish = (omit, rest) => {
    const lines = [...(rest.notes ?? [])];
    lines.push(...staleManagedEntries(consumerRoot, managed, rest.names ?? []));
    for (const n of lines) log(n);
    return {
      optedIn, omit, names: [], notes: [], textFor: () => null, ...rest,
      /** The consumer entry with the unshipped source paths removed from its file list. */
      scope: (repo) => ({ ...repo, files: repo.files.filter((f) => !omit.has(f)) }),
      dropOmitted: (files) => Object.fromEntries(Object.entries(files).filter(([k]) => !omit.has(k))),
    };
  };
  if (!optedIn) return finish(new Set(['.mcp.json']), { notes: ['.mcp.json not shipped: not opted in (syncOptIn "root-mcp-json" in .sync-overrides.json)'] });
  const render = (rel) => renderConsumerMcp({ sourceText: fs.readFileSync(path.join(sourceRoot, rel), 'utf-8'), consumerRoot });
  const root = render('.mcp.json');
  const vscode = render('.vscode/mcp.json');
  const notes = root.notes.map((n) => `.mcp.json: ${n}`);
  if (root.text === null) notes.push('.mcp.json not shipped: no server is pinned, locked and installed here');
  return finish(
    new Set([...(root.text === null ? ['.mcp.json'] : []), ...(vscode.text === null ? ['.vscode/mcp.json'] : [])]),
    { names: root.names, notes, textFor: (srcRel) => (srcRel === '.mcp.json' ? root.text : srcRel === '.vscode/mcp.json' ? vscode.text : null) },
  );
}
