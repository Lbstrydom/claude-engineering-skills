/**
 * @fileoverview Cold-pass support extracted from scripts/solo-control-audit.mjs (an over-1000-line file that may not grow):
 * free-JSON clamping/parsing and the per-recipient reasoning-effort tables.
 * @module scripts/lib/solo-control/cold-pass-support
 */

/** Clamp verbose free-JSON string fields to the ShadowPassSchema/ProducerFinding
 * caps so a valid-but-too-long finding is KEPT (truncated), not dropped. The arms
 * conform natively (enforced structured output); `claude -p` writes free JSON and
 * routinely exceeds detail(600)/summary(1000). Same principle as gemini-review's
 * truncateToSchema — a real finding shouldn't be discarded over prose length. */
export const FIELD_CAPS = { id: 10, category: 80, section: 120, detail: 600, risk: 500, recommendation: 600, principle: 150 };
/** Truncate at a WORD boundary within the cap (not mid-word) and mark it with an
 * ellipsis, so the rare overflow reads as clearly-cut, never severed mid-word. The
 * PROMPT already tells the model to write within budget (matching the arms), so this
 * fires rarely — it's a safety net, not the routine path. */
export function clampField(s, cap) {
  if (typeof s !== 'string' || s.length <= cap) return s;
  const head = s.slice(0, cap - 1);
  const lastSpace = head.lastIndexOf(' ');
  return (lastSpace > cap * 0.6 ? head.slice(0, lastSpace) : head).replace(/[\s.,;:]+$/, '') + '…';
}
export function clampToSchema(parsed) {
  if (!parsed || typeof parsed !== 'object') return parsed;
  if (typeof parsed.summary === 'string') parsed.summary = clampField(parsed.summary, 1000);
  if (Array.isArray(parsed.findings)) {
    for (const f of parsed.findings) {
      if (!f || typeof f !== 'object') continue;
      for (const [k, cap] of Object.entries(FIELD_CAPS)) f[k] = clampField(f[k], cap);
      if (f.classification) f.classification.sourceName = clampField(f.classification.sourceName, 64);
    }
  }
  return parsed;
}

export function parseJsonLoose(text) {
  if (!text) return null;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try { return JSON.parse(t); } catch { return null; }
}

/**
 * Reasoning-effort tiers per recipient, verified against each vendor's docs
 * 2026-09-21. The tables are deliberately NOT unified: DeepSeek silently
 * aliases `xhigh` → `high` and `medium` → `high`, so passing an Anthropic tier
 * through would record one effort in the manifest and run another. A tier
 * not in the recipient's table is refused at the CLI, never remapped.
 *
 * - anthropic: `output_config.effort`; `high` is the API default (identical to
 *   omitting it); `max` is documented to overthink structured output, so
 *   `xhigh` is the above-default tier exp-5 uses.
 * - deepseek: `thinking.reasoning_effort`; thinking is ON by default at `high`;
 *   `max` is the only above-default tier. Thinking mode IGNORES `temperature`.
 *
 * `maxTokens` is the vendor-documented ceiling that thinking shares with the
 * answer — raising effort without raising it truncates the chain of thought
 * and reads as a conformance miss, an instrument artifact the experiment
 * would then mis-score as "the model found less".
 */
export const REASONING_TIERS = Object.freeze({
  anthropic: Object.freeze({ low: 8000, medium: 8000, high: 8000, xhigh: 64000, max: 64000 }),
  deepseek: Object.freeze({ low: 65536, high: 65536, max: 131072 }),
  // Responses API `reasoning.effort`; `max_output_tokens` INCLUDES reasoning
  // tokens, so it scales with the tier. Only the tiers the production pipeline
  // already uses (PASS_REASONING) — an `xhigh` exists on some newer OpenAI
  // models but is not verified for gpt-5.6, so it is refused, not guessed.
  openai: Object.freeze({ low: 8000, medium: 16000, high: 32000 }),
});
export function assertReasoningTier(recipient, tier) {
  if (tier == null) return null;
  const table = REASONING_TIERS[recipient];
  if (!table) throw new Error(`--reasoning-effort is not supported for recipient "${recipient}"`);
  if (!Object.hasOwn(table, tier)) {
    throw new Error(`--reasoning-effort "${tier}" is not a ${recipient} tier (valid: ${Object.keys(table).join('|')}) — refusing rather than letting the provider silently remap it`);
  }
  return tier;
}
