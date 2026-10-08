/**
 * @fileoverview /fleet's pure decision core — no fs, no git, no process, no clock.
 *
 * Everything that DECIDES lives here as a function of plain data: does claim A
 * overlap claim B, is this a duplicate, is a session live, may a new chip
 * proceed, may a train be approved, in what order should branches land, and the
 * read-only join (`buildStatus`) that `fleet status` renders. The fact modules
 * gather; this module judges. `now` is always a parameter — it is read once by
 * the caller, never twice here.
 *
 * Soundness stance: `patternsIntersect` answers `'disjoint'` ONLY when
 * disjointness is proven; anything it cannot prove (including input outside the
 * closed claim grammar) is `'unknown'`, which every caller treats as overlap.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2, §2b, §7 (Phase 2).
 *
 * @module scripts/lib/fleet/overlap
 */
import micromatch from 'micromatch';

export const TERMINAL_STATES = Object.freeze(['done', 'abandoned']);
export const DEFAULT_LEASE_MS = 4 * 60 * 60 * 1000;
export const DEFAULT_SKEW_MS = 5 * 60 * 1000;

/** @param {unknown} v @returns {number|null} epoch ms */
export function toMs(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return Number.isFinite(v.getTime()) ? v.getTime() : null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

export function isTerminalState(state) { return TERMINAL_STATES.includes(state); }

// ── Claim-pattern grammar ───────────────────────────────────────────────────

// ALLOWLIST of per-segment characters. Every accepted character is a LITERAL in
// micromatch too (or one of the two grammar wildcards), so validation,
// patternsIntersect and fileOverlap share one semantics. Anything else
// (double quote, ', backslash, `, $, ^, |, ;, :, <, >, braces, brackets, parens, !, &)
// is rejected at claim time, naming the character.
const ALLOWED_SEGMENT_CHAR = /^[\p{L}\p{N}_.\-@+=,~#%* ?]$/u;

// Size bounds. `charsIntersect` and `patternsIntersect` recurse once per character / segment step, so
// unbounded input is a stack overflow (an unexpected-error trace) rather than a refusal, and the DP is
// O(chars x chars) per segment pair. `patternsIntersect` validates first, so no recursion ever runs on
// an over-limit pattern: it answers `'unknown'`, which every caller treats as overlap. Real claims are
// nowhere near these (a path is rarely over ~12 segments, a name rarely over ~60 characters).
export const MAX_PATTERN_SEGMENTS = 24;
export const MAX_SEGMENT_CHARS = 100;

/**
 * Validate one `paths` entry against the closed grammar: literals, `*`, `?`,
 * and `**` as a WHOLE segment, within the size bounds above. Rejection names the
 * offending character or limit — a refusal at claim time beats an unsound guess
 * (or a stack overflow) at overlap time.
 * @param {unknown} p
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function validateClaimPattern(p) {
  if (typeof p !== 'string' || p === '') return { ok: false, reason: 'pattern must be a non-empty string' };
  for (const ch of p) {
    if (ch !== '/' && !ALLOWED_SEGMENT_CHAR.test(ch)) {
      return { ok: false, reason: `pattern "${p}" contains ${JSON.stringify(ch)}, which is outside the claim grammar (letters, digits, _ . - space @ + = , ~ # % plus * ? and whole-segment **)` };
    }
  }
  if (p.startsWith('/')) return { ok: false, reason: `pattern "${p}" must be repo-relative (leading "/")` };
  const segs = p.split('/');
  if (segs.length > MAX_PATTERN_SEGMENTS) return { ok: false, reason: `pattern is too long: ${segs.length} segments (at most ${MAX_PATTERN_SEGMENTS})` };
  for (const s of segs) {
    if ([...s].length > MAX_SEGMENT_CHARS) return { ok: false, reason: `pattern has a segment of ${[...s].length} characters (at most ${MAX_SEGMENT_CHARS})` };
    if (s === '') return { ok: false, reason: `pattern "${p}" has an empty segment ("//" or trailing "/")` };
    if (s === '..') return { ok: false, reason: `pattern "${p}" contains ".." (must stay inside the repo)` };
    if (s === '.') return { ok: false, reason: `pattern "${p}" contains "." segment` };
    if (s.includes('**') && s !== '**') return { ok: false, reason: `pattern "${p}": "**" must be a whole segment` };
  }
  return { ok: true };
}

/** @param {unknown} list @returns {{ok: boolean, errors: string[]}} */
export function validateClaimPatterns(list) {
  if (!Array.isArray(list)) return { ok: false, errors: ['paths must be an array'] };
  const errors = [];
  for (const p of list) { const r = validateClaimPattern(p); if (!r.ok) errors.push(r.reason); }
  return { ok: errors.length === 0, errors };
}

/** Wildcard-intersection DP over two already-split character arrays. */
function charsIntersect(a, b) {
  const memo = new Map();
  const f = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === a.length && j === b.length) r = true;
    else if (i < a.length && a[i] === '*') r = f(i + 1, j) || (j < b.length && f(i, j + 1));
    else if (j < b.length && b[j] === '*') r = f(i, j + 1) || (i < a.length && f(i + 1, j));
    else if (i === a.length || j === b.length) r = false;
    else r = (a[i] === '?' || b[j] === '?' || a[i] === b[j]) && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return f(0, 0);
}

/**
 * Two segments intersect iff the DP finds a common string. The DP runs on CODE
 * POINTS (a supplementary-plane letter is ONE `?`). micromatch, however, counts
 * `?` in UTF-16 units, so for a segment holding an astral character the DP is
 * ALSO run on code units and either answer counts: the engine may over-report
 * overlap there but never claims `disjoint` where micromatch could match.
 */
function segmentsIntersect(a, b) {
  if (charsIntersect(Array.from(a), Array.from(b))) return true;
  const astral = /[\uD800-\uDBFF]/;
  return (astral.test(a) || astral.test(b)) && charsIntersect([...a.split('')], [...b.split('')]);
}

/**
 * Do two claim patterns share at least one path? Exact for the grammar.
 * `'disjoint'` only when proven; invalid input → `'unknown'` (treated as overlap).
 * @param {string} a
 * @param {string} b
 * @returns {'intersect'|'disjoint'|'unknown'}
 */
export function patternsIntersect(a, b) {
  if (!validateClaimPattern(a).ok || !validateClaimPattern(b).ok) return 'unknown';
  const A = a.split('/');
  const B = b.split('/');
  const memo = new Map();
  const f = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let r;
    if (i === A.length && j === B.length) r = true;
    else if (i < A.length && A[i] === '**') r = f(i + 1, j) || (j < B.length && f(i, j + 1));
    else if (j < B.length && B[j] === '**') r = f(i, j + 1) || (i < A.length && f(i + 1, j));
    else if (i === A.length || j === B.length) r = false;
    else r = segmentsIntersect(A[i], B[j]) && f(i + 1, j + 1);
    memo.set(key, r);
    return r;
  };
  return f(0, 0) ? 'intersect' : 'disjoint';
}

/**
 * Concrete files matched by any pattern. `dot:true` because the grammar's `*`
 * matches leading-dot names (so `.github/*` agrees with `patternsIntersect`);
 * `nocase:false` because a claim is case-exact. `lib/glob-match.mjs` is not
 * used: its `**\/` does not match zero segments.
 * @param {string[]} files
 * @param {string[]} patterns
 * @returns {string[]}
 */
export function fileOverlap(files, patterns) {
  if (!files?.length || !patterns?.length) return [];
  return files.filter((f) => micromatch.isMatch(f, patterns, { dot: true, nocase: false }));
}

// ── Hot files (`.fleet.json` `hotFiles`) ────────────────────────────────────

/**
 * Hot files are files nearly every branch legitimately touches (ratchet
 * baselines, debt ledgers). An overlap made ONLY of hot files is disclosed, never
 * counted as a conflict and never blocking. Soundness: a changed FILE is hot when
 * a hot pattern matches it; a claim PATTERN pair is hot-only only when one side is
 * a LITERAL path (no `*`/`?`) that is itself hot — the pair's intersection is then
 * at most that one file. A wildcard pair stays a real conflict even if it also
 * covers a hot file, because it may cover non-hot files too.
 */
export function isHotFile(file, hotFiles) {
  return Boolean(hotFiles?.length) && micromatch.isMatch(file, hotFiles, { dot: true, nocase: false });
}

const isLiteralPattern = (p) => typeof p === 'string' && !/[*?]/.test(p);

/** @returns {string|null} the hot literal path when the pair `pa ~ pb` can only meet on it, else null */
function hotLiteralOf(pa, pb, hotFiles) {
  if (isLiteralPattern(pa) && isHotFile(pa, hotFiles)) return pa;
  if (isLiteralPattern(pb) && isHotFile(pb, hotFiles)) return pb;
  return null;
}

/** Partition files into real and hot. @returns {{real: string[], hot: string[]}} */
export function splitHotFiles(files, hotFiles) {
  const real = []; const hot = [];
  for (const f of files ?? []) (isHotFile(f, hotFiles) ? hot : real).push(f);
  return { real, hot };
}

/**
 * Does a `decideClaim` conflict stop a new claim (and need an override)? A known
 * overlap and a hot-files-only overlap do not; everything else does. The one
 * predicate `claim`, `start` and the verdict itself use.
 */
export function isBlockingConflict(c) {
  return !c.known && !c.hotOnly;
}

// ── Duplicates and liveness ─────────────────────────────────────────────────

/**
 * Group items sharing a non-null patch-id.
 * @param {Array<{id: string, patchId: string|null}>} items
 * @returns {Array<{patchId: string, ids: string[]}>}
 */
export function duplicatePatches(items) {
  const by = new Map();
  for (const it of items) {
    if (!it.patchId) continue;
    if (!by.has(it.patchId)) by.set(it.patchId, []);
    by.get(it.patchId).push(it.id);
  }
  return [...by.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([pid, ids]) => ({ patchId: pid, ids: ids.sort() }))
    .sort((x, y) => (x.patchId < y.patchId ? -1 : 1));
}

/**
 * Liveness with its reason. Live iff non-terminal AND (lease unexpired OR a tip
 * commit inside the lease window). A tip more than `skewMs` in the future is
 * ignored and reported — a future-dated commit must not keep a lease alive.
 * @param {{state: string, leaseExpiresAt?: string|number|null}} session
 * @param {{now: number|string|Date, leaseMs?: number, tipCommitAt?: number|null, skewMs?: number}} ctx
 * @returns {{live: boolean, reason: 'terminal'|'lease'|'branch-activity'|'stale', futureDatedTipIgnored: boolean}}
 */
export function liveness(session, { now, leaseMs = DEFAULT_LEASE_MS, tipCommitAt = null, skewMs = DEFAULT_SKEW_MS }) {
  const nowMs = toMs(now);
  if (nowMs === null) throw new Error('liveness: `now` is required');
  if (isTerminalState(session.state)) return { live: false, reason: 'terminal', futureDatedTipIgnored: false };
  const lease = toMs(session.leaseExpiresAt);
  if (lease !== null && lease > nowMs) return { live: true, reason: 'lease', futureDatedTipIgnored: false };
  const tip = toMs(tipCommitAt);
  let future = false;
  if (tip !== null) {
    if (tip > nowMs + skewMs) future = true;
    else if (tip > nowMs - leaseMs) return { live: true, reason: 'branch-activity', futureDatedTipIgnored: false };
  }
  return { live: false, reason: 'stale', futureDatedTipIgnored: future };
}

/** @returns {boolean} */
export function isLive(session, ctx) { return liveness(session, ctx).live; }

// ── The claim gate ──────────────────────────────────────────────────────────

const normIntent = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Admission mode for a `claim`: an id with no record or a TERMINAL record is
 * new (a reused branch name must not read as already-running work); anything
 * else is an update/adoption. Never inferred from branch history.
 * @param {{state: string}|null|undefined} existing
 * @returns {'new'|'adopt'}
 */
export function claimMode(existing) {
  return !existing || isTerminalState(existing.state) ? 'new' : 'adopt';
}

/**
 * The duplicate gate.
 *
 * @param {object} args
 * @param {{id: string, intent?: string, paths?: string[], changedFiles?: string[], knownOverlaps?: Array<{with: string}>}} args.claim
 * @param {'new'|'adopt'} args.mode
 * @param {Array<{session: object, live: boolean, changedFiles?: string[]}>} args.others
 * @param {boolean} args.complete - registry completeness; false refuses for BOTH modes
 * @param {string[]} [args.hotFiles] - `.fleet.json` `hotFiles`: evidence made only of these is disclosed
 *   on the conflict (`hotFiles`, `hotOnly:true`) and never blocks; mixed evidence blocks as before
 * @returns {{ok: boolean, verdict: 'ok'|'warn'|'blocked'|'refused', conflicts: object[], reason?: string}}
 */
export function decideClaim({ claim, mode, others, complete, hotFiles = [] }) {
  if (mode !== 'new' && mode !== 'adopt') throw new Error(`decideClaim: unknown mode ${JSON.stringify(mode)}`);
  if (!complete) return { ok: false, verdict: 'refused', conflicts: [], reason: 'registry incomplete' };
  const myIntent = normIntent(claim.intent);
  const myPaths = claim.paths ?? [];
  const conflicts = [];
  for (const o of others) {
    const s = o.session;
    if (!o.live || isTerminalState(s.state) || s.id === claim.id) continue;
    const via = [];
    const hit = { with: s.id, via, paths: [], files: [], known: false };
    const hot = new Set();
    for (const pa of myPaths) {
      for (const pb of s.paths ?? []) {
        if (patternsIntersect(pa, pb) === 'disjoint') continue;
        const lit = hotLiteralOf(pa, pb, hotFiles);
        if (lit) hot.add(lit); else hit.paths.push([pa, pb]);
      }
    }
    if (hit.paths.length) via.push('paths');
    if (myIntent && myIntent === normIntent(s.intent)) via.push('intent');
    const { real, hot: hotChanged } = splitHotFiles(fileOverlap(o.changedFiles ?? [], myPaths), hotFiles);
    if (real.length) { via.push('files'); hit.files = real; }
    for (const f of hotChanged) hot.add(f);
    if (hot.size) { via.push('hot-files'); hit.hotFiles = [...hot]; hit.hotOnly = via.length === 1; }
    if (!via.length) continue;
    hit.known = (claim.knownOverlaps ?? []).some((k) => k.with === s.id)
      || (s.knownOverlaps ?? []).some((k) => k.with === claim.id);
    conflicts.push(hit);
  }
  const blocking = conflicts.filter(isBlockingConflict);
  if (mode === 'new' && blocking.length) return { ok: false, verdict: 'blocked', conflicts };
  if (mode === 'adopt' && blocking.length) return { ok: true, verdict: 'warn', conflicts };
  return { ok: true, verdict: 'ok', conflicts };
}

// ── Approval eligibility ────────────────────────────────────────────────────

const NEVER_PHASES = new Set(['snapshot', 'applying', 'conflict', 'diverged', 'abandoned', 'landed']);
const RESULT_RANK = ['green', 'green-after-rerun', 'none', 'red', 'dirty'];

/** Worst of a list of results (unknown values rank worst). */
export function worstResult(results) {
  let w = 0;
  for (const r of results) {
    const i = RESULT_RANK.indexOf(r);
    w = Math.max(w, i === -1 ? RESULT_RANK.length : i);
  }
  return RESULT_RANK[w] ?? 'none';
}

/** Tier list from either the normalised array or `{tiers}` form. */
export function tiersOf(testCommand) {
  if (Array.isArray(testCommand)) return testCommand;
  if (testCommand && Array.isArray(testCommand.tiers)) return testCommand.tiers;
  return [];
}

/**
 * Do the recorded hook results forbid approval? A `block` finding, or a
 * check-failed/timeout on a `severity:'block'` check — an unmeasured hook never
 * reads as a pass. `warn` checks only disclose.
 * @returns {string|null} reason, or null when nothing blocks
 */
export function checkBlocksApproval(checkResults) {
  for (const c of checkResults ?? []) {
    if (c.status === 'check-failed' && c.severity === 'block') {
      return `check "${c.name}" failed to run (${c.reason ?? 'no reason recorded'}) and is severity:block`;
    }
    if (c.severity === 'block' && (c.findings ?? []).some((f) => f.level === 'block')) {
      return `check "${c.name}" reported a block-level finding`;
    }
  }
  return null;
}

/**
 * The single approval gate — a pure predicate over the manifest (§2 table, §2b).
 * `approved` is eligible only after a push-pending reconcile
 * (`manifest.reconciledFrom === 'push-pending'`).
 *
 * @param {object} manifest
 * @param {{acceptRerun?: boolean}} [opts]
 * @returns {{ok: boolean, reason: string, needsAcceptRerun?: boolean, note?: string}}
 */
export function approvable(manifest, { acceptRerun = false } = {}) {
  const no = (reason, extra = {}) => ({ ok: false, reason, ...extra });
  if (!manifest || typeof manifest !== 'object') return no('no train manifest');
  const phase = manifest.phase;
  if (NEVER_PHASES.has(phase)) return no(`train is ${phase}${phase === 'diverged' ? ' — needs a human; build a new train' : ''}`);
  if (phase === 'push-pending') return no('train is push-pending — run `land --reconcile` first');
  if (phase === 'awaiting-merge') return no('train is awaiting-merge — approval was already issued; use `land --confirm`');
  if (phase === 'approved' && manifest.reconciledFrom !== 'push-pending') return no('train is approved but not after a push-pending reconcile');
  if (phase !== 'tested' && phase !== 'approved') return no(`train is in unrecognised phase ${JSON.stringify(phase)}`);
  if (!manifest.candidate?.oid || !manifest.candidate?.tree) return no('no candidate recorded');

  const preLand = tiersOf(manifest.testCommand).filter((t) => (t.stage ?? 'pre-land') === 'pre-land');
  const tierResults = Array.isArray(manifest.tierResults) ? manifest.tierResults : null;
  const considered = [manifest.result];
  if (tierResults) {
    for (const t of preLand) {
      const r = tierResults.find((x) => x.name === t.name);
      if (!r) return no(`pre-land tier "${t.name}" has no recorded result`);
      considered.push(r.result);
      if (r.result !== 'green' && r.result !== 'green-after-rerun') return no(`tier "${t.name}" result is ${r.result}`);
    }
  } else if (preLand.length > 1) {
    return no('multiple pre-land tiers but no tier results recorded');
  }
  const overall = worstResult(considered);
  if (overall === 'green-after-rerun') {
    const note = 'first run failed; passed on rerun — possible flake';
    if (!acceptRerun) return no(`result is green-after-rerun — ${note}; pass --accept-rerun to approve`, { needsAcceptRerun: true });
    const blocked = checkBlocksApproval(manifest.checkResults);
    return blocked ? no(blocked) : { ok: true, reason: 'green after rerun, accepted', note };
  }
  if (overall !== 'green') {
    return no(`result is ${manifest.result ?? 'unrecorded'}${overall !== manifest.result ? ` (worst: ${overall})` : ''}`);
  }
  const blocked = checkBlocksApproval(manifest.checkResults);
  if (blocked) return no(blocked);
  return { ok: true, reason: 'tested green' };
}

// ── Landing order ───────────────────────────────────────────────────────────

/** Tarjan SCCs over `edges` (id → ids it waits on). Returns components of size > 1 (or self-loops). */
function cycleComponents(ids, edges) {
  let idx = 0;
  const index = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const out = [];
  const visit = (v) => {
    index.set(v, idx); low.set(v, idx); idx += 1; stack.push(v); onStack.add(v);
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || (edges.get(v) ?? []).includes(v)) out.push(comp.sort());
    }
  };
  for (const id of [...ids].sort()) if (!index.has(id)) visit(id);
  return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/**
 * Deterministic landing order. Base order: ready first, then fewest overlaps,
 * then oldest ready, ties by id. Then a session waiting on another session in
 * the set is placed after it. A waiting cycle is reported and broken by id
 * (the higher id keeps waiting on the lower) for ordering purposes only.
 *
 * @param {Array<{id: string, ready: boolean, overlapCount?: number, readyAt?: string|number|null, waitingOn?: Array<{kind: string, ref: string}>}>} items
 * @returns {{order: string[], cycles: string[][]}}
 */
export function proposeLandingOrder(items) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const base = [...items].sort((a, b) => {
    if (a.ready !== b.ready) return a.ready ? -1 : 1;
    const oc = (a.overlapCount ?? 0) - (b.overlapCount ?? 0);
    if (oc) return oc;
    const ra = toMs(a.readyAt) ?? Infinity; const rb = toMs(b.readyAt) ?? Infinity;
    if (ra !== rb) return ra < rb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }).map((i) => i.id);

  const edges = new Map();
  for (const i of items) {
    edges.set(i.id, (i.waitingOn ?? []).filter((w) => w.kind === 'session' && byId.has(w.ref)).map((w) => w.ref));
  }
  const cycles = cycleComponents(base, edges);
  const inCycle = new Map();
  cycles.forEach((c, n) => c.forEach((id) => inCycle.set(id, n)));
  for (const [id, deps] of edges) {
    edges.set(id, deps.filter((d) => {
      if (inCycle.get(id) !== undefined && inCycle.get(id) === inCycle.get(d)) return id > d;
      return true;
    }));
  }
  const placed = new Set(); const order = [];
  while (order.length < base.length) {
    const next = base.find((id) => !placed.has(id) && (edges.get(id) ?? []).every((d) => placed.has(d)));
    const pick = next ?? base.find((id) => !placed.has(id));
    placed.add(pick); order.push(pick);
  }
  return { order, cycles };
}

// ── The status join ─────────────────────────────────────────────────────────

const samePath = (a, b) => a && b && String(a).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  === String(b).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Is the session finished? Derived on read from a `landed` train: the train's
 * `sources` contain `(id, gen)`; the session's current `rev`/`ready.oid` equal
 * the manifest's; and the OBSERVED tip still equals the manifest oid (or the
 * source ref is gone). A record already cached as `done` is terminal on its own.
 * @returns {{done: boolean, trainId?: string, note?: string}}
 */
export function deriveDone(session, trains, { observedOid, branchGone, tipObserved }) {
  if (isTerminalState(session.state)) return { done: true };
  for (const t of trains ?? []) {
    if (t.phase !== 'landed') continue;
    const src = (t.sources ?? []).find((s) => s.id === session.id && s.gen === session.gen);
    if (!src) continue;
    if (session.rev !== src.rev || session.ready?.oid !== src.oid) {
      return { done: false, note: `landed in ${t.trainId}, but the session record changed since (rev/ready moved)` };
    }
    if (!tipObserved) return { done: false, note: `landed in ${t.trainId}; source tip not observable` };
    if (branchGone || observedOid === src.oid) return { done: true, trainId: t.trainId };
    return { done: false, note: `landed in ${t.trainId}, but newer commits exist on the source` };
  }
  return { done: false };
}

function waitingView(w, { byId, trains }) {
  const view = { ...w };
  if (w.kind === 'session') {
    const t = byId.get(w.ref);
    if (!t || isTerminalState(t.state)) view.unblocked = 'unblocked?';
  } else if (w.kind === 'train') {
    const t = (trains ?? []).find((x) => x.trainId === w.ref);
    if (t?.phase === 'landed') view.unblocked = 'unblocked?';
  }
  return view;
}

/**
 * The read-only join `fleet status` renders. Takes only data; writes nothing.
 *
 * @param {object} facts
 * @param {number|string|Date} facts.now
 * @param {number} [facts.leaseMs]
 * @param {number} [facts.skewMs]
 * @param {{name: string, freshness?: object|null}} facts.base
 * @param {{sessions: object[], invalid?: object[], complete: boolean}} facts.registry
 * @param {{queried: boolean, reason?: string, worktrees?: object[]}} facts.worktrees
 * @param {{queried: boolean, reason?: string, branches?: object[]}} facts.branches
 * @param {{queried: boolean, reason?: string, prs?: object[]}} facts.prs
 * @param {Record<string, {queried: boolean, files?: string[]}>} [facts.changed] - by branch
 * @param {Record<string, {queried: boolean, patchId?: string|null}>} [facts.patchIds] - by branch
 * @param {object[]} [facts.trains]
 * @param {object|null} [facts.hold]
 * @param {Array<{level: string, message: string, sessions?: string[]}>} [facts.findings]
 */
export function buildStatus(facts) {
  const nowMs = toMs(facts.now);
  if (nowMs === null) throw new Error('buildStatus: `now` is required');
  const leaseMs = facts.leaseMs ?? DEFAULT_LEASE_MS;
  const skewMs = facts.skewMs ?? DEFAULT_SKEW_MS;
  const sessions = facts.registry?.sessions ?? [];
  const branchList = facts.branches?.queried ? facts.branches.branches ?? [] : [];
  const branchByName = new Map(branchList.map((b) => [b.name, b]));
  const worktrees = facts.worktrees?.queried ? facts.worktrees.worktrees ?? [] : [];
  const prs = facts.prs?.queried ? facts.prs.prs ?? [] : [];
  const trains = facts.trains ?? [];
  const baseName = facts.base?.name;
  const byId = new Map(sessions.map((s) => [s.id, s]));

  const wtFor = (path, branch) => worktrees.find((w) => samePath(w.path, path))
    ?? (branch ? worktrees.find((w) => w.branch === branch) : undefined) ?? null;
  const wtState = (w) => (!w ? null : w.missing ? 'missing' : w.prunable ? 'prunable' : 'present');
  const prFor = (src, branch) => prs.find((p) => (src?.prNumber && p.number === src.prNumber && (!src.repo || p.repo === src.repo)))
    ?? prs.find((p) => !p.isCrossRepository && p.headRef === branch) ?? null;

  const items = [];
  const claimedBranches = new Set();
  for (const s of sessions) {
    const branch = s.source?.branch ?? null;
    if (branch) claimedBranches.add(branch);
    const b = branch ? branchByName.get(branch) : undefined;
    const pr = prFor(s.source, branch);
    const observedOid = s.source?.kind === 'pr' && pr ? pr.headOid : b?.oid ?? null;
    const tipObserved = Boolean(facts.branches?.queried) && (s.source?.kind !== 'pr' || Boolean(facts.prs?.queried));
    const branchGone = tipObserved && !b && !pr;
    const wt = wtFor(s.worktree, branch);
    const live = liveness(s, { now: nowMs, leaseMs, tipCommitAt: b?.tipTime ?? null, skewMs });
    const done = deriveDone(s, trains, { observedOid, branchGone, tipObserved });
    const state = done.done ? 'done' : s.state;
    const notes = [];
    if (done.note) notes.push(done.note);
    if (live.futureDatedTipIgnored) notes.push('future-dated commit ignored');
    if (done.done && s.state !== 'done') notes.push(`derived done (landed in ${done.trainId})`);
    let display = state;
    if (state === 'ready') {
      if (s.ready?.oid && observedOid && s.ready.oid !== observedOid) display = 'ready (stale — head moved)';
      else if (!tipObserved) notes.push('ready oid not verifiable (tip not observed)');
    }
    if (!isTerminalState(state) && !live.live) { display = `${display} · stale`; }
    if (wt && wtState(wt) === 'missing') notes.push('worktree directory missing');
    if (s.source?.kind === 'pr' && !b && !pr && tipObserved) notes.push('remote-only — not landable by fleet');
    items.push({
      id: s.id, tracked: true, kind: s.source?.kind ?? 'branch', branch, oid: observedOid,
      worktree: s.worktree ?? wt?.path ?? null, worktreeState: wtState(wt), intent: s.intent, paths: s.paths ?? [],
      state, display, live: live.live, liveReason: live.reason, stale: !isTerminalState(state) && !live.live,
      gen: s.gen, rev: s.rev, ready: s.ready ?? null, readyStale: display.startsWith('ready (stale'),
      ahead: b?.ahead ?? null, behind: b?.behind ?? null, pr, notes,
      waitingOn: (s.waitingOn ?? []).map((w) => waitingView(w, { byId, trains })),
      overlaps: [], hotOverlaps: [], duplicates: [], findings: [],
    });
  }

  // Untracked: branches ahead of base and worktrees with no session.
  for (const b of branchList) {
    if (claimedBranches.has(b.name) || b.name === baseName) continue;
    const wt = worktrees.find((w) => w.branch === b.name) ?? null;
    if (!(b.ahead > 0) && !wt) continue;
    claimedBranches.add(b.name);
    const pr = prFor(null, b.name);
    const live = liveness({ state: 'working', leaseExpiresAt: null }, { now: nowMs, leaseMs, tipCommitAt: b.tipTime, skewMs });
    items.push({
      id: b.name, tracked: false, kind: 'branch', branch: b.name, oid: b.oid, worktree: wt?.path ?? null, worktreeState: wtState(wt),
      intent: null, paths: [], state: 'untracked', display: 'untracked', live: live.live, liveReason: live.reason, stale: false, tipTime: b.tipTime ?? null,
      worktreeClean: wt ? (facts.worktreeClean?.[wt.path] ?? null) : null,
      gen: null, rev: null, ready: null, readyStale: false, ahead: b.ahead, behind: b.behind, pr,
      notes: live.futureDatedTipIgnored ? ['future-dated commit ignored'] : [], waitingOn: [], overlaps: [], hotOverlaps: [], duplicates: [], findings: [],
    });
  }
  for (const w of worktrees) {
    if (w.bare || w.branch || items.some((i) => samePath(i.worktree, w.path))) continue;
    if (samePath(w.path, worktrees[0]?.path)) continue; // the main checkout itself
    items.push({
      id: w.path, tracked: false, kind: 'worktree', branch: null, oid: w.head, worktree: w.path, worktreeState: wtState(w),
      intent: null, paths: [], state: 'untracked', display: 'untracked (detached worktree)', live: false, liveReason: 'stale', stale: false,
      gen: null, rev: null, ready: null, readyStale: false, ahead: null, behind: null, pr: null, notes: [], waitingOn: [],
      overlaps: [], hotOverlaps: [], duplicates: [], findings: [],
    });
  }
  // Open PRs with no local counterpart: shown, never dropped.
  for (const p of prs) {
    if (items.some((i) => i.pr?.number === p.number)) continue;
    items.push({
      id: `#${p.number}`, tracked: false, kind: 'remote-only', branch: p.headRef, oid: p.headOid, worktree: null, worktreeState: null,
      intent: p.title, paths: [], state: 'remote-only', display: 'remote-only — not landable by fleet', live: false, liveReason: 'stale',
      stale: false, gen: null, rev: null, ready: null, readyStale: false, ahead: null, behind: null, pr: p,
      notes: [], waitingOn: [], overlaps: [], hotOverlaps: [], duplicates: [], findings: [],
    });
  }

  // Overlaps among non-terminal local items: shared changed files, or declared paths. Evidence made
  // only of `hotFiles` goes to `hotOverlaps` (disclosed, not counted as a conflict anywhere).
  const hotFiles = facts.hotFiles ?? [];
  const active = items.filter((i) => i.branch && i.kind !== 'remote-only' && !isTerminalState(i.state));
  const changedOf = (i) => (facts.changed?.[i.branch]?.queried ? facts.changed[i.branch].files ?? [] : []);
  for (let x = 0; x < active.length; x += 1) {
    for (let y = x + 1; y < active.length; y += 1) {
      const a = active[x]; const b = active[y];
      const via = [];
      const setB = new Set(changedOf(b));
      const { real: files, hot: hotShared } = splitHotFiles(changedOf(a).filter((f) => setB.has(f)), hotFiles);
      if (files.length) via.push('files');
      const hot = new Set(hotShared);
      let declared = false;
      for (const pa of a.paths) {
        for (const pb of b.paths) {
          if (patternsIntersect(pa, pb) === 'disjoint') continue;
          const lit = hotLiteralOf(pa, pb, hotFiles);
          if (lit) hot.add(lit); else declared = true;
        }
      }
      if (declared) via.push('paths');
      if (hot.size) {
        const hf = [...hot].slice(0, 5);
        a.hotOverlaps.push({ with: b.id, files: hf });
        b.hotOverlaps.push({ with: a.id, files: hf });
      }
      if (!via.length) continue;
      const sa = byId.get(a.id); const sb = byId.get(b.id);
      const known = (sa?.knownOverlaps ?? []).some((k) => k.with === b.id) || (sb?.knownOverlaps ?? []).some((k) => k.with === a.id);
      a.overlaps.push({ with: b.id, via, files: files.slice(0, 5), known });
      b.overlaps.push({ with: a.id, via, files: files.slice(0, 5), known });
    }
  }
  const dupGroups = duplicatePatches(active.map((i) => ({ id: i.id, patchId: facts.patchIds?.[i.branch]?.patchId ?? null })));
  for (const g of dupGroups) for (const id of g.ids) items.find((i) => i.id === id).duplicates = g.ids.filter((o) => o !== id);
  for (const f of facts.findings ?? []) for (const id of f.sessions ?? []) {
    const it = items.find((i) => i.id === id); if (it) it.findings.push(f);
  }

  const landable = items.filter((i) => i.tracked && !isTerminalState(i.state));
  const { order, cycles } = proposeLandingOrder(landable.map((i) => ({
    id: i.id, ready: i.state === 'ready' && !i.readyStale && Boolean(i.ready),
    overlapCount: i.overlaps.filter((o) => !o.known).length, readyAt: i.ready?.at ?? null, waitingOn: i.waitingOn,
  })));
  const rank = new Map(order.map((id, n) => [id, n]));
  items.sort((a, b) => {
    const ha = a.waitingOn.some((w) => w.kind === 'human') ? 0 : 1;
    const hb = b.waitingOn.some((w) => w.kind === 'human') ? 0 : 1;
    if (ha !== hb) return ha - hb;
    const ra = rank.get(a.id) ?? 1e9; const rb = rank.get(b.id) ?? 1e9;
    if (ra !== rb) return ra - rb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return {
    observedAt: new Date(nowMs).toISOString(),
    base: { name: baseName, freshness: facts.base?.freshness ?? null, measure: facts.base?.measure ?? null },
    registry: { complete: facts.registry?.complete !== false, invalid: facts.registry?.invalid ?? [] },
    sources: {
      worktrees: { queried: Boolean(facts.worktrees?.queried), reason: facts.worktrees?.reason },
      branches: { queried: Boolean(facts.branches?.queried), partial: Boolean(facts.branches?.partial), reason: facts.branches?.reason },
      // `complete:false` = queried but possibly truncated/partly malformed; never read as a full list.
      prs: { queried: Boolean(facts.prs?.queried), complete: Boolean(facts.prs?.queried) && facts.prs?.complete !== false, limit: facts.prs?.limit, reason: facts.prs?.reason, ...(facts.prs?.fields ? { fields: facts.prs.fields } : {}) },
    },
    hold: facts.hold ?? null,
    items,
    landingOrder: order.filter((id) => { const i = items.find((x) => x.id === id); return i?.state === 'ready' && !i.readyStale; }),
    cycles,
    duplicates: dupGroups,
    trains: trains.filter((t) => !['landed', 'abandoned'].includes(t.phase)).map((t) => ({ trainId: t.trainId, phase: t.phase, result: t.result ?? null })),
  };
}

// ── The default view's hiding rule ──────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** `.fleet.json` `hideIdleAfterDays` default: an untracked branch with no commit for this long reads as abandoned. */
export const DEFAULT_IDLE_DAYS = 14;

/** The idle window in ms from a resolved config (`hideIdleAfterDays`, else the default). */
export const idleMsFrom = (config) => (config?.hideIdleAfterDays ?? DEFAULT_IDLE_DAYS) * DAY_MS;

/**
 * Is a branch tip older than the idle window? Every unknown answers false: a
 * missing tip time or clock, a non-positive window, and a FUTURE-dated tip (the
 * age is negative) all keep the branch visible.
 */
export function isIdleTip(tipTime, now, idleMs) {
  const tip = toMs(tipTime); const n = toMs(now);
  return tip !== null && n !== null && Number.isFinite(idleMs) && idleMs > 0 && n - tip > idleMs;
}

/**
 * Why the DEFAULT `fleet status` view may hide an item — `'merged'`, `'idle'` —
 * or null when it must stay visible. Only on sufficient evidence; every unknown
 * keeps the item visible. Common to both reasons:
 *   - untracked (no registration), a local branch (never a detached worktree or a
 *     remote-only PR);
 *   - no open PR, AND the PR lookup was complete (`pr === null` only means "no
 *     open PR" when the list was queried and not truncated);
 *   - an attached worktree must be provably CLEAN (`worktreeClean === true`):
 *     neither containment nor an old tip says nobody is editing it.
 * Then either:
 *   - `merged`: `ahead === 0` — the tip is contained in base (`null` = counts
 *     unavailable = not hidden);
 *   - `idle`: ahead count KNOWN and the tip commit older than `idleMs`
 *     (squash-merged or abandoned work still reads as ahead). A tip time that is
 *     missing or future-dated is not idle.
 * @param {object} item a status item
 * @param {{prsComplete: boolean, now?: number|string|Date|null, idleMs?: number}} ctx
 * @returns {'merged'|'idle'|null}
 */
export function hideReason(item, { prsComplete, now = null, idleMs = DEFAULT_IDLE_DAYS * DAY_MS }) {
  if (!(item.tracked === false && item.kind === 'branch' && item.pr === null && prsComplete === true)) return null;
  if (!(item.worktree === null || item.worktreeClean === true)) return null;
  if (item.ahead === 0) return 'merged';
  if (Number.isInteger(item.ahead) && isIdleTip(item.tipTime, now, idleMs)) return 'idle';
  return null;
}

/** Back-compatible boolean form of `hideReason`. */
export function isStaleUntracked(item, ctx) { return hideReason(item, ctx) !== null; }

/**
 * The `status` verb's presentation boundary: split a COMPLETE `buildStatus`
 * result into the visible items and what the default view hides. `buildStatus`
 * itself stays complete (land and train-approve depend on that), and the input is
 * never mutated. An IDLE hidden branch is ahead of base, so it can overlap a
 * visible item: on the visible copy those overlaps (and hot overlaps) are folded
 * into `overlapsWithHidden` (ids), rendered as one count line, never dropped.
 * @param {ReturnType<typeof buildStatus>} status
 * @param {{all?: boolean, idleMs?: number}} [opts]
 * @returns {{items: object[], hidden: {count: number, ids: string[], unchecked: number, merged: number, idle: number, idleDays: number}}}
 */
export function splitHidden(status, { all = false, idleMs = DEFAULT_IDLE_DAYS * DAY_MS } = {}) {
  const ctx = { prsComplete: status.sources?.prs?.complete === true, now: status.observedAt ?? null, idleMs };
  const idleDays = Math.round((idleMs / DAY_MS) * 100) / 100;
  // Candidates that would be hidden but for an attached worktree of unknown cleanliness: visible, and counted.
  const unchecked = status.items.filter((i) => i.worktree !== null && i.worktreeClean === null
    && hideReason({ ...i, worktreeClean: true }, ctx) !== null).length;
  if (all) return { items: status.items, hidden: { count: 0, ids: [], unchecked, merged: 0, idle: 0, idleDays } };
  const reasons = new Map();
  for (const i of status.items) { const r = hideReason(i, ctx); if (r) reasons.set(i.id, r); }
  const items = status.items.filter((i) => !reasons.has(i.id)).map((i) => {
    const toHidden = (i.overlaps ?? []).filter((o) => reasons.has(o.with));
    const hotToHidden = (i.hotOverlaps ?? []).filter((o) => reasons.has(o.with));
    if (!toHidden.length && !hotToHidden.length) return i;
    return {
      ...i,
      overlaps: i.overlaps.filter((o) => !reasons.has(o.with)),
      hotOverlaps: i.hotOverlaps.filter((o) => !reasons.has(o.with)),
      overlapsWithHidden: [...new Set([...toHidden, ...hotToHidden].map((o) => o.with))],
    };
  });
  const ids = [...reasons.keys()];
  const count = (r) => ids.filter((id) => reasons.get(id) === r).length;
  return { items, hidden: { count: ids.length, ids, unchecked, merged: count('merged'), idle: count('idle'), idleDays } };
}
