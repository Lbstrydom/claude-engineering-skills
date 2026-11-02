/**
 * @fileoverview One env-resolution oracle for the doctors, and the shadow warning
 * (Azure work-profile mirror report, 2026-11-02).
 *
 * Two defects, both silent:
 *   1. check-setup parsed `<repo>/.env` alone, so a key the runtime read from the
 *      launch environment or `~/.audit-loop.env` failed setup as "missing" while
 *      every audit authenticated with it.
 *   2. dotenv's `override:false` lets a stale terminal export beat `.env` with no
 *      notice — the mirror ran a 404 Claude deployment that way.
 *
 * Every layer is INJECTED (inherited env, `.env` path, shared path), so no test
 * reads this machine's environment or files. The spawned-CLI case scrubs
 * `AZURE_*` and every credential the parent carries.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { composeEnvLayers, readEnvLayers, sharedLayerPlan } from '../scripts/lib/load-shared-env.mjs';
import {
  formatShadow, isSecretName, isSelectorName, resolveVariable, selectorProvenance,
} from '../scripts/lib/env-provenance.mjs';
import { evaluateAuditSetup, evaluateEnvProvenance, loadEnv } from '../scripts/check-setup.mjs';
import { runAzureDoctor, EXIT, routeShadows, configuredMatch } from '../scripts/azure-doctor.mjs';
import { runRouteDoctor } from '../scripts/lib/azure/route-doctor.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET_INHERITED = 'sk-inherited-SECRET-0123456789';
const SECRET_FILE = 'sk-dotenv-SECRET-9876543210';

let dir;
let envFile;
let sharedFile;
const write = (p, lines) => fs.writeFileSync(p, `${lines.join('\n')}\n`);
const NO_SHARED = () => path.join(dir, 'absent-shared.env');

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-provenance-'));
  envFile = path.join(dir, '.env');
  sharedFile = path.join(dir, 'shared.env');
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('composeEnvLayers — the runtime precedence as a pure function', () => {
  it('launch environment > .env > shared, override:false at every step', () => {
    const { env } = composeEnvLayers({
      inherited: { A: 'inh' }, local: { A: 'loc', B: 'loc' }, shared: { A: 'sh', B: 'sh', C: 'sh' },
    });
    assert.deepEqual([env.A, env.B, env.C], ['inh', 'loc', 'sh']);
  });

  it('the DB group is one bundle: an explicitly EMPTY DSN (the air-gap signal) takes none of the shared DB keys', () => {
    const shared = { AUDIT_DB_URL: 'postgresql://shared', AUDIT_DB_SSL_MODE: 'no-verify', OTHER: 'x' };
    const { env } = composeEnvLayers({ inherited: { AUDIT_DB_URL: '' }, local: {}, shared });
    assert.equal(env.AUDIT_DB_URL, '', 'the air gap is preserved, never "fixed"');
    assert.equal(env.AUDIT_DB_SSL_MODE, undefined, 'no half bundle');
    assert.equal(env.OTHER, 'x');
    // Same rule, same function, as the runtime loader.
    assert.deepEqual(sharedLayerPlan(shared, { AUDIT_DB_URL: '' }).contributed, ['OTHER']);
  });

  it('readEnvLayers does not even READ a disabled shared layer, so it is neither a source nor a shadow', () => {
    write(sharedFile, ['OPENAI_AUDIT_MODEL=from-shared']);
    write(envFile, ['OPENAI_AUDIT_MODEL=from-env']);
    const { layers } = readEnvLayers(dir, { inherited: { AUDIT_LOOP_DISABLE_SHARED: '1' }, localEnvPath: envFile, sharedPath: sharedFile });
    assert.deepEqual(layers.shared, {});
    assert.equal(formatShadow(resolveVariable('OPENAI_AUDIT_MODEL', layers)), null);
  });

  it('AUDIT_LOOP_DISABLE_SHARED=1 in .env switches the shared layer off, as the runtime reads it after .env', () => {
    const { env, sharedContributed } = composeEnvLayers({ inherited: {}, local: { AUDIT_LOOP_DISABLE_SHARED: '1' }, shared: { K: 'v' } });
    assert.equal(env.K, undefined);
    assert.deepEqual(sharedContributed, []);
  });
});

describe('check-setup asks the SAME chain the runtime uses (the false-missing case)', () => {
  const azureOnly = { AZURE_OPENAI_ENDPOINT: 'https://corp.openai.azure.com' };
  const keysMissing = (r) => r.items.some((i) => /AZURE_OPENAI_API_KEY missing/.test(i.label));

  it('a key in the LAUNCH ENVIRONMENT only is found, where the old .env-only parser reported it missing', () => {
    write(envFile, ['AZURE_OPENAI_ENDPOINT=https://corp.openai.azure.com']);
    const env = loadEnv(dir, { inherited: { AZURE_OPENAI_API_KEY: SECRET_INHERITED }, localEnvPath: envFile, sharedPath: NO_SHARED() });
    const r = evaluateAuditSetup(env, dir, { sharedPath: NO_SHARED() });
    assert.equal(keysMissing(r), false, JSON.stringify(r.items));
    assert.ok(r.items.some((i) => i.label === 'Azure work profile' && i.status === 'PASS'));
  });

  it('a key in ~/.audit-loop.env only is found', () => {
    write(envFile, ['AZURE_OPENAI_ENDPOINT=https://corp.openai.azure.com']);
    write(sharedFile, [`AZURE_OPENAI_API_KEY=${SECRET_FILE}`]);
    const env = loadEnv(dir, { inherited: {}, localEnvPath: envFile, sharedPath: sharedFile });
    assert.equal(keysMissing(evaluateAuditSetup(env, dir, { sharedPath: sharedFile })), false);
  });

  it('NEGATIVE CONTROL: absent from every layer still fails — the probe can report absence', () => {
    write(envFile, ['AZURE_OPENAI_ENDPOINT=https://corp.openai.azure.com']);
    const env = loadEnv(dir, { inherited: { ...azureOnly }, localEnvPath: envFile, sharedPath: NO_SHARED() });
    const r = evaluateAuditSetup(env, dir, { sharedPath: NO_SHARED() });
    assert.equal(keysMissing(r), true);
    assert.ok(r.failures >= 1);
  });

  it('loadEnv never writes process.env (several repos can be checked in one process)', () => {
    write(envFile, ['ENV_PROVENANCE_PROBE_ONLY_IN_FILE=1']);
    loadEnv(dir, { inherited: {}, localEnvPath: envFile, sharedPath: NO_SHARED() });
    assert.equal(process.env.ENV_PROVENANCE_PROBE_ONLY_IN_FILE, undefined);
  });
});

describe('selector provenance + shadow warning', () => {
  const layersFor = (inherited, fileLines) => {
    write(envFile, fileLines);
    return readEnvLayers(dir, { inherited, localEnvPath: envFile, sharedPath: NO_SHARED() });
  };

  it('a launch-environment value that DIFFERS from .env warns, naming the variable, both layers and both values', () => {
    const composed = layersFor(
      { AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-5' },
      ['AZURE_FOUNDRY_CLAUDE_DEPLOYMENT=claude-opus-5-5'],
    );
    const v = resolveVariable('AZURE_FOUNDRY_CLAUDE_DEPLOYMENT', composed.layers);
    assert.equal(v.value, 'claude-opus-5');
    assert.equal(v.source, 'inherited');
    const line = formatShadow(v);
    assert.match(line, /AZURE_FOUNDRY_CLAUDE_DEPLOYMENT/);
    assert.match(line, /launch environment value "claude-opus-5"/);
    assert.match(line, /\.env says "claude-opus-5-5"/);

    const r = evaluateEnvProvenance(null, dir, { inherited: { AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-5' }, localEnvPath: envFile, sharedPath: NO_SHARED() });
    assert.equal(r.warnings, 1);
    const warn = r.items.find((i) => i.status === 'WARN');
    assert.match(warn.fix, /restart the editor/);
  });

  it('an EQUAL launch-environment value does not warn; it wins by precedence and the equal file is named beside it', () => {
    const composed = layersFor({ OPENAI_AUDIT_MODEL: 'gpt-6.1-terra' }, ['OPENAI_AUDIT_MODEL=gpt-6.1-terra']);
    const v = resolveVariable('OPENAI_AUDIT_MODEL', composed.layers);
    assert.equal(v.source, 'inherited');
    assert.deepEqual(v.equalTo, ['local']);
    assert.equal(formatShadow(v), null);
    assert.equal(configuredMatch(v).matches, true, 'equal to .env is the configured value');
    const r = evaluateEnvProvenance(null, dir, { inherited: { OPENAI_AUDIT_MODEL: 'gpt-6.1-terra' }, localEnvPath: envFile, sharedPath: NO_SHARED() });
    assert.equal(r.warnings, 0);
    assert.ok(r.items.some((i) => i.status === 'PASS' && i.label === 'OPENAI_AUDIT_MODEL = gpt-6.1-terra' && /^from launch environment, same value as \.env \(possibly loaded from it by a parent process/.test(i.detail)));
  });

  it('.env over a different shared value also warns (every higher-over-lower difference)', () => {
    write(envFile, ['FINAL_REVIEW_MODEL=a']);
    write(sharedFile, ['FINAL_REVIEW_MODEL=b']);
    const { layers } = readEnvLayers(dir, { inherited: {}, localEnvPath: envFile, sharedPath: sharedFile });
    assert.match(formatShadow(resolveVariable('FINAL_REVIEW_MODEL', layers)), /\.env value "a".*~\/\.audit-loop\.env says "b"/);
    const r = evaluateEnvProvenance(null, dir, { inherited: {}, localEnvPath: envFile, sharedPath: sharedFile });
    const warn = r.items.find((i) => i.status === 'WARN');
    assert.match(warn.fix, /Remove the line from whichever file/, 'no launch override exists, so the remedy must not claim one');
    assert.doesNotMatch(warn.fix, /restart the editor/);
  });

  it('only selector NAMES are judged: budgets and OS paths are not selectors, and a credential never is', () => {
    for (const n of ['OPENAI_AUDIT_MODEL', 'AZURE_OPENAI_GPT_DEPLOYMENT', 'FINAL_REVIEW_SHADOW_MODEL', 'X_MODEL_ID']) assert.equal(isSelectorName(n), true, n);
    for (const n of ['AUDIT_MODEL_SHADOW_BUDGET_EUR', 'PAI_MODEL_DIR', 'AZURE_DEPLOYMENT_KEY', 'MODEL_API_TOKEN']) assert.equal(isSelectorName(n), false, n);
    assert.equal(isSecretName('AZURE_OPENAI_API_KEY'), true);
  });

  it('NO secret value appears anywhere in the output, even when the key differs across layers', () => {
    write(envFile, [`AZURE_OPENAI_API_KEY=${SECRET_FILE}`, `OPENAI_API_KEY=${SECRET_FILE}`, `AZURE_DEPLOYMENT_KEY=${SECRET_FILE}`]);
    const inherited = { AZURE_OPENAI_API_KEY: SECRET_INHERITED, AZURE_DEPLOYMENT_KEY: SECRET_INHERITED, OPENAI_AUDIT_MODEL: 'm1' };
    const r = evaluateEnvProvenance(null, dir, { inherited, localEnvPath: envFile, sharedPath: NO_SHARED() });
    const text = JSON.stringify(r);
    for (const secret of [SECRET_INHERITED, SECRET_FILE, 'SECRET']) assert.ok(!text.includes(secret), text);
    assert.ok(r.items.some((i) => i.label === 'AZURE_OPENAI_API_KEY present' && i.detail === 'from launch environment'), 'presence and layer only');
    const sel = JSON.stringify(selectorProvenance(readEnvLayers(dir, { inherited, localEnvPath: envFile, sharedPath: NO_SHARED() }).layers));
    assert.ok(!sel.includes('SECRET'));
  });
});

describe('azure:doctor separates "answers" from "is the configured one"', () => {
  const ACTIVE = Object.freeze({ active: true, claudeDeployment: 'claude-opus-5' });
  const verified = (name) => ({ status: 'verified', selected: name, catalogSource: 'catalog', probed: [{ name, outcome: 'verified' }] });
  const deps = (provenance, json = false) => {
    const lines = [];
    return {
      lines,
      json,
      d: {
        azure: ACTIVE, client: {}, select: async () => verified('claude-opus-5'), isTTY: false, prompt: async () => 'n',
        readEnvFile: () => '', writeEnvFile: () => {}, envPath: '/repo/.env', out: (s) => lines.push(s), provenance,
      },
    };
  };
  const shadowed = { name: 'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT', value: 'claude-opus-5', source: 'inherited', shadowed: [{ source: 'local', value: 'claude-opus-5-5' }], equalTo: [] };

  it('a shadowed deployment that ANSWERS is not healthy: two lines, exit SHADOWED', async () => {
    const h = deps(shadowed);
    const r = await runAzureDoctor({ target: 'claude' }, h.d);
    const out = h.lines.join('\n');
    assert.equal(r.exitCode, EXIT.SHADOWED);
    assert.match(out, /Effective deployment "claude-opus-5" answers/);
    assert.match(out, /not the configured deployment.*\.env says "claude-opus-5-5"/);
    assert.doesNotMatch(out, /Nothing to fix/);
  });

  it('--json carries answers and matchesConfigured as separate fields', async () => {
    const h = deps(shadowed);
    const r = await runAzureDoctor({ target: 'claude', json: true }, h.d);
    assert.equal(r.json.answers, true);
    assert.equal(r.json.matchesConfigured, false);
    assert.equal(r.json.configuredSource, 'launch environment');
    assert.equal(r.exitCode, EXIT.SHADOWED);
  });

  it('CONTROL: the same verified deployment, unshadowed, is OK', async () => {
    const h = deps({ name: 'AZURE_FOUNDRY_CLAUDE_DEPLOYMENT', value: 'claude-opus-5', source: 'local', shadowed: [], equalTo: [] });
    const r = await runAzureDoctor({ target: 'claude' }, h.d);
    assert.equal(r.exitCode, EXIT.OK);
    assert.match(h.lines.join('\n'), /Nothing to fix/);
  });

  it('.env winning over ~/.audit-loop.env IS the configuration — not a mismatch', () => {
    const m = configuredMatch({ name: 'AZURE_OPENAI_GPT_DEPLOYMENT', value: 'a', source: 'local', shadowed: [{ source: 'shared', value: 'b' }], equalTo: [] });
    assert.equal(m.matches, true);
    assert.equal(configuredMatch({ name: 'X_DEPLOYMENT', value: 'a', source: 'inherited', shadowed: [], equalTo: [] }).matches, null, 'no file names it: nothing to compare');
    // Launch value equal to the SHARED file but different from .env: .env is the configuration, so it is a mismatch.
    assert.equal(configuredMatch({ name: 'X_DEPLOYMENT', value: 'a', source: 'inherited', shadowed: [{ source: 'local', value: 'b' }], equalTo: ['shared'] }).matches, false);
  });

  it('--routes maps each shadowed slot to its surface; only a PROBED surface carries it, in JSON too', async () => {
    const shadows = routeShadows({
      inherited: { AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.6-terra', AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-5' },
      local: { AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-6.1-sol', AZURE_OPENAI_EMBED_DEPLOYMENT: 'e', AZURE_FOUNDRY_CLAUDE_DEPLOYMENT: 'claude-opus-5-5' },
      shared: {},
    });
    assert.deepEqual(Object.keys(shadows).sort(), ['claude', 'gpt']);
    assert.match(shadows.gpt, /AZURE_OPENAI_GPT_DEPLOYMENT.*"gpt-5\.6-terra".*\.env says "gpt-6\.1-sol"/);
    // No Claude route on this profile: its shadow must not decide the exit.
    const azure = { active: true, openaiEndpoint: 'https://x.openai.azure.com', gptDeployment: 'gpt-5.6-terra', embedDeployment: 'e', apiKey: 'k', claudeRoute: null };
    const ok = async () => ({});
    const json = [];
    const r = await runRouteDoctor({ json: true }, { azure, probes: { gpt: ok, embed: ok }, out: (s) => json.push(s), shadows, shadowedExit: EXIT.SHADOWED });
    assert.equal(r.exitCode, EXIT.SHADOWED);
    const routes = JSON.parse(json.join('')).routes;
    assert.equal(routes.find((x) => x.surface === 'gpt').shadow, shadows.gpt);
    assert.equal(routes.find((x) => x.surface === 'embed').shadow, null);
    const onlyClaude = await runRouteDoctor({ json: true }, { azure, probes: { gpt: ok, embed: ok }, out: () => {}, shadows: { claude: shadows.claude }, shadowedExit: EXIT.SHADOWED });
    assert.equal(onlyClaude.exitCode, 0, 'an unprobed surface never turns the exit');
  });
});

describe('the spawned CLI: a launch-environment key passes setup (scrubbed env)', () => {
  it('check-setup --repo-path <repo without the key in .env> reports the Azure profile configured and prints no secret', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'env-provenance-cli-'));
    try {
      fs.writeFileSync(path.join(repo, '.env'), 'AZURE_OPENAI_ENDPOINT=https://corp.openai.azure.com\nAZURE_OPENAI_GPT_DEPLOYMENT=gpt-6.1-sol\n');
      const env = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (/^AZURE_|_API_KEY$|^AUDIT_DB_|^AUDIT_POSTGRES_|^GH_TOKEN$|^GITHUB_TOKEN$|^DOTENV_CONFIG_PATH$|^_AUDIT_LOOP/.test(k)) continue;
        env[k] = v;
      }
      Object.assign(env, {
        AZURE_OPENAI_API_KEY: SECRET_INHERITED,
        AZURE_OPENAI_GPT_DEPLOYMENT: 'gpt-5.6-terra',
        AUDIT_LOOP_DISABLE_SHARED: '1',
        AUDIT_DB_URL: '',
      });
      const r = spawnSync(process.execPath, [path.join(REPO, 'scripts', 'check-setup.mjs'), '--repo-path', repo, '--json'],
        { cwd: repo, encoding: 'utf8', env, timeout: 120_000 });
      const out = `${r.stdout}${r.stderr}`;
      for (const secret of [SECRET_INHERITED, 'SECRET']) assert.ok(!out.includes(secret), 'no secret value in any output');
      const report = JSON.parse(r.stdout);
      const items = report.sections.flatMap((s) => s.items);
      assert.ok(!items.some((i) => /AZURE_OPENAI_API_KEY missing/.test(i.label)), out);
      assert.ok(items.some((i) => i.label === 'Azure work profile' && i.status === 'PASS'));
      assert.ok(items.some((i) => i.status === 'WARN' && /AZURE_OPENAI_GPT_DEPLOYMENT/.test(i.label)), 'the shadowed deployment warns');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
