/**
 * @fileoverview Single oracle for the worktree-preflight contract: which skills
 * must carry the marker, and what the marker says.
 *
 * **The defect class.** A consumer's synced tooling lives in the gitignored
 * `scripts/.claude-skills/`, so it is absent from every linked git worktree —
 * while the `.claude/` tree carrying the SKILL.md that names it is copied in by
 * the harness. The instruction arrives, the tool does not, and the failure is a
 * bare `MODULE_NOT_FOUND` with no remedy. Reported 2026-08-13; the incident and
 * the remedies are in `docs/runbooks/consumer-adoption.md` §"Linked git
 * worktrees".
 *
 * **Why the subject set is derived from the filesystem, never listed.** The
 * first cut of this used a hand-picked pair of skills chosen by grepping for
 * `node scripts/*.mjs`. That predicate missed `ai-context-management` — which
 * reaches the tooling only through `npm run context:check`, and is the skill
 * the bug was actually reported against. A curated list would have exempted the
 * reporting skill. So `skillsInvokingSyncedTooling` walks `skills/` and
 * resolves BOTH invocation forms; a skill drops out of scope only by an
 * EXEMPTIONS entry with a written reason. Same shape as `db:enrolment:gate`:
 * iterate the side that can see what no list mentions.
 *
 * @module scripts/lib/worktree-preflight
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * The canonical marker block, inserted verbatim into every in-scope SKILL.md.
 *
 * Byte-identity across copies is the whole anti-drift mechanism — it is what
 * lets the gate compare rather than merely detect, and it is why this constant
 * exists instead of 16 hand-written paragraphs. The SUBSTANCE deliberately
 * lives in the runbook, not here: this block is a trigger, sized so that
 * carrying it in every skill costs almost nothing.
 */
export const MARKER_BLOCK = `> **Worktree preflight** — in a linked git worktree the synced tooling tree
> \`scripts/.claude-skills/\` is absent — it is gitignored, so \`git worktree add\`
> does not populate it, and every command below that uses it dies on a bare
> \`MODULE_NOT_FOUND\`. Run \`npm run skills:hydrate\` first. Detail:
> \`docs/runbooks/consumer-adoption.md\` §"Linked git worktrees".`;

/**
 * Phrasing constraint, learned at the pre-push gate: keep this block clear of
 * `scripts/lib/gate-honesty/verb-pattern.mjs`'s ENFORCEMENT_VERBS (`never`,
 * `must`, `fails`, `gate`, …). That check is deliberately broad and
 * diff-scoped, which normally costs nothing — but this block is byte-identical
 * across every skill, so ONE stray verb here demands an `ignoredCandidates`
 * disposition in all 16 contracts for a sentence that makes no enforcement
 * claim at all. The first draft said "`git worktree add` never populates it";
 * the plainer wording above is both accurate and cheap.
 */

/**
 * Stable substring proving the block is present. Matched separately from the
 * full block so the gate can tell "absent" from "present but edited" — two
 * different failures needing two different messages.
 */
export const MARKER_KEY = '**Worktree preflight**';

/**
 * Every `npm run <script>` the marker block instructs the reader to run.
 *
 * Derived from `MARKER_BLOCK` rather than hard-coded, so a future edit to the
 * remedy cannot drift from what gets verified — the same reason the block is
 * one constant instead of 16 paragraphs.
 *
 * @param {string} [block]
 * @returns {string[]} script names, de-duplicated, in order of appearance
 */
export function markerNamedNpmScripts(block = MARKER_BLOCK) {
  const names = [];
  // Tolerates the backslash-escaped backticks the constant carries in source.
  for (const m of block.matchAll(/npm run ([a-z0-9:_-]+)/gi)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/**
 * Does every script the marker names actually EXIST in `package.json`?
 *
 * **Why this is a gate and not a note** (added 2026-08-14). The marker check
 * above proves the block is PRESENT in all 16 skills. It never asked whether
 * the remedy the block prescribes could be followed — and it could not: the
 * block has told readers to run `npm run skills:hydrate` since it landed, while
 * no such npm script existed here, so following the instruction produced
 * `npm error Missing script`. That is the very defect class this module was
 * built to stop (*the instruction ships and the tool does not*), reappearing
 * one level up — in the REMEDY rather than the subject it remedies. A gate that
 * verifies a pointer's existence but not its target is half a gate.
 *
 * `package.json` is the right place to look precisely because it is TRACKED:
 * the runbook's whole argument is that a worktree remedy must ride on tracked
 * content, so a remedy absent from `package.json` is unreachable by
 * construction.
 *
 * @param {string} rootDir
 * @param {{readPackageJson?: (dir: string) => object}} [io] - injected for tests
 * @returns {{ok: boolean, missing: string[], checked: string[]}}
 */
export function checkMarkerRemedies(rootDir, io = {}) {
  const read = io.readPackageJson
    ?? ((dir) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')));
  const checked = markerNamedNpmScripts();
  let scripts = {};
  try {
    scripts = read(rootDir)?.scripts ?? {};
  } catch {
    // An unreadable package.json cannot prove the remedy exists, so report
    // every named script missing rather than passing on absence of evidence.
    return { ok: false, missing: checked, checked };
  }
  const missing = checked.filter((name) => !Object.prototype.hasOwnProperty.call(scripts, name));
  return { ok: missing.length === 0, missing, checked };
}

/**
 * Skills deliberately out of scope, each with the reason it cannot be bitten.
 *
 * Empty today, and that is a finding rather than an oversight: the census found
 * all 16 skills invoke synced tooling one way or another. Kept because a future
 * skill that genuinely never touches the tree should drop out by a written
 * reason, never by being forgotten.
 *
 * @type {Readonly<Record<string,string>>}
 */
export const EXEMPTIONS = Object.freeze({});

/**
 * The ONE spelling of "resolve the MAIN checkout's pending-note path".
 *
 * `/ship` Step 2 READS that file and Step 6.8 WRITES it, so the two must
 * resolve the same path — and they carried hand-copied recipes with nothing
 * comparing them. That is the producer/consumer-must-agree class this repo keeps
 * fixing, reappearing inside a single document. `checkDocumentedRecipes` compares
 * every copy against this constant, so N copies stay legal and DISAGREEMENT does
 * not — the same shape as `MARKER_BLOCK` above.
 */
export const MAIN_CHECKOUT_PATH_RECIPE = "node -e \"const{execFileSync}=require('node:child_process'),p=require('node:path');console.log(p.join(p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim()),'.claude','tmp','ship-verification-pending.md'))\"";

/**
 * The consumer-side `skills:hydrate` npm script, as documented in
 * `docs/runbooks/consumer-adoption.md` §"Linked git worktrees" → Remedy 1.
 *
 * **Why a second implementation of `scripts/skills-hydrate.mjs` is legitimate,
 * and why it is pinned anyway.** A consumer cannot run that script: it syncs
 * into `scripts/.claude-skills/`, which is precisely the gitignored tree absent
 * from every linked worktree — the bootstrap problem the remedy exists to solve.
 * So a consumer needs a package.json one-liner depending on nothing but node and
 * git. The duplication is FORCED, not sloppy. What is not forced is letting the
 * two drift: the runbook must quote this constant byte-for-byte, and
 * `tests/skills-hydrate.test.mjs` asserts the one-liner emits the same
 * user-visible messages `planHydration` does for the branches they share.
 */
export const CONSUMER_HYDRATE_NPM_SCRIPT = "\"skills:hydrate\": \"node -e \\\"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});console.log('[hydrate] copied '+src)\\\"\"";

/**
 * Do the DOCS still quote the canonical recipes byte-for-byte?
 *
 * Closes the last two hand-copied spellings this subsystem had (2026-08-14):
 * `skills/ship/SKILL.md` carries the pending-note path recipe twice — once
 * where Step 6.8 WRITES the file and once where Step 2 READS it — and
 * `docs/runbooks/consumer-adoption.md` carries the consumer `skills:hydrate`
 * one-liner. Nothing compared any of them.
 *
 * **N copies stay legal; disagreement does not.** Deliberately not "the recipe
 * must appear exactly once": a reader following Step 2 should not have to jump
 * to Step 6.8 to learn the path, and prose that forces a jump gets re-inlined
 * by the next editor anyway. The real invariant is that the writer and the
 * reader resolve the SAME path — so this compares every occurrence against one
 * constant, exactly as `checkSkill` compares 16 marker copies against
 * `MARKER_BLOCK`.
 *
 * A leading blockquote marker (`> `) is stripped before comparing: the recipe
 * appears both bare and inside a `>` callout, and that is formatting, not
 * meaning.
 *
 * @param {string} rootDir
 * @param {{readFile?: (p: string) => string}} [io] - injected for tests
 * @returns {{ok: boolean, mismatches: Array<{file: string, line: number, found: string}>, checked: number}}
 */
export function checkDocumentedRecipes(rootDir, io = {}) {
  const read = io.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const subjects = [
    { file: 'skills/ship/SKILL.md', marker: '--git-common-dir', canonical: MAIN_CHECKOUT_PATH_RECIPE, needs: 'node -e' },
    { file: 'docs/runbooks/consumer-adoption.md', marker: '"skills:hydrate"', canonical: CONSUMER_HYDRATE_NPM_SCRIPT, needs: '"skills:hydrate"' },
  ];
  const mismatches = [];
  let checked = 0;
  for (const s of subjects) {
    let text;
    try {
      text = read(path.join(rootDir, s.file));
    } catch {
      // A doc that cannot be read cannot be shown to quote the constant.
      mismatches.push({ file: s.file, line: 0, found: '<unreadable>' });
      continue;
    }
    const lines = text.split('\n');
    for (const [i, raw] of lines.entries()) {
      if (!raw.includes(s.marker) || !raw.includes(s.needs)) continue;
      checked++;
      const bare = raw.replace(/^>\s?/, '').trim();
      if (bare !== s.canonical.trim()) {
        mismatches.push({ file: s.file, line: i + 1, found: bare.slice(0, 120) });
      }
    }
  }
  return { ok: mismatches.length === 0, mismatches, checked };
}

/** Matches a path into the tooling tree, in either invocation form. */
const TOOLING_PATH = /scripts\/[\w./-]+\.mjs/;

/**
 * Every skill whose documented commands reach the synced tooling tree.
 *
 * Two invocation forms, because covering only the first is what produced the
 * miss described in the module header:
 *   1. direct — `node scripts/<x>.mjs` in SKILL.md or any reference
 *   2. indirect — `npm run <name>` where THIS repo's package.json defines
 *      `<name>` as a command into `scripts/`. The consumer's own package.json
 *      is not readable from here, so the source definition is the proxy; it is
 *      the same script under the sync's path rewrite.
 *
 * Fails closed: an unreadable package.json throws rather than yielding an
 * empty script map, which would silently shrink the subject set to the
 * direct-invocation skills only — the exact blind spot this function exists
 * to remove.
 *
 * @param {string} rootDir absolute repo root
 * @returns {string[]} skill directory names, sorted, exemptions removed
 */
export function skillsInvokingSyncedTooling(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  let scripts;
  try {
    scripts = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).scripts || {};
  } catch (err) {
    throw new Error(`worktree-preflight: cannot read ${pkgPath} (${err.code || err.message}) — refusing to compute a subject set from an unknown script map`);
  }

  const skillsDir = path.join(rootDir, 'skills');
  if (!fs.existsSync(skillsDir)) return [];

  const hits = [];
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skill = entry.name;
    if (skill in EXEMPTIONS) continue;
    if (markdownUnder(path.join(skillsDir, skill)).some(f => reachesTooling(f, scripts))) {
      hits.push(skill);
    }
  }
  return hits.sort();
}

/** Every `.md` under a skill directory, recursively (SKILL.md + references + examples). */
function markdownUnder(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...markdownUnder(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

/** True when a markdown file documents a command that reaches the tooling tree. */
function reachesTooling(file, scripts) {
  const text = fs.readFileSync(file, 'utf-8');
  if (/node\s+scripts\/[\w./-]+\.mjs/.test(text)) return true;
  for (const m of text.matchAll(/npm run ([\w:.-]+)/g)) {
    const def = scripts[m[1]];
    if (def && TOOLING_PATH.test(def)) return true;
  }
  return false;
}

/**
 * Classify one skill's SKILL.md against the contract.
 *
 * @param {string} rootDir absolute repo root
 * @param {string} skill directory name
 * @returns {{skill:string, status:'ok'|'missing'|'edited'|'no-skill-md'}}
 */
export function checkSkill(rootDir, skill) {
  const p = path.join(rootDir, 'skills', skill, 'SKILL.md');
  if (!fs.existsSync(p)) return { skill, status: 'no-skill-md' };
  const text = fs.readFileSync(p, 'utf-8');
  if (!text.includes(MARKER_KEY)) return { skill, status: 'missing' };
  // Compare on LF so a CRLF checkout is not read as an edit — git calls such a
  // file clean, and a tool that disagrees is comparing the wrong thing.
  if (!text.replaceAll('\r\n', '\n').includes(MARKER_BLOCK)) return { skill, status: 'edited' };
  return { skill, status: 'ok' };
}
