#!/usr/bin/env node
/**
 * @fileoverview Azure embedding-deployment doctor — probe → select → confirm →
 * persist. The interactive, config-mutating counterpart to the read-only
 * `azure-limits` diagnostic (plan §2; separate command by design — #3).
 *
 * Core logic is `runAzureDoctor(options, deps)` — a pure-ish application service
 * with every side effect injected (client, file IO, snapshot read, TTY, prompt,
 * writers), so the whole §2 CLI state matrix is unit-testable without a network
 * or a real `.env`. `main()` is a thin process adapter that wires the real deps.
 *
 * Safety invariants:
 *   - **`--json` / non-TTY NEVER writes** (H7) — "does it write?" is a function of
 *     TTY alone; no flag overrides it.
 *   - A terminal `unverified` probe preserves the configured value and offers no
 *     replacement (H5).
 *   - The provenance-invalidation warning is best-effort; a failed snapshot read
 *     never blocks a valid config fix (M7).
 *
 * Usage: node scripts/azure-doctor.mjs [--fix] [--json] [--candidate <name>]... [--env-file <path>]
 *        node scripts/azure-doctor.mjs --routes [--json]   # read-only route table + probes
 *
 * @module scripts/azure-doctor
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, dirname, sep } from 'node:path';
import readline from 'node:readline';
import { azureConfig } from './lib/config.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { applyEnvSetting, resolveEnvValue } from './lib/env-setting.mjs';
import { selectEmbedDeployment as realSelect } from './lib/azure/embed-discovery.mjs';

const ENV_KEY = 'AZURE_OPENAI_EMBED_DEPLOYMENT';
const DOCTOR_COMMENT = '# Azure embedding deployment — verified + locked in by `npm run azure:doctor`.';

/**
 * A well-formed Azure deployment name (audit H2): alphanumerics plus `.`, `-`, `_`,
 * up to 64 chars. `--candidate` is user CLI input forwarded to the provider as the
 * `model`; validating the charset keeps a malformed/oversized string from being
 * sent to Azure and rejects an obvious typo loudly instead of probing garbage.
 */
const DEPLOYMENT_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Exit codes — stable + distinct so a caller can tell the states apart (§2). */
export const EXIT = Object.freeze({
  OK: 0,          // verified & already configured, or written successfully
  BAD_INPUT: 2,   // invalid CLI input (e.g. a malformed --candidate)
  FIXABLE: 3,     // report-only: a better candidate verified; run --fix to lock it in
  UNVERIFIED: 4,  // transient/auth/transport — not a config problem
  NONE_FOUND: 5,  // every tried candidate was unsupported; supply --candidate
  REFUSED_CI: 6,  // --fix without a TTY: refuse to auto-write
  DECLINED: 130,  // user answered 'n' at the confirm prompt
});

function renderProbeTable(result, configured) {
  const rows = result.probed.map((p) => {
    const mark = p.outcome === 'verified' ? '✓' : p.outcome === 'unsupported' ? '·' : '✗';
    const tag = p.name === configured ? ' (configured)' : '';
    return `    ${mark} ${p.name}${tag} — ${p.outcome}${p.detail ? ` (${p.detail})` : ''}`;
  });
  return `  Probed candidates (catalog source: ${result.catalogSource}):\n${rows.join('\n')}`;
}

/** Map a select() result to the --json / report-only exit code (no write states). */
function reportExitCode(result, configured) {
  if (result.status === 'verified') return result.selected === configured ? EXIT.OK : EXIT.FIXABLE;
  if (result.status === 'unverified') return EXIT.UNVERIFIED;
  return EXIT.NONE_FOUND; // none-found
}

/**
 * The doctor state machine. All effects injected via `deps`.
 *
 * @param {{fix?:boolean, json?:boolean, candidates?:string[]}} options
 * @param {{
 *   azure: typeof azureConfig,
 *   client: object,
 *   clientFor?: (name:string)=>Promise<object>|object,
 *   select?: typeof realSelect,
 *   throttle?: Function,
 *   isTTY: boolean,
 *   prompt: (q:string)=>Promise<string>,
 *   readEnvFile: (path:string)=>string,
 *   writeEnvFile: (path:string, text:string)=>void,
 *   envPath: string,
 *   getActiveSnapshot?: (repoId:string)=>Promise<{activeEmbeddingModel?:string}|null>,
 *   repoId?: string,
 *   out: (s:string)=>void,
 * }} deps
 * @returns {Promise<{exitCode:number, wrote:boolean, json?:object}>}
 */
export async function runAzureDoctor(options, deps) {
  const { azure, out } = deps;
  if (!azure.active) {
    if (options.json) { out(JSON.stringify({ active: false })); }
    else { out('Azure work profile inactive (AZURE_OPENAI_ENDPOINT not set) — nothing to check.'); }
    return { exitCode: EXIT.OK, wrote: false };
  }

  // Validate user-supplied --candidate names before any provider call (H2).
  const badCandidates = (options.candidates || []).filter((c) => !DEPLOYMENT_NAME_RE.test(c));
  if (badCandidates.length) {
    const m = `Invalid --candidate value(s): ${badCandidates.join(', ')}. Deployment names are ` +
      `alphanumerics plus '.', '-', '_', up to 64 chars.`;
    if (options.json) out(JSON.stringify({ active: true, error: 'bad_candidate', invalid: badCandidates }));
    else out(m);
    return { exitCode: EXIT.BAD_INPUT, wrote: false };
  }

  const select = deps.select || realSelect;
  const result = await select({
    configured: azure.embedDeployment,
    userCandidates: options.candidates || [],
    client: deps.client,
    clientFor: deps.clientFor,
    throttle: deps.throttle,
  });
  const configured = azure.embedDeployment;

  // --json: machine object, NEVER prompts, NEVER writes (H7). Exit mirrors the matrix.
  if (options.json) {
    const obj = {
      active: true, configured, status: result.status,
      selected: result.selected, catalogSource: result.catalogSource, probed: result.probed,
    };
    out(JSON.stringify(obj));
    return { exitCode: reportExitCode(result, configured), wrote: false, json: obj };
  }

  out(renderProbeTable(result, configured));

  if (result.status === 'unverified') {
    out('✗ Could not verify any candidate — the failure was auth/throttle/transport/5xx, not a ' +
        'missing deployment. Configured value preserved; nothing written. Re-run once resolved.');
    return { exitCode: EXIT.UNVERIFIED, wrote: false };
  }
  if (result.status === 'none-found') {
    out(`✗ None of the tried candidates is a working deployment. If your deployment has a custom ` +
        `name the catalog can't see, pass it explicitly: --candidate <your-deployment-name>.`);
    return { exitCode: EXIT.NONE_FOUND, wrote: false };
  }

  // verified
  if (result.selected === configured) {
    out(`✓ Configured deployment "${configured}" is verified. Nothing to fix.`);
    return { exitCode: EXIT.OK, wrote: false };
  }

  // A better candidate verified while the configured one did not.
  if (!options.fix) {
    out(`→ "${configured}" did not verify, but "${result.selected}" did. ` +
        `Run \`npm run azure:doctor -- --fix\` to lock it in.`);
    return { exitCode: EXIT.FIXABLE, wrote: false };
  }
  if (!deps.isTTY) {
    // --fix without a TTY: refuse to auto-write (H7/R3). Print the actionable suggestion.
    out(`Refusing to auto-write without a TTY. Set ${ENV_KEY}=${result.selected} yourself, ` +
        `or run \`--fix\` interactively.`);
    return { exitCode: EXIT.REFUSED_CI, wrote: false };
  }

  // TTY + --fix: provenance-invalidation warning (best-effort, M7) + confirm + write.
  let priorModel = null;
  if (deps.getActiveSnapshot && deps.repoId) {
    try { priorModel = (await deps.getActiveSnapshot(deps.repoId))?.activeEmbeddingModel || null; }
    catch { /* advisory only — never blocks the fix (M7) */ }
  }
  out(priorModel
    ? `⚠ This changes the embedding vector-space identity. It invalidates the index built with ` +
      `"${priorModel}" — rebuild after this change: npm run arch:refresh -- --full`
    : `⚠ If an architectural-memory index already exists for this repo, this change invalidates it ` +
      `— rebuild after: npm run arch:refresh -- --full`);

  const answer = (await deps.prompt(`Lock in ${ENV_KEY}=${result.selected} in ${deps.envPath}? [y/N] `)).trim();
  if (!/^y(es)?$/i.test(answer)) {
    out('Aborted — no changes written.');
    return { exitCode: EXIT.DECLINED, wrote: false };
  }

  const existing = deps.readEnvFile(deps.envPath);
  const { text } = applyEnvSetting(existing, ENV_KEY, result.selected, { comment: DOCTOR_COMMENT });
  deps.writeEnvFile(deps.envPath, text);
  out(`✓ Wrote ${ENV_KEY}=${result.selected} to ${deps.envPath}.`);

  // H10: gate on the OBSERVABLE difference (live value vs what we just wrote), not
  // on an unrecoverable claim about origin. dotenv is override:false, so a shell
  // export would keep winning over the file.
  const { liveValue } = resolveEnvValue(ENV_KEY, { envFileText: text });
  if (liveValue != null && liveValue !== result.selected) {
    out(`⚠ A value "${liveValue}" is active in this environment and differs from what was written. ` +
        `If it comes from a shell export it will keep overriding ${deps.envPath} (dotenv is ` +
        `override:false) — unset the export to use the written value.`);
  }
  out(`Next: npm run arch:refresh -- --full`);
  return { exitCode: EXIT.OK, wrote: true };
}

function parseArgs(argv) {
  const options = { fix: false, json: false, routes: false, candidates: [], envFile: '.env' };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') options.fix = true;
    else if (a === '--json') options.json = true;
    // `--routes` is a read-only REPORT mode, never a writer: it reports every
    // Azure wire route (endpoint, final path, deployment, api-version,
    // credential SOURCE VARIABLE, auth header) and probes each one.
    else if (a === '--routes') options.routes = true;
    else if (a === '--candidate') options.candidates.push(argv[++i]);
    else if (a === '--env-file') options.envFile = argv[++i];
  }
  return options;
}

/**
 * `--routes`: build + probe the route table. Deliberately short-circuits before
 * any of the embedding doctor's discovery/write machinery — it shares only the
 * process adapter, and it can never mutate `.env`.
 */
async function runRoutesMode(options, out) {
  const { runRouteDoctor } = await import('./lib/azure/route-doctor.mjs');
  if (!azureConfig.active) {
    const r = await runRouteDoctor(options, { azure: azureConfig, probes: {}, out });
    return r.exitCode;
  }
  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { createAnthropicClient } = await import('./lib/anthropic-client.mjs');
  // Each probe is the smallest request that exercises the REAL route for that
  // surface — same client factory, same purpose, same route the audit uses.
  const probes = {
    gpt: async () => {
      const c = await createOpenAIClient({ purpose: 'gpt' });
      // The GPT auditor calls `responses.*`; probe that surface, not chat, so a
      // resource that serves only one of them is reported honestly.
      return c.responses.create({ model: azureConfig.gptDeployment, input: 'ping', max_output_tokens: 16 });
    },
    embed: async () => {
      const c = await createOpenAIClient({ purpose: 'embed' });
      return c.embeddings.create({ model: azureConfig.embedDeployment, input: 'ping', dimensions: 768 });
    },
    claude: async () => {
      // `backend:'sdk'` explicitly — the cli backend cannot target a custom
      // endpoint, so it would prove nothing about this route.
      const c = await createAnthropicClient({ backend: 'sdk', azureRoute: azureConfig.claudeRoute, redactor: null });
      return c.messages.create({
        model: azureConfig.claudeDeployment, max_tokens: 16,
        messages: [{ role: 'user', content: 'ping' }],
      });
    },
  };
  const r = await runRouteDoctor(options, { azure: azureConfig, probes, out });
  return r.exitCode;
}

/**
 * Resolve the `.env` write target safely (§2 / R4 / INC-001): canonicalize the
 * repo root (always exists), join the target within it, and if the target file
 * already exists, canonicalize it and fail closed when it escapes the repo root.
 * A not-yet-existing `.env` is fine (the no-`.env` case must work) — we only
 * realpath the parent.
 */
function resolveEnvPath(repoRoot, envFile) {
  const rootReal = realpathSync(repoRoot);
  // Path-COMPONENT containment (audit H1) — a plain `startsWith` prefix check
  // would treat a sibling like `/repo-evil` as inside `/repo`. Require an exact
  // match or a real path-separator boundary.
  const inside = (child) => child === rootReal || child.startsWith(rootReal + sep);
  const target = resolve(rootReal, envFile);
  if (existsSync(target)) {
    const real = realpathSync(target);
    if (!inside(real)) {
      throw new Error(`[azure-doctor] refusing to write ${envFile}: it resolves outside the repo root.`);
    }
    return real;
  }
  // Parent must exist + be inside the repo.
  const parentReal = realpathSync(dirname(target));
  if (!inside(parentReal)) {
    throw new Error(`[azure-doctor] refusing to write ${envFile}: its directory is outside the repo root.`);
  }
  return resolve(parentReal, target.slice(dirname(target).length + 1));
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }

  const options = parseArgs(process.argv);
  const out = (s) => process.stdout.write(s + '\n');

  if (options.routes) process.exit(await runRoutesMode(options, out));

  if (!azureConfig.active) {
    // Fast path — no client construction needed.
    const r = await runAzureDoctor(options, { azure: azureConfig, out, client: null, isTTY: false, prompt: async () => 'n', readEnvFile: () => '', writeEnvFile: () => {}, envPath: '' });
    process.exit(r.exitCode);
  }

  const { createOpenAIClient } = await import('./lib/openai-client.mjs');
  const { azureThrottle } = await import('./lib/azure-throttle.mjs');
  const client = await createOpenAIClient({ purpose: 'embed' });
  // One client PER candidate. The deployment is constructor-level route state on
  // the deployment-qualified surface — reusing `client` would send every probe to
  // the already-configured deployment and stamp the first candidate `verified`
  // regardless of what the resource actually has (see probeDeployment's docstring).
  // `azure` snapshot-injection is the existing seam for this (same pattern as
  // model-eval's provider-adapter); the factory's cache key includes the
  // deployment, so candidates stay isolated from each other and from `client`.
  const clientFor = (name) => createOpenAIClient({
    purpose: 'embed',
    azure: { ...azureConfig, embedDeployment: name },
  });
  const repoRoot = process.cwd();
  const envPath = resolveEnvPath(repoRoot, options.envFile);

  // Snapshot reader (best-effort, M7) — resolve repo identity + active snapshot.
  let getActiveSnapshot = null, repoId = null;
  try {
    const { resolveRepoIdentity } = await import('./lib/repo-identity.mjs');
    const { upsertRepoByUuid } = await import('./learning-store.mjs');
    const snapMod = await import('./lib/store/arch/snapshots.mjs');
    const id = resolveRepoIdentity(repoRoot);
    const repo = await upsertRepoByUuid({ repoUuid: id.repoUuid, name: id.name });
    repoId = repo?.id || null;
    getActiveSnapshot = snapMod.getActiveSnapshot;
  } catch { /* advisory only */ }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const prompt = (q) => new Promise((res) => rl.question(q, res));

  try {
    const r = await runAzureDoctor(options, {
      azure: azureConfig, client, clientFor, throttle: azureThrottle,
      isTTY: Boolean(process.stdin.isTTY) && !options.json,
      prompt,
      readEnvFile: (p) => (existsSync(p) ? readFileSync(p, 'utf8') : ''),
      writeEnvFile: (p, t) => atomicWriteFileSync(p, t),
      envPath, getActiveSnapshot, repoId, out,
    });
    rl.close();
    process.exit(r.exitCode);
  } catch (err) {
    rl.close();
    process.stderr.write(`azure-doctor: ${err.message}\n`);
    process.exit(1);
  }
}

// Run as a CLI only — importing for tests must not execute main().
import { fileURLToPath } from 'node:url';
const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  main();
}

export const _internals = { parseArgs, resolveEnvPath, renderProbeTable, reportExitCode, DOCTOR_COMMENT, ENV_KEY };
