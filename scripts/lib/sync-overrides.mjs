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
 * @module scripts/lib/sync-overrides
 */

import fs from 'node:fs';
import path from 'node:path';

import { LAYOUT_CONSTANTS } from './sync-path-map.mjs';

/** Where the consumer declares its overrides, relative to the consumer root. */
export const OVERRIDES_PATH = '.sync-overrides.json';

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

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { overrides, gitignoreExtra, errors: [`${OVERRIDES_PATH}: expected a JSON object at the top level`] };
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
      const banned = UNOVERRIDABLE_EXACT.has(match)
        || UNOVERRIDABLE_PREFIXES.some((p) => match.startsWith(p));
      if (banned) {
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

  return { overrides, gitignoreExtra, errors };
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
    return { present: false, overrides: [], gitignoreExtra: [], errors: [] };
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
  } catch (err) {
    return {
      present: true,
      overrides: [],
      gitignoreExtra: [],
      errors: [`${OVERRIDES_PATH}: unreadable or malformed JSON — ${err.message}`],
    };
  }
  return { present: true, ...validateOverrides(raw) };
}

/**
 * Which override, if any, claims this destination?
 *
 * First match wins, in declaration order, so a consumer can read the file
 * top-to-bottom and know which entry applies.
 *
 * @param {string} dstRel — POSIX, repo-relative
 * @param {Array<{test: RegExp}>} overrides
 * @returns {object|null}
 */
export function matchOverride(dstRel, overrides) {
  const p = normaliseOverridePath(dstRel);
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
