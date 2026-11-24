/**
 * @fileoverview Skill names the HOST reserves for its own built-in skills.
 *
 * Claude Code v2.1.330 (Claude Ship, 2026-11-23) bundles `/ship` (internal
 * skill `ship-local`) and `/steward`, and **does not load** a project or
 * personal skill carrying one of those names. Measured 2026-11-24, same repo,
 * `claude -p "reply ok" --debug-file`:
 *   - CC 2.1.330: `[skills] Ignored /ship: each uses a name reserved for a skill
 *     built into Claude Code (ship-local, ship, steward, ship:steward)`;
 *   - CC 2.1.318 (negative control): no such line.
 * The docs agree (code.claude.com/docs/en/skills §Resolve skills that share a
 * name). Detail and the off switch: docs/reference/skill-surface-ownership.md.
 *
 * `steward` is worse than ignored: `.claude/skills/steward/SKILL.md` is the file
 * the built-in watch AND the org PR Steward agent read as INSTRUCTIONS. A skill
 * of ours named `steward` would be regenerated into exactly that path and synced
 * into every consumer, steering an agent that pushes under the user's name.
 *
 * `ship` is the one live collision: ours predates the built-in. It is a
 * DECLARED exception, not a silent one, and the exception must stay live — a
 * renamed skill leaves the entry stale, which fails, so the list cannot rot.
 *
 * @module scripts/lib/skill-reserved-names
 */
import yaml from 'yaml';

/** Names the host reserves (from the CC 2.1.330 debug line quoted above). */
export const RESERVED_SKILL_NAMES = Object.freeze(['ship', 'ship-local', 'steward', 'ship:steward']);

/**
 * Known collisions, keyed by the skill DIRECTORY they are tolerated in, each
 * naming the one reserved name it may carry and why. Scoped to the directory so
 * a second skill claiming `ship` is still a violation. Removing an entry is
 * the normal end state (after a rename); adding one needs Louis's decision.
 */
export const KNOWN_RESERVED_COLLISIONS = Object.freeze({
  ship: Object.freeze({
    name: 'ship',
    reason: 'Ours predates the CC 2.1.330 built-in; CC no longer loads it. Rename is pending a decision (skill-surface-ownership.md §8).',
  }),
});

/**
 * Claude Code compares names ignoring case and spacing (docs §When a synced
 * skill name matches); fold the same way so `Steward` cannot slip past.
 * @param {string} name
 */
export function foldSkillName(name) {
  return String(name ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
}

/**
 * The frontmatter `name`, parsed as YAML (comments, quoting and block scalars
 * all handled by the parser, not a regex).
 * @param {string} skillMd
 * @returns {{ok:true, name:string|null} | {ok:false, error:string}}
 */
export function extractFrontmatterName(skillMd) {
  const fm = String(skillMd ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return { ok: true, name: null };
  let doc;
  try { doc = yaml.parse(fm[1]); } catch (err) { return { ok: false, error: `unparseable frontmatter: ${err.message}` }; }
  const name = doc && typeof doc === 'object' ? doc.name : undefined;
  if (name === undefined || name === null) return { ok: true, name: null };
  if (typeof name !== 'string') return { ok: false, error: `frontmatter name is a ${typeof name}, not a string` };
  return { ok: true, name: name.trim() };
}

/**
 * @param {Record<string,string>} skillMdByDir  skill directory name → SKILL.md text
 * @param {{reserved?: readonly string[], known?: Record<string,{name:string, reason:string}>}} [opts]
 * @returns {{violations: {skill:string, name:string}[], tolerated: {skill:string, name:string, reason:string}[],
 *   staleExceptions: string[], unreadable: {skill:string, error:string}[]}}
 *   An unreadable name fails closed: the caller must not report clean over it.
 */
export function findReservedNameCollisions(skillMdByDir, opts = {}) {
  const reserved = new Set((opts.reserved ?? RESERVED_SKILL_NAMES).map(foldSkillName));
  const known = opts.known ?? KNOWN_RESERVED_COLLISIONS;
  const violations = [], tolerated = [], unreadable = [], used = new Set();
  for (const [dir, md] of Object.entries(skillMdByDir)) {
    const fm = extractFrontmatterName(md);
    if (!fm.ok) { unreadable.push({ skill: dir, error: fm.error }); continue; }
    const names = new Set([dir, fm.name].filter(Boolean).map(foldSkillName));
    const exception = Object.hasOwn(known, dir) ? known[dir] : null;
    for (const name of names) {
      if (!reserved.has(name)) continue;
      if (exception && foldSkillName(exception.name) === name) {
        used.add(dir);
        tolerated.push({ skill: dir, name, reason: exception.reason });
      } else {
        violations.push({ skill: dir, name });
      }
    }
  }
  const staleExceptions = Object.keys(known).filter((dir) => !used.has(dir));
  return { violations, tolerated, staleExceptions, unreadable };
}
