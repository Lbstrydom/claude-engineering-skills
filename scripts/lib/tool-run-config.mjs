/**
 * @fileoverview Tool pre-pass runtime config — the PROJECT-scoped tools (today: `dotnet build` / `dotnet format`).
 *
 * Parsed ONCE, here, never inline in `linter.mjs`; a sibling of `config.mjs` (which is already over the size limit and may not
 * grow) that uses the same `clampConfigNumber` validation and warning style.
 *
 *   AUDIT_TOOLS_DEADLINE_MS  audit-wide wall-clock budget for the PROJECT-scoped tools; every process gets
 *                            min(its own timeout, what is left of it). Positive integer, clamped to [10s, 60min].
 *   AUDIT_DOTNET_RESTORE     opt IN to NuGet restore during the dotnet tools. Exactly `1` or `true`; anything else that is
 *                            set warns and means false, because this is the switch that lets the audit touch the network
 *                            and a typo must never turn it on.
 *
 * The effective values are recorded in a result's `_coverage.toolPolicy`.
 *
 * @module scripts/lib/tool-run-config
 */

import { clampConfigNumber } from './config.mjs';

/**
 * @param {Record<string, string|undefined>} [env]
 * @returns {{deadlineMs: number, restore: boolean}}
 */
export function resolveToolRunConfig(env = process.env) {
  const deadlineMs = clampConfigNumber(env.AUDIT_TOOLS_DEADLINE_MS, {
    fallback: 900_000, min: 10_000, max: 3_600_000, parser: Number.parseInt, envVar: 'AUDIT_TOOLS_DEADLINE_MS',
  });
  const rawRestore = env.AUDIT_DOTNET_RESTORE;
  let restore = false;
  if (rawRestore != null && String(rawRestore).trim() !== '') {
    const v = String(rawRestore).trim().toLowerCase();
    if (v === '1' || v === 'true') restore = true;
    else process.stderr.write(`  [config] WARNING: AUDIT_DOTNET_RESTORE="${rawRestore}" is not exactly 1 or true — NuGet restore stays OFF\n`);
  }
  return { deadlineMs, restore };
}

export const toolRunConfig = Object.freeze(resolveToolRunConfig());
