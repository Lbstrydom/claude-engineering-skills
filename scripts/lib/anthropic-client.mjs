/**
 * @fileoverview Pluggable Anthropic client factory.
 *
 * Backends (selected via env `CLAUDE_BACKEND`):
 *
 *   `sdk`  (default) — raw `@anthropic-ai/sdk`.
 *                       Bills your Anthropic API key on a per-token basis.
 *
 *   `cli`            — spawns `claude -p ... --output-format json`.
 *                       Bills the Max subscription today; from 2026-06-15
 *                       this draws from the Max 20x Agent SDK $200/mo
 *                       credit per the announcement
 *                       (https://support.anthropic.com — search "Agent SDK credit").
 *                       Default flag stays `sdk` until that date; flip when
 *                       the credit redemption flow opens.
 *
 * Both backends expose the same `.messages.create({model, max_tokens, system, messages})`
 * shape returning `{content: [{type:'text', text}], usage: {input_tokens, output_tokens}, ...}`.
 * Call sites swap `new Anthropic({apiKey})` → `await createAnthropicClient()`
 * with no other changes.
 *
 * **Contract scope** — the `cli` adapter targets one-shot, single-user-message,
 * text-only generation (the only call pattern we use). It throws on
 * multi-turn messages or non-text content blocks rather than silently
 * lossy-flattening them. `max_tokens` has no `claude -p` flag equivalent;
 * passing it on the cli backend emits a one-time stderr warning so the
 * mismatch is surfaced rather than silently dropped.
 *
 * Module-global single-client cache: subsequent calls within the same process
 * reuse the same adapter (matches the AGENTS.md "reuse the client created in
 * main()" rule). Cache key is built from the *effective* values (post-env
 * resolution), not the raw `options` object, so two `createAnthropicClient()`
 * calls without overrides hit the same cache entry as expected.
 *
 * Redaction (deny-by-default): every outgoing `system` and text content
 * block is passed through `redactSecrets()` from `./sanitizer.mjs` before
 * leaving the process (cli backend) or being handed to the SDK (sdk
 * backend). Callers no longer need to pre-redact — the factory enforces
 * it. To override, pass `redactor: <fn>` (custom) or `redactor: null`
 * (explicit opt-out; not recommended).
 *
 * @module scripts/lib/anthropic-client
 */

import { spawn, spawnSync } from 'node:child_process';
import { z } from 'zod';

// ── CLI envelope schema ─────────────────────────────────────────────────────
// Validates the JSON shape emitted by `claude -p --output-format json`.
// `result` is required; everything else is optional/lenient because the
// envelope evolves between Claude Code versions.
const ClaudeCliEnvelope = z.object({
  result: z.string(),
  is_error: z.boolean().optional(),
  model: z.string().optional(),
  usage: z.object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
  }).passthrough().optional(),
  total_cost_usd: z.number().optional(),
  duration_ms: z.number().optional(),
  num_turns: z.number().optional(),
}).passthrough();

const ClaudeCliErrorEnvelope = z.object({
  is_error: z.literal(true),
  result: z.string().optional(),
}).passthrough();

const VALID_BACKENDS = new Set(['sdk', 'cli']);

// Default subprocess timeout for cli backend. Overridable via
// CLAUDE_CLI_TIMEOUT_MS env var. Picked to comfortably exceed Haiku/Sonnet
// p99 first-token latency while still failing fast on a hung child.
const DEFAULT_CLI_TIMEOUT_MS = 120_000;
// 100ms floor is generous: legitimate CLI calls take seconds. Anything
// lower is almost certainly a `.env` typo (`CLAUDE_CLI_TIMEOUT_MS=120`
// when they meant 120000).
const MIN_CLI_TIMEOUT_MS = 100;
const MAX_CLI_TIMEOUT_MS = 3_600_000; // 1 hour — anything beyond is a config bug

/**
 * Resolve and validate the effective subprocess timeout. Rejects nonsensical
 * values (zero, negative, Infinity, NaN, > 1h) — these usually indicate a
 * `.env` typo and would either hang forever or fail every call.
 */
function resolveTimeoutMs(optionsTimeout) {
  const raw = optionsTimeout !== undefined
    ? optionsTimeout
    : (process.env.CLAUDE_CLI_TIMEOUT_MS ? Number(process.env.CLAUDE_CLI_TIMEOUT_MS) : DEFAULT_CLI_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw < MIN_CLI_TIMEOUT_MS || raw > MAX_CLI_TIMEOUT_MS) {
    throw new Error(
      `[anthropic-client] CLAUDE_CLI_TIMEOUT_MS / options.timeoutMs must be a finite number ` +
      `in [${MIN_CLI_TIMEOUT_MS}, ${MAX_CLI_TIMEOUT_MS}] ms (got ${raw}).`,
    );
  }
  return raw;
}

/** @type {Map<string, object>} */
const _clientCache = new Map();

/** Once-per-session tracking for warnings. */
let _warnedMaxTokensCli = false;

/**
 * Resolve the backend from env. **Throws** on invalid values — the backend
 * choice affects billing, so a typo like `CLAUDE_BACKEND=cil` must surface
 * at config-load time rather than silently routing to a paid path. Unset
 * the variable to use the default `sdk`.
 * @returns {'sdk'|'cli'}
 * @throws {Error} when CLAUDE_BACKEND is set to an unrecognised value
 */
export function resolveBackend() {
  const raw = (process.env.CLAUDE_BACKEND || 'sdk').toLowerCase();
  if (!VALID_BACKENDS.has(raw)) {
    // Hard-fail on invalid values. The backend choice affects billing (API
    // meter vs Agent SDK credit), so a typo like `CLAUDE_BACKEND=cil` must
    // not silently route to a paid path — fail at config load instead.
    throw new Error(
      `[anthropic-client] Invalid CLAUDE_BACKEND="${raw}". ` +
      `Valid values: ${[...VALID_BACKENDS].join(', ')}. ` +
      `Unset the variable to use the default "sdk".`,
    );
  }
  return /** @type {'sdk'|'cli'} */ (raw);
}

/**
 * Create or retrieve a cached Anthropic-shaped client.
 *
 * **Egress redaction** — by default, `redactSecrets` from
 * [scripts/lib/sanitizer.mjs](sanitizer.mjs) is applied to `system` strings
 * and every text content block before they leave the process. Pass
 * `redactor: null` to opt out, or a custom function `(s: string) => string`.
 * The default redactor is identity-cached (same Function reference per
 * factory load) so the client cache works correctly.
 *
 * **Cache key** — built from effective resolved env values + redactor
 * identity. Distinct custom redactor functions DO NOT share a cache
 * entry; passing `redactor` always bypasses the cache and returns a
 * fresh client. Callers that need a long-lived client with a custom
 * redactor should manage its lifetime themselves.
 *
 * @param {object} [options]
 * @param {'sdk'|'cli'} [options.backend] - Override env-resolved backend (test injection)
 * @param {string} [options.apiKey] - Override `ANTHROPIC_API_KEY` (sdk backend only)
 * @param {string} [options.claudeBin] - Override `CLAUDE_BIN` (cli backend only)
 * @param {number} [options.timeoutMs] - Per-call default subprocess timeout (cli backend)
 * @param {((text: string) => string)|null} [options.redactor] - Egress redactor.
 *   Defaults to `redactSecrets`. `null` disables redaction (NOT recommended).
 * @param {boolean} [options.fresh] - Bypass cache (for tests)
 * @returns {Promise<{messages: {create: (params: object, requestOptions?: object) => Promise<object>}}>}
 */
export async function createAnthropicClient(options = {}) {
  const backend = options.backend || resolveBackend();
  // Resolve effective env values BEFORE building the cache key so that two
  // unparameterised calls share a cache entry.
  const effectiveApiKey = options.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const effectiveClaudeBin = options.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const effectiveTimeoutMs = resolveTimeoutMs(options.timeoutMs);

  // Default redactor is the shared `redactSecrets` (lazy-imported so test
  // injection can override without pulling in sanitizer.mjs).
  // `redactor: null` → no redaction (explicit opt-out).
  // `redactor: undefined` → default redactor.
  const effectiveRedactor = options.redactor === null
    ? null
    : (options.redactor || await getDefaultRedactor());

  // Cache key — only `null` (no redaction) and the shared default redactor
  // are cacheable. Custom redactor functions bypass the cache entirely
  // because two distinct functions could collapse to one cache entry under
  // a string key, returning the wrong redactor to the second caller.
  const defaultRedactor = await getDefaultRedactor();
  const cacheable = effectiveRedactor === null || effectiveRedactor === defaultRedactor;
  const cacheKey = `${backend}:${effectiveApiKey}:${effectiveClaudeBin}:${effectiveTimeoutMs}:${effectiveRedactor === null ? 'n' : 'd'}`;
  if (!options.fresh && cacheable && _clientCache.has(cacheKey)) {
    return _clientCache.get(cacheKey);
  }

  let client;
  if (backend === 'cli') {
    client = createCliAdapter({
      claudeBin: effectiveClaudeBin,
      timeoutMs: effectiveTimeoutMs,
      redactor: effectiveRedactor,
    });
  } else {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    if (!effectiveApiKey) {
      throw new Error('[anthropic-client] ANTHROPIC_API_KEY required for sdk backend');
    }
    const rawClient = new Anthropic({ apiKey: effectiveApiKey });
    client = effectiveRedactor ? wrapSdkWithRedactor(rawClient, effectiveRedactor) : rawClient;
  }

  if (cacheable) _clientCache.set(cacheKey, client);
  return client;
}

/** @type {((s: string) => string)|null} */
let _defaultRedactor = null;
async function getDefaultRedactor() {
  if (_defaultRedactor === null) {
    const { redactSecrets } = await import('./sanitizer.mjs');
    _defaultRedactor = redactSecrets;
  }
  return _defaultRedactor;
}

/**
 * Wrap a raw SDK client so every outbound `system` and text content block
 * is run through `redactor` before reaching the network. Returns a proxy
 * that exposes the same `.messages.create()` surface.
 */
function wrapSdkWithRedactor(rawClient, redactor) {
  return {
    messages: {
      async create(params, requestOptions) {
        const redacted = applyRedactor(params, redactor);
        return rawClient.messages.create(redacted, requestOptions);
      },
    },
  };
}

/**
 * Return a shallow-cloned params object with redacted `system` and text
 * content blocks. Non-text content blocks pass through untouched (the
 * cli adapter rejects them, but the sdk path may forward images).
 *
 * Handles both `system: "string"` and `system: [{type:'text', text:'...'}]`
 * (the structured form used for prompt caching).
 */
function applyRedactor(params, redactor) {
  if (typeof redactor !== 'function') return params;
  const out = { ...params };
  if (typeof out.system === 'string') {
    out.system = redactor(out.system);
  } else if (Array.isArray(out.system)) {
    out.system = out.system.map(b =>
      b && b.type === 'text' && typeof b.text === 'string'
        ? { ...b, text: redactor(b.text) }
        : b,
    );
  }
  if (Array.isArray(out.messages)) {
    out.messages = out.messages.map(m => {
      if (typeof m.content === 'string') return { ...m, content: redactor(m.content) };
      if (Array.isArray(m.content)) {
        return {
          ...m,
          content: m.content.map(b =>
            b && b.type === 'text' && typeof b.text === 'string'
              ? { ...b, text: redactor(b.text) }
              : b,
          ),
        };
      }
      return m;
    });
  }
  return out;
}

/**
 * Reset the module-global client cache AND once-per-session warning flags.
 * Tests only.
 */
export function _resetClientCache() {
  _clientCache.clear();
  _warnedMaxTokensCli = false;
}

/**
 * Build a `claude -p` adapter that mimics the raw-SDK `.messages.create()` shape.
 *
 * Scope: targets one-shot single-user-message text-only generation. Throws
 * on multi-turn / non-text content rather than silently flattening. Pass
 * `redactor` to enforce egress redaction on `system` and text content.
 *
 * @param {{claudeBin?: string, timeoutMs?: number, redactor?: (s: string) => string}} opts
 * @returns {{messages: {create: (params: object, requestOptions?: object) => Promise<object>}}}
 */
function createCliAdapter(opts = {}) {
  const claudeBin = opts.claudeBin || process.env.CLAUDE_BIN || 'claude';
  const defaultTimeoutMs = resolveTimeoutMs(opts.timeoutMs);
  const redactor = typeof opts.redactor === 'function' ? opts.redactor : null;

  return {
    messages: {
      /**
       * @param {{
       *   model?: string,
       *   max_tokens?: number,
       *   system?: string,
       *   messages: Array<{role: string, content: string|Array}>
       * }} params
       * @param {{signal?: AbortSignal, timeoutMs?: number}} [requestOptions]
       *   `signal` kills the child via SIGTERM; `timeoutMs` overrides the
       *   factory default for this single call.
       */
      async create(params, requestOptions = {}) {
        const { model, max_tokens, system, messages } = params;

        assertOneShotTextMessages(messages);

        if (max_tokens !== undefined && !_warnedMaxTokensCli) {
          _warnedMaxTokensCli = true;
          process.stderr.write(
            `  [anthropic-client] WARNING: max_tokens is not enforceable on the cli backend ` +
            `(claude -p has no equivalent flag). The model's own output limit applies.\n`,
          );
        }

        const effectiveSystem = redactor && typeof system === 'string'
          ? redactor(system) : system;
        const prompt = redactor
          ? redactor(buildPromptFromMessages(messages))
          : buildPromptFromMessages(messages);

        // Prompt goes via stdin — avoids shell-escaping the user content
        // when `shell: true` is required (Windows .cmd / .bat resolution).
        const args = ['-p', '--output-format', 'json', '--max-turns', '1'];
        if (effectiveSystem) args.push('--system-prompt', effectiveSystem);
        if (model) args.push('--model', model);

        const callTimeoutMs = Number.isFinite(requestOptions.timeoutMs)
          ? requestOptions.timeoutMs
          : defaultTimeoutMs;

        const { stdout } = await runClaudeCli(
          claudeBin, args, requestOptions.signal, prompt, callTimeoutMs,
        );
        return normaliseCliOutput(stdout, model);
      },
    },
  };
}

/**
 * Reject inputs the cli adapter cannot faithfully represent: multi-turn
 * histories, assistant-role messages, image/tool_use/tool_result blocks.
 * Better to fail loudly than silently strip semantically meaningful data.
 *
 * @param {Array<{role: string, content: string|Array}>} messages
 */
function assertOneShotTextMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('[anthropic-client] cli backend requires a non-empty messages array');
  }
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role && m.role !== 'user') {
      throw new Error(
        `[anthropic-client] cli backend supports user-role messages only ` +
        `(got role="${m.role}" at index ${i}). Use the sdk backend for multi-turn ` +
        `or assistant-priming flows.`,
      );
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (!block || block.type !== 'text') {
          throw new Error(
            `[anthropic-client] cli backend supports text content blocks only ` +
            `(got type="${block?.type}" at message ${i}). Use the sdk backend ` +
            `for images, tool_use, or tool_result blocks.`,
          );
        }
      }
    } else if (typeof m.content !== 'string') {
      throw new Error(
        `[anthropic-client] cli backend: message ${i} content must be string or array`,
      );
    }
  }
}

/**
 * Flatten the messages array into a single user-prompt string. We only ever
 * pass single-turn one-shot prompts through this adapter, so this is safe.
 * @param {Array<{role: string, content: string|Array}>} messages
 * @returns {string}
 */
function buildPromptFromMessages(messages) {
  if (!Array.isArray(messages)) {
    throw new Error('[anthropic-client] messages must be an array');
  }
  return messages
    .map(m => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .filter(b => b && b.type === 'text' && typeof b.text === 'string')
          .map(b => b.text)
          .join('\n');
      }
      return '';
    })
    .filter(s => s.length > 0)
    .join('\n\n');
}

/**
 * Spawn `claude -p ...` and collect stdout. Rejects on non-zero exit, process
 * error, AbortSignal abort, or `timeoutMs` elapsed. The timeout is a hard
 * upper bound — when it fires, the child is killed with SIGTERM (followed
 * by SIGKILL if it doesn't exit within 2s).
 *
 * On Windows, `shell: true` is required to resolve `.cmd`/`.bat` wrappers
 * (`claude.cmd` is the standard install). Args are still passed as an array;
 * the prompt content is sent via stdin to avoid shell-escaping arbitrary
 * user text. The remaining args (`--model`, `--system-prompt` values) are
 * controlled by application code, not external input.
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {AbortSignal|undefined} signal - Aborting kills the child with SIGTERM.
 * @param {string} stdinPayload - Prompt content piped to the child's stdin.
 * @param {number} timeoutMs - Hard subprocess timeout in milliseconds.
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
function runClaudeCli(bin, args, signal, stdinPayload = '', timeoutMs = DEFAULT_CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error(`[anthropic-client] aborted before spawn`));
      return;
    }

    let proc;
    try {
      if (process.platform === 'win32') {
        // shell:true is required to resolve claude.cmd (the standard install
        // on Windows). Node does not auto-quote args under shell:true, so we
        // must quote any arg containing whitespace or cmd special chars to
        // preserve `--system-prompt "be brief"` as a single argv entry.
        const quotedBin = quoteWinArg(bin);
        const quotedArgs = args.map(quoteWinArg);
        proc = spawn(quotedBin, quotedArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: true,
          windowsVerbatimArguments: true,
        });
      } else {
        proc = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      }
    } catch (err) {
      reject(new Error(`[anthropic-client] failed to spawn '${bin}': ${err.message}`));
      return;
    }

    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;
    let killTimer = null;

    const cleanup = () => {
      if (killTimer) { clearTimeout(killTimer); killTimer = null; }
      if (timeoutHandle) { clearTimeout(timeoutHandle); }
      signal?.removeEventListener('abort', onAbort);
    };

    // killProcessTree: on Windows + shell:true, `proc.kill()` terminates only
    // the cmd.exe shell, leaving the spawned `claude` (or test fake) running
    // orphaned. Use taskkill /T to kill the whole process tree. On POSIX,
    // node's signal-based kill is sufficient.
    const killProcessTree = (signal) => {
      if (!proc.pid) return;
      if (process.platform === 'win32') {
        try {
          spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
            stdio: 'ignore',
            windowsHide: true,
          });
        } catch { /* best-effort */ }
      } else {
        try { proc.kill(signal); } catch { /* best-effort */ }
      }
    };

    const onAbort = () => {
      aborted = true;
      killProcessTree('SIGTERM');
      // Force-kill if the child doesn't exit cleanly (POSIX only — taskkill /F
      // is already a hard kill on Windows).
      if (process.platform !== 'win32') {
        killTimer = setTimeout(() => killProcessTree('SIGKILL'), 2000);
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutHandle = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          killProcessTree('SIGTERM');
          if (process.platform !== 'win32') {
            killTimer = setTimeout(() => killProcessTree('SIGKILL'), 2000);
          }
        }, timeoutMs)
      : null;

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      cleanup();
      reject(new Error(`[anthropic-client] spawn error for '${bin}': ${err.message}`));
    });
    proc.on('close', code => {
      cleanup();
      if (timedOut) {
        reject(new Error(
          `[anthropic-client] '${bin}' timed out after ${timeoutMs}ms`,
        ));
        return;
      }
      if (aborted) {
        reject(new Error(`[anthropic-client] aborted`));
        return;
      }
      if (code !== 0) {
        reject(new Error(
          `[anthropic-client] '${bin}' exited ${code}: ${(stderr || stdout).slice(0, 500)}`,
        ));
        return;
      }
      resolve({ stdout, stderr });
    });

    // Swallow stdin EPIPE if the child exits without consuming stdin.
    proc.stdin.on('error', () => {});

    // Write the prompt to stdin and close it so the child exits.
    if (stdinPayload) proc.stdin.write(stdinPayload);
    proc.stdin.end();
  });
}

/**
 * Parse the JSON envelope produced by `claude -p --output-format json` and
 * reshape it into the raw-SDK response shape.
 *
 * Expected input fields (per Claude Code docs, stable as of v1.x):
 *   - `result`: final assistant text
 *   - `usage.input_tokens`, `usage.output_tokens`: token counts
 *   - `total_cost_usd`, `duration_ms`, `num_turns`: surfaced via _meta
 *
 * @param {string} stdout
 * @param {string|undefined} requestedModel
 * @returns {{
 *   content: [{type: 'text', text: string}],
 *   usage: {input_tokens: number, output_tokens: number},
 *   model: string|undefined,
 *   stop_reason: string,
 *   _meta: object
 * }}
 */
/**
 * Parse + validate `claude -p --output-format json` stdout. Throws on malformed
 * JSON, non-object root, schema mismatch, or `is_error: true` envelopes.
 *
 * The returned `_meta` field is the **cli backend's extension** of the SDK
 * response shape — it surfaces metrics (cost, duration, turn count) the raw
 * SDK doesn't include. It is documented and stable; the `sdk` backend
 * does not populate it.
 *
 * @param {string} stdout
 * @param {string|undefined} requestedModel
 * @returns {{
 *   content: [{type: 'text', text: string}],
 *   usage: {input_tokens: number, output_tokens: number},
 *   model: string|undefined,
 *   stop_reason: string,
 *   _meta: {cost_usd?: number, duration_ms?: number, num_turns?: number}
 * }}
 */
function normaliseCliOutput(stdout, requestedModel) {
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (err) {
    throw new Error(
      `[anthropic-client] failed to parse claude -p JSON output: ${err.message}. ` +
      `First 300 chars of stdout: ${stdout.slice(0, 300)}`,
    );
  }

  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error(
      `[anthropic-client] claude -p output is not a JSON object: ${stdout.slice(0, 200)}`,
    );
  }

  // Error envelope: surface as throw so callers don't have to inspect a
  // success shape and then check is_error.
  if (json.is_error === true) {
    const errParse = ClaudeCliErrorEnvelope.safeParse(json);
    const detail = errParse.success ? (errParse.data.result || '(no detail)') : '(malformed error envelope)';
    throw new Error(`[anthropic-client] claude -p reported error: ${detail}`);
  }

  const parsed = ClaudeCliEnvelope.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `[anthropic-client] claude -p output failed schema validation: ` +
      `${parsed.error.message}. First 200 chars: ${stdout.slice(0, 200)}`,
    );
  }
  const data = parsed.data;

  return {
    content: [{ type: 'text', text: data.result }],
    usage: {
      input_tokens: Number(data.usage?.input_tokens) || 0,
      output_tokens: Number(data.usage?.output_tokens) || 0,
    },
    model: requestedModel || data.model,
    stop_reason: 'end_turn',
    _meta: {
      cost_usd: data.total_cost_usd,
      duration_ms: data.duration_ms,
      num_turns: data.num_turns,
    },
  };
}

/**
 * Quote an argument safely for Windows cmd.exe + CommandLineToArgvW round-trip.
 *
 * **Why `""` instead of `\"`**: cmd.exe parses quotes naively — it does NOT
 * treat `\"` as an escape. A value like `foo " & whoami` quoted as
 * `"foo \" & whoami"` would close the quoted span at the un-escaped `"`,
 * leaving `& whoami` to be evaluated by the shell (command injection).
 * The doubled-quote form `""` is interpreted as a literal `"` by BOTH
 * cmd.exe AND CommandLineToArgvW (the latter accepts it as an officially
 * documented alternate to `\"`).
 *
 * With `""` as the quote-escape, backslashes are always literal inside
 * the quoted span — no special handling needed.
 *
 * We additionally pass `windowsVerbatimArguments: true` to `spawn` so
 * Node forwards the args byte-for-byte without re-quoting.
 *
 * Reference: Microsoft "Naming Files, Paths, and Namespaces" + "Parsing
 * C++ command-line arguments" docs; Raymond Chen "Everyone quotes command
 * line arguments the wrong way" (devblogs.microsoft.com).
 *
 * @param {string} arg
 * @returns {string}
 */
function quoteWinArg(arg) {
  const s = String(arg);
  if (s.length === 0) return '""';
  if (!/[\s"&<>|^()%!]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

// ── Exports for tests ───────────────────────────────────────────────────────

export const _internals = {
  buildPromptFromMessages,
  normaliseCliOutput,
  createCliAdapter,
  quoteWinArg,
};
