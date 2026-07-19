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

function listSkillDirs(root, surface) {
  const base = path.join(root, ...surface.split('/'));
  if (!fs.existsSync(base)) return [];
  return fs.readdirSync(base, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => e.name)
    .sort();
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
  const root = repoIdx >= 0 && argv[repoIdx + 1] ? path.resolve(argv[repoIdx + 1]) : process.cwd();

  const staleNames = listSkillDirs(root, STALE_SURFACE);
  const liveNames = listSkillDirs(root, LIVE_SURFACE);
  const result = compareSkillSurfaces({
    staleNames,
    liveNames,
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
    `${D}  (${LIVE_SURFACE}/ is the single Copilot-native surface; .github/prompts/ shims are unaffected.)${X}\n`
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
