/**
 * @fileoverview The test-tier ORACLE: one pure function from (a pushed head's tree, what the push changed, the
 * heavy-file list, the pusher's request) to a `test-tier/v1` envelope that says which heavy test files may be left
 * out of a work-in-progress push. The hook, `prepush-check.mjs`, `run-tests.mjs`, the query CLI and ship-trains
 * Cluster D all ask it; none re-derives a selection (plan D1).
 *
 * **Why it is shaped like this** (docs/plans/gate-cost-slice-2.md):
 *  - Selection applies ONLY to the committed heavy list (`.test-tiers.json`, the 48-file fleet / archive-lane
 *    family: 57% of the suite's test time). Every other file always runs, because the measured late failures are
 *    cheap corpus guards no import graph can see (§1.4).
 *  - A heavy file runs when the diff reaches it: it changed, or something in its computed reach changed (ESM import
 *    closure plus literal repo paths a test names), or something in its DECLARED reach changed (what the graph cannot
 *    compute: a spawned CLI, `.fleet.json`). An edge we cannot follow (an unresolvable import, a non-literal
 *    `import()`) counts as reached: fail toward running more (D3).
 *  - A push that updates the default branch, a diff that touches the selector or what it reads, a stale list, an
 *    unresolvable base, or an explicit `AUDIT_PREPUSH_TIER=full` is `full` and says which escape fired (§2.5).
 *  - The module is PURE: the tree is injected (`{files, read}`), so it answers for any head and never reads the
 *    working tree. The git adapters live in `test-tier-git.mjs`.
 *
 * Stage 0 (shadow) is "requested defaults to full, so nothing is skipped, and `wouldSkip` is printed". Stage 1 is
 * `AUDIT_PREPUSH_TIER=branch`. The default flip (stage 2) is NOT built: `DEFAULT_BRANCH_TIER` stays `full`.
 *
 * @module scripts/lib/test-tier
 */
import { z } from 'zod';
import { globMatch } from './glob-match.mjs';
import { parseImports, resolveSpecifier } from './module-graph.mjs';

export const TEST_TIER_VERSION = 'test-tier/v1';
/** The tier a push takes when the pusher does not ask. Flipping it to `branch` is stage 2 and needs the user's approval. */
export const DEFAULT_BRANCH_TIER = 'full';
export const TIERS = Object.freeze(['full', 'branch']);
/** What the sandbox looks for in a head's `scripts/run-tests.mjs` text to know the tiered path exists there (D7b). */
export const TIER_PROTOCOL_MARKER = 'export const TIER_PROTOCOL';

/**
 * Every file whose change can alter a selection (audit H1). ONE list behind the selector-change escape, the selector
 * identity of the query, and the sandbox capability check.
 */
export const SELECTOR_DEPENDENCIES = Object.freeze([
  'scripts/lib/test-tier.mjs',
  'scripts/lib/test-tier-git.mjs',
  'scripts/lib/module-graph.mjs',
  'scripts/lib/glob-match.mjs',
  'scripts/test-tier.mjs',
  '.test-tiers.json',
  'scripts/run-tests.mjs',
  'scripts/prepush-check.mjs',
  '.githooks/**',
]);
/** The subset whose blob shas identify the selector for a historical query (§2.6). */
export const SELECTOR_IDENTITY_FILES = Object.freeze([
  'scripts/lib/test-tier.mjs', 'scripts/lib/test-tier-git.mjs', 'scripts/lib/module-graph.mjs', 'scripts/lib/glob-match.mjs', 'scripts/test-tier.mjs',
]);
/** Files shared by every test: a change reaches everything (§2.5). */
export const SHARED_ENVIRONMENT = Object.freeze(['package.json', 'package-lock.json', '.nvmrc']);
const DAY_MS = 86_400_000;

// ── The heavy list ──────────────────────────────────────────────────────────

const HeavyEntrySchema = z.strictObject({
  file: z.string().regex(/^tests\/(?:claudemd\/|install\/)?[\w.-]+\.test\.mjs$/, 'a test file directly inside tests/, tests/claudemd/ or tests/install/'),
  why: z.string().min(10),
  measuredMs: z.number().int().nonnegative(),
  measuredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((s) => Number.isFinite(Date.parse(s)), 'a calendar date'),
  reach: z.array(z.string().min(1)).min(1),
});
export const HeavyListSchema = z.strictObject({
  version: z.literal(1),
  maxAgeDays: z.number().int().positive(),
  heavyThresholdMs: z.number().int().positive(),
  heavy: z.array(HeavyEntrySchema).min(1),
}).refine((l) => new Set(l.heavy.map((h) => h.file)).size === l.heavy.length, { message: 'a file is listed twice' });

/** @returns {{ok: true, list: z.infer<typeof HeavyListSchema>}|{ok: false, reason: string}} */
export function parseHeavyList(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, reason: `.test-tiers.json is not JSON (${e.message})` }; }
  const p = HeavyListSchema.safeParse(raw);
  return p.success ? { ok: true, list: p.data } : { ok: false, reason: `.test-tiers.json is invalid: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` };
}

// ── Reach ───────────────────────────────────────────────────────────────────

/**
 * Repo paths a TEST-SIDE file names as literals: a quoted `'scripts/x.mjs'`, the segments of a `path.join/resolve(…)`
 * call, and a quoted root file such as `'status.md'`. These are edges ESM imports do not express (a spawned CLI, a
 * file read at test time), so the closure follows them into that file's own imports.
 */
export function literalRefs(src) {
  const refs = new Set();
  for (const m of src.matchAll(/['"`]((?:\.{0,2}\/)?(?:[\w.@-]+\/)+[\w.@-]+\.\w+)['"`]/g)) refs.add(m[1].replace(/^(\.\.?\/)+/, ''));
  for (const m of src.matchAll(/(?:join|resolve)\(([^()]*)\)/g)) {
    const segs = [...m[1].matchAll(/['"]([^'"\n]+)['"]/g)].map((x) => x[1]).filter((s) => s !== '..' && s !== '.');
    if (segs.length >= 1) refs.add(segs.join('/').replace(/^(\.\.?\/)+/, ''));
  }
  for (const m of src.matchAll(/['"`]([\w.-]+\.(?:md|json|jsonc|yml|yaml|mjs))['"`]/g)) refs.add(m[1]);
  return refs;
}

const isCode = (f) => /\.(?:mjs|js|cjs)$/.test(f);

/**
 * The computed reach of one test file: the transitive closure over ESM imports plus the literal repo paths of
 * test-side files. `unresolved` lists path-like imports that resolve to no file, and `computed` counts `import()`
 * calls with a non-literal argument in the TEST layer (`tests/**`, the test file and its helpers): either marks the
 * file reached (D3).
 *
 * **Measured deviation from D3 (plan section 13, item 9).** Applied to every module in the closure, the computed-import
 * rule made 40 of the 48 heavy files "reached" by ANY diff (14 `scripts/**` modules, `anthropic-client.mjs` among them,
 * carry a non-literal `import()` and the fleet tests reach them), so the tier could never skip. In `scripts/**` such a
 * call is recorded in `blind` (the envelope names it) and the DECLARED reach plus the full verification before a
 * merge are the backstops; in the test layer it stays a reach, because a test that loads a computed fixture path is
 * exactly the edge a literal scan cannot see.
 *
 * @param {{file: string, tree: {files: Set<string>, read: (p: string) => string|null}, suffixIndex?: Map<string, string|null>}} a
 * @returns {{files: Set<string>, computed: number, blind: Array<{file: string, calls: number}>, unresolved: string[], named: Set<string>}}
 */
export function computeReach({ file, tree, suffixIndex = new Map() }) {
  const seen = new Set();
  const unresolved = [];
  const blind = [];
  // Every repo path a test-side file NAMES, whether or not it exists at the head: a path deleted by the diff is named
  // by the test and absent from the tree, and that deletion must still reach the test (audit H3).
  const named = new Set();
  let computed = 0;
  const queue = [file];
  // EVERY file the literal could mean, never the first one enumeration happens to give (audit H4: ambiguity is
  // resolved by running more, not by the tree's iteration order).
  const byTail = (lit) => {
    if (!suffixIndex.has(lit)) suffixIndex.set(lit, [...tree.files].filter((f) => f.endsWith(`/${lit}`)).sort());
    return suffixIndex.get(lit);
  };
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    // A symbolic link's target is not followed (its content is a path, and the target may sit anywhere): reaching one is
    // an UNRESOLVABLE edge, so the entry is reached by any diff. Fail toward running more (audit r3 H1/M1).
    if (tree.symlinks?.has(f)) { unresolved.push(`${f} (a symbolic link: its target is not followed)`); continue; }
    if (!isCode(f)) continue;
    const src = tree.read(f);
    if (src == null) continue;
    const parsed = parseImports(src, { dynamic: true, reportComputed: true });
    if (parsed.computed) {
      if (f.startsWith('tests/')) computed += parsed.computed;
      else blind.push({ file: f, calls: parsed.computed });
    }
    for (const specifier of parsed.specifiers) {
      const r = resolveSpecifier({ fromFile: f, specifier, repoFiles: tree.files, exact: true });
      if (r.kind === 'repo' && r.resolved) queue.push(r.resolved);
      // A specifier carrying a template placeholder or a backtick is the regex reading source TEXT (a string that
      // contains the word "from"), not an import: it is a computed edge, never an unresolvable path.
      // Only the two shapes a template literal can leave behind: a backtick, or a `${` placeholder. A lone `$` is a legal
      // file name character and stays a genuine unresolvable import (audit r2 H2). The edge is recorded either way.
      else if (r.kind === 'unresolvable' && (specifier.includes('`') || specifier.includes('${'))) { if (f.startsWith('tests/')) computed += 1; else blind.push({ file: f, calls: 1, template: specifier.slice(0, 60) }); }
      else if (r.kind === 'unresolvable') unresolved.push(`${f} -> ${specifier}`);
    }
    if (f.startsWith('tests/')) {
      for (const lit of literalRefs(src)) {
        named.add(lit);
        if (tree.files.has(lit)) queue.push(lit);
        else if (lit.includes('/')) queue.push(...byTail(lit));
      }
    }
  }
  return { files: seen, computed, blind, unresolved, named };
}

/** Does the diff reach this heavy entry? `via` names up to three reasons. */
export function entryReached(entry, { changed, reach }) {
  const via = [];
  if (changed.includes(entry.file)) via.push(`${entry.file} itself changed`);
  for (const c of changed) {
    if (reach.files.has(c) && c !== entry.file) via.push(`${c} (imported or named by the test)`);
    else if (reach.named?.has(c) || [...(reach.named ?? [])].some((n) => n.includes('/') && c.endsWith(`/${n}`))) via.push(`${c} (named by the test, present or deleted)`);
    else if (entry.reach.some((g) => globMatch(g, c))) via.push(`${c} (declared reach)`);
    if (via.length >= 3) break;
  }
  if (reach.computed > 0) via.push(`${reach.computed} import() call(s) with a computed argument in the test layer cannot be followed`);
  if (reach.unresolved.length > 0) via.push(`unresolvable import: ${reach.unresolved[0]}`);
  return { reached: via.length > 0, via: via.slice(0, 3) };
}

// ── Selection ───────────────────────────────────────────────────────────────

const normalise = (p) => String(p).replace(/\\/g, '/');

/** Content escapes: a function of (head, base, changed, list) only, so they are part of the counterfactual. */
function contentEscapes({ base, changed, list, tree, asOf }) {
  const out = [];
  if (!base) out.push({ id: 'no-selection-base', detail: 'no resolvable selection base, so what changed is unknown' });
  const touched = changed.filter((c) => SELECTOR_DEPENDENCIES.some((g) => globMatch(g, c)));
  if (touched.length) out.push({ id: 'selector-changed', detail: `the diff touches the selector or what it reads: ${touched.slice(0, 3).join(', ')}` });
  const shared = changed.filter((c) => SHARED_ENVIRONMENT.includes(c));
  if (shared.length) out.push({ id: 'shared-environment', detail: `the diff touches what every test shares: ${shared.join(', ')}` });
  const missing = list.heavy.filter((h) => !tree.files.has(h.file)).map((h) => h.file);
  if (missing.length) out.push({ id: 'heavy-list-stale', detail: `${missing.length} listed file(s) no longer exist: ${missing.slice(0, 3).join(', ')}` });
  const asOfMs = Date.parse(asOf);
  const old = Number.isFinite(asOfMs) ? list.heavy.filter((h) => asOfMs - Date.parse(h.measuredAt) > list.maxAgeDays * DAY_MS).map((h) => h.file) : [];
  if (old.length) out.push({ id: 'heavy-list-stale', detail: `${old.length} listed timing(s) are older than ${list.maxAgeDays} days (first: ${old[0]})` });
  return out;
}

/**
 * @param {object} a
 * @param {{files: Set<string>, read: (p: string) => string|null}} a.tree the pushed head's tree
 * @param {z.infer<typeof HeavyListSchema>} a.list
 * @param {string[]} a.changed repo paths the push changed since the selection base
 * @param {string} a.head
 * @param {string|null} a.base
 * @param {string} [a.baseSource]
 * @param {string} a.asOf ISO time the list's age is judged at
 * @param {string|null|undefined} [a.requested] the pusher's request (`AUDIT_PREPUSH_TIER`); unset means the default
 * @param {boolean} [a.pushesDefault] does this push update the default branch
 * @param {'push'|'counterfactual-branch'|'counterfactual-candidate'} [a.kind]
 * @param {object} [a.identity] selector and manifest blob shas, recorded as given
 */
export function selectTier({ tree, list, changed, head, base, baseSource = 'merge-base', asOf, requested = null, pushesDefault = false, kind = 'push', identity = {} }) {
  const ch = [...new Set(changed.map(normalise))].sort();
  const raw = requested === null || requested === undefined || requested === '' ? null : String(requested);
  const effective = raw ?? DEFAULT_BRANCH_TIER;
  const escapes = [];
  if (!TIERS.includes(effective)) escapes.push({ id: 'unknown-tier-request', detail: `AUDIT_PREPUSH_TIER=${JSON.stringify(raw)} is not one of ${TIERS.join(', ')}` });
  if (pushesDefault) escapes.push({ id: 'pushes-default', detail: 'this push updates the default branch: the bytes that land get the full suite' });
  if (raw === 'full') escapes.push({ id: 'forced-full', detail: 'AUDIT_PREPUSH_TIER=full' });
  const content = contentEscapes({ base, changed: ch, list, tree, asOf });
  const suffixIndex = new Map();
  const heavy = list.heavy.map((entry) => {
    const present = tree.files.has(entry.file);
    const reach = present ? computeReach({ file: entry.file, tree, suffixIndex }) : { files: new Set(), computed: 0, blind: [], unresolved: [], named: new Set() };
    const r = entryReached(entry, { changed: ch, reach });
    // `blind` is known uncertainty (a non-literal import() inside scripts/**): carried into the envelope, not dropped (M3).
    return { file: entry.file, reached: present ? r.reached : true, via: present ? r.via : ['listed but missing from the tree'], blind: reach.blind.slice(0, 5), blindCount: reach.blind.length };
  });
  // What the branch tier WOULD skip if no push-time escape fired (stage 0 prints this number).
  const wouldSkip = content.length ? [] : heavy.filter((h) => !h.reached).map((h) => h.file);
  const allEscapes = [...escapes, ...content];
  const branch = effective === 'branch' && allEscapes.length === 0;
  return {
    version: TEST_TIER_VERSION, kind,
    tier: branch ? 'branch' : 'full',
    requested: effective, requestedRaw: raw,
    head, base: base ?? null, baseSource, asOf,
    selector: identity.selector ?? null, manifest: identity.manifest ?? null,
    escapes: allEscapes, heavy, wouldSkip, skipped: branch ? wouldSkip : [],
  };
}

/** The counterfactual of §2.6: what the branch tier would skip for (head, base), with no push-time input. */
export function selectBranchTier(a) {
  return { ...selectTier({ ...a, requested: 'branch', pushesDefault: false, kind: 'counterfactual-branch' }), measured: true };
}

/** §2.6's replay: an explicitly supplied candidate list and change list, against an injected tree. Never the production query. */
export function replayCandidate({ changed, list, tree, asOf, head = 'candidate', base = 'candidate', identity = {} }) {
  return { ...selectTier({ tree, list, changed, head, base, baseSource: 'explicit', asOf, requested: 'branch', kind: 'counterfactual-candidate', identity }), measured: true };
}

// ── The envelope and the one-line summary ───────────────────────────────────

const EnvelopeSchema = z.object({
  version: z.literal(TEST_TIER_VERSION),
  kind: z.enum(['push', 'counterfactual-branch', 'counterfactual-candidate']),
  tier: z.enum(TIERS),
  head: z.string().min(1),
  escapes: z.array(z.object({ id: z.string(), detail: z.string() }).passthrough()),
  heavy: z.array(z.object({ file: z.string(), reached: z.boolean() }).passthrough()),
  skipped: z.array(z.string()),
  wouldSkip: z.array(z.string()),
}).passthrough();

/** Parse an envelope. A missing, unparseable or wrong-version envelope is NOT "skip nothing silently": the caller falls back to full. */
export function parseTierEnvelope(text) {
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, reason: `the tier envelope is not JSON (${e.message})` }; }
  const p = EnvelopeSchema.safeParse(raw);
  if (!p.success) return { ok: false, reason: `the tier envelope is invalid: ${p.error.issues.slice(0, 2).map((i) => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}` };
  return { ok: true, envelope: p.data };
}

/**
 * Cross-check an envelope against the heavy list (guard §2.4 item 1): every skipped file is on the list and is not
 * reached, and a `full` envelope skips nothing.
 */
export function validateEnvelopeAgainstList(envelope, list) {
  const listed = new Set(list.heavy.map((h) => h.file));
  // Absence is never "not reached" (audit H2/M8): the envelope must carry a record for EVERY listed file, exactly once.
  const recorded = envelope.heavy.map((h) => h.file);
  const missing = [...listed].filter((f) => !recorded.includes(f));
  if (missing.length) return { ok: false, reason: `the envelope has no reach record for ${missing.length} listed file(s): ${missing.slice(0, 3).join(', ')}` };
  if (new Set(recorded).size !== recorded.length) return { ok: false, reason: 'the envelope records a file twice' };
  const extra = recorded.filter((f) => !listed.has(f));
  if (extra.length) return { ok: false, reason: `the envelope records file(s) that are not on the heavy list: ${extra.slice(0, 3).join(', ')}` };
  const reached = new Set(envelope.heavy.filter((h) => h.reached).map((h) => h.file));
  const bad = envelope.skipped.filter((f) => !listed.has(f));
  if (bad.length) return { ok: false, reason: `the envelope skips file(s) that are not on the heavy list: ${bad.slice(0, 3).join(', ')}` };
  const wrong = envelope.skipped.filter((f) => reached.has(f));
  if (wrong.length) return { ok: false, reason: `the envelope skips file(s) the diff reaches: ${wrong.slice(0, 3).join(', ')}` };
  if (envelope.tier === 'full' && envelope.skipped.length) return { ok: false, reason: 'a full-tier envelope must skip nothing' };
  return { ok: true };
}

/**
 * The envelope must agree with the request it is about to be executed for (audit H1): a `branch` envelope is only legal
 * for a request of `branch`, on a push that does not update the default branch, with no escape listed. Anything else
 * runs the full suite.
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function envelopeMatchesRequest(envelope, { tier, pushesDefault }) {
  if (envelope.tier !== 'branch') return { ok: true };
  if (tier !== 'branch') return { ok: false, reason: `a branch envelope for a request of ${JSON.stringify(tier || 'the default')}` };
  if (pushesDefault) return { ok: false, reason: 'a branch envelope for a push that updates the default branch' };
  if (envelope.escapes.length) return { ok: false, reason: `a branch envelope that lists escape(s): ${envelope.escapes.map((e) => e.id).join(', ')}` };
  return { ok: true };
}

const SHA = /^[0-9a-f]{40,64}$/;
/** `test-tier/v1 <tier> <head> skipped=<n> base=<sha|none>[ reason=<token>]` — exactly this, one line. */
export function summaryLine({ tier, head, skipped, base, reason = null }) {
  if (!TIERS.includes(tier) || !SHA.test(head)) throw new Error(`summaryLine: bad tier ${JSON.stringify(tier)} or head ${JSON.stringify(head)}`);
  return `${TEST_TIER_VERSION} ${tier} ${head} skipped=${skipped} base=${base ?? 'none'}${reason ? ` reason=${String(reason).replace(/[^A-Za-z0-9._:-]/g, '-').slice(0, 60)}` : ''}`;
}
const SUMMARY_RE = /^test-tier\/v1 (full|branch) ([0-9a-f]{40,64}) skipped=(\d+) base=([0-9a-f]{40,64}|none)(?: reason=([A-Za-z0-9._:-]+))?$/;
/** Validate the single-line summary the hook reads back: exactly one line, the grammar, and the pushed head. */
export function parseSummary(text, expectedHead) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => l !== '');
  if (lines.length !== 1) return { ok: false, reason: lines.length === 0 ? 'the summary is empty' : `the summary has ${lines.length} lines, not one` };
  const m = SUMMARY_RE.exec(lines[0]);
  if (!m) return { ok: false, reason: 'the summary does not match the test-tier/v1 grammar' };
  if (expectedHead && m[2] !== expectedHead) return { ok: false, reason: `the summary names ${m[2].slice(0, 8)}, not the pushed head ${String(expectedHead).slice(0, 8)}` };
  return { ok: true, tier: m[1], head: m[2], skipped: Number(m[3]), base: m[4] === 'none' ? null : m[4], reason: m[5] ?? null };
}

/** Honest wording before and after a tiered run (D8). */
export function tierBanner(envelope) {
  if (envelope.tier === 'branch') {
    return `BRANCH TIER — not the full suite. Skipped ${envelope.skipped.length} heavy file(s): ${envelope.skipped.map((f) => f.replace(/^tests\//, '')).join(', ')}.`;
  }
  return null;
}

/** Stage 0's shadow line: what the branch tier would have done, said without doing it. */
export function shadowLine(envelope) {
  const content = envelope.escapes.filter((e) => !['pushes-default', 'forced-full', 'unknown-tier-request'].includes(e.id));
  if (content.length) return `test-tier/v1 shadow: the branch tier would run everything (${content.map((e) => e.id).join(', ')})`;
  return `test-tier/v1 shadow: would skip ${envelope.wouldSkip.length} of ${envelope.heavy.length} heavy file(s) (${envelope.heavy.filter((h) => h.reached).length} reached by this diff)`;
}
