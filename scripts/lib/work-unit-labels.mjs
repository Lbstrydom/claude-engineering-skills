/**
 * @fileoverview Work-unit LABELS — the one part of work-unit grouping a model
 * is allowed to decide.
 *
 * The split this file exists to hold (see `work-units.mjs` for the other half):
 * **membership is deterministic, the label is presentation.** The unit key is
 * what a caller filters, counts and diffs on, so a model deciding membership
 * would mean "work off unit X" names a different set tomorrow. A label carries
 * no such weight — a bad one costs a re-render.
 *
 * And the label is where a model genuinely earns its place. The deterministic
 * fallback is the canonical row's `category`, which on this repo produced
 * `Coupling concern` for a 9-row unit spanning 6 files — true, and useless as
 * something to point a refactor at. No deterministic normaliser fixes that
 * across a Node repo, a Django repo and a Rails one, which is exactly the
 * multi-repo case this bundle ships into.
 *
 * THREE PROPERTIES, all load-bearing:
 *
 *  1. **Cached on the work-unit KEY**, which is a hash of sorted member ids
 *     (`workUnitKey`). It therefore changes precisely when membership changes —
 *     so a cached label can never describe a unit that has since grown, and an
 *     unchanged unit costs nothing on re-read. Across many repos that is the
 *     difference between one call per changed cluster and one per run.
 *  2. **Degrades, never gates.** No key, no network, a refusal, a malformed
 *     reply → the category fallback stands and `labelSource` says
 *     `category`/`underived`. Same rule as visual-audit's VLM: advisory only.
 *     A backlog reader must not fail because a labeller was unavailable.
 *  3. **Only SUCCESSFUL labels are cached** — mirroring `normalize-intent.mjs`
 *     C10. Caching a fallback would pin a unit to the bad label for the cache
 *     TTL, turning one transient timeout into a persistent regression.
 *
 * @module scripts/lib/work-unit-labels
 */

import { getCached, putCached } from './arch-memory/json-cache.mjs';

const CACHE_REL = '.audit-loop/cache/work-unit-labels.json';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30d; the key invalidates on change

/**
 * Bumped by hand when the PROMPT changes. Part of the cache key, so a reworded
 * prompt cannot serve labels written under the old one — the same mechanical
 * invalidation `normalize-intent.mjs` uses.
 */
export const LABEL_PROMPT_VERSION = 2;

/** Labels longer than this are truncated — a work-unit name, not a summary. */
const MAX_LABEL_CHARS = 72;

const SYSTEM = [
  'You name clusters of related code-audit findings so an engineer can point one',
  'refactor at the whole cluster.',
  '',
  'Reply with ONLY the name. Plain text: no preamble, no quotes, no backticks,',
  'no markdown emphasis, no trailing period. Do not restate the task.',
  'Write 3-8 words naming the SHARED DEFECT and, where it helps, the layer it',
  'lives in — e.g. "store writes that collapse failures into absence".',
  'Prefer the concrete shared mechanism over a generic category word.',
  'Never name a single file; the cluster spans several.',
].join('\n');

/** The evidence a labeller sees. Bounded — this is a naming task, not a review. */
function buildPrompt(unit) {
  const members = unit.members ?? [];
  const details = members.slice(0, 6).map((m, i) => {
    const detail = String(m.detail || m.detail_snapshot || m.category || '').replace(/\s+/g, ' ').slice(0, 220);
    return `${i + 1}. [${m.category || 'uncategorised'}] ${m.primaryFile || '?'} — ${detail}`;
  }).join('\n');
  return [
    `${members.length} findings share a cluster. Files: ${(unit.files || []).slice(0, 8).join(', ')}`,
    '',
    details,
    '',
    'Name this cluster.',
  ].join('\n');
}

/**
 * First non-empty line, peeled of every wrapper a chat model adds.
 *
 * Written against REAL observed output, not imagined output. The first version
 * stripped a single leading bullet char and edge quotes, and the live run
 * produced labels like ``*`orchestrator-bloat-and-store-layer-coupling`**`` and
 * `*Cluster name: `swallowed-errors-in-audit-input-pipeline`**` — markdown
 * emphasis, backticks and a restated preamble, all surviving. Wrappers NEST, so
 * one pass in a fixed order cannot remove them; this peels repeatedly until the
 * string stops shrinking.
 */
export function sanitizeLabel(raw) {
  let s = String(raw ?? '').split('\n').map((x) => x.trim()).find(Boolean) || '';
  // A model told to answer with only a name still sometimes restates the task.
  s = s.replace(/^\W*(?:the\s+)?(?:cluster\s+)?name\s*[:—-]\s*/i, '');
  // Emphasis and backticks are stripped GLOBALLY, not just at the edges. Peeling
  // edges alone left `subprocess-error-loss`** — *Git/subprocess failures…`
  // intact on a live run: the model answered "**`name`** — *gloss*", so the
  // wrappers sat mid-string and edge-peeling stopped at the first word
  // character. Neither `*` nor a backtick is ever legitimate in a work-unit
  // name, so removing them everywhere is a rule rather than a heuristic.
  // `_` is deliberately kept — snake_case names are legitimate.
  s = s.replace(/[*`]/g, '');
  let prev;
  do {
    prev = s;
    s = s.trim()
      .replace(/^[-*•>#\s]+/, '')       // bullets, emphasis, blockquote, heading
      .replace(/[*_\s]+$/, '')          // trailing emphasis
      .replace(/^["'`]+|["'`]+$/g, '')  // quotes + backticks at either edge
      .replace(/[.]+$/, '')             // trailing full stops
      .trim();
  } while (s !== prev && s.length > 0);
  if (!s) return null;
  return s.length > MAX_LABEL_CHARS ? `${s.slice(0, MAX_LABEL_CHARS - 1).trimEnd()}…` : s;
}

/**
 * Label the given work units, in place-ish (returns new objects).
 *
 * @param {Array<object>} units - from `clusterWorkUnits`
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] - cache location root (default cwd)
 * @param {(unit: object) => Promise<string|null>} [opts.labeller] - injected for
 *   tests; defaults to a small Claude call
 * @param {boolean} [opts.enabled] - force off (e.g. `--no-llm-labels`)
 * @returns {Promise<{units: Array<object>, labelled: number, cached: number, failed: number, reason: string|null}>}
 */
export async function labelWorkUnits(units, opts = {}) {
  const out = { units, labelled: 0, cached: 0, failed: 0, reason: null };
  if (!Array.isArray(units) || units.length === 0) return out;
  if (opts.enabled === false) return { ...out, reason: 'disabled' };

  const labeller = opts.labeller || await defaultLabeller();
  if (!labeller) return { ...out, reason: 'labeller-unavailable' };

  const { join } = await import('node:path');
  const cacheFile = join(opts.repoRoot || process.cwd(), CACHE_REL);

  const relabelled = await Promise.all(units.map(async (u) => {
    // Singletons keep their category: their `detail` IS the description, and a
    // model call per singleton would be most of the spend for none of the value.
    if (u.size < 2) return u;
    const cacheKey = `v${LABEL_PROMPT_VERSION}:${u.key}`;
    try {
      const hit = getCached(cacheFile, cacheKey, CACHE_TTL_MS);
      if (hit) { out.cached++; return { ...u, label: hit, labelSource: 'llm-cached' }; }
      const raw = await labeller(u);
      const label = sanitizeLabel(raw);
      if (!label) { out.failed++; return { ...u, labelSource: 'underived' }; }
      putCached(cacheFile, cacheKey, label, CACHE_TTL_MS);   // successes only (C10)
      out.labelled++;
      return { ...u, label, labelSource: 'llm' };
    } catch {
      // Advisory: the category fallback stands, and the caller is told via
      // labelSource that this unit's name was not derived.
      out.failed++;
      return { ...u, labelSource: 'underived' };
    }
  }));

  return { ...out, units: relabelled };
}

/**
 * The default labeller — one small Claude call per unit.
 *
 * Returns null (not a throwing stub) when Claude is unavailable, so the caller
 * degrades to the category fallback rather than surfacing a transport error out
 * of a backlog listing. Availability is `isClaudeAvailable()`, NOT an
 * `ANTHROPIC_API_KEY` env check — the cli backend authenticates through the
 * `claude` CLI and needs no key, so a raw env test would silently skip a fully
 * working backend (AGENTS.md, Anthropic Backend Routing).
 */
async function defaultLabeller() {
  try {
    const { createAnthropicClient, isClaudeAvailable } = await import('./anthropic-client.mjs');
    if (typeof isClaudeAvailable === 'function' && !(await isClaudeAvailable())) return null;
    const { resolveModel } = await import('./model-resolver.mjs');
    const model = resolveModel(process.env.WORK_UNIT_LABEL_MODEL || 'latest-haiku');
    const client = await createAnthropicClient();
    return async (unit) => {
      const res = await client.messages.create({
        model,
        max_tokens: 64,
        system: SYSTEM,
        messages: [{ role: 'user', content: buildPrompt(unit) }],
      });
      return res?.content?.[0]?.text ?? null;
    };
  } catch {
    return null;
  }
}

export const _internals = { buildPrompt, SYSTEM, CACHE_REL, CACHE_TTL_MS, MAX_LABEL_CHARS };
