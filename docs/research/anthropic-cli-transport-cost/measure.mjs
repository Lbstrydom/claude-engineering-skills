#!/usr/bin/env node
/**
 * @fileoverview Reproduce the cli-vs-sdk transport measurements behind
 * `docs/plans/anthropic-cli-faithfulness-routing.md` §6.
 *
 * Committed because the plan's §6.D revert triggers are stated in terms of
 * these numbers, and a revert criterion nobody else can re-measure is not
 * falsifiable. Raised as MEDIUM by that plan's own round-1 audit (M1).
 *
 * SPENDS REAL MONEY on the sdk leg (`ANTHROPIC_API_KEY`) and real Max 20x
 * credit on the cli leg. Each mode prints its own cost before exiting; see the
 * README for the figures a clean run produced on 2026-11-14.
 *
 * Usage, from the repo root:
 *   node docs/research/anthropic-cli-transport-cost/measure.mjs summariser [runs]
 *   node docs/research/anthropic-cli-transport-cost/measure.mjs system [runs]
 *   node docs/research/anthropic-cli-transport-cost/measure.mjs prefix [runs]
 *   node docs/research/anthropic-cli-transport-cost/measure.mjs bare
 *
 * @module docs/research/anthropic-cli-transport-cost/measure
 */
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODE = process.argv[2];
const RUNS = Number(process.argv[3] || 1);
const REPO = process.cwd();

const load = p => import(pathToFileURL(path.join(REPO, p)).href);

/**
 * The model the SUMMARISER itself would use, resolved through the same config
 * path production reads (`symbolIndexConfig.summariseModel`, which runs
 * `resolveModel` over `ARCH_INDEX_SUMMARY_MODEL || 'latest-haiku'`).
 *
 * Not a hardcoded id — AGENTS.md's "do NOT pin concrete model IDs in new code"
 * applies here too, and the round-3 audit was right to raise it (M1). But the
 * figures in the README are model-specific, so a harness that silently measured
 * a different model than the one its numbers were taken on would make those
 * numbers quietly incomparable. Hence: resolve like production, then PRINT the
 * resolved id with every run, so each figure carries the model that produced
 * it. `ARCH_INDEX_SUMMARY_MODEL` overrides for a deliberate comparison.
 */
async function resolveMeasurementModel() {
  const { symbolIndexConfig } = await load('scripts/lib/config.mjs');
  const model = symbolIndexConfig.summariseModel;
  if (!model) throw new Error('could not resolve symbolIndexConfig.summariseModel');
  return model;
}

/**
 * Quote for Windows cmd.exe + CommandLineToArgvW, as the cli adapter does.
 * Applied ONLY on win32 — see `spawnClaude` below.
 */
const q = s => {
  s = String(s);
  if (!s.length) return '""';
  return /[\s"&<>|^()%!]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * Spawn the `claude` binary the way the production adapter does, which is
 * PLATFORM-DEPENDENT and was wrong here until the round-2 audit raised it (M2).
 *
 * On Windows `shell: true` is required to resolve the `claude.cmd` wrapper, and
 * because Node does not auto-quote under `shell: true`, args are hand-quoted
 * and `windowsVerbatimArguments` stops Node re-quoting them. Off Windows none
 * of that applies: a shell is unnecessary, the Windows doubled-quote escape is
 * not how POSIX shells unquote, and routing through `sh -c` would let shell
 * metacharacters in a system prompt be interpreted. So: direct argv, no shell.
 */
function spawnClaude(args, input) {
  const win = process.platform === 'win32';
  return spawnSync('claude', win ? args.map(q) : args, {
    input,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 50 * 1024 * 1024,
    ...(win ? { shell: true, windowsVerbatimArguments: true } : {}),
  });
}

/**
 * Spawn `claude -p` with the EXACT argv `createCliAdapter` builds, so a figure
 * measured here is a figure the production path would have produced. Used for
 * the cli leg of the `system` mode, which the seam now refuses outright.
 */
function rawClaude({ system, prompt, model }) {
  const args = ['-p', '--output-format', 'json', '--max-turns', '6', '--tools', ''];
  if (system) args.push('--system-prompt', system);
  if (model) args.push('--model', model);
  const t0 = Date.now();
  const r = spawnClaude(args, prompt);
  const ms = Date.now() - t0;
  if (r.error) return { error: r.error.message, ms };
  if (!r.stdout) return { error: `status ${r.status}: ${(r.stderr || '').slice(0, 300)}`, ms };
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch (err) {
    return { error: `unparseable JSON (${err.message}): ${r.stdout.slice(0, 200)}`, ms };
  }
  // A PARSEABLE ERROR ENVELOPE IS STILL AN ERROR. `claude -p` reports failures
  // as `{is_error: true, result: "<detail>"}` with exit 0, so parsing alone is
  // not success — the production `normaliseCliOutput` checks this and this
  // harness did not, which would have folded a failed call into the figures as
  // a real measurement (round-2 audit, M1).
  if (j.is_error === true) {
    return { error: `claude -p reported an error: ${String(j.result || '(no detail)').slice(0, 300)}`, ms };
  }
  const u = j.usage || {};
  return {
    ms,
    text: String(j.result || ''),
    input_tokens: u.input_tokens,
    cache_create: u.cache_creation_input_tokens,
    cache_read: u.cache_read_input_tokens,
    output_tokens: u.output_tokens,
    cost: j.total_cost_usd,
  };
}

function row(label, r) {
  if (r.error) return console.log(`  ${label}: ERROR ${r.error}`);
  const lines = r.text === undefined ? '?' : r.text.split('\n').length;
  console.log(
    `  ${label}: out_tokens=${r.output_tokens} chars=${r.text?.length ?? '?'} lines=${lines}`
    + ` ms=${r.ms} cost=${r.cost === undefined ? 'n/a' : '$' + r.cost}`
    + ` in=${r.input_tokens ?? '-'} cache_create=${r.cache_create ?? '-'} cache_read=${r.cache_read ?? '-'}`,
  );
}

// ── summariser shape: no `system`, instruction in the user message (§6.A) ────
async function modeSummariser() {
  await load('scripts/lib/load-env.mjs');
  const { createAnthropicClient, _resetClientCache } = await load('scripts/lib/anthropic-client.mjs');
  const { redactSecrets } = await load('scripts/lib/sensitive-egress-gate.mjs');

  // Real symbol records, so the prompt is the production shape and not a
  // hand-written stand-in. Four source files give >= 10 bodies over 200 chars.
  const SOURCES = [
    'scripts/lib/push-range.mjs', 'scripts/lib/cli-entry.mjs',
    'scripts/lib/file-io.mjs', 'scripts/lib/vcs.mjs',
  ].join(',');
  const jsonl = execFileSync(
    process.execPath, ['scripts/symbol-index/extract.mjs', '--files', SOURCES],
    { cwd: REPO, encoding: 'utf8', maxBuffer: 200 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const batch = jsonl.trim().split('\n')
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(r => r && r.type === 'symbol' && !r.redacted && (r.bodyText || '').length > 200)
    .slice(0, 10);
  if (batch.length < 10) throw new Error(`only ${batch.length} eligible symbols — widen SOURCES`);

  // Verbatim from `summariseBatch`.
  const lines = batch.map((s, i) =>
    `${i + 1}. ${s.kind} \`${s.symbolName}\` in \`${s.filePath}\` (lines ${s.startLine}-${s.endLine}):\n`
    + '```\n' + redactSecrets((s.bodyText || '').slice(0, 1500)) + '\n```');
  const prompt = `Summarise each of these ${batch.length} symbols in EXACTLY ONE LINE describing its purpose. `
    + `Use plain English; no boilerplate. Output as a numbered list (one line each, matching input numbers). `
    + `If a symbol's body is empty or unparseable, write "<no body>".\n\n`
    + lines.join('\n\n');

  const MODEL = await resolveMeasurementModel();
  console.log(`summariser shape — ${batch.length} symbols, ${prompt.length}-char prompt`);
  console.log(`model: ${MODEL} (resolved via symbolIndexConfig.summariseModel — the summariser's own)`);
  console.log('(no `system`: this shape is SERVICEABLE on cli and stays there)\n');

  for (const backend of ['sdk', 'cli']) {
    for (let i = 0; i < RUNS; i++) {
      _resetClientCache();
      try {
        const client = await createAnthropicClient({ backend, azureRoute: null });
        const t0 = Date.now();
        const res = await client.messages.create({
          model: MODEL, max_tokens: 4096,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = (res.content || []).map(c => c.text || '').join('');
        const u = res.usage || {};
        const numbered = text.split('\n').filter(l => /^\s*\d+\.\s*\S/.test(l)).length;
        row(`${backend} run ${i + 1}`, {
          ms: Date.now() - t0, text,
          input_tokens: u.input_tokens, cache_create: u.cache_creation_input_tokens,
          cache_read: u.cache_read_input_tokens, output_tokens: u.output_tokens,
          cost: u.provider_cost_usd,
        });
        console.log(`    obeyed "EXACTLY ONE LINE": ${numbered}/${batch.length}`);
      } catch (err) {
        console.log(`  ${backend} run ${i + 1}: ERROR ${err.message.slice(0, 200)}`);
      }
    }
  }
}

// ── `system`-carried instruction: normalize-intent's own shape (§6.B) ────────
async function modeSystem() {
  await load('scripts/lib/load-env.mjs');
  const { createAnthropicClient, _resetClientCache } = await load('scripts/lib/anthropic-client.mjs');
  const { NORMALIZE_PROMPT } = await load('scripts/lib/arch-memory/normalize-intent.mjs');
  const INTENT = 'add a retry wrapper around the audit store write path';

  const MODEL = await resolveMeasurementModel();
  console.log(`\`system\` shape — the real NORMALIZE_PROMPT (${NORMALIZE_PROMPT.length} chars)`);
  console.log(`model: ${MODEL} (resolved via symbolIndexConfig.summariseModel)`);
  console.log('sdk leg through the seam; cli leg BELOW it, because the seam now refuses this shape.\n');

  for (let i = 0; i < RUNS; i++) {
    _resetClientCache();
    try {
      const client = await createAnthropicClient({ backend: 'sdk', azureRoute: null });
      const t0 = Date.now();
      const res = await client.messages.create({
        model: MODEL, max_tokens: 200, system: NORMALIZE_PROMPT,
        messages: [{ role: 'user', content: INTENT }],
      });
      const text = (res.content || []).map(c => c.text || '').join('').trim();
      row(`sdk run ${i + 1}`, { ms: Date.now() - t0, text, output_tokens: res.usage?.output_tokens });
      console.log(`    >>> ${JSON.stringify(text.slice(0, 160))}`);
    } catch (err) {
      console.log(`  sdk run ${i + 1}: ERROR ${err.message.slice(0, 200)}`);
    }
  }
  for (let i = 0; i < RUNS; i++) {
    const r = rawClaude({ system: NORMALIZE_PROMPT, prompt: INTENT, model: MODEL });
    row(`cli run ${i + 1}`, r);
    if (r.text) console.log(`    >>> ${JSON.stringify(r.text.slice(0, 160))}`);
  }
  console.log('\nThe seam refuses the cli leg on the live path — confirm that separately:');
  console.log('  it must throw "cannot honour `system`" for backend:\'cli\'.');
}

// ── the injected prefix: cost that does not depend on the prompt (§2.4) ──────
async function modePrefix() {
  await load('scripts/lib/load-env.mjs');
  const model = await resolveMeasurementModel();
  console.log('injected-prefix probe — a 6-token exchange on cli');
  console.log(`model: ${model} (resolved via symbolIndexConfig.summariseModel)`);
  console.log('cache_create on a cold call IS the Claude Code + project-context prefix.\n');
  for (let i = 0; i < RUNS; i++) {
    row(`cli run ${i + 1}`, rawClaude({ prompt: 'Reply with exactly the word: pong', model }));
  }
  console.log('\nRun it twice: the first call CREATES the ~164K-token 1h ephemeral cache,');
  console.log('later calls READ it. Both are billed; neither depends on your prompt.');
}

// ── --bare: the flag that strips the prefix AND the credit (§2.5) ────────────
function modeBare() {
  console.log('--bare probe — does the CLAUDE.md-discovery opt-out keep the Max credit?\n');
  const args = ['-p', '--output-format', 'json', '--max-turns', '6', '--tools', '', '--bare'];
  const r = spawnClaude(args, 'Reply with exactly the word: pong');
  if (!r.stdout) return console.log(`  no stdout, status ${r.status}: ${(r.stderr || '').slice(0, 300)}`);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch (err) {
    return console.log(`  unparseable JSON (${err.message}): ${r.stdout.slice(0, 200)}`);
  }
  // Unlike the other modes this one EXPECTS an error envelope — "Not logged in"
  // is the finding. So it is reported, not treated as a failed measurement.
  if (j.is_error === true) console.log('  (claude -p reported is_error: true — expected here)');
  console.log(`  result: ${JSON.stringify(String(j.result || '').slice(0, 160))}`);
  console.log(`  cost: $${j.total_cost_usd}  usage: ${JSON.stringify(j.usage || {})}`);
  console.log('\nExpected (2026-11-14): "Not logged in · Please run /login", cost $0 —');
  console.log('--bare forces ANTHROPIC_API_KEY/apiKeyHelper auth and never reads OAuth,');
  console.log('so it cannot draw the subscription credit. It is the sdk backend, slower.');
}

const MODES = { summariser: modeSummariser, system: modeSystem, prefix: modePrefix, bare: modeBare };
if (!MODES[MODE]) {
  process.stderr.write(`usage: measure.mjs <${Object.keys(MODES).join('|')}> [runs]\n`);
  process.exit(2);
}
await MODES[MODE]();
