# Consumer sync durability — making deliberate divergence survive

**Status**: Complete (2026-08-29)
**Driver**: upstream reports `263e49e8`, `36be3a03`, `29a9f4cf`, `ab61aefa`, `5b1a121e` (all from `storyline`)
**Touches**: `scripts/sync-to-repos.mjs`, `scripts/lib/sync-{divergence,overrides,pin-guard,receipt,eol-pins}.mjs`

---

## 1. The problem, stated as a mechanism

The sync's ownership model asked exactly one question of every destination:
*did a previous sync write this?* A yes — an entry in the consumer's
`scripts/.sync-manifest.json` — licensed an **unconditional** overwrite.

Two properties made that dangerous in combination:

1. **The manifest is gitignored in the consumer.** A reverted file looks exactly
   like an ordinary uncommitted edit; `git status` cannot distinguish "the user
   changed this" from "a sync changed this".
2. **Many synced paths are tracked files a consumer has deliberately diverged
   on.** The sync therefore moved a working tree *backwards from the consumer's
   own default branch*, silently.

Observed 2026-08-29: a sync from `667b2488` at `14:11:25Z` reverted four
separate pieces of already-merged work in `storyline`. Two were caught by
consumer-side CI gates; two passed unnoticed and would have been re-enshrined by
any `git commit -a`.

**The root cause is an asymmetry.** The project already had a concept of
ownership — the `⚠ UPSTREAM-OWNED` banner — but only in one direction.
`sourceDirty` tracks dirt on the SOURCE side; nothing recorded deliberate
divergence on the CONSUMER side.

---

## 2. What was built

### 2.1 The divergence gate — `lib/sync-divergence.mjs`

The manifest already stores the sha256 of what the last sync wrote, so a
three-way comparison was available for free, with no new state:

```
base   = manifest[dst]   — what we wrote last time
theirs = bytes on disk   — what is there now
ours   = outbound bytes  — what we would write now
```

`theirs === base` ⇒ the consumer has not touched it ⇒ overwrite, however far
`ours` has moved. **Choosing the manifest and not `HEAD` as the base is what
keeps the gate from firing on every ordinary upstream update** — the failure
mode that gets a gate flagged into irrelevance.

`theirs !== base` is consumer content, and tracked-ness decides severity:

| | Action |
|---|---|
| tracked, matches HEAD | **REFUSE** — merged work; overwriting reverts it |
| tracked, dirty | **REFUSE** — no commit to recover from; worse, not better |
| untracked (the gitignored tooling tree) | overwrite, loudly |
| git could not answer | **REFUSE** — fails closed |

`git` is consulted only for an already-diverged path, so the 751-file bundle
never pays for it. `readVcsState` distinguishes git's exit 1 ("no") from 128
("could not run"); collapsing them would fail OPEN, the one direction this guard
must never fail.

A refusal does not abort the target: everything else syncs, the diverged paths
are untouched, and **the run exits non-zero**. `--overwrite-diverged` consents,
per run (a flag, not an env var, so it cannot linger in a shell).

**Exempt: the sync's own bookkeeping** (`SYNC_BOOKKEEPING_DESTS`). The manifest
is a synced asset AND a per-run artifact, so it differs every run; gating on it
would print "overwrote consumer content" on every sync of every consumer and
train operators to ignore the one line that matters.

### 2.2 The consumer's declaration — `.sync-overrides.json`

Committed at the consumer root; names paths (or globs) the sync must not
overwrite, each with a required `reason`. Malformed ⇒ **ABORT the target**;
fail-open would silently resume clobbering the very paths it protects while the
run reported clean. `gitignoreExtra` patterns are folded into the sync's managed
`.gitignore` fence, which is how a consumer keeps a line the wholesale rewrite
would otherwise delete.

**`scripts/.claude-skills/**` may never be claimed.** Making a local patch of
upstream-owned tooling *durable* would convert the one governance rule the
banner enforces into an opt-out; the refusal names
`cross-skill.mjs upstream report` instead.

**Stale-override story:** on every run the sync reports a held path, and when
upstream's bytes for it have moved since the last sync it says so with both
shas and sets `upstreamMoved` in the receipt. An override freezes a path; it
must not also freeze the consumer's knowledge that upstream moved on.

### 2.3 Never un-pin — `lib/sync-pin-guard.mjs`

`deepMerge` gives a source leaf authority and replaces arrays wholesale, so
upstream's `npx -y @playwright/mcp@latest` silently replaced a consumer's
`${workspaceFolder}/node_modules/...` launcher. Fixed as an invariant, not a
per-file exception: `guardPinDowngrades` restores the consumer's whole spec for
any server that would go pinned→unpinned, and `assertNoPinDowngrade`
re-derives the same question from the FINAL bytes and throws. Guard **plus** an
independent post-condition — a check sharing its only implementation with the
thing it checks proves nothing.

Scope is the `servers` / `mcpServers` maps and the pinned→unpinned direction
only. `unknown` is a real classification and is inert in both directions.

### 2.4 The in-repo trace — `.sync-receipt.json`

Committed at the consumer root: the upstream commit, `sourceDirty`, and the
created / updated / gc-deleted / held / overwritten / refused lists.

This is a **deliberate exception** to the generated-artifact policy, which sends
timestamped artifacts to Category A. The policy's own test is *does its
dirtiness carry information?* — and here it is the only information there is.
The receipt is an event record, not a derived view of source. It does not churn:
`receiptShouldWrite` skips a no-op run whose body would be identical.

### 2.5 Known boundary: the first sync has no base

With no manifest entry there is nothing to compare against, so `NO_BASE` writes.
That is correct for a genuine first sync — refusing would fire on every adoption
— but it means a consumer that hand-adopted the bundle, or whose manifest was
rolled back by a merge, has its existing content overwritten on that one run.

This is not silent: the ownership preflight already reports both shapes
(`note: N managed-surface file(s) not in prior manifest` for the namespace claim,
`adopt N orphan(s) proved ours by content` plus the ownership-regression warning
for the rollback). Asking git per file instead would cost two execs across the
whole 751-file bundle on exactly the runs where the manifest is missing. Left as
is, named here so the boundary is a decision rather than an oversight.

---

## 3. Options considered

**Adopt the consumer's form upstream — DECLINED.** The premise expired. Commit
`13acf83e` (2026-08-27) had already fixed `263e49e8`/`36be3a03`/`29a9f4cf` by
INLINING the hydrate recipe into the marker block and labelling the runbook
citation source-repo-only. Sync `667b248` *delivered that fix*; the consumer's
condensed one-liner — which cites `../../../docs/runbooks/consumer-adoption.md`,
a file only that consumer has — is the older, weaker form for any repo that has
not authored its own runbook. Adopting it would regress every fresh consumer to
the exact "pointer to nothing" the reports objected to. See §4.

**Region-level ownership markers — DEFERRED, with reason.** They would let a
consumer keep only part of a synced file (the `repo-electron-target` case). But
file-level overrides plus `gitignoreExtra` cover every reported case today, and
a marker-aware three-way merge is a substantially larger mechanism than any
current requirement needs. The cost of the deferral is bounded and visible: an
overridden file stops receiving upstream updates, and `upstreamMoved` says so
every run. Revisit when a consumer reports an override it cannot afford to hold
whole.

**Deduplicate the 16-site block — ALREADY DONE, in the form the format allows.**
`SKILL.md` has no transclusion; Copilot, Cursor and Claude Code read the file
raw. Upstream's answer is `scripts/lib/worktree-preflight.mjs`'s `MARKER_BLOCK`
— one constant, inserted verbatim, byte-pinned across all 16 copies by
`check-worktree-preflight.mjs`. Editing the block is already one edit site; the
16 copies are generated output, not 16 hand-written paragraphs.

---

## 4. Disposition of the five reports

| Report | Verdict | Why |
|---|---|---|
| `263e49e8` (BLOCKER) | **fixed** | `13acf83e` (2026-08-27) inlined `CONSUMER_HYDRATE_NPM_SCRIPT` into the marker; the reporter's own `29a9f4cf` confirms the remedy exists and works |
| `36be3a03` (MEDIUM) | **fixed** | same commit labels the runbook citation "source repo only" and no longer depends on it; the 16-site half is answered by the single pinned constant (§3) |
| `29a9f4cf` (MEDIUM) | **fixed** | its own ask — inline the recipe rather than cite it — is what `13acf83e` did |
| `ab61aefa` (MEDIUM) | **wont-fix** (as asked) / fixed (as a class) | the specific ask was to adopt the consumer's condensed form upstream; declined per §3. The general defect it names — a consumer fix with nowhere durable to live — is what this change builds |
| `5b1a121e` (HIGH) | **fixed** | all four of its remedies, in its own preference order except (1): §2.2 is its "honour a local override", §2.1 + §2.4 are its "minimum ask" (be loud, fail on reverting merged work), §2.3 closes the `mcp.json` half |

---

## 4b. Two defects found while closing those reports

Both are in the upstream-report machinery, not the sync, and both were hit by
the act of closing five reports at once.

**Closing by ID PREFIX left `npm run check` permanently red.** The store
resolves a prefix, so `upstream fix --id 5b1a121e` succeeded — but
`upstreamTransition` records `--id` VERBATIM in the committed disposition
ledger, and `check-upstream-probe-coverage.mjs --gate` requires every
`issueId` to be uuid-shaped. So the report closed, the ledger entry was
written, and the gate then rejected an entry nothing could withdraw. The writer
accepted a key its own reader refuses — shape (1) of the four AGENTS.md names,
inverted. **Fixed here**: a terminal transition now demands the full uuid at the
boundary, before either write, which preserves the deliberate ledger-then-DB
ordering (resolving instead would need a store round-trip before the local
write). `ack` writes no ledger entry, so prefixes stay convenient there.
Guarded by `tests/upstream-disposition-ratchet.test.mjs`, verified red-then-green.

**The disposition ledger is single-store, and consumers are not.** OPEN — named,
not fixed. `scripts/upstream-dispositions.json` is committed here and reconciled
by `upstream:reconcile:gate` against whatever store `AUDIT_DB_URL` points at.
These five reports were filed from `storyline`, which uses a different store
(corporate Azure) from this repo's default, so closing them wrote five ledger
entries with no matching row in the store the gate reads, and
`RECONCILE_NEEDS_REVIEW` failed the push. The entries were removed; the
dispositions live on the `upstream_issues` rows themselves, in the store that
owns them, which is what the reporting consumer actually reads.

The consequence to be aware of: **a report filed from a consumer on a different
store cannot be recorded in this repo's committed ledger at all**, so the
upstream-coverage ratchet silently under-counts closures for those consumers.
Fixing it means deciding what identity a ledger entry carries (store, or repo,
or both) — a real design question, and larger than this change. Not smuggled in
here.

---

## 5. Acceptance criteria

- [x] A tracked, committed divergence is **not** overwritten, and the run exits non-zero.
- [x] The refusal names every affected path and the three ways to resolve it.
- [x] An ordinary upstream update of an untouched file is unaffected (no false fire).
- [x] `.sync-overrides.json` holds a declared path across a sync; the run stays green.
- [x] A malformed `.sync-overrides.json` aborts the target rather than failing open.
- [x] An override may not claim `scripts/.claude-skills/**`.
- [x] A consumer's pinned MCP launcher survives, even under `--overwrite-diverged`.
- [x] `.sync-receipt.json` is written, committed (not gitignored), and does not churn on a no-op sync.
- [x] `.audit-loop/cache/` is in the managed `.gitignore` block.

Guarded by `tests/sync-{divergence,overrides,pin-guard,receipt}.test.mjs` and the
end-to-end `tests/sync-consumer-divergence-e2e.test.mjs`, which drives the real
CLI against a real `git init` consumer and replays the 2026-08-29 sequence. Both
the divergence gate and the pin guard were verified red-then-green by neutering
them (7/14 and 4/18 respectively).
