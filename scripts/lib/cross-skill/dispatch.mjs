/**
 * @fileoverview The registry dispatcher — the ONE enforcement point for the
 * five cross-cutting contracts every legacy handler re-implemented by
 * convention (docs/plans/cross-skill-command-registry.md D2/D4/D5).
 *
 * Responsibilities (and deliberate non-responsibilities):
 *   - Per-command flag validation, both directions: an undeclared flag on the
 *     argv exits 2 (`assertKnownFlags` over declared ∪ payload-derived ∪
 *     universal), and a handler cannot READ an undeclared flag
 *     (`ctx.flag('x')` throws UNDECLARED_FLAG) — the two halves of the
 *     accepted-but-inert class (F4/F11/F16, --report-path).
 *   - Positional validation for `positionals:'none'` commands. For
 *     `{verbs}`, unknown verbs flow to the handler whose legacy usage
 *     message is the frozen surface.
 *   - Cloud init: `initLearningStore()` once, before the handler, for
 *     `cloud ≠ 'none'` commands (shadow R1-M2). `ctx.cloud` then carries the
 *     routing gate (`enabled` — the same pool-presence truth legacy used)
 *     plus the ADVISORY classification for envelope honesty.
 *   - Scope helpers bound to the declared policy — but resolution is LAZY
 *     (`ctx.resolveScope()`): legacy handlers resolve scope AFTER their own
 *     input validation and cloud check, and calling the resolver eagerly
 *     would run DB lookups on paths that never did (byte-compat is
 *     per-command ORDER, not just per-command envelope).
 *   - Emission mechanics + the outcome contract: the handler returns the
 *     FULL legacy envelope or throws CommandError; a returned envelope with
 *     `ok !== true` on a non-softFail command is CONTRACT_VIOLATION (audit
 *     R3-M2) — a migrated handler cannot hand-build "ok:true regardless"
 *     (F2/F3/F8/F15/F20) or return a failure-shaped success.
 *
 * dispatch() returns {envelope, exitCode} and NEVER calls process.exit —
 * main() owns the process boundary, tests call dispatch in-process.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertKnownFlags, ArgvError } from '../cli-io.mjs';
import { getCommand, normalizeFlag, payloadFlags, UNIVERSAL_FLAGS } from './registry.mjs';
import { resolveCommandScope } from './scope.mjs';

/** Typed failure a handler throws instead of returning ok:false (plan D5). */
export class CommandError extends Error {
  constructor(code, message, extra = {}, exitCode = 2) {
    super(message);
    this.code = code;
    this.extra = extra;
    this.exitCode = exitCode;
  }
}

// @duplicate-justification: target=scripts/lib/repo-context.mjs:commitSha reason=byte-compat verbatim move of cross-skill.mjs's git helpers; three copies exist only during migration and consolidate when the legacy pair retires in Phase 5 (consolidating now would change repo-context's baseDir contract mid-cluster)
function currentCommitSha() {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

// @duplicate-justification: target=scripts/cross-skill.mjs:currentBranch reason=the legacy copy serves unmigrated handlers and retires with the legacy map in Phase 5; consolidating mid-migration would edit the byte-compat surface for no behaviour gain
function currentBranch() {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch { return null; }
}

/**
 * The legacy parsePayload algorithm VERBATIM (audit R3-H1 — precedence
 * frozen): `--json <inline>` wins, else `--stdin` reads fd 0, else a
 * trailing `{`-prefixed bare arg parses, else `{}`.
 */
function parsePayload(rest) {
  const jsonIdx = rest.indexOf('--json');
  if (jsonIdx >= 0) {
    return JSON.parse(rest[jsonIdx + 1] || '{}');
  }
  const stdinIdx = rest.indexOf('--stdin');
  if (stdinIdx >= 0) {
    const raw = readFileSync(0, 'utf8');
    return raw.trim() ? JSON.parse(raw) : {};
  }
  if (rest.length > 0 && rest[rest.length - 1].startsWith('{')) {
    return JSON.parse(rest[rest.length - 1]);
  }
  return {};
}

/**
 * Bare words on the argv, excluding declared flags' values and (when the
 * payload admits one) the trailing bare-JSON arg.
 */
function findPositionals(rest, decls, payload) {
  const valued = new Set(
    decls.filter((d) => d.kind === 'valued' || d.kind === 'repeatable').map((d) => `--${d.name}`),
  );
  valued.add('--json'); // --json takes a value even though it is payload-derived
  const out = [];
  let terminated = false; // POSIX `--`: everything after is positional
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    // Aligned with assertKnownFlags, which stops validating at `--` (audit
    // CA-r5): treating a post-`--` token as a flag here would mean the
    // validator and the consumer read the same argv differently — the
    // validated-vs-consumed drift this dispatcher exists to kill. NOTE:
    // parsePayload above deliberately does NOT honour `--` — it is the legacy
    // algorithm verbatim (R3-H1 frozen precedence), and legacy scanned the
    // full tail.
    if (!terminated && a === '--') { terminated = true; continue; }
    if (!terminated && a.startsWith('--')) {
      if (valued.has(a)) i += 1; // skip its value
      continue;
    }
    if ((payload === 'json' || payload === 'both') && i === rest.length - 1 && a.startsWith('{')) continue;
    out.push(a);
  }
  return out;
}

/**
 * Dispatch one registry command.
 *
 * @param {string[]} argv - process.argv (full)
 * @param {{deps?: object, cloudGate?: 'ready'|'off', now?: () => Date}} [overrides]
 *   test seams: `deps` replaces the store port; `cloudGate` forces the
 *   routing gate so hermetic tests can reach store paths (audit R3-H2).
 * @returns {Promise<{envelope: object|null, exitCode: number}>}
 */
export async function dispatch(argv, overrides = {}) {
  const [name, ...rest] = argv.slice(2);
  const cmd = getCommand(name);
  if (!cmd) throw new Error(`dispatch() called for a non-registry command "${name}" — route it to the legacy map`);

  // ── Flag validation (both directions start here) ──────────────────────────
  const decls = (cmd.flags ?? []).map(normalizeFlag);
  const allowed = [
    ...decls.map((d) => `--${d.name}`),
    ...payloadFlags(cmd.payload),
    ...UNIVERSAL_FLAGS,
  ];
  try {
    assertKnownFlags(argv, allowed, { cli: `cross-skill.mjs ${name}` });
  } catch (err) {
    if (err instanceof ArgvError) {
      process.stderr.write(`${err.message}\n`);
      return { envelope: null, exitCode: 2 };
    }
    throw err;
  }

  // ── Positional validation ────────────────────────────────────────────────
  const bare = findPositionals(rest, decls, cmd.payload);
  if (cmd.positionals === 'none' && bare.length > 0) {
    return {
      envelope: { ok: false, error: { code: 'BAD_INPUT',
        message: `${name} takes no positional arguments, got: ${bare.join(' ')}` } },
      exitCode: 2,
    };
  }

  // ── Load the handler — a registry name NEVER falls back to legacy ────────
  let handler;
  try {
    handler = await cmd.load();
    if (typeof handler !== 'function') throw new Error(`loader returned ${typeof handler}`);
  } catch (err) {
    return {
      envelope: { ok: false, error: { code: 'REGISTRY_LOAD_FAILED',
        message: `command "${name}" is registered but its handler failed to load: ${err.message}` } },
      exitCode: 1,
    };
  }

  // ── Deps + cloud ─────────────────────────────────────────────────────────
  const deps = overrides.deps
    ?? (await import('./store-port.mjs')).STORE_PORT;

  const cloud = { enabled: false, state: 'off' };
  if (cmd.cloud !== 'none') {
    if (overrides.cloudGate) {
      cloud.enabled = overrides.cloudGate === 'ready';
      cloud.state = overrides.cloudGate;
    } else {
      await deps.initLearningStore();
      cloud.enabled = await deps.isCloudEnabled();
      // Through the PORT, not a direct client-state import (audit CA-r6):
      // the port is the dispatcher's one store seam too, which keeps the
      // advisory classification stubbable with the same {deps} override that
      // stubs everything else.
      cloud.state = deps.getCloudState?.() ?? 'off';
    }
  }

  // ── ctx ──────────────────────────────────────────────────────────────────
  const declared = new Set(decls.map((d) => d.name));
  // Flag reads stop at the POSIX `--` terminator, exactly as assertKnownFlags
  // and findPositionals do (audit CD-r1). Cluster A aligned the positional
  // scanner and left the flag ACCESSORS scanning the whole tail — so the
  // dispatcher's own three readers disagreed about where flags end, which is
  // the validated-vs-consumed drift this dispatcher exists to kill, reproduced
  // inside it. (parsePayload deliberately does NOT honour `--`: it is the
  // legacy algorithm verbatim under the R3-H1 frozen-precedence mandate, and
  // legacy scanned the full tail — that divergence is declared, not accidental.)
  const flagRegion = (() => {
    const stop = rest.indexOf('--');
    return stop < 0 ? rest : rest.slice(0, stop);
  })();
  const flagValue = (n) => {
    const idx = flagRegion.indexOf(`--${n}`);
    return idx < 0 ? null : (flagRegion[idx + 1] ?? null);
  };
  let payloadCache;
  const ctx = {
    // The first bare positional (the sub-verb), NOT the raw argv tail: exposing
    // `rest` would let a handler parse flags around the declaration-checked
    // accessors, quietly reopening the accepted-but-inert class the accessors
    // close (audit CA-r1). A handler that needs more than the verb needs a
    // richer declaration, not a side door.
    verb: bare[0] ?? null,
    cloud,
    deps,
    git: { commitSha: currentCommitSha, branch: currentBranch },
    flag(n) {
      if (!declared.has(n)) {
        throw new CommandError('UNDECLARED_FLAG',
          `handler for "${name}" read --${n}, which its registry entry does not declare — declare it or stop reading it`, {}, 1);
      }
      return flagValue(n);
    },
    hasFlag(n) {
      if (!declared.has(n)) {
        throw new CommandError('UNDECLARED_FLAG',
          `handler for "${name}" read --${n}, which its registry entry does not declare — declare it or stop reading it`, {}, 1);
      }
      return flagRegion.includes(`--${n}`);
    },
    payload() {
      if (cmd.payload === 'none') return {};
      if (payloadCache === undefined) payloadCache = parsePayload(rest);
      return payloadCache;
    },
    /**
     * The canonical cloud-off envelope for this command (registry
     * degradeShape; pinned to the captured legacy fixture by the goldens).
     * When the ADVISORY classification says the configured store is
     * unreachable, the additive `degraded` hint rides along (plan D4).
     */
    degrade() {
      const env = { ok: true, cloud: false, ...(cmd.degradeShape ?? {}) };
      if (cloud.state === 'unreachable') env.degraded = 'store-unreachable';
      return env;
    },
    /**
     * Resolve this command's declared scope policy. LAZY — call it where the
     * legacy handler resolved scope, so DB lookups keep their legacy order.
     * Applies the D3 dispatch table: error kinds become thrown CommandError
     * (fail closed) except where the policy admits pass-through.
     */
    async resolveScope(inputOverrides = {}) {
      const p = cmd.payload === 'none' ? {} : ctx.payload();
      const input = {
        explicitRepoId: (declared.has('repo-id') ? flagValue('repo-id') : null) ?? p.repoId ?? null,
        explicitRepoUuid: p.repoUuid ?? null,
        explicitRepoName: (declared.has('repo') ? flagValue('repo') : null) ?? null,
        allRepos: declared.has('all-repos') ? rest.includes('--all-repos') : false,
        ...inputOverrides,
      };
      const scope = await resolveCommandScope(cmd.scope, input, deps);
      if (scope.kind === 'error') {
        throw new CommandError(scope.code, scope.message, {}, scope.exitCode ?? 2);
      }
      return Object.freeze(scope);
    },
  };

  // ── Run + outcome contract ───────────────────────────────────────────────
  try {
    const envelope = await handler(ctx);
    if (envelope === undefined) {
      // A handler that emitted nothing (e.g. wrote a card to stdout) —
      // mirror the legacy `return undefined` → exit 0 contract.
      return { envelope: null, exitCode: 0 };
    }
    if (!envelope || typeof envelope !== 'object') {
      return {
        envelope: { ok: false, error: { code: 'CONTRACT_VIOLATION',
          message: `handler for "${name}" returned ${typeof envelope} instead of an envelope` } },
        exitCode: 1,
      };
    }
    // softFail is verb-scoped when declared as {verbs:[…]} — a command-wide
    // boolean would exempt every verb from the validator when only one carries
    // the frozen legacy quirk (audit CA-r1).
    const softFailApplies = cmd.softFail === true
      || cmd.softFail?.all === true
      || (Array.isArray(cmd.softFail?.verbs) && cmd.softFail.verbs.includes(bare[0]));
    // An envelope with NO `ok` field at all is a distinct, legitimate shape —
    // `final-review-pending` carries its outcome in `state`
    // (ready|disabled|unavailable) and deliberately exits 0 for all three,
    // because /ship must continue through every one. There is no `ok` to lie
    // with there, so the validator does not apply; but the ABSENCE must be
    // DECLARED (`okless`), or a handler that simply forgot to return `ok`
    // would slip through under the same exemption.
    if (!('ok' in envelope)) {
      if (cmd.okless?.reason) return { envelope, exitCode: 0 };
      return {
        envelope: { ok: false, error: { code: 'CONTRACT_VIOLATION',
          message: `handler for "${name}" returned an envelope with no \`ok\` field — declare \`okless\` with a reason if that is deliberate` } },
        exitCode: 1,
      };
    }
    if (envelope.ok !== true && !softFailApplies) {
      return {
        envelope: { ok: false, error: { code: 'CONTRACT_VIOLATION',
          message: `handler for "${name}" RETURNED a non-ok envelope — failure must travel as CommandError, `
            + 'never as a returned ok:false (that is how five unverified-success bugs were built)' } },
        exitCode: 1,
      };
    }
    return { envelope, exitCode: 0 };
  } catch (err) {
    if (err instanceof CommandError) {
      return {
        envelope: { ok: false, error: { code: err.code, message: err.message, ...err.extra } },
        exitCode: err.exitCode,
      };
    }
    return {
      envelope: { ok: false, error: { code: 'EXCEPTION', message: err.message, stack: err.stack } },
      exitCode: 1,
    };
  }
}
