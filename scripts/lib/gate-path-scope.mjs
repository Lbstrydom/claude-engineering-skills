/**
 * @fileoverview Path-scoping for two slow pre-push gates (`db:suites:gate`, `gates:poison`): run the gate only when the
 * push range touches what the gate READS, say so out loud when it does not, and run it in full whenever the answer is
 * uncertain. Gate census 2026-11 F5/F10 (L-2, L-3); Louis approved both loosenings on 2026-11-22.
 *
 * THE RULE THIS FILE KEEPS: a skip is only ever the conclusion of a positive finding ("this push touched none of the N
 * paths this gate reads"), never the fallthrough of a failure. Every uncertainty (no explicit range, git cannot list the
 * diff, the tree cannot be read, an import the closure cannot follow) returns `run: true`. And the scoped mode is OFF
 * unless the pre-push sandbox says so (`AUDIT_PREPUSH_GATE_SCOPE=path`, set by `prepush-check.mjs` only for a branch-tier
 * push that does not update the default branch), so `npm run check`, `/ship`, a push to `main` and the `full` tier are
 * byte-for-byte what they were.
 *
 * Triggers are DERIVED from the gate's own inputs, never typed in: the import closure (plus the repo paths each file
 * names as a literal, the way a spawned CLI is named) of the files the gate executes. `DB_SEAM_PREFIXES` in
 * db-test-container.mjs is a hand list that already drifted from this once; it is not consulted here.
 *
 * @module scripts/lib/gate-path-scope
 */
import path from 'node:path';
import { languageForExtension } from './file-taxonomy.mjs';
import { describePushRange, resolvePushRange } from './push-range.mjs';
import { parseImports, resolveSpecifier } from './module-graph.mjs';
import { SHARED_ENVIRONMENT, literalRefs, parseHeavyList, parseTierEnvelope } from './test-tier.mjs';
import { changedFiles, readTreeAt } from './test-tier-git.mjs';

/** Set by the pre-push sandbox to `path` for a branch-tier push that does not update the default branch. Absent = full. */
export const GATE_SCOPE_ENV = 'AUDIT_PREPUSH_GATE_SCOPE';
export const GATE_SCOPE_PATH = 'path';

// The taxonomy owns "which extensions are JS"; no hand-kept list here.
const isCode = (f) => languageForExtension(path.extname(f))?.id === 'js';

/**
 * May the slow gates scope themselves for this push? PURE. Mirrors `selectTier`'s reading of the request: an empty
 * request takes the repo's committed default (`.test-tiers.json` `defaultTier`, else `full`), and anything that is not
 * plainly `branch` (a forced `full`, an unknown value, an unreadable list) or any push to the default branch is NOT scoped.
 *
 * @param {{tierRequest?: string|null, pushesDefault?: boolean, listText?: string|null}} a
 * @returns {boolean}
 */
export function isScopedPush({ tierRequest = '', pushesDefault = false, listText = null } = {}) {
  if (pushesDefault) return false;
  const raw = String(tierRequest ?? '').trim();
  if (raw === 'branch') return true;
  if (raw !== '') return false;
  const list = parseHeavyList(listText ?? '');
  return list.ok && list.list.defaultTier === 'branch';
}

/**
 * The scope decision for one push, taken from the tier ORACLE's own envelope, not from the requested tier. The oracle can
 * force the full tier for reasons the request does not show (a stale heavy list, a changed selector, shared environment, a
 * missing base), and the full tier runs every gate in full. So: pre-filter on the cheap facts, then run the same `plan` the
 * real tiered run will, and scope ONLY when it says `branch`. Any failure, any other tier, any head mismatch => not scoped.
 *
 * @param {{base: string|null, tierRequest: string, pushesDefault: boolean, listText: string|null, head: string,
 *   run: (kind: 'node', args: string[], opts: {capture: boolean}) => {status: number|null, error?: Error},
 *   readText: (p: string) => string|null, envelopePath: string}} a
 * @returns {{scoped: boolean, reason: string}}
 */
export function scopeFromOracle({ base, tierRequest, pushesDefault, listText, head, run, readText, envelopePath }) {
  if (!base) return { scoped: false, reason: 'no explicit push base' };
  if (!isScopedPush({ tierRequest, pushesDefault, listText })) return { scoped: false, reason: 'not a branch-tier push to a non-default branch' };
  try {
    const args = ['scripts/test-tier.mjs', 'plan', '--head', head, '--out', envelopePath];
    if (tierRequest) args.push('--tier', tierRequest);
    if (pushesDefault) args.push('--pushes-default');
    const p = run('node', args, { capture: true });
    if (p.error || p.status !== 0) return { scoped: false, reason: `the tier oracle exited ${p.status ?? 'abnormally'}` };
    const parsed = parseTierEnvelope(readText(envelopePath) ?? '');
    if (!parsed.ok) return { scoped: false, reason: parsed.reason };
    if (parsed.envelope.head !== head) return { scoped: false, reason: 'the oracle envelope is for another head' };
    if (parsed.envelope.tier !== 'branch') {
      return { scoped: false, reason: `the oracle chose the ${parsed.envelope.tier} tier (${(parsed.envelope.escapes ?? []).map((e) => e.id).join(', ') || 'no escape named'})` };
    }
    return { scoped: true, reason: 'the oracle chose the branch tier' };
  } catch (e) {
    return { scoped: false, reason: `the oracle check threw: ${e.message}` };
  }
}

/**
 * Apply a scope decision to the env the sandbox hands `npm run check`. Always clears first, so an ambient
 * `AUDIT_PREPUSH_GATE_SCOPE=path` can never scope a push the oracle did not approve. Mutates and returns `env`.
 * @param {Record<string, string|undefined>} env
 * @param {{scoped: boolean}} scoping
 */
export function applyGateScope(env, scoping) {
  delete env[GATE_SCOPE_ENV];
  if (scoping.scoped) env[GATE_SCOPE_ENV] = GATE_SCOPE_PATH;
  return env;
}

/**
 * Every file a set of root files can load: the transitive closure over ESM imports, plus the repo paths a file names as a
 * string literal. Literals are followed to ANY target from test-layer files and from `literalFrom` (the gate's own driver
 * scripts, which spawn their workload by path); from every other file only to DATA targets (a fixture, a schema, a JSON
 * file), which cannot recurse. Following library mentions of CODE paths pulled in 1,100 of 1,700 files (measured
 * 2026-11-22: libraries name `scripts/x.mjs` in prose and comments), which would make the gate unskippable.
 *
 * Fail-closed, with ONE acknowledged exception class. Anything the closure cannot follow is `uncertain` and makes the
 * caller run the gate: an unresolvable import anywhere, a root or symlink the tree does not give, an unreadable file, and
 * a computed a dynamic import. A computed a dynamic import is `blind` (reported, not forcing) ONLY when its file is listed in
 * `acknowledgedComputed` with a reason AND the exact call count that was read; a new one (or a changed count) is `uncertain` until someone reads it and says why it cannot reach the
 * gate. A literal that names a path the pushed tree no longer has (a deleted fixture) is kept in the result, so deleting
 * it still matches.
 *
 * @param {{roots: string[], literalFrom?: string[], skipLiteral?: (lit: string) => boolean, acknowledgedComputed?: Record<string, {reason: string, calls: number}>,
 *   tree: {files: Set<string>, symlinks?: Set<string>, read: (p: string) => string|null}}} a
 * @returns {{files: Set<string>, uncertain: string[], blind: string[], computedFiles: string[]}}
 */
export function importClosure({ roots, literalFrom = [], skipLiteral = () => false, acknowledgedComputed = {}, tree }) {
  const seen = new Set();
  const named = new Set();
  const uncertain = [];
  const blind = [];
  const computedFiles = [];
  const queue = [...roots];
  const byTail = new Map();
  const tails = (lit) => {
    if (!byTail.has(lit)) byTail.set(lit, [...tree.files].filter((f) => f.endsWith(`/${lit}`)));
    return byTail.get(lit);
  };
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!tree.files.has(f)) { uncertain.push(`${f} is a root the tree does not contain`); continue; }
    if (tree.symlinks?.has(f)) { uncertain.push(`${f} is a symbolic link (its target is not followed)`); continue; }
    if (!isCode(f)) continue;
    const src = tree.read(f);
    if (src == null) { uncertain.push(`${f} could not be read`); continue; }
    const parsed = parseImports(src, { dynamic: true, reportComputed: true });
    if (parsed.computed) {
      computedFiles.push(f);
      const ack = Object.hasOwn(acknowledgedComputed, f) ? acknowledgedComputed[f] : null;
      // The acknowledgement is bound to the EXACT number of calls that were read. A file that gains one is no longer
      // what was reviewed, so it is `uncertain` again until someone reads the new edge.
      if (ack && ack.calls === parsed.computed) blind.push(`${f} (${parsed.computed} computed dynamic import, acknowledged: ${ack.reason})`);
      else if (ack) uncertain.push(`${f} now has ${parsed.computed} computed dynamic import call(s); the acknowledgement covers ${ack.calls}`);
      else uncertain.push(`${f} has ${parsed.computed} computed dynamic import call(s) not acknowledged in the gate's list`);
    }
    for (const specifier of parsed.specifiers) {
      const r = resolveSpecifier({ fromFile: f, specifier, repoFiles: tree.files, exact: true });
      if (r.kind === 'repo' && r.resolved) queue.push(r.resolved);
      // A placeholder or backtick is template text the regex mistook for an import, not an edge.
      else if (r.kind === 'unresolvable' && !specifier.includes('`') && !specifier.includes('${')) {
        uncertain.push(`${f} -> ${specifier} does not resolve`);
      }
    }
    const full = f.startsWith('tests/') || literalFrom.includes(f);
    for (const lit of literalRefs(src)) {
      // The skip applies ONLY to the driver files: that is where an enrolment-exempt list lives. A suite that names another
      // test file by path is an edge.
      if (literalFrom.includes(f) && skipLiteral(lit)) continue;
      const targets = tree.files.has(lit) ? [lit] : (lit.includes('/') ? tails(lit) : []);
      if (targets.length === 0 && lit.includes('/')) named.add(lit);
      for (const t of targets) if (full || !isCode(t)) queue.push(t);
    }
  }
  for (const n of named) seen.add(n);
  return { files: seen, uncertain, blind, computedFiles };
}

/**
 * Decide whether a scoped gate runs. Never throws; every failure is `run: true` with its reason.
 *
 * @param {object} a
 * @param {string} a.gate  name for the printed line
 * @param {NodeJS.ProcessEnv} a.env
 * @param {string} a.cwd  the checkout the gate runs in (the sandbox)
 * @param {(tree: {files: Set<string>, symlinks?: Set<string>, read: (p: string) => string|null}) => {files?: Iterable<string>, prefixes?: string[], uncertain?: string[]}} a.triggers
 *   what THIS gate reads, derived from the tree at the pushed head
 * @param {{resolveRange?: Function, getChanged?: Function, getTree?: Function}} [a.io] injected for tests
 * @returns {{run: boolean, scoped: boolean, reason: string}}
 */
export function decideGateScope({ gate, env, cwd, triggers, io = {} }) {
  const full = (reason) => ({ run: true, scoped: false, reason });
  if ((env[GATE_SCOPE_ENV] ?? '').trim() !== GATE_SCOPE_PATH) {
    return full('full: not a path-scoped push (full tier, a push to the default branch, or not run by the pre-push sandbox)');
  }
  const resolveRange = io.resolveRange ?? resolvePushRange;
  const getChanged = io.getChanged ?? changedFiles;
  const getTree = io.getTree ?? readTreeAt;

  const range = resolveRange({ env, requireExplicit: true });
  if (!range.ok) return full(`full: the push range is unresolved (${range.reason}: ${range.message})`);
  const head = range.head;

  const ch = getChanged(cwd, range.base, head);
  if (!ch.ok) return full(`full: could not list what ${describePushRange(range)} changed (${ch.error})`);
  const tr = getTree(cwd, head);
  if (!tr.ok) return full(`full: could not read the pushed tree (${tr.error})`);

  let t;
  try { t = triggers(tr.tree); } catch (e) { return full(`full: could not derive what ${gate} reads (${e.message})`); }
  if (t.uncertain?.length) return full(`full: ${t.uncertain.length} input(s) of ${gate} cannot be followed (first: ${t.uncertain[0]})`);
  const blind = t.blind?.length ? `; ${t.blind.length} blind computed dynamic import edge(s) in scripts/** not followed` : '';

  // Checked BEFORE the shared additions below, which are never empty: an empty derived set would skip every push.
  if (!(t.files && [...t.files].length) && !(t.prefixes && t.prefixes.length)) return full(`full: the derived input set of ${gate} is empty`);
  // What every test shares is an input of any gate that runs tests (the pg driver version, the node version). The tier
  // selector's own files are not mirrored here: `scopeFromOracle` already refuses to scope a push the oracle made full.
  const files = new Set([...(t.files ?? []), ...SHARED_ENVIRONMENT]);
  const prefixes = t.prefixes ?? [];
  const norm = (p) => String(p).replace(/\\/g, '/');
  const hit = ch.files.map(norm).find((c) => files.has(c) || prefixes.some((p) => c.startsWith(p)));
  const span = describePushRange(range);
  if (hit) return { run: true, scoped: true, reason: `runs: ${hit} is an input of ${gate} and changed in ${span}` };
  return {
    run: false,
    scoped: true,
    reason: `none of the ${files.size} file(s) and ${prefixes.length} path prefix(es) ${gate} reads changed in ${span} (${ch.files.length} changed file(s) checked${blind})`,
  };
}

/** The one visible line a scoped gate prints, whichever way it went. */
export function scopeLine(gate, d) {
  if (!d.scoped) return `${gate}: running in full — ${d.reason}\n`;
  if (d.run) return `${gate}: running (path-scoped) — ${d.reason}\n`;
  return (
    `${gate}: SKIPPED (path-scoped) — ${d.reason}.\n` +
    '  This gate did NOT run for this push. It runs in full on every push to the default branch, in the full tier,\n' +
    '  and whenever the push touches one of its inputs.\n'
  );
}
