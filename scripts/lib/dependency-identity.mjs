/**
 * @fileoverview Does a `package.json` describe a DIFFERENT dependency tree?
 *
 * The pre-push sandbox links the main checkout's `node_modules` into the
 * throwaway worktree — instant, and correct whenever the pushed commit does not
 * change what would be installed. When it does, we must `npm ci`, or we would be
 * testing new code against an old dependency tree.
 *
 * **The defect this closes (measured 2026-08-11).** `prepush-check.mjs` decided
 * that by comparing the WHOLE `package.json` byte-for-byte. Commit e7e182ea
 * added one line to the `scripts` block and touched no lockfile, and the sandbox
 * threw away the instant link for a full 410-package `npm ci`. In a git worktree
 * this fired on nearly every push, because the sandbox's checkout is compared
 * against the MAIN checkout's file, which is routinely on a different commit —
 * so a `scripts`, `version`, `description` or formatting delta paid the install
 * cost every time.
 *
 * **Fields, and why these.** Everything npm reads when resolving the tree:
 * the four dependency maps, `overrides` (npm rewrites transitive resolutions),
 * `engines` (npm can refuse to install), and `peerDependenciesMeta` (flips a
 * peer between required and optional). `bundleDependencies` is listed beside
 * `bundledDependencies` because npm accepts BOTH spellings — reading only the
 * documented-canonical one would leave a real hole in a check whose failure mode
 * is silent.
 *
 * **Fails CLOSED, deliberately.** Unreadable file, unparseable JSON, a
 * non-object root, or a dependency field of an unexpected shape all report
 * `changed: true` with a reason. Installing when we did not need to costs
 * seconds; linking when we needed to install runs the entire `check` chain
 * against dependencies the commit does not describe, and reports green. Those
 * are not symmetric, so the ambiguous case takes the expensive branch.
 *
 * A side effect worth naming: comparing PARSED values means CRLF-vs-LF and
 * key-order churn stop reading as a dependency change — the same "hashing
 * working-tree bytes ≠ hashing committed source" trap AGENTS.md records for the
 * generated-artifact checks.
 *
 * @module scripts/lib/dependency-identity
 */

/**
 * The `package.json` fields that can change what `npm ci` would install.
 *
 * Ordering is fixed and the list is frozen because it IS the fingerprint's
 * shape: adding a field is a deliberate edit, and any field NOT here is
 * asserted not to affect the installed tree.
 */
export const DEPENDENCY_FIELDS = Object.freeze([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'peerDependenciesMeta',
  'bundledDependencies',
  'bundleDependencies',
  'overrides',
  'engines',
]);

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Recursively key-sorted clone, so `{a,b}` and `{b,a}` fingerprint identically. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

/**
 * Reduce a `package.json` to a canonical string covering only the fields that
 * decide the installed tree.
 *
 * @param {string|null|undefined} jsonText - raw file contents, or null/undefined
 *   when the file could not be read
 * @returns {{ok: true, fingerprint: string} | {ok: false, reason: string}}
 */
export function dependencyFingerprint(jsonText) {
  if (typeof jsonText !== 'string') return { ok: false, reason: 'package.json could not be read' };

  let doc;
  try {
    doc = JSON.parse(jsonText);
  } catch (err) {
    return { ok: false, reason: `package.json is not valid JSON (${err.message})` };
  }
  if (!isPlainObject(doc)) {
    return { ok: false, reason: `package.json root is ${Array.isArray(doc) ? 'an array' : typeof doc}, not an object` };
  }

  const picked = {};
  for (const field of DEPENDENCY_FIELDS) {
    if (!Object.hasOwn(doc, field)) continue;
    const value = doc[field];
    // An UNEXPECTED shape is not "no dependencies" — it is a file we do not
    // understand, and guessing about it is exactly the fail-open direction this
    // module refuses. `bundle(d)Dependencies` is legitimately an array of names;
    // everything else here is a map.
    const arrayAllowed = field === 'bundledDependencies' || field === 'bundleDependencies';
    const shapeOk = isPlainObject(value)
      || (arrayAllowed && Array.isArray(value) && value.every((v) => typeof v === 'string'));
    if (!shapeOk) {
      return {
        ok: false,
        reason: `package.json field "${field}" has an unexpected shape `
          + `(${Array.isArray(value) ? 'array' : typeof value}) — refusing to assume it is inert`,
      };
    }
    picked[field] = canonical(value);
  }
  return { ok: true, fingerprint: JSON.stringify(picked) };
}

/**
 * Compare two `package.json` texts by dependency-relevant content only.
 *
 * @param {string|null|undefined} mainText
 * @param {string|null|undefined} sandboxText
 * @returns {{changed: boolean, reason: string}} `reason` always explains the
 *   verdict, so the caller can log WHY it installed rather than leaving an
 *   unexplained 40-second pause in the middle of a push.
 */
export function dependencySetChanged(mainText, sandboxText) {
  const a = dependencyFingerprint(mainText);
  if (!a.ok) return { changed: true, reason: `main checkout: ${a.reason}` };
  const b = dependencyFingerprint(sandboxText);
  if (!b.ok) return { changed: true, reason: `sandbox checkout: ${b.reason}` };

  return a.fingerprint === b.fingerprint
    ? { changed: false, reason: 'dependency-relevant package.json fields are identical' }
    : { changed: true, reason: 'package.json dependency fields differ between the checkouts' };
}
