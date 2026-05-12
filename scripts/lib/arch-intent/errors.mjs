/**
 * @fileoverview Architecture-intent typed errors. Shared-lib stays
 * transport-agnostic — these are domain-typed errors. The audit pipeline
 * maps them to LlmError({category:'config'}) at the orchestration layer.
 *
 * @module scripts/lib/arch-intent/errors
 */

export class ArchIntentConfigError extends Error {
  constructor(message, { configFile = null, semantic = false } = {}) {
    super(message);
    this.name = 'ArchIntentConfigError';
    this.configFile = configFile;
    this.semantic = semantic; // true if validation passed shape but failed semantic
  }
}

export class ArchIntentAnalyzerError extends Error {
  constructor(message, { stackKind = null, cause = null } = {}) {
    super(message);
    this.name = 'ArchIntentAnalyzerError';
    this.stackKind = stackKind;
    if (cause) this.cause = cause;
  }
}
