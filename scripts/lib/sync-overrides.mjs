/**
 * @fileoverview `.sync-overrides.json` — the consumer's half of the ownership
 * contract.
 *
 * ## Why this exists
 *
 * Every synced tooling file carries an `⚠ UPSTREAM-OWNED — DO NOT EDIT HERE`
 * banner, so the project already had a way to say *"this file is ours, not
 * yours"*. It had no way to say the opposite. `sourceDirty` records dirt on the
 * SOURCE side; nothing recorded deliberate divergence on the CONSUMER side, and
 * that asymmetry is the root cause of upstream report `5b1a121e` — a consumer
 * re-fixing the same files after every sync, forever.
 *
 * This file is that missing declaration. It lives at the consumer's repo root,
 * it is COMMITTED (unlike the gitignored manifest), and it is the only thing in
 * the loop that can make a consumer's divergence outlive a sync.
 *
 * ## The contract
 *
 * ```json
 * {
 *   "version": 1,
 *   "overrides": [
 *     { "path": ".vscode/mcp.json", "reason": "supply-chain gate requires pinned local paths" },
 *     { "glob": ".claude/skills/&#42;/SKILL.md", "reason": "condensed preflight block; upstream report 5b1a121e" }
 *   ],
 *   "gitignoreExtra": [
 *     { "pattern": ".audit-loop/cache/", "reason": "runtime cache, not tracked here" }
 *   ],
 *   "syncOptIn": [
 *     { "feature": "root-mcp-json", "reason": "we pin @playwright/mcp and want the root .mcp.json wired to it" }
 *   ],
 *   "blocks": [
 *     { "path": ".claude/skills/nav-audit/SKILL.md", "slot": "target-adapter",
 *       "from": ".sync-blocks/nav-audit.target-adapter.md", "reason": "no HTTP surface: use the repo's own driver" }
 *   ]
 * }
 * ```
 *
 * `reason` is REQUIRED on every entry and a malformed file ABORTS the target.
 * Both are deliberate. An override is a standing decision to stop receiving
 * upstream fixes for a path; a reasonless one is indistinguishable from a
 * forgotten one a year later, and a fail-OPEN parse would silently resume the
 * clobbering this file exists to stop — the worst possible failure mode for a
 * guard whose whole job is to be believed.
 *
 * ## What happens when an overridden file also changes upstream
 *
 * The write is held and the sync says so, every run — and when the upstream
 * bytes have MOVED since the base the consumer forked from, it says that too,
 * with both shas. An override freezes a path; it must never quietly freeze the
 * consumer's knowledge that upstream moved on. `.sync-receipt.json` carries the
 * same fact in committed form so CI can fail on a stale override if the
 * consumer wants it to.
 *
 * ## What may not be overridden
 *
 * Nothing under `scripts/.claude-skills/`. That tree is upstream-owned by
 * governance (AGENTS.md §"Upstream-owned — never patch the synced copy"): a
 * local fix there is invisible to review, lost on the next sync, and leaves the
 * bug live for every other consumer. Letting an override MAKE that edit durable
 * would convert the one governance rule the banner enforces into an opt-out.
 * The refusal names `cross-skill.mjs upstream report` instead, which is the
 * sanctioned path.
 *
 * ## Block holds (`blocks`)
 *
 * A whole-file override freezes every upstream fix to keep one inserted block.
 * A block hold keeps ONLY the block: upstream declares a named slot in its own
 * source (`lib/sync-slots.mjs`), the consumer names a committed fragment file,
 * and the sync splices the fragment's bytes into the slot on every run, so the
 * rest of the file keeps receiving upstream. Validation here is static; the
 * checks that need the target's inventory (`from` naming a managed file, a
 * declaration whose path the target never receives) are the pure helpers at the
 * end of this module, called by the sync once that inventory is known.
 * Plan: docs/plans/sync-skill-block-holds.md
 *
 * @module scripts/lib/sync-overrides
 */

import fs from 'node:fs';
import path from 'node:path';

import { createHash } from 'node:crypto';

import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';
import { SYNC_RECEIPT_PATH } from './bundle-generated-stores.mjs';
import { SLOT_NAME_RE, normaliseFragment, SlotError } from './sync-slots.mjs';

/** Where the consumer declares its overrides, relative to the consumer root. */
export const OVERRIDES_PATH = '.sync-overrides.json';

/**
 * Features a consumer may switch ON (the inverse of an override: a file shipped to some consumers only). Each name is the
 * contract with `sync-mcp-optin.mjs`; an unknown one is an error, never a silent no-op.
 */
export const SYNC_OPT_IN_FEATURES = Object.freeze(['root-mcp-json']);

/** Paths an override may never claim — see the module header. */
const UNOVERRIDABLE_PREFIXES = [
  `${LAYOUT_CONSTANTS.CONSUMER_TOOLING_DIR}/`,
];

/** Paths whose override would break the sync's own bookkeeping. */
const UNOVERRIDABLE_EXACT = new Set([
  LAYOUT_CONSTANTS.MANIFEST_PATH,
  LAYOUT_CONSTANTS.IN_PROGRESS_JOURNAL,
]);

/**
 * May an override claim this (normalised) path at all?
 *
 * Asked of the DECLARATION at validation time and again of every concrete path
 * at match time. The validation-time check alone tests what a glob SAYS, not
 * what it MATCHES: the glob `**&#47;*.mjs` passes it, then held
 * `scripts/.claude-skills/cross-skill.mjs` (verified 2026-10-13) — making a local
 * edit to an upstream-owned file durable, the one thing this ban exists to stop.
 *
 * @param {string} p — POSIX, repo-relative
 * @returns {boolean}
 */
export function isUnoverridable(p) {
  return UNOVERRIDABLE_EXACT.has(p) || UNOVERRIDABLE_PREFIXES.some((prefix) => p.startsWith(prefix));
}

/**
 * Compile a glob to a RegExp over POSIX-separated repo-relative paths.
 *
 * Deliberately tiny: `*` matches within one segment, `**` crosses segments.
 * No brace expansion, no negation, no character classes. A consumer declaring a
 * standing exception to upstream fixes should be writing paths a reader can
 * verify by eye, and every operator this file has is one more way for the
 * declaration to mean something other than it looks like.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function compileGlob(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { out += '.*'; i++; } else { out += '[^/]*'; }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Normalise a consumer-authored path to the POSIX, repo-relative form the
 * manifest and the sync's destination keys use.
 *
 * Separator folding is load-bearing on Windows for exactly the reason
 * `validateAffectedPath` folds it in the upstream-report path: an operator who
 * pastes `.claude\skills\plan\SKILL.md` would otherwise write a correct-looking
 * override that silently matches nothing — a guard that reads as active and is
 * not, which is the failure class this whole change exists to remove.
 *
 * @param {string} p
 * @returns {string}
 */
export function normaliseOverridePath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

/**
 * Parse + validate an overrides document. PURE.
 *
 * Returns `errors` rather than throwing, so the caller can report ALL of a
 * consumer's mistakes in one run instead of making them fix one per sync.
 *
 * @param {unknown} raw — the parsed JSON value
 * @returns {{overrides: Array<{match: string, kind: 'path'|'glob', reason: string, test: RegExp}>,
 *            gitignoreExtra: Array<{pattern: string, reason: string}>,
 *            errors: string[]}}
 */
export function validateOverrides(raw) {
  const errors = [];
  const overrides = [];
  const gitignoreExtra = [];
  const syncOptIn = [];
  const blocks = [];

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides, gitignoreExtra, syncOptIn, blocks, errors: [`${OVERRIDES_PATH}: expected a JSON object at the top level`] };
  }
  if (raw.version !== 1) {
    errors.push(`${OVERRIDES_PATH}: "version" must be 1 (got ${JSON.stringify(raw.version)})`);
  }

  const entries = raw.overrides ?? [];
  if (!Array.isArray(entries)) {
    errors.push(`${OVERRIDES_PATH}: "overrides" must be an array`);
  } else {
    entries.forEach((entry, i) => {
      const at = `${OVERRIDES_PATH}: overrides[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      const hasPath = typeof entry.path === 'string' && entry.path.trim();
      const hasGlob = typeof entry.glob === 'string' && entry.glob.trim();
      if (hasPath && hasGlob) {
        errors.push(`${at}: declare exactly one of "path" or "glob", not both`);
        return;
      }
      if (!hasPath && !hasGlob) {
        errors.push(`${at}: needs a "path" or a "glob"`);
        return;
      }
      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      if (!reason) {
        errors.push(`${at}: "reason" is required — say why this path diverges, so the next reader can tell a decision from an accident`);
        return;
      }
      const kind = hasPath ? 'path' : 'glob';
      const match = normaliseOverridePath(hasPath ? entry.path : entry.glob);
      if (isUnoverridable(match)) {
        errors.push(
          `${at}: "${match}" may not be overridden — that tree is upstream-owned. `
          + 'A defect there is an UPSTREAM bug: report it with '
          + '`cross-skill.mjs upstream report --affected-path <path>` and fix it in '
          + 'claude-engineering-skills, so every consumer gets the fix.',
        );
        return;
      }
      overrides.push({
        match,
        kind,
        reason,
        test: kind === 'path' ? new RegExp(`^${match.replace(/[\\^$.|?*+()[\]{}]/g, '\\$&')}$`) : compileGlob(match),
      });
    });
  }

  const extras = raw.gitignoreExtra ?? [];
  if (!Array.isArray(extras)) {
    errors.push(`${OVERRIDES_PATH}: "gitignoreExtra" must be an array`);
  } else {
    extras.forEach((entry, i) => {
      const at = `${OVERRIDES_PATH}: gitignoreExtra[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${at}: expected an object`);
        return;
      }
      const pattern = typeof entry.pattern === 'string' ? entry.pattern.trim() : '';
      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      if (!pattern) { errors.push(`${at}: "pattern" is required`); return; }
      if (!reason) { errors.push(`${at}: "reason" is required`); return; }
      // A managed-block marker inside a declared pattern would produce a second
      // begin/end pair and put `updateManagedBlock` into its duplicate-block
      // abort on the NEXT sync — a corruption authored here but surfacing there.
      if (pattern.includes(LAYOUT_CONSTANTS.MARKER_BEGIN) || pattern.includes(LAYOUT_CONSTANTS.MARKER_END)) {
        errors.push(`${at}: a pattern may not contain a managed-block marker`);
        return;
      }
      if (pattern.includes('\n') || pattern.includes('\r')) {
        errors.push(`${at}: a pattern must be a single line`);
        return;
      }
      gitignoreExtra.push({ pattern, reason });
    });
  }

  const optIns = raw.syncOptIn ?? [];
  if (!Array.isArray(optIns)) {
    errors.push(`${OVERRIDES_PATH}: "syncOptIn" must be an array`);
  } else {
    optIns.forEach((entry, i) => {
      const at = `${OVERRIDES_PATH}: syncOptIn[${i}]`;
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${at}: expected an object`); return; }
      const feature = typeof entry.feature === 'string' ? entry.feature.trim() : '';
      const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
      if (!SYNC_OPT_IN_FEATURES.includes(feature)) {
        errors.push(`${at}: unknown feature ${JSON.stringify(entry.feature)} (known: ${SYNC_OPT_IN_FEATURES.join(', ')})`);
        return;
      }
      if (!reason) { errors.push(`${at}: "reason" is required`); return; }
      syncOptIn.push({ feature, reason });
    });
  }

  // Present-but-null is an ERROR, never "no blocks": a declaration nobody can read must not fail open (absent is fine).
  validateBlocks(Object.hasOwn(raw, 'blocks') ? raw.blocks : [], overrides, blocks, errors);

  return { overrides, gitignoreExtra, syncOptIn, blocks, errors };
}

/** A declared block's destination: exactly a synced SKILL.md (v1 scope, and what the upstream slot lint covers). */
const BLOCK_DEST_RE = new RegExp(`^${LAYOUT_CONSTANTS.SKILLS_DEST_PREFIX.replace(/[.]/g, '\\.')}[^/]+/SKILL\\.md$`);
/** A fragment path a reader can verify by eye, and that cannot close the HTML comment it is printed in. */
const SAFE_FROM_RE = /^[A-Za-z0-9._/-]+$/;
/** Per-path, per-generation consent to adopt a previously HELD file (plan Q4, condition e). */
export const ADOPTION_TOKEN_RE = /^sha256:[0-9a-f]{16}$/;

/**
 * Validate the `blocks` array into `out`, pushing every problem onto `errors`. PURE.
 *
 * @param {unknown} entries
 * @param {Array<{test: RegExp, match: string}>} overrides — the already-validated whole-file overrides
 * @param {Array<object>} out
 * @param {string[]} errors
 */
function validateBlocks(entries, overrides, out, errors) {
  if (!Array.isArray(entries)) { errors.push(`${OVERRIDES_PATH}: "blocks" must be an array`); return; }
  const seen = new Map();
  entries.forEach((entry, i) => {
    const at = `${OVERRIDES_PATH}: blocks[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${at}: expected an object`); return; }
    const p = normaliseOverridePath(typeof entry.path === 'string' ? entry.path.trim() : '');
    const slot = typeof entry.slot === 'string' ? entry.slot.trim() : '';
    const from = normaliseOverridePath(typeof entry.from === 'string' ? entry.from.trim() : '');
    const reason = typeof entry.reason === 'string' ? entry.reason.trim() : '';
    const problems = [];
    if (!BLOCK_DEST_RE.test(p)) problems.push(`"path" must be a synced ${LAYOUT_CONSTANTS.SKILLS_DEST_PREFIX}<skill>/SKILL.md (got ${JSON.stringify(entry.path)})`);
    if (!SLOT_NAME_RE.test(slot)) problems.push(`"slot" must match ${SLOT_NAME_RE} (got ${JSON.stringify(entry.slot)})`);
    const segments = from.split('/');
    if (!from || !SAFE_FROM_RE.test(from) || segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
      problems.push(`"from" must be a plain repo-relative path of [A-Za-z0-9._/-] with no empty, "." or ".." segment (got ${JSON.stringify(entry.from)})`);
    } else if (isUnoverridable(from) || from.startsWith(LAYOUT_CONSTANTS.SKILLS_DEST_PREFIX)
      || from === OVERRIDES_PATH || from === SYNC_RECEIPT_PATH || from === LAYOUT_CONSTANTS.OWNERSHIP_WATERMARK) {
      problems.push(`"from" may not name a file the sync writes or keeps as bookkeeping (${from}); keep fragments in your own tree, e.g. .sync-blocks/`);
    }
    if (!reason) problems.push('"reason" is required — say why this block exists, so the next reader can tell a decision from an accident');
    const token = entry.adoptHeldFile;
    if (token !== undefined && !(typeof token === 'string' && ADOPTION_TOKEN_RE.test(token))) {
      problems.push(`"adoptHeldFile" must be "sha256:" + 16 lowercase hex — the value the sync prints when it refuses to adopt a held file (got ${JSON.stringify(token)})`);
    }
    if (problems.length) { for (const msg of problems) errors.push(`${at}: ${msg}`); return; }
    const key = `${p}\u0000${slot}`;
    if (seen.has(key)) { errors.push(`${at}: slot "${slot}" on ${p} is already declared at blocks[${seen.get(key)}]`); return; }
    seen.set(key, i);
    const held = overrides.find((o) => o.test.test(p));
    if (held) {
      errors.push(`${at}: ${p} is also held whole-file by the override "${held.match}" — a hold would silently win; remove one of the two`);
      return;
    }
    out.push({ path: p, slot, from, reason, adoptHeldFile: typeof token === 'string' ? token : null, index: i });
  });
  // Consent is per FILE: every entry on one path that carries the token must carry the same one.
  const byPath = new Map();
  for (const b of out) {
    if (!b.adoptHeldFile) continue;
    if (!byPath.has(b.path)) byPath.set(b.path, new Set());
    byPath.get(b.path).add(b.adoptHeldFile);
  }
  for (const [p, tokens] of byPath) {
    if (tokens.size > 1) errors.push(`${OVERRIDES_PATH}: blocks on ${p} carry ${tokens.size} different "adoptHeldFile" values; they must agree`);
  }
}

/**
 * Read + validate the consumer's overrides file. IMPURE.
 *
 * An ABSENT file is the ordinary case and yields an empty, error-free result —
 * every consumer that has never needed an override. A file that exists but
 * cannot be read or parsed is an ERROR, never an empty result: those two states
 * are indistinguishable from the caller's side unless this distinction is made
 * here, and collapsing them would make a typo silently disable every override
 * the consumer thought it had.
 *
 * @param {string} repoRoot
 * @returns {{present: boolean, overrides: Array<object>, gitignoreExtra: Array<object>, errors: string[]}}
 */
export function loadOverrides(repoRoot) {
  const abs = path.join(repoRoot, OVERRIDES_PATH);
  if (!fs.existsSync(abs)) {
    return { present: false, overrides: [], gitignoreExtra: [], syncOptIn: [], blocks: [], errors: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    return {
      present: true,
      overrides: [],
      gitignoreExtra: [],
      syncOptIn: [],
      blocks: [],
      errors: [`${OVERRIDES_PATH}: unreadable or malformed JSON — ${err.message}`],
    };
  }
  return { present: true, ...validateOverrides(raw) };
}

/**
 * Which override, if any, claims this destination?
 *
 * First match wins, in declaration order, so a consumer can read the file
 * top-to-bottom and know which entry applies. An unoverridable path matches
 * nothing, whatever a glob says (see `isUnoverridable`) — so the writes and gc
 * share one answer: the tooling tree is never held.
 *
 * @param {string} dstRel — POSIX, repo-relative
 * @param {Array<{test: RegExp}>} overrides
 * @returns {object|null}
 */
export function matchOverride(dstRel, overrides) {
  const p = normaliseOverridePath(dstRel);
  if (isUnoverridable(p)) return null;
  for (const entry of overrides) {
    if (entry.test.test(p)) return entry;
  }
  return null;
}

/**
 * Render the consumer-declared gitignore patterns for inclusion in the managed
 * block, each preceded by its reason.
 *
 * The patterns go INSIDE the sync's own fence rather than beside it, because
 * the fence is rewritten wholesale on every sync: a consumer line outside it
 * survives but a consumer line inside it does not, and consumers have already
 * put lines inside it (that is how `.audit-loop/cache/` was lost). Making the
 * block `upstream ∪ declared` is the honest resolution — the fence stays
 * entirely sync-owned, and its CONTENT now has two declared sources.
 *
 * @param {Array<{pattern: string, reason: string}>} extras
 * @returns {string[]}
 */
export function renderGitignoreExtras(extras) {
  if (!extras.length) return [];
  // No leading blank separator: `updateManagedBlock` trims + drops empty lines,
  // so one would be silently discarded and read as a formatting bug here.
  const lines = [`# declared by this repo in ${OVERRIDES_PATH} (edit there, not here):`];
  for (const { pattern, reason } of extras) {
    lines.push(`# ${reason}`);
    lines.push(pattern);
  }
  return lines;
}

/**
 * Load every declared block's fragment. Reads go through the injected `read`
 * (the sync passes `readConsumerFile`: contained to the consumer root, a link
 * refused), so this module stays free of the write seam the verifier never needs.
 *
 * Every problem is an ERROR, never a skip: a declared block whose bytes cannot
 * be read must not render as "no block". The sync aborts the target on these,
 * the same severity as a malformed overrides file.
 *
 * @param {string} repoRoot
 * @param {Array<{path: string, slot: string, from: string, adoptHeldFile: string|null, index: number}>} blocks
 * @param {(root: string, rel: string) => {state: string, content?: string, reason?: string, message?: string}} read
 * @returns {{byDest: Map<string, Array<{slot: string, from: string, content: string, fragmentSha: string, adoptHeldFile: string|null}>>, errors: string[]}}
 */
export function loadBlockFragments(repoRoot, blocks, read) {
  const byDest = new Map();
  const errors = [];
  for (const b of blocks) {
    const r = read(repoRoot, b.from);
    if (r.state !== 'present') {
      const why = r.reason || r.message;
      errors.push(`${OVERRIDES_PATH}: blocks[${b.index}] fragment ${b.from} is ${r.state}${why ? ` (${why})` : ''} — a declared block that cannot be read is never treated as no block`);
      continue;
    }
    let content;
    try { content = normaliseFragment(r.content, { from: b.from }); } catch (err) {
      if (!(err instanceof SlotError)) throw err;
      errors.push(`${OVERRIDES_PATH}: blocks[${b.index}] ${err.message}`);
      continue;
    }
    const fragmentSha = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    if (!byDest.has(b.path)) byDest.set(b.path, []);
    byDest.get(b.path).push({ slot: b.slot, from: b.from, content, fragmentSha, adoptHeldFile: b.adoptHeldFile });
  }
  for (const list of byDest.values()) list.sort((x, y) => (x.slot < y.slot ? -1 : x.slot > y.slot ? 1 : 0));
  return { byDest, errors };
}

/**
 * A fragment source may never be a file the sync manages, under any alias or
 * case (plan Q1). Asked once the target's inventory is known, before any write. PURE.
 *
 * @param {Array<{from: string, index: number}>} blocks
 * @param {Iterable<string>} managedDests — this run's intended writes plus the prior manifest's keys
 * @returns {string[]} errors
 */
export function checkFragmentSources(blocks, managedDests) {
  const managed = new Set([...managedDests].map((d) => normaliseOverridePath(d).toLowerCase()));
  return blocks
    .filter((b) => managed.has(b.from.toLowerCase()))
    .map((b) => `${OVERRIDES_PATH}: blocks[${b.index}] "from" ${b.from} is a file the sync manages — a fragment must live in your own tree`);
}

/**
 * Every declared block path must have reached the renderer this run (plan Q3).
 * A path the target never receives is a typo, or a destination this consumer
 * does not get; one GC found retired upstream is held, and still reported. PURE.
 *
 * @param {Array<{path: string, slot: string, index: number}>} blocks
 * @param {{rendered: Set<string>, retired: Set<string>}} seen
 * @returns {Array<{path: string, slot: string, code: 'block-dest-unknown'|'block-dest-retired', message: string}>}
 */
export function reconcileBlockDestinations(blocks, { rendered, retired }) {
  const out = [];
  for (const b of blocks) {
    if (rendered.has(b.path)) continue;
    if (retired.has(b.path)) {
      out.push({ path: b.path, slot: b.slot, code: 'block-dest-retired',
        message: `blocks[${b.index}]: ${b.path} was retired upstream; the file and its block were kept. Remove the declaration, or move the block to the skill that replaced it` });
    } else {
      out.push({ path: b.path, slot: b.slot, code: 'block-dest-unknown',
        message: `blocks[${b.index}]: ${b.path} is not a file this sync delivers to this repo (a typo, or a skill it does not receive); nothing was spliced` });
    }
  }
  return out;
}
