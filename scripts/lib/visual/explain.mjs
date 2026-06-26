/**
 * @fileoverview Opt-in VLM narrator (plan §2 decision 8, M4/M5). Takes an ALREADY-
 * FOUND deterministic finding and asks the model to translate it into human prose +
 * a likely root-cause category. Creates ZERO findings and NEVER touches the gate.
 *
 * Egress posture (defence-in-depth):
 *   - `--explain` alone → metadata-only prose (the finding's fields); no pixels leave.
 *   - `--explain --allow-external-screenshot` → a tight crop MAY be sent.
 *
 * Model access is a thin consumer of the existing resolver path: sentinels only,
 * structured nothing (free prose), and it DEGRADES TO EMPTY on any LLM failure so
 * the deterministic report is never blocked.
 *
 * @module scripts/lib/visual/explain
 */

/**
 * @param {object} finding
 * @param {object} [opts]
 * @param {boolean} [opts.allowScreenshot] - gate for sending pixels (default false)
 * @param {string|null} [opts.cropPath] - path to a tight crop (only sent if allowScreenshot)
 * @returns {Promise<string>} prose explanation, or '' on any failure/disabled
 */
export async function explainFinding(finding, { allowScreenshot = false, cropPath = null } = {}) {
  if (!finding || typeof finding !== 'object') return '';
  let createAnthropicClient;
  let redactSecrets = (s) => s;
  try { ({ createAnthropicClient } = await import('../anthropic-client.mjs')); }
  catch { return ''; }
  // Egress safety (M4): redact any secret-shaped tokens from the finding metadata
  // before it leaves the machine. Finding fields are paint values, not paths, but
  // rendered `actual` text could carry a leaked token — fail-closed via the shared
  // redactor. Pixels are gated separately by allowScreenshot.
  try { ({ redactSecrets } = await import('../secret-patterns.mjs')); } catch { /* identity */ }

  const model = process.env.CLAUDE_FINAL_REVIEW_MODEL || 'latest-opus';
  const facts = redactSecrets([
    `class: ${finding.class}`,
    `severity: ${finding.severity}`,
    finding.surfaceId ? `surface: ${finding.surfaceId}` : null,
    finding.nodeKey ? `node: ${finding.nodeKey}` : null,
    finding.property ? `property: ${finding.property}` : null,
    finding.expected ? `expected: ${finding.expected}` : null,
    finding.actual ? `actual: ${finding.actual}` : null,
    finding.device || finding.theme ? `state: ${[finding.device, finding.theme].filter(Boolean).join('/')}` : null,
  ].filter(Boolean).join('\n'));

  const content = [{
    type: 'text',
    text: `A deterministic visual-audit check produced this finding. In 2-3 sentences, explain to a developer what it means and the most likely CSS root cause. Do NOT invent values beyond those given.\n\n${facts}`,
  }];

  // Pixels only leave the machine under the explicit second flag.
  if (allowScreenshot && cropPath) {
    try {
      const { readFileSync } = await import('node:fs');
      const b64 = readFileSync(cropPath).toString('base64');
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } });
    } catch { /* crop unavailable → metadata-only */ }
  }

  try {
    const client = await createAnthropicClient();
    const resp = await client.messages.create({
      model,
      max_tokens: 300,
      messages: [{ role: 'user', content }],
    });
    const text = (resp?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text || '';
  } catch {
    return ''; // never block the deterministic report
  }
}
