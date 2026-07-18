/**
 * @fileoverview Path-based domain tagger for the symbol index.
 *
 * Maps a symbol's file path to a domain tag (e.g. "wine-data", "ui",
 * "auth") using ordered glob rules from .audit-loop/domain-map.json.
 *
 * Why not use claudemd/file-scanner.mjs:matchPattern?
 *   That helper only supports leading `**\/` (filename-anywhere) and
 *   single-segment `*`. Domain rules need `prefix/**` (subtree) and
 *   `*.ext` extension matching, which are common in repo-organisation
 *   patterns (e.g. `scripts/lib/brainstorm/**` for the brainstorm
 *   sub-bundle).
 *
 * Rule application is FIRST-MATCH-WINS — order in the JSON file matters.
 * Rules with more specific paths should come before broad catch-alls.
 *
 * @module scripts/lib/symbol-index/domain-tagger
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCoverageConfig } from './graph-verdict.mjs';

const DOMAIN_MAP_RELATIVE = '.audit-loop/domain-map.json';
const VALID_DOMAIN_RE = /^[a-z][a-z0-9_-]{0,49}$/;

/**
 * Match a forward-slash-normalised file path against a glob pattern.
 *
 * Supported syntax:
 *   - `**` matches zero or more path segments
 *   - `*` matches one segment (no slashes)
 *   - `*.ext` matches one segment ending in `.ext`
 *   - Literal segments must match exactly
 *
 * @param {string} filePath - cwd-relative path; backslashes accepted on Windows
 * @param {string} pattern  - glob pattern from a domain rule
 * @returns {boolean}
 */
export function matchGlob(filePath, pattern) {
  if (typeof filePath !== 'string' || typeof pattern !== 'string') return false;
  const norm = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const pat = pattern.replaceAll('\\', '/').replace(/^\.\//, '');

  // Build a single anchored regex: split on `**`, escape literals, replace `*`
  // and `**` with the right regex. Anchored at both ends so partial paths
  // never accidentally match (`scripts/lib` MUST NOT match `scripts/lib/foo`
  // unless the pattern explicitly says so).
  const re = new RegExp('^' + globToRegexBody(pat) + '$');
  return re.test(norm);
}

function globToRegexBody(pat) {
  let out = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      // `**` → match any chars including slashes (zero or more).
      //
      // The two forms are deliberately NOT symmetric:
      //   LEADING  `**/x`      → the slash FOLLOWS and is made optional, so
      //                          this matches both `x` and `deep/x`.
      //   TRAILING `prefix/**` → compiles to `prefix/.*`, which does NOT
      //                          match a bare `prefix`. That is INTENTIONAL:
      //                          it matches bash + gitignore semantics, and
      //                          `tagDomain` is only ever handed FILE paths,
      //                          never bare directories. Asserted in
      //                          tests/domain-tagger.test.mjs.
      //
      // A round-1 LOW and a final-gate MEDIUM both read the previous comment
      // here — which described the LEADING form and implied it covered the
      // trailing one — and concluded the trailing form was broken. It is not;
      // the comment was. "Fixing" the code to match those findings broke the
      // existing bash-semantics test, which is how the mistake surfaced. Do
      // not change this again without changing that test first, deliberately.
      if (pat[i + 2] === '/') {
        out += '(?:.*\\/)?';
        i += 3;
      } else {
        out += '.*';
        i += 2;
      }
    } else if (ch === '*') {
      // single `*` → match any chars except `/`
      out += '[^/]*';
      i += 1;
    } else if ('.+?^$|()[]{}\\'.includes(ch)) {
      out += '\\' + ch;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * Tag a file path with a domain by applying rules in order.
 *
 * @param {string} filePath
 * @param {Array<{pattern: string, domain: string}>} rules
 * @returns {string|null} domain tag, or null if no rule matched
 */
export function tagDomain(filePath, rules) {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== 'string' || typeof rule.domain !== 'string') continue;
    if (matchGlob(filePath, rule.pattern)) return rule.domain;
  }
  return null;
}

/**
 * Precompile a rule set into a fast tagger that reuses the same anchored
 * regex per pattern instead of rebuilding it on every call. Use this when
 * you'll tag many file paths against the same rules (e.g. tagging
 * thousands of import edges in `computeObservedDomainDeps`).
 *
 * Returns a function `(filePath) => domain | null` with the same semantics
 * as `tagDomain` — first-match-wins, malformed rules skipped, returns null
 * when no rule matches. Plan: docs/plans/observed-domain-deps.md (Gemini-R3-G1).
 *
 * @param {Array<{pattern: string, domain: string}>} rules
 * @returns {(filePath: string) => (string | null)}
 */
export function makeFastTagger(rules) {
  if (!Array.isArray(rules) || rules.length === 0) {
    return () => null;
  }
  const compiled = [];
  for (const rule of rules) {
    if (!rule || typeof rule.pattern !== 'string' || typeof rule.domain !== 'string') continue;
    const norm = rule.pattern.replaceAll('\\', '/').replace(/^\.\//, '');
    compiled.push({
      re: new RegExp('^' + globToRegexBody(norm) + '$'),
      domain: rule.domain,
    });
  }
  return (filePath) => {
    if (typeof filePath !== 'string') return null;
    const norm = filePath.replaceAll('\\', '/').replace(/^\.\//, '');
    for (const c of compiled) {
      if (c.re.test(norm)) return c.domain;
    }
    return null;
  };
}

/**
 * Compute the distinct domain tags for a list of target paths.
 * Used by /plan to anchor planning in the architecture map and surface
 * cross-domain work + untagged paths.
 *
 * Plan: docs/plans/arch-memory-planning-anchor.md §2.2 (R2-M4: untagged
 * paths surfaced rather than silently dropped).
 *
 * @param {string[]} targetPaths
 * @param {Array<{pattern: string, domain: string}>} rules
 * @returns {{
 *   domains: string[],         // tagged domains, sorted alphabetically
 *   untaggedPaths: string[],   // paths with no matching rule
 *   crossDomain: boolean       // true when domains.length > 1
 * }}
 */
export function computeTargetDomains(targetPaths, rules) {
  const tagged = new Set();
  const untagged = [];
  const paths = Array.isArray(targetPaths) ? targetPaths : [];
  for (const p of paths) {
    if (typeof p !== 'string') continue;
    const d = tagDomain(p, rules);
    if (d) tagged.add(d);
    else untagged.push(p);
  }
  return {
    domains: Array.from(tagged).sort(),
    untaggedPaths: untagged,
    crossDomain: tagged.size > 1,
  };
}

/**
 * Load + validate domain rules from a repo's .audit-loop/domain-map.json.
 * Missing file or unreadable JSON is treated as "no rules" (returns []).
 * Invalid rule entries are dropped silently (with a stderr warning).
 *
 * Rule shape:
 *   { "rules": [
 *       { "pattern": "scripts/lib/brainstorm/**", "domain": "brainstorm" },
 *       ...
 *   ] }
 *
 * @param {string} repoRoot - absolute path to repo root
 * @returns {Array<{pattern: string, domain: string}>}
 */
/**
 * Load + normalize the `coverage` block of `.audit-loop/domain-map.json`.
 *
 * A sibling of `loadDomainRules` rather than a change to its return shape —
 * this module stays the single owner of the FILE (§2.1.4) without breaking
 * every existing caller of a function that returns an array.
 *
 * Defaulting is delegated to `parseCoverageConfig`, which is the ONLY
 * defaulting site: two would let the CLI and the dashboard drift to different
 * thresholds while both looking correct.
 *
 * Never throws — a malformed domain-map must not take down `arch:refresh`
 * (#16). Note that `arch-coverage-gate` deliberately does NOT inherit that
 * leniency: see §2.1.4 "BINDING ON PHASE 4".
 *
 * @param {string} repoRoot
 * @param {(msg: string) => void} [warn]
 * @returns {object} fully-defaulted coverage config
 */
export function loadCoverageConfig(repoRoot, warn) {
  const emit = warn || ((m) => process.stderr.write(`  [domain-tagger] ${m}\n`));
  const file = path.join(repoRoot, DOMAIN_MAP_RELATIVE);
  if (!fs.existsSync(file)) return parseCoverageConfig(undefined, emit);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return parseCoverageConfig(raw?.coverage, emit);
  } catch (err) {
    emit(`WARN: ${file} is invalid JSON (${err.message}); using coverage defaults`);
    return parseCoverageConfig(undefined, emit);
  }
}

export function loadDomainRules(repoRoot) {
  const file = path.join(repoRoot, DOMAIN_MAP_RELATIVE);
  if (!fs.existsSync(file)) return [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    process.stderr.write(`  [domain-tagger] WARN: ${file} is invalid JSON (${err.message}); ignoring\n`);
    return [];
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.rules)) {
    process.stderr.write(`  [domain-tagger] WARN: ${file} missing "rules" array; ignoring\n`);
    return [];
  }
  const out = [];
  for (const r of raw.rules) {
    if (!r || typeof r.pattern !== 'string' || typeof r.domain !== 'string') {
      process.stderr.write(`  [domain-tagger] WARN: skipping malformed rule: ${JSON.stringify(r)}\n`);
      continue;
    }
    if (!VALID_DOMAIN_RE.test(r.domain)) {
      process.stderr.write(`  [domain-tagger] WARN: skipping rule with invalid domain "${r.domain}" (must match ${VALID_DOMAIN_RE})\n`);
      continue;
    }
    out.push({ pattern: r.pattern, domain: r.domain });
  }
  return out;
}
