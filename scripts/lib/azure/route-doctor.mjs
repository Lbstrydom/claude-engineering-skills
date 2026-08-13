/**
 * @fileoverview Azure **route** doctor — "what does each surface actually send,
 * where, and with which credential?"
 *
 * The sibling embedding doctor answers a narrower question (which embedding
 * deployment name exists). This one answers the question the 2026-08-13 consumer
 * incident could not: a Claude 401 and a GPT 404 that named no endpoint, no
 * credential variable and no auth header, and so were diagnosed only by writing
 * a throwaway probe script by hand.
 *
 * Read-only and non-mutating by construction — it has no writer dep at all,
 * unlike `azure-doctor`'s `--fix` path. Every probe is a minimal request against
 * the real route, because a route table derived from config alone would restate
 * our own assumptions; the incident's whole lesson is that the emitted request
 * is the only thing worth believing.
 *
 * **Never prints credential values** — only the SOURCE VARIABLE NAME and length.
 *
 * @module scripts/lib/azure/route-doctor
 */

import { claudeRouteReport, openAiRouteReport, classifyAzureTransportFailure } from '../azure-route-report.mjs';

const G = '\x1b[32m', R = '\x1b[31m', Y = '\x1b[33m', D = '\x1b[2m', X = '\x1b[0m';

/**
 * Run one probe and normalise its outcome. A probe never throws out of here —
 * an unreachable surface is a RESULT, not a crash.
 * @param {() => Promise<any>} probe
 * @returns {Promise<{outcome:'verified'|'failed', status:number|null, code:string|null, detail:string|null}>}
 */
async function runProbe(probe) {
  if (!probe) return { outcome: 'skipped', status: null, code: null, detail: 'no probe wired' };
  try {
    await probe();
    return { outcome: 'verified', status: 200, code: null, detail: null };
  } catch (err) {
    const status = err?.status ?? err?.response?.status ?? null;
    return {
      outcome: 'failed',
      status,
      code: classifyAzureTransportFailure(err),
      // Provider message only — never the request body, never a header value.
      detail: String(err?.error?.error?.message || err?.error?.message || err?.message || '')
        .replace(/\s+/g, ' ').slice(0, 160) || null,
    };
  }
}

function renderRow(r, out) {
  const mark = r.probe.outcome === 'verified' ? `${G}✓${X}` : r.probe.outcome === 'skipped' ? `${D}·${X}` : `${R}✗${X}`;
  out(`  ${mark} ${r.surface.padEnd(7)} ${D}${r.route}${X}`);
  out(`      endpoint   : ${r.endpointOrigin}${r.finalPath}`);
  out(`      model      : ${r.requestedModel}${r.wireDeployment && r.wireDeployment !== r.requestedModel ? ` ${D}(wire deployment: ${r.wireDeployment})${X}` : ''}`);
  if (r.apiVersion) out(`      api-version: ${r.apiVersion}`);
  const shared = r.credentialShared ? ` ${Y}[SHARED across services]${X}` : '';
  out(`      credential : ${r.credentialSource}${r.credentialPresent ? '' : ` ${R}(UNSET)${X}`} via ${r.authMode} header${shared}`);
  if (r.probe.outcome === 'failed') {
    out(`      ${R}${r.probe.code}${X} ${r.probe.status ?? ''} ${D}${r.probe.detail || ''}${X}`);
  }
}

/**
 * Build + probe the route table.
 *
 * @param {{json?: boolean}} options
 * @param {{azure: object, probes: Record<string, (() => Promise<any>)|null>, out: (s:string)=>void}} deps
 * @returns {Promise<{exitCode: number, rows: object[]}>}
 */
export async function runRouteDoctor(options, deps) {
  const { azure, probes = {}, out } = deps;
  if (!azure?.active) {
    const payload = { active: false, routes: [] };
    out(options.json ? JSON.stringify(payload, null, 2)
      : `${Y}Azure work profile inactive${X} (AZURE_OPENAI_ENDPOINT not set) — no Azure routes to report.`);
    return { exitCode: 0, rows: [] };
  }

  const reports = [
    openAiRouteReport('gpt', azure),
    openAiRouteReport('embed', azure),
    claudeRouteReport(azure),
  ].filter(Boolean);

  const rows = [];
  for (const report of reports) {
    rows.push({ ...report, probe: await runProbe(probes[report.surface]) });
  }

  if (options.json) {
    out(JSON.stringify({ active: true, routes: rows }, null, 2));
  } else {
    out(`${G}Azure routes${X} ${D}(credential values are never printed — only their source variable)${X}\n`);
    for (const r of rows) { renderRow(r, out); out(''); }
    const failed = rows.filter((r) => r.probe.outcome === 'failed');
    out(failed.length === 0
      ? `  ${G}All probed routes authenticated.${X}`
      : `  ${R}${failed.length} route(s) failed${X}: ${failed.map((r) => `${r.surface} (${r.probe.code})`).join(', ')}`);
  }

  return { exitCode: rows.some((r) => r.probe.outcome === 'failed') ? 7 : 0, rows };
}
