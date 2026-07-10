/**
 * Tiny fixture frontend file for tests/run-multi-pass-code-audit-harness.test.mjs
 * (Phase 10 of docs/plans/tiered-recall-audit-pipeline.md). Path contains
 * `/components/` so `classifyFiles` (scripts/lib/file-io.mjs) buckets it as
 * frontend without extra config.
 */
export function Widget({ items }) {
  return items.map((item) => item.name).join(', ');
}
