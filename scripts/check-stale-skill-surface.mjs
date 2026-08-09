#!/usr/bin/env node
/**
 * @fileoverview Detect a stale `.github/skills/` tree shadowing the live
 * `.claude/skills/` copies.
 *
 * WHY THIS EXISTS (field incident, 2026-07-19). VS Code Copilot's Agent Skills
 * discovers BOTH `.github/skills/` and `.claude/skills/`, and **`.github/skills/`
 * wins on a name collision**. `.github/skills/` was deprecated here in the
 * ai-context-sync work, so any surviving copy is by definition older than the
 * live one — and it silently takes precedence.
 *
 * That is not theoretical. A consumer repo was found carrying an untracked
 * `.github/skills/` tree of 9 stale skills. Its `ship/SKILL.md` was 220 lines
 * against the live 586, predated the cross-skill data loop entirely (zero
 * mentions of `ship_event`), and contained no helper invocations at all. The
 * reported symptom was "ship telemetry silently stopped recording"; the
 * reported cause was helper-path drift. Both were wrong — the rewriter works
 * fine. Telemetry never fired because in the shadowing copy **the step does not
 * exist**.
 *
 * The failure mode is the expensive one: everything looks installed, the live
 * copies are correct on disk, and the tool silently reads a different file.
 * `install-skills.mjs` already printed a deprecation notice, but only when
 * someone happened to run an install, and its text still claimed "no documented
 * tool reads it" — which stopped being true when Copilot shipped Agent Skills.
 *
 * Usage:
 *   node scripts/check-stale-skill-surface.mjs                 # report (exit 0)
 *   node scripts/check-stale-skill-surface.mjs --gate          # exit 1 on any shadow
 *   node scripts/check-stale-skill-surface.mjs --repo <path>   # check a consumer repo
 *   node scripts/check-stale-skill-surface.mjs --format json
 *
 * @module scripts/check-stale-skill-surface
 */

import fs from 'node:fs';
import path from 'node:path';

import { inspectLegacySurfaces, describeLegacySurfaces } from './lib/install/legacy-surfaces.mjs';

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

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
 * The skill names THIS BUNDLE owns, read from the source repo's authoritative
 * `skills/` directory.
 *
 * Ownership must not be inferred from `<target>/.claude/skills/` on disk. In the
 * source repo the two sets are identical, but in a consumer `.claude/skills/`
 * also holds the consumer's OWN skills — so an on-disk read would make this tool
 * gate a collision between two copies of THEIR content, which is exactly the
 * "policing someone else's repo" that earns a permanent `--no-verify`. The rule
 * is the same one gate 8 in `sync-isolation-verify.mjs` applies from the consumer
 * side (it derives ownership from the consumer's manifest): **fail only on a name
 * we deploy.**
 *
 * @returns {string[]|null} null when the source `skills/` tree is unreadable
 */
function ourBundleSkillNames() {
  const skillsDir = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'skills');
  try {
    return fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory()).map(e => e.name).sort();
  } catch {
    return null;
  }
}

function readSkillMd(root, surface, name) {
  const p = path.join(root, ...surface.split('/'), name, 'SKILL.md');
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
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
    if (!live.has(name)) { orphans.push(name); continue; }
    // TWO NAMES FOR ONE DIRECTORY IS NOT A COLLISION.
    //
    // A consumer's plugin legitimately stores a skill in `.agents/skills/<n>` and
    // exposes it as `.claude/skills/<n>` via a symlink — verified in a consumer
    // 2026-07-30, where `realpath` of both was byte-identical. Whichever root the
    // agent reads, it gets the same file, so precedence is irrelevant. Flagging
    // that as a shadow would fail a repo for correct plugin wiring, which is how a
    // gate earns a permanent `--no-verify`.
    //
    // Opt-in: callers that cannot resolve paths (the pure unit tests, the sync's
    // name-only inspection) pass no resolver and keep the old behaviour.
    if (realPathOf) {
      const a = realPathOf('stale', name);
      const b = realPathOf('live', name);
      if (a && b && a === b) { aliased.push(name); continue; }
    }
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
 * The blocking decision, extracted pure (testing-doctrine Tier 1). A shadowing
 * collision blocks; an orphan is advisory — it is a deprecated leftover, but it
 * is not currently intercepting anything.
 *
 * @param {{gate: boolean, shadowedCount: number}} a
 * @returns {0|1}
 */
export function decideStaleSurfaceExit({ gate, shadowedCount }) {
  if (!gate) return 0;
  return shadowedCount > 0 ? 1 : 0;
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const argv = process.argv.slice(2);
  const gate = argv.includes('--gate');
  const json = argv.includes('--format=json') ||
    (argv.includes('--format') && argv[argv.indexOf('--format') + 1] === 'json');
  const repoIdx = argv.indexOf('--repo');
  // Gemini gate wrongly_dismissed M3 (real bug, fixed) — this plan's own
  // round-1 dismissal of this exact concern cited section 1.4, which only
  // exempts install-skills.mjs's switch parser, not this file (actively
  // modified by this diff). A malformed `--repo` (no value, or the next
  // token is itself another flag) must not silently fall back to cwd — it
  // would report a false-clean result for the WRONG directory entirely.
  if (repoIdx >= 0 && (!argv[repoIdx + 1] || argv[repoIdx + 1].startsWith('--'))) {
    process.stderr.write(`${R}Error${X}: --repo requires a directory path${X}\n`);
    process.exit(2);
  }
  const root = repoIdx >= 0 ? path.resolve(argv[repoIdx + 1]) : process.cwd();

  // SANDBOX HONESTY (2026-07-20). The defect this check hunts is an UNTRACKED
  // `.github/skills/` tree — `git ls-files .github/skills` is empty by design,
  // and the incident that motivated this script was "an untracked tree of 9
  // stale skills" (see the fileoverview). Since 25436c8 the pre-push hook runs
  // `npm run check` inside a CLEAN CHECKOUT, which by construction contains no
  // untracked files — so in the sandbox this check is guaranteed to find
  // nothing and guaranteed to print "✓ nothing can shadow", a positive
  // verification claim it did not earn.
  //
  // No strictness flag can fix that: the input is architecturally absent, not
  // merely unprovisioned. The check has to run against the WORKING TREE, which
  // the hook now does before entering the sandbox. Here we only refuse to lie.
  // An explicit --repo means the caller aimed this at a specific tree on
  // purpose (the honest usage); never suppress that, sandbox or not.
  const repoOverride = repoIdx >= 0 && Boolean(argv[repoIdx + 1]);
  const inSandbox = process.env.AUDIT_PREPUSH_SANDBOX_ACTIVE === '1';
  if (inSandbox && !repoOverride) {
    const msg = `unverifiable in the pre-push sandbox — a clean checkout has no untracked files, ` +
      `so ${STALE_SURFACE}/ debris cannot exist here. The hook runs this against the working tree instead.`;
    if (json) {
      process.stdout.write(JSON.stringify({
        repo: root, staleSurface: STALE_SURFACE, liveSurface: LIVE_SURFACE,
        status: 'unverifiable', reason: 'clean-checkout-sandbox', exitCode: 0,
      }, null, 2) + '\n');
    } else {
      process.stderr.write(`${Y}○ stale skill surface: ${msg}${X}\n`);
    }
    process.exit(0);
  }

  // Advisory, before any exit path so it prints regardless of the verdict.
  reportRetiredSurfaces(root);

  const live = listSurfaceNames(root, LIVE_SURFACE);
  // Ownership comes from OUR bundle, not from what happens to sit in the target's
  // `.claude/skills/` — see ourBundleSkillNames. Falls back to the on-disk read
  // only if the source `skills/` tree is unreadable, which in this repo means
  // something is badly wrong; a narrower check is better than none.
  const ownedNames = ourBundleSkillNames() ?? live.names ?? [];
  // Every shadowing root, not just `.github/skills` — see SHADOWING_SURFACES.
  const reads = SHADOWING_SURFACES.map(surface => ({ surface, read: listSurfaceNames(root, surface) }));
  const stale = reads.find(r => r.surface === STALE_SURFACE).read;

  // An inspection failure on EITHER surface must never present as a clean
  // pass — exits 1 UNCONDITIONALLY (not gated by --gate), consistent with
  // this repo's own capture-honesty doctrine ("audit your success paths").
  // This deliberately also covers an unreadable LIVE (.claude/skills/)
  // surface, not just the stale one: it is committed and tracked, so an
  // unreadable copy in a normal checkout means the repo itself is broken,
  // and a loud failure is the correct response — not the old silent
  // existsSync-swallow into "0 skills, clean" this fix exists to close.
  const failure = reads.find(r => !r.read.readable)?.read ?? (!live.readable ? live : null);
  if (failure) {
    if (json) {
      process.stdout.write(JSON.stringify({
        repo: root, staleSurface: STALE_SURFACE, liveSurface: LIVE_SURFACE,
        status: 'error', inspectionError: failure.error.message, exitCode: 1,
      }, null, 2) + '\n');
    } else {
      process.stderr.write(
        `${R}✗ cannot inspect ${failure.error.path}: ${failure.error.message}${X}\n`,
      );
    }
    process.exit(1);
  }

  // One comparison per shadowing root, against the SAME live name set.
  const perSurface = reads.map(({ surface, read }) => ({
    surface,
    ...compareSkillSurfaces({
      staleNames: read.names,
      liveNames: ownedNames,
      // `compareSkillSurfaces` asks for content with the literal `STALE_SURFACE`
      // constant, so a naive passthrough reads `.github/skills/<n>/SKILL.md`
      // while comparing `.agents/skills` — reporting every `.agents` shadow as
      // "0 lines" because the file it looked for does not exist. Map the
      // stale-side request onto the surface actually under comparison.
      contentOf: (which, name) => readSkillMd(root, which === LIVE_SURFACE ? LIVE_SURFACE : surface, name),
      // Resolve both sides so a plugin symlink (one directory, two names) is
      // recognised as an alias rather than reported as a shadow.
      realPathOf: (which, name) => {
        const dir = path.join(root, ...(which === 'live' ? LIVE_SURFACE : surface).split('/'), name);
        try { return fs.realpathSync(dir); } catch { return null; }
      },
    }),
  }));

  const shadowedTotal = perSurface.reduce((n, s) => n + s.shadowed.length, 0);
  const treeTotal = perSurface.reduce((n, s) => n + s.total, 0);
  const exitCode = decideStaleSurfaceExit({ gate, shadowedCount: shadowedTotal });

  if (json) {
    process.stdout.write(JSON.stringify({
      repo: root, liveSurface: LIVE_SURFACE, shadowingSurfaces: SHADOWING_SURFACES,
      surfaces: perSurface, shadowedTotal, exitCode,
      // Back-compat: the pre-2026-07-30 single-surface shape, so an existing
      // reader keyed on `.github/skills` keeps working rather than silently
      // reading `undefined` and concluding "clean".
      staleSurface: STALE_SURFACE,
      ...perSurface.find(s => s.surface === STALE_SURFACE),
    }, null, 2) + '\n');
    process.exit(exitCode);
  }

  if (treeTotal === 0) {
    process.stderr.write(
      `${G}✓ no ${SHADOWING_SURFACES.join('/ or ')}/ tree — nothing can shadow ${LIVE_SURFACE}/${X}\n`,
    );
    process.exit(exitCode);
  }

  // Report every shadowing surface that has content, not just the first.
  for (const s of perSurface) {
    if (s.total === 0) continue;
    if (s.shadowed.length > 0) {
      process.stderr.write(
        `\n${R}── ${s.surface}/ shadows ${s.shadowed.length} live skill(s) ──${X}\n` +
        `  ${root}\n` +
        `  Copilot Agent Skills reads BOTH roots and precedence between them is ` +
        `${R}undefined${X} — the live copy may be unreachable.\n\n`,
      );
      for (const sh of s.shadowed) {
        // The line delta is the useful signal: it says HOW stale the shadow is,
        // which is what told the 2026-07-19 investigation that the shadowing
        // `ship` predated the cross-skill data loop entirely.
        const note = sh.identical
          ? `${D}identical content${X}`
          : `${R}${sh.staleLines} lines vs live ${sh.liveLines}${X}` +
            (sh.lineDelta > 0 ? ` ${D}(shadow is ${sh.lineDelta} lines behind)${X}` : '');
        process.stderr.write(`  ${R}✗${X} ${sh.name.padEnd(24)} ${note}\n`);
      }
      process.stderr.write(
        `\n${Y}Fix${X}: remove the shadowing copy (${LIVE_SURFACE}/ is the one this bundle owns) —\n` +
        s.shadowed.map(sh => `  rm -rf "${path.join(root, ...s.surface.split('/'), sh.name)}"\n`).join(''),
      );
    }
    if (s.orphans.length > 0 && s.surface === STALE_SURFACE) {
      process.stderr.write(
        `${Y}orphans${X} ${D}(deprecated ${s.surface}/ copies with no live counterpart — not intercepting today):${X}\n` +
        `  ${s.orphans.join(', ')}\n`,
      );
    } else if (s.orphans.length > 0 && s.surface === AGENTS_SURFACE) {
      // Names we do NOT deploy. Not our gate — but the advice depends on WHO put
      // them there, and the old wording assumed a mistake.
      //
      // `skills-lock.json` is the `skills` CLI's own record (skills.sh). That tool
      // treats `.agents/skills/` as CANONICAL and fans copies out to every agent
      // root the skill was added for — Claude Code, Codex, Gemini CLI, Copilot,
      // Kiro. So a name in BOTH `.agents/skills/` and `.claude/skills/` is that
      // tool working correctly, kept in sync by `skills update`, not an ambiguity
      // anyone should "resolve". Telling an operator to delete one copy sends them
      // to remove multi-agent access; measured 2026-08-09 — deleted, and the tool
      // restored it, because the lockfile is the source of truth.
      //
      // Only names ABSENT from that lockfile are unexplained, and only those get
      // the precedence warning.
      const managed = readSkillsLockNames(root);
      const toolManaged = s.orphans.filter((n) => managed.has(n));
      const unexplained = s.orphans.filter((n) => !managed.has(n));
      if (toolManaged.length > 0) {
        process.stderr.write(
          `${D}note: ${s.surface}/ holds ${toolManaged.length} skill(s) managed by the ` +
          `\`skills\` CLI (${toolManaged.join(', ')}) — canonical there, copied per agent ` +
          `root by design. Expected; change the agent set with \`skills add … --agent …\`, ` +
          `never by deleting a copy.${X}\n`,
        );
      }
      if (unexplained.length > 0) {
        process.stderr.write(
          `${D}note: ${s.surface}/ holds ${unexplained.length} skill(s) this bundle does not ` +
          `deploy and no skills-lock.json claims (${unexplained.join(', ')}) — not gated here; ` +
          `if any also exists in ${LIVE_SURFACE}/, its precedence is undefined and that is ` +
          `yours to resolve.${X}\n`,
        );
      }
    }
  }
  process.exit(exitCode);
}

/**
 * Report — never gate on — a stranded tree from the RETIRED install surfaces.
 *
 * `.github/skills/` (above) and `~/.claude/skills/` + `.agents/skills/` (here)
 * are the same failure shape: a copy in a discovered root shadowing the live one
 * with undefined precedence. So this file is the natural place to surface both.
 *
 * Two deliberate choices:
 *
 * 1. **No second detector.** It delegates to `inspectLegacySurfaces`, which is
 *    already the single oracle used by `sync-to-repos.mjs`, `setup.mjs` and
 *    `install.mjs`. Re-deriving "is there a stale global tree?" here would be a
 *    fourth answer to one question — precisely the duplication this whole change
 *    exists to remove.
 *
 * 2. **It does NOT gate, and that is a stated scope boundary rather than
 *    timidity.** Every machine that ever ran the old installer has this tree
 *    right now, including the authoring one (56 files). A gate would fail every
 *    push until each developer cleaned up — the cried-wolf gate that gets
 *    `--no-verify`'d, after which it protects nothing. Gate it once the fleet is
 *    clean; the cleanup command is one line and is printed here.
 *
 * @param {string} root repo root being checked
 */
function reportRetiredSurfaces(root) {
  // SYNCHRONOUS on purpose. `main()` ends in `process.exit()` on every branch, so
  // an async advisory would be scheduled and then discarded — a report that
  // silently never prints is worse than none, because its absence reads as
  // "nothing found".
  try {
    const legacy = inspectLegacySurfaces({ repoRoot: root });
    if (legacy.overall === 'absent') return;
    process.stderr.write(`\n${Y}Retired install surfaces still present${X} ${D}(advisory — not gated)${X}\n`);
    for (const line of describeLegacySurfaces(legacy)) {
      process.stderr.write(`  ${Y}•${X} ${line}\n`);
    }
    process.stderr.write(
      `${D}  These shadow ${LIVE_SURFACE}/ with undefined precedence between discovered roots.\n` +
      `  Remove: node scripts/install-skills.mjs --uninstall-legacy${X}\n`,
    );
  } catch (err) {
    // Advisory only — never let it affect the run, but never swallow it either.
    process.stderr.write(`${D}  (retired-surface check skipped: ${err.message})${X}\n`);
  }
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    if (!argv1) return false;
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) main();
