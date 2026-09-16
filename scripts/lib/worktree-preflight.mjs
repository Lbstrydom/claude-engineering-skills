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
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

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
export const CONSUMER_HYDRATE_NPM_SCRIPT = "\"skills:hydrate\": \"node -e \\\"const{execFileSync}=require('node:child_process'),p=require('node:path'),f=require('node:fs');const main=p.dirname(execFileSync('git',['rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8'}).trim());const dir='scripts/.claude-skills';const src=p.join(main,dir);if(p.resolve(dir)===p.resolve(src)){console.log('[hydrate] main checkout - nothing to do');process.exit(0)}if(!f.existsSync(src)){console.error('[hydrate] no tooling at '+src+' - re-sync the main checkout first');process.exit(1)}f.cpSync(src,dir,{recursive:true});const prune=(s,d)=>{if(!f.existsSync(d))return;for(const e of f.readdirSync(d,{withFileTypes:true})){const sp=p.join(s,e.name),dp=p.join(d,e.name);if(e.isDirectory()){if(!f.existsSync(sp)){f.rmSync(dp,{recursive:true,force:true});continue}prune(sp,dp);if(f.readdirSync(dp).length===0)f.rmSync(dp,{recursive:true,force:true})}else if(!f.existsSync(sp))f.rmSync(dp,{force:true})}};prune(src,dir);const man='scripts/.sync-manifest.json',ms=p.join(main,man),ok=f.existsSync(ms);if(ok){f.copyFileSync(ms,man)}console.log('[hydrate] copied '+(ok?2:1)+'/2 items from '+main+(ok?'':' - but NOT '+man+' (absent there): this tree has no bundle stamp'))\\\"\"";

/**
 * The canonical marker block, inserted verbatim into every in-scope SKILL.md.
 *
 * Byte-identity across copies is the whole anti-drift mechanism — it is what
 * lets the gate compare rather than merely detect, and it is why this constant
 * exists instead of 16 hand-written paragraphs.
 *
 * **Why the remedy is INLINE and not merely cited** (2026-08-27). The block used
 * to be a pure trigger — "run `npm run skills:hydrate`, detail in the runbook" —
 * on the assumption that the substance was one hop away. In an UNADOPTED consumer
 * both hops are dead ends at once: the npm script does not exist yet (that IS the
 * symptom the block is explaining), and `docs/runbooks/` is not in the sync's
 * CORE_ASSETS, so the runbook holding Remedy 1 is absent from the repo entirely.
 * Measured 2026-08-27: neither consumer of this bundle carries the runbook, and
 * one carries no `skills:hydrate` script either. A reader hits the failure,
 * follows the pointer, finds nothing, and concludes no remedy exists — which is
 * what a consumer reported after a session of manual workarounds.
 *
 * So the block now carries `CONSUMER_HYDRATE_NPM_SCRIPT` itself. The reader needs
 * no second artifact, and byte-pinning comes for free: `checkSkill` already
 * compares this whole constant across all 16 copies, so the recipe embedded here
 * cannot drift from the one `checkDocumentedRecipes` pins in the runbook. The
 * runbook citation stays, labelled source-repo-only, because it carries the
 * rationale — the part a blocked reader does not need.
 *
 * A skill file is the ONLY carrier that reaches this reader: it is copied into the
 * worktree with the `.claude/` tree, while everything the sync writes into
 * `scripts/.claude-skills/` is by construction absent. Same rule as the runbook's
 * own — a remedy has to ride on what reaches the reader.
 */
export const MARKER_BLOCK = `> **Worktree preflight** — in a linked git worktree the synced tooling tree
> \`scripts/.claude-skills/\` is absent — it is gitignored, so \`git worktree add\`
> does not populate it, and every command below that uses it dies on a bare
> \`MODULE_NOT_FOUND\`. Run \`npm run skills:hydrate\` first.
>
> If this repo defines no such script, it has not adopted the remedy yet. Add
> this entry to its \`package.json\` \`scripts\` and run it — it copies the tooling
> tree in from the main checkout, and leans on nothing but node and git:
>
> ${CONSUMER_HYDRATE_NPM_SCRIPT}
>
> Rationale (source repo only — \`docs/runbooks/\` is not synced to consumers):
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
 *
 * That still holds for the PROSE. It stopped holding for the whole block on
 * 2026-08-27, when the remedy was inlined: `CONSUMER_HYDRATE_NPM_SCRIPT` is a
 * node one-liner, and every such one-liner carries `require` and `process.exit`
 * — two ENFORCEMENT_VERBS — with no phrasing available that avoids them. So the
 * recipe line is dispositioned as an `ignoredCandidates` entry in all 16
 * contracts, which is what that field is for: a line carrying a verb while
 * making no enforcement claim. Editing the constant re-fires the check and the
 * 16 dispositions have to be re-stated; that is the price of the recipe
 * reaching a reader who can reach nothing else, and it is worth paying.
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
 * The ONE spelling of each pending-note command.
 *
 * `/ship` Step 2 READS the notes and Step 6.8 WRITES one, so the two must reach
 * the same store — and they carried hand-copied recipes with nothing comparing
 * them. That is the producer/consumer-must-agree class this repo keeps fixing,
 * reappearing inside a single document. `checkDocumentedRecipes` compares every
 * copy against these constants, so N copies stay legal and DISAGREEMENT does not
 * — the same shape as `MARKER_BLOCK` above.
 *
 * **These were one `node -e` one-liner resolving a single fixed filename until
 * 2026-09-07.** Path agreement was all it could enforce; it never asked how many
 * notes that path can hold, and the answer was one, overwritten without a look
 * (upstream b02d80b3). Occupancy is now code — `readPendingNotes` /
 * `writePendingNote` / `clearPendingNotes` below — for the same reason this
 * constant exists rather than a note asking two steps to stay in sync.
 *
 * Named BY PATH, never as an `npm run` alias: the path is rewritten into a
 * consumer's `scripts/.claude-skills/` by the sync, an alias is not.
 */
export const PENDING_NOTE_READ_RECIPE = 'node scripts/lib/worktree-preflight.mjs pending-note read';
export const PENDING_NOTE_WRITE_RECIPE = 'node scripts/lib/worktree-preflight.mjs pending-note write';

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
    // `excludes` disambiguates two recipes that share a substring. Both are node
    // one-liners resolving the main checkout via `--git-common-dir`, so ship's
    // (marker `--git-common-dir`, needs `node -e`) also matches the hydrate
    // recipe now inlined in every skill's MARKER_BLOCK — and compared it against
    // the WRONG canonical, reporting drift on a line that is byte-correct. A
    // subject claims a line only when no other subject's key appears on it.
    { file: 'skills/ship/SKILL.md', marker: 'pending-note read', canonical: PENDING_NOTE_READ_RECIPE, needs: 'node scripts/lib/worktree-preflight.mjs' },
    { file: 'skills/ship/SKILL.md', marker: 'pending-note write', canonical: PENDING_NOTE_WRITE_RECIPE, needs: 'node scripts/lib/worktree-preflight.mjs' },
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
      if (s.excludes?.some((x) => raw.includes(x))) continue;
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

// ── Ship pending-notes: occupancy, not just path agreement ──────────────────

/**
 * `/ship` Step 6.8 writes a consumer-verification note that Step 2 of the NEXT
 * ship reads, prepends to `status.md` and deletes. That handoff used ONE fixed
 * filename, written unconditionally, with no existence check — and the gap
 * between a write and the next read is unbounded, because Step 2 only runs
 * inside `/ship` and not every status.md commit is a ship. A second ship inside
 * that gap destroyed an unread note by following the step as written. Hit live
 * 2026-09-06: a verified note was still unread ~10 hours later when the next
 * Step 6.8 ran (upstream b02d80b3).
 *
 * `MAIN_CHECKOUT_PATH_RECIPE` above already made the reader and the writer
 * resolve the same PATH, with `checkDocumentedRecipes` proving it. It never
 * asked how many notes that path can hold. These functions answer the second
 * question the same way: in code, so the invariant cannot be restated wrongly
 * in prose. One file per ship, unique by construction, drained oldest-first.
 */
export const PENDING_NOTE_PREFIX = 'ship-verification-';
export const PENDING_NOTE_SUFFIX = '.md';
/**
 * The pre-2026-09-07 single-occupancy filename. Still MATCHED (never written),
 * so a note left by the old step is drained rather than stranded by the fix.
 */
export const LEGACY_PENDING_NOTE = 'ship-verification-pending.md';

/** The MAIN checkout's note directory — the one tree that outlives a session. */
export function pendingNoteDir(mainCheckout) {
  return path.join(mainCheckout, '.claude', 'tmp');
}

/**
 * `ship-verification-<sha>-<compact ISO>.md`.
 *
 * The sha says WHICH ship the note is about; the timestamp makes the name
 * unique even when one sha is shipped twice, so a write can never land on an
 * unread note. Both are readable in a directory listing, which is where an
 * operator looks when the handoff seems to have gone missing.
 */
export function pendingNoteName(sha, when = new Date()) {
  const shortSha = String(sha || 'unknown').trim().slice(0, 12).replace(/[^0-9a-zA-Z]/g, '') || 'unknown';
  const stamp = when.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `${PENDING_NOTE_PREFIX}${shortSha}-${stamp}${PENDING_NOTE_SUFFIX}`;
}

/**
 * Chronological key for a note filename. Legacy notes have no timestamp, so
 * they sort FIRST — they are by definition older than anything written since
 * the per-ship naming landed.
 */
export function pendingNoteSortKey(name) {
  if (name === LEGACY_PENDING_NOTE) return '';
  const m = /-(\d{8}T\d{6}Z)\.md$/.exec(name);
  return m ? m[1] : '';
}

/**
 * Every pending note in the main checkout, OLDEST FIRST.
 *
 * Never throws: an absent directory is an empty list, which is the normal state
 * between ships. An unreadable one is reported as an error rather than an empty
 * list — "nothing pending" and "could not look" must not be the same answer.
 *
 * @returns {{ok: boolean, notes: Array<{name:string, path:string, text:string}>, error?: string}}
 */
export function readPendingNotes(mainCheckout, io = {}) {
  const readdir = io.readdir ?? ((d) => fs.readdirSync(d));
  const readFile = io.readFile ?? ((p) => fs.readFileSync(p, 'utf-8'));
  const exists = io.exists ?? ((p) => fs.existsSync(p));
  const dir = pendingNoteDir(mainCheckout);
  if (!exists(dir)) return { ok: true, notes: [] };
  let entries;
  try { entries = readdir(dir); }
  catch (err) { return { ok: false, notes: [], error: `cannot read ${dir}: ${err.message}` }; }
  const names = entries
    .filter((n) => n === LEGACY_PENDING_NOTE
      || (n.startsWith(PENDING_NOTE_PREFIX) && n.endsWith(PENDING_NOTE_SUFFIX)))
    // Key FIRST, then name — concatenating the two put the legacy note (empty
    // key) AFTER a timestamped one, which is backwards: it is the oldest.
    .sort((a, b) => pendingNoteSortKey(a).localeCompare(pendingNoteSortKey(b)) || a.localeCompare(b));
  const notes = [];
  for (const name of names) {
    const p = path.join(dir, name);
    try { notes.push({ name, path: p, text: readFile(p) }); }
    catch (err) { return { ok: false, notes: [], error: `cannot read ${p}: ${err.message}` }; }
  }
  return { ok: true, notes };
}

/**
 * Write one note. Returns the path written.
 *
 * No existence check is needed and none is performed — the name carries a
 * timestamp, so this cannot collide with an unread note. That is the point: the
 * race is removed by construction rather than by asking the writer to look
 * first, the same reason `checkDocumentedRecipes` exists instead of a comment
 * saying "keep these in sync".
 */
export function writePendingNote(mainCheckout, sha, text, io = {}) {
  const mkdir = io.mkdir ?? ((d) => fs.mkdirSync(d, { recursive: true }));
  const write = io.writeFile ?? ((p, t) => fs.writeFileSync(p, t));
  const now = io.now ?? new Date();
  const dir = pendingNoteDir(mainCheckout);
  mkdir(dir);
  const p = path.join(dir, pendingNoteName(sha, now));
  write(p, text.endsWith('\n') ? text : `${text}\n`);
  return p;
}

/**
 * Delete the notes NAMED by the caller — never "everything currently there".
 *
 * A blanket delete would reopen the defect one step later: a note written
 * between the read and the clear would be destroyed unread. The caller passes
 * back exactly the names `readPendingNotes` handed it, so a note that arrived
 * in between survives to the next drain.
 *
 * @returns {{deleted: string[], missing: string[]}}
 */
export function clearPendingNotes(mainCheckout, names, io = {}) {
  // The 4-property form the repo-wide rmSync guard requires: a Windows AV or
  // indexer holding a handle turns a delete into a transient EPERM/EBUSY.
  const rm = io.rm ?? ((p) => fs.rmSync(p, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 }));
  const exists = io.exists ?? ((p) => fs.existsSync(p));
  const dir = pendingNoteDir(mainCheckout);
  const deleted = [];
  const missing = [];
  for (const raw of names) {
    // Basenames only: this deletes files, and a caller-supplied path must not
    // be able to reach outside the note directory.
    const name = path.basename(String(raw));
    if (name !== LEGACY_PENDING_NOTE
      && !(name.startsWith(PENDING_NOTE_PREFIX) && name.endsWith(PENDING_NOTE_SUFFIX))) {
      missing.push(name);
      continue;
    }
    const p = path.join(dir, name);
    if (!exists(p)) { missing.push(name); continue; }
    rm(p);
    deleted.push(name);
  }
  return { deleted, missing };
}

// ── CLI: `pending-note read|write|clear` ────────────────────────────────────
//
// A module rather than a top-level script, and run BY PATH from the two
// `/ship` steps, exactly as Step 6.8 already runs
// `lib/sync-isolation-verify.mjs`: naming synced tooling by path is what makes
// the command survive the rewrite into a consumer's `scripts/.claude-skills/`.

/** Resolve the MAIN checkout — the one tree guaranteed to outlive a session. */
export function resolveMainCheckout(run) {
  const common = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  if (!common) throw new Error('git could not resolve --git-common-dir');
  return path.resolve(path.dirname(common));
}

function readAllStdin() {
  try { return fs.readFileSync(0, 'utf-8'); } catch { return ''; }
}

async function pendingNoteMain(argv) {
  const { assertKnownFlags, ArgvError, finishAndExit } = await import('./cli-io.mjs');
  const KNOWN = ['--sha', '--notes', '--json'];
  const sub = argv[3] ?? '';
  try {
    assertKnownFlags(argv, KNOWN, { cli: 'worktree-preflight pending-note', from: 4 });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); return finishAndExit(2); }
    throw err;
  }
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i !== -1 ? (argv[i + 1] ?? null) : null;
  };
  const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
  let main;
  try { main = resolveMainCheckout(run); }
  catch (err) {
    process.stderr.write(`[pending-note] ${err.message}\n`);
    return finishAndExit(2);
  }

  if (sub === 'read') {
    const res = readPendingNotes(main);
    if (!res.ok) {
      // "could not look" is not "nothing pending" — never render it as one.
      process.stderr.write(`[pending-note] ${res.error}\n`);
      return finishAndExit(1);
    }
    const out = res.notes.map((n) => `<!-- ${n.name} -->\n${n.text.trimEnd()}`).join('\n\n');
    process.stdout.write(res.notes.length
      ? `${out}\n\n<!-- ${res.notes.length} note(s). After prepending them to status.md, delete exactly these: `
        + `pending-note clear --notes ${res.notes.map((n) => n.name).join(',')} -->\n`
      : '<!-- no pending consumer-verification notes -->\n');
    return finishAndExit(0);
  }

  if (sub === 'write') {
    const sha = flag('--sha') || (() => {
      try { return run('git', ['rev-parse', '--short', 'HEAD']).trim(); } catch { return 'unknown'; }
    })();
    const text = readAllStdin();
    if (!text.trim()) {
      process.stderr.write('[pending-note] refusing to write an empty note (body is read from stdin)\n');
      return finishAndExit(2);
    }
    const p = writePendingNote(main, sha, text);
    process.stdout.write(`[pending-note] wrote ${p}\n`);
    return finishAndExit(0);
  }

  if (sub === 'clear') {
    const names = (flag('--notes') || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) {
      // Deliberately not "clear everything": a note written between the read
      // and this call must survive, or the fix reopens the defect one step on.
      process.stderr.write('[pending-note] --notes is required — pass exactly the names `pending-note read` printed\n');
      return finishAndExit(2);
    }
    const res = clearPendingNotes(main, names);
    process.stdout.write(`[pending-note] deleted ${res.deleted.length}`
      + (res.missing.length ? `, ${res.missing.length} not found: ${res.missing.join(', ')}` : '') + '\n');
    return finishAndExit(res.missing.length ? 1 : 0);
  }

  process.stderr.write('usage: worktree-preflight.mjs pending-note read|write|clear\n');
  return finishAndExit(2);
}

const _isCli = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (_isCli) {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  if (process.argv[2] === 'pending-note') {
    pendingNoteMain(process.argv).catch((err) => {
      process.stderr.write(`[pending-note] fatal: ${err?.message || err}\n`);
      process.exit(1);
    });
  } else {
    process.stderr.write('usage: worktree-preflight.mjs pending-note read|write|clear\n');
    process.exit(2);
  }
}
