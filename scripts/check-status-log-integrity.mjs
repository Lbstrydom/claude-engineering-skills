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
import { assertKnownFlags, ArgvError, argOption } from './lib/cli-io.mjs';
import { checkConservation } from './lib/status-log-integrity.mjs';

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
  let listing;
  try { listing = git(['ls-tree', '-r', '--name-only', rev, `${ARCHIVE_DIR}/`]); } catch { return out; }
  for (const rel of listing.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.md'))) {
    const text = showAt(rev, rel);
    if (text !== null) out[rel] = text;
  }
  return out;
}

function archivesOnDisk() {
  const out = {};
  const dir = path.join(REPO, ARCHIVE_DIR);
  let names;
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names) {
    if (!n.endsWith('.md')) continue;
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
 * An unvalidated `--base` is a gate bypass: `--base HEAD` on a clean tree makes
 * the previous and current states IDENTICAL, so conservation holds vacuously
 * and any loss already committed is invisible. A ref that is not an ancestor of
 * HEAD describes a range this push did not make. Both are refusals, not
 * warnings — the same fail-closed rule the unresolvable-base path already
 * follows, and AGENTS.md's "an unresolvable explicit base fails hard, never
 * demotes to inference".
 *
 * @returns {string} the resolved OID
 * @throws {Error} with an operator-facing message
 */
function validateExplicitBase(explicit) {
  let oid;
  try {
    oid = git(['rev-parse', '--verify', `${explicit}^{commit}`]).trim();
  } catch {
    throw new Error(`--base "${explicit}" does not resolve to a commit.`);
  }
  const head = git(['rev-parse', 'HEAD']).trim();
  if (oid === head) {
    throw new Error(
      `--base "${explicit}" resolves to HEAD (${oid.slice(0, 8)}). The previous and current `
      + 'states would be identical, so conservation would hold having compared nothing.',
    );
  }
  try {
    git(['merge-base', '--is-ancestor', oid, head]);
  } catch {
    throw new Error(
      `--base "${explicit}" (${oid.slice(0, 8)}) is not an ancestor of HEAD — that range is not this push.`,
    );
  }
  return oid;
}

async function resolveBase(explicit) {
  if (explicit !== null && explicit !== undefined) return validateExplicitBase(explicit);
  let base = null;
  try {
    const mod = await import('./lib/push-range.mjs');
    const resolver = mod.resolvePushRange || mod.default;
    if (typeof resolver === 'function') {
      const r = await resolver({ repoRoot: REPO });
      base = r?.base || r?.baseSha || r?.from || null;
    }
  } catch { /* fall through to the honest failure below */ }
  if (!base) return null;
  // The INFERRED base gets the same treatment as an explicit one. Hardening
  // only the explicit path left the default — the path CI actually takes —
  // unvalidated, so a resolver returning HEAD or a non-ancestor would produce
  // a vacuous or wrong comparison with no refusal. Same rule, both doors.
  return validateExplicitBase(base);
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
  const prevRootText = showAt(base, ROOT_LOG);
  if (prevRootText === null) {
    const msg = `status-log-integrity: CANNOT VERIFY — no ${ROOT_LOG} at base "${base}" `
      + '(unresolvable ref, or a shallow clone).\n'
      + '  Failing closed: an empty baseline would make any truncation look conserved.\n';
    if (jsonMode) process.stdout.write(`${JSON.stringify({ ok: false, verdict: 'cannot-verify', base })}\n`);
    else process.stderr.write(msg);
    process.exit(2);
  }

  const prev = {
    root: prevRootText,
    archives: archivesAt(base),
    manifest: parseManifest(showAt(base, MANIFEST)),
  };
  const curr = {
    root: fs.existsSync(path.join(REPO, ROOT_LOG)) ? fs.readFileSync(path.join(REPO, ROOT_LOG), 'utf-8') : '',
    archives: archivesOnDisk(),
    manifest: parseManifest(
      fs.existsSync(path.join(REPO, MANIFEST)) ? fs.readFileSync(path.join(REPO, MANIFEST), 'utf-8') : null,
    ),
  };

  const { ok, violations } = checkConservation(prev, curr);

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify({ ok, base, violations })}\n`);
  } else if (ok) {
    process.stdout.write(`status-log-integrity: conserved against ${base.slice(0, 8)}.\n`);
  } else {
    process.stdout.write(`status-log-integrity: ${violations.length} violation(s) against ${base.slice(0, 8)}\n`);
    for (const v of violations) process.stdout.write(`  ${v.kind}: ${v.detail}\n`);
    process.stdout.write('\n  status.md is append-only. To archive a month, use `npm run status:rotate`,\n');
    process.stdout.write('  which records each archived entry in docs/status/rotation-manifest.json.\n');
  }
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`status-log-integrity: ${err.message}\n`);
  process.exit(2); // fail closed on an unexpected error too
});
