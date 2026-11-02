/**
 * @fileoverview Which layer a model/deployment selector came from, and which
 * lower layer it silently overrode.
 *
 * The runtime layers env as launch environment > `.env` > `~/.audit-loop.env`
 * (`load-shared-env.mjs`, dotenv `override:false`). That precedence is right, and
 * it is silent: a value exported in the terminal (or the editor's own launch
 * environment) beats `.env` with no notice. Reported 2026-11-02 by the Azure
 * work-profile mirror: the terminal still carried
 * `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT=claude-opus-5` (a 404 DeploymentNotFound) and
 * `AZURE_OPENAI_GPT_DEPLOYMENT=gpt-5.6-terra` while `.env` named
 * `claude-opus-5-5` / `gpt-6.1-sol`, and nothing said so.
 *
 * Pure: the caller supplies the layers (`readEnvLayers` in load-shared-env.mjs).
 * Only SELECTOR variables are judged — names ending in MODEL or DEPLOYMENT, whose
 * values are identifiers safe to print. A name that also looks like a credential
 * is never treated as a selector, so no key or secret value can reach a message.
 *
 * @module scripts/lib/env-provenance
 */

/** Human names for the three layers, in precedence order. */
export const LAYER_LABELS = Object.freeze({
  inherited: 'launch environment',
  local: '.env',
  shared: '~/.audit-loop.env',
});
const ORDER = ['inherited', 'local', 'shared'];

const SECRET_NAME = /KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|DSN|_URL\b|CONNECTION/i;
// The name ENDS in the selector noun: `OPENAI_AUDIT_MODEL`, `AZURE_FOUNDRY_CLAUDE_DEPLOYMENT`.
// Not `AUDIT_MODEL_SHADOW_BUDGET_EUR` (a budget) nor an OS `*_MODEL_DIR` (a path).
const SELECTOR_NAME = /(?:^|_)(?:MODEL|DEPLOYMENT)S?(?:_ID|_NAME)?$/i;

/** A name whose value may be a credential. Its value is never printed. */
export function isSecretName(name) {
  return SECRET_NAME.test(String(name));
}

/** A model or deployment selector: its value is an identifier and may be shown. */
export function isSelectorName(name) {
  return SELECTOR_NAME.test(String(name)) && !isSecretName(name);
}

/**
 * Where one variable's effective value comes from, and what it shadows.
 *
 * `source` is the layer that WINS, by precedence. Lower layers holding the SAME
 * value are listed in `equalTo`, apart from `shadowed` (lower layers holding a
 * DIFFERENT value): an equal value overrides nothing and never warns, and a
 * launch value equal to `.env` may simply be `.env` loaded by a parent process —
 * which this process cannot tell apart from a shell export, so it says so.
 *
 * @param {string} name
 * @param {{inherited: object, local: object, shared: object}} layers
 * @param {{sharedActive?: boolean}} [opts] - false when the runtime would not read
 *   the shared layer at all (`AUDIT_LOOP_DISABLE_SHARED=1`): it is then neither a
 *   source nor a shadow.
 * @returns {{name: string, value: string|null, source: 'inherited'|'local'|'shared'|'unset',
 *            shadowed: Array<{source: string, value: string}>, equalTo: string[]}}
 */
export function resolveVariable(name, layers, { sharedActive = true } = {}) {
  const present = ORDER
    .filter((source) => sharedActive || source !== 'shared')
    .map((source) => ({ source, value: layers?.[source]?.[name] }))
    .filter(({ value }) => value !== undefined);
  if (present.length === 0) return { name, value: null, source: 'unset', shadowed: [], equalTo: [] };
  const [{ source, value }, ...lower] = present;
  const shadowed = lower.filter((p) => p.value !== value).map(({ source: s, value: v }) => ({ source: s, value: v }));
  const equalTo = lower.filter((p) => p.value === value).map((p) => p.source);
  return { name, value, source, shadowed, equalTo };
}

/**
 * The human label for where a value comes from. A launch value equal to a file
 * says so, because it may be that file loaded by a parent process rather than
 * an override — and it would win silently the day the file changed.
 * @param {ReturnType<typeof resolveVariable>} v
 */
export function sourceLabel(v) {
  const base = LAYER_LABELS[v.source];
  if (!v.equalTo?.length) return base;
  const files = v.equalTo.map((s) => LAYER_LABELS[s]).join(' and ');
  return v.source === 'inherited'
    ? `${base}, same value as ${files} (possibly loaded from it by a parent process; it would win if the file changed)`
    : `${base}, same value as ${files}`;
}

/**
 * Every selector variable in any layer, with its source and shadows.
 * @param {{inherited: object, local: object, shared: object}} layers
 * @param {{sharedActive?: boolean}} [opts]
 */
export function selectorProvenance(layers, opts = {}) {
  const names = new Set();
  for (const source of ORDER) for (const k of Object.keys(layers?.[source] ?? {})) if (isSelectorName(k)) names.add(k);
  return [...names].sort().map((n) => resolveVariable(n, layers, opts)).filter((v) => v.source !== 'unset');
}

/** Remedy for a LAUNCH-ENVIRONMENT override, shared by every surface that reports one. */
export const SHADOW_REMEDY = 'Clear the override from the launch environment (the shell export, or the user/system '
  + 'environment variable), then restart the editor and every terminal so they stop inheriting it.';

/** Remedy for a `.env` value overriding `~/.audit-loop.env` — no launch override is involved. */
export const FILE_SHADOW_REMEDY = 'The repo .env wins over ~/.audit-loop.env. Remove the line from whichever file '
  + 'should not decide it, or make the two agree.';

/** The remedy that matches the layer that won. */
export function shadowRemedy(v) {
  return v?.source === 'inherited' ? SHADOW_REMEDY : FILE_SHADOW_REMEDY;
}

/**
 * The warning for one shadowed selector: the variable, the winning layer and
 * value, and each overridden layer and value. Selectors only — refuses a secret name.
 * @param {ReturnType<typeof resolveVariable>} v
 * @returns {string|null}
 */
export function formatShadow(v) {
  if (!v || v.shadowed.length === 0 || !isSelectorName(v.name)) return null;
  const lost = v.shadowed.map((s) => `${LAYER_LABELS[s.source]} says "${s.value}"`).join(', ');
  return `${v.name}: the ${LAYER_LABELS[v.source]} value "${v.value}" is in effect; ${lost}`;
}

/**
 * Add the provenance findings to a doctor `Report` (lib/doctor/report.mjs): one
 * PASS per selector naming its value and layer, one WARN per selector a
 * higher-precedence layer overrode with a DIFFERENT value. Equal values never
 * warn. Values printed are selector values only (see `isSelectorName`).
 *
 * @param {{pass: Function, warn: Function, info: Function}} report
 * @param {{inherited: object, local: object, shared: object}} layers
 * @param {{sharedActive?: boolean}} [opts]
 * @returns {{shadowed: number, selectors: number}}
 */
export function reportSelectorProvenance(report, layers, opts = {}) {
  const all = selectorProvenance(layers, opts);
  if (all.length === 0) {
    report.info('No model/deployment selector is set', 'every model and deployment uses its built-in default');
    return { shadowed: 0, selectors: 0 };
  }
  let shadowed = 0;
  for (const v of all) {
    const line = formatShadow(v);
    if (line) {
      shadowed += 1;
      report.warn(`${v.name} is overridden by the ${LAYER_LABELS[v.source]}`, line, shadowRemedy(v));
    } else {
      report.pass(`${v.name} = ${v.value}`, `from ${sourceLabel(v)}`);
    }
  }
  return { shadowed, selectors: all.length };
}

/**
 * Where a credential is set, for a PRESENCE line: the layer label, never the
 * value. `null` when no layer sets it.
 * @param {string} name
 * @param {{inherited: object, local: object, shared: object}} layers
 * @param {{sharedActive?: boolean}} [opts]
 */
export function credentialSource(name, layers, opts = {}) {
  const v = resolveVariable(name, layers, opts);
  return v.source === 'unset' || v.value === '' ? null : sourceLabel(v);
}

/** Credentials reported by PRESENCE and layer only — a value is never printed. */
export const PROVENANCE_CREDENTIALS = Object.freeze([
  'AZURE_OPENAI_API_KEY', 'AZURE_AI_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_API_KEY',
]);

/**
 * The check-setup / doctor section body: which layer each credential and
 * model/deployment selector comes from, and a WARN for every selector a higher
 * layer overrides with a different value — dotenv's `override:false` does that
 * silently.
 *
 * @param {{pass: Function, warn: Function, info: Function}} report
 * @param {{env: object, layers: {inherited: object, local: object, shared: object}}} composed - `readEnvLayers`'s result
 */
export function reportEnvProvenance(report, { env, layers }) {
  const opts = { sharedActive: env?.AUDIT_LOOP_DISABLE_SHARED !== '1' };
  for (const name of PROVENANCE_CREDENTIALS) {
    const from = credentialSource(name, layers, opts);
    if (from) report.pass(`${name} present`, `from ${from}`);
  }
  return reportSelectorProvenance(report, layers, opts);
}
