/**
 * @fileoverview Single oracle for "which of these candidate paths does this
 * repo NOT own" — extracted from `scripts/lib/claudemd/file-scanner.mjs`
 * (`ignoredUntrackedPaths`), which had it as a private, unexported helper.
 *
 * Consumer-friction-doctor plan D4: the doctor's own disowned-file probe and
 * `file-scanner.mjs` both need this predicate, and a second implementation is
 * exactly the class of drift AGENTS.md's "find the existing normaliser first"
 * rule exists to prevent. The body below is unchanged from the original.
 *
 * The predicate is ignored AND UNTRACKED, deliberately — not merely ignored.
 * `git check-ignore` reports a TRACKED file as ignored whenever a pattern
 * matches it, so filtering on ignore-status alone would silently stop judging a
 * committed file that happens to match one.
 * `git ls-files --others --ignored --exclude-standard` is exactly the
 * "untracked and ignored" set and cannot make that mistake.
 *
 * Asked of the CANDIDATES, never of the repo. Materialising the whole
 * ignored-and-untracked universe to classify a handful of walked files means
 * `git ls-files --others --ignored` enumerating every path under
 * `node_modules` — tens of thousands of entries, far past spawnSync's 1 MiB
 * default `maxBuffer`. ENOBUFS surfaces as `r.error`, and a fail-open guard
 * that returns the empty set on that error silently disables the exclusion.
 * Both queries below take the candidate list on **stdin**, so neither the
 * output size nor the Windows ~32K argv limit scales with repo size.
 *
 * Degrades to an EMPTY `paths` set (never throws) when git is unavailable or
 * this is not a work tree, leaving the caller's un-filtered candidate set
 * untouched — a scanner that throws because it is being run outside git is a
 * worse failure than one that scans slightly too much. The degradation is
 * WARNED about on stderr AND returned as `{degraded:true, warning}` (round-3
 * audit M20) — a caller that treats results as diagnostic evidence (the
 * doctor's probes are the intended future consumer this module's own
 * docstring names) must be able to tell "verified: nothing is disowned" apart
 * from "could not verify; the empty set means nothing was checked". Losing
 * the filter turns owned-file judgements into unowned-file noise; losing the
 * DISTINCTION turns an unverified result into a false-confident one.
 *
 * `git check-ignore` WITHOUT `--no-index` (what this module calls) already
 * excludes tracked paths from its own output — verified empirically (round-2
 * audit M7): a tracked file matching a .gitignore pattern reports exit 1
 * (no match) under the default mode, and only reports a match under
 * `--no-index`. An earlier version of this module ran a second
 * `git ls-files` pass to subtract tracked paths from `check-ignore`'s result,
 * on the mistaken belief that `check-ignore` reports tracked matches by
 * default — that subtraction was redundant (git already omits them) and pure
 * overhead, so it has been removed rather than kept as defensive redundancy.
 *
 * @module scripts/lib/disowned-paths
 */
import { spawnSync } from 'node:child_process';

/**
 * Which of `candidates` (repo-relative paths) are ignored AND untracked in
 * `repoRoot`?
 *
 * @param {string} repoRoot
 * @param {string[]} candidates repo-relative paths to classify
 * @returns {{paths: Set<string>, degraded: boolean, warning: string|null}}
 *   `degraded:true` means git could not be consulted at all — `paths` is
 *   empty because NOTHING was checked, not because nothing is disowned. A
 *   caller using this as diagnostic evidence (round-3 audit M20) must branch
 *   on `degraded`, not merely on whether `paths` is empty.
 */
export function ignoredUntrackedPaths(repoRoot, candidates) {
  const paths = [...new Set(candidates.map((p) => p.replaceAll(/\\/g, '/')))];
  if (paths.length === 0) return { paths: new Set(), degraded: false, warning: null };

  // Explicit maxBuffer (matches the 64 MiB convention this repo already
  // uses — repo-stack.mjs, duplicate-justification-pragma.mjs): routing the
  // QUERY through stdin (the 2026-08-11 fix) bounds the INPUT, but
  // `check-ignore`'s OUTPUT echoes back every MATCHED candidate — a caller
  // passing many candidates that are mostly ignored can still produce an
  // output past Node's 1 MiB spawnSync default. Verified empirically
  // (round-4 audit L1's stress-test fix): 20,000 genuinely-matching ~65-byte
  // paths (~1.3 MB of output) threw a REAL ENOBUFS here before this fix.
  const git = (args, input) => spawnSync('git', args, {
    cwd: repoRoot, input, encoding: 'utf-8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  const nulList = paths.join('\0');
  const split = (out) => (typeof out === 'string' ? out.split('\0').filter(Boolean) : []);

  // `check-ignore` exits 0 when at least one path is ignored, 1 when none are —
  // 1 is a legitimate answer, not a failure. Anything else (128 = not a work
  // tree, spawn error) means we could not determine ownership.
  const ign = git(['check-ignore', '-z', '--stdin'], nulList);
  if (ign.error || (ign.status !== 0 && ign.status !== 1)) {
    const warning = '[disowned-paths] WARN: could not determine gitignore status '
      + `(${ign.error ? ign.error.code || ign.error.message : `git exit ${ign.status}`}) — `
      + 'ownership was NOT verified; treating every candidate as owned by default, but this result is unverified, not a confirmed clean scan.';
    process.stderr.write(`${warning}\n`);
    return { paths: new Set(), degraded: true, warning };
  }
  // No further subtraction needed: `check-ignore` WITHOUT `--no-index` (above)
  // already excludes tracked paths from its own output (round-2 audit M7,
  // verified empirically) — its result set already IS "ignored and untracked".
  return {
    paths: new Set(split(ign.stdout).map((p) => p.replaceAll(/\\/g, '/'))),
    degraded: false,
    warning: null,
  };
}
