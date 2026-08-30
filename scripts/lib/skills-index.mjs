/**
 * @fileoverview The skills inventory — `skills/<name>/SKILL.md` frontmatter parsed into
 * structured records. Answers ONE question: *what skills exist, and what do they do?*
 *
 * **Why this is not in `scripts/skills-help.mjs`.** It used to be. That module is a
 * CLI entry point, and `scripts/lib/dashboard/collect-reference.mjs` imported it as a
 * library — a `dashboard -> scripts` edge that was the SOLE reason
 * `allowedDeps.dashboard` had to grant the whole root-scripts domain. Extracting the
 * two pure functions here (`shared-lib`) let that grant be deleted outright.
 * Plan: docs/plans/dashboard-skills-index-layering.md (L5 of the layering series).
 *
 * **Deliberately NOT merged into `skill-refs-parser.mjs`** — that parses the
 * `## Reference files` *table* and reference-file frontmatter for the skills:check
 * lint. Different input, different consumer, different question.
 *
 * **cwd contract (load-bearing).** `loadAllSkills` resolves its skills directory
 * relative to `process.cwd()` when the caller passes none, and `parseSkill` returns a
 * `process.cwd()`-relative `path` that the dashboard RENDERS. A caller not guaranteed
 * to run from the repo root must pass an explicit directory. Making the root a
 * required parameter would change that rendered field — see the named assumption and
 * its revisit trigger in the plan’s §4.
 *
 * @module scripts/lib/skills-index
 */
import fs from 'node:fs';
import path from 'node:path';
import yaml from 'yaml';

/**
 * Load a single SKILL.md file and parse its frontmatter into a structured
 * record. Returns null if no frontmatter is present or the file is unreadable
 * (so the caller can skip it gracefully rather than aborting the whole scan).
 *
 * **A bare null cannot say WHY.** Four unrelated causes collapse to it — an
 * unreadable file, absent frontmatter, YAML that does not parse, and frontmatter
 * whose `name`/`description` are missing or the wrong type. At `loadAllSkills`'
 * call site the file is `existsSync`-gated first, so a null there is never
 * "absent"; it is always a SKILL.md that is PRESENT and broken, and it used to
 * be dropped in silence. A skill with one corrupt YAML line vanished from the
 * dashboard and from skills-help, reading exactly like a skill nobody had
 * written yet. `onSkip` is the diagnostic channel; the null return is unchanged,
 * so every existing caller and test keeps working.
 *
 * @param {string} skillFile
 * @param {{onSkip?: (info: {file: string, reason: string, detail?: string}) => void}} [opts]
 *   `reason` ∈ 'unreadable' | 'no-frontmatter' | 'unparseable-yaml' | 'invalid-frontmatter'
 */
export function parseSkill(skillFile, { onSkip } = {}) {
  const skip = (reason, detail) => {
    if (onSkip) onSkip(detail === undefined ? { file: skillFile, reason } : { file: skillFile, reason, detail });
    return null;
  };

  let raw;
  try { raw = fs.readFileSync(skillFile, 'utf-8'); }
  catch (err) { return skip('unreadable', err.message); }

  // Normalise CRLF → LF before matching so the same regex works whether the
  // file was authored on Windows or Unix.
  raw = raw.replace(/\r\n/g, '\n').replace(/^﻿/, '');
  const m = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return skip('no-frontmatter');

  let fm;
  try { fm = yaml.parse(m[1]); }
  catch (err) { return skip('unparseable-yaml', err.message); }

  // `name` must be a STRING, not merely truthy. YAML happily produces a number
  // (`name: 123`), boolean (`name: true`) or map (`name: {value: foo}`), and a
  // truthy-only check let those through — then loadAllSkills' sort threw
  // `a.name.localeCompare is not a function`, aborting the WHOLE scan. That
  // contradicts this function's own contract two lines up ("so the caller can
  // skip it gracefully rather than aborting the whole scan"), and in the
  // dashboard it surfaced as an empty skills section, not an error.
  if (!fm || typeof fm.name !== 'string' || !fm.name || typeof fm.description !== 'string') {
    return skip('invalid-frontmatter',
      `name must be a non-empty string (got ${typeof fm?.name}), description must be a string (got ${typeof fm?.description})`);
  }

  // Extract structured pieces from the description text. Frontmatter
  // descriptions in this repo follow a stable shape:
  //   <one or two summary sentences>
  //   Triggers on: "x", "y", "z"
  //   Usage: /name <args>      — what it does
  //          /name <other>     — what else
  const desc = fm.description.trim();
  const lines = desc.split('\n').map(l => l.trim());

  // First non-empty line up to first "Triggers on:"/"Usage:" is the one-liner
  const summaryLines = [];
  for (const line of lines) {
    if (/^triggers? on:/i.test(line) || /^usage:/i.test(line)) break;
    if (line.length > 0) summaryLines.push(line);
  }
  const oneLiner = summaryLines.join(' ').replace(/\s+/g, ' ').trim();
  // First sentence only (everything up to the first period followed by space-or-end)
  const firstSentence = oneLiner.split(/\.\s|\.$/)[0].trim() + (oneLiner.includes('.') ? '.' : '');

  // Triggers: the line(s) starting with "Triggers on:"
  const triggers = [];
  const triggerLineRe = /^triggers? on:\s*(.*)$/i;
  let inTriggers = false;
  for (const line of lines) {
    const m2 = line.match(triggerLineRe);
    if (m2) { inTriggers = true; triggers.push(m2[1]); continue; }
    if (inTriggers) {
      if (/^usage:/i.test(line)) { inTriggers = false; continue; }
      if (line.length === 0) { inTriggers = false; continue; }
      // A trigger continuation line is a quoted-comma list. A line with no
      // quote (e.g. "IMPORTANT: …" boilerplate) is NOT a trigger — stop
      // capture so it doesn't become a giant malformed trigger chip.
      if (!line.includes('"')) { inTriggers = false; continue; }
      triggers.push(line);
    }
  }
  // Flatten quoted-comma trigger lists: '"x", "y", "z"' → ['x', 'y', 'z']
  const flatTriggers = triggers
    .join(' ')
    .replace(/^"|"$/g, '')
    .split(/"\s*,\s*"/)
    .map(t => t.replace(/^["\s]+|["\s.]+$/g, ''))
    .filter(Boolean);

  // Usage lines: capture everything after "Usage:" up to next blank/section
  const usage = [];
  let inUsage = false;
  for (const line of lines) {
    if (/^usage:/i.test(line)) {
      inUsage = true;
      const tail = line.replace(/^usage:\s*/i, '').trim();
      if (tail) usage.push(tail);
      continue;
    }
    if (inUsage) {
      if (line.length === 0) { inUsage = false; continue; }
      // Stop on a new top-level field cue — "Examples:" or "Triggers on:"
      // (a Usage block before the triggers must not swallow them).
      if (/^examples?:/i.test(line)) { inUsage = false; continue; }
      if (/^triggers? on:/i.test(line)) { inUsage = false; continue; }
      usage.push(line);
    }
  }

  // Fallback: skills whose Usage/Examples were relocated out of the (≤1024-char
  // Copilot-capped) frontmatter description into a `## Usage` body section
  // (2026-07-21). Scan the markdown body after the frontmatter for that
  // section's fenced block. Skip fences and any stray "Triggers on:" line the
  // relocated tail may carry (triggers already parsed from the description).
  if (usage.length === 0) {
    const body = raw.slice(m[0].length);
    const section = body.match(/^##\s+Usage\b[^\n]*\n([\s\S]*?)(?=^##\s|$(?![\s\S]))/m);
    if (section) {
      // Prefer the fenced block so trailing prose after the fence isn't captured;
      // fall back to the raw section for a non-fenced `## Usage`.
      const fence = section[1].match(/```[^\n]*\n([\s\S]*?)```/);
      const src = fence ? fence[1] : section[1];
      let inTrig = false;
      for (const rawLine of src.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('```')) continue;
        if (/^triggers? on:/i.test(line)) { inTrig = true; continue; }
        if (inTrig) { if (!line.includes('"')) inTrig = false; else continue; }
        usage.push(line.replace(/^usage:\s*/i, ''));
      }
    }
  }

  return {
    name: fm.name,
    oneLiner: firstSentence || (lines[0] || '').slice(0, 200),
    fullDescription: desc,
    triggers: flatTriggers,
    usage,
    disableModelInvocation: fm['disable-model-invocation'] === true,
    path: path.relative(process.cwd(), skillFile).replace(/\\/g, '/'),
  };
}

/**
 * Where a repo's skills live, in preference order.
 *
 * `skills/` is the AUTHORING tree and exists only in the source repo;
 * `.claude/skills/` is the generated copy the sync writes into every consumer.
 * A consumer has only the second, so a reader that knows only the first sees
 * an empty repo (upstream report `5b67f273`).
 */
export const SKILL_ROOT_CANDIDATES = Object.freeze(['skills', '.claude/skills']);

/**
 * Resolve the skills root for `cwd`, or `{root: null}` when neither exists.
 *
 * Returns the ORIGIN alongside the path so a caller can say which tree it
 * read. Never guesses: a null root is reported, not silently treated as an
 * empty skill set — that equivalence is the defect this exists to remove.
 *
 * @param {string} [cwd]
 * @returns {{root: string|null, origin: 'authoring'|'generated'|'none'}}
 */
export function resolveSkillsRoot(cwd = process.cwd()) {
  for (const [i, candidate] of SKILL_ROOT_CANDIDATES.entries()) {
    const abs = path.resolve(cwd, candidate);
    if (fs.existsSync(abs)) return { root: abs, origin: i === 0 ? 'authoring' : 'generated' };
  }
  return { root: null, origin: 'none' };
}

/**
 * Scan all skills/* directories for SKILL.md files. Returns sorted by name.
 * Excludes the .claude/skills/ mirror (regenerated, not authoritative).
 *
 * The SKILL.md is `existsSync`-gated before parsing, so anything `parseSkill`
 * rejects here is present-and-broken rather than absent — never a silent drop.
 * `onSkip` receives one `{file, reason, detail?}` per rejected skill; omit it
 * and a one-line warning goes to stderr instead, which is what the dashboard
 * and skills-help collectors get for free.
 *
 * **The root is DISCOVERED, not assumed** (upstream report `5b67f273`). This
 * defaulted to a top-level `skills/` and returned `[]` through the
 * `existsSync` guard below when it was absent — so in a consumer that carries
 * only `.claude/skills/` (which is every consumer: the sync writes the
 * generated copy there and the authoring tree is source-repo-only)
 * `skills-help.mjs` printed "_No skills found in `skills/`._" over 67 tracked
 * skill files. A silently-wrong empty result, not an error, so it read as
 * "this repo has no skills" rather than "I looked in the wrong place".
 *
 * `resolveSkillsRoot` therefore prefers the authoring tree and falls back to
 * the generated one, and an ABSENT root is reported through `onSkip` instead
 * of vanishing: "nothing here" and "no such directory" are different answers
 * and only one of them is a fact about the skills.
 *
 * An explicit `skillsRoot` argument still wins outright — `collect-reference`
 * passes one deliberately, because the dashboard documents the AUTHORING tree
 * and must not silently fall back to the generated mirror.
 *
 * @param {string} [skillsRoot]
 * @param {{onSkip?: (info: {file: string, reason: string, detail?: string}) => void}} [opts]
 */
export function loadAllSkills(skillsRoot = undefined, { onSkip } = {}) {
  const resolved = skillsRoot === undefined
    ? resolveSkillsRoot()
    : { root: path.resolve(skillsRoot), origin: 'explicit' };
  const report0 = onSkip ?? ((info) => {
    process.stderr.write(
      `  [skills-index] ${info.file}: skipped (${info.reason}${info.detail ? ` — ${info.detail}` : ''})
`,
    );
  });
  if (resolved.root === null) {
    report0({
      file: SKILL_ROOT_CANDIDATES.join(' | '),
      reason: 'no-skills-root',
      detail: 'neither the authoring tree nor the generated copy exists here',
    });
    return [];
  }
  const root = resolved.root;
  if (!fs.existsSync(root)) {
    report0({ file: path.relative(process.cwd(), root).replace(/\\/g, '/'), reason: 'skills-root-absent' });
    return [];
  }
  const entries = fs.readdirSync(root, { withFileTypes: true });
  const report = onSkip ?? ((info) => {
    process.stderr.write(
      `  [skills-index] ${info.file}: skipped (${info.reason}${info.detail ? ` — ${info.detail}` : ''})\n`,
    );
  });
  const out = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(root, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    const parsed = parseSkill(skillFile, { onSkip: report });
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
