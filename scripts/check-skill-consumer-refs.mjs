#!/usr/bin/env node
/**
 * @fileoverview Delivery gate for pointers inside SYNCED skill content.
 *
 * A SKILL.md is read in a consumer repo, where the only things that exist are
 * what the sync put there. Two kinds of pointer routinely name something that
 * cannot be there:
 *
 *   - a `docs/…md` path — the sync closure carries almost no `docs/`, so a
 *     citation to `docs/plans/<name>.md` resolves here and nowhere else;
 *   - an `npm run X` alias — the sync DELIBERATELY never merges npm scripts
 *     into a consumer's `package.json`, so every alias this repo defines is
 *     source-repo-only by construction.
 *
 * This is a recurring defect class, not a one-off. It was fixed once for the
 * worktree bootstrap (`wtpf/bootstrap-not-shipped`, after 16 skills told
 * consumers to run `npm run skills:hydrate` and read a runbook the sync
 * delivers neither of), and the reasoning was recorded in AGENTS.md as
 * consumer defect shape (4): "a documented command whose tooling cannot be
 * present where it runs". It then recurred — `/ai-context-management` named
 * `npm run context:check` in every one of its modes while the detector it
 * wraps WAS synced; `/security-strategy` and `/ship` reached for
 * `npm run security:refresh --if-present`, which exits 0 having run nothing;
 * two shared references promised `.audit/` is swept "in every consumer" by a
 * script that was not shipped. Each was invisible to review because each
 * pointer is individually plausible.
 *
 * What this gate can and cannot see. It CANNOT decide whether an unreachable
 * pointer is a defect: "run `npm run check`" inside a source-repo-gated step is
 * correct, and `docs/security-strategy.md` is authored IN the consumer by the
 * tooling itself. Judging that needs intent. What a mechanical scan can see,
 * and what nothing else does, is the POPULATION — so this is a ratchet over
 * declared dispositions, in the shape of `emit:exit:gate` / `knip:gate`:
 *
 *   - a ref KIND that is not declared in the baseline fails, and the fix is to
 *     add an entry carrying a disposition and a written reason (or to make the
 *     pointer reachable, which is usually the better fix);
 *   - a declared kind whose site count GROWS fails — a new instance of a known
 *     exemption still has to be looked at;
 *   - a declared kind that has disappeared fails too, so the baseline cannot
 *     quietly outlive what it describes.
 *
 * Reachability is computed from the sync closure as a pure function of
 * COMMITTED source (`getSyncClosure()` + `git ls-files`), never from a
 * consumer's manifest — a consumer's tree is stale by definition, and the
 * pre-push sandbox has no consumer at all.
 *
 * Usage:
 *   node scripts/check-skill-consumer-refs.mjs            # gate
 *   node scripts/check-skill-consumer-refs.mjs --json     # machine-readable
 *   node scripts/check-skill-consumer-refs.mjs --list     # every site, grouped
 *   node scripts/check-skill-consumer-refs.mjs --update   # re-baseline (deliberate)
 *
 * @module scripts/check-skill-consumer-refs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { emit, hasFlag, assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { sanitizeGitEnv } from './lib/git-env-sanitize.mjs';
import { getSyncClosure } from './lib/sync-inventory.mjs';

const KNOWN_FLAGS = ['--json', '--list', '--update', '--selfcheck-relocation', '--help'];

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Repo-root dotfile, matching .emit-exit-baseline.json / .knip-baseline.json.
// A pure function of committed source ⇒ Category B: committed, and verified by
// this gate on every run.
const BASELINE_PATH = path.join(REPO, '.skill-consumer-refs-baseline.json');

/** Dispositions a baseline entry may declare. Anything else is rejected. */
const DISPOSITIONS = new Set([
  // The pointer names something only the source repo has, and the surrounding
  // text says so. Legal; the reason must say what a consumer does instead.
  'source-repo-only',
  // The path is created IN the consumer, by this tooling or by its own author
  // (docs/security-strategy.md, docs/architecture-map.md). Legal.
  'consumer-authored',
  // A design-rationale citation, not an instruction. Legal, but it must read as
  // provenance so a consumer agent does not go hunting for the file.
  'provenance',
  // An npm alias the ADOPTION RUNBOOK instructs a consumer to add by hand
  // (arch:*, debt:*, skills:hydrate). Still not delivered by the sync, so the
  // skill text must survive its absence — but naming it is not a mistake.
  'consumer-wired',
]);

// A markdown path under docs/. Bounded to a single line by the caller.
const DOC_RE = /(docs\/[A-Za-z0-9_.\/-]+\.md)/g;
// Mirrors lib/npm-script-enumerator.mjs's NPM_RUN_REGEX: the name must start
// and end alphanumerically so trailing prose punctuation ("run npm run audit.")
// is not captured as part of the name.
const NPM_RE = /\bnpm\s+run\s+([A-Za-z0-9_@][A-Za-z0-9_:.\-/@]*[A-Za-z0-9_/@]|[A-Za-z0-9_@])/g;

/**
 * Markdown under `skills/` that the repo OWNS — tracked, plus untracked files
 * git does not ignore.
 *
 * Sandbox-honesty (AGENTS.md) says not to walk the working tree blindly: an
 * ignored scratch `.md` would move the counts and the verdict would depend on
 * whose tree it ran in. But tracked-only is the wrong predicate, and it left a
 * hole this gate fell into on 2026-09-02: two brand-new generated reference
 * copies, each citing an out-of-closure `docs/` path AND `npm run check`, were
 * **invisible** — `git ls-files` does not list a file until it is staged, so
 * the gate passed on precisely the change being introduced and would only have
 * fired a commit later. A gate that cannot see new files cannot ratchet.
 *
 * `--others --exclude-standard` is the fix: it adds untracked files while
 * still honouring `.gitignore`, so ignored scratch stays out and genuinely new
 * content comes in. Same predicate AGENTS.md prescribes for consumer defect
 * shape (2) — "ignored AND untracked", asked of the candidates.
 *
 * **Why this does not break sandbox-honesty** (the union was challenged as a
 * repo-invariant violation, 2026-09-02, and the challenge is worth answering in
 * writing). The pre-push hook runs `check` in a fresh worktree at the commit
 * being pushed, where nothing is untracked — so there the union is a no-op and
 * the gate is exactly the pure function of committed source it claims to be.
 * Locally the union can only add an untracked, NON-ignored `.md` under
 * `skills/`, which is never scratch: `skills:check` independently rejects any
 * such file as an orphan not listed in its skill reference table. The scenario
 * the tracked-only rule protects against — a stray scratch file moving the
 * counts — is therefore already unreachable here, while the scenario it caused
 * was observed and measured.
 *
 * Returns `null` on a git failure — the caller must treat that as a hard error,
 * never as "no files", or a broken git makes this gate pass having read
 * nothing.
 */
function listOwnedSkillMarkdown(repoRoot) {
  const opts = {
    cwd: repoRoot, encoding: 'utf-8', windowsHide: true, env: sanitizeGitEnv(repoRoot),
  };
  const tracked = spawnSync('git', ['ls-files', '-z', 'skills'], opts);
  if (tracked.status !== 0) return null;
  const untracked = spawnSync('git', ['ls-files', '-z', '--others', '--exclude-standard', 'skills'], opts);
  if (untracked.status !== 0) return null;

  const out = new Set();
  for (const chunk of [tracked.stdout, untracked.stdout]) {
    for (const f of String(chunk || '').split('\0').filter(Boolean)) {
      const rel = f.replace(/\\/g, '/');
      if (rel.endsWith('.md')) out.add(rel);
    }
  }
  return [...out].sort();
}

/**
 * The files this gate judges: owned markdown under `skills/`, PLUS every other
 * markdown file the sync actually ships.
 *
 * **Why the literal directory was the wrong input** (upstream 63552e8b,
 * wine-cellar-app, 2026-09-04). This gate exists to catch a pointer a CONSUMER
 * cannot resolve, and it was reading `skills/` — a proxy for "synced content"
 * that was true when it was written and is not true now. The closure ships 783
 * paths, exactly one of which is outside `skills/` and `.claude/skills/`:
 * `docs/reference/consistency-contract.md`. That one file carried this gate's
 * own defect class (an out-of-closure `docs/plans/…` pointer) for its whole
 * history, unseen — 1 of 1 unscanned files, a 100% hit rate on the blind spot.
 *
 * Deriving the set from the closure means a NEW synced surface is enrolled the
 * day it is added, rather than silently widening the hole. Same rule as
 * `db:enrolment:gate` and `skillsInvokingSyncedTooling`: iterate the side that
 * can see what no list mentions.
 *
 * `.claude/skills/**` is excluded because it is generated FROM `skills/**`,
 * which is already in the set — scanning both would double every count and make
 * the ratchet fire on its own duplication.
 *
 * @param {string[]} owned repo-owned markdown under `skills/`
 * @param {Set<string>} closure source-relative paths the sync ships
 * @returns {string[]} sorted, de-duplicated
 */
export function subjectFiles(owned, closure) {
  const out = new Set(owned);
  for (const rel of closure) {
    if (!rel.endsWith('.md')) continue;
    if (rel.startsWith('skills/') || rel.startsWith('.claude/skills/')) continue;
    out.add(rel);
  }
  return [...out].sort();
}

/**
 * Blank the http(s) URLs on a line, preserving length so column maths still holds.
 *
 * **Why a URL must not be scanned** (2026-09-04). An absolute upstream URL
 * EMBEDS the repo-relative path — `…/blob/main/docs/plans/x.md` — so `DOC_RE`
 * matches inside it and the gate counts the pointer as unreachable. That was
 * harmless while every such path was also written relatively, and stopped being
 * harmless when the absolute upstream URL became the prescribed remedy for a
 * link in synced content (`docs:synced-links:gate`): measured immediately after
 * that fix landed, 68 of this gate's 220 sites — 31% — were the remedy being
 * counted as the disease. A gate that flags its own remedy pushes the next
 * author back to the relative link.
 *
 * A URL is reachable from a consumer BY CONSTRUCTION: it does not depend on
 * what the sync put on their disk, which is the only thing this gate reasons
 * about.
 *
 * @param {string} line
 * @returns {string}
 */
export function blankUrls(line) {
  return String(line).replace(/https?:\/\/\S+/g, (u) => ' '.repeat(u.length));
}

/**
 * Scan one markdown file for pointers that a consumer cannot resolve.
 *
 * Fenced code blocks are scanned like any other text: a command inside a
 * ```bash fence is the MOST instructional form a pointer takes, so skipping
 * fences would blind the gate to exactly the sites that matter.
 *
 * @param {string} rel repo-relative path
 * @param {string} content
 * @param {Set<string>} closure source-relative paths the sync ships
 * @returns {{kind: 'doc'|'npm', ref: string, file: string, line: number}[]}
 */
export function scanFile(rel, content, closure) {
  const out = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    // A pointer INSIDE an absolute URL is reachable by construction — see
    // blankUrls. Blanked rather than skipped so a line carrying both a URL and
    // a bare unreachable path still reports the bare one.
    const L = blankUrls(lines[i]);
    let m;
    DOC_RE.lastIndex = 0;
    while ((m = DOC_RE.exec(L)) !== null) {
      if (closure.has(m[1])) continue;
      out.push({ kind: 'doc', ref: m[1], file: rel, line: i + 1 });
    }
    NPM_RE.lastIndex = 0;
    while ((m = NPM_RE.exec(L)) !== null) {
      // Unconditional: the sync never merges npm scripts into a consumer's
      // package.json, so no alias this repo defines is reachable there. This
      // is the whole point — an `npm run` in synced skill text is a claim
      // about another repo's script table that nothing can make true.
      out.push({ kind: 'npm', ref: m[1], file: rel, line: i + 1 });
    }
  }
  return out;
}

/** Group sites into the baseline's ref-keyed shape. */
export function tally(sites) {
  const counts = new Map();
  for (const s of sites) {
    const key = `${s.kind} ${s.ref}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

/**
 * Compare the live tally against the baseline.
 *
 * Three failure directions, deliberately including the third: a baseline that
 * outlives what it describes is how an exemption list becomes folklore.
 */
export function adjudicate(counts, baseline) {
  const declared = baseline.refs || {};
  const undeclared = [];
  const grown = [];
  const stale = [];
  const malformed = [];

  for (const [key, n] of [...counts].sort()) {
    const entry = declared[key];
    if (!entry) { undeclared.push({ ref: key, count: n }); continue; }
    if (!DISPOSITIONS.has(entry.disposition)) {
      malformed.push({ ref: key, problem: `unknown disposition "${entry.disposition}"` });
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 12) {
      malformed.push({ ref: key, problem: 'reason missing or too short to be a reason' });
    }
    if (n > entry.sites) grown.push({ ref: key, was: entry.sites, now: n });
  }
  for (const key of Object.keys(declared).sort()) {
    if (!counts.has(key)) stale.push({ ref: key, was: declared[key].sites });
  }
  const shrunk = [...counts].filter(([k, n]) => declared[k] && n < declared[k].sites)
    .map(([k, n]) => ({ ref: k, was: declared[k].sites, now: n }));

  return { undeclared, grown, stale, malformed, shrunk };
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8')); }
  catch (err) { return { __parseError: err.message }; }
}

function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try { assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'check-skill-consumer-refs' }); }
  catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  if (hasFlag('help')) {
    process.stdout.write(fs.readFileSync(fileURLToPath(import.meta.url), 'utf-8')
      .split('\n').slice(1, 56).join('\n') + '\n');
    process.exit(0);
  }

  const owned = listOwnedSkillMarkdown(REPO);
  if (owned === null) {
    emit({ ok: false, error: 'git ls-files failed — refusing to report zero refs from a tree I could not read' });
    return;
  }
  const closure = new Set(getSyncClosure().files.map((f) => f.replace(/\\/g, '/')));
  const files = subjectFiles(owned, closure);

  const sites = [];
  for (const rel of files) {
    const abs = path.join(REPO, rel);
    if (!fs.existsSync(abs)) continue; // tracked but deleted in the tree
    sites.push(...scanFile(rel, fs.readFileSync(abs, 'utf-8'), closure));
  }
  const counts = tally(sites);

  if (hasFlag('list')) {
    for (const [key, n] of [...counts].sort()) {
      process.stdout.write(`${String(n).padStart(3)}  ${key}\n`);
      for (const s of sites.filter((x) => `${x.kind} ${x.ref}` === key)) {
        process.stdout.write(`       ${s.file}:${s.line}\n`);
      }
    }
    process.exit(0);
  }

  if (hasFlag('update')) {
    const prev = loadBaseline();
    const prevRefs = (prev && !prev.__parseError && prev.refs) || {};
    const refs = {};
    for (const [key, n] of [...counts].sort()) {
      refs[key] = prevRefs[key]
        ? { ...prevRefs[key], sites: n }
        : { disposition: 'source-repo-only', reason: 'TODO: state why a consumer cannot need this, and what it does instead.', sites: n };
    }
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify({
      $comment: 'Declared unreachable pointers in synced skill content. See scripts/check-skill-consumer-refs.mjs. Every entry needs a disposition and a real reason; new entries default to a TODO reason that the gate rejects.',
      totalSites: sites.length,
      refs,
    }, null, 2)}\n`);
    process.stdout.write(`re-baselined: ${Object.keys(refs).length} refs, ${sites.length} sites → ${path.relative(REPO, BASELINE_PATH)}\n`);
    process.exit(0);
  }

  const baseline = loadBaseline();
  if (!baseline) {
    emit({ ok: false, error: `baseline missing at ${path.relative(REPO, BASELINE_PATH)} — run with --update to seed it` });
    return;
  }
  if (baseline.__parseError) {
    emit({ ok: false, error: `baseline unparseable: ${baseline.__parseError}` });
    return;
  }

  const verdict = adjudicate(counts, baseline);
  const ok = verdict.undeclared.length === 0 && verdict.grown.length === 0
    && verdict.stale.length === 0 && verdict.malformed.length === 0;

  if (hasFlag('json')) {
    emit({ ok, totalSites: sites.length, refs: counts.size, ...verdict });
    return;
  }

  const R = '\x1b[31m', G = '\x1b[32m', Y = '\x1b[33m', X = '\x1b[0m';
  if (ok) {
    const note = verdict.shrunk.length ? ` ${Y}(${verdict.shrunk.length} ref(s) shrank — re-baseline to lock the gain in)${X}` : '';
    process.stdout.write(`${G}✓ skill→consumer refs: ${counts.size} declared kinds, ${sites.length} sites${X}${note}\n`);
    return;
  }
  for (const u of verdict.undeclared) {
    process.stderr.write(`${R}UNDECLARED${X} ${u.ref} (${u.count} site(s))\n`);
    for (const s of sites.filter((x) => `${x.kind} ${x.ref}` === u.ref)) {
      process.stderr.write(`           ${s.file}:${s.line}\n`);
    }
  }
  for (const g of verdict.grown) process.stderr.write(`${R}GREW${X}       ${g.ref}: ${g.was} → ${g.now} site(s)\n`);
  for (const s of verdict.stale) process.stderr.write(`${R}STALE${X}      ${s.ref}: declared ${s.was} site(s), now absent — drop it from the baseline\n`);
  for (const m of verdict.malformed) process.stderr.write(`${R}MALFORMED${X}  ${m.ref}: ${m.problem}\n`);
  process.stderr.write(
    `\nA synced SKILL.md is read in a consumer repo. A \`docs/…\` path outside the\n` +
    `sync closure, or ANY \`npm run\` alias, cannot resolve there.\n` +
    `  Best fix:  name the synced script by path (\`node scripts/x.mjs\`) — the sync\n` +
    `             rewrites it to \`scripts/.claude-skills/x.mjs\` for the consumer.\n` +
    `  Otherwise: declare it in ${path.relative(REPO, BASELINE_PATH)} with a disposition\n` +
    `             (${[...DISPOSITIONS].join(' | ')}) and a reason, and make the\n` +
    `             surrounding prose say the pointer is source-repo-only.\n`);
  emit({ ok: false, error: 'unreachable pointers in synced skill content' });
}

// `process.argv[1]` is undefined under `node --input-type=module -e`, which is
// how a test imports this module for its `scanFile`/`tally`/`adjudicate`
// exports — guard it, or the import runs main() before the exports are usable.
if (process.argv[1]?.endsWith('check-skill-consumer-refs.mjs')) {
  main();
}
