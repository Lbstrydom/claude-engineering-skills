# Plan: An upstream closure must not silently block every push

- **Date**: 2026-10-10
- **Status**: In Progress — implemented and code-audited (converged R2, Gemini APPROVE); PR open, awaiting merge
- **Author**: Claude + Louis
- **Scope**: backend (CLI + pre-push gate; no UI)

> **Target domain(s)**: `cross-skill-bridge`, `shared-lib`, `tests`.
> Citations are pinned to `5df1ade5` (`main` == `origin/main`, 2026-10-10).

---

## 1. Context

### 1.1 The incident (2026-10-10, measured)

`node scripts/cross-skill.mjs upstream fix --id … --commit … --disposition test:… --note -`
does two writes (`scripts/lib/upstream/commands.mjs:644-655 (5df1ade5)`):
an entry in the COMMITTED file `scripts/upstream-dispositions.json` of whatever
checkout it ran in (`upsertDispositionLedgerEntry`), then the store transition
(open -> fixed).

`npm run upstream:reconcile:gate` (in `npm run check`, run by the pre-push hook
against the pushed commit) throws `RECONCILE_NEEDS_REVIEW` when a terminal store
row has no ledger entry **on that commit**
(`scripts/lib/cross-skill/commands/quality.mjs:296-315 (5df1ade5)`).

So when any session closes a report, every push from every session fails until
someone lands that JSON entry on `main`. It happened twice on 2026-10-10
(512cf1c9, then 58f4e3a5): three sessions were blocked, one used three pre-push
attempts, and both fixes were hand-made one-file PRs (#180, #183). Nothing told
the closer they had created a repo-wide push blocker. Nothing told the blocked
sessions the failure was not theirs. In `--gate` mode the throw also fires
*before* the worksheet render, so the cause attribution `missingCause` already
computes is thrown away.

### 1.2 What the gate exists to catch

From its own comment block and `docs/plans/consumer-friction-doctor.md` §2.4: proof,
after the fact, that the **CLI/backfill write path** did not silently miss or
diverge from the store. The categories are the crash window (ledger written,
store write lost), a missing entry, a state or disposition-value disagreement,
and a row still carrying the migration catch-all sentinel.

### 1.3 Why its current level is wrong for one class

The gate reads two kinds of state:

- **repo state**: the ledger on the pushed commit.
- **live shared-store state**: rows that anyone in the repo can transition at
  any moment.

The "gate level follows the kind of state read" rule says repo state may block.
Store state that someone *else* changed may only be reported, because
blocking stops unrelated work and fixes nothing. The blocked session cannot land
someone else's uncommitted entry. Its only in-scope moves are `--no-verify`, or
bundling an unrelated regenerated entry into its PR. The second violates scope
discipline, and the `recordedAt` timestamps make concurrent copies conflict.

Precedent for this attribution exists in the repo: `plans:status --drift` gates only
non-conforming Status lines *in this push* and reports pre-existing ones as
"not gating this push" (`scripts/check-plan-status.mjs:161 (5df1ade5)`).

Note the internal contradiction this also resolves: `upstreamReconcile`'s
docstring says the reconciler *"can never be a `check` gate"*, but it was later
wired into `check` (consumer-friction-doctor round-6 H7). Attribution is what
makes the `check` wiring honest.

## 2. Design

### 2.1 The band-aid, the over-build, and this

- **Band-aid**: (b) alone. A better error message still blocks every unrelated
  push.
- **Over-build**: an age threshold on pending closures ("block once
  unlanded > N days"), a CLI auto-commit, or a bot that lands the file. The
  first still blocks unrelated commits. The other two violate shared-tree scope
  discipline.
- **This**: attribute each divergence to the pushed range. **Block** a
  divergence on an issue id whose ledger entry the range changed. **Report**
  everything else, loudly, on every run, with its precise cause and remedy. Then
  make the closer's command say clearly that it created a pending landing.

### 2.2 Gate attribution: `scripts/lib/upstream/reconcile-gate.mjs` (new)

- `readRangeBaseLedger({repoRoot, env})` asks the ONE range oracle
  (`resolvePushRange`, `scripts/lib/push-range.mjs`; AGENTS.md "one range, one
  resolver") for the base, then reads the ledger there via a shared
  `readLedgerEntriesAtRef` (extracted from `readUpstreamLedgerEvidence`, which
  is reused, not duplicated). Status is `read | absent | unresolved | unreadable`.
- `changedLedgerIds({baseEntries, headEntries})` is PURE. It returns the ids whose
  entry was added, removed or changed in any byte (canonical JSON). A
  `recordedAt`-only rewrite counts as changed, the conservative direction.
- **Evidence boundary (plan-audit R1 M1).** Acquisition is impure and lives in
  the orchestration layer. Policy is pure. Two ledger evidences reach the policy,
  each `{status, entries}`:
  - **head**: the ledger `upstreamReconcile` already reads from the working tree.
    In the pre-push sandbox the working tree IS the pushed commit
    (`prepush-check.mjs` builds a worktree at it), so this is the canonical pushed
    content. `upstreamReconcile` today collapses absent and malformed into `[]`. It
    will instead return `ledgerStatus: 'read' | 'absent' | 'malformed'` beside the
    entries, so an invalid head can never be confused with a valid empty ledger.
  - **base**: `readRangeBaseLedger`, with status `read | absent | unresolved |
    unreadable | malformed`.
- `decideReconcileGate({reconciliation, head, base, closedAtById, presentUpstream})`
  is PURE. It calls `changedLedgerIds` itself, so the changed set has exactly one
  derivation. Attribution is possible only when BOTH evidences are `read` or
  `absent`. Any other status on either side is **unattributable**: every
  divergence item is `blocking` (fail closed, today's behaviour), and the message
  names which side and why. A malformed head ledger with no per-id divergence is
  still blocking as an integrity failure (`ledger-unreadable`), not a pass. When
  attributable, an item is `blocking` iff its id is in `changedLedgerIds`, and
  `preExisting` otherwise.
- The renderers name each item's cause:
  - missing entry, pre-existing: "store row closed (state) at T, entry never
    committed. NOT caused by this push. Land it from the checkout that ran
    `upstream fix`, or regenerate it anywhere with
    `npm run upstream:reconcile -- --apply` and land that one-file change". If
    the id is already on the upstream (`missingCause.presentUpstream`), the
    message says "already landed; rebasing clears this".
  - attributable missing entry: "this push removes the entry".
  - ledgerOnly, mismatch and sentinel each get their own sentence.

To support per-id attribution, `computeLedgerReconciliation` gains per-divergence
`mismatches` records `{kind, issueId, detail}` (code-audit R1 M2: not parallel arrays). The prose strings stay as they are.
That avoids parsing ids back out of prose. `listTerminalUpstreamIssues`
additionally projects `updated_at` as `closedAt`, the lifecycle timestamp: set on
transition, deliberately NOT on annotate (`store/upstream-issues.mjs:303,346`).

**Third input, already acquired (Gemini R1 G2).** `presentUpstream` is not a new
read. It is `res.missingCause.presentUpstream`, which `upstreamReconcile` already
computes whenever `missingFromLedger` is non-empty. It does this via
`readUpstreamLedgerEvidence` against the resolved upstream (branch upstream, else
`origin/HEAD`; `scripts/lib/upstream/commands.mjs:1073-1087 (5df1ade5)`). It affects
**wording only** ("already landed upstream, rebase clears this") and never the
blocking decision. When `missingCause` is null or its evidence unreadable, the
set is empty and the generic sentence is used.

**Output order (Gemini R1 G1).** The diagnostics must not be swallowed the way
§1.1 describes. Under `--gate`, `quality.mjs` takes these steps in order:
1. Write the rendered `preExisting` lines to stderr, on every run.
2. If `blocking` is non-empty, build the CommandError MESSAGE from the same
   renderer's blocking lines. Each line names the id, the category, and the
   cause sentence ("this push removes the entry for X", "could not attribute:
   base ledger unreadable at REF"). Then throw `RECONCILE_NEEDS_REVIEW` (same
   code). The dispatcher prints the error message in its envelope and on stderr,
   so the cause is the failure text itself and not a sibling render that the
   throw skips. The structured decision rides on the error `details`.

Cloud-off behaviour is unchanged. The level rationale is written at the gate
(quality.mjs).

**What is NOT lost.** A push that deletes, adds or edits a ledger entry
inconsistently with the store still blocks, as does a malformed or unreadable
ledger (every id reads as changed). Store-side divergence the push did not cause
is still printed on every push, in every session, until fixed, but it no longer
holds unrelated work hostage. The ledger's own integrity remains enforced
cloudlessly by `upstream:coverage:gate`.

### 2.3 Closing command: landing descriptor

- `upsertDispositionLedgerEntry` returns
  `{path, written: true, landed, base, reason}`. A pure
  `assessDispositionLanding({entry, baseLedger})` computes `landed`. It is `true` iff
  `origin/main` (as of the last fetch, never fetches) already carries an entry
  with the same `state` + disposition, which is what the gate compares. It is
  `false` if the base was read and lacks it. It is `null` if the base could not be read.
- `upstreamTransition` returns it as `dispositionFile` on the envelope, with
  `storeTransitioned: res.ok === true` (the ledger is written FIRST, so a failed
  store write leaves an entry that must NOT be committed).
- **The notice is keyed on BOTH outcomes (plan-audit R1 H1).** Landing
  instructions are printed ONLY when `storeTransitioned === true && landed !== true`.
  When the store transition failed, the original error and non-zero exit are
  preserved unchanged: the CommandError still carries `res`, now including
  `dispositionFile`. A separate stderr line then says the entry was written AHEAD
  of a failed store write. It tells the operator NOT to commit it and points to
  recovery: re-run the same `upstream fix|wont-fix` once the store is reachable
  (the upsert is idempotent per issueId and preserves other entries), or remove
  just that entry. It never prints `git add` or commit commands. A dispatcher test
  asserts that an unsuccessful transition prints no commit or PR instruction.
- On success with `landed !== true`, `quality.mjs` prints a stderr notice. The notice names
  the file, that it is uncommitted in this checkout, what it causes until it
  lands, and the exact commands, all PowerShell-safe with real values:
  `git add -- scripts/upstream-dispositions.json`, a commit, a PR. It also says
  that **branches still running the pre-attribution gate fail on it until rebased**,
  because the sandbox runs the pushed commit's code, so old branches keep the old
  gate. No auto-commit or auto-push (shared trees).

### 2.4 Files

| File | Change |
|---|---|
| `scripts/lib/upstream/reconcile-gate.mjs` | **new**: reader + pure decision + renderers |
| `scripts/lib/upstream/disposition-ledger.mjs` | `readLedgerEntriesAtRef`, `assessDispositionLanding`; upsert returns descriptor |
| `scripts/lib/upstream/dispositions.mjs` | structured mismatch ids |
| `scripts/lib/upstream/commands.mjs` | carry `dispositionFile` (line-neutral: size ratchet) |
| `scripts/lib/cross-skill/commands/quality.mjs` | gate uses decision; landing notice |
| `scripts/lib/store/upstream-issues.mjs` | `closedAt` projection |
| `tests/upstream-reconcile-gate-attribution.test.mjs` | **new**: pure decision + temp-repo reader + dispatcher both directions |
| `tests/upstream-disposition-landing.test.mjs` | **new**: landing assessment + envelope |
| `tests/upstream-reconcile-gate.test.mjs` | existing blocking cases pinned to the fail-closed path |

## 3. Testing

- Tier 1 (pure): `changedLedgerIds`, `decideReconcileGate` (each category ×
  changed/unchanged, unattributable -> all blocking), `assessDispositionLanding`.
- Real git in a temp repo: `readRangeBaseLedger` read/absent/unresolved/malformed;
  a malformed HEAD ledger and a valid empty ledger are distinguished; plus the
  dispatcher in a temp repo, testing **both directions**. A pre-existing missing
  entry passes with a stderr warning. An entry removed by the range blocks. A mixed
  run blocks on the attributable item only and still prints the pre-existing one.
  A failed transition prints no landing instructions.
- Negative control: the "pre-existing passes" dispatcher test is run against
  the unmodified `quality.mjs` first and must FAIL (it throws today).

## 4. Risks

- **Re-push base is the remote branch tip**, so an entry added in an earlier push
  of the same branch is not "changed" by a later push. Accepted, because that
  earlier push was gated at the time. Divergence appearing later is store movement.
- **An unlanded entry can now linger** as a warning rather than a block.
  Mitigated by the closer's notice and the every-push warning naming the id
  and closedAt. An age-based escalation is a deliberate non-goal (§2.1).

## 5. Audit trail

- **/audit-plan R1** (GPT): H:1 M:1, both accepted and fixed (100% acceptance).
  H1 was failed-transition guidance (notice keyed on both outcomes). M1 was the
  incomplete head/base evidence contract.
- **R2** (GPT): READY_TO_IMPLEMENT, H:0 M:0 L:0. Stopped as converged.
- **Gemini gate R1**: CONCERNS, 2 blocking, both accepted. G1: the blocking
  diagnostics must be the error message, not a render the throw skips. G2:
  `presentUpstream` is the existing `missingCause` read, used for wording only.
- **Gemini gate R2**: APPROVE, 0 new.
- **/audit-code R1** (GPT, 5 passes + waves, coverage complete): H:5 M:5. Accepted
  7, at 70% acceptance. H2/H4/H5 were one concern: both ledger writers degraded a
  malformed ledger to `[]` and overwrote it, and they now refuse with
  `LEDGER_MALFORMED`. M1: a thrown transition is now folded into
  `storeTransitioned:false`. M2: mismatch records replace parallel arrays. M3:
  remedies no longer re-close terminal rows. M4: fixtures commit the pushed change.
  H1 (head = working tree) and H3 (non-atomic two-store write) were deliberated,
  and GPT overruled its own findings. M5 was the adjacency wave's own enumeration
  bound (`maxContainers=20`), recorded as tool coverage, not a defect.
- **/audit-code R2**: PASS, H:0 M:0 L:0, `_coverage` complete,
  `_convergence.converged: true`.
- **Gemini code gate R1**: APPROVE, 0 new, 0 wrongly-dismissed, 0
  over-engineering flags.
- **Negative controls**: the dispatcher "pre-existing closure does not block" test,
  plus 4 more, failed on the unmodified gate. The landing and envelope tests failed
  on the unmodified `commands.mjs`. Each R1 guard (strict write path, thrown
  transition) was reverted alone, went red naming its defect, then was restored green.
