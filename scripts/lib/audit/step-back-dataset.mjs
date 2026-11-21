/**
 * @fileoverview Freeze the step-back replay DATASET before any paid call
 * (docs/plans/verification-lessons.md §2.4, "Replay baseline"). For each PR it
 * lists the SID, the final ledger path, every round-result path, the per-round
 * ledger snapshots that exist, and each round's recorded `audited_sha` — read
 * from the worktrees' `.audit/` directories and, when supplied, cross-checked
 * against rows exported from the store's `audit_runs` (this module never queries
 * the store). A PR whose data cannot be recovered or whose sources disagree is
 * `unrecoverable` with the reason: excluded, never imputed.
 *
 * Ground truth is written to a SEPARATE scoring file (`scoring/<dataset>.json`)
 * that the pack builder never opens: per PR, the round numbers with at least one
 * finding later adjudicated `accepted` at HIGH, read from the final ledger.
 *
 * Domain: audit-orchestration.
 *
 * @module scripts/lib/audit/step-back-dataset
 */
import fs from 'node:fs';
import path from 'node:path';

export const DATASET_VERSION = 1;
export const CHECKPOINTS = Object.freeze([3, 6]);

const readJsonDefault = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Round numbers with >= 1 finding adjudicated `accepted` at HIGH in the (final) ledger entries. */
export function acceptedHighRounds(entries) {
  const out = new Set();
  for (const e of entries || []) {
    const round = [e?.firstSeenRound, e?.round].find((n) => Number.isInteger(n));
    if (e?.adjudicationOutcome === 'accepted' && String(e?.severity).toUpperCase() === 'HIGH' && round != null) out.add(round);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * @param {{spec: {prs: Array<{pr: number, label: 'bad'|'converged', sid: string, auditDir: string, planFile?: string,
 *   storeRows?: Array<{round: number, audited_sha: string}>}>}, readJson?: Function, listDir?: (d: string) => string[], exists?: (p: string) => boolean}} a
 * @returns {{dataset: object, scoring: object}}
 */
export function freezeDataset({ spec, readJson = readJsonDefault, listDir = (d) => fs.readdirSync(d), exists = (p) => fs.existsSync(p) }) {
  const prs = []; const truth = {};
  for (const p of spec.prs) {
    const base = { pr: p.pr, label: p.label, sid: p.sid, auditDir: p.auditDir, planFile: p.planFile ?? null };
    const fail = (reason) => prs.push({ ...base, status: 'unrecoverable', reason });
    let names;
    try { names = listDir(p.auditDir); } catch (err) { fail(`audit dir unreadable (${err?.code || err?.message})`); continue; }
    const rounds = names.map((n) => /^(.*)-r(\d+)-result\.json$/.exec(n)).filter((m) => m && m[1] === p.sid).map((m) => Number(m[2])).sort((a, b) => a - b);
    if (rounds.length === 0) { fail(`no ${p.sid}-r<N>-result.json in ${p.auditDir}`); continue; }
    const auditedShas = {}; const resultPaths = {}; const roundLedgerPaths = {}; const disagreements = [];
    let bad = null;
    for (const n of rounds) {
      const rp = path.join(p.auditDir, `${p.sid}-r${n}-result.json`);
      let r; try { r = readJson(rp); } catch (err) { bad = `round ${n} result unreadable (${err?.message})`; break; }
      if (!r?._auditedSha) { bad = `round ${n} result has no audited_sha`; break; }
      auditedShas[n] = r._auditedSha; resultPaths[n] = rp;
      const lp = path.join(p.auditDir, `${p.sid}-r${n}-ledger.json`);
      if (exists(lp)) roundLedgerPaths[n] = lp;
      const row = (p.storeRows || []).find((x) => x.round === n);
      if (row && row.audited_sha !== r._auditedSha) disagreements.push({ round: n, file: r._auditedSha, store: row.audited_sha });
    }
    if (bad) { fail(bad); continue; }
    if (disagreements.length) { fail(`store audit_runs disagrees with the result files for round(s) ${disagreements.map((d) => d.round).join(', ')}`); continue; }
    const ledgerPath = path.join(p.auditDir, `${p.sid}-ledger.json`);
    let ledger; try { ledger = readJson(ledgerPath); } catch (err) { fail(`final ledger unreadable (${err?.code || err?.message})`); continue; }
    if (!Array.isArray(ledger?.entries)) { fail('final ledger has no entries[]'); continue; }
    const checkpoints = CHECKPOINTS.filter((c) => c <= rounds[rounds.length - 1]).map((c) => ({ checkpoint: c, hasRoundLedger: c in roundLedgerPaths }));
    prs.push({ ...base, status: 'recoverable', rounds, ledgerPath, resultPaths, roundLedgerPaths, auditedShas, checkpoints, crossChecked: rounds.every((n) => (p.storeRows || []).some((x) => x.round === n)) });
    truth[p.pr] = { label: p.label, acceptedHighRounds: acceptedHighRounds(ledger.entries), lastRound: rounds[rounds.length - 1] };
  }
  return { dataset: { version: DATASET_VERSION, prs }, scoring: { version: DATASET_VERSION, truth } };
}

/** Where the scoring file for a dataset lives: `<dir>/scoring/<basename>`. */
export function scoringPathFor(datasetPath) {
  return path.join(path.dirname(datasetPath), 'scoring', path.basename(datasetPath));
}
