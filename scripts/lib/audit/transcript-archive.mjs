/**
 * @fileoverview Mirror every final-review transcript into a DURABLE archive
 * under the main checkout, so a transcript written inside a throwaway worktree
 * survives that worktree's removal.
 *
 * **The defect** (measured 2026-08-18, plan
 * `docs/plans/audit-transcript-durability.md`). `.audit/` is gitignored, so
 * every linked worktree keeps its own copy and it is deleted with the worktree.
 * Agent/chip sessions routinely run real audits in `.claude/worktrees/<name>`
 * and are then removed: ZERO transcripts dated 2026-08-17 existed anywhere on
 * disk while the store recorded real audit sessions that day. Findings,
 * verdicts and costs were safe — those go to Postgres — but the transcripts,
 * the only replayable INPUT the model-comparison campaigns have, were gone.
 * `final-review-scoped-2026q3` is stalled transcript-starved while this repo
 * audits constantly.
 *
 * **Why a MIRROR and not a redirect.** Writing the transcript straight to the
 * main checkout would be equally durable and was rejected: the path
 * `.audit/$SID-transcript.json` is spelled out in four SKILL.md files as the
 * argument to the MANDATORY `gemini-review.mjs review` gate, and that
 * prose↔code seam has no compiler. A missed reader means the gate dies on
 * `File not found` — the exact 2026-08-08 field failure `build-audit-transcript`
 * exists to fix. A mirror buys identical durability at zero blast radius; the
 * cost is one ~84KB duplicate per transcript.
 *
 * **Why not on teardown.** A cleanup hook only runs if cleanup runs, and it
 * demonstrably does not: `.claude/worktrees/` held two directories git had
 * already deregistered (a failed `git worktree remove` deregisters first). This
 * writes at transcript-write time, so durability depends on nothing later.
 *
 * **The failure contract.** Nothing here throws — every function returns a
 * structured outcome — but "does not throw" is not "does not matter". A
 * failed mirror is reported through `outcome.reason` AND, when the source is
 * volatile, through the CALLER'S EXIT CODE (`isArchiveFailure` +
 * `outcome.volatile`; see `build-audit-transcript.mjs`). The first draft only
 * warned, which restored the original loss mode through the reporting channel:
 * a warning nobody reads, then `git worktree remove`, then the transcript is
 * gone. The one caller that deliberately continues is `audit-loop.mjs`, which
 * is mid-run and about to feed this transcript to the final gate — there,
 * aborting destroys more than it protects.
 *
 * @module scripts/lib/audit/transcript-archive
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../file-io.mjs';
import { resolveMainRoot } from '../pinned-worktree/paths.mjs';

/** Archive location, relative to the MAIN checkout. */
export const ARCHIVE_RELDIR = path.join('.audit', 'transcripts');

/**
 * Matches the transcript artifacts, including the `-v2`/`-v3` re-review
 * variants. Deliberately the same widened shape `audit-clean.mjs` uses for its
 * retention window — a narrower `-transcript\.json$` is what let those variants
 * grow unpruned there, and here it would let them go unarchived.
 */
export const TRANSCRIPT_BASENAME_RE = /-?transcript(-[a-z0-9]+)?\.json$/i;

/**
 * Outcome reasons. Distinct per outcome ON PURPOSE: "nothing to do" and "tried
 * and could not" must never share a string. Collapsing those two is how the
 * `isP0OrP1` shape drift stayed invisible for its whole life (AGENTS.md
 * §"Contracts across the prose↔code seam").
 */
export const ARCHIVE_REASONS = Object.freeze({
  ARCHIVED: 'archived',
  ALREADY: 'already-archived',
  DISABLED: 'disabled',
  NO_REPO: 'not-in-a-repo',
  UNREADABLE: 'source-unreadable',
  COLLISION: 'name-collision-unresolved',
  FAILED: 'copy-failed',
});

/**
 * True when a NOT-archived outcome means the transcript is at risk — i.e. the
 * mirror was ATTEMPTED and could not complete, as opposed to an operator
 * switching it off. Callers use this to decide their exit code, so the
 * distinction has to live here rather than being re-derived per call site.
 *
 * `DISABLED` is excluded deliberately: `AUDIT_TRANSCRIPT_ARCHIVE=0` is a
 * choice, and a chosen degradation must not fail a build. Everything else in
 * the set is a failure wearing a warning's clothes.
 *
 * @param {{archived: boolean, reason: string}} outcome
 * @returns {boolean}
 */
export function isArchiveFailure(outcome) {
  if (!outcome || outcome.archived) return false;
  return outcome.reason !== ARCHIVE_REASONS.DISABLED;
}

/** `AUDIT_TRANSCRIPT_ARCHIVE=0` (or `false`) turns the mirror off. */
export function archiveEnabled(env = process.env) {
  const raw = env.AUDIT_TRANSCRIPT_ARCHIVE;
  return !(raw === '0' || String(raw).toLowerCase() === 'false');
}

/**
 * Absolute archive directory for the repository containing `cwd`, or null when
 * `cwd` is not inside a git repository at all.
 *
 * `resolveMainRoot` derives the MAIN checkout via `--git-common-dir/..`, which
 * resolves correctly from a linked worktree where `--show-toplevel` does not —
 * the same derivation `discoverLocalEnvPath` and `skills-hydrate` use. Reused
 * rather than re-spelled: a fifth copy of "find the main checkout" is how the
 * four existing ones would drift apart.
 *
 * @param {string} [cwd]
 * @returns {string|null}
 */
export function resolveArchiveDir(cwd = process.cwd()) {
  const root = resolveMainRootOrNull(cwd);
  return root ? path.join(root, ARCHIVE_RELDIR) : null;
}

/** `resolveMainRoot`, degraded to null outside a repository. */
export function resolveMainRootOrNull(cwd = process.cwd()) {
  try {
    return resolveMainRoot(cwd);
  } catch {
    return null;
  }
}

/**
 * Canonical identity of a filesystem path, for comparing or deduplicating
 * directories. **The single oracle for path identity in this feature** — both
 * the volatility test here and the sweep's candidate dedup use it, so the two
 * cannot disagree about whether two paths name the same place.
 *
 * `realpathSync.native` asks the FILESYSTEM, which is the only thing that
 * knows. An earlier draft case-folded by `process.platform`, which is a guess
 * in both directions: macOS APFS can be case-SENSITIVE (so folding merged the
 * genuinely-distinct `wt-A` and `wt-a`, silently dropping one from the sweep),
 * and NTFS can be case-sensitive per-directory. Canonicalising sidesteps the
 * question entirely — two paths naming one directory canonicalise identically
 * on a case-insensitive volume and differently on a case-sensitive one,
 * without this code knowing which it is on.
 *
 * Falls back to `path.resolve` when the path does not exist or cannot be
 * resolved, so a vanished worktree still gets a stable key.
 *
 * @param {string} p
 * @returns {string}
 */
export function canonicalPathKey(p) {
  const resolved = path.resolve(p).replace(/[\\/]+$/, '');
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/**
 * Worktree root containing `cwd` (`--show-toplevel`), or null outside a repo.
 * Distinct from `resolveMainRoot`, which crosses into the MAIN checkout: the
 * two differ exactly when we are in a linked worktree, which is the whole test.
 *
 * @param {string} cwd
 * @returns {string|null}
 */
function resolveWorktreeRoot(cwd) {
  try {
    return path.resolve(execFileSync(
      'git', ['rev-parse', '--path-format=absolute', '--show-toplevel'],
      { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim());
  } catch {
    return null;
  }
}

/**
 * Does this transcript die when its checkout is removed?
 *
 * True when the file's own worktree is not the main checkout — the case the
 * whole module exists for. **Fails CLOSED**: an unresolvable worktree root
 * reads as volatile, so an unknown situation is treated as at-risk rather than
 * safe. Callers gate their exit code on this, and the expensive mistake is the
 * one that says "durable" about a file that is not.
 *
 * @param {string} absSrc
 * @param {string|null} mainRoot
 * @returns {boolean}
 */
export function sourceIsVolatile(absSrc, mainRoot) {
  if (!mainRoot) return true;
  const own = resolveWorktreeRoot(path.dirname(absSrc));
  if (!own) return true;
  return canonicalPathKey(own) !== canonicalPathKey(mainRoot);
}

// @duplicate-justification: target=scripts/lib/nav/schema.mjs:sha256 reason=nav-audit is not an allowed dependency of audit-orchestration (.audit-loop/domain-map.json allowedDeps), and 65 files in this repo construct sha256 digests locally rather than sharing a wrapper — a 1-line crypto call is not a shared abstraction here
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * Write `body` to `target` ONLY if `target` does not exist, with no
 * check-then-write window: `atomicWriteFileSync({exclusive:true})` publishes
 * via `link()`, which fails `EEXIST` atomically in the filesystem.
 *
 * This is the whole answer to the concurrency finding. Two worktrees minting
 * one session id used to race between "does it exist?" and "write it", and the
 * loser's transcript was overwritten — silently losing exactly the artifact
 * this module protects.
 *
 * @param {string} target
 * @param {Buffer} body
 * @returns {'written'|'exists'}
 */
function claimTarget(target, body) {
  try {
    atomicWriteFileSync(target, body, { exclusive: true });
    return 'written';
  } catch (err) {
    if (err.code === 'EEXIST') return 'exists';
    throw err;
  }
}

/**
 * Read a file's bytes, or null if it is not there / not readable.
 * @param {string} p
 * @returns {Buffer|null}
 */
function readOrNull(p) {
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * Copy one transcript into the durable archive.
 *
 * **Never throws** — returns a structured outcome instead, so a caller can
 * print the truth without a try/catch. That is a reporting choice, NOT a
 * best-effort guarantee: see the failure contract in the module docstring for
 * which callers turn a failed mirror into a non-zero exit.
 *
 * Naming, and why it is not a plain overwrite: session ids are USUALLY unique
 * (`audit-code-<epoch>`), but hand-picked ones demonstrably are not — the live
 * worktree observed on 2026-08-18 carried `audit-plan-1755500000-transcript.json`,
 * an id another session could mint verbatim. So identical bytes under one name
 * collapse to a single file (making repeated sweeps idempotent), while
 * DIFFERING bytes get a content-derived suffix. Nothing is overwritten, and the
 * suffix is stable across re-harvests because it is a function of the content.
 *
 * Bytes are copied verbatim — deliberately NOT `canonicalizeEol`'d. This is an
 * archival copy, so the exact bytes ARE the contract (AGENTS.md: canonicalise
 * for hashing committed source, never where the bytes are the thing).
 *
 * Every outcome carries `volatile`: whether the SOURCE dies with its checkout.
 * A failed mirror in the main checkout is a nuisance (the local copy is already
 * durable); the same failure in a linked worktree is imminent data loss. The
 * caller's exit code depends on which, so the fact travels with the outcome
 * rather than being guessed at the call site.
 *
 * @param {string} srcPath - transcript to mirror
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, archiveDir?: string, mainRoot?: string|null}} [opts]
 * @returns {{archived: boolean, path: string|null, reason: string, volatile: boolean, error?: string}}
 */
export function archiveTranscript(srcPath, { cwd = process.cwd(), env = process.env, archiveDir, mainRoot } = {}) {
  const abs = path.resolve(cwd, srcPath);
  const root = mainRoot !== undefined ? mainRoot : resolveMainRootOrNull(cwd);
  const volatileSource = sourceIsVolatile(abs, root);
  const out = (archived, p, reason, extra = {}) => ({ archived, path: p, reason, volatile: volatileSource, ...extra });

  if (!archiveEnabled(env)) return out(false, null, ARCHIVE_REASONS.DISABLED);

  const dir = archiveDir ?? (root ? path.join(root, ARCHIVE_RELDIR) : null);
  if (!dir) return out(false, null, ARCHIVE_REASONS.NO_REPO);

  const body = readOrNull(abs);
  if (body === null) return out(false, null, ARCHIVE_REASONS.UNREADABLE);

  // Already IN the archive (the sweep sees the main checkout's own tree too):
  // copying a file onto itself is not an outcome worth reporting as work.
  const preferred = path.join(dir, path.basename(abs));
  if (path.resolve(abs) === path.resolve(preferred)) {
    return out(true, preferred, ARCHIVE_REASONS.ALREADY);
  }

  const digest = sha256(body);
  const ext = path.extname(preferred);
  // Same name, different transcript — two sessions minted one id. Disambiguated
  // by CONTENT rather than a counter, so the same bytes always land on the same
  // name and a repeated harvest is a no-op.
  const hashed = `${preferred.slice(0, preferred.length - ext.length)}-${digest.slice(0, 8)}${ext}`;

  try {
    fs.mkdirSync(dir, { recursive: true });
    // Claim the name with an exclusive create, never a read-then-write: a
    // check-then-write leaves a window in which a concurrent worktree publishes
    // the same basename and this write clobbers it. `claimTarget` closes the
    // window in the filesystem.
    for (const target of [preferred, hashed]) {
      if (claimTarget(target, body) === 'written') {
        // Audit the success path: read the published bytes back and compare.
        // "I called write and it did not throw" is not the same claim as "the
        // durable copy is correct" — and this function's entire purpose is to
        // be trustworthy about the second. A short or corrupted copy that
        // reported `archived` would be worse than no copy at all, because the
        // exit-code contract above would then report durability that is absent.
        const readBack = readOrNull(target);
        if (readBack === null || sha256(readBack) !== digest) {
          return out(false, target, ARCHIVE_REASONS.FAILED, {
            error: readBack === null
              ? 'archived file could not be read back'
              : 'archived file does not match the source bytes',
          });
        }
        return out(true, target, ARCHIVE_REASONS.ARCHIVED);
      }
      // Someone got there first. Identical bytes ⇒ the transcript IS durable,
      // whoever wrote it.
      const rival = readOrNull(target);
      if (rival !== null && sha256(rival) === digest) return out(true, target, ARCHIVE_REASONS.ALREADY);
    }
    // Both names taken by DIFFERENT content: the second implies a sha256-prefix
    // collision between two real transcripts. Refuse rather than overwrite —
    // silently losing a transcript is the bug this module exists to fix.
    return out(false, hashed, ARCHIVE_REASONS.COLLISION);
  } catch (err) {
    return out(false, hashed, ARCHIVE_REASONS.FAILED, { error: err.message });
  }
}

/**
 * One human line describing an outcome. Shared so the two write sites and the
 * sweep all say the same thing about the same result.
 *
 * @param {string} srcPath
 * @param {ReturnType<typeof archiveTranscript>} outcome
 * @returns {string}
 */
export function formatArchiveOutcome(srcPath, outcome) {
  const base = path.basename(srcPath);
  // The consequence, not just the cause: in a linked worktree a failed mirror
  // means this file is about to be lost, and that is what the reader needs to
  // act on. In the main checkout the local copy is already durable.
  const stake = outcome.volatile
    ? ` — ${base} will be LOST when this worktree is removed`
    : ` — ${base} survives here (main checkout), but is not in the archive`;
  switch (outcome.reason) {
    case ARCHIVE_REASONS.ARCHIVED: return `  [transcript] archived → ${outcome.path}`;
    case ARCHIVE_REASONS.ALREADY: return `  [transcript] archived (already present) → ${outcome.path}`;
    case ARCHIVE_REASONS.DISABLED: return `  [transcript] NOT archived: AUDIT_TRANSCRIPT_ARCHIVE=0${stake}`;
    case ARCHIVE_REASONS.NO_REPO: return `  [transcript] NOT archived: ${base} is not inside a git repository${stake}`;
    case ARCHIVE_REASONS.UNREADABLE: return `  [transcript] NOT archived: could not read ${srcPath}${stake}`;
    case ARCHIVE_REASONS.COLLISION: return `  [transcript] NOT archived: ${base} collides with a DIFFERENT transcript already at ${outcome.path}${stake}`;
    default: return `  [transcript] NOT archived: ${outcome.error || outcome.reason}${stake}`;
  }
}
