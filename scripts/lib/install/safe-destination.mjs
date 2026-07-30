/**
 * @fileoverview The single destination-containment guard for managed writes.
 *
 * Every managed write, delete and rename in this bundle passes through here, so
 * a caller cannot be talked into touching a path outside the root it declared.
 *
 * ## Why a one-time CLI check is not enough
 *
 * `resolveAdHocTarget` canonicalises the *root* an operator supplies. That is
 * necessary and not sufficient: the root can be perfectly innocent while one of
 * the managed destinations *beneath* it — `.claude/`, `.claude/skills/`,
 * `scripts/`, `scripts/.claude-skills/` — is itself a symlink or a Windows
 * junction pointing somewhere else. The writer would follow it and overwrite
 * files the operator never named, despite a clean root check. This is INC-001's
 * lesson applied to the destination side.
 *
 * It also validates `root` ITSELF, rather than assuming a caller checked it.
 * The `--uninstall-legacy` delete path never passes through `resolveAdHocTarget`
 * at all — its roots are `globalSurfaceRoot()` and `<repo>/.agents/skills` — so a
 * guard that trusted its root would leave the one operation that deletes from a
 * user's home directory completely unprotected.
 *
 * ## Threat model, stated honestly
 *
 * This does NOT close the TOCTOU window. Any check-then-write sequence has one,
 * and Node exposes no portable `openat`/`O_NOFOLLOW` primitive that would let us
 * eliminate it. What it does buy is defence against the failure modes that
 * actually occur here — a pre-existing symlinked directory, a stale junction
 * from another tool, a target path mistyped into a linked tree — and it narrows
 * the window to the interval between check and write. It is not a defence
 * against a local attacker actively racing a privileged install, and nothing
 * here should be read as claiming otherwise. A security claim the code cannot
 * honour is worse than a scoped one, because the next reader builds on it.
 *
 * Plan: docs/plans/repo-scoped-skill-surfaces-and-installer.md §6 S2.
 *
 * @module scripts/lib/install/safe-destination
 */
import fs from 'node:fs';
import path from 'node:path';

/** Error thrown when a destination escapes, or could escape, its declared root. */
export class ContainmentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainmentError';
    this.code = 'DESTINATION_NOT_CONTAINED';
  }
}

/**
 * Is this dirent a symlink or a Windows reparse point (junction)?
 *
 * `lstat` does not follow, which is the whole point — `stat`/`existsSync` would
 * resolve the link and report on its target, hiding exactly what we are looking
 * for.
 *
 * **ENOENT is a PASS, and that is load-bearing.** An empty target directory is a
 * valid first install (S3b), so on adoption almost none of the managed
 * destinations exist yet. A traversal that let ENOENT propagate would crash the
 * primary adoption path — the very thing this bundle is being made able to do.
 * A non-existent component cannot be a symlink, so its absence ends the walk
 * successfully. Every OTHER errno still fails closed.
 *
 * @param {string} p
 * @returns {{exists: boolean, link: boolean}}
 */
function inspectEntry(p) {
  try {
    const st = fs.lstatSync(p);
    return { exists: true, link: st.isSymbolicLink() };
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, link: false };
    throw new ContainmentError(`cannot inspect ${p} (${err.code}) — refusing to write through it`);
  }
}

/**
 * Canonicalise the containment root before anything is compared against it.
 *
 * Validating the root's own dirent and then walking BELOW it leaves a gap: the
 * components leading TO the root are never inspected, so a root like
 * `/a/b/skills` where `/a/b` is a symlink passes every check while actually
 * living somewhere else entirely. Containment compared against a non-canonical
 * root is containment within a boundary we have not established.
 *
 * So: reject the root if its own entry is a link (the operator handed us one —
 * be explicit rather than silently following it), then `realpath` it so any
 * ANCESTOR link is resolved and every later comparison stands on real ground.
 *
 * A non-existent root resolves lexically and is fine: there is nothing to
 * write into it yet, and the component walk below will stop at the first
 * ENOENT anyway.
 *
 * @param {string} root
 * @returns {string} canonical absolute root
 */
function canonicalRoot(root) {
  const absRoot = path.resolve(root);
  const entry = inspectEntry(absRoot);
  if (entry.link) {
    throw new ContainmentError(`containment root is a symlink or reparse point: ${absRoot}`);
  }
  if (entry.exists) {
    try {
      return fs.realpathSync(absRoot);
    } catch (err) {
      throw new ContainmentError(`cannot canonicalise containment root ${absRoot} (${err.code})`);
    }
  }

  // The root does NOT exist yet — and returning the lexical path here was a real
  // hole, verified by probe: with `base/link -> outside` and a declared root of
  // `base/link/skills`, `lstat` on the root gave ENOENT, so nothing ever
  // inspected `base/link`, and the guard returned
  // `base/link/skills/x.md` — a path that actually lands in `outside/skills/`.
  // The returned value LIED about where the write goes, which is worse than a
  // rejection because the caller's containment reasoning was built on it.
  //
  // So walk up to the nearest EXISTING ancestor, realpath THAT (resolving any
  // ancestor link), then re-append the literal remainder. Same technique
  // transaction.mjs uses, and for the same reason. Resolving rather than
  // rejecting: a consumer repo living under a junctioned drive or symlinked
  // parent is a legitimate setup, and `resolveAdHocTarget` already canonicalises
  // the sync target before it ever reaches here — so the honest resolved path is
  // both correct and non-breaking.
  // `inspectEntry` (lstat), NOT `fs.existsSync`, to decide "does this exist?".
  // `existsSync` FOLLOWS symlinks, so it reports false for a DANGLING link — the
  // walk would step straight past a real symlinked ancestor as though nothing
  // were there and anchor containment one level too high. Same defect class as
  // the one fixed in `legacy-surfaces.mjs::classifyMember`, and the reason this
  // module never calls `existsSync` anywhere.
  let existing = absRoot;
  const remainder = [];
  while (!inspectEntry(existing).exists) {
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new ContainmentError(`containment root has no existing ancestor: ${absRoot}`);
    }
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  // Deliberately NOT rejecting a symlinked ancestor here — it is RESOLVED below.
  // A repo under a junctioned drive or symlinked parent is a legitimate setup,
  // and the defect being fixed is that the returned path used to LIE about where
  // the write lands, not that links exist at all. A dangling link needs no
  // special case either: it now correctly registers as "exists" (lstat), and
  // `realpathSync` below fails it with its own errno rather than being silently
  // walked past as `existsSync` did.
  let realAncestor;
  try {
    realAncestor = fs.realpathSync(existing);
  } catch (err) {
    throw new ContainmentError(`cannot canonicalise ${existing} (${err.code}) for root ${absRoot}`);
  }
  return remainder.length ? path.resolve(realAncestor, ...remainder) : realAncestor;
}

/**
 * Assert that `relPath` under `root` is a safe destination, and return the
 * absolute path to write.
 *
 * @param {object} args
 * @param {string} args.root the declared containment root (absolute)
 * @param {string} args.relPath destination relative to `root`
 * @returns {string} absolute destination path
 * @throws {ContainmentError}
 */
export function assertContainedDestination({ root, relPath }) {
  if (typeof root !== 'string' || root === '') {
    throw new ContainmentError('assertContainedDestination: root is required');
  }
  if (typeof relPath !== 'string' || relPath === '') {
    throw new ContainmentError('assertContainedDestination: relPath is required');
  }
  if (path.isAbsolute(relPath)) {
    // Destinations are derived from CLOSED relative paths only. Accepting an
    // absolute one would let a caller bypass the root entirely, which is the
    // rule this module exists to enforce rather than a case to normalise away.
    throw new ContainmentError(`destination must be relative to the root, got absolute: ${relPath}`);
  }

  const absRoot = canonicalRoot(root);

  const abs = path.resolve(absRoot, relPath);

  // Lexical escape (`..`, or a different Windows drive) — cheap, and catches the
  // case where no component exists yet so there is nothing to lstat.
  const rel = path.relative(absRoot, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ContainmentError(`destination escapes its root: ${abs} (root ${absRoot})`);
  }

  // Walk EVERY component, not just the nearest existing ancestor: a link three
  // levels down redirects the write just as effectively as one at the top.
  const parts = rel.split(/[\\/]/).filter(Boolean);
  let cursor = absRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    const entry = inspectEntry(cursor);
    if (!entry.exists) break;          // nothing below can exist either
    if (entry.link) {
      throw new ContainmentError(
        `destination path crosses a symlink or reparse point: ${cursor} (root ${absRoot})`,
      );
    }
  }

  return abs;
}

/**
 * Guard an absolute destination that a caller already computed.
 *
 * Convenience for the delete path, whose bounded set is receipt-derived absolute
 * paths rather than root+rel pairs. Rederives the relative form so there is
 * still exactly ONE containment implementation — a second, subtly different
 * check for deletes is precisely the drift this module exists to prevent.
 *
 * @param {{root: string, absPath: string}} args
 * @returns {string} the validated absolute path
 * @throws {ContainmentError}
 */
export function assertContainedAbsolute({ root, absPath }) {
  // Canonicalise the root here too — the relative form is derived from it, so a
  // non-canonical root would produce a relative path that means something else.
  const absRoot = canonicalRoot(root);
  const target = path.resolve(absPath);
  const rel = path.relative(absRoot, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ContainmentError(`path escapes its root: ${target} (root ${absRoot})`);
  }
  return assertContainedDestination({ root: absRoot, relPath: rel });
}

export const _internals = { inspectEntry };
