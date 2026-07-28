#!/usr/bin/env node
/**
 * @fileoverview Install engineering skills to consumer repos.
 *
 * **Version-gated entrypoint** (Phase B.1): reads `schemaVersion` BEFORE
 * parsing the manifest. v1 and v2 manifests are supported; anything else
 * exits with `UNSUPPORTED_MANIFEST_VERSION` and the minimum installer
 * version required.
 *
 * **Multi-file skills** (v2): when a skill entry has a `files[]` array,
 * every file (SKILL.md + references, examples) is installed into the
 * skill's target directory. Files previously managed
 * that are no longer in the manifest are deleted as part of the same
 * transaction (with orphan-protection for user-modified files).
 *
 * **Receipt scoping** (G2 fix): claude-surface files live in
 * `~/.claude/skills/` and are tracked in a global receipt at
 * `~/.audit-loop-install-receipt.json`. Repo-surface files (copilot,
 * agents) stay in the repo receipt. No more cross-home-directory
 * relative paths.
 *
 * **Copilot merge idempotency** (G3 fix): `managedFiles.sha` for the
 * merged `copilot-instructions.md` is the SHA of the final merged
 * content, not the inserted block alone. `blockSha` is kept as a separate
 * metadata field for block-update detection.
 *
 * Usage:
 *   node scripts/install-skills.mjs --local --target /path/to/consumer-repo
 *   node scripts/install-skills.mjs --local --target /path/to/repo --surface both
 *   node scripts/install-skills.mjs --local --target /path/to/repo --dry-run
 *
 * `--surface` accepts `claude` | `agents` | `both` (default). `copilot`
 * (`.github/skills/`) was retired 2026-07-28
 * (docs/plans/refactor-skill-governance.md) and now errors immediately
 * rather than completing a silent zero-write install.
 *
 * The --target flag is REQUIRED for cross-repo installs. Without it, the
 * installer targets the current repo (useful for self-install/testing only).
 *
 * @module scripts/install-skills
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ManifestSchema, MANIFEST_SUPPORTED_VERSIONS } from './lib/schemas-install.mjs';
import {
  findRepoRoot, resolveSkillFiles,
  receiptPath, partitionManagedFilesByScope, managedFileAbsPath,
  repoJournalPath, globalJournalPath,
} from './lib/install/surface-paths.mjs';
import { readReceipt, writeReceipt, buildReceipt } from './lib/install/receipt.mjs';
import { detectConflicts } from './lib/install/conflict-detector.mjs';
import { mergeBlock, COPILOT_BLOCK } from './lib/install/merge.mjs';
import { executeTransaction, recoverFromJournal } from './lib/install/transaction.mjs';
import { ensureAuditGitignore } from './lib/install/gitignore.mjs';
import { ensureAuditDeps } from './lib/install/deps.mjs';

const G = '\x1b[32m', Y = '\x1b[33m', R = '\x1b[31m', D = '\x1b[2m', B = '\x1b[1m', X = '\x1b[0m';

const MIN_INSTALLER_FOR_V2 = 'v2 (multi-file skills — Phase B.1)';

function parseArgs(argv) {
  const args = {
    local: false, remote: false, surface: 'both', skills: null,
    force: false, dryRun: false, target: null,
  };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--local': args.local = true; break;
      case '--remote': args.remote = true; break;
      case '--surface': args.surface = argv[++i]; break;
      case '--skills': args.skills = argv[++i]?.split(','); break;
      case '--force': args.force = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--target': case '--repo-root': {
        // Name the mistake. Without the guard `path.resolve(undefined)` throws
        // deep in node and the top-level catch reports
        // `The "paths[0]" argument must be of type string` — technically handled,
        // but it tells the user nothing about which flag they mistyped.
        const v = argv[++i];
        if (!v) {
          console.error(`${R}Error${X}: ${argv[i - 1]} requires a directory path`);
          process.exit(1);
        }
        args.target = path.resolve(v);
        break;
      }
      case '--keep-github-skills':
        console.error(
          `${R}Error${X}: --keep-github-skills was removed 2026-07-28 ` +
          '(docs/plans/refactor-skill-governance.md) — the .github/skills/ escape ' +
          'hatch no longer exists in this installer. Drop the flag.',
        );
        process.exit(2);
        break;
    }
  }
  if (!args.local && !args.remote) {
    args.local = fs.existsSync(path.resolve('skills'));
  }
  return args;
}

/**
 * Load + validate a manifest file with version gating.
 * Rejects unsupported versions with a clear error before Zod parses the body.
 */
function loadManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) {
    console.error(`${R}Error${X}: skills.manifest.json not found. Run: node scripts/build-manifest.mjs`);
    process.exit(1);
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  } catch (err) {
    console.error(`${R}Error${X}: manifest is not valid JSON: ${err.message}`);
    process.exit(1);
  }

  const v = raw?.schemaVersion;
  if (typeof v !== 'number' || !MANIFEST_SUPPORTED_VERSIONS.includes(v)) {
    console.error(`${R}UNSUPPORTED_MANIFEST_VERSION${X}: manifest declares schemaVersion=${v}`);
    console.error(`  This installer supports: ${MANIFEST_SUPPORTED_VERSIONS.join(', ')}`);
    console.error(`  Minimum installer for this manifest: ${MIN_INSTALLER_FOR_V2}`);
    console.error(`  Update the installer: git pull in the engineering-skills repo`);
    process.exit(1);
  }

  return ManifestSchema.parse(raw);
}

/**
 * Compute the expanded file list for a skill:
 * - v2 manifest + `files[]` present → use it as-is.
 * - v1 manifest or v2 without `files[]` → treat as single-file skill (SKILL.md only).
 */
function expandSkillFiles(skillName, meta) {
  if (Array.isArray(meta.files) && meta.files.length > 0) {
    return meta.files.map(f => ({ ...f }));
  }
  // Back-compat: legacy v1 manifest or v2 entry without files array
  return [{ relPath: 'SKILL.md', sha: meta.sha, size: meta.size }];
}

function fileShaShort(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

// ── main() helpers — keep main() under cognitive-complexity 15 ────────────

function validateTarget(args) {
  if (!args.target) return;
  if (!fs.existsSync(args.target)) {
    console.error(`${R}Error${X}: target directory does not exist: ${args.target}`);
    process.exit(1);
  }
  const hasGit = fs.existsSync(path.join(args.target, '.git'));
  const hasPkg = fs.existsSync(path.join(args.target, 'package.json'));
  if (!hasGit && !hasPkg) {
    console.error(`${Y}Warning${X}: target has no .git or package.json — are you sure this is a repo?`);
  }
}

function printBanner(args, repoRoot) {
  console.log(`${B}Engineering Skills Installer${X}`);
  console.log(`  Mode: ${args.local ? 'local' : 'remote'}`);
  console.log(`  Surface: ${args.surface}`);
  console.log(`  Target repo: ${repoRoot}`);
  if (args.target) console.log(`  ${D}(cross-repo install from ${process.cwd()})${X}`);
  if (args.dryRun) console.log(`  ${Y}DRY RUN — no files will be written${X}`);
  console.log('');
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
 * @param {string} repoRoot
 */
function reconcileJournals(repoRoot) {
  // BOTH anchors are scanned, and both are now live. A transaction touching the
  // shared ~/.claude/skills surface journals globally, so the global scan is
  // what lets THIS repo see a crash that another repo left on that surface.
  // Paths come from surface-paths.mjs so the reader cannot drift from the
  // writer.
  for (const jp of [repoJournalPath(repoRoot), globalJournalPath()]) {
    const rec = recoverFromJournal(jp, { repoRoot });

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
    // and the installer is about to abort, categorically different from a
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
      'the install completed, but is not guaranteed crash-safe\n',
    );
  }
}

function maybeWarnGithubSkillsDeprecation(args, repoRoot) {
  const stale = path.join(repoRoot, '.github', 'skills');
  if (!fs.existsSync(stale)) return;
  process.stderr.write(
    `${Y}[install] SHADOWING RISK:${X} .github/skills/ exists and is no longer maintained.\n` +
    '  Copilot Agent Skills reads BOTH .github/skills/ and .claude/skills/, and\n' +
    '  .github/skills/ WINS on a name collision — so every stale copy there silently\n' +
    '  shadows the fresh one this install just wrote. (Observed in a consumer repo\n' +
    '  2026-07-19: 6 skills shadowed, ship 366 lines behind, and its telemetry step\n' +
    '  simply absent — so ship events never recorded and nothing surfaced an error.)\n' +
    `  Existing files at ${path.relative(repoRoot, stale)} are not deleted by this install.\n` +
    '  Inspect: node scripts/check-stale-skill-surface.mjs --repo <repo>\n' +
    '  Fix: delete the directory manually — this installer can no longer write to it.\n',
  );
}

function buildSkillWrites(skillName, meta, args, repoRoot) {
  const skillSrcDir = path.resolve('skills', skillName);
  const files = expandSkillFiles(skillName, meta);
  const surfaces = resolveSkillFiles(skillName, args.surface, repoRoot, files);
  const writes = [];
  const managedFiles = [];
  for (const t of surfaces) {
    const srcPath = path.join(skillSrcDir, t.relPath);
    if (!fs.existsSync(srcPath)) {
      console.error(`${R}Error${X}: source file missing for ${skillName}: ${t.relPath}`);
      process.exit(1);
    }
    const content = fs.readFileSync(srcPath);
    const sha = fileShaShort(content);
    const manifestFile = files.find(f => f.relPath === t.relPath);
    if (manifestFile && sha !== manifestFile.sha) {
      console.error(
        `${R}Error${X}: SHA mismatch for ${skillName}/${t.relPath} ` +
        `(manifest: ${manifestFile.sha}, actual: ${sha}). Run: node scripts/build-manifest.mjs`,
      );
      process.exit(1);
    }
    const recordPath = t.scope === 'global'
      ? t.filePath
      : path.relative(repoRoot, t.filePath).replaceAll(/\\/g, '/');
    writes.push({ path: recordPath, absPath: t.filePath, content, sha, scope: t.scope });
    managedFiles.push({ path: recordPath, sha, skill: skillName, scope: t.scope });
  }
  return { writes, managedFiles };
}

function buildCopilotMergeWrite(args, repoRoot) {
  if (args.surface !== 'copilot' && args.surface !== 'both') return null;
  const copilotPath = path.join(repoRoot, '.github', 'copilot-instructions.md');
  const existing = fs.existsSync(copilotPath) ? fs.readFileSync(copilotPath, 'utf-8') : null;
  const merged = mergeBlock(existing);
  const mergedBuf = Buffer.from(merged, 'utf-8');
  const mergedSha = fileShaShort(mergedBuf);
  const blockSha = crypto.createHash('sha256').update(COPILOT_BLOCK).digest('hex').slice(0, 12);
  const recordPath = path.relative(repoRoot, copilotPath).replaceAll(/\\/g, '/');
  return {
    write: { path: recordPath, absPath: copilotPath, content: mergedBuf, sha: mergedSha, scope: 'repo' },
    managed: { path: recordPath, sha: mergedSha, blockSha, merged: true, scope: 'repo' },
  };
}

/**
 * Which previously-managed files should this run delete?
 *
 * A file is deleted when it was managed before and this run no longer writes it
 * — but ONLY for skills this run is AUTHORITATIVE over. `--skills <csv>` is a
 * FILTER selecting a partial install, not a declaration that the bundle should
 * become exactly that set. Comparing a filtered write set against the whole
 * receipt makes every UNSELECTED skill look "no longer managed", so
 * `install --skills explain` would delete the other 14 — from the shared
 * ~/.claude/skills surface, which every repo reads.
 *
 * This was latent: global deletes silently no-op'd (the receipt schema stripped
 * `scope`, so their paths never resolved), which hid it. Fixing that resolution
 * ARMED this path — measured at 112 proposed deletes for a one-skill install —
 * so the two must land together.
 *
 * The installer's own docstring already states the intended rule: files
 * "no longer in the manifest" are deleted. Skills absent from `--skills` are
 * still in the manifest.
 *
 * There are TWO independent filters, and BOTH narrow authority — handling only
 * one is the same partial-enumeration mistake in a new coat:
 *   `--skills <csv>`  narrows WHICH SKILLS      -> authoritativeSkills
 *   `--surface <s>`   narrows WHICH SURFACES    -> authoritativeScopes
 * `--surface claude` writes only global files, so every repo-scope entry in the
 * receipt looks "no longer managed" and would be deleted — measured at 2 deletes
 * for a one-skill repo, and `post-merge` runs `--surface claude --force` on
 * every merge.
 *
 * @param {Array<{absPath: string}>} writes
 * @param {object|null} prevGlobalReceipt
 * @param {object|null} prevRepoReceipt
 * @param {string} repoRoot
 * @param {{skills?: Set<string>|null, scopes?: Set<string>|null}} [authority]
 *   — a null/absent member means "this run covers all of that axis".
 */
function computeDeletes(writes, prevGlobalReceipt, prevRepoReceipt, repoRoot, authority = {}) {
  const authoritativeSkills = authority.skills ?? null;
  const authoritativeScopes = authority.scopes ?? null;
  const newAbsPaths = new Set(writes.map(w => w.absPath));
  const deletes = [];
  for (const prev of [prevGlobalReceipt, prevRepoReceipt]) {
    if (!prev?.managedFiles) continue;
    for (const mf of prev.managedFiles) {
      // A surface this run wasn't asked to install is not ours to prune.
      if (authoritativeScopes && !authoritativeScopes.has(mf.scope ?? 'repo')) continue;
      // Leave other skills' files alone. Entries with no `skill` (the merged
      // copilot-instructions block) are always in scope — they are rebuilt on
      // every run regardless of the filter.
      if (authoritativeSkills && mf.skill && !authoritativeSkills.has(mf.skill)) continue;
      // Shared decoder — must not be open-coded here (see managedFileAbsPath).
      const prevAbsPath = managedFileAbsPath(mf, repoRoot);
      if (!newAbsPaths.has(prevAbsPath)) deletes.push({ absPath: prevAbsPath, expectedSha: mf.sha });
    }
  }
  return deletes;
}

/**
 * Which scopes is a `--surface` selection authoritative over? Mirrors
 * resolveSkillTargets' surface->scope mapping (claude lives in the global
 * surface; copilot + agents live in the repo). null = every scope.
 *
 * Gemini gate shadow finding #3: `args.surface === 'copilot'` can never
 * actually reach this function post-retirement — `buildSkillWrites` (called
 * earlier in `main()`, per skill, before this authority computation) calls
 * `resolveSkillFiles`/`resolveSkillTargets`, which now throws for a bare
 * `'copilot'` request and aborts the run. The `copilot` branch here is kept
 * deliberately anyway: `computeDeletes`'s authority check consults THIS
 * function's return value to decide whether a *pre-existing* repo-scope
 * receipt entry (from an install made before this surface was retired) is
 * within this run's pruning authority — that entry's OWN recorded `scope`
 * can still be `'repo'` from when it was copilot-sourced, and a `--surface
 * copilot` value passed here (defensively, or by a future caller with a
 * different entry point) must still map to `'repo'`, not `null`/global.
 */
function authoritativeScopesFor(surface) {
  if (surface === 'claude') return new Set(['global']);
  if (surface === 'copilot' || surface === 'agents') return new Set(['repo']);
  return null; // 'both' — this run covers every surface
}

/**
 * Carry forward receipt entries this run was not authoritative over, so a
 * partial install does not erase the record of the rest of the bundle. Mirrors
 * computeDeletes' authority test exactly — an entry we refuse to delete must
 * also be an entry we keep tracking, or the next run sees it as unmanaged and
 * orphans it.
 */
function retainUnmanagedEntries(prevReceipt, authority = {}) {
  const skills = authority.skills ?? null;
  const scopes = authority.scopes ?? null;
  if ((!skills && !scopes) || !prevReceipt?.managedFiles) return [];
  return prevReceipt.managedFiles.filter(mf => {
    if (scopes && !scopes.has(mf.scope ?? 'repo')) return true;
    if (skills && mf.skill && !skills.has(mf.skill)) return true;
    return false;
  });
}

function checkConflicts(writes, prevGlobalReceipt, prevRepoReceipt, args) {
  const { safe, conflicts } = detectConflicts(writes, prevRepoReceipt, { force: args.force });
  const { safe: safeGlobal, conflicts: conflictsGlobal } = detectConflicts(
    writes.filter(w => w.scope === 'global'),
    prevGlobalReceipt, { force: args.force },
  );
  const allConflicts = [
    ...conflicts.filter(c => writes.find(w => w.path === c.path)?.scope !== 'global'),
    ...conflictsGlobal,
  ];
  const allSafe = [...safe.filter(s => s.scope !== 'global'), ...safeGlobal];
  return { allSafe, allConflicts };
}

function writeReceiptsByScope(managedFiles, manifest, args, repoReceiptPath, globalReceiptPath, prev = {}) {
  const { global: globalManaged, repo: repoManaged } = partitionManagedFilesByScope(managedFiles);
  const buildOpts = {
    bundleVersion: manifest.bundleVersion,
    sourceUrl: manifest.rawUrlBase,
    surface: args.surface,
  };
  // Rewrite a scope's receipt when it has files NOW **or HAD them before**.
  // Guarding on the write side alone (`managed.length > 0`) is the same
  // partial-enumeration mistake the transaction's lock predicate made: a DELETE
  // changes the managed set exactly as a write does. Without the second term,
  // an install whose last file in a scope was removed leaves that scope's
  // receipt listing files that no longer exist — and check-skill-updates then
  // reports every one as `missing` and tells the user to reinstall.
  const had = (r) => (r?.managedFiles?.length ?? 0) > 0;
  if (repoManaged.length > 0 || had(prev.repo)) {
    writeReceipt(repoReceiptPath, buildReceipt({ ...buildOpts, managedFiles: repoManaged }));
  }
  if (globalManaged.length > 0 || had(prev.global)) {
    writeReceipt(globalReceiptPath, buildReceipt({ ...buildOpts, managedFiles: globalManaged }));
  }
  return { repoManaged, globalManaged };
}

function main() {
  const args = parseArgs(process.argv);
  const repoRoot = args.target || findRepoRoot();
  validateTarget(args);
  printBanner(args, repoRoot);

  const globalReceiptPath = receiptPath('global', repoRoot);
  const repoReceiptPath = receiptPath('repo', repoRoot);
  reconcileJournals(repoRoot);

  if (!args.local) {
    console.error(`${R}Error${X}: --remote mode not implemented yet (Phase F follow-up)`);
    process.exit(1);
  }

  const manifest = loadManifest(path.resolve('skills.manifest.json'));
  console.log(`  Manifest: schemaVersion ${manifest.schemaVersion} · bundleVersion ${manifest.bundleVersion}`);

  const skillNames = args.skills || Object.keys(manifest.skills);
  const availableSkills = skillNames.filter(s => manifest.skills[s]);
  if (availableSkills.length === 0) {
    console.error(`${R}Error${X}: no matching skills in manifest`);
    process.exit(1);
  }
  console.log(`  Skills: ${availableSkills.join(', ')}`);

  maybeWarnGithubSkillsDeprecation(args, repoRoot);

  // Build write list from skills + Copilot merge
  const writes = [];
  const managedFiles = [];
  for (const skillName of availableSkills) {
    const { writes: sw, managedFiles: sm } = buildSkillWrites(skillName, manifest.skills[skillName], args, repoRoot);
    writes.push(...sw);
    managedFiles.push(...sm);
  }
  const copilot = buildCopilotMergeWrite(args, repoRoot);
  if (copilot) {
    writes.push(copilot.write);
    managedFiles.push(copilot.managed);
  }

  const { receipt: prevGlobalReceipt } = readReceipt(globalReceiptPath);
  const { receipt: prevRepoReceipt } = readReceipt(repoReceiptPath);
  // BOTH filters narrow what this run may prune. `--skills` selects which
  // skills; `--surface` selects which surfaces. Absent = covers that whole axis.
  const authority = {
    skills: args.skills ? new Set(availableSkills) : null,
    scopes: authoritativeScopesFor(args.surface),
  };
  const deletes = computeDeletes(writes, prevGlobalReceipt, prevRepoReceipt, repoRoot, authority);
  // A partial install must not erase the receipt's record of what it left alone
  // — otherwise the next run sees it as unmanaged and orphans it.
  managedFiles.push(
    ...retainUnmanagedEntries(prevRepoReceipt, authority),
    ...retainUnmanagedEntries(prevGlobalReceipt, authority),
  );
  const { allSafe, allConflicts } = checkConflicts(writes, prevGlobalReceipt, prevRepoReceipt, args);

  if (allConflicts.length > 0) {
    console.log(`\n${R}Conflicts detected:${X}`);
    for (const c of allConflicts) console.log(`  ${R}x${X} ${c.path}: ${c.reason}`);
    if (!args.force) {
      console.log(`\nUse --force to overwrite, or resolve conflicts first.`);
      process.exit(1);
    }
  }

  if (args.dryRun) {
    console.log(`\n${Y}Would write ${allSafe.length} files, delete ${deletes.length}:${X}`);
    for (const w of allSafe) console.log(`  ${G}+${X} ${w.path} ${D}(${w.scope})${X}`);
    for (const d of deletes) console.log(`  ${R}-${X} ${d.absPath}`);
    process.exit(0);
  }

  // `allSafe` deliberately mixes repo-scope and global-scope (~/.claude/skills)
  // writes into ONE transaction. No journalPath is passed: placement follows the
  // transaction's own scope, which only transaction.mjs can see. A mixed-scope
  // transaction must journal at the GLOBAL anchor so other repos can see a crash
  // on the surface they share — a decision the caller has no business making,
  // because getting it wrong is invisible here and harms someone else's repo.
  const result = executeTransaction({
    writes: allSafe.map(w => ({ absPath: w.absPath, content: w.content })),
    deletes,
    repoRoot,
  });
  reportDegradations(result.degradations);

  if (!result.success) {
    console.error(`${R}Install failed${X}: ${result.error}`);
    console.error('All changes have been rolled back.');
    process.exit(1);
  }
  for (const skip of result.skippedDeletes) {
    console.log(`  ${Y}○${X} ${skip.absPath}: ${skip.reason}`);
  }
  if ((result.deleteFailures || []).length > 0) {
    console.error(`${R}[install] journal retained${X} — the next install will block until this is resolved.`);
  }

  const { repoManaged, globalManaged } = writeReceiptsByScope(
    managedFiles, manifest, args, repoReceiptPath, globalReceiptPath,
    { repo: prevRepoReceipt, global: prevGlobalReceipt },
  );
  // ── Repo-scope maintenance — gated on the SAME authority the delete-pruner
  // uses, so the two can't drift about what a `--surface` selection owns.
  //
  // `--surface claude` writes only global files (this module's own docstring
  // above says exactly that, and authoritativeScopesFor encodes it), so it must
  // not mutate REPO files either. Both calls below do: ensureAuditGitignore
  // rewrites .gitignore, ensureAuditDeps rewrites package.json and shells out to
  // npm install.
  //
  // Why this mattered (2026-07-19): the source repo's own post-merge hook runs
  // `install-skills.mjs --local --surface claude --force` after EVERY git pull,
  // so a global skill refresh was silently appending a consumer-shaped managed
  // block to the source repo's .gitignore — every pattern of it already covered
  // by the existing bare `.audit/` rule, i.e. pure churn. Same shape as the
  // 2026-07-15 bundle-pattern incident that gitignore.mjs's source-repo filter
  // was added for; that filter caught the BUNDLE patterns but not the
  // operational-state ones, because the real defect is a global-surface run
  // touching repo scope at all.
  //
  // Consumers are unaffected: their managed gitignore block is owned by
  // `npm run sync` (sync-gitignore.mjs::updateManagedBlock), and a full
  // `--surface both` install still maintains both of these.
  const repoScopeAuthority = authoritativeScopesFor(args.surface);
  if (repoScopeAuthority === null || repoScopeAuthority.has('repo')) {
    ensureAuditGitignore(repoRoot, { dryRun: args.dryRun });
    ensureAuditDeps(repoRoot, { dryRun: args.dryRun });
  }

  console.log(`\n${G}Installed ${result.written} files${X}${result.deleted ? `, deleted ${result.deleted}` : ''}`);
  console.log(`  Bundle version: ${manifest.bundleVersion}`);
  if (repoManaged.length > 0) console.log(`  Repo receipt: ${path.relative(repoRoot, repoReceiptPath)}`);
  if (globalManaged.length > 0) console.log(`  Global receipt: ${globalReceiptPath}`);
  for (const w of allSafe) console.log(`  ${G}+${X} ${w.path} ${D}(${w.scope})${X}`);

  // deleteFailures.length > 0 is the ONLY signal driving this exit code —
  // never skippedDeletes.length (which also counts benign conflict-skipped
  // entries) and never a reason-string match. The install itself succeeded
  // (writes/renames committed); this only means a retained journal will
  // block the NEXT install until resolved.
  if ((result.deleteFailures || []).length > 0) process.exit(1);
}

/**
 * Internal seams exposed for tests. Underscore-prefixed per this repo's
 * convention (file-io.mjs, shared.mjs, anthropic-client.mjs).
 */
export const _internals = {
  reconcileJournals, reportDegradations, computeDeletes, writeReceiptsByScope,
  retainUnmanagedEntries, authoritativeScopesFor,
};

// isMain guard — importing this module (e.g. from a test) must not run an
// install. Matches the pattern used by memory-health.mjs / symbol-index/drift.mjs.
const isMain = import.meta.url === `file://${process.argv[1]}`
  || import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}`;

if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`${R}Install error${X}: ${err.message}`);
    if (process.env.DEBUG) console.error(err.stack);
    process.exit(1);
  }
}
