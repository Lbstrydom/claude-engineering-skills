/**
 * @fileoverview Shared test fixture helpers — small filesystem/git/stream
 * primitives that were independently copy-pasted, byte-identically, across
 * many test files (flagged by `arch:duplicates`). Consolidated here
 * following the same pattern as `tests/helpers/run-cli.mjs`.
 *
 * @module tests/helpers/fixtures
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { GIT_LOCAL_ENV_VARS } from '../../scripts/lib/git-env-sanitize.mjs';

export { GIT_LOCAL_ENV_VARS };

/**
 * A `process.env`-derived environment with every {@link GIT_LOCAL_ENV_VARS}
 * key stripped — pass as the `env` option to any `git` subprocess spawned
 * against a fixture repo the caller wants isolated from the ambient process.
 *
 * A git command run against a fixture repo with an explicit `cwd` must NOT
 * inherit these from the ambient process, or git gives them precedence over
 * `cwd` and silently redirects to whatever repo they point at instead. Root
 * cause of six live HEAD-corruption incidents (2026-07-23): git's own
 * hook-invocation machinery exports GIT_DIR/GIT_WORK_TREE into the pre-push
 * hook's process (documented, githooks(5)); `npm run check` inherited that
 * env into the sandboxed test run, and every fixture helper below built its
 * "isolated" repo with a raw `cwd` and no `env` override — so `git
 * init`/`git commit` ignored `cwd` entirely and landed synthetic commits
 * ("seed", "init", "add data + readme") on the real repo's real HEAD.
 *
 * Uses the STATIC `GIT_LOCAL_ENV_VARS` baseline (imported from
 * `scripts/lib/git-env-sanitize.mjs`, the one canonical source — a plan
 * audit round caught the earlier design keeping two independently-maintained
 * copies as a drift risk), not `git rev-parse --local-env-vars` computed per
 * call — these fixture helpers run per-test, potentially hundreds of times
 * in one suite, and spawning a git subprocess just to ask for the var names
 * before every actual fixture git call is real, avoidable overhead. The
 * dynamic, version-authoritative form lives at `git-env-sanitize.mjs`'s
 * `getGitLocalEnvVarNames()`/`sanitizeGitEnv()`, used at the pre-push
 * hook->sandbox boundary, where it's called once per push, not once per
 * fixture spawn.
 * @returns {NodeJS.ProcessEnv}
 */
export function gitFixtureEnv() {
  const env = { ...process.env };
  for (const name of GIT_LOCAL_ENV_VARS) delete env[name];
  return env;
}

/**
 * Write a `{relPath: content}` tree under `baseDir`. Parameterized (not
 * closure-based) — the four `arch-intent-adapter-*.test.mjs` copies each
 * closed over their own module-level `tmpDir` instead of taking it as an
 * argument, so callers here must pass it explicitly.
 * @param {string} baseDir
 * @param {Record<string, string>} files
 * @returns {string} baseDir, for convenient chaining
 */
export function writeTree(baseDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(baseDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return baseDir;
}

/**
 * Factory for a synchronous git runner bound to a default cwd getter (mirrors
 * `tests/helpers/run-cli.mjs`'s `makeRunCli` factory pattern). Each of the
 * three `ship-commit-*.test.mjs` files reassigns its own `repo` variable in
 * `beforeEach`, so the default cwd must be resolved PER CALL, not captured
 * once at factory time — `getCwd` is invoked lazily for exactly that reason.
 *
 * Runs the command and asserts a zero exit status (a non-zero exit is always
 * a test-setup bug, never an expected outcome for these fixture calls).
 *
 * @param {() => string} getCwd - returns the current default cwd (e.g. `() => repo`)
 * @returns {(args: string[], cwd?: string) => string} git(args, cwd?) => stdout
 */
export function makeGitRunner(getCwd) {
  return (args, cwd) => {
    const resolvedCwd = cwd ?? getCwd();
    const r = spawnSync('git', args, { cwd: resolvedCwd, encoding: 'utf-8', env: gitFixtureEnv() });
    assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    return r.stdout;
  };
}

/**
 * Build an expensive fixture tree ONCE per process, then hand out cheap
 * filesystem copies of it.
 *
 * **Why (measured 2026-08-11).** A `beforeEach` that runs `git init` + three
 * `git config` + `git add` + `git commit` costs **406 ms**, and
 * `ship-commit-cli.test.mjs` paid it 26 times — 10.6 s of a 44.9 s file, none
 * of it testing anything. `fs.cpSync` of the resulting seeded tree costs
 * **19 ms**: **21.9x faster**, 20 iterations, benchmarked with this file's own
 * `gitFixtureEnv()`.
 *
 * Copying is *equivalent*, not merely similar: a fresh `.git` contains no
 * absolute paths (verified — `core.worktree` is unset and `config` never names
 * its own directory), so a copy is a working repo wherever it lands. The
 * template is built by real git, so it can never drift from what git produces.
 *
 * **This is a memoizer, not a fifth fixture builder.** The repo already had
 * four overlapping git-fixture constructors (`gitInit`,
 * `gitInitWithEmptyCommit`, `worktree-guard-args.mjs`'s `initTempRepo`, and an
 * inline one); architectural memory banded this space `precedent /
 * above-floor-cluster`. So the caller keeps owning WHAT its fixture contains
 * and this owns only the build-once-copy-many part.
 *
 * The template is process-scoped (node's test runner gives each FILE its own
 * process, so there is no cross-file sharing to reason about) and removed on
 * exit. A build failure is NOT swallowed — a silently degraded fixture is how a
 * suite goes green having tested a repo that is not the one it describes.
 *
 * @param {(dir: string) => void} build - populates a fresh directory; runs once
 * @returns {(prefix?: string) => string} instantiate → path to a private copy
 */
export function makeRepoTemplate(build) {
  let template = null;
  return function instantiate(prefix = 'ces-fixture-') {
    if (template === null) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ces-template-'));
      try {
        build(dir);
      } catch (err) {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        throw new Error(`fixture template build failed: ${err.message}`, { cause: err });
      }
      template = dir;
      process.on('exit', () => {
        try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); } catch { /* best effort */ }
      });
    }
    const copy = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.cpSync(template, copy, { recursive: true });
    return copy;
  };
}

/**
 * Initialize a git repo with a deterministic test identity and GPG signing
 * disabled — NO initial commit. Use when the caller creates its own first
 * commit immediately afterward (`commit()` below).
 * @param {string} dir
 */
export function gitInit(dir) {
  // Through the CHECKED runner, not raw spawnSync. These are setup commands
  // that must succeed; with stdio:'ignore' and no status read, a failed
  // `git init` produced a fixture that LOOKED constructed and was not, so
  // every suite built on it asserted against a broken repo — green for the
  // wrong reason, which is indistinguishable from the code being correct.
  // See docs/plans/silent-success-cluster.md KD-4.
  const git = makeGitRunner(() => dir);
  git(['init', '-q']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
}

/**
 * Same as `gitInit`, PLUS an initial `--allow-empty` commit ("init"). This is
 * a genuinely different behaviour from `gitInit` (not a superset config —
 * an extra history-shaping step), so it is kept as a separate export rather
 * than silently folded into `gitInit`: a caller relying on a clean, commit-
 * free repo (to make its own first commit HEAD) would get an extra ancestor
 * commit it never asked for.
 * @param {string} dir
 */
export function gitInitWithEmptyCommit(dir) {
  gitInit(dir);
  makeGitRunner(() => dir)(['commit', '--allow-empty', '-m', 'init']);
}

/**
 * Write a file, stage it, commit it, and return the resulting commit SHA.
 * @param {string} dir
 * @param {string} filePath - relative to dir
 * @param {string} content
 * @param {string} message
 * @returns {string} the new commit's full SHA
 */
export function commit(dir, filePath, content, message) {
  const env = gitFixtureEnv();
  const git = makeGitRunner(() => dir);
  fs.writeFileSync(path.join(dir, filePath), content);
  git(['add', filePath]);
  git(['commit', '-m', message]);
  return execSync('git rev-parse HEAD', { cwd: dir, env }).toString().trim();
}

/**
 * A minimal fake OpenAI-shaped client stub for `responses.parse()` calls,
 * keyed by the requested `text.format.name` (the structured-output schema
 * name). Throws on any unstubbed schema — a deliberate "no silent no-op"
 * fixture so a test that forgot to stub a call fails loudly instead of
 * returning an empty result.
 * @param {Record<string, unknown | ((params: object) => unknown)>} [responses]
 */
export function makeStubClient(responses = {}) {
  return {
    responses: {
      parse: async (params) => {
        const schemaName = params?.text?.format?.name;
        const handler = responses[schemaName];
        if (handler === undefined) {
          throw new Error(`makeStubClient: unrecognized schemaName "${schemaName}" — unstubbed LLM call`);
        }
        const result = typeof handler === 'function' ? handler(params) : handler;
        return {
          status: 'completed', output: [], output_parsed: result,
          usage: { input_tokens: 10, output_tokens: 5, prompt_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        };
      },
    },
  };
}

/**
 * Create a fresh temp directory under the OS tmpdir with the given prefix.
 * @param {string} prefix
 * @returns {string} the created directory's absolute path
 */
export function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * A writable stream that buffers everything written to it and exposes the
 * accumulated text via `.text()` — a stand-in for a fetch-like Response body
 * in tests that pipe output into a stream and then read it back.
 * @returns {import('node:stream').Writable & {text: () => string}}
 */
export function collectStream() {
  const chunks = [];
  const s = new Writable({ write(chunk, _enc, cb) { chunks.push(chunk.toString('utf-8')); cb(); } });
  s.text = () => chunks.join('');
  return s;
}

/**
 * Write `content` to `root/rel`, creating parent directories as needed.
 * @param {string} root
 * @param {string} rel
 * @param {string} content
 * @returns {string} the absolute path written
 */
export function writeFile(root, rel, content) {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  return abs;
}

/**
 * Recursively collect every `.mjs` file under `dir` (skipping `node_modules`).
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]} absolute paths
 */
export function collectMjs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      collectMjs(full, acc);
    } else if (entry.name.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

/** A fixed, deterministic clock for tests that need a stable `createdAt`. */
export const CLOCK = () => '2026-01-01T00:00:00.000Z';

/**
 * A disposable repo root under the OS tmpdir, realpath'd (macOS /tmp is a
 * symlink). Consolidated from near-byte-identical copies in
 * tests/security-triage-cli.test.mjs and tests/security-triage-gate-honesty.
 * test.mjs (sast-sandbox-backlog-hardening.md item 4).
 * @param {string} [prefix]
 * @returns {Promise<string>}
 */
export async function makeSecurityTriageRepo(prefix = 'sec-triage-') {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), prefix));
  return fs.realpathSync(dir);
}

/**
 * A minimal SARIF 2.1.0 document wrapping the given `results` array — the
 * shape `security-triage.mjs`'s ingestion expects.
 * @param {object[]} results
 * @returns {object}
 */
export function sarifDoc(results) {
  return {
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'TestTool' } }, results }],
  };
}

/**
 * A single SARIF result at `uri`/`line`, with the codeFlow/location shape
 * `classifyLocationPath`/`routeFindings` read. `over` shallow-merges
 * additional/overriding fields onto the base result.
 * @param {string} uri
 * @param {number} [line]
 * @param {object} [over]
 * @returns {object}
 */
export function sarifResultAt(uri, line = 1, over = {}) {
  const loc = {
    physicalLocation: {
      artifactLocation: { uri, uriBaseId: '%SRCROOT%' },
      region: { startLine: line, endLine: line, startColumn: 1, endColumn: 40 },
    },
  };
  return {
    ruleId: 'javascript/DOMXSS',
    level: 'warning',
    message: { text: 'flows into innerHTML' },
    locations: [loc],
    codeFlows: [{ threadFlows: [{ locations: [{ location: loc }] }] }],
    ...over,
  };
}
