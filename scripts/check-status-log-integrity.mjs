#!/usr/bin/env node
/**
 * @fileoverview Gate: the session log never loses history.
 *
 * **The gap this closes.** PR #87 replaced `status.md` with a single entry,
 * destroying 19,257 lines; PR #88 restored them (`3a17bbce` — 19,257
 * insertions, 0 deletions). It reached `main` through a full `npm run check`
 * and a pre-push run, because **nothing measures the log's size, entry count,
 * or oldest date.** A partial Read then a whole-file Write is all it took.
 *
 * **This gate FAILS CLOSED, unlike the advisory debt checks.** Those report
 * `unverifiable` and exit 0 because they describe a machine-local file that the
 * current commit cannot change. This one guards irreversible history loss, and
 * a data-integrity gate that cannot see its baseline provides *zero* protection
 * precisely where merges land. So an unresolvable push base exits non-zero.
 * Any workflow running it needs `fetch-depth: 2` or greater.
 *
 * **The base is the whole push, not `HEAD^`.** Hardcoding the parent is
 * bypassable on a multi-commit push: an earlier commit deletes history, the tip
 * changes something unrelated, and a HEAD-vs-HEAD^ comparison sees no loss
 * because both sides already lack it. `scripts/lib/push-range.mjs` is this
 * repo's single range resolver, and AGENTS.md's rule is explicit: gates must
 * not re-infer a base from working-tree state.
 *
 * **AN EMPTY COMMIT RANGE IS NOT AN EMPTY COMPARISON (fixed 2026-11-13).**
 * `curr` is read from the WORKING TREE, `prev` from git. So when the resolved
 * base equals HEAD — a fully-pushed branch, or a fresh worktree branched at the
 * default-branch tip — `base..HEAD` spans no commits, but the working tree can
 * still hold a delta, and PR #87's own defect class (a partial Read then a
 * whole-file Write) is a working-tree event. This gate used to refuse on the
 * PROXY `base == HEAD`, which made it blind to exactly that, on 6 of 17 live
 * worktrees. It now refuses on the REAL condition — the two states are
 * identical — asked after both have been read. Fail-closed is unchanged:
 * nothing to compare is still exit 2, never a "conserved" that read nothing.
 * A run that compared only the working tree says so in its summary and sets
 * `comparedWorkingTreeOnly` in `--json`, so a green is never read as covering
 * a span of commits it never saw.
 * Measurement: docs/research/status-integrity-gate-base-measurement-2026-11-13.md
 *
 * Exit codes: 0 conserved · 1 history lost · 2 cannot verify (fail-closed).
 *
 * Usage:
 *   node scripts/check-status-log-integrity.mjs [--base <ref>] [--json]
 *
 * Plan: docs/plans/backlog-and-drift-reduction.md §2 A9, Phase 12.
 *
 * @module scripts/check-status-log-integrity
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertKnownFlags, ArgvError, argOption, finishAndExit } from './lib/cli-io.mjs';
import { checkConservation } from './lib/status-log-integrity.mjs';
import { ENTRIES_DIR, MARKER_REL, entryStateOnDisk, isArchivePath, isEntryRecordPath, perEntryMode } from './lib/status-entry-files.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT_LOG = 'status.md';
const ARCHIVE_DIR = 'docs/status';
const MANIFEST = 'docs/status/rotation-manifest.json';

function git(args, opts = {}) {
  // `stdio: pipe` on stderr: a `git show` for a path that does not exist at the
  // base is an EXPECTED miss (no archives before the first rotation), and its
  // `fatal:` line on the terminal reads like a failure when it is not.
  return execFileSync('git', args, {
    cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'], ...opts,
  });
}

/** Read a path at a revision; `null` when it does not exist there. */
function showAt(rev, rel) {
  try { return git(['show', `${rev}:${rel}`]); } catch { return null; }
}

/** Every `docs/status/*.md` at a revision. */
function archivesAt(rev) {
  const out = {};
  // An absent directory lists as empty with exit 0, so a throw is a real failure, never "no archives".
  const listing = git(['ls-tree', '-r', '--name-only', rev, `${ARCHIVE_DIR}/`]);
  for (const rel of listing.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.md') && isArchivePath(l))) {
    const text = showAt(rev, rel);
    if (text === null) throw new Error(`${rel} is listed at ${rev.slice(0, 8)} but cannot be read`);
    out[rel] = text;
  }
  return out;
}

/** The per-entry state at a revision: the marker, the entry records, and any foreign file in the directory. */
function entryStateAt(rev) {
  // A path absent at `rev` lists as empty with exit 0, so a THROW here is a real failure (bad rev,
  // corrupt object) and must not be read as "no entries": it would blind Laws 7 and 9.
  // The ONE marker policy (also entryStateOnDisk's): a regular file. `ls-tree` modes 100644/100755 are
  // regular; 120000 (a symlink) and 160000 (a submodule) are not, so they are named as strays.
  const listing = git(['ls-tree', '-r', rev, `${ENTRIES_DIR}/`]);
  const paths = [];
  const strays = [];
  for (const line of listing.split('\n').filter(Boolean)) {
    const m = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/.exec(line);
    if (!m) throw new Error(`unparseable ls-tree line at ${rev.slice(0, 8)}: ${line}`);
    if (m[1] === '100644' || m[1] === '100755') paths.push(m[2]); else strays.push(m[2]);
  }
  const entries = {};
  for (const rel of paths) {
    if (rel === MARKER_REL) continue;
    if (!isEntryRecordPath(rel)) { strays.push(rel); continue; }
    const text = showAt(rev, rel);
    if (text === null) throw new Error(`${rel} is listed at ${rev.slice(0, 8)} but cannot be read`);
    entries[rel] = text;
  }
  return { marker: perEntryMode(paths), entries, strays };
}

function archivesOnDisk() {
  const out = {};
  const dir = path.join(REPO, ARCHIVE_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch (err) {
    if (err.code === 'ENOENT') return out; // no archives yet; any other failure is not "none"
    throw err;
  }
  for (const n of names) {
    if (!isArchivePath(`${ARCHIVE_DIR}/${n}`) || !n.endsWith('.md')) continue;
    out[`${ARCHIVE_DIR}/${n}`] = fs.readFileSync(path.join(dir, n), 'utf-8');
  }
  return out;
}

function parseManifest(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Resolve a caller-supplied `--base` to an immutable commit, and refuse the
 * ranges that cannot detect anything.
 *
 * A ref that is not an ancestor of HEAD describes a range this push did not
 * make, and an unresolvable one cannot be diffed at all. Both are refusals,
 * not warnings — the same fail-closed rule the unresolvable-base path already
 * follows, and AGENTS.md's "an unresolvable explicit base fails hard, never
 * demotes to inference".
 *
 * `base == HEAD` is NOT refused here, and that is the 2026-11-13 fix. It used
 * to be, on the stated grounds that "the previous and current states would be
 * identical" — but that is a PROXY for the real condition, and it is false
 * whenever the tree is dirty, because `curr` is read from DISK and `prev` from
 * git. The caller therefore gets `emptyRange: true` and must decide AFTER
 * reading both states, which is the only point at which "there is nothing to
 * compare" can be known rather than assumed. See `refuseIfNothingToCompare`.
 *
 * @returns {{oid: string, emptyRange: boolean}} the resolved OID, and whether
 *   `base..HEAD` spans no commits (so only the working tree can supply a delta)
 * @throws {Error} with an operator-facing message
 */
function validateExplicitBase(explicit, rangeNote = null) {
  let oid;
  try {
    oid = git(['rev-parse', '--verify', `${explicit}^{commit}`]).trim();
  } catch {
    throw new Error(`--base "${explicit}" does not resolve to a commit.`);
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  if (oid === head) return { oid, emptyRange: true, rangeNote, explicit };
  try {
    git(['merge-base', '--is-ancestor', oid, head]);
  } catch {
    throw new Error(
      `--base "${explicit}" (${oid.slice(0, 8)}) is not an ancestor of HEAD — that range is not this push.`,
    );
  }
  return { oid, emptyRange: false, rangeNote, explicit };
}

/**
 * Canonical bytes of a comparable state, so key ORDER can never fake a
 * difference. `prev` is built from `git ls-tree` / `git show` and `curr` from
 * `readdirSync` / `readFileSync`: the same content arrives through two
 * different enumerations, so a plain `JSON.stringify` of either would compare
 * orderings rather than content — which on this gate would mean claiming a
 * delta exists when none does, and running the laws on a vacuous pair.
 *
 * Only the fields `checkConservation` actually reads are included. A field it
 * ignores cannot make a comparison substantive.
 */
function canonicalState(s) {
  const sortedMap = (m) => Object.keys(m ?? {}).sort().map((k) => [k, m[k]]);
  const sortedJson = (v) => (v === null || v === undefined
    ? null
    : JSON.stringify(v, (_k, val) => (
      val && typeof val === 'object' && !Array.isArray(val)
        ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
        : val
    )));
  return JSON.stringify({
    root: s.root ?? '',
    archives: sortedMap(s.archives),
    manifest: sortedJson(s.manifest),
    marker: s.marker ?? null,
    entries: sortedMap(s.entries),
    strays: [...(s.strays ?? [])].sort(),
  });
}

/**
 * The empty-range refusal, moved to where the answer is KNOWN.
 *
 * Failing closed on an empty range is correct and stays correct: a gate that
 * reports "conserved" having compared nothing is this gate's whole reason for
 * existing. What was wrong is WHEN the question was asked. `base == HEAD` means
 * `base..HEAD` spans no commits; it does NOT mean there is nothing to compare,
 * because this gate's `curr` is the WORKING TREE. With a status-log delta on
 * disk the comparison is substantive — measured: with the old refusal removed,
 * a disk-only truncation at `base == HEAD` reported 3 x `entry-vanished`, the
 * exact PR #87 class, which is itself a working-tree event (a partial Read then
 * a whole-file Write).
 *
 * So: refuse when the two states are genuinely IDENTICAL, which is the real
 * condition, and only in the empty-range case. Outside it, `prev == curr` is
 * the ordinary and legal "this range did not touch the log" — refusing there
 * would block almost every push.
 *
 * docs/research/status-integrity-gate-base-measurement-2026-11-13.md
 *
 * @returns {string|null} an operator-facing message, or `null` to proceed
 */
function refuseIfNothingToCompare(base, prev, curr) {
  if (!base.emptyRange) return null;
  if (canonicalState(prev) !== canonicalState(curr)) return null; // a real delta: the working tree's
  const { rangeNote, explicit, oid } = base;
  return `the base resolves to HEAD (${oid.slice(0, 8)})`
    + `${rangeNote ? `, via ${rangeNote}` : ` — from --base "${explicit}"`}`
    + ': the range is EMPTY and the working tree is identical to it, so there is '
    + 'genuinely nothing to compare.\n'
    + '  Expected on a fully-pushed branch with a clean tree, and on a fresh worktree '
    + 'branched at the default-branch tip (no upstream, so the base is merge-base = HEAD).\n'
    + '  Failing closed rather than reporting "conserved" having read nothing. With '
    + 'uncommitted status-log changes this same run checks them; to check a span of '
    + 'commits, pass --base <ref>. The authoritative run is the pre-push hook, which '
    + 'supplies the pushed range itself.';
}

async function resolveBase(explicit) {
  if (explicit !== null && explicit !== undefined) return validateExplicitBase(explicit);
  let base = null;
  let note = null;
  try {
    const mod = await import('./lib/push-range.mjs');
    const resolver = mod.resolvePushRange || mod.default;
    if (typeof resolver === 'function') {
      const r = await resolver({ repoRoot: REPO });
      base = r?.base || r?.baseSha || r?.from || null;
      // The resolver reports WHICH rung produced the base precisely so a gate
      // can say so (push-range.mjs's honesty invariant). Reading only `base`
      // discarded it, which left an operator in the fresh-worktree case told
      // about a bare sha with no way to see the fork-point path was taken.
      if (base && typeof mod.describePushRange === 'function') {
        try { note = mod.describePushRange(r); } catch { note = null; }
      }
    }
  } catch { /* fall through to the honest failure below */ }
  if (!base) return null;
  // The INFERRED base gets the same treatment as an explicit one. Hardening
  // only the explicit path left the default — the path CI actually takes —
  // unvalidated, so a resolver returning HEAD or a non-ancestor would produce
  // a vacuous or wrong comparison with no refusal. Same rule, both doors.
  return validateExplicitBase(base, note);
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  try {
    assertKnownFlags(process.argv, ['--base', '--json', '--help', '-h', '--selfcheck-relocation'], { cli: 'check-status-log-integrity' });
  } catch (err) {
    if (err instanceof ArgvError) { process.stderr.write(`${err.message}\n`); process.exit(2); }
    throw err;
  }
  // `--flag=value` returns -1 from a bare indexOf, so the explicit argument was
  // SILENTLY IGNORED and the default used instead. Fixed in
  // rotate-status-log.mjs first and left here — the inconsistent partial fix
  // the final gate flagged twice. `argOption` handles both forms.
  // On an integrity gate this is worse than a typo: an ignored --base=<commit>
  // silently drops back to push-range inference, bypassing the boundary the
  // operator explicitly set.
  const i = process.argv.findIndex((a) => a === '--base' || a.startsWith('--base='));
  // A terminal `--base` with no value yields undefined, which a truthiness
  // test would read as 'absent' and silently fall back to inference — an
  // invalid invocation quietly becoming a different, unrequested range.
  // Only the BARE form can be valueless; `--base=x` carries its own value.
  if (i !== -1 && process.argv[i] === '--base'
      && (process.argv[i + 1] === undefined || process.argv[i + 1].startsWith('--'))) {
    process.stderr.write('status-log-integrity: --base requires a value.\n');
    process.exit(2);
  }
  const explicit = i !== -1 ? argOption('base', null) : null;
  const jsonMode = process.argv.includes('--json');

  let base;
  try {
    base = await resolveBase(explicit);
  } catch (err) {
    // A rejected explicit base is a refusal, not a fallback to inference.
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'bad-base', error: err.message })}\n`);
    else process.stderr.write(`status-log-integrity: ${err.message}\n  Failing closed.\n`);
    process.exit(2);
  }
  if (!base) {
    // FAIL CLOSED. Reporting "unverifiable, exit 0" here would silently disable
    // the gate in CI shallow clones — where merges actually land.
    const msg = 'status-log-integrity: CANNOT VERIFY — no push base resolved '
      + '(shallow clone? use fetch-depth: 2+, or pass --base <ref>).\n'
      + '  Failing closed: a data-integrity gate that cannot see its baseline protects nothing.\n';
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'cannot-verify' })}\n`);
    else process.stderr.write(msg);
    process.exit(2);
  }

  // A base that does not resolve, or that has no log to compare against, must
  // FAIL CLOSED — not report "conserved" having compared nothing.
  //
  // Found by testing this gate against a bogus `--base`: every `git show`
  // missed, `prev.root` came back empty, there were no prior entries to
  // conserve, and it printed "conserved". That is a vacuous pass — the exact
  // false-green class this plan exists to remove, reproduced in the guard
  // written to prevent it. A check must never be able to go green having
  // checked nothing.
  const oid = base.oid;
  const prevRootText = showAt(oid, ROOT_LOG);
  if (prevRootText === null) {
    const msg = `status-log-integrity: CANNOT VERIFY — no ${ROOT_LOG} at base "${oid}" `
      + '(unresolvable ref, or a shallow clone).\n'
      + '  Failing closed: an empty baseline would make any truncation look conserved.\n';
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'cannot-verify', base: oid })}\n`);
    else process.stderr.write(msg);
    process.exit(2);
  }

  const prev = {
    root: prevRootText,
    archives: archivesAt(oid),
    manifest: parseManifest(showAt(oid, MANIFEST)),
    ...entryStateAt(oid),
  };
  const curr = {
    root: fs.existsSync(path.join(REPO, ROOT_LOG)) ? fs.readFileSync(path.join(REPO, ROOT_LOG), 'utf-8') : '',
    archives: archivesOnDisk(),
    manifest: parseManifest(
      fs.existsSync(path.join(REPO, MANIFEST)) ? fs.readFileSync(path.join(REPO, MANIFEST), 'utf-8') : null,
    ),
    ...entryStateOnDisk(REPO),
  };

  // The empty-range refusal, asked now that BOTH states are in hand — the only
  // point at which "there is nothing to compare" is known rather than assumed.
  // Still fail-closed, still exit 2, still `bad-base`.
  const nothingToCompare = refuseIfNothingToCompare(base, prev, curr);
  if (nothingToCompare) {
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'bad-base', base: oid, error: nothingToCompare })}\n`);
    else process.stderr.write(`status-log-integrity: ${nothingToCompare}\n`);
    // `await finishAndExit`, not `process.exit`: on Windows a piped stdout is
    // async, so exiting here would truncate the JSON envelope a caller parses
    // — and this gate's envelope is the evidence that it refused rather than
    // crashed. We are inside the async `main()`, so it can be awaited.
    await finishAndExit(2);
    return;
  }

  const { ok, violations } = checkConservation(prev, curr);
  // An empty range that DID have a delta compared the working tree, not a span
  // of commits. Say which, so a green is never read as covering more than it did.
  const against = base.emptyRange
    ? `the working tree vs ${oid.slice(0, 8)} (empty commit range)`
    : oid.slice(0, 8);

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({
      ok, base: oid, emptyRange: base.emptyRange, comparedWorkingTreeOnly: base.emptyRange, violations,
    })}\n`);
  } else if (ok) {
    process.stdout.write(`status-log-integrity: conserved against ${against}.\n`);
  } else {
    process.stdout.write(`status-log-integrity: ${violations.length} violation(s) against ${against}\n`);
    for (const v of violations) process.stdout.write(`  ${v.kind}: ${v.detail}\n`);
    process.stdout.write('\n  status.md is append-only; once docs/status/entries/README.md exists it takes no NEW entry (add a file there).\n');
    process.stdout.write('  To archive a month, use `npm run status:rotate`,\n');
    process.stdout.write('  which records each archived entry in docs/status/rotation-manifest.json.\n');
  }
  await finishAndExit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`status-log-integrity: ${err.message}\n`);
  process.exit(2); // fail closed on an unexpected error too
});
