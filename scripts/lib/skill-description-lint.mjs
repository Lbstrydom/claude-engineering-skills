/**
 * @fileoverview Pure lints over the SKILL.md `description` block — the surface
 * that decides whether a skill is ever selected. Two checks, both mechanical,
 * both seeded with real violations found the day this landed:
 *
 *   1. **Description budget.** AGENTS.md states the Copilot contract as
 *      "`description` is required, max 1024 chars" and claims it is "enforced
 *      by `skills:check`". It was not: on 2026-08-04 three skills were over
 *      (`investigate` 1257, `explain` 1152, `ux-lock` 1062) and `skills:check`
 *      exited 0. A stated-but-unenforced gate is the exact class the
 *      gate-honesty suite exists to catch, so the claim is made true here
 *      rather than softened in the doc. (The sibling `name` rule in that same
 *      sentence WAS enforced — poison-tested by renaming a skill's frontmatter
 *      `name`: `skills:check` exits 1. Only the budget half was fiction.)
 *
 *   2. **Literal trigger-phrase collisions.** See below.
 *
 * ## Why only literal collisions, and what this deliberately does NOT do
 *
 * Claude picks a skill from its description, so two skills advertising the same
 * phrase is a coin-flip the author never sees — the same silent-failure shape
 * `/investigate` exists for. This check makes the LITERAL case impossible.
 *
 * It does **not** detect semantic overlap, and that limit is measured, not
 * assumed. Across the 16 skills on 2026-08-04 there was exactly ONE literal
 * duplicate (`"verify the plan"`, claimed by both audit-plan and ux-lock —
 * fixed in the same commit that added this check, so the check shipped with a
 * real instance rather than as speculation).
 *
 * A fuzzy variant was measured and REJECTED on the evidence: Jaccard ≥ 0.5 over
 * phrase tokens produced 47 cross-skill "near-duplicate" pairs, essentially all
 * of them noise from a single shared word (`"audit my pr"` vs `"ia audit"`).
 * A gate with that false-positive rate is the cried-wolf shape this repo already
 * knows gets `--no-verify`'d.
 *
 * And the collision that motivated the check — `/investigate`'s "when did we
 * actually" against `/explain --history`'s prior-art search — shares NO literal
 * phrase, so this check would not have caught it. That is stated plainly rather
 * than papered over: semantic discrimination is declared by a human in the two
 * descriptions (each states the rule: a *topic* goes to `/explain --history`, a
 * *claim* goes to `/investigate`), because no mechanical oracle can find it and
 * claiming one would be the fake-check the gate-honesty suite exists to catch.
 *
 * @module scripts/lib/skill-description-lint
 */

/**
 * Copilot's hard cap on the frontmatter `description`, as recorded in AGENTS.md
 * from the 2026-07-21 compatibility audit. Not our number to tune — it is a
 * property of the consuming tool, so raising it here would only hide a skill
 * that the tool will reject anyway.
 */
export const DESCRIPTION_MAX_CHARS = 1024;

/**
 * Extract the `description:` block-scalar value from SKILL.md frontmatter,
 * with the block indent stripped — i.e. the string the YAML parser produces
 * and the consuming tool actually measures. Counting the raw indented lines
 * instead over-reports by two chars per line; that error is what made this
 * worth writing as a shared function rather than an inline regex.
 *
 * @param {string} skillMd
 * @returns {string|null} the description, or null when there is no block scalar
 */
export function extractDescription(skillMd) {
  const fm = String(skillMd ?? '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const lines = fm[1].split(/\r?\n/);
  const start = lines.findIndex((l) => /^description:\s*\|/.test(l));
  if (start === -1) return null;

  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    // A new top-level frontmatter key ends the block scalar.
    if (/^[A-Za-z][A-Za-z0-9_-]*:/.test(lines[i])) break;
    body.push(lines[i].replace(/^ {2}/, ''));
  }
  return body.join('\n').replace(/\s+$/, '');
}

/**
 * Skills whose description exceeds the budget.
 *
 * @param {Record<string, string>} skillMdByName
 * @returns {{ over: Array<{skill: string, length: number}>, missing: string[] }}
 *   `missing` lists skills with no parseable block description — required by
 *   the same contract, and a parse regression would otherwise read as clean.
 */
export function checkDescriptionBudget(skillMdByName) {
  const over = [];
  const missing = [];
  for (const [skill, md] of Object.entries(skillMdByName)) {
    const d = extractDescription(md);
    if (d === null) { missing.push(skill); continue; }
    if (d.length > DESCRIPTION_MAX_CHARS) over.push({ skill, length: d.length });
  }
  over.sort((a, b) => b.length - a.length);
  return { over, missing: missing.sort() };
}

/**
 * Pull the quoted phrases out of a SKILL.md's `Triggers on:` run.
 *
 * The run starts at `Triggers on:` and ends at the next `Usage:` /
 * `Full command syntax` / a frontmatter key / the closing `---`, matching how
 * every SKILL.md in the bundle is laid out.
 *
 * @param {string} skillMd - full SKILL.md text
 * @returns {{ declared: boolean, phrases: string[] }} `declared` is whether a
 *   `Triggers on:` run exists at all — distinguishing "no triggers declared"
 *   from "declared but nothing parsed", which is a parser regression, not a
 *   clean result.
 */
export function extractTriggerPhrases(skillMd) {
  const text = String(skillMd ?? '');
  const start = text.indexOf('Triggers on:');
  if (start === -1) return { declared: false, phrases: [] };

  const rest = text.slice(start + 'Triggers on:'.length);
  const endMatch = rest.match(/\n\s*(?:Usage:|Full command syntax|[a-z-]+:\s|---)/);
  const run = endMatch ? rest.slice(0, endMatch.index) : rest;

  const phrases = [...run.matchAll(/"([^"]+)"/g)]
    .map((m) => normalisePhrase(m[1]))
    .filter(Boolean);

  return { declared: true, phrases };
}

/**
 * Case- and whitespace-insensitive comparison key. Deliberately NOT
 * punctuation-stripping: `/audit-plan` and `audit-plan` are different claims
 * (one is a slash command, one is prose) and collapsing them would invent
 * collisions that do not exist.
 *
 * @param {string} phrase
 * @returns {string}
 */
export function normalisePhrase(phrase) {
  return String(phrase ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Find phrases claimed by more than one skill.
 *
 * @param {Record<string, string>} skillMdByName - skill name → SKILL.md text
 * @returns {{
 *   collisions: Array<{ phrase: string, skills: string[] }>,
 *   counts: Record<string, number>,
 *   emptyDeclared: string[],
 * }} `emptyDeclared` lists skills that declare `Triggers on:` but yielded zero
 *   phrases — a parser regression that would otherwise let this check pass
 *   having compared nothing.
 */
export function findTriggerCollisions(skillMdByName) {
  const owners = new Map();
  const counts = {};
  const emptyDeclared = [];

  for (const [skill, md] of Object.entries(skillMdByName)) {
    const { declared, phrases } = extractTriggerPhrases(md);
    counts[skill] = phrases.length;
    if (declared && phrases.length === 0) emptyDeclared.push(skill);
    for (const p of phrases) {
      if (!owners.has(p)) owners.set(p, new Set());
      owners.get(p).add(skill);
    }
  }

  const collisions = [...owners.entries()]
    .filter(([, s]) => s.size > 1)
    .map(([phrase, s]) => ({ phrase, skills: [...s].sort() }))
    .sort((a, b) => a.phrase.localeCompare(b.phrase));

  return { collisions, counts, emptyDeclared: emptyDeclared.sort() };
}
