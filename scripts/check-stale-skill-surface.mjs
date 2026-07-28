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

const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

/** The deprecated surface, and the live one it shadows. */
export const STALE_SURFACE = '.github/skills';
export const LIVE_SURFACE = '.claude/skills';

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
      .filter(e => e.isDirectory())
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
export function compareSkillSurfaces({ staleNames, liveNames, contentOf }) {
  const live = new Set(liveNames);
  const shadowed = [];
  const orphans = [];
  for (const name of staleNames) {
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
  return { shadowed, orphans, total: staleNames.length };
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

  const stale = listSurfaceNames(root, STALE_SURFACE);
  const live = listSurfaceNames(root, LIVE_SURFACE);

  // An inspection failure on EITHER surface must never present as a clean
  // pass — exits 1 UNCONDITIONALLY (not gated by --gate), consistent with
  // this repo's own capture-honesty doctrine ("audit your success paths").
  // This deliberately also covers an unreadable LIVE (.claude/skills/)
  // surface, not just the stale one: it is committed and tracked, so an
  // unreadable copy in a normal checkout means the repo itself is broken,
  // and a loud failure is the correct response — not the old silent
  // existsSync-swallow into "0 skills, clean" this fix exists to close.
  const failure = !stale.readable ? stale : !live.readable ? live : null;
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

  const result = compareSkillSurfaces({
    staleNames: stale.names,
    liveNames: live.names,
    contentOf: (surface, name) => readSkillMd(root, surface, name),
  });

  const exitCode = decideStaleSurfaceExit({ gate, shadowedCount: result.shadowed.length });

  if (json) {
    process.stdout.write(JSON.stringify({
      repo: root, staleSurface: STALE_SURFACE, liveSurface: LIVE_SURFACE, ...result, exitCode,
    }, null, 2) + '\n');
    process.exit(exitCode);
  }

  if (result.total === 0) {
    process.stderr.write(`${G}✓ no ${STALE_SURFACE}/ tree — nothing can shadow ${LIVE_SURFACE}/${X}\n`);
    process.exit(exitCode);
  }

  process.stderr.write(
    `${R}── stale skill surface ──${X}\n` +
    `  ${root}\n` +
    `  ${STALE_SURFACE}/ exists with ${result.total} skill(s).\n` +
    `  Copilot Agent Skills reads BOTH surfaces and ${R}${STALE_SURFACE}/ WINS on a name collision${X}.\n\n`
  );

  if (result.shadowed.length > 0) {
    process.stderr.write(`${R}SHADOWED${X} — the live copy is unreachable for these names:\n`);
    for (const s of result.shadowed) {
      const note = s.identical
        ? `${D}identical content${X}`
        : `${R}${s.staleLines} lines vs live ${s.liveLines}${X}` +
          (s.lineDelta > 0 ? ` ${D}(stale is ${s.lineDelta} lines behind)${X}` : '');
      process.stderr.write(`  ${R}✗${X} ${s.name.padEnd(24)} ${note}\n`);
    }
    process.stderr.write('\n');
  }

  if (result.orphans.length > 0) {
    process.stderr.write(
      `${Y}orphans${X} ${D}(deprecated copies with no live counterpart — not intercepting today):${X}\n` +
      `  ${result.orphans.join(', ')}\n\n`
    );
  }

  process.stderr.write(
    `${Y}Fix${X}: delete the deprecated tree —\n` +
    `  rm -rf "${path.join(root, ...STALE_SURFACE.split('/'))}"\n` +
    `${D}  (${LIVE_SURFACE}/ is the single Copilot-native surface.)${X}\n`
  );
  process.exit(exitCode);
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    if (!argv1) return false;
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();

if (isMain) main();
