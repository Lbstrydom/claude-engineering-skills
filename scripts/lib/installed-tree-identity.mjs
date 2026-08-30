/**
 * @fileoverview Does an INSTALLED `node_modules` still match the
 * `package-lock.json` it was installed from?
 *
 * The pre-push sandbox links the main checkout's `node_modules` instead of
 * paying `npm ci`. Manifest identity between the two CHECKOUTS
 * ({@link module:scripts/lib/dependency-identity}) says nothing about whether
 * the main checkout's own installed tree still reflects its OWN lockfile — a
 * developer can edit `package-lock.json`, or pull a commit that changes it, and
 * never re-run `npm install`. Linking then runs the whole `check` chain against
 * dependencies nobody's lockfile describes, and reports green.
 *
 * **The defect this replaces (measured 2026-08-30).** That question used to be
 * answered by mtime: `package-lock.json` newer than the `node_modules`
 * DIRECTORY meant "possible stale install". A directory's mtime moves only when
 * a TOP-LEVEL entry is added or removed, and `npm install` writes the lockfile
 * LAST — so the oracle reported STALE on the healthiest possible state.
 * Measured directly on a tree `npm install` had just called *"up to date in
 * 6s"*: lockfile 13:24:07, `node_modules/` 13:22:07, verdict STALE. It stays
 * STALE until something unrelated happens to add or remove a top-level entry
 * (a build tool creating `node_modules/.cache` will do it), at which point the
 * same tree silently reads FRESH with the lockfile 18 days older. That is not a
 * heuristic with false positives — it is a coin-flip on an unrelated event, and
 * on 2026-08-30 it landed on STALE and forced a full `npm ci` that then failed
 * and blocked the push.
 *
 * **npm already maintains the correct oracle.** `node_modules/.package-lock.json`
 * — npm's "hidden lockfile", written at the end of every install since npm 7 —
 * records the tree that is ACTUALLY on disk, in the same `packages` shape as the
 * root lockfile. Comparing content answers the real question and costs ~1ms for
 * this repo's 455/410-entry pair, versus tens of seconds for the install the
 * mtime flap was triggering.
 *
 * **Why not compare raw key counts.** They legitimately differ: measured here,
 * the root lockfile declares 455 entries and the hidden one records 410. Every
 * one of the 45 missing entries is flagged `optional` (43 also `dev`) — deps npm
 * deliberately skipped for this platform. Absence of an OPTIONAL entry is
 * therefore normal and must not force an install; absence of a required one must.
 *
 * **Fails CLOSED, like its sibling.** Unreadable, unparseable, a non-object
 * root, a lockfile too old to have a `packages` map, or an entry of an
 * unexpected shape all report `stale: true` with a reason. Installing when we
 * needn't costs seconds; linking when we should have installed reports a green
 * gate over the wrong dependency tree.
 *
 * @module scripts/lib/installed-tree-identity
 */

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Pull the `packages` map out of a lockfile text, or explain why we cannot.
 *
 * @param {string|null|undefined} text
 * @param {string} label - how to name this file in a reason string
 * @returns {{ok: true, packages: Record<string, unknown>} | {ok: false, reason: string}}
 */
function readPackages(text, label) {
  if (typeof text !== 'string') return { ok: false, reason: `${label} could not be read` };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    return { ok: false, reason: `${label} is not valid JSON (${err.message})` };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, reason: `${label} root is ${Array.isArray(doc) ? 'an array' : typeof doc}, not an object` };
  }
  if (!isPlainObject(doc.packages)) {
    // lockfileVersion 1 has no `packages` map at all. Rather than grow a second
    // comparison for a format npm has not written since 2021, say so and install.
    return {
      ok: false,
      reason: `${label} has no "packages" map (lockfileVersion `
        + `${doc.lockfileVersion ?? 'unknown'} is not supported by this check)`,
    };
  }
  return { ok: true, packages: doc.packages };
}

/**
 * May this declared entry be legitimately absent from the installed tree?
 *
 * Only optional dependencies: npm skips them per-platform by design, so their
 * absence is a normal install, not a stale one. `devOptional` is npm's flag for
 * an entry reached optionally through the dev tree and is included for the same
 * reason — reading only one spelling would leave a hole in a check whose
 * failure mode is an unnecessary 45-second install on every push.
 *
 * @param {unknown} entry
 * @returns {boolean}
 */
function mayBeAbsent(entry) {
  return isPlainObject(entry) && (entry.optional === true || entry.devOptional === true);
}

/**
 * Compare a root `package-lock.json` against npm's hidden
 * `node_modules/.package-lock.json`.
 *
 * @param {string|null|undefined} rootLockText - `package-lock.json` contents
 * @param {string|null|undefined} hiddenLockText - `node_modules/.package-lock.json` contents
 * @returns {{stale: boolean, reason: string}} `reason` always explains the
 *   verdict, so the caller can name WHY it installed instead of leaving an
 *   unexplained pause in the middle of a push.
 */
export function installedTreeStale(rootLockText, hiddenLockText) {
  const root = readPackages(rootLockText, 'package-lock.json');
  if (!root.ok) return { stale: true, reason: root.reason };
  const hidden = readPackages(hiddenLockText, 'node_modules/.package-lock.json');
  if (!hidden.ok) return { stale: true, reason: hidden.reason };

  // Direction 1: everything INSTALLED must be what the lockfile pins. Catches a
  // lockfile edited (or pulled) since the install.
  for (const [location, installed] of Object.entries(hidden.packages)) {
    if (location === '') continue; // the root project, not a dependency
    const declared = root.packages[location];
    if (!isPlainObject(installed) || !isPlainObject(declared)) {
      return {
        stale: true,
        reason: declared === undefined
          ? `${location} is installed but absent from package-lock.json`
          : `${location} has an unexpected entry shape in one of the lockfiles`,
      };
    }
    if (declared.version !== installed.version) {
      return {
        stale: true,
        reason: `${location} is installed at ${installed.version ?? '(no version)'} `
          + `but package-lock.json pins ${declared.version ?? '(no version)'}`,
      };
    }
    if (declared.resolved !== installed.resolved) {
      return { stale: true, reason: `${location} resolves to a different tarball than package-lock.json pins` };
    }
  }

  // Direction 2: everything the lockfile REQUIRES must be installed. Asking only
  // direction 1 would pass a tree that is merely a subset — e.g. a
  // half-finished install, or one run with --omit=dev.
  for (const [location, declared] of Object.entries(root.packages)) {
    if (location === '') continue;
    if (Object.hasOwn(hidden.packages, location)) continue;
    if (mayBeAbsent(declared)) continue;
    return { stale: true, reason: `${location} is in package-lock.json but is not installed` };
  }

  return { stale: false, reason: 'the installed tree matches package-lock.json' };
}
