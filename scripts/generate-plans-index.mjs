#!/usr/bin/env node
/**
 * @fileoverview Generates `docs/plans/README.md` — a status-bucketed index of
 * every plan, so the 150+-file plans directory is navigable without moving
 * files.
 *
 * ## Why an index instead of an archive directory
 *
 * `docs/plans/` → `docs/completed/` archiving was deleted by
 * `docs/plans/reference-integrity-gate.md` Cluster C: moving a completed plan
 * silently broke every inbound reference to it (including references from
 * source comments, which no docs linter sees).
 *
 * The underlying rule is narrower than "never organise": a path is an
 * **identity**, `Status:` is a **fact that changes**. Encoding a mutable fact
 * in an immutable identifier is what broke. Deriving a *view* from that fact
 * costs nothing and breaks nothing — so navigability is solved by generating
 * this index, not by relocating files.
 *
 * ## Contract
 *
 * - Status parsing is delegated to `lib/plan-status.mjs` (`parsePlanStatus`) —
 *   the single source of truth, shared with the `plans:status` lint. Nothing
 *   here re-implements the parse (same R1-H2 rule that module documents).
 * - Output is a **category-B generated artefact** per AGENTS.md: a pure,
 *   deterministic function of committed source, committed to git, and
 *   freshness-verified in the pre-push `check`. It therefore contains **no
 *   clock, no git sha, no machine-specific path** — two regenerations on the
 *   same commit are byte-identical.
 *
 * Usage:
 *   node scripts/generate-plans-index.mjs           # write docs/plans/README.md
 *   node scripts/generate-plans-index.mjs --check   # exit 1 if stale (CI/pre-push)
 *
 * @module scripts/generate-plans-index
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parsePlanStatus, isAuditSummary } from './lib/plan-status.mjs';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';

/**
 * Every flag this CLI accepts. None take a value.
 *
 * `--check` is a SAFE mode over a MUTATING default (the bare invocation
 * overwrites the committed `docs/plans/README.md`), so a silently-dropped
 * `--chek` would rewrite the artifact while the operator believed they were
 * only verifying its freshness.
 */
const KNOWN_FLAGS = ['--check', '--selfcheck-relocation'];

const PLANS_DIR = 'docs/plans';
const INDEX_NAME = 'README.md';
const G = '\x1b[32m', R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m', B = '\x1b[1m';

/** First `# ` heading, minus a leading `Plan: ` prefix. Falls back to the filename. */
function extractTitle(content, name) {
  const m = content.match(/^#\s+(.+?)\s*$/m);
  if (!m) return name.replace(/\.md$/, '');
  return m[1].replace(/^Plan:\s*/i, '').trim();
}

/**
 * Strip a `(…)` wrapper, but only when it spans the WHOLE detail.
 *
 * Unconditional stripping is right only for a fully-wrapped detail
 * (`Complete (superseded by X)` → `superseded by X`), and this was previously
 * done in two independent halves: `(` came off with the leading separators,
 * `)` came off with a trailing-anchored replace. Each half then fired on
 * details the other did not, rendering an orphan bracket into the COMMITTED
 * index that every reader of docs/plans/README.md sees:
 *
 *   - closes early — `Complete (cross-host unverified) — E1–E6 not run`
 *     lost its opener   → `cross-host unverified) — E1–E6 not run`
 *   - opens late   — `Complete — shipped (partly)`
 *     lost its closer   → `shipped (partly`
 *
 * The pair is now decided together, which is the only way either half can be
 * right: unwrap when the opener's match is the last character, otherwise leave
 * the text as authored. Balance-scanned rather than `indexOf(')')` so a nested
 * pair (`(see (2) below)`) is measured, not mis-split; an UNBALANCED string is
 * returned untouched, because a malformed status is the author's to fix and
 * guessing at it is how the orphan reached the index in the first place.
 */
function unwrapWholeParenthetical(text) {
  if (!text.startsWith('(')) return text;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i === text.length - 1 ? text.slice(1, -1).trim() : text;
    }
  }
  return text;
}

/**
 * The remainder of the Status line after the vocabulary token — the "why" a
 * human wants in the index (e.g. "Cluster B pending"). Trimmed of leading
 * separators and markdown emphasis, clipped so the table stays readable.
 *
 * Takes `parsePlanStatus`'s own `raw`, deliberately: this used to re-find the
 * Status line with a second copy of the header slice and the anchored regex,
 * which is the exact duplication `lib/plan-status.mjs` documents as how the
 * dashboard once drifted into showing a status it had not bucketed. It also
 * silently inherited the fragment bug — `$`-anchored, so a WRAPPED status (52
 * of the plans here) contributed only its first line, rendered with no ellipsis
 * and therefore indistinguishable from a complete note. Reading `raw` fixes
 * both at once, and any future widening of what counts as the status value
 * lands in one place.
 */
export function extractStatusDetail(raw, token) {
  if (!raw) return '';
  let rest = raw.replace(/\*\*|__/g, '').trim().slice(token.length);
  // `(` is deliberately NOT in this separator class — see unwrapWholeParenthetical.
  rest = unwrapWholeParenthetical(rest.replace(/^[\s—–:,.;-]+/, '').trim());
  rest = rest.replace(/\s+/g, ' ').replace(/\|/g, '\\|');
  return rest.length > 110 ? `${rest.slice(0, 107)}…` : rest;
}

/**
 * The plan filenames to index — **git-tracked files only**, via `git ls-files`.
 *
 * Load-bearing (not a stylistic choice): this artefact is committed and
 * freshness-gated, so it must be a function of *committed* source. Enumerating
 * with `fs.readdirSync` would fold in the working tree — an untracked local
 * draft would get baked into the committed index, giving every other clone a
 * broken link AND a failing `plans:index:check` they cannot fix (they
 * regenerate without that file and get a mismatch). Tracked-only enumeration
 * makes the output reproducible from any clone at the same commit.
 */
function trackedPlanNames(dir) {
  const out = execFileSync('git', ['ls-files', '-z', '--', `${PLANS_DIR}/*.md`], {
    cwd: path.resolve(dir, '..', '..'), encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024,
  });
  return out.split('\0')
    .filter(Boolean)
    .map(p => path.basename(p.trim()))
    // Shallow, like the status lint: `docs/plans/security/PLAN.md` is not a
    // top-level plan, and basename() would collide it with a real one.
    .filter((n, i, a) => a.indexOf(n) === i)
    .filter(n => n.endsWith('.md') && n !== INDEX_NAME);
}

/** Read every tracked plan file and classify it. Sorted by name for determinism. */
export function collectPlans(dir) {
  const tracked = new Set(trackedPlanNames(dir));
  const names = fs.readdirSync(dir)
    .filter(n => n.endsWith('.md') && n !== INDEX_NAME && tracked.has(n))
    .sort();

  const rows = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    try { if (!fs.statSync(abs).isFile()) continue; } catch { continue; }
    const content = fs.readFileSync(abs, 'utf8');
    const title = extractTitle(content, name);

    if (isAuditSummary(name)) {
      rows.push({ name, title, bucket: 'audit-summary', token: '', detail: '' });
      continue;
    }
    const s = parsePlanStatus(content);
    if (!s.ok) {
      // `absent` = not a plan document (a reference//note that lives here).
      rows.push({
        name, title, token: '', detail: '',
        bucket: s.reason === 'absent' ? 'unstatused' : 'malformed',
      });
      continue;
    }
    rows.push({
      name, title, token: s.token, bucket: s.kind,
      detail: extractStatusDetail(s.raw, s.token),
    });
  }
  return rows;
}

function table(rows, { showStatus = true } = {}) {
  const head = showStatus
    ? '| Plan | Status | Notes |\n|---|---|---|\n'
    : '| Plan | Notes |\n|---|---|\n';
  return head + rows.map(r => showStatus
    ? `| [${r.title}](./${r.name}) | \`${r.token}\` | ${r.detail} |`
    : `| [${r.title}](./${r.name}) | ${r.detail} |`
  ).join('\n') + '\n';
}

export function renderIndex(rows) {
  const active = rows.filter(r => r.bucket === 'active');
  const terminal = rows.filter(r => r.bucket === 'terminal');
  // `bucket` IS `kind` (see collect above), so a vocabulary kind with no
  // section here would be silently dropped from the index — the same
  // invisibility a non-conforming Status line causes, one layer along.
  const parked = rows.filter(r => r.bucket === 'parked');
  const summaries = rows.filter(r => r.bucket === 'audit-summary');
  const unstatused = rows.filter(r => r.bucket === 'unstatused');
  const malformed = rows.filter(r => r.bucket === 'malformed');

  let out = '';
  out += '# Plans index\n\n';
  out += '> **Generated file — do not edit.** Regenerate with `npm run plans:index`.\n';
  out += '> Freshness is enforced by `npm run plans:index:check` in the pre-push `check`.\n\n';
  out += 'Plans are indexed by their `Status:` line, **not** by directory. A plan keeps\n';
  out += 'the same path for its whole lifecycle — moving completed plans into an archive\n';
  out += 'directory silently broke every inbound reference to them, which is why the\n';
  out += 'archiver was deleted ([`reference-integrity-gate.md`](./reference-integrity-gate.md)\n';
  out += 'Cluster C). A path is an identity; status is a fact that changes. This index is\n';
  out += 'the derived view that makes status navigable without touching identity.\n\n';
  out += `**${active.length} active · ${terminal.length} terminal · ${summaries.length} audit summaries`;
  out += `${parked.length ? ` · ${parked.length} parked` : ''}`;
  out += `${unstatused.length ? ` · ${unstatused.length} reference docs` : ''}`;
  out += `${malformed.length ? ` · ${malformed.length} malformed` : ''}**\n\n`;

  out += '---\n\n## Active\n\n';
  out += 'Work that is not finished — `Draft`, `Approved`, or `In Progress`.\n';
  out += 'This is the list to read when asking "what is in flight?".\n\n';
  out += active.length ? table(active) : '_None — every plan is in a terminal state._\n';

  if (parked.length) {
    out += '\n## Parked\n\n';
    out += 'Consciously shelved — not abandoned, not superseded, and not in flight.\n';
    out += 'Deliberately listed SEPARATELY from Active: parked work should not be\n';
    out += 'chased for progress, but filing it as terminal would lose that it can\n';
    out += 'resume. Read this list when asking "what did we decide to defer?".\n\n';
    out += table(parked);
  }

  if (malformed.length) {
    out += '\n## ⚠️ Malformed status\n\n';
    out += 'These have a `Status:` line the closed vocabulary does not recognise.\n';
    out += '`npm run plans:status` fails on these — fix the status line.\n\n';
    out += table(malformed, { showStatus: false });
  }

  const superseded = terminal.filter(r => r.token === 'Superseded');
  const complete = terminal.filter(r => r.token !== 'Superseded');

  if (superseded.length) {
    out += '\n## Superseded / abandoned\n\n';
    out += 'Decided against, replaced, or overtaken — these did **not** ship as written.\n';
    out += 'Listed openly (not collapsed) because "why did we not do this?" is asked far\n';
    out += 'more often than "how did this ship?", and the answer is usually here.\n\n';
    out += table(superseded, { showStatus: false });
  }

  out += '\n## Complete\n\n';
  out += 'Shipped. Kept in place so every inbound reference — including the ones in\n';
  out += 'source comments that no docs linter sees — stays valid.\n\n';
  out += '<details>\n<summary>Show all ' + complete.length + ' completed plans</summary>\n\n';
  out += table(complete);
  out += '\n</details>\n';

  if (summaries.length) {
    out += '\n## Audit summaries\n\n';
    out += 'Companion `*-audit-summary.md` records. Exempt from the status vocabulary\n';
    out += '(they carry a free-text convergence sentence by convention).\n\n';
    out += '<details>\n<summary>Show all ' + summaries.length + ' audit summaries</summary>\n\n';
    out += table(summaries, { showStatus: false });
    out += '\n</details>\n';
  }

  if (unstatused.length) {
    out += '\n## Reference documents\n\n';
    out += 'Files in `docs/plans/` with no `Status:` line — contract matrices,\n';
    out += 'inventories, and notes rather than plans.\n\n';
    out += '<details>\n<summary>Show all ' + unstatused.length + ' reference documents</summary>\n\n';
    out += table(unstatused, { showStatus: false });
    out += '\n</details>\n';
  }

  return out;
}

function main() {
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'generate-plans-index' });

  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const dir = path.resolve(PLANS_DIR);
  const target = path.join(dir, INDEX_NAME);
  const rendered = renderIndex(collectPlans(dir));
  const check = process.argv.includes('--check');

  if (check) {
    let current = null;
    try { current = fs.readFileSync(target, 'utf8'); } catch { /* missing */ }
    if (current === rendered) {
      console.log(`${G}✓${X} plans:index — ${PLANS_DIR}/${INDEX_NAME} is up to date.`);
      process.exit(0);
    }
    console.error(`\n${R}${B}✗ plans:index${X} — ${PLANS_DIR}/${INDEX_NAME} is ${current === null ? 'missing' : 'stale'}.`);
    console.error(`${D}  A plan's Status line changed (or a plan was added) without regenerating.`);
    console.error(`  Fix: npm run plans:index${X}\n`);
    process.exit(1);
  }

  atomicWriteFileSync(target, rendered);
  console.log(`${G}✓${X} plans:index — wrote ${PLANS_DIR}/${INDEX_NAME}`);
}

const isMain = (() => {
  try {
    const argv1 = (process.argv[1] || '').replace(/\\/g, '/');
    return import.meta.url === `file://${argv1}` || import.meta.url === `file:///${argv1}`;
  } catch { return false; }
})();
if (isMain) {
  try {
    main();
  } catch (err) {
    // A usage mistake is not a crash: print the diagnostic alone, no stack.
    if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }
}
