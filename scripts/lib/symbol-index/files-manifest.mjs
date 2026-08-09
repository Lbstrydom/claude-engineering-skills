/**
 * @fileoverview The `--files-from` manifest wire format — one formatter, one
 * parser, so the two producers and the single reader cannot drift.
 *
 * The manifest is how a caller hands `extract.mjs` an explicit file list
 * without overflowing the OS argv limit (Windows `ENAMETOOLONG` at ~1600+
 * files). It is also the handoff that decides WHICH files an incremental
 * refresh extracts, so a path that mangles here is a file silently not
 * indexed.
 *
 * **Why NUL, not newline** (topicIds `c191e74d781b` HIGH / `395e92881aa4`
 * MEDIUM): everything upstream of this seam is already NUL-clean — `vcs.mjs`
 * runs `git diff --name-status -z` / `git ls-files -z` and hard-fails on a
 * malformed stream — so a POSIX path containing a newline or leading/trailing
 * whitespace arrives here intact. The previous format (`join('\n')` on the
 * write side, `split('\n').map(s => s.trim())` on the read side) was the ONE
 * lossy hop in an otherwise faithful chain: it split such a path into two
 * phantom entries, or silently altered it. The file's own comment claimed
 * newline-delimited framing made "any filename safe", which was the inverse
 * of what it did.
 *
 * **Framing contract** — mirrors `vcs.mjs`'s `parseUntrackedPathsZ` verbatim,
 * because it is parsing the same class of stream:
 *   - Empty content is VALID and means a real zero-file scope (`[]`), never
 *     "unrestricted" (`null`) — see `isFullRunFromFiles`/`b021576b`.
 *   - Non-empty content MUST end in a NUL. A missing terminator means the
 *     write was truncated; reading a short list as a complete one is silent
 *     data loss, so it throws.
 *   - Exactly one trailing empty token (the string after the final NUL) is
 *     discarded — it is framing, not a record.
 *   - An interior empty token means a malformed stream and throws. Dropping
 *     it with `.filter(Boolean)` is the silent-data-loss class AGENTS.md
 *     names explicitly.
 *
 * There is deliberately NO legacy-newline fallback. A path containing a
 * newline is indistinguishable from a separator, so format sniffing would
 * reopen the exact bug this closes. Both producers and the reader ship in
 * one tree and are spawned as a matched pair, so there is no version-skew
 * window to bridge.
 *
 * @module scripts/lib/symbol-index/files-manifest
 */

/**
 * Serialize a file list to manifest content.
 *
 * Each path is written as its own NUL-TERMINATED record (not NUL-JOINED), so
 * an empty list yields empty content rather than a single bare NUL — which
 * would otherwise parse as one empty record and be rejected as malformed.
 *
 * @param {string[]} paths
 * @returns {string}
 */
export function formatFilesManifest(paths) {
  return paths.map(p => `${p}\0`).join('');
}

/**
 * Parse manifest content back into the exact file list that was written.
 *
 * @param {string} content
 * @param {string} [manifestPath] - included in error messages for locatability
 * @returns {string[]}
 * @throws {Error} on a missing NUL terminator or an interior empty token
 */
export function parseFilesManifest(content, manifestPath = '<manifest>') {
  if (content === '') return [];
  if (!content.endsWith('\0')) {
    throw new Error(
      `--files-from manifest ${manifestPath} did not end with a NUL terminator — `
      + 'the write was truncated, or the file is in the retired newline-delimited format',
    );
  }
  const tokens = content.split('\0');
  tokens.pop(); // discard exactly one trailing token: the empty string after the final NUL
  for (const t of tokens) {
    if (t === '') {
      throw new Error(`malformed --files-from manifest ${manifestPath}: empty path token`);
    }
  }
  return tokens;
}
