/**
 * @fileoverview The audit passes with no model of their own (or none worth shadowing). One list, in a shared-lib module so
 * both the model-A/B shadow (`audit-shadow.mjs`, which re-exports it as `MECHANICAL_WAVES` -- the name AGENTS.md and the
 * shadow tests know) and the telemetry coverage predicates (`telemetry/coverage.mjs`) can read it without either depending
 * on the other's domain.
 *
 * A new mechanical wave is declared HERE, or `PASS_PROMPTS` silently enrols it in the shadow's paid comparison.
 *
 * @module scripts/lib/mechanical-waves
 */
export const MECHANICAL_WAVES = Object.freeze(['quickfix', 'duplication', 'adjacency']);
