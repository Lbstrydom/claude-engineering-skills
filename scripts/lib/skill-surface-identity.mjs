/**
 * @fileoverview The single oracle for "is this skill name, present in two
 * discovered roots, actually a problem?" — plus the reader and the vocabulary
 * that question needs.
 *
 * ## Why this is a library and not part of a CLI
 *
 * Three enforcement points ask this question, at three different moments:
 *
 *   1. `check-stale-skill-surface.mjs`     — source-repo CLI, on demand.
 *   2. `sync-to-repos.mjs`                 — as the sync writes into a consumer.
 *   3. `sync-isolation-verify.mjs` gate 8  — consumer-side, continuously.
 *
 * (3) is SYNCED to consumers and may import only from its own `lib/` siblings,
 * while (1) is a source-repo CLI that is deliberately not shipped. That boundary
 * is *why* gate 8 grew its own copy of the predicate: it could not reach the one
 * living in the CLI. Two implementations of one rule agreed only by luck, and
 * nothing kept them agreeing. Putting the rule in `lib/` is what lets all three
 * share it — the same reason `sensitive-paths.mjs` is a library rather than a
 * copy per caller.
 *
 * ## The rule
 *
 * A name present in a shadowing root is classified by IDENTITY first, and only
 * then by ownership:
 *
 *   aliased  — resolves to the SAME directory as the live copy. One directory
 *              with two names is not a collision, whoever owns it.
 *   shadowed — a different directory, and a name THIS BUNDLE deploys. Fatal:
 *              precedence between discovered roots is undefined, so the fresh
 *              copy this sync just wrote may be unreachable.
 *   orphan   — a different directory, and a name we do not deploy. Never fatal;
 *              `classifyOrphans` then says which KIND it is, because "orphan"
 *              covers three situations that want opposite advice.
 *
 * Ordering is the invariant. Identity is a fact about the filesystem; ownership
 * is a fact about the bundle. Ask the bundle question first and the filesystem
 * fact becomes unrepresentable — which is precisely the bug this module was
 * extracted while fixing. Pinned on both branches by
 * `tests/shadow-gate-ownership.test.mjs`.
 *
 * @module scripts/lib/skill-surface-identity
 */

import fs from 'node:fs';
import path from 'node:path';

/** The deprecated surface, and the live one it shadows. */
export const STALE_SURFACE = '.github/skills';
export const LIVE_SURFACE = '.claude/skills';

/** `<repo>/.agents/skills/` — retired 2026-07-30, and a discovered root too. */
export const AGENTS_SURFACE = '.agents/skills';

/**
 * Skill names the `skills` CLI (skills.sh) manages in this repo, read from its
 * own `skills-lock.json`.
 *
 * That tool treats `.agents/skills/` as CANONICAL and fans copies out to every
 * agent root a skill was added for, so a name in both `.agents/skills/` and
 * `.claude/skills/` is it working correctly — not an ambiguity to resolve.
 *
 * Absent / unreadable / malformed → empty set, so a repo without the tool
 * behaves exactly as before and every name still gets the precedence warning.
 * Fail-open is right here: this only ever *downgrades* an advisory note, never
 * suppresses a gated finding (those are `shadowed`, handled above).
 */
function readSkillsLockNames(repoRoot) {
  try {
    const raw = fs.readFileSync(path.join(repoRoot, 'skills-lock.json'), 'utf-8');
    return new Set(Object.keys(JSON.parse(raw).skills || {}));
  } catch { return new Set(); }
}

/**
 * Every workspace root that can shadow `LIVE_SURFACE`.
 *
 * Both are read by VS Code Copilot's Agent Skills alongside `.claude/skills/`,
 * and precedence between roots is **not documented** — so a name in either one
 * makes the live copy's resolution undefined, not merely redundant.
 *
 * `.agents/skills` joined the list when the `agents` install surface was retired
 * (docs/reference/skill-surface-ownership.md §3). It was found live in a consumer
 * the same day: a stale `ship/SKILL.md` there against the synced `.claude/skills/ship`.
 *
 * ## Ownership is the whole predicate
 *
 * A name here is only OUR problem when it collides with a skill this bundle
 * deploys. Consumers legitimately keep their own skills in `.agents/skills/` —
 * one carries `supabase-postgres-best-practices` and `use-railway` from unrelated
 * plugins — and failing on those would be a gate about someone else's content
 * that no one can act on, which is how a gate earns a permanent `--no-verify`.
 * Ownership comes from `ourBundleSkillNames()` — this bundle's own `skills/`
 * directory — NOT from whatever sits in the target's `.claude/skills/`, which in a
 * consumer also holds their skills. A non-bundle name is an `orphan` (advisory),
 * never a `shadowed` (fatal).
 *
 * And a name that resolves to the SAME directory in both roots is `aliased`, not
 * shadowed: a consumer's plugin legitimately keeps a skill in `.agents/skills/<n>`
 * and exposes it as `.claude/skills/<n>` via a symlink, so both roots read one
 * file and precedence is moot. Verified in a consumer 2026-07-30.
 */
export const SHADOWING_SURFACES = Object.freeze([STALE_SURFACE, AGENTS_SURFACE]);

/**
 * Read a surface's skill-directory names. `docs/plans/refactor-skill-governance.md`
 * round-2 M1: exported (was a private `listSkillDirs`) so `sync-to-repos.mjs`
 * shares this exact reader instead of re-deriving its own — and given a richer
 * contract than before: no `fs.existsSync` pre-check, because `existsSync`
 * swallows EVERY stat error (not just "doesn't exist") and returns `false` for
 * an EACCES-unreadable directory exactly the same as a genuinely-absent one —
 * that would silently misreport an unreadable surface as clean. `readdirSync`
 * runs directly in a try/catch: `ENOENT` is the absent/clean case; ANY other
 * `err.code` (`EACCES`, `EPERM`, `ENOTDIR` for a stray non-directory path at
 * the surface location, or anything else) is `readable: false` — never
 * silently "no shadow."
 *
 * **Audit-code round-3 M1 (real bug, fixed)**: an `ENOENT` on
 * `<root>/<surface>` was unconditionally treated as "surface legitimately
 * absent, clean" — but that same `ENOENT` also fires when `root` ITSELF
 * doesn't exist (e.g. a typo'd `--repo` path), which is a fundamentally
 * different, actionable error this contract should never mask as "nothing
 * can shadow." Fixed: an `ENOENT` now checks whether `root` exists first.
 *
 * **Gemini gate shadow finding #2 (real bug, fixed)**: the round-3 fix
 * above used `fs.existsSync(root)` for that root check — reintroducing, in
 * this very function's own body, the exact `existsSync` EACCES-swallowing
 * defect this whole reader exists to eliminate. A `root` that exists but is
 * unreadable would have `existsSync` report `false`, misclassifying a real
 * permissions problem as "repository root does not exist." Fixed: probes
 * `root` with `lstatSync` in its own try/catch (same pattern as
 * `regenerate-skill-copies.mjs`'s `removeStaleGithubSkills`) — `ENOENT`
 * means genuinely absent; any other code (`EACCES`, etc.) is reported
 * accurately as its own error, not relabeled as "does not exist."
 *
 * @param {string} root
 * @param {string} surface
 * @returns {{names: string[], readable: true} | {names: null, readable: false, error: {code: string, message: string, path: string}}}
 */
export function listSurfaceNames(root, surface) {
  const base = path.join(root, ...surface.split('/'));
  try {
    const names = fs.readdirSync(base, { withFileTypes: true })
      // A SYMLINK to a directory is a skill directory. `Dirent.isDirectory()` is
      // false for a link, so the original filter silently dropped them — and that
      // was a false-green in this very gate: a plugin (or anyone) that exposes a
      // skill via a symlink made the name invisible to `liveNames`, so a real
      // shadow of one of OUR skills would have been misclassified as a harmless
      // `orphan` and the gate would have passed. Found live in a consumer whose
      // plugin skills are symlinks (2026-07-30).
      //
      // `statSync` follows the link, so a DANGLING link is correctly excluded —
      // it is not a readable skill directory by any definition.
      .filter((e) => {
        if (e.isDirectory()) return true;
        if (!e.isSymbolicLink()) return false;
        try { return fs.statSync(path.join(base, e.name)).isDirectory(); } catch { return false; }
      })
      .map(e => e.name)
      .sort();
    return { names, readable: true };
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        fs.lstatSync(root);
      } catch (rootErr) {
        if (rootErr.code === 'ENOENT') {
          return { names: null, readable: false, error: { code: 'ENOENT', message: `repository root does not exist: ${root}`, path: root } };
        }
        return { names: null, readable: false, error: { code: rootErr.code, message: rootErr.message, path: root } };
      }
      return { names: [], readable: true };
    }
    return { names: null, readable: false, error: { code: err.code, message: err.message, path: base } };
  }
}

/**
 * Compare the two surfaces. PURE apart from the two directory reads it is
 * handed — callers pass already-read content so this is unit-testable.
 *
 * A skill present in BOTH surfaces is a `shadowed` collision: Copilot resolves
 * `.github/skills` first, so the live copy is unreachable for that name. A
 * skill present ONLY in the stale surface is `orphan` — it does not shadow
 * anything, but it is still a deprecated copy that can drift into a collision
 * the moment a skill of that name is added.
 *
 * @param {{staleNames: string[], liveNames: string[], contentOf: (surface: string, name: string) => string|null}} a
 * @returns {{shadowed: object[], orphans: string[], total: number}}
 */
export function compareSkillSurfaces({ staleNames, liveNames, contentOf, realPathOf = null }) {
  const live = new Set(liveNames);
  const shadowed = [];
  const orphans = [];
  const aliased = [];
  for (const name of staleNames) {
    // IDENTITY FIRST, OWNERSHIP SECOND. TWO NAMES FOR ONE DIRECTORY IS NOT A
    // COLLISION — of any kind, owned or not.
    //
    // A consumer's plugin legitimately stores a skill in `.agents/skills/<n>` and
    // exposes it as `.claude/skills/<n>` via a symlink — verified in a consumer
    // 2026-07-30, where `realpath` of both was byte-identical. Whichever root the
    // agent reads, it gets the same file, so precedence is irrelevant. Flagging
    // that as a shadow would fail a repo for correct plugin wiring, which is how a
    // gate earns a permanent `--no-verify`.
    //
    // **This check used to sit BELOW the ownership test, which made it
    // unreachable for the only case it was written for** (found 2026-08-10, in
    // the same consumer the paragraph above cites). `liveNames` carries
    // OWNERSHIP — what this bundle deploys — so a plugin's aliased skill is by
    // construction a name we do not own, took the `orphan` branch, and never
    // reached a `realpath` call. Both of that consumer's aliased plugin skills
    // were reported as an unresolved ambiguity on every single sync, with the
    // operator told that precedence was "undefined and yours to resolve" about
    // ONE directory.
    //
    // Identity is a fact about the filesystem; ownership is a fact about the
    // bundle. Ask the bundle question first and the filesystem fact becomes
    // unrepresentable. Ordering IS the invariant here, so it is pinned by
    // `tests/shadow-gate-ownership.test.mjs` on both branches — a foreign alias
    // must be `aliased`, and a foreign non-alias must stay an `orphan`.
    //
    // `realPathOf` stays injectable for the pure unit tests, and every
    // production call site is required to supply one (same test file) — a
    // caller without a resolver cannot tell an alias from a collision, and
    // silently reports the alias as the collision.
    if (realPathOf) {
      const a = realPathOf('stale', name);
      const b = realPathOf('live', name);
      if (a && b && a === b) { aliased.push(name); continue; }
    }
    if (!live.has(name)) { orphans.push(name); continue; }
    const staleBody = contentOf(STALE_SURFACE, name);
    const liveBody = contentOf(LIVE_SURFACE, name);
    const staleLines = staleBody === null ? 0 : staleBody.split('\n').length;
    const liveLines = liveBody === null ? 0 : liveBody.split('\n').length;
    shadowed.push({
      name,
      staleLines,
      liveLines,
      identical: staleBody !== null && staleBody === liveBody,
      lineDelta: liveLines - staleLines,
    });
  }
  return { shadowed, orphans, aliased, total: staleNames.length };
}

/**
 * Say what KIND of orphan each name is, so no caller has to guess — and so the
 * three enforcement points cannot drift into giving different advice about one
 * directory.
 *
 * An orphan is a name in a shadowing root that this bundle does not deploy. That
 * is not one situation, it is three, and they want opposite advice:
 *
 *   toolManaged  — `skills-lock.json` claims it. The `skills` CLI (skills.sh)
 *                  treats `.agents/skills/` as CANONICAL and fans a copy out to
 *                  every agent root the skill was added for. Separate
 *                  directories, so identity cannot clear them — only the
 *                  lockfile can. Measured 2026-08-09: an operator followed a
 *                  "resolve this" note, deleted a copy, and the tool restored
 *                  it. Advising deletion here removes multi-agent access.
 *   contested    — nothing claims it and it IS a separate directory in the live
 *                  root. A real undefined-precedence ambiguity, in their repo,
 *                  over their own skill. Worth naming; never ours to gate.
 *   theirs       — nothing claims it and there is no live counterpart at all.
 *                  Simply a skill they keep elsewhere. Claim nothing.
 *   undetermined — the live root could not be read, so contested-vs-theirs is
 *                  genuinely unknown. Degrade to the conditional wording rather
 *                  than assert either. The one case where a hedge is accurate.
 *
 * @param {{orphans: string[], root: string, liveNames: Set<string>|null}} a
 *   `liveNames` is the ON-DISK live surface (null when unreadable) — NOT the
 *   ownership set, which by definition contains none of these names.
 * @returns {{toolManaged: string[], contested: string[], theirs: string[], undetermined: string[]}}
 */
export function classifyOrphans({ orphans, root, liveNames }) {
  const managed = readSkillsLockNames(root);
  const out = { toolManaged: [], contested: [], theirs: [], undetermined: [] };
  for (const name of orphans) {
    if (managed.has(name)) { out.toolManaged.push(name); continue; }
    if (liveNames === null) { out.undetermined.push(name); continue; }
    if (liveNames.has(name)) out.contested.push(name);
    else out.theirs.push(name);
  }
  return out;
}
