/**
 * @fileoverview /fleet configuration: optional keys in a consumer-owned
 * `.fleet.json` at the repo root, each reported with where it came from.
 *
 *  - `baseBranch`   config > origin/HEAD > fallback `main`
 *  - `testCommand`  a string (sugar for ONE pre-land tier named `default`) or
 *                   `{tiers:[...]}`; default `npm test` when package.json has a
 *                   real `scripts.test`, else none (`land` refuses)
 *  - `mergeMethod`  `pr` (default) | `direct-squash` | `direct-merge`
 *  - `checks`       the extension hook (§2b)
 *  - `hotFiles`     claim-grammar patterns for files nearly every branch touches
 *                   (ratchet baselines, debt ledgers): overlaps made only of them
 *                   are disclosed, never counted as conflicts, never blocking
 *  - `hideIdleAfterDays` the default `status` view hides an untracked branch with
 *                   no commit for this many days (default 14; `--all` shows it)
 *
 * Validation is strict (`z.strictObject`): an unknown key is an error NAMING it.
 * Commands are argv arrays only — a shell string in a tier or a check is a
 * config error; the one exception is a plain-string `testCommand`, which is
 * argv-split when it holds no shell metacharacters and otherwise carried as a
 * single shell command flagged `shell:true`.
 *
 * Two layers: `parseFleetConfig` is pure (tested without git); `resolveConfig`
 * adds the repo lookups and throws `ConfigError` listing every problem.
 *
 * Plan: docs/plans/fleet-multi-session-coordination.md §2 Config, §2b, §7 (Phase 3).
 *
 * @module scripts/lib/fleet/config
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { runGit, gitCommonDir, repoToplevel } from './git-facts.mjs';
import { DEFAULT_IDLE_DAYS, validateClaimPattern } from './overlap.mjs';
import { MERGE_METHODS, NoteSchema, TIER_NAME_RE, TierSchema as PersistedTierSchema, argvSchema, isInside } from './contracts.mjs';

export { MERGE_METHODS };
const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./\\-]+$/;
const NPM_PLACEHOLDER = /no test specified/;

export class ConfigError extends Error {
  /** @param {string[]} errors */
  constructor(errors) {
    super(`invalid fleet config:\n  - ${errors.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.errors = errors;
  }
}

const timeout = () => z.number().int().positive();
export const MAX_HOT_FILES = 200;

/** User-facing tier: the persisted tier minus `shell` (only a string testCommand may set it). */
const TierSchema = PersistedTierSchema.omit({ shell: true });

const CheckSchema = z.strictObject({
  name: z.string().regex(TIER_NAME_RE, 'must match [a-z0-9][a-z0-9_-]*'),
  script: z.string().min(1, 'script is required').refine((v) => v.trim() !== '', 'script must not be blank'),
  runner: argvSchema().optional(),
  args: z.array(z.string(), { error: 'must be an argv array of strings' }).optional(),
  runIn: z.array(z.enum(['status', 'land'])).min(1).default(['status', 'land']),
  severity: z.enum(['block', 'warn']).default('warn'),
  timeoutMs: timeout().default(60_000),
  note: NoteSchema.optional(),
});

const TierListSchema = z.strictObject({ tiers: z.array(TierSchema).min(1) });

const FleetFileSchema = z.strictObject({
  baseBranch: z.string().min(1).regex(/^[^\s-][^\s]*$/, 'must not contain whitespace or start with "-"').optional(),
  // string | {tiers} is validated by hand: a z.union reports one opaque "Invalid input" and loses the key.
  testCommand: z.unknown().optional(),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  checks: z.array(CheckSchema).optional(),
  // Each entry is validated against the claim grammar below (bounded, repo-relative), so hot-file
  // matching and claim matching share one semantics.
  hotFiles: z.array(z.string(), { error: 'must be an array of path patterns' }).max(MAX_HOT_FILES).optional(),
  hideIdleAfterDays: z.number().int('must be a whole number of days').min(1).max(3650).optional(),
});

const issuePath = (i) => i.path.length ? i.path.join('.') : '(root)';
const describeIssue = (i) => (i.code === 'unrecognized_keys'
  ? `${issuePath(i)}: unknown key ${i.keys.map((k) => JSON.stringify(k)).join(', ')}`
  : `${issuePath(i)}: ${i.message}`);

/**
 * A `script` must be repo-relative and stay inside the repo.
 * @returns {string|null} error message or null
 */
export function validateScriptPath(script) {
  const s = String(script).replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return 'script must be a repo-relative path, not absolute';
  if (s.split('/').includes('..')) return 'script must not escape the repo ("..")';
  return null;
}

/**
 * Normalise a string `testCommand` into one pre-land tier named `default`.
 * Plain words become argv; anything with shell syntax is kept whole and flagged.
 */
export function stringToTier(str) {
  const tokens = str.trim().split(/\s+/);
  if (tokens.every((t) => SAFE_TOKEN.test(t))) return { name: 'default', stage: 'pre-land', command: tokens };
  return { name: 'default', stage: 'pre-land', command: [str.trim()], shell: true };
}

/**
 * Pure parse + validate of an already-JSON-parsed `.fleet.json`.
 *
 * @param {unknown} raw - parsed file contents (`{}` / undefined when no file)
 * @param {{hasPackageTest?: boolean}} [ctx]
 * @returns {{ok: true, value: {baseBranch: string|null, testCommand: object[], testCommandSource: 'config'|'package.json'|'unset',
 *   mergeMethod: string, mergeMethodSource: 'config'|'default', checks: object[], hotFiles: string[], hideIdleAfterDays: number}}
 *   | {ok: false, errors: string[]}}
 */
export function parseFleetConfig(raw, { hasPackageTest = false } = {}) {
  const parsed = FleetFileSchema.safeParse(raw ?? {});
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map(describeIssue) };
  const cfg = parsed.data;
  const errors = [];

  let tiers; let testCommandSource;
  const tc = cfg.testCommand;
  if (tc !== undefined && typeof tc !== 'string' && (tc === null || typeof tc !== 'object')) {
    return { ok: false, errors: ['testCommand: must be a string or {tiers:[...]}'] };
  }
  if (typeof tc === 'string' && tc.trim() === '') return { ok: false, errors: ['testCommand: must not be empty'] };
  let tierList = null;
  if (tc !== undefined && typeof tc !== 'string') {
    const tl = TierListSchema.safeParse(tc);
    if (!tl.success) return { ok: false, errors: tl.error.issues.map((i) => describeIssue({ ...i, path: ['testCommand', ...i.path] })) };
    tierList = tl.data.tiers;
  }
  if (tc === undefined) {
    tiers = hasPackageTest ? [{ name: 'default', stage: 'pre-land', command: ['npm', 'test'] }] : [];
    testCommandSource = hasPackageTest ? 'package.json' : 'unset';
  } else {
    tiers = tierList ?? [stringToTier(tc)];
    testCommandSource = 'config';
    const names = tiers.map((t) => t.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup) errors.push(`testCommand.tiers: duplicate tier name "${dup}"`);
    if (!tiers.some((t) => t.stage === 'pre-land')) {
      errors.push('testCommand.tiers: at least one tier must be stage "pre-land" (a train with no pre-land tier would approve having tested nothing)');
    }
  }

  const checks = (cfg.checks ?? []).map((c, i) => {
    const bad = validateScriptPath(c.script);
    if (bad) errors.push(`checks.${i}.script: ${bad}`);
    return { ...c, script: c.script.replace(/\\/g, '/') };
  });
  (cfg.hotFiles ?? []).forEach((p, i) => {
    const r = validateClaimPattern(p);
    if (!r.ok) errors.push(`hotFiles.${i}: ${r.reason}`);
  });
  const cnames = checks.map((c) => c.name);
  const cdup = cnames.find((n, i) => cnames.indexOf(n) !== i);
  if (cdup) errors.push(`checks: duplicate check name "${cdup}"`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      baseBranch: cfg.baseBranch ?? null, testCommand: tiers, testCommandSource,
      mergeMethod: cfg.mergeMethod ?? 'pr', mergeMethodSource: cfg.mergeMethod ? 'config' : 'default', checks,
      hotFiles: cfg.hotFiles ?? [], hideIdleAfterDays: cfg.hideIdleAfterDays ?? DEFAULT_IDLE_DAYS,
    },
  };
}

/**
 * The integration-worktree root must be outside `.git` (test runners and
 * linters refuse to traverse it; nested git misreads the boundary) and outside
 * the repo's tracked tree.
 * @param {string} root
 * @param {{repoRoots: string[], gitDirs: string[]}} where
 * @returns {string|null} error message or null
 */
export function validateWorktreeRoot(root, { repoRoots, gitDirs }) {
  for (const g of gitDirs) if (isInside(root, g)) return `worktree root ${root} is inside the git directory ${g}`;
  for (const r of repoRoots) if (isInside(root, r)) return `worktree root ${root} is inside the repo's working tree ${r}`;
  return null;
}

/** Default root: `<repoRoot>/../.fleet-wt/<repoName>/` (the pinned-worktree sibling precedent). */
export function defaultWorktreeRoot(mainRoot) {
  const resolved = path.resolve(mainRoot);
  return path.join(path.dirname(resolved), '.fleet-wt', path.basename(resolved));
}

function resolveBaseBranch(cwd, configured) {
  if (configured) return { baseBranch: configured, source: 'config' };
  const r = runGit(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
  const m = r.ok ? /^origin\/(.+)$/.exec(r.stdout.trim()) : null;
  return m ? { baseBranch: m[1], source: 'origin/HEAD' } : { baseBranch: 'main', source: 'fallback' };
}

function readJsonFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf-8'); } catch (e) { return e.code === 'ENOENT' ? { absent: true } : { error: `cannot read ${file}: ${e.message}` }; }
  try { return { value: JSON.parse(text) }; } catch (e) { return { error: `${file} is not valid JSON: ${e.message}` }; }
}

/**
 * Resolve the effective configuration for the repo containing `cwd`.
 * @param {string} cwd
 * @param {{env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{baseBranch: string, testCommand: object[], mergeMethod: string, checks: object[], worktreeRoot: string,
 *   hotFiles: string[], hideIdleAfterDays: number,
 *   sources: {baseBranch: string, testCommand: string, mergeMethod: string, checks: string, worktreeRoot: string,
 *     hotFiles: string, hideIdleAfterDays: string}}}
 * @throws {ConfigError}
 */
export function resolveConfig(cwd, { env = process.env } = {}) {
  const top = repoToplevel(cwd);
  const common = gitCommonDir(cwd);
  if (!top.ok || !common.ok) throw new ConfigError([`not a git repository: ${top.reason ?? common.reason}`]);

  const file = readJsonFile(path.join(top.dir, '.fleet.json'));
  if (file.error) throw new ConfigError([file.error]);
  const pkg = readJsonFile(path.join(top.dir, 'package.json'));
  const testScript = pkg.value?.scripts?.test;
  const hasPackageTest = typeof testScript === 'string' && testScript.trim() !== '' && !NPM_PLACEHOLDER.test(testScript);

  const parsed = parseFleetConfig(file.value ?? {}, { hasPackageTest });
  if (!parsed.ok) throw new ConfigError(parsed.errors.map((e) => `.fleet.json ${e}`));
  const v = parsed.value;
  const base = resolveBaseBranch(cwd, v.baseBranch);

  const mainRoot = path.basename(common.dir) === '.git' ? path.dirname(common.dir) : top.dir;
  const fromEnv = typeof env.FLEET_WORKTREE_ROOT === 'string' && env.FLEET_WORKTREE_ROOT.trim() !== '';
  const worktreeRoot = path.resolve(fromEnv ? env.FLEET_WORKTREE_ROOT : defaultWorktreeRoot(mainRoot));
  const rootErr = validateWorktreeRoot(worktreeRoot, { repoRoots: [...new Set([mainRoot, top.dir])], gitDirs: [common.dir] });
  if (rootErr) throw new ConfigError([`${fromEnv ? 'FLEET_WORKTREE_ROOT' : 'worktree root'}: ${rootErr}`]);

  return {
    baseBranch: base.baseBranch, testCommand: v.testCommand, mergeMethod: v.mergeMethod, checks: v.checks, worktreeRoot,
    hotFiles: v.hotFiles, hideIdleAfterDays: v.hideIdleAfterDays,
    sources: {
      baseBranch: base.source, testCommand: v.testCommandSource, mergeMethod: v.mergeMethodSource,
      checks: file.value?.checks ? 'config' : 'default', worktreeRoot: fromEnv ? 'env' : 'default',
      hotFiles: file.value?.hotFiles ? 'config' : 'default', hideIdleAfterDays: file.value?.hideIdleAfterDays ? 'config' : 'default',
    },
  };
}
