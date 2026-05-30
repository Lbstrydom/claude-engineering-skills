/**
 * @fileoverview Tests for classifyMitigation (pure status resolution).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyMitigation } from '../scripts/security-memory/incident-status.mjs';

test('manual + file-ref never auto-claim passing', () => {
  assert.equal(classifyMitigation({ mitigation_kind: 'manual', semgrepRunResult: null }).status, 'manual-verification-required');
  assert.equal(classifyMitigation({ mitigation_kind: 'file-ref', semgrepRunResult: null }).status, 'manual-verification-required');
});

test('semgrep not run → manual-verification-required', () => {
  assert.equal(classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: null }).status, 'manual-verification-required');
});

test('semgrep rule missing → mitigation-failing', () => {
  const r = classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: false } });
  assert.equal(r.status, 'mitigation-failing');
  assert.equal(r.status_evidence, 'rule-not-found');
});

test('semgrep binary missing vs tool error are distinguished', () => {
  const binary = classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: true, toolError: false } });
  assert.equal(binary.status_evidence, 'semgrep-binary-not-found');
  const tool = classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: { passed: false, ranSemgrep: false, ruleFileFound: true, toolError: true } });
  assert.equal(tool.status_evidence, 'semgrep-tool-error');
});

test('semgrep passed / failed', () => {
  assert.equal(classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: { passed: true, ranSemgrep: true, ruleFileFound: true } }).status, 'mitigation-passing');
  assert.equal(classifyMitigation({ mitigation_kind: 'semgrep', semgrepRunResult: { passed: false, ranSemgrep: true, ruleFileFound: true } }).status, 'mitigation-failing');
});
