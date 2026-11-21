/**
 * @fileoverview The no-look-ahead CHECKPOINT SNAPSHOT for the step-back
 * (docs/plans/verification-lessons.md §2.4, R2 H4). A checkpoint (round 3 or 6)
 * is built ONLY from what existed then:
 *   - the round results `<sid>-r<N>-result.json` for N <= checkpoint, each with a
 *     recorded `_auditedSha` (the repo revision the pack's file reads use),
 *   - the per-round ledger snapshot `<sid>-r<checkpoint>-ledger.json` the audit
 *     wrote AT that round — never a filter over the final, mutable ledger, which
 *     does not keep earlier field values.
 * Provenance is checked: the result's round and audited sha, and the snapshot's own
 * round/audited-sha when it records them, must agree, and no ledger entry may mention a round after the checkpoint.
 * Session IDENTITY is NOT checked: a result's internal `_sid` is not the file-name sid (they differ in real audits), so
 * the file-name convention is the only binding between a result and its session; the store-backed path pins run ids instead. A checkpoint whose data
 * is missing or disagrees is `unrecoverable` with the reason — never reconstructed.
 *
 * Ground truth (the final ledger's accepted-HIGH rounds) is NOT read here; it is
 * `scoreFileFor`'s separate `scoring/` file that the replay reads only to score.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-snapshot
 */
import fs from 'node:fs';
import path from 'node:path';

const ROUND_FIELDS = ['round', 'firstSeenRound', 'lastSeenRound', 'resolvedRound'];

const unrecoverable = (reason) => ({ ok: false, status: 'unrecoverable', reason });

/** Path of the per-round ledger snapshot. */
export const roundLedgerPath = (auditDir, sid, round) => path.join(auditDir, `${sid}-r${round}-ledger.json`);

/** Path of a round result. */
export const roundResultPath = (auditDir, sid, round) => path.join(auditDir, `${sid}-r${round}-result.json`);

/**
 * @param {{sid: string, checkpoint: number, auditDir: string, readJson?: (p: string) => object}} a
 *   `readJson` is injectable; the default reads and parses the file, throwing on ENOENT.
 * @returns {{ok: true, snapshot: {sid: string, checkpoint: number, auditedSha: string, provenance: string,
 *   rounds: Array<{round: number, auditedSha: string, verdict: string|null, findings: object[]}>,
 *   ledgerEntries: object[], paths: string[]}}|{ok: false, status: 'unrecoverable', reason: string}}
 */
export function buildCheckpointSnapshot({ sid, checkpoint, auditDir, readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8')) }) {
  if (!sid || !Number.isInteger(checkpoint) || checkpoint < 1) return unrecoverable('sid and a positive integer checkpoint are required');
  const rounds = []; const paths = [];
  for (let n = 1; n <= checkpoint; n++) {
    const p = roundResultPath(auditDir, sid, n);
    let r;
    try { r = readJson(p); } catch (err) { return unrecoverable(`round ${n} result missing or unreadable (${err?.code || err?.message})`); }
    if (!Array.isArray(r?.findings)) return unrecoverable(`round ${n} result has no findings[]`);
    if (r.round != null && r.round !== n) return unrecoverable(`round ${n} result file records round ${r.round}`);
    if (!r._auditedSha || !/^[0-9a-f]{7,64}$/i.test(r._auditedSha)) return unrecoverable(`round ${n} result has no audited_sha`);
    rounds.push({ round: n, auditedSha: r._auditedSha, verdict: r.verdict ?? null, findings: r.findings });
    paths.push(p);
  }
  const lp = roundLedgerPath(auditDir, sid, checkpoint);
  let ledger;
  try { ledger = readJson(lp); } catch (err) { return unrecoverable(`per-round ledger snapshot r${checkpoint} missing or unreadable (${err?.code || err?.message})`); }
  if (!Array.isArray(ledger?.entries)) return unrecoverable(`ledger snapshot r${checkpoint} has no entries[]`);
  paths.push(lp);

  const sha = rounds[checkpoint - 1].auditedSha;
  const meta = ledger.meta || {};
  if (meta.round != null && meta.round !== checkpoint) return unrecoverable(`ledger snapshot records round ${meta.round}, expected ${checkpoint}`);
  const metaSha = meta.auditedSha ?? meta.audited_sha ?? null;
  if (metaSha && metaSha !== sha) return unrecoverable(`ledger snapshot audited_sha ${String(metaSha).slice(0, 8)} disagrees with the round result's ${sha.slice(0, 8)}`);
  let maxSeen = 0;
  for (const e of ledger.entries) for (const k of ROUND_FIELDS) if (Number.isInteger(e?.[k])) maxSeen = Math.max(maxSeen, e[k]);
  if (maxSeen > checkpoint) return unrecoverable(`ledger snapshot r${checkpoint} carries an entry from round ${maxSeen} (look-ahead)`);

  return {
    ok: true,
    snapshot: {
      sid, checkpoint, auditedSha: sha, rounds, ledgerEntries: ledger.entries, paths,
      provenance: meta.round != null || metaSha ? 'snapshot-meta' : 'file-name+entry-rounds',
    },
  };
}
