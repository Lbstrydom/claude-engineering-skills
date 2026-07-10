/**
 * Tiny fixture backend file for tests/run-multi-pass-code-audit-harness.test.mjs
 * (Phase 10 of docs/plans/tiered-recall-audit-pipeline.md). Not a real service —
 * just enough content for the audit passes' file-context assembly to have
 * something non-empty to read.
 */
export function widgetTotal(items) {
  return items.reduce((sum, item) => sum + item.price, 0);
}
