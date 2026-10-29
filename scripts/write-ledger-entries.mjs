#!/usr/bin/env node
/**
 * @fileoverview `write-ledger-entries` — write adjudication-ledger entries for a
 * round's findings from a triage map, deriving every identity field FROM the
 * round's own result JSON.
 *
 * Why a CLI and not the documented heredoc snippet (two defects, one fix):
 *
 *  1. **The snippet could not run in a consumer repo.** It wrote a `.mjs` file
 *     importing `../../scripts/shared.mjs`, but a consumer's bundle lives under
 *     `scripts/.claude-skills/`, and the sync's command rewriter only relocates
 *     `node scripts/<path>` invocations — never a module specifier inside a
 *     heredoc. Same class a consumer reported on 2026-08-08 for /plan's Gate-1
 *     self-check.
 *  2. **Hand-constructed identity fields make the ledger invisible.** Every
 *     downstream matcher keys on the finding's OWN fields (`topicId` folds in
 *     `_hash`; suppression narrows by `_pass` + `affectedFiles`). An entry with
 *     curated stand-ins joins to nothing, so suppression never engages and
 *     outcome labeling reports `0/N labelled · needs_triage` — reported live,
 *     twice. Here the operator supplies ONLY the judgement
 *     (outcome/state/ruling/why); identity is derived, never typed.
 *
 * Usage:
 *   node scripts/write-ledger-entries.mjs \
 *     --result .audit/$SID-r1-result.json \
 *     --ledger .audit/$SID-ledger.json \
 *     --triage .claude/tmp/triage-r1.json
 *
 * The triage file is JSON keyed by the round's finding ids — write it with an
 * editor, not a shell string (rationales contain apostrophes):
 *
 *   {
 *     "H1": { "outcome": "accepted",  "state": "planned", "ruling": "sustain",
 *             "why": "valid — the plan's fix is scheduled" },
 *     "M3": { "outcome": "dismissed", "state": "pending", "ruling": "overrule",
 *             "why": "300-line file, 2 consumers, acceptable" },
 *     "M4": { "outcome": "dismissed", "state": "pending", "ruling": "overrule",
 *             "why": "same limits-from-policy ask as before", "sameConcernAs": "3fa91c" }
 *   }
 *
 * A dismissal whose finding carries `_priorRuling` pointing at an earlier
 * dismissal MUST decide: `sameConcernAs` or `"newConcern": true`; an undecided
 * one refuses the batch (concern-identity.mjs `findUndecidedReRaises`).
 * A `newConcern` decision is stored as `newConcernOf: <prior topicId>`.
 * `sameConcernAs` links a re-raise to the concern it repeats — a
 * finding id in this triage, or a ledger topicId / unique 6+ char prefix (a
 * kept R2+ finding carries its nearest prior ruling as `_priorRuling.topicId`). Three dismissals of one concern hard-suppress
 * the next raise however it is worded (concern-identity.mjs).
 *
 * Mark fixes after Step 4 with the same tool:
 *   node scripts/write-ledger-entries.mjs --ledger <l> --mark-fixed <topicId> [<topicId> …]
 *
 * @module scripts/write-ledger-entries
 */
import fs from 'node:fs';
import path from 'node:path';
import { assertKnownFlags, ArgvError } from './lib/cli-io.mjs';
import { generateTopicId, populateFindingMetadata } from './lib/ledger.mjs';
import { resolveConcernLinks, findUndecidedReRaises } from './lib/concern-identity.mjs';
import { atomicWriteFileSync } from './lib/file-io.mjs';
import { parseResultPath, captureRoundOutcomes } from './lib/finalize-outcomes.mjs';
import { withFileLock } from './lib/file-lock.mjs';
import { LedgerEntrySchema } from './lib/schemas.mjs';
import { isDismissReasonClass, DISMISS_REASON_CLASSES } from './lib/adjudication-vocab.mjs';
import { readPersistedDebtEntries } from './lib/debt-ledger.mjs';

const KNOWN_FLAGS = [
  '--result', '--ledger', '--triage', '--pass', '--round', '--mark-fixed',
  '--json', '--no-finalize', '--selfcheck-relocation',
];

const OUTCOMES = new Set(['accepted', 'dismissed', 'severity_adjusted']);
const STATES = new Set(['pending', 'planned', 'fixed', 'verified', 'regressed']);
const RULINGS = new Set(['sustain', 'overrule', 'compromise', 'defer']);

/**
 * The round these rulings belong to — never a default.
 *
 * Upstream report 01f5cfd1 (2026-09-29): this was `--round ?? result.round ?? 1`,
 * while openai-audit's `--out` JSON carried no `round` and the documented call
 * never passes `--round`, so every R2+ triage landed at `resolvedRound: 1` —
 * which the R2+ rulings block renders as `ruled DISMISSED R1` and orders
 * most-recent-first by. Three sources can now answer, and each is checked:
 * the flag, the result's own `round` (openai-audit writes it since this fix),
 * and the `<sid>-r<N>-result.json` filename every documented invocation uses
 * (parsed by finalize-outcomes' single regex, never a second one). Any that
 * are present must AGREE — an R1 finding recorded at round 2 was in the same
 * report — and none present is a refusal, not round 1.
 *
 * @param {{flag: string|null, field: unknown, resultPath: string}} args
 * @returns {number}
 */
function resolveRound({ flag, field, resultPath }) {
  // Validate EXACTLY (a positive integer), never coerce. `Number` (not
  // `parseInt`) also rejects trailing garbage — same contract as
  // write-code-outcomes.mjs. Reproduced 2026-08-08: `--round nope` became NaN,
  // LedgerEntrySchema rejected every entry and this CLI still reported success.
  const positiveInt = (v) => Number.isInteger(v) && v >= 1;
  const sources = [];
  if (flag !== null) {
    if (!positiveInt(Number(flag))) {
      throw new ArgvError(`write-ledger-entries: --round must be a positive integer (got ${JSON.stringify(flag)}).`);
    }
    sources.push(['--round', Number(flag)]);
  }
  if (field !== undefined && field !== null) {
    if (!positiveInt(field)) {
      throw new ArgvError(
        `write-ledger-entries: ${resultPath} has a "round" that is not a positive integer (got ${JSON.stringify(field)}).`,
      );
    }
    sources.push(['the result\'s "round"', field]);
  }
  const fromName = parseResultPath(resultPath).round;
  if (positiveInt(fromName)) sources.push([`the filename (${path.basename(resultPath)})`, fromName]);

  if (sources.length === 0) {
    throw new ArgvError(
      `write-ledger-entries: cannot determine the round for ${resultPath} — no --round, no "round" in the `
      + 'result, and the filename is not <sid>-r<N>-result.json. Pass --round N; refusing to record the '
      + 'rulings at a guessed round.',
    );
  }
  if (new Set(sources.map(([, n]) => n)).size > 1) {
    throw new ArgvError(
      `write-ledger-entries: round sources disagree — ${sources.map(([what, n]) => `${what} says ${n}`).join(', ')}. `
      + 'Refusing to record the rulings in the wrong round; fix whichever is wrong.',
    );
  }
  return sources[0][1];
}

function valueOf(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}

/** Everything after `--mark-fixed` up to the next flag. */
function markFixedIds(argv) {
  const i = argv.indexOf('--mark-fixed');
  if (i === -1) return null;
  const out = [];
  for (let j = i + 1; j < argv.length && !argv[j].startsWith('--'); j++) out.push(argv[j]);
  return out;
}

function readJson(p, label) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(p), 'utf-8'));
  } catch (err) {
    throw new ArgvError(`write-ledger-entries: cannot read ${label} ${p} — ${err.message}`);
  }
}

/**
 * Merge entries into the ledger and persist them in ONE atomic write.
 *
 * `writeLedgerEntry` is read-modify-write PER ENTRY, so a batch the operator
 * issued as one action reached disk as N separate mutations: a failure partway
 * through left the ledger holding some of them. Validating up front (below)
 * removed the realistic trigger but not the property — so do the merge in
 * memory and hand the whole ledger to one `atomicWriteFileSync` (temp file +
 * rename), which is the same durability primitive `writeLedgerEntry` itself
 * relies on. Either every entry lands or none does.
 *
 * REPLACE-by-topicId semantics, matching `writeLedgerEntry` and deliberately
 * NOT `batchWriteLedger`: that helper PRESERVES `adjudicationOutcome` /
 * `remediationState` / `ruling` on an existing entry (correct for its
 * pre-adjudication caller), which would silently discard the very rulings this
 * CLI exists to record.
 *
 * `derive` runs INSIDE the lock and receives the freshly-read entries, so a
 * caller whose new entries depend on the CURRENT ledger state (`--mark-fixed`
 * merges into existing rows) computes them from what is on disk now, not from a
 * snapshot read before the lock was held. Reading outside and writing inside
 * looks atomic and is not: a concurrent triage decision landing in between was
 * silently overwritten by the stale copy. Caught by the Gemini final gate
 * 2026-08-08, as the residual of the lock added one round earlier.
 *
 * @param {string} ledgerPath
 * @param {object[] | ((existing: Map<string, object>) => object[])} derive
 *   a ready array (entries independent of ledger state), or a function
 *   evaluated under the lock against the current entries
 */
async function writeLedgerAtomically(ledgerPath, derive) {
  const abs = path.resolve(ledgerPath);
  // The atomic rename protects the WRITE; it does not serialize the
  // read-merge-write TRANSACTION. Two processes adjudicating the same ledger
  // (routine here — this repo's working tree is shared by concurrent sessions)
  // would each read the same prior state and each replace the file, so the
  // second silently discards the first's rulings. `withFileLock` is the repo's
  // existing answer (requirements.mjs reconcile uses it for the same shape).
  //
  // Nothing inside this callback may call `process.exit`: that skips the lock's
  // `finally` release and orphans the .lock file. Failures throw and unwind;
  // the caller sets the exit code.
  return withFileLock(`${abs}.lock`, {}, () => {
    let ledger = { version: 1, entries: [] };
    if (fs.existsSync(abs)) {
      const raw = JSON.parse(fs.readFileSync(abs, 'utf-8'));
      if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
        ledger = raw;
      } else {
        // Parseable but structurally wrong. Do NOT silently start fresh — that
        // REPLACES a file whose rulings may be recoverable by hand. Back it up
        // and say so, matching writeSingleLedgerEntry, whose behaviour this
        // write path took over and had quietly dropped.
        const backup = `${abs}.bak`;
        fs.copyFileSync(abs, backup);
        process.stderr.write(
          `  [ledger] WARNING: ${abs} is valid JSON but not a ledger (no entries[] array). `
          + `Backed up to ${backup} and starting a fresh ledger — inspect the backup before discarding it.\n`,
        );
      }
    }
    const byTopic = new Map(ledger.entries.map(e => [e.topicId, e]));
    const entries = typeof derive === 'function' ? derive(byTopic) : derive;
    assertAllValid(entries, abs);
    for (const entry of entries) byTopic.set(entry.topicId, entry);
    ledger.entries = [...byTopic.values()];
    atomicWriteFileSync(abs, `${JSON.stringify(ledger, null, 2)}\n`);
    process.stderr.write(`  [ledger] wrote ${entries.length} entr(ies) → ${abs} (${ledger.entries.length} total)\n`);
  });
}

/**
 * Validate EVERY entry before writing ANY of them.
 *
 * `writeLedgerEntry` validates per call and writes per call, so a batch whose
 * third entry is invalid persisted the first two and rejected the rest — a
 * partially-applied operation the operator issued as one action. Validating the
 * whole batch up front makes the realistic failure mode (a malformed entry)
 * all-or-nothing: nothing touches disk. A mid-loop crash or I/O failure is not
 * covered by this — that residual is caught after the fact by
 * `unverifiedTopicIds`, which fails the run naming exactly what is missing.
 *
 * @param {object[]} entries
 * @param {string} ledgerPath
 */
function assertAllValid(entries, ledgerPath) {
  const bad = entries
    .map((entry, i) => ({ i, entry, parsed: LedgerEntrySchema.safeParse(entry) }))
    .filter(r => !r.parsed.success);
  if (bad.length === 0) return;
  const detail = bad
    .map(r => `  ${r.entry.topicId ?? `#${r.i}`}: ${r.parsed.error.issues.map(is => `${is.path.join('.')} ${is.message}`).join('; ')}`)
    .join('\n');
  throw new ArgvError(
    `write-ledger-entries: ${bad.length} of ${entries.length} entr(ies) would be rejected by the ledger `
    + `schema. Nothing was written to ${ledgerPath} — a batch is one operator action, so it applies whole `
    + `or not at all.\n${detail}`,
  );
}

/**
 * Confirm the ledger on disk actually contains what we just claimed to write.
 *
 * `writeLedgerEntry` validates against the full `LedgerEntrySchema` and, on a
 * rejection, writes one stderr line and RETURNS — it throws nothing and returns
 * nothing, so a caller that reports its own intent is reporting a wish. Read the
 * file back and check, rather than trusting the call.
 *
 * Defence in depth behind `assertAllValid` (refuses a malformed batch before
 * anything is written) and `writeLedgerAtomically` (one temp-file+rename for
 * the whole batch). With both in place there is no partial-write path left to
 * construct hermetically — this stays as the final read-back that the file on
 * disk really says what was reported, which costs one stat and closes the
 * "reported a write that did not happen" class for good.
 *
 * @param {string} ledgerPath
 * @param {string[]} expectedTopicIds
 * @param {(entry: object) => boolean} [predicate] — extra per-entry assertion
 * @returns {string[]} topicIds that are absent or failed the predicate
 */
function unverifiedTopicIds(ledgerPath, expectedTopicIds, predicate = () => true) {
  let onDisk;
  try {
    onDisk = JSON.parse(fs.readFileSync(path.resolve(ledgerPath), 'utf-8'));
  } catch {
    return [...expectedTopicIds];   // no file at all ⇒ nothing landed
  }
  const byTopic = new Map((onDisk.entries ?? []).map(e => [e.topicId, e]));
  return expectedTopicIds.filter(id => !byTopic.has(id) || !predicate(byTopic.get(id)));
}

async function main() {
  if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
  assertKnownFlags(process.argv, KNOWN_FLAGS, { cli: 'write-ledger-entries' });
  const argv = process.argv.slice(2);

  const ledgerPath = valueOf(argv, '--ledger');
  if (!ledgerPath) throw new ArgvError('write-ledger-entries: --ledger <path> is required.');

  // ── Post-fix pass: flip remediationState on existing entries ─────────────
  //
  // A read-modify-write, NOT a partial write. `writeLedgerEntry` REPLACES the
  // entry at a topicId (it does not merge) and validates against the full
  // LedgerEntrySchema, so the recipe this replaced — writing bare
  // `{topicId, remediationState:'fixed'}` — failed validation and returned
  // without writing anything. It printed one stderr line and exited 0, so
  // "mark the fixed items" silently did nothing and every entry stayed
  // `pending`. Verified against the schema 2026-08-08.
  const fixedIds = markFixedIds(argv);
  if (fixedIds) {
    if (fixedIds.length === 0) {
      throw new ArgvError('write-ledger-entries: --mark-fixed needs at least one topicId.');
    }
    // Both the existence check and the merge happen UNDER the lock, against the
    // entries as they are on disk at that moment — see writeLedgerAtomically.
    await writeLedgerAtomically(ledgerPath, (byTopic) => {
      const missing = fixedIds.filter(id => !byTopic.has(id));
      if (missing.length > 0) {
        throw new ArgvError(
          `write-ledger-entries: ${missing.length} topicId(s) are not in ${ledgerPath}: ${missing.join(', ')}. `
          + 'Mark only entries that exist — a typo would otherwise leave the real one pending.',
        );
      }
      return fixedIds.map(topicId => ({ ...byTopic.get(topicId), remediationState: 'fixed' }));
    });
    const unmarked = unverifiedTopicIds(ledgerPath, fixedIds, e => e.remediationState === 'fixed');
    if (unmarked.length > 0) {
      console.error(
        `write-ledger-entries: ${unmarked.length} of ${fixedIds.length} entr(ies) are NOT marked fixed `
        + `on disk: ${unmarked.join(', ')}. The ledger write was rejected (see the [ledger] line above); `
        + 'nothing was silently accepted.',
      );
      process.exit(1);
    }
    console.log(`marked ${fixedIds.length} entr(ies) fixed → ${ledgerPath}`);
    return;
  }

  // ── Triage pass: write entries derived from the round's findings ─────────
  const resultPath = valueOf(argv, '--result');
  const triagePath = valueOf(argv, '--triage');
  if (!resultPath || !triagePath) {
    throw new ArgvError(
      'write-ledger-entries: --result <round-result.json> and --triage <triage.json> are both '
      + 'required (or use --mark-fixed <topicId>… to flip remediation state).',
    );
  }

  const result = readJson(resultPath, 'result');
  const triage = readJson(triagePath, 'triage');
  const findings = Array.isArray(result.findings) ? result.findings : [];
  if (findings.length === 0) {
    throw new ArgvError(`write-ledger-entries: ${resultPath} has no findings[] to adjudicate.`);
  }

  // A PLAN audit's findings carry no `_pass`; a CODE audit's carry the audit
  // pass name ('Structure', 'Wiring', …). Passing a bare undefined produces a
  // topicId that joins to nothing — the invisible-entry failure above.
  const passDefault = valueOf(argv, '--pass') || 'plan';

  // Validate the round EXACTLY (a positive integer), never coerce. `Number`
  // (not `parseInt`) also rejects trailing garbage — same contract as
  // write-code-outcomes.mjs. Reproduced 2026-08-08: `--round nope` became NaN,
  // LedgerEntrySchema rejected every entry, `writeLedgerEntry` returned after
  // one stderr line, and this CLI still printed `1/1 findings ruled ·
  // acceptance 100%` and exited 0 — with NO ledger file on disk at all. That is
  // the success-shaped-write class this whole change set exists to close.
  const round = resolveRound({ flag: valueOf(argv, '--round'), field: result.round, resultPath });

  const byId = new Map(findings.map(f => [f.id, f]));
  const unknown = Object.keys(triage).filter(id => !byId.has(id));
  if (unknown.length > 0) {
    // A typo'd id would otherwise be silently skipped, leaving a finding
    // un-adjudicated while the operator believes they ruled on it.
    throw new ArgvError(
      `write-ledger-entries: triage names ${unknown.length} finding id(s) not in ${resultPath}: `
      + `${unknown.join(', ')}. Ids must match the round's own findings.`,
    );
  }

  const written = [];
  const writtenTopicIds = [];
  const pending = [];
  const concernRefs = new Map();      // topicId → raw sameConcernAs
  const topicByFindingId = new Map();
  for (const [id, t] of Object.entries(triage)) {
    for (const [field, allowed] of [['outcome', OUTCOMES], ['state', STATES], ['ruling', RULINGS]]) {
      if (!allowed.has(t?.[field])) {
        throw new ArgvError(
          `write-ledger-entries: ${id}.${field} must be one of ${[...allowed].join('|')}, got ${JSON.stringify(t?.[field])}`,
        );
      }
    }
    if (t.dismissReasonClass !== undefined && !isDismissReasonClass(t.dismissReasonClass)) {
      throw new ArgvError(`write-ledger-entries: ${id}.dismissReasonClass must be one of ${DISMISS_REASON_CLASSES.join('|')}, got ${JSON.stringify(t.dismissReasonClass)}`);
    }
    if (typeof t.why !== 'string' || t.why.trim() === '') {
      throw new ArgvError(`write-ledger-entries: ${id}.why (the ruling rationale) is required.`);
    }
    if (t.sameConcernAs !== undefined && (typeof t.sameConcernAs !== 'string' || t.sameConcernAs.trim() === '')) {
      throw new ArgvError(`write-ledger-entries: ${id}.sameConcernAs must be a finding id or a ledger topicId (or unique prefix).`);
    }
    if (t.newConcern !== undefined && typeof t.newConcern !== 'boolean') {
      throw new ArgvError(`write-ledger-entries: ${id}.newConcern must be true or false.`);
    }
    if (t.newConcern === true && t.sameConcernAs !== undefined) {
      throw new ArgvError(`write-ledger-entries: ${id} sets both sameConcernAs and newConcern — pick one.`);
    }
    const f = byId.get(id);
    populateFindingMetadata(f, f._pass || passDefault);   // idempotent; ensures _hash/_primaryFile
    const topicId = generateTopicId(f);
    writtenTopicIds.push(topicId);
    topicByFindingId.set(id, topicId);
    if (t.sameConcernAs !== undefined) concernRefs.set(topicId, t.sameConcernAs.trim());
    pending.push({
      topicId,                                     // from the REAL finding — never a stand-in
      latestFindingId: f.id,                       // second join key for outcome labeling
      semanticHash: f._hash,
      adjudicationOutcome: t.outcome,
      remediationState: t.state,
      severity: f.severity,
      originalSeverity: f.severity,
      category: f.category,
      section: f.section,
      detailSnapshot: (f.detail || '').slice(0, 400),
      affectedFiles: f.affectedFiles,
      affectedPrinciples: f.principle ? [f.principle] : [],
      ruling: t.ruling,
      rulingRationale: t.why,                      // rationale is YOURS; identity is the finding's
      ...(t.dismissReasonClass !== undefined ? { dismissReasonClass: t.dismissReasonClass } : {}),
      // A newConcern decision is recorded against the prior it was ruled
      // distinct from, so it can be audited later; see LedgerCoreFields.
      ...(t.newConcern === true && f._priorRuling?.topicId ? { newConcernOf: f._priorRuling.topicId } : {}),
      resolvedRound: round,
      pass: f._pass,                               // matches the populateFindingMetadata arg above
    });
    written.push(id);
  }

  // Validate the whole batch before a single entry reaches disk.
  // `pending` derives from the result + triage files, never from the ledger,
  // so it carries no stale-read hazard; assertAllValid runs inside the write.
  // `sameConcernAs` resolves INSIDE the lock, against the ledger as it is now:
  // the concern it names may have been written by a concurrent adjudication.
  let linked = 0;
  let unlinked = [];
  let equivalenceLinks = [];
  // Tech-debt entries are valid link targets (fac2). Read once, outside the ledger lock; an unreadable debt ledger resolves nothing extra
  // (the link is then reported unresolved, never guessed).
  let debtTopicIds = [];
  try { debtTopicIds = readPersistedDebtEntries().map((e) => e?.topicId).filter((x) => typeof x === 'string'); } catch { debtTopicIds = []; }
  await writeLedgerAtomically(ledgerPath, (byTopic) => {
    const undecided = findUndecidedReRaises(Object.entries(triage).map(([id, t]) => [id, byId.get(id), t]), byTopic);
    if (undecided.length > 0) {
      throw new ArgvError(
        `write-ledger-entries: ${undecided.length} dismissal(s) sit beside an earlier dismissal with no concern `
        + 'decision. Nothing was written. For each, add "sameConcernAs": "<prior>" if it is the same concern '
        + 'reworded, or "newConcern": true if it is a different defect:\n  '
        + undecided.map(u => `${u.id} beside ${u.prior.slice(0, 6)} "${u.priorCategory}"`).join('\n  '),
      );
    }
    const { entries, errors, links } = resolveConcernLinks(pending, concernRefs, topicByFindingId, byTopic, debtTopicIds);
    // The links as FINGERPRINT pairs, for finding_equivalence. A debt-entry target has no fingerprint and is skipped.
    const hashOf = (topicId) => pending.find((e) => e.topicId === topicId)?.semanticHash ?? byTopic.get(topicId)?.semanticHash;
    equivalenceLinks = links
      .map((l) => ({ duplicateFingerprint: hashOf(l.duplicateTopicId), canonicalFingerprint: hashOf(l.canonicalTopicId) }))
      .filter((l) => l.duplicateFingerprint && l.canonicalFingerprint);
    // One bad link costs that LINK, not the batch (fleet fac2): the rulings are written, the raw reference is stored on the entry as
    // unresolvedConcernRef, and the caller is told below - never silently.
    unlinked = errors;
    linked = entries.filter(e => e.concernId && concernRefs.has(e.topicId)).length;
    return entries;
  });

  // Verify BEFORE reporting: the counts below are a claim about disk, and
  // `writeLedgerEntry` fails silently on a schema rejection.
  const unlanded = unverifiedTopicIds(ledgerPath, writtenTopicIds);
  if (unlanded.length > 0) {
    console.error(
      `write-ledger-entries: ${unlanded.length} of ${writtenTopicIds.length} entr(ies) are absent from `
      + `${ledgerPath} after writing (topicIds: ${unlanded.join(', ')}). The ledger write was rejected — `
      + 'see the [ledger] validation line above. Refusing to report a write that did not happen.',
    );
    process.exit(1);
  }

  const unruled = findings.filter(f => !Object.hasOwn(triage, f.id)).map(f => f.id);

  // Persist the concern links as finding_equivalence rows (audit-telemetry-capture Decision 6). Fail-open: a link the
  // store cannot take is COUNTED on the run's `equivalence` receipt, never allowed to fail the ledger write that just landed.
  if (equivalenceLinks.length > 0 && result._cloudRunId) {
    try {
      await import('./lib/load-env.mjs');
      const { initLearningStore } = await import('./learning-store.mjs');
      await initLearningStore();
      const [{ recordEquivalenceLinks }, { durableWrite }, { recordWriteReceipt }] = await Promise.all([
        import('./lib/audit/equivalence-links.mjs'), import('./lib/durable-write.mjs'), import('./lib/store/write-receipts.mjs'),
      ]);
      await import('./lib/audit-store-writers.mjs');
      await recordEquivalenceLinks({ links: equivalenceLinks, runId: result._cloudRunId, createdBy: 'concern-v1', deps: { durableWrite, recordWriteReceipt } });
    } catch (err) {
      process.stderr.write(`  [ledger] equivalence links not recorded (non-blocking): ${err.message}\n`);
    }
  }

  // The round's acceptance rate — the PRIMARY convergence signal for a plan
  // audit (see the /audit-plan convergence table). A round whose findings the
  // author accepts wholesale is by definition not rigor pressure, whatever the
  // HIGH count did; a round mostly dismissed or deferred is. Computed here
  // because this is where the judgements are, and a counted number beats a
  // remembered one.
  const ruled = Object.values(triage);
  const accepted = ruled.filter(t => t.outcome === 'accepted' && t.ruling !== 'defer').length;
  const adjusted = ruled.filter(t => t.outcome === 'severity_adjusted').length;
  const deferred = ruled.filter(t => t.ruling === 'defer').length;
  const dismissed = ruled.filter(t => t.outcome === 'dismissed' && t.ruling !== 'defer').length;
  const acceptanceRate = ruled.length > 0 ? (accepted + adjusted) / ruled.length : 0;

  if (argv.includes('--json')) {
    console.log(JSON.stringify({
      ok: true, ledger: ledgerPath, round, written, unruled, unlinked,
      accepted, adjusted, dismissed, deferred, acceptanceRate, linked,
    }));
  } else {
    console.log(`ledger → ${ledgerPath} · round ${round} · ${written.length}/${findings.length} findings ruled`);
    console.log(
      `acceptance ${(acceptanceRate * 100).toFixed(0)}% `
      + `(accepted ${accepted} · severity-adjusted ${adjusted} · dismissed ${dismissed} · deferred ${deferred})`
      + (linked > 0 ? ` · ${linked} linked to an earlier concern` : ''),
    );
  }
  if (unlinked.length > 0) {
    process.stderr.write(
      `  [ledger] UNLINKED: ${unlinked.length} sameConcernAs reference(s) did not resolve; the rulings WERE written without the link and `
      + `the raw reference is kept as unresolvedConcernRef. Re-triage with a resolvable reference to link them:\n    ${unlinked.join('\n    ')}\n`,
    );
  }
  if (unruled.length > 0) {
    // Every finding needs a ruling before Step 4; an un-ruled one stays
    // `pending` and later reports as `needs_triage` rather than a labelled
    // outcome — the silent half of the 0/N labelled report.
    process.stderr.write(
      `  [ledger] WARN: ${unruled.length} finding(s) have no triage entry and stay pending: ${unruled.join(', ')}\n`,
    );
  }

  // Label the round in the store NOW. The R2+ start of the next round labels rounds 1..N-1, but the LAST round has no
  // next round, and its row sat at accepted 0 / dismissed 0 / unlabelled unless the operator remembered
  // write-code-outcomes.mjs (3 of 3 final rounds after 2026-10-04 were left that way). Idempotent, so the R2+ capture
  // that follows is a no-op for this round. Only when the result is tied to a cloud run (a local-only audit has
  // nothing to label) and only when EVERY finding has a ruling: finalizing a half-ruled round would flag the
  // not-yet-ruled findings needs_triage. Fail-open; `--no-finalize` opts out.
  if (!argv.includes('--no-finalize') && result._cloudRunId) {
    if (unruled.length > 0) {
      process.stderr.write(`  [finalize] skipped: ${unruled.length} finding(s) are not ruled yet; re-run once every finding has a ruling\n`);
    } else {
      try {
        await import('./lib/load-env.mjs');
        const { initLearningStore } = await import('./learning-store.mjs');
        await initLearningStore();
        await captureRoundOutcomes({ resultPath, ledgerPath, round, sid: parseResultPath(resultPath).sid });
      } catch (err) {
        process.stderr.write(`  [finalize] WARN: could not label round ${round} (${err.message}); run write-code-outcomes.mjs\n`);
      }
    }
  }
}

main().catch((err) => {
  if (err instanceof ArgvError || err?.code === 'ARGV_ERROR') {
    console.error(err.message);
    process.exit(2);
  }
  console.error(err.message);
  process.exit(1);
});
