import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

import { loadArchIntentConfig } from '../scripts/lib/arch-intent/load-config.mjs';
import { ArchIntentConfigError } from '../scripts/lib/arch-intent/errors.mjs';

function mkRepo(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-cfg-'));
  fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
  if (contents) {
    fs.writeFileSync(path.join(dir, '.audit-loop/domain-map.json'), JSON.stringify(contents));
  }
  return dir;
}

describe('loadArchIntentConfig', () => {
  it('throws ArchIntentConfigError when domain-map.json missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-empty-'));
    assert.throws(
      () => loadArchIntentConfig(dir),
      (err) => err instanceof ArchIntentConfigError && /not found/.test(err.message)
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('throws on malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-intent-badjson-'));
    fs.mkdirSync(path.join(dir, '.audit-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.audit-loop/domain-map.json'), '{ invalid json');
    assert.throws(
      () => loadArchIntentConfig(dir),
      (err) => err instanceof ArchIntentConfigError && /Invalid JSON/.test(err.message)
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('absent allowedDeps → null (NOT empty {})', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
    });
    const cfg = loadArchIntentConfig(dir);
    assert.equal(cfg.allowedDeps, null);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('explicit null allowedDeps → null', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
      allowedDeps: null,
    });
    const cfg = loadArchIntentConfig(dir);
    assert.equal(cfg.allowedDeps, null);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('empty {} allowedDeps preserved as {}', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
      allowedDeps: {},
    });
    const cfg = loadArchIntentConfig(dir);
    assert.deepEqual(cfg.allowedDeps, {});
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('populated allowedDeps preserved', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/core/**', domain: 'core' }, { pattern: 'src/app/**', domain: 'app' }],
      allowedDeps: { app: ['core'] },
    });
    const cfg = loadArchIntentConfig(dir);
    assert.deepEqual(cfg.allowedDeps, { app: ['core'] });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('throws semantic error on allowedDeps key not in declared domains', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
      allowedDeps: { undeclared: ['app'] },
    });
    assert.throws(
      () => loadArchIntentConfig(dir),
      (err) => err instanceof ArchIntentConfigError && err.semantic === true && /undeclared/.test(err.message)
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('throws semantic error on allowedDeps value not in declared domains', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
      allowedDeps: { app: ['nonsense'] },
    });
    assert.throws(
      () => loadArchIntentConfig(dir),
      (err) => err instanceof ArchIntentConfigError && err.semantic === true && /nonsense/.test(err.message)
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('vendor as target value is always allowed', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'app' }],
      allowedDeps: { app: ['vendor'] },
    });
    const cfg = loadArchIntentConfig(dir); // should not throw
    assert.deepEqual(cfg.allowedDeps, { app: ['vendor'] });
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });

  it('rejects on invalid domain name in rules', () => {
    const dir = mkRepo({
      rules: [{ pattern: 'src/**', domain: 'INVALID-Caps' }],
    });
    assert.throws(
      () => loadArchIntentConfig(dir),
      (err) => err instanceof ArchIntentConfigError
    );
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  });
});
