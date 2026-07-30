#!/usr/bin/env node
/**
 * @fileoverview Skill-surface RETIREMENT and legacy cleanup.
 *
 * **This script no longer installs skills.** Every surface it used to write is
 * retired; invoking it without `--uninstall-legacy` prints why and exits 2.
 *
 * ## Why the install path is gone
 *
 * A SKILL.md's runner paths are a function of the DEPLOYMENT LAYOUT — `scripts/X.mjs`
 * in this source repo, `scripts/.claude-skills/X.mjs` in a consumer (see
 * `lib/sync-path-map.mjs`). This script copied bytes VERBATIM, so:
 *
 *   - `--surface claude` wrote `~/.claude/skills/`, ONE machine-wide directory
 *     shared by every repo. Being layout-agnostic, no correct content for it
 *     exists — a rewrite would only flip which repo is broken. Field-observed:
 *     a consumer session was served the global `ship/SKILL.md`, every runner
 *     invocation missed, and MODULE_NOT_FOUND was misread as "not installed".
 *   - `--surface agents` wrote `<repo>/.agents/skills/` with the same unrewritten
 *     paths, AND created a second Copilot-discovered root duplicating every name
 *     in `.claude/skills/` — the collision AGENTS.md forbids.
 *
 * `.claude/skills/**` is therefore written by exactly ONE writer per layout:
 * `regenerate-skill-copies.mjs` here, `sync-to-repos.mjs` (which rewrites) in
 * every other repo. To install: `npx github:Lbstrydom/claude-engineering-skills <dir>`
 * or `node scripts/sync-to-repos.mjs --target-path <dir>`.
 *
 * ## What this script still does
 *
 * It owns the receipts that record what the old installer wrote, so it is the
 * only thing that can safely un-own them:
 *
 *   node scripts/install-skills.mjs --uninstall-legacy [--repo-root <dir>] [--home <dir>] [--dry-run]
 *
 * Four outcomes, deliberately distinct (a partial cleanup is a SUCCESS WITH A
 * REPORT, never a silent pass):
 *
 *   clean    — no receipt, or zero surviving members            → exit 0
 *   complete — every member deleted, receipt removed            → exit 0
 *   partial  — some skipped/absent; receipt REWRITTEN to the
 *              survivors, each skip printed                     → exit 0
 *   failed   — transaction error; receipt untouched             → exit 1
 *
 * The `partial` receipt rewrite is load-bearing: deleting the receipt after a
 * skip would discard the only authoritative bounded-membership record for the
 * file still on disk, permanently orphaning it and defeating the "never
 * enumerate the directory" rule on every future run.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md
 * Reference: docs/reference/skill-surface-ownership.md
 *
 * @module scripts/install-skills
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { findRepoRoot, receiptPath, repoJournalPath, globalJournalPath }
  from './lib/install/surface-paths.mjs';
import { readReceipt, writeReceipt, buildReceipt } from './lib/install/receipt.mjs';
import { executeTransaction, recoverFromJournal } from './lib/install/transaction.mjs';
import { inspectLegacySurfaces, describeLegacySurfaces } from './lib/install/legacy-surfaces.mjs';
import { assertKnownFlags } from './lib/cli-io.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

/** Flags that only made sense for the removed install path. */
const RETIRED_INSTALL_FLAGS = ['--surface', '--skills', '--local', '--remote'];

/**
 * Every flag this CLI accepts — including the retired ones, which are ACCEPTED
 * by the parser only so they can be refused by name with a useful message
 * (rejecting them as "unknown" would hide that they used to work).
 *
 * `--uninstall-legacy` DELETES FILES FROM `$HOME`, so an unrecognised flag must
 * abort rather than be ignored: a mistyped `--dry-runn` silently becoming a real
 * delete is precisely the opt-out-shape incident class `check-cli-flags.mjs`
 * exists for. `assertKnownFlags` validates NAMES only; the value-taking flags'
 * values are bare positionals it ignores by design.
 */
const KNOWN_FLAGS = [
  '--uninstall-legacy', '--dry-run', '--home', '--target', '--repo-root', '--help', '-h',
  '--keep-github-skills', ...RETIRED_INSTALL_FLAGS,
];

const REPLACEMENT_HINT = [
  'Skills install REPO-SCOPED into <repo>/.claude/skills/, never machine-global.',
  '',
  '  Adopt / update any repo:  npx github:Lbstrydom/claude-engineering-skills <dir>',
  '  From this repo:           node scripts/sync-to-repos.mjs --target-path <dir>',
  '  Registered consumers:     npm run sync -- --target <name>',
  '',
  '  Remove a legacy tree:     node scripts/install-skills.mjs --uninstall-legacy',
  '',
  '  Why: docs/reference/skill-surface-ownership.md',
].join('\n');

function usage() {
  console.log(`${B}install-skills.mjs${X} — skill-surface retirement + legacy cleanup

${B}This script no longer installs skills.${X}

${B}Usage${X}
  node scripts/install-skills.mjs --uninstall-legacy [options]

${B}Options${X}
  --uninstall-legacy     Remove skill trees written by the retired installer
  --repo-root <dir>      Repo whose .agents/skills/ to inspect
                         (default: the OUTERMOST git repo containing the cwd —
                         findRepoRoot's semantics; pass this explicitly when
                         working inside a nested or submodule checkout)
  --home <dir>           Home root whose ~/.claude/skills/ to inspect (default: os.homedir())
  --dry-run              Report what would be removed; change nothing
  --help                 This message

${REPLACEMENT_HINT}
`);
}

/**
 * Read the value of a value-taking flag, refusing another flag as that value.
 *
 * `assertKnownFlags` validates flag NAMES only, so without this
 * `--home --dry-run` resolves the string `--dry-run` into a home path and leaves
 * `dryRun` false — the operator asked for a rehearsal and got a real delete
 * against a nonsense root. Losing a brake to a shell typo is the specific
 * incident shape this repo's CLI gate exists for, so a missing value is a hard
 * error, never a silent default.
 *
 * @param {string[]} argv
 * @param {number} i index of the FLAG token
 * @returns {string} the value
 */
function takeValue(argv, i) {
  const flag = argv[i];
  const v = argv[i + 1];
  if (!v || v.startsWith('-')) {
    console.error(
      `${R}Error${X}: ${flag} requires a directory path`
      + (v ? `, but got the flag "${v}" — a value-taking flag must not swallow another flag.` : '.'),
    );
    process.exit(1);
  }
  return v;
}

function parseArgs(argv) {
  // Before ANY interpretation: refuse an unknown flag outright. The switch below
  // has no default arm that can catch one (a `default:` would have to guess
  // whether the token is a flag or a value), so this is the only thing standing
  // between a typo and a silently-different mutating run.
  assertKnownFlags(argv, KNOWN_FLAGS, { cli: 'install-skills' });

  // This CLI declares NO positional arguments, so a bare token is always a
  // mistake — most likely a path the operator meant to attach to --repo-root.
  // Ignoring it on a command that deletes from $HOME would run the default
  // (ambient home, outermost repo) while the operator believes they scoped it.
  // Includes the RETIRED value-taking flags (`--surface claude`, `--skills ship`).
  // Without them their values look like stray positionals and this guard fires
  // first, so the operator gets "unexpected argument: claude" instead of the
  // message explaining that `--surface` itself is retired and what replaced it.
  // The specific diagnostic is the whole point of keeping those flags known.
  const valueTaking = new Set(['--home', '--target', '--repo-root', '--surface', '--skills']);
  for (let i = 2; i < argv.length; i++) {
    if (argv[i].startsWith('-')) continue;
    if (valueTaking.has(argv[i - 1])) continue;   // consumed as a flag's value
    console.error(
      `${R}Error${X}: unexpected argument "${argv[i]}" — this command takes no positional `
      + 'arguments. Did you mean `--repo-root ' + argv[i] + '`?',
    );
    process.exit(1);
  }

  const args = {
    uninstallLegacy: false, dryRun: false, target: null, home: null, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    // `--flag=value` is accepted by `assertKnownFlags` (it validates the NAME
    // half), but the switch below matches whole tokens — so `--home=/somewhere`
    // used to fall through unmatched and leave `home` null, silently acting on
    // the AMBIENT home. On the one command that deletes from `$HOME` that is the
    // same brake-loss class as `--home --dry-run`, just wearing an equals sign.
    // Verified before the fix: `--home=/tmp/x` printed `Home: C:\Users\User`.
    const eq = argv[i].indexOf('=');
    if (argv[i].startsWith('--') && eq > 0) {
      const name = argv[i].slice(0, eq);
      const value = argv[i].slice(eq + 1);
      if (!value) {
        console.error(`${R}Error${X}: ${name}= requires a value`);
        process.exit(1);
      }
      if (name === '--home') { args.home = path.resolve(value); continue; }
      if (name === '--target' || name === '--repo-root') { args.target = path.resolve(value); continue; }
      console.error(`${R}Error${X}: ${name} does not take a value`);
      process.exit(1);
    }

    switch (argv[i]) {
      case '--uninstall-legacy': args.uninstallLegacy = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--help': case '-h': args.help = true; break;
      case '--home':
        args.home = path.resolve(takeValue(argv, i));
        i++;
        break;
      case '--target': case '--repo-root':
        // `takeValue` names the mistake. Without it, `path.resolve(undefined)`
        // throws deep in node and the top-level catch reports
        // `The "paths[0]" argument must be of type string` — technically
        // handled, but it tells the user nothing about which flag they mistyped
        // — and a following flag would be silently eaten as the value.
        args.target = path.resolve(takeValue(argv, i));
        i++;
        break;
      case '--keep-github-skills':
        // Kept as an explicit arm rather than bare-removed: this switch has no
        // default case, so deleting the arm would make the flag SILENTLY ignored
        // on a mutating command rather than rejected (round-1 audit H1).
        console.error(
          `${R}Error${X}: --keep-github-skills was removed 2026-07-28 ` +
          '(docs/plans/refactor-skill-governance.md) — the .github/skills/ escape ' +
          'hatch no longer exists in this installer. Drop the flag.',
        );
        process.exit(2);
        break;
      default:
        break;
    }
  }
  return args;
}

/**
 * Reconcile any crashed install transaction before starting a new one.
 *
 * Fails CLOSED on `rec.error`, not on an enumerated list of named flags: an
 * earlier version gated only on `rec.quarantined`, which silently ignored the
 * lock-contention failure result added later. Keying on `error` means any
 * future non-benign result is fatal by default. The benign "no journal exists"
 * case is the only one carrying neither `error` nor `quarantined`.
 *
 * `homeRoot` arrives in an OPTIONS OBJECT, never as a second positional. The
 * previous signature took `(repoRoot)` alone and at least one caller passed a
 * stale second argument that the old body ignored; adding a positional would
 * have silently reinterpreted that leftover as a home root and pointed journal
 * recovery at a nonsense path. An options bag makes the same mistake a no-op.
 *
 * @param {string} repoRoot
 * @param {{homeRoot?: string}} [opts]
 */
function reconcileJournals(repoRoot, { homeRoot } = {}) {
  // BOTH anchors are scanned. A transaction touching the shared
  // ~/.claude/skills surface journals globally, so the global scan is what lets
  // THIS repo see a crash that another repo left on that surface. Paths come
  // from surface-paths.mjs so the reader cannot drift from the writer.
  for (const jp of [repoJournalPath(repoRoot), globalJournalPath(homeRoot)]) {
    // `homeRoot` goes to recovery too, not just to discovery. Locating a journal
    // under an explicit home and then validating its entries against the ambient
    // one puts every entry out of containment, which quarantines a healthy
    // record rather than recovering it.
    const rec = recoverFromJournal(jp, { repoRoot, homeRoot });

    if (rec.error) {
      process.stderr.write(`${R}[install] ABORT — unresolved install transaction at ${jp}${X}\n`);
      process.stderr.write(`  ${rec.error}\n`);
      if (rec.foreign) {
        process.stderr.write('  It is left in place deliberately: it is the only record of what that\n');
        process.stderr.write('  install had already applied, and only its own repo can complete it.\n');
      }
      if (rec.quarantined) {
        process.stderr.write(`  The journal was quarantined to: ${rec.quarantined}\n`);
        process.stderr.write('  Inspect it to see what the crashed install had already applied,\n');
        process.stderr.write('  then delete it to unblock installs.\n');
      }
      process.exit(1);
    }

    for (const s of rec.skippedDeletes || []) {
      process.stderr.write(`  ${Y}⚠ recovery skipped a delete${X}: ${s.absPath} — ${s.reason}\n`);
    }
    // Recovery renames are fsynced like the transaction's own, so it can
    // degrade too — route it through the SAME channel rather than leaving the
    // recovery path silently exempt from the "never silent" guarantee.
    reportDegradations(rec.degradations);
    if (rec.recovered) {
      console.log(`  ${Y}Journal recovered${X} (${jp}): rolled-forward=${rec.rolledForward} rolled-back=${rec.rolledBack}`);
    }

    // Sibling to reportDegradations() but a distinct channel and heading —
    // a recoveryFailures entry means the WAL could not be fully resolved
    // and the run is about to abort, categorically different from a
    // non-critical durability degradation.
    if ((rec.recoveryFailures || []).length > 0) {
      process.stderr.write(`${R}[install] ABORT — unresolved WAL at ${jp}${X}\n`);
      for (const f of rec.recoveryFailures) {
        process.stderr.write(`  ${R}✗${X} ${f.absPath} — ${f.reason}\n`);
      }
      process.exit(1);
    }
  }
}

/**
 * Render durability degradations. The "degrade loudly, never silently" stance
 * is only real if something actually prints — this is that something.
 *
 * Deduplicated by (code, what): the journal is written twice per transaction,
 * so an unsupported fsync would otherwise report the identical line twice and
 * read like two separate problems. The transaction's `degradations` array
 * stays complete (data layer); uniqueness is a presentation concern.
 *
 * @param {Array<{code: string, what: string}>} degradations
 */
function reportDegradations(degradations) {
  const seen = new Set();
  for (const d of degradations || []) {
    const key = `${d.code}|${d.what}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Do NOT say "unsupported" for every code: ENOTSUP/EINVAL are capability
    // limits, but EIO/ENOSPC are real I/O failures and calling those
    // "unsupported" understates them into noise. Name what actually happened.
    const capability = d.code === 'ENOTSUP' || d.code === 'EINVAL';
    const cause = capability
      ? `fsync unsupported on this filesystem (${d.code})`
      : `fsync FAILED (${d.code}) — this may indicate a failing disk or a full volume`;
    process.stderr.write(
      `  ${Y}⚠ durability degraded${X}: ${d.what}: ${cause} — ` +
      'the operation completed, but is not guaranteed crash-safe\n',
    );
  }
}

/**
 * Rewrite a receipt to exactly its surviving members, or remove it when none
 * remain. Called ONLY on a committed transaction (S3a `partial` / `complete`).
 *
 * @param {string} rp receipt path
 * @param {Set<string>} removedAbsPaths absolute paths the transaction deleted
 * @param {string} repoRoot
 * @param {string|undefined} homeRoot
 * @returns {'removed'|'reduced'|'unchanged'}
 */
function reconcileReceipt(rp, removedAbsPaths, repoRoot, homeRoot) {
  const { receipt, error } = readReceipt(rp);
  // An unreadable receipt was already classified `blocked` upstream, so nothing
  // was deleted under it — leave it exactly as found rather than guessing.
  if (error || !receipt) return 'unchanged';

  const survivors = receipt.managedFiles.filter((mf) => {
    const abs = mf.scope === 'global' ? mf.path : path.join(repoRoot, mf.path);
    return !removedAbsPaths.has(path.resolve(abs));
  });
  if (survivors.length === receipt.managedFiles.length) return 'unchanged';

  if (survivors.length === 0) {
    // Retry-hardened per the repo-wide Windows EPERM/EBUSY invariant
    // (tests/rmsync-retry-guard.test.mjs): a receipt an editor or AV scanner is
    // momentarily holding must not fail the cleanup it is recording.
    fs.rmSync(rp, { force: true, recursive: true, maxRetries: 3, retryDelay: 50 });
    return 'removed';
  }
  writeReceipt(rp, buildReceipt({
    bundleVersion: receipt.bundleVersion,
    sourceUrl: receipt.sourceUrl,
    surface: receipt.surface,
    managedFiles: survivors,
  }));
  return 'reduced';
}

/**
 * Remove directories that THIS RUN emptied, walking upward toward each surface
 * root without ever reaching it.
 *
 * Deleting the receipt's files left the folder skeleton behind, so a `complete`
 * cleanup was not literally complete — measured 2026-07-30, where removing 56
 * managed files left 15 empty directories (`ship/references/`, `plan/`, …) that
 * had to be cleared by hand, in three separate trees.
 *
 * Three properties make this safe, and none of them is optional:
 *
 * 1. **Seeded only from what we deleted.** The walk starts at the parent of each
 *    removed file. A directory we did not empty is never even considered, so
 *    this cannot become the directory enumeration that S3 forbids.
 * 2. **`rmdirSync`, NOT `rmSync({recursive:true})`.** A non-recursive rmdir
 *    throws `ENOTEMPTY` on a directory with any content left in it — so
 *    "only if empty" is enforced by the SYSCALL rather than by a check we could
 *    get wrong. A user file sitting beside ours physically cannot be removed.
 * 3. **Stops below the surface root.** `~/.claude/skills/` and
 *    `<repo>/.agents/skills/` are well-known locations; leaving them empty is
 *    harmless, and removing a directory the operator expects to exist is not
 *    ours to decide.
 *
 * Best-effort throughout: a prune failure must never turn a successful cleanup
 * into a failed one. The files — the thing that actually shadows — are already
 * gone by the time this runs.
 *
 * @param {string[]} removedAbsPaths absolute paths this run deleted
 * @param {string[]} surfaceRoots the roots to stop beneath
 * @returns {number} directories removed
 */
function pruneEmptiedDirs(removedAbsPaths, surfaceRoots) {
  const roots = surfaceRoots.map(r => path.resolve(r));
  const isUnderARoot = (dir) => roots.some((root) => {
    const rel = path.relative(root, dir);
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  });

  // Deepest-first, so `ship/references/` is gone before `ship/` is tried.
  const candidates = [...new Set(removedAbsPaths.map(p => path.dirname(path.resolve(p))))]
    .sort((a, b) => b.split(path.sep).length - a.split(path.sep).length);

  let removed = 0;
  for (const start of candidates) {
    let dir = start;
    while (isUnderARoot(dir)) {
      try {
        fs.rmdirSync(dir);          // ENOTEMPTY if anything remains — by design
        removed++;
      } catch {
        break;                      // not empty, or not removable: stop climbing
      }
      dir = path.dirname(dir);
    }
  }
  return removed;
}

/**
 * `--uninstall-legacy` — remove skill trees written by the retired installer.
 *
 * The bounded delete set comes from `inspectLegacySurfaces`, NOT from reading
 * the directory and NOT from `computeDeletes`.
 *
 * Why not `computeDeletes` (which the plan originally named): it answers "which
 * previously-managed files is this run no longer writing", which — with zero
 * writes — is EVERY receipt member, including non-skill entries like the merged
 * `copilot-instructions.md` block. That is far outside this command's authority.
 * The inspector's set is narrower by construction: only `present-clean` members
 * that live under a retired surface root. The transaction's own `expectedSha`
 * check then re-verifies each one, so a file modified between inspection and
 * delete is still skipped rather than removed.
 *
 * @param {{target: string|null, home: string|null, dryRun: boolean}} args
 * @returns {number} process exit code
 */
function runUninstallLegacy(args) {
  const repoRoot = args.target || findRepoRoot();
  const homeRoot = args.home || undefined;

  console.log(`${B}Legacy skill-surface cleanup${X}`);
  console.log(`  Repo: ${repoRoot}`);
  console.log(`  Home: ${homeRoot || os.homedir()}`);
  if (args.dryRun) console.log(`  ${Y}DRY RUN — nothing will be deleted${X}`);
  console.log('');

  reconcileJournals(repoRoot, { homeRoot });

  const inspection = inspectLegacySurfaces({ homeRoot, repoRoot });
  for (const line of describeLegacySurfaces(inspection)) console.log(`  ${line}`);

  if (inspection.deletable.length === 0) {
    // A no-op must SAY which state it observed. A bare "done" would imply the
    // tree was verified when the honest reading may be "a receipt was blocked".
    if (inspection.overall === 'blocked') {
      console.log(`\n  ${Y}blocked${X} — nothing could be removed automatically (see above).`);
      console.log(`  ${D}Resolve the listed files by hand, then re-run.${X}`);
    } else {
      console.log(`  ${G}clean${X} — no legacy skill surface found. Nothing to do.`);
    }
    return 0;
  }

  if (args.dryRun) {
    console.log(`\n${Y}Would remove ${inspection.deletable.length} file(s):${X}`);
    for (const d of inspection.deletable) console.log(`  ${R}-${X} ${d.absPath}`);
    return 0;
  }

  const result = executeTransaction({
    writes: [],
    deletes: inspection.deletable,
    repoRoot,
  });
  reportDegradations(result.degradations);

  if (!result.success) {
    console.error(`${R}Cleanup failed${X}: ${result.error}`);
    console.error('All changes have been rolled back; receipts are untouched.');
    return 1;
  }

  const skipped = result.skippedDeletes || [];
  for (const s of skipped) console.log(`  ${Y}○ skipped${X} ${s.absPath}: ${s.reason}`);

  const removed = new Set(
    inspection.deletable
      .filter(d => !skipped.some(s => path.resolve(s.absPath) === path.resolve(d.absPath)))
      .map(d => path.resolve(d.absPath)),
  );
  for (const scope of ['global', 'repo']) {
    const rp = receiptPath(scope, repoRoot, homeRoot);
    const outcome = reconcileReceipt(rp, removed, repoRoot, homeRoot);
    if (outcome === 'removed') console.log(`  ${D}receipt removed: ${rp}${X}`);
    if (outcome === 'reduced') console.log(`  ${D}receipt reduced to survivors: ${rp}${X}`);
  }

  // Only AFTER the receipts are reconciled: the files are the thing that
  // shadows, and their ownership record must be settled before we tidy the
  // folders they lived in.
  const prunedDirs = pruneEmptiedDirs([...removed], inspection.surfaces.map(s => s.root));

  const partial = skipped.length > 0 || inspection.overall === 'blocked';
  console.log(
    `\n${G}${partial ? 'partial' : 'complete'}${X} — removed ${removed.size} file(s)`
    + (skipped.length ? `, skipped ${skipped.length}` : '')
    + (prunedDirs ? `, pruned ${prunedDirs} empty director${prunedDirs === 1 ? 'y' : 'ies'}` : ''),
  );
  if (partial) {
    console.log(`  ${D}The skipped files were modified since install and are yours to remove.${X}`);
  }

  // deleteFailures.length > 0 is the ONLY signal driving a non-zero exit here —
  // never skippedDeletes.length, which also counts the benign
  // modified-file-protected case that S3a defines as a SUCCESS with a report.
  if ((result.deleteFailures || []).length > 0) {
    console.error(`${R}[install] journal retained${X} — resolve before the next run.`);
    return 1;
  }
  return 0;
}

function main() {
  const args = parseArgs(process.argv);

  if (args.help) { usage(); return 0; }

  // Any flag from the removed install path is refused by name, so the operator
  // learns their command is retired rather than watching it silently do nothing.
  const usedInstallFlag = RETIRED_INSTALL_FLAGS.find(f =>
    process.argv.includes(f) || process.argv.some(a => a.startsWith(`${f}=`)));

  if (!args.uninstallLegacy) {
    console.error(`${R}install-skills.mjs no longer installs skills.${X}`);
    if (usedInstallFlag) {
      console.error(`  ${usedInstallFlag} belonged to the retired install path.`);
    }
    console.error('');
    console.error(REPLACEMENT_HINT);
    return 2;
  }
  if (usedInstallFlag) {
    console.error(`${R}Error${X}: ${usedInstallFlag} is retired and cannot be combined with --uninstall-legacy.`);
    return 2;
  }

  return runUninstallLegacy(args);
}

/**
 * Internal seams exposed for tests. Underscore-prefixed per this repo's
 * convention (file-io.mjs, shared.mjs, anthropic-client.mjs).
 */
export const _internals = {
  parseArgs, reconcileJournals, reportDegradations, reconcileReceipt, pruneEmptiedDirs,
  runUninstallLegacy, RETIRED_INSTALL_FLAGS,
};

// isMain guard — importing this module (e.g. from a test) must not run a
// cleanup. Matches the pattern used by memory-health.mjs / symbol-index/drift.mjs.
const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`${R}Error${X}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}
