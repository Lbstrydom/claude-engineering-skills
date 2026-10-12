/**
 * @fileoverview A barrier for DB concurrency tests: wait until a competing
 * backend is OBSERVED blocked on a lock the test's own transaction holds.
 *
 * A fixed `setTimeout` is not that. It only hopes the competing statement has
 * reached its lock by then; on a slow or loaded runner it can start after the
 * holder commits, and the test degrades into a sequential case that passes
 * without ever exercising the race or the deadlock it claims to guard.
 */

/**
 * Resolve once some backend is waiting on a lock held by `holderPid`; reject if
 * none appears within `timeoutMs`, so a competing statement that never blocks
 * fails the test instead of silently passing it.
 *
 * @param {{query: (sql: string, params?: unknown[]) => Promise<{rows: object[]}>}} pool - a connection OTHER than the holder's
 * @param {number} holderPid - `SELECT pg_backend_pid()` on the holding connection
 * @param {{timeoutMs?: number, pollMs?: number}} [opts]
 * @returns {Promise<number[]>} the pids found blocked behind the holder
 */
export async function waitUntilBlockedBy(pool, holderPid, { timeoutMs = 10_000, pollMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { rows } = await pool.query(
      `SELECT pid FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND $1 = ANY(pg_blocking_pids(pid))`,
      [holderPid],
    );
    if (rows.length > 0) return rows.map((r) => r.pid);
    if (Date.now() >= deadline) {
      throw new Error(`no backend became blocked on a lock held by pid ${holderPid} within ${timeoutMs}ms — the competing statement never reached the lock, so this test would not exercise the interleaving it claims to`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
