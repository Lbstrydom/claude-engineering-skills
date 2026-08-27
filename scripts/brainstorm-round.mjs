#!/usr/bin/env node
/**
 * brainstorm-round — call OpenAI and/or Gemini concurrently with the
 * concept-level brainstorm prompt; emit one schema-valid JSON document.
 *
 * Plan: docs/plans/brainstorm-and-arch-discoverability.md (v6).
 *
 * Total output contract (R2-H4): always emit schema-valid JSON. Exit code
 * is secondary — caller reads per-provider state to know what worked.
 */
import './lib/load-env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { resolveModel, refreshModelCatalog } from './lib/model-resolver.mjs';
import { redactSecrets } from './lib/secret-patterns.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { BrainstormEnvelopeWriteSchema, BRAINSTORM_PROVIDERS } from './lib/brainstorm/schemas.mjs';
import { callOpenAI } from './lib/brainstorm/openai-adapter.mjs';
import { callGemini } from './lib/brainstorm/gemini-adapter.mjs';
import { callAzureClaude } from './lib/brainstorm/azure-claude-adapter.mjs';
import { resolveProviderAvailability, defaultProviders } from './lib/brainstorm/provider-availability.mjs';
import { azureConfig } from './lib/config.mjs';
import { preflightEstimateUsd } from './lib/brainstorm/pricing.mjs';
import { resolveOutputBudget, DEPTH_TOKENS } from './lib/brainstorm/depth-config.mjs';
import { assembleResumeContext } from './lib/brainstorm/resume-context.mjs';
import { loadArchSection, shouldAttachArch } from './lib/brainstorm/arch-context.mjs';
import { buildBrainstormSystemPrompt, DEFAULT_WORD_TARGET } from './lib/brainstorm/prompt.mjs';
import { loadArtifacts } from './lib/brainstorm/artifact-context.mjs';
import { loadPolicyPack } from './lib/brainstorm/policy-context.mjs';
import { buildDebatePrompt } from './lib/brainstorm/debate-prompt.mjs';
import { classifyDebateOutcome, isDebateEligible } from './lib/brainstorm/debate-outcome.mjs';
import { appendSession, pruneOldSessions, loadSession } from './lib/brainstorm/session-store.mjs';
import { saveInsight } from './lib/brainstorm/insight-store.mjs';

// Repo-local debug dir for malformed-payload artefacts (Plan v6 Gemini-G3).
// Lives inside the repo so file ACLs are governed by repo ownership, not
// the world-readable /tmp umask. Synced to consumer-repo .gitignore via
// scripts/sync-to-repos.mjs.
const DEBUG_DIR_RELATIVE = '.claude/tmp';

const HELP_TEXT = `brainstorm-round — call multiple LLMs concurrently for concept-level brainstorming

USAGE — brainstorm round (default mode)
  node scripts/brainstorm-round.mjs --topic "<text>" [flags]
  echo "<text>" | node scripts/brainstorm-round.mjs --topic-stdin [flags]

USAGE — save mode (positional 'save' first arg)
  node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic "<text>" --insight "<text>" [--tags <csv>]
  node scripts/brainstorm-round.mjs save --sid <sid> --round <n> --topic-stdin --insight-stdin [--tags <csv>] < combined.txt
    (combined.txt = topic, then "---END-TOPIC---" line, then insight)

FLAGS — brainstorm-round mode
  --topic <text>         User topic
  --topic-stdin          Read topic from stdin
  --models <csv>         Providers to call. Options: openai, gemini, azure-claude.
                         Default depends on the active profile: openai,gemini on
                         the public profile; openai,azure-claude when the Azure
                         work profile is active (no Gemini exists in an Azure
                         tenant). An explicit --models is honoured verbatim.
  --with-gemini          Force the Gemini leg in (no-op on the public default)
  --no-gemini            Just the OpenAI voice (alias: --openai-only) — on Azure
                         this also drops the substituted azure-claude leg
  --openai-model <id>    OpenAI model sentinel or concrete ID (default: latest-gpt)
  --gemini-model <id>    Gemini model sentinel or concrete ID (default: latest-pro)
                         (azure-claude has no flag: its model is the deployment
                         named by AZURE_FOUNDRY_CLAUDE_DEPLOYMENT)
  --max-tokens <n>       Per-provider output CEILING. Overrides only the ceiling —
                         --depth still sets the prose length asked for.
  --depth <tier>         shallow|standard|deep — sets the prose length asked for
                         (150–250 / 250–500 / 600–1000 words) and the output
                         ceiling that holds it plus reasoning headroom
  --debate               Run a second round where each model reacts to the other's response
  --continue-from <sid>  Resume from prior session id (loads prior rounds as context)
  --with-context "<txt>" Additional context (repeatable, max 8000 chars per flag, 24000 total)
  --with-arch            Force-attach the repo's AGENTS.md '## Architecture' section as context
  --no-arch              Force-skip architecture context (unanchored ideation)
  --with-artifact <path> Attach the focal artifact verbatim (plan/diff/module).
                         Repeatable. Auto-attaches the repo policy pack.
                         Sensitive paths are refused, never sent.
  --no-policy            Suppress the auto-attached policy pack
                         Default: auto-attach when the topic shows architecture intent
  --out <path>           Write JSON output to file (default: stdout)
  --timeout-ms <n>       Per-provider timeout (default: 60000)
  --sid <sid>            Override session id (default: auto-generated)
  --help                 Show this message

FLAGS — save mode (only valid after positional 'save')
  --sid <sid>            REQUIRED — session id from a brainstorm round
  --round <n>            REQUIRED — round number to attach the insight to
  --topic <text>         REQUIRED — topic text (use --topic-stdin for safety with shell-special chars)
  --topic-stdin          Read topic from stdin
  --insight <text>       Insight body
  --insight-stdin        Read insight body from stdin (with --topic-stdin uses ---END-TOPIC--- delimiter)
  --tags <csv>           Optional comma-separated tags

OUTPUT
  Brainstorm-round mode → schema-valid envelope JSON to stdout/--out (V2 schema with sid/round/debate?)
  Save mode → {ok:true, path, slugUsed} JSON to stdout
  Exit 0 = helper ran. Exit 1 = argv/runtime error. Exit 2 = BUDGET_EXCEEDED.
`;

const WITH_CONTEXT_PER_FLAG_MAX = 8_000;
const WITH_CONTEXT_TOTAL_MAX = 24_000;

function parseArgs(argv) {
  // Detect save mode: first non-flag argv = 'save'
  let mode = 'brainstorm';
  let startIdx = 0;
  if (argv[0] === 'save') {
    mode = 'save';
    startIdx = 1;
  }

  if (mode === 'save') {
    return parseSaveArgs(argv.slice(startIdx));
  }
  return parseBrainstormArgs(argv);
}

function parseBrainstormArgs(argv) {
  const args = {
    mode: 'brainstorm',
    topic: null,
    topicStdin: false,
    // Default is TWO providers — the whole point of /brainstorm is comparing
    // independent perspectives, so one-model was the wrong default. WHICH two
    // is a property of the active profile (`defaultProviders()`: openai+gemini
    // public, openai+azure-claude on Azure), so it is resolved after the argv
    // loop rather than baked in here — `null` means "user did not choose". A
    // provider with no route degrades to state:'misconfigured' (see
    // lib/brainstorm/provider-availability.mjs); it does not fail the run.
    models: null,
    forceGemini: false,      // --with-gemini
    openaiOnly: false,       // --no-gemini / --openai-only
    openaiModel: 'latest-gpt',
    geminiModel: 'latest-pro',
    maxTokens: null,         // null = derived from --depth (or default standard)
    explicitMaxTokens: false,
    depth: null,             // null = auto-resolve via topic (autoPromote) or default standard
    debate: false,
    continueFrom: null,
    withContext: [],         // collected per-flag, validated below
    withArch: false,         // --with-arch — force-attach architecture context
    noArch: false,           // --no-arch — force-skip architecture context
    withArtifact: [],        // --with-artifact <path> — focal object(s), repeatable
    noPolicy: false,         // --no-policy — suppress the auto-attached policy pack
    sid: null,               // explicit override (else auto-generated)
    out: null,
    timeoutMs: 60000,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const requireValue = () => {
      const v = argv[++i];
      if (v === undefined) throw new ArgvError(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--topic': args.topic = requireValue(); break;
      case '--topic-stdin': args.topicStdin = true; break;
      case '--models': args.models = requireValue().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--with-gemini':
        // Audit R1-H16: convenience shortcut for --models openai,gemini
        // (documented in SKILL.md). A no-op on the PUBLIC default path (gemini
        // is already in), retained so existing scripts/docs keep working — and
        // now load-bearing again on Azure, where it forces the Gemini leg back
        // in beside the profile's default voices if you really do have a key.
        args.forceGemini = true;
        break;
      case '--no-gemini':
      case '--openai-only':
        // Aliases, and they must stay one meaning: "just the OpenAI voice".
        // Applied AFTER the default list resolves, so on Azure it also drops
        // the substituted azure-claude leg — the flag's intent is one voice,
        // not "drop a provider that is not in the list anyway".
        args.openaiOnly = true;
        break;
      case '--openai-model': args.openaiModel = requireValue(); break;
      case '--gemini-model': args.geminiModel = requireValue(); break;
      case '--max-tokens': args.maxTokens = Number(requireValue()); args.explicitMaxTokens = true; break;
      case '--depth': args.depth = requireValue(); break;
      case '--debate': args.debate = true; break;
      case '--continue-from': args.continueFrom = requireValue(); break;
      case '--with-context': args.withContext.push(requireValue()); break;
      case '--with-arch': args.withArch = true; break;
      case '--no-arch': args.noArch = true; break;
      case '--with-artifact': args.withArtifact.push(requireValue()); break;
      case '--no-policy': args.noPolicy = true; break;
      case '--sid': args.sid = requireValue(); break;
      case '--out': args.out = requireValue(); break;
      case '--timeout-ms': args.timeoutMs = Number(requireValue()); break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        throw new ArgvError(`Unknown flag: ${a}`);
    }
  }
  if (args.help) return args;
  if (args.topic !== null && args.topicStdin) {
    throw new ArgvError('Provide either --topic OR --topic-stdin, not both');
  }
  if (args.topic === null && !args.topicStdin) {
    throw new ArgvError('Missing --topic or --topic-stdin');
  }
  // Audit R3-M8: --models "" or --models , leaves args.models empty. Checked
  // BEFORE the default resolves, so an explicitly-empty list still fails loudly
  // instead of silently inheriting the profile default.
  if (args.models !== null && args.models.length === 0) {
    throw new ArgvError(`--models requires at least one provider (allowed: ${BRAINSTORM_PROVIDERS.join(', ')})`);
  }
  for (const m of args.models ?? []) {
    if (!BRAINSTORM_PROVIDERS.includes(m)) {
      throw new ArgvError(`Unknown model provider: ${m} (allowed: ${BRAINSTORM_PROVIDERS.join(', ')})`);
    }
  }
  // Resolve the effective provider list: explicit --models wins verbatim,
  // otherwise the active profile's default pair.
  args.models = args.models ?? defaultProviders();
  if (args.forceGemini && !args.models.includes('gemini')) args.models = [...args.models, 'gemini'];
  if (args.openaiOnly) args.models = args.models.filter(m => m === 'openai');
  if (args.models.length === 0) {
    throw new ArgvError('--openai-only / --no-gemini left no providers to call (did you pass --models without openai?)');
  }
  // Audit R4-M7: Object.hasOwn guards against prototype-chain bypass
  if (args.depth !== null && !Object.hasOwn(DEPTH_TOKENS, args.depth)) {
    throw new ArgvError(`--depth must be one of: ${Object.keys(DEPTH_TOKENS).join(', ')}`);
  }
  if (args.explicitMaxTokens) {
    if (!Number.isFinite(args.maxTokens) || args.maxTokens <= 0 || !Number.isInteger(args.maxTokens)) {
      throw new ArgvError(`--max-tokens must be a positive integer`);
    }
  }
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0 || !Number.isInteger(args.timeoutMs)) {
    throw new ArgvError(`--timeout-ms must be a positive integer`);
  }
  // Validate --with-context sizes
  let totalWithContext = 0;
  for (const wc of args.withContext) {
    if (wc.length > WITH_CONTEXT_PER_FLAG_MAX) {
      throw new ArgvError(`--with-context value (${wc.length} chars) exceeds per-flag max ${WITH_CONTEXT_PER_FLAG_MAX}`);
    }
    totalWithContext += wc.length;
  }
  if (totalWithContext > WITH_CONTEXT_TOTAL_MAX) {
    throw new ArgvError(`--with-context combined (${totalWithContext} chars) exceeds total max ${WITH_CONTEXT_TOTAL_MAX}`);
  }
  // --with-arch and --no-arch are contradictory — fail fast.
  if (args.withArch && args.noArch) {
    throw new ArgvError('Provide either --with-arch OR --no-arch, not both');
  }
  return args;
}

function parseSaveArgs(argv) {
  const args = {
    mode: 'save',
    sid: null,
    round: null,
    topic: null,
    topicStdin: false,
    insight: null,
    insightStdin: false,
    tags: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const requireValue = () => {
      const v = argv[++i];
      if (v === undefined) throw new ArgvError(`Flag ${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--sid': args.sid = requireValue(); break;
      case '--round': args.round = Number(requireValue()); break;
      case '--topic': args.topic = requireValue(); break;
      case '--topic-stdin': args.topicStdin = true; break;
      case '--insight': args.insight = requireValue(); break;
      case '--insight-stdin': args.insightStdin = true; break;
      case '--tags': args.tags = requireValue().split(',').map(s => s.trim()).filter(Boolean); break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        throw new ArgvError(`Unknown save-mode flag: ${a}`);
    }
  }
  if (args.help) return args;
  if (!args.sid) throw new ArgvError('save mode requires --sid');
  if (args.round === null || !Number.isInteger(args.round) || args.round < 0) {
    throw new ArgvError('save mode requires --round (non-negative integer)');
  }
  if (args.topic !== null && args.topicStdin) {
    throw new ArgvError('Provide either --topic OR --topic-stdin, not both');
  }
  if (args.insight !== null && args.insightStdin) {
    throw new ArgvError('Provide either --insight OR --insight-stdin, not both');
  }
  if (args.topic === null && !args.topicStdin) throw new ArgvError('save mode requires --topic or --topic-stdin');
  if (args.insight === null && !args.insightStdin) throw new ArgvError('save mode requires --insight or --insight-stdin');
  return args;
}

class ArgvError extends Error {
  constructor(msg) { super(msg); this.code = 'ARGV_ERROR'; }
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err.code === 'ARGV_ERROR') {
      process.stderr.write(`Error: ${err.message}\n\n${HELP_TEXT}`);
      process.exit(1);
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  // Best-effort prune at startup (§16.D — never fail the invocation)
  try {
    const pruned = await pruneOldSessions(30);
    if (pruned > 0) process.stderr.write(`  [brainstorm] pruned ${pruned} old session(s)\n`);
  } catch (err) {
    process.stderr.write(`  [brainstorm] WARN: prune skipped — ${err.code || err.message}\n`);
  }

  if (args.mode === 'save') return runSaveMode(args);
  return runBrainstormMode(args);
}

async function runBrainstormMode(args) {
  // Load topic — supports stdin
  let rawTopic = args.topic;
  if (args.topicStdin) rawTopic = await readStdin();
  if (!rawTopic || rawTopic.trim().length === 0) {
    process.stderr.write(`Error: empty topic\n`);
    process.exit(1);
  }

  // Redact secrets — mandatory (R2-H3); no opt-out flag exists.
  const redaction = redactSecrets(rawTopic);
  const topic = redaction.text;
  const redactionCount = redaction.redacted.length;
  if (redactionCount > 0) {
    process.stderr.write(`  [brainstorm] ⚠ Redacted ${redactionCount} secret pattern(s) before sending: ${redaction.redacted.join(', ')}\n`);
  }

  // Resolve model sentinels
  await refreshModelCatalog().catch(err => {
    process.stderr.write(`  [brainstorm] WARN: model catalog refresh failed (${err?.message ?? 'unknown'}); using static pool\n`);
  });
  const resolvedModels = {};
  if (args.models.includes('openai')) resolvedModels.openai = resolveModel(args.openaiModel);
  if (args.models.includes('gemini')) resolvedModels.gemini = resolveModel(args.geminiModel);
  // The Azure voice's "model" is a DEPLOYMENT name, so it must NOT go through
  // resolveModel — a sentinel would 404 on the wire, which is exactly the
  // footgun `azureConfig` keeps the deployment vars separate from the logical
  // model vars to avoid. Null-safe: an inactive profile leaves it undefined and
  // the availability oracle reports why before any call is attempted.
  if (args.models.includes('azure-claude')) resolvedModels['azure-claude'] = azureConfig.claudeDeployment ?? undefined;

  // Depth ALWAYS resolves; `--max-tokens` overrides only the CEILING.
  //
  // Depth's real lever is the prose length asked for in the system prompt
  // (plus the reasoning-effort hint and topic auto-promotion). Those are
  // properties of the tier, not of the ceiling — so resolving them inside an
  // `else` meant any `--max-tokens` invocation silently reverted to the
  // default 250–500 word ask with reasoningEffort null and auto-promotion
  // dead, i.e. `--depth deep --max-tokens N` behaved like standard. The
  // ceiling is the one thing `--max-tokens` legitimately owns.
  const dep = resolveOutputBudget({
    explicitDepth: args.depth,
    topic,
    explicitMaxTokens: args.explicitMaxTokens,
    maxTokens: args.maxTokens,
  });
  const { maxTokens, reasoningEffort: depEffort, wordTarget: depWordTarget } = dep;
  const reasoningEffort = depEffort ?? null;
  const wordTarget = depWordTarget ?? DEFAULT_WORD_TARGET;

  if (dep.autoPromoted) {
    process.stderr.write(`  [brainstorm] auto-promoted depth → ${dep.depth} (${dep.tierMaxTokens} tokens)\n`);
  }
  if (dep.ceilingOverridden) {
    process.stderr.write(
      `  [brainstorm] --max-tokens overrides the ${dep.depth} ceiling ` +
      `(${dep.tierMaxTokens} → ${maxTokens}); depth still sets the ${dep.wordTarget} target\n`
    );
    // Say it up front rather than leaving the adapter's `state:'truncated'`
    // to explain it after the spend.
    if (dep.ceilingBelowProseBudget) {
      process.stderr.write(
        `  [brainstorm] WARN: max-tokens ${maxTokens} is below the ${dep.depth} prose budget ` +
        `(${dep.visibleTokens}) — the response will very likely be truncated\n`
      );
    }
  }

  // Decide + load architecture context (docs/plans/brainstorm-arch-context.md).
  // shouldAttachArch is pure; the file read happens only when it returns true.
  const attachArch = shouldAttachArch({ withArch: args.withArch, noArch: args.noArch, topic });
  let archContextText = '';
  let archContextWarning = null;
  if (attachArch) {
    const arch = loadArchSection();
    if (arch.state === 'ok') {
      archContextText = arch.text;
      process.stderr.write(`  [brainstorm] attached architecture context (${arch.text.length} chars from ${arch.sourceFile})\n`);
    } else {
      const reason = arch.state === 'no-file'
        ? 'no AGENTS.md/CLAUDE.md found'
        : arch.state === 'no-section'
          ? "no '## Architecture' section found in AGENTS.md/CLAUDE.md"
          : `instruction file unreadable (${arch.error})`;
      if (args.withArch) {
        // Explicit intent — surface to the user via the envelope (Step 3).
        archContextWarning = `--with-arch was requested but architecture context could not be attached: ${reason}.`;
        process.stderr.write(`  [brainstorm] WARN: ${archContextWarning}\n`);
      } else {
        // Auto-mode — quiet stderr only; the user didn't ask.
        process.stderr.write(`  [brainstorm] architecture context not attached (${reason}); proceeding\n`);
      }
    }
  }

  // ── Focal artifacts + policy pack (--with-artifact) ──
  // The empirical fix for repo-blind external takes: attach the OBJECT
  // under discussion verbatim, plus the standing rules a recommendation
  // must not break. Attaching denser architecture prose was tried and
  // measured — it did not work (see the module header).
  let artifactBlock = '';
  let policyBlock = '';
  let artifactSummary = null;
  if (args.withArtifact.length > 0) {
    const loaded = loadArtifacts(args.withArtifact, { repoRoot: process.cwd() });
    artifactBlock = loaded.text;
    for (const r of loaded.refused) {
      process.stderr.write(`  [brainstorm] ⚠ artifact REFUSED (${r.reason}): ${r.path}\n`);
    }
    if (loaded.attached.length > 0) {
      process.stderr.write(`  [brainstorm] attached ${loaded.attached.length} focal artifact(s), ~${loaded.totalTokens} tokens${loaded.redactionCount > 0 ? ` (${loaded.redactionCount} secret(s) redacted)` : ''}\n`);
    }
    if (!args.noPolicy && loaded.attached.length > 0) {
      const pack = loadPolicyPack({ artifactPaths: loaded.attached.map(a => a.path) });
      policyBlock = pack.text;
      if (pack.text) {
        process.stderr.write(`  [brainstorm] attached policy pack: ${pack.requirementCount} in-scope invariant(s), ${pack.sectionsIncluded.length} doc section(s), ~${pack.totalTokens} tokens${pack.ledgerStale ? ' (⚠ ledger may be stale)' : ''}\n`);
      }
    }
    artifactSummary = {
      requested: args.withArtifact.length,
      attached: loaded.attached.map(a => ({ path: a.path, bytes: a.bytes, truncated: a.truncated })),
      refused: loaded.refused.map(r => ({ path: r.path, reason: r.reason })),
      policyAttached: policyBlock.length > 0,
    };
  }

  // Assemble resume context + --with-context (BEFORE preflight per §13.C)
  const providersForBudget = args.models.map(p => ({
    provider: p,
    model: p === 'openai' ? args.openaiModel : args.geminiModel,
  }));
  const wcCombined = args.withContext.length > 0
    ? args.withContext.join('\n\n---\n\n')
    : '';
  let assembledContext = { systemPreface: '', userPrefix: '', withContextEffective: '', archContextEffective: '', archContextTokens: 0, includedRounds: [], droppedRounds: [], estimatedTokens: 0 };
  try {
    assembledContext = assembleResumeContext({
      sid: args.continueFrom,
      withContextText: wcCombined,
      archContextText,
      extraPrefaceBlocks: [artifactBlock, policyBlock],
      providers: providersForBudget,
    });
  } catch (err) {
    if (err.code === 'BUDGET_EXCEEDED') {
      process.stderr.write(`  [brainstorm] ERROR: ${err.message}\n`);
      const out = { ok: false, code: 'BUDGET_EXCEEDED', estimatedTokens: err.estimatedTokens, budgetTokens: err.budgetTokens };
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(2);
    }
    throw err;
  }
  if (args.continueFrom && assembledContext.includedRounds.length === 0) {
    process.stderr.write(`  [brainstorm] WARN: session ${args.continueFrom} not found or empty — proceeding without resume context\n`);
  }
  if (assembledContext.includedRounds.length > 0 || assembledContext.droppedRounds.length > 0) {
    process.stderr.write(`  [brainstorm] resume: included ${assembledContext.includedRounds.length}; dropped ${assembledContext.droppedRounds.length}; tokens ${assembledContext.estimatedTokens}\n`);
  }

  // Pre-call cost estimate — uses ASSEMBLED context (§13.C) AND debate (§14.C)
  const totalInputChars = topic.length + (assembledContext.systemPreface || '').length + (assembledContext.userPrefix || '').length + (assembledContext.withContextEffective || '').length;
  const round1Cost = args.models.reduce((sum, p) => sum + preflightEstimateUsd({
    modelId: resolvedModels[p],
    inputChars: totalInputChars,
    maxOutputTokens: maxTokens,
  }), 0);
  const debateRunsForBudget = (args.debate && args.models.length === 2) ? 2 : 0;
  const debateCost = debateRunsForBudget > 0
    ? args.models.reduce((sum, p) => sum + preflightEstimateUsd({
        modelId: resolvedModels[p],
        inputChars: totalInputChars + maxTokens * 4,  // peer's response added to input
        maxOutputTokens: maxTokens,
      }), 0)
    : 0;
  const preflightTotal = round1Cost + debateCost;
  process.stderr.write(`  [brainstorm] Calling: ${args.models.join(', ')} | Resolved: ${JSON.stringify(resolvedModels)}\n`);
  process.stderr.write(`  [brainstorm] Pre-call cost ceiling: ~$${preflightTotal.toFixed(4)} (${args.models.length} round-1${args.debate && args.models.length === 2 ? ' + 2 debate' : ''} calls; total input ~${totalInputChars} chars; max-out=${maxTokens})\n`);

  // Dispatch round 1
  const composedSystemPreface = assembledContext.systemPreface;
  const composedTopic = assembledContext.withContextEffective
    ? `${topic}\n\nAdditional context:\n${assembledContext.withContextEffective}`
    : topic;
  const tasks = args.models.map(p => dispatchProvider({
    provider: p,
    topic: composedTopic,
    systemPreface: composedSystemPreface,
    args: { ...args, maxTokens, reasoningEffort, wordTarget },
    resolvedModels,
  }));
  const settled = await Promise.all(tasks);

  // Optional debate round (§12.A canonical 4-case state machine)
  let debateResults = [];
  // null = the debate round was not requested. Set only when `--debate` was
  // passed and the round could not run; stays null when it did run.
  let debateSkipped = null;
  if (args.debate) {
    const outcome = await runDebateRound({
      providers: args.models,
      round1: settled,
      args: { ...args, maxTokens, reasoningEffort, wordTarget },
      resolvedModels,
      assembledContext,
      withContextText: assembledContext.withContextEffective,
      originalTopic: topic,
    });
    debateResults = outcome.results;
    debateSkipped = outcome.skipped;
  }

  // Build envelope (V2)
  const round1CostFinal = settled.reduce((s, p) => s + (p.estimatedCostUsd ?? 0), 0);
  const debateCostFinal = debateResults.reduce((s, d) => s + (d.estimatedCostUsd ?? 0), 0);
  const totalCostUsd = round1CostFinal + debateCostFinal;
  const sid = args.sid || generateSid();
  const envelope = {
    topic,
    redactionCount,
    resolvedModels,
    providers: settled,
    totalCostUsd: Number(totalCostUsd.toFixed(6)),
    sid,
    capturedAt: new Date().toISOString(),
    schemaVersion: 2,
    debate: debateResults,
    // Always emitted (WriteSchema requires the key). null = not requested, or
    // requested and it ran; an object = requested and cancelled, with the why.
    debateSkipped,
    // Arch-context fields — always emitted (WriteSchema requires them).
    // archContextChars is the post-redaction, post-truncation length of
    // the wrapped block actually sent (docs/plans/brainstorm-arch-context.md).
    archContextAttached: (assembledContext.archContextEffective || '').length > 0,
    archContextChars: (assembledContext.archContextEffective || '').length,
    archContextWarning,
    // Focal-artifact fields — null when --with-artifact was not used, so a
    // consumer can distinguish "not requested" from "requested, all refused".
    artifactContext: artifactSummary,
  };

  // Both providers failed — DO NOT append to session ledger (§10.F)
  const successCount = settled.filter(p => p.state === 'success').length;
  let appendResult = null;
  if (successCount === 0) {
    process.stderr.write(`  [brainstorm] ERROR: both providers failed in round 1; not appending to session ledger\n`);
    // Still emit envelope so caller can see error states; round=0 placeholder
    envelope.round = 0;
  } else {
    try {
      appendResult = await appendSession({ sid, envelope: { ...envelope, round: undefined } });
      envelope.round = appendResult.round;
    } catch (err) {
      process.stderr.write(`  [brainstorm] WARN: appendSession failed — ${err.code || err.message}\n`);
      envelope.round = 0;
    }
  }

  // Deterministic arm-eval capture (toggle-gated; first-round only; detached).
  // Replaces the skippable skill Step 4.5 — capture now fires as a function of
  // PERSISTING the brainstorm, not a trailing instruction the model can omit.
  // No-op (byte-identical path) when the per-repo toggle is off.
  // NOTE: appendSession numbers a session's FIRST round 0 (session-store.mjs)
  // — the ledger is 0-based. Gating on `=== 1` here meant a fresh brainstorm
  // could never capture (field-found in wine-cellar-app, 2026-07-03). A failed
  // append leaves round 0 via the catch above, but successCount === 0 guards
  // the both-providers-failed case and appendSession only throws on lock/IO
  // failure — acceptable to still capture then (the round DID run).
  if (successCount > 0 && envelope.round === 0) {
    try {
      const { maybeFireArmEvalCaptureDetached } = await import('./lib/arm-eval/capture-trigger.mjs');
      const r = maybeFireArmEvalCaptureDetached({ experimentType: 'brainstorm', task: envelope.topic, round: envelope.round });
      if (r.fired) process.stderr.write('  [brainstorm] arm-eval capture dispatched in background (toggle on)\n');
    } catch { /* never block the brainstorm on capture */ }
  }

  // Validate envelope
  const parsed = BrainstormEnvelopeWriteSchema.safeParse(envelope);
  if (!parsed.success) {
    process.stderr.write(`  [brainstorm] code: SCHEMA_INVALID — helper produced invalid envelope\n`);
    process.stderr.write(`  ${JSON.stringify(parsed.error.issues, null, 2)}\n`);
    process.exit(1);
  }

  const json = JSON.stringify(parsed.data, null, 2);
  if (args.out) {
    atomicWriteFileSync(args.out, json);
    process.stderr.write(`  [brainstorm] Output: ${args.out} | Session: ${sid} round ${envelope.round}\n`);
  } else {
    process.stdout.write(json + '\n');
  }
  process.exit(0);
}

async function runSaveMode(args) {
  // Load topic + insight (handles stdin variants per §16.A)
  let topic = args.topic;
  let insight = args.insight;
  if (args.topicStdin && args.insightStdin) {
    const raw = await readStdin();
    const idx = raw.indexOf('\n---END-TOPIC---\n');
    if (idx < 0) {
      process.stderr.write('Error: --topic-stdin + --insight-stdin require "---END-TOPIC---" delimiter on its own line\n');
      process.exit(1);
    }
    topic = raw.slice(0, idx);
    insight = raw.slice(idx + '\n---END-TOPIC---\n'.length);
  } else if (args.topicStdin) {
    topic = await readStdin();
  } else if (args.insightStdin) {
    insight = await readStdin();
  }
  topic = (topic || '').trim();
  insight = (insight || '').trim();

  // Validate sid + round exist in ledger (§10.H + §16.B)
  const session = loadSession(args.sid);
  if (!session) {
    process.stderr.write(`Error: session ${args.sid} not found in .brainstorm/sessions/\n`);
    process.exit(1);
  }
  const matchingRound = session.rounds.find(r => r.round === args.round);
  if (!matchingRound) {
    process.stderr.write(`Error: round ${args.round} not found in session ${args.sid} (session has rounds ${session.rounds.map(r => r.round).join(',')})\n`);
    process.exit(1);
  }
  if (topic !== matchingRound.topic) {
    process.stderr.write(`  [brainstorm] WARN: --topic does not match round's recorded topic (insight saved with provided topic)\n`);
  }

  try {
    const result = await saveInsight({ sid: args.sid, round: args.round, topic, insightText: insight, tags: args.tags });
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    process.exit(0);
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(1);
  }
}

function generateSid() {
  // Short, sortable, unique-enough for local sessions: timestamp + random suffix
  return `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
}

async function runDebateRound({ providers, round1, args, resolvedModels, assembledContext, withContextText, originalTopic }) {
  // §12.A canonical state machine — entries only when both providers succeeded.
  //
  // A skip returns `{results: [], skipped: {reason, detail}}` rather than a bare
  // `[]`. The bare form made a requested-but-cancelled debate byte-identical to
  // one that was never requested (both landed as `debate: []`), so an agent
  // following the skill rendered neither a debate block nor an explanation —
  // after the user had already paid for round 1. The one-provider case did not
  // even get the stderr WARN, so it was silent on every surface.
  // Same oracle as the classifier — never a second copy of the eligibility test.
  const successByProvider = {};
  for (const r of round1) successByProvider[r.provider] = isDebateEligible(r) ? r : null;

  const outcome = classifyDebateOutcome({ providers, round1 });
  if (!outcome.ok) {
    process.stderr.write(`  [brainstorm] WARN: debate skipped — ${outcome.skipped.detail}\n`);
    return { results: [], skipped: outcome.skipped };
  }

  const tasks = providers.map(speaker => {
    const peer = providers.find(p => p !== speaker);
    const peerResp = successByProvider[peer];
    const { systemPrompt, userMessage } = buildDebatePrompt({
      otherProvider: peer,
      otherResponse: peerResp.text,
      originalTopic,
      assembledContext: { systemPreface: assembledContext.systemPreface || '', userPrefix: assembledContext.userPrefix || '' },
      withContextText: withContextText || '',
    });
    return dispatchDebateCall({
      provider: speaker,
      reactingTo: peer,
      systemPrompt,
      userMessage,
      args,
      resolvedModels,
    });
  });
  return { results: await Promise.all(tasks), skipped: null };
}

/**
 * provider id → adapter. One table, used by round 1 AND the debate round, so a
 * new voice cannot be wired into one and forgotten in the other. Every id in
 * `BRAINSTORM_PROVIDERS` must appear here — asserted at module load below.
 */
const ADAPTERS = {
  openai: callOpenAI,
  gemini: callGemini,
  'azure-claude': callAzureClaude,
};
for (const p of BRAINSTORM_PROVIDERS) {
  if (typeof ADAPTERS[p] !== 'function') {
    throw new Error(`[brainstorm] provider "${p}" is declared but has no adapter wired in ADAPTERS`);
  }
}

async function dispatchDebateCall({ provider, reactingTo, systemPrompt, userMessage, args, resolvedModels }) {
  const baseEntry = {
    provider, reactingTo,
    state: 'http_error', text: null, errorMessage: null,
    httpStatus: null, usage: null, latencyMs: 0, estimatedCostUsd: null,
  };
  // Same oracle as round 1 — never a second copy of the credential test.
  const availability = resolveProviderAvailability(provider);
  if (!availability.available) {
    return { ...baseEntry, state: 'http_error', errorMessage: availability.reason };
  }
  const model = resolvedModels[provider];
  // Reuse round-1 adapters but pass the debate prompts via the topic argument
  // and inject the system preface inline. The adapters take a single `topic`
  // string today — we concatenate system+user for compatibility.
  const fn = ADAPTERS[provider];
  const debateTopic = `${systemPrompt}\n\n---\n\n${userMessage}`;
  const r1 = await fn({ topic: debateTopic, model, maxTokens: args.maxTokens, timeoutMs: args.timeoutMs, reasoningEffort: args.reasoningEffort ?? null });
  // r1 has the ProviderResultSchema shape; project the fields the DebateRoundSchema expects
  return {
    provider, reactingTo,
    // Pass the provider's own state through. This used to collapse anything
    // outside a hardcoded five-state list to `http_error`, so a debate response
    // that was content-filtered (`blocked`) or hit the output ceiling
    // (`truncated`) was persisted under a label naming a transport failure that
    // never happened. DebateRoundSchema now accepts the full PROVIDER_STATES
    // contract, so there is nothing left to collapse — and a state the schema
    // does not know fails at the write boundary rather than being renamed.
    state: r1.state,
    text: r1.text ?? null,
    errorMessage: r1.errorMessage ?? null,
    httpStatus: r1.httpStatus ?? null,
    usage: r1.usage ?? null,
    latencyMs: r1.latencyMs ?? 0,
    estimatedCostUsd: r1.estimatedCostUsd ?? null,
  };
}

async function dispatchProvider({ provider, topic, systemPreface = '', args, resolvedModels }) {
  // "Can this provider be called?" — a route question, not a public-env-var
  // question. See lib/brainstorm/provider-availability.mjs for why the two are
  // not the same on an Azure work profile.
  const availability = resolveProviderAvailability(provider);
  if (!availability.available) {
    return {
      provider,
      state: 'misconfigured',
      text: null,
      errorMessage: availability.reason,
      httpStatus: null,
      usage: null,
      latencyMs: 0,
      estimatedCostUsd: null,
    };
  }

  const model = resolvedModels[provider];
  const fn = ADAPTERS[provider];
  // The adapters take a single `topic` string. We prepend the resume
  // context inline so the round-1 prompt = preface + topic + with-context.
  const composedTopic = systemPreface
    ? `${systemPreface}\n\n---\n\nNew topic for this round:\n${topic}`
    : topic;
  const result = await fn({
    topic: composedTopic,
    model,
    maxTokens: args.maxTokens,
    timeoutMs: args.timeoutMs,
    // Depth's real lever: the prose length the prompt asks for. Without
    // this, every tier requested the same 250–500 words and `--depth`
    // only moved where truncation landed.
    systemPrompt: buildBrainstormSystemPrompt({ wordTarget: args.wordTarget ?? DEFAULT_WORD_TARGET }),
    // OpenAI-only depth hint; callGemini's destructuring ignores it.
    reasoningEffort: args.reasoningEffort ?? null,
  });

  // For malformed responses, save raw payload to repo-local debug dir
  // with restricted permissions (Gemini-G3, R2-M3).
  if (result.state === 'malformed' && result.errorMessage) {
    try {
      const repoRoot = process.cwd();
      const debugDir = path.join(repoRoot, DEBUG_DIR_RELATIVE);
      fs.mkdirSync(debugDir, { recursive: true });
      const sid = Date.now().toString(36);
      const debugPath = path.join(debugDir, `brainstorm-${sid}-${provider}.json`);
      const payload = redactSecrets(result.errorMessage).text;
      fs.writeFileSync(debugPath, payload, { mode: 0o600 });
      result.errorMessage = `${result.errorMessage} (raw payload: ${path.relative(repoRoot, debugPath)})`;
    } catch {
      // Best-effort; don't fail the whole call
    }
  }

  return result;
}

main().catch(err => {
  process.stderr.write(`  [brainstorm] FATAL: ${err.message}\n`);
  process.stderr.write(`${err.stack ?? ''}\n`);
  process.exit(1);
});
