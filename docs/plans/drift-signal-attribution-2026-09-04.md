# Plan: The drift signal must be falsifiable from CI

- **Date**: 2026-09-04
- **Status**: Complete — implemented and audited. `/audit-code` ×7 rounds
  (H:2→2→2→0→1→2→0), **25 findings ruled, 0 unadjudicated**: 17 accepted and
  fixed, 5 deferred with independence stated and captured as debt, 2 dismissed
  as scope pressure, 1 severity-adjusted. Gemini final gate ×2 —
  `CONCERNS` → **APPROVE**, 0 findings, 0 false positives, coherence "Strong",
  no over-engineering flags. Ran past the 6-round cap by one round under
  AGENTS.md's genuine-bug exception: every round found a real, security-relevant
  defect in the same class, and R7 was the first fully-clean round. Full suite
  **15,090 tests / 0 fail / 39 skipped**; all 27 pre-push gates green.
  `upstream:reconcile:gate` also passes: it had failed only because this
  worktree was **14 commits behind `origin/main`**, where all three entries
  already exist — the gate was right and the checkout was stale.
- **Earlier**: `/audit-plan` R1:
  `SIGNIFICANT_GAPS`, H:2 M:3, **5/5 accepted as fix-now** (100% acceptance ⇒
  productive round, continue). Two were narrowed on the evidence rather than
  taken whole: H1's persistence-mode subsystem (§2.4 "Rejected as over-built")
  and H2's corpus-count half (refuted — one `refreshId` already feeds both
  queries). R2: `READY_TO_IMPLEMENT`, 0 findings. Gemini final gate R1:
  `CONCERNS_REMAINING` — deliberation judged fair, 1 GPT false positive
  identified, both of its own findings accepted and fixed (`isPragmaPoolCapped`
  owning its own null case; the durability warning going silent on a correctly
  configured cloud setup). Gemini R2: **APPROVE**, 0 findings, coherence
  "Strong". `/audit-code` next.
- **Source**: an ADDENDUM to the consumer report behind
  [`consumer-corpus-and-honesty-2026-09-04.md`](consumer-corpus-and-honesty-2026-09-04.md)
  — same consumer (`louis-strydom_wartsila/storyline`), same synced bundle
  (`8802550`). The earlier report was about the index measuring the wrong
  corpus; this one is about the **report** not saying which corpus it measured.
- **Every claim below verified in this repo's source**, not inferred from the
  report. One of the four proposed fixes was rejected on the evidence and
  replaced — see §2.3.

---

## 0. The one theme

**The drift report describes a verdict without describing what was measured.**

Four small omissions compose into one large property: the drift signal is
*unfalsifiable from CI*. The run cannot tell you what corpus it measured (§1.2),
or which store it came from (§1.3); it can be silently pointed at the wrong store
by the most natural way to write the workflow (§1.1); and the debt it captures
may not survive the checkout (§1.4).

**A second theme emerged while fixing it, and it is the same one.** Two of the
four proposed remedies could not be taken as written — §1.3's would have
published a corporate hostname from a public repo, and §1.1's would have
re-pointed 20 air-gapped test suites at a live database. Both were *correct
diagnoses with a remedy that read one side of a two-sided contract*: what the
report could see (the drift output, the loader's precedence) and not what it
could not (this repo's publication rules, the air-gap harness). The verification
that caught them was mechanical in both cases — an existing invariant in
AGENTS.md, and the suite itself.

Same family as the parent plan's §0 — *a check that can succeed having measured
nothing* — one layer out. There the check was blind; here the check was fine and
the **report** could not be audited.

---

## 1. What was measured

The consumer wired `arch:*` into a scheduled GitHub Actions workflow on a
self-hosted runner. It took four dispatches. The first that completed every step
reported:

```
- **Status:** `GREEN`
- **Drift score:** 0 / threshold 20
- **Duplication pairs:** 0
```

An hour earlier the same repo measured **14 pairs**. Nothing was wrong with the
workflow — it had connected to a different database, and there was no way to tell
from the report. Their own duplication verifier exited 0 on that snapshot: a
policy gate passing over a near-empty store.

> The signal was not wrong. It was **unattributable**, which is worse, because it
> reported a confident GREEN and every step passed.

### 1.1 An empty environment variable blocks the shared config

> **The reporter's diagnosis is right and their fix is wrong.** It was
> implemented as asked, and the test suite refuted it — see §2.1. What ships is
> the opposite change plus a diagnostic. This section states the incident as
> reported; §2.1 states why the precedence stays as it is.

[`load-shared-env.mjs:130`](../../scripts/lib/load-shared-env.mjs) normalises DSN
presence as `(x || '').trim() !== ''`, with a comment arguing that *an empty
DSN counts as ABSENT*. Nine lines later the contribution test read
`process.env[k] === undefined`, so **an empty string won over the shared file**.
The module did disagree with itself, but not in the direction the report assumed:
the guard said "no higher-layer DSN, so contribute the DB group", handed over a
shared `AUDIT_DB_SSL_MODE`, and then declined the DSN itself — half a bundle.

The obvious way to pass credentials into a workflow is

```yaml
env:
  AUDIT_DB_URL: ${{ secrets.AUDIT_DB_URL }}   # secret absent -> empty, but SET
```

and a secret that does not exist expands to an empty-but-present value. The run
log states it exactly — the shared file loaded only the six variables the `env:`
block did **not** name, and the four it did name arrived empty:

```
[config] loaded shared cloud config from ~/.audit-loop.env (sets: ARM_EVAL_BUDGET_EUR,
  AUDIT_AUTHOR_TIER_HINT, AUDIT_DB_SSL_MODE, AUDIT_MODEL_SHADOW_ARM_TIMEOUT_MS,
  AUDIT_MODEL_SHADOW_BUDGET_EUR, OPENROUTER_API_KEY)
[learning] Cloud store not configured — using local mode.
```

**The block written to pass credentials in was the thing keeping them out.** Three
failed dispatches.

A second, quieter half: that `(sets: …)` notice is a before/after diff of
`Object.keys(process.env)`, so even once the value IS supplied it cannot report a
filled empty-but-present key. The one line an operator reads to find out what the
shared file did would have stayed silent about the key at issue.

### 1.2 The drift report omits the corpus it measured

`renderDriftIssue` printed repo, status, generated-at, commit, refresh id, score,
duplication pairs and layering violations — and no symbol count. **A score of 0
over 1842 symbols and a score of 0 over 12 symbols rendered identically**, and
only the first is a statement about code.

`arch:duplicates --json` had the same hole. Its `limit`/`returned`/`truncated`/
`total` fields (added earlier the same day) let a caller assert exhaustivity over
the *page*; nothing let it assert the page described a real corpus. The consumer
had to thread the count in from the refresh step's own output to build a floor
check.

The architecture map header already prints `Symbols: N` — so the two surfaces
disagreed about whether the corpus was worth stating.

### 1.3 The report never says which store it read

The only evidence was a debug line from
[`db/client.mjs`](../../scripts/lib/db/client.mjs)'s `announceStore`:

```
[db/client] store d5a9d07b91225a93 (db=audit_loop)
```

— thousands of lines away, in a different CI step. Distinguishing the two runs
meant noticing that an eight-hex digest had changed, across an hour and two
separate log files.

Having more than one store reachable is a **supported** configuration: a repo
`.env` and a shared `~/.audit-loop.env` may name different databases, and which
wins depends on §1.1's precedence rule. A supported ambiguity has to be resolved
in the output.

### 1.4 The debt ledger's persistence contract was assumed, not checked

[`debt-ledger.mjs`](../../scripts/lib/debt-ledger.mjs)'s header said the ledger
*"is committed, human-approved state"*. `debt-memory.mjs` had already been
corrected on the same premise earlier that day — local 106 entries, cloud 136,
overlap 69, **37 entries on exactly one disk** — but the correction did not reach
the module a reader actually opens to find out what the file is.

The consumer then paid the same cost independently: `.gitignore` carries
`.audit/`, the 8 entries `/audit-code` captured lived only in the worktree that
captured them (the main checkout still showed the original 34), and their own
ownership overlay went beside the ledger *on the strength of that sentence*,
where it was silently never committed and the tool requiring it exited non-zero
in every checkout but the one that built it.

It is a claim about the consumer's git configuration, made by a file that cannot
see it — and `git check-ignore` is already in this toolchain.

---

## 2. Design

### 2.1 An empty DSN is the AIR-GAP signal — preserve it, and say so

**The fix in the report was implemented, and the suite refuted it.** Flipping the
precedence — empty counts as absent, shared file wins — made **31 tests across
20+ suites** fail. Not incidentally: `tests/helpers/air-gap.mjs::airGapDbUrl()`
exists to set *both* DSN keys to `''` so a suite *"must never resolve to a real
database"*, and 20 test files use that idiom, several of which
`DROP SCHEMA public CASCADE`. The flip pointed them at whatever store the
developer's `~/.audit-loop.env` names.

So the design claim I wrote first — *"nothing in this codebase gives an empty
value that meaning"* — was false, and I had asserted it without checking. **An
explicitly-empty DSN is this codebase's established "cloud off" signal.**

The two requirements are the same literal state and cannot both hold:

| | wants |
|---|---|
| CI (§1.1) | empty-because-a-secret-was-missing ⇒ fall back to the shared DSN |
| air-gap | empty-because-I-said-so ⇒ never resolve a DSN |

The one that loses must not be the one protecting production, so what ships is:

1. **An explicitly-empty DSN suppresses the whole DB group**, not just the DSN —
   `dsnExplicitlyEmpty` joins `higherHasDsn` in one `skipDbGroup` predicate. This
   is the coherence fix §1.1 actually identified, in the direction the codebase
   relies on: no more shared SSL mode attached to a deliberately-absent DSN.
2. **The state is announced with its remedy** — *unset the variable rather than
   setting it to `""`*, naming the Actions `env:` shape that produces it. Emitted
   only when the shared file actually had a DSN to offer, so an air-gapped run
   with no shared DSN stays quiet.
3. **The real fix for §1.1 is §2.3.** The reporter said it themselves: *"Items 2
   and 3 … would have made the incident self-diagnosing in the first minute
   rather than the third hour."* A drift report that prints `Store: unknown` ends
   this debugging session immediately, whichever way the precedence goes.

The `(sets: …)` notice still reports what was contributed rather than which names
are new — a correction that survives independently of the precedence decision.

### 2.2 Put the corpus next to the score

`renderDriftIssue` gains `symbolCount`; `arch:duplicates` gains it in both the
JSON envelope and the text render, including the zero-cluster sentence — which is
the exact string the incident produced.

`null` renders `unknown`, never `0` and never an omitted line. That distinction is
the entire point: *nobody looked* must not be able to wear *looked, found nothing*'s
clothes. `0` stays a real, measured answer (`Number.isFinite`, not truthiness).

`drift.mjs` already called `countSymbolsForSnapshot` — but inside the pragma block,
conditional on the repo containing `@duplicate-justification` pragmas, and only to
size a candidate pool. The count is hoisted to one call per run, so the number the
report prints and the number the cap compares can never disagree.

An **unmeasurable** total fails the cap **closed**, and that lives *inside*
`isPragmaPoolCapped` — not at the call site, where the first version put it. The
predicate's own docstring says it is "the ONE thing `main()` calls to decide
`capped`", and a `totalCount === null ||` guard in the caller quietly made that
two things. It also reads as a bug from the function alone, which is exactly how
the Gemini gate reported it: `null > CAP` is `false` in JavaScript (null coerces
to 0), so the one input meaning *"I could not measure the pool"* was the one most
confidently reporting the pool complete. Behaviour was already correct via the
caller; the structure was not. Now `typeof`/`Number.isFinite` guards it in one
place, `0` stays a real measured total, and each of `null`/`undefined`/`NaN`/
`Infinity`/`'5'`/`{}` is asserted to fail closed — every one of which passes
against a bare `>`.

### 2.3 Name the store — but by fingerprint, not by host

**The reporter's proposed fix is rejected.** They asked for `host:port/database`.
AGENTS.md forbids exactly that: *a store is named to operators by fingerprint plus
the consumers using it, never a hostname — this repo is public and one consumer's
store is corporate.* `dbIdentity` **is** that hostname and stays internal.

What ships is the fingerprint plus the **database name** — which is the
discriminator that would have caught their incident at a glance (`audit_loop` vs
`postgres`) and is not a locator. That is what `announceStore`'s own docstring
already argued; the change is that a second surface now needs it, so the
formatting moves into one exported oracle, `storeDescriptor`, and `announceStore`
consumes it. Two spellings of the same label would be a second thing that can
drift, and equality across surfaces is the whole property.

It lands in the drift report (markdown **and** `--json`), the `arch:duplicates`
output, and the architecture-map header — the last because that document renders
from the cloud `symbol_index` and nothing else in it said which store.

**It is bound to the pool, not re-read from config** (plan-audit R1 H2). A
descriptor resolved separately from the client that ran the query is
structurally a second answer to a question that must have one — the same
"resolved apart" shape AGENTS.md names for endpoint/credential pairs. `getPool()`
records the DSN it opened; `activeStoreDescriptor()` prefers it and falls back to
configuration only when no pool exists. In one process the two cannot diverge
today, so this is not a bug fix — it removes the possibility instead of relying
on an invariant nothing states. Guarded by a child-process test that mutates
`AUDIT_DB_URL` *after* the pool opens and asserts the descriptor does not follow.

The **corpus count** needed no such change, and the finding's claim that it might
is refuted by the source: `drift.mjs` resolves `snap.refreshId` once and threads
that same value to both `computeDriftScore` and `countSymbolsForSnapshot`, so
score and count already describe one snapshot by construction.

### 2.2a A DSN's query string decides where it connects

**The largest thing this work found, and the report never mentioned it.**
`/audit-code` R1 H1 observed that every guard and identity function in the DB
layer read `URL.hostname` / `URL.port` — where a connection string *points*, not
where the driver *dials*. Probed against the installed `pg-connection-string`,
which is the parser `pg` itself uses:

```
postgresql://localhost:5432/db?host=prod.example.com   → host prod.example.com
postgresql://x.pooler.supabase.com:5432/db?port=6543   → port 6543
?host=first.example&host=last.example                  → host last.example
```

Three guards were reading the wrong field, and one of them is destructive:

| Guard | What the override did |
|---|---|
| `assertDisposableDbUrl` | `postgresql://localhost/db?host=prod.example.com` cleared the loopback allowlist. The suites behind it run `DROP SCHEMA public CASCADE`. The allowlist is documented as failing CLOSED; through this door it failed **OPEN**. |
| `assertSafeDsn` | `?port=6543` read as 5432, connecting to the Supabase **transaction** pooler the check exists to refuse. |
| `dbIdentity` / `storeFingerprint` | the fingerprint named the displayed host — a confident label for a database the process never talked to, which is precisely the defect §2.3's store line was added to prevent. |

In scope by **impact**, not authorship: this plan's contribution is a report line
built on `dbIdentity`. Fixed with one oracle, `effectiveDbTarget`, routed into
all five DSN parse sites plus the external `isDisposableDbHost` consumer.

**A hand census is not a census.** Step 3.7's detector could not run here (`rg`
absent on this machine — recorded as `unverifiable`, never as clean), so the
class was enumerated with `grep` at the detector's own globs. That found **two
more instances the finding never cited**: `assertDisposableDbUrl`'s *error
message*, which printed the displayed host while refusing on the effective one —
a message contradicting its own decision — and `describeDatabase`, whose whole
job is telling a reader which DSN a printed `--migrate` would target.

**Then the fix reproduced the class it was fixing — twice.** R2 caught
`searchParams.get()` taking the *first* duplicate parameter where the driver
takes the *last*, so `?host=127.0.0.1&host=prod.example.com` read as disposable
and dialled prod. R3 caught the repair for *that*: scanning backwards for the
last **non-empty** value, where the driver takes the last value verbatim and
treats an empty one as *no override* — so
`postgresql://prod.example.com/db?host=127.0.0.1&host=` resolved to the loopback
host while connecting to prod. **The same fail-open, three times, each one a
layer deeper.** R2's regression test asserted the wrong behaviour, so it pinned
the defect rather than the contract.

**The root-cause fix was to stop hand-writing the expectations.** Every round of
this was decided by probing `pg-connection-string`, so the case-by-case
assertions are now backed by a **differential test** comparing
`effectiveDbTarget` against the driver's own parser across eleven DSN shapes.
The contract is literally *"resolve what the driver would resolve"*; hand-written
expectations were a test of my reading of it, which is the thing that was wrong
each time.

**The oracle is resolved THROUGH `pg`, not imported by name.** The first attempt
imported `pg-connection-string` directly and declared it in `devDependencies` to
satisfy `knip:gate` — which quietly reintroduced the very shape the change
exists to close. The oracle is not *some copy* of the parser; it is **the copy
`pg` parses with**. A declared version, or a strict (pnpm-style) `node_modules`,
could hand the test a different parser while the driver used another, and it
would keep passing against the wrong thing. Resolving via
`createRequire(require.resolve('pg')).resolve('pg-connection-string')` makes that
unrepresentable, and needs no declaration — `knip` is clean either way. Two
guards sit on it: an assertion that the resolved module actually exports
`parse`, and a behavioural probe that it parses like `pg-connection-string`. The
first fired immediately — CJS reached by absolute path exposes `parse` on
`.default`, so without it every comparison would have run `undefined` against
`undefined` and reported green.

**Six rounds, six real defects, one class.** Each was a different way of asking
*where does this DSN actually connect*, and every one was settled by probing the
driver rather than reasoning about it:

| Round | Defect | Consequence |
|---|---|---|
| R1 | `URL.hostname`/`URL.port` read instead of the effective target | `?host=` cleared the DROP-SCHEMA allowlist; `?port=6543` reached the transaction pooler |
| R2 | `searchParams.get()` takes the **first** duplicate; the driver takes the last | `?host=127.0.0.1&host=prod` read as disposable |
| R3 | scanned back for the last **non-empty**; the driver takes the last verbatim | `?host=127.0.0.1&host=` read as disposable |
| R5 | port compared as a string; `?port=06543` ≠ `'6543'` | padded ports bypassed the pooler refusal, and one store had two fingerprints |
| R6 | `Number()` where pg uses `parseInt(v, 10)` | `?port=6543abc` → `NaN` for us, **6543** for the driver |
| Gate | `?dbname=` challenged as an override | **refuted** by measuring `ConnectionParameters`: a pathless DSN falls back to the OS *username*, not `dbname` |

The census also found two sites no finding cited — `assertDisposableDbUrl`'s
error message, which printed the *displayed* host while refusing on the effective
one, and `describeDatabase`, whose whole job is naming the DSN a printed
`--migrate` would target.

**Scope, stated rather than implied.** `effectiveDbTarget` resolves the two
overrides the shipped parser applies to a URL-form DSN. It is deliberately not a
libpq reimplementation: `PGHOST`/`PGPORT`, `service=` files and multi-host DSNs
are named in the docstring as unresolved. One further gap is recorded rather than
closed: a **pathless** DSN connects to a database named after the OS user, and we
report "no database" instead. Mirroring that fallback would make the identity
depend on `process.env.USER`, so two machines would fingerprint one DSN
differently — destroying the cross-machine equality the fingerprint exists for.
A half-done version that looked complete would be worse than one that says where
it stops.

### 2.3a The output contract (what `store` and `symbolCount` actually are)

Stated because three human renderers and two JSON envelopes consume them, and an
undefined contract lets each serialise the same provenance differently
(plan-audit R1 M1):

| | Contract |
|---|---|
| internal shape | `{fingerprint: string, database: string, label: string}` — safe fields only; `dbIdentity`'s host:port form never appears |
| unavailable | `null` — for no DSN and for an unparseable one alike |
| JSON envelopes | the **structured object**, never the display string, so a consumer cannot couple to presentation; `symbolCount` is `number \| null`, and both keys are always present |
| human renderers | the single `label` formatter; `null` → the literal `unknown`, never `0` and never an omitted line |
| `symbolCount: 0` | a real measured answer, distinct from `null` (`Number.isFinite`, not truthiness) |

**Not versioned.** The recommendation asked for a versioned contract; no consumer
requires one, and a version field nothing reads is the over-engineering cliff.
The single-formatter property is asserted directly instead —
`db-store-announcement.test.mjs` fails if `(db=` is composed in more than one
place.

### 2.3b Stream contract for the two new advisories

Both new diagnostics — the empty-DSN notice and the ledger durability warning —
go to **stderr** with exactly one trailing newline; stdout stays reserved for a
single JSON value (plan-audit R1 M2, repo invariants `REQ-behavioural-44427de3` /
`-d193bf6e`, both verified present in `.requirements/ledger.json`). This matters because both fire on paths that *also* have `--json`
output, and an in-process assertion on the message text cannot see the
difference: a `console.log` would satisfy it and still break every scheduled CI
consumer parsing stdout. Verified by a child process that triggers the advisory
and parses the real stdout, plus a template check (with a vacuous-pass guard)
that every `process.stderr.write` in the two modules ends in `\n`.

### 2.4 Check the ledger's contract instead of asserting it

`assertLedgerDurability` warns — once per process — when the ledger's own path is
ignored **and** untracked, via the existing single oracle
[`ignoredUntrackedPaths`](../../scripts/lib/disowned-paths.mjs).

**The header correction had to be corrected too** (plan-audit R1 H1). The first
repair replaced *"committed, human-approved state"* with *"a machine-local cache;
the cloud store is the source of truth"* — **a second false universal**.
`debt-memory.mjs` chooses the authoritative source **per run**: cloud when
`isCloudEnabled()` and a repo id resolves, local otherwise. And local mode is not
hypothetical — it is the mode the incident that prompted this whole change was
in, logging `Cloud store not configured — using local mode`. There, this file is
not a cache of anything; it is the only copy that exists, and an operator told
their state is safe elsewhere would be reading the original defect with its
polarity flipped.

So the module now asserts only what it can CHECK. The header says the file is not
committed state and that *which* copy is authoritative is `debt-memory.mjs`'s
per-run decision, not this module's to declare. The advisory states the one fact
the probe proves — this path does not survive a checkout — then names the
discriminator (`AUDIT_DB_URL`) instead of asserting a cloud copy exists:

> `[debt] <path> is gitignored and untracked — entries written here do not
> survive this checkout. Whether that costs you anything depends on which source
> this run is using (see debt-memory.mjs): with a cloud store configured
> (AUDIT_DB_URL) this file is a local mirror; without one it is the ONLY copy.
> To keep a committed copy, un-ignore this path.`

**Rejected as over-built:** the finding's remedy asked for an explicit
persistence-mode contract with a synchronization-outcome API and tests for
local-only / cloud-synchronized / cloud-write-failed. The defect is that a module
announced a fact it had not checked; the fix is to stop doing that. A mode
subsystem no current requirement needs is the other cliff — and `debt-memory.mjs`
already owns the mode decision, so a second owner would recreate the
two-sources-of-truth problem this plan exists to close.

**But declining to OWN the mode is not the same as declining to ACCEPT it**, and
the Gemini gate was right to fault the first version for conflating them. A
warning that fires whenever the ledger is gitignored fires on the **correctly
configured** setup — cloud authoritative, local file a mirror, gitignored
exactly as intended — which is the common case in this repo and every consumer.
A warning on the happy path is how operators learn to skip warnings, including
the ones that matter.

`assertLedgerDurability` therefore takes a tri-state `cloudMirrored` hint,
**propagated** from `debt-memory.mjs::selectEventSource` (which already decided
it) and never computed locally:

| hint | behaviour |
|---|---|
| `true` — a cloud copy exists | **silent**; gitignored is the intended state |
| `false` — local mode | **loud + actionable**: "these entries exist ONLY in this checkout"; the state the consumer incident was actually in |
| omitted — unknown | states the fact and names `debt-memory.mjs`, with **no imperative** — prescribing a fix for a setup that may be correct is the nag |

All three directions are tested, including the one it must **not** fire in.

**Warn, never refuse.** Ignored + cloud-as-source-of-truth is the *supported*
configuration, so failing the write would break the correct setup. What was
missing was visibility, not permission — the band-aid here would have been to fix
the sentence and leave the contract unverifiable.

**The sentence was in three places, not one.** Correcting only the header the
report quoted would have left the claim standing where a consumer actually meets
it: `debt-review.mjs` printed *"`debt-resolve.mjs` removes the entry from the
**committed** ledger"* in its operator-facing output, and `debt-resolve.mjs`'s own
header said the same. Both now say *local*. (`.requirements/ledger.json` genuinely
is committed — the other "committed ledger" references in the tree are about that
one and are correct.)

**One quiet cost of adding the check**, caught by the suite: the ownership oracle
writes its own stderr warning on a degraded probe, so outside a git work tree
every temp-dir ledger write began emitting an unrelated `[disowned-paths] WARN:`.
`ignoredUntrackedPaths` gains `warnOnDegraded` (default `true`, so no existing
caller changes). The distinction it encodes: warn loudly when the probe's RESULT
is the judgement being reported; stay quiet when it only decides whether to print
the caller's own advisory — there, `degraded` already says everything.

Three properties the predicate must have, all locked by test:
- **ignored AND untracked**, not merely ignored — `git check-ignore` reports a
  committed file as ignored whenever a pattern matches it, so an ignore-only test
  would cry wolf at exactly the repos that got it right;
- **degraded ≠ durable** — outside a work tree it stays silent rather than
  warning or reassuring;
- **never blocks the write**, proven by driving the real `writeDebtEntries`.

---

## 3. Files

| File | Change |
|---|---|
| `scripts/lib/load-shared-env.mjs` | `dsnExplicitlyEmpty` + `skipDbGroup`; the empty-DSN notice; `contributed` replaces the key-name diff |
| `scripts/lib/db/client.mjs` | `storeDescriptor` exported; `announceStore` consumes it; `_activeDsn` recorded at pool init + `activeStoreDescriptor`; **`effectiveDbTarget`** + its four consumers; `storeFingerprint`'s privacy claim corrected |
| `scripts/lib/db/schema-realization.mjs` · `scripts/postgres-parity/generate-expected-schema.mjs` | the two remaining DSN parse sites, found by the census rather than by a finding |
| `scripts/lib/store/repo.mjs` | `getActiveStoreDescriptor` — the barrel accessor the arch CLIs use |
| `scripts/lib/arch-render.mjs` | `renderDriftIssue` + `renderHeader` take `symbolCount` / `store` |
| `scripts/symbol-index/drift.mjs` | hoisted count, store descriptor, both in markdown + `--json`; null total fails the pragma cap closed |
| `scripts/symbol-index/duplicates.mjs` | `symbolCount` + `store` in the envelope and both text branches; `renderText` exported for test |
| `scripts/symbol-index/render-mermaid.mjs` | passes `store` to the map header |
| `scripts/lib/disowned-paths.mjs` | `warnOnDegraded` option (default true — unchanged for every existing caller) |
| `scripts/lib/debt-ledger.mjs` | header corrected; `assertLedgerDurability` + `_internals` |
| `scripts/debt-review.mjs` · `scripts/debt-resolve.mjs` | the same false "committed ledger" claim, in operator-facing output and a header |
| `docs/plans/postgres-parity-contract-matrix.md` · `tests/learning-store-exports.test.mjs` | the barrel's frozen surface, 198 → 199 |
| `package.json` · `package-lock.json` | **unchanged** — a `pg-connection-string` devDependency was added and then removed; see §2.2a, the test resolves the parser through `pg` instead |
| `AGENTS.md` | the store-naming bullet gains the oracle, the corpus rule, and the air-gap invariant |
| `tests/shared-env-loading.test.mjs` | cases 9–14 (air-gap preserved via either key, whole-bundle suppression, unset control, notice, silence control) |
| `tests/db-store-announcement.test.mjs` | re-anchored on `storeDescriptor`; + the label is composed in exactly one place |
| `tests/drift-signal-attribution.test.mjs` | **new** — descriptor, pool-binding, both renderers, duplicates text, stdout/stderr separation |
| `tests/debt-ledger-durability.test.mjs` | **new** — fires, does-not-fire, degraded-and-silent, warn-once, wired |

### 3.1 Layering

The first draft imported `db/client.mjs` from the three `symbol-index` CLIs and
produced **3 `arch-memory -> stores` violations** —
`.audit-loop/domain-map.json` lets `arch-memory` depend on `learning-store` and
`shared-lib`, not on `stores`. `tests/arm-vocabulary-layering.test.mjs` caught all
three. Resolved by the *refactor* half of AGENTS.md's **refactor > retag >
declare** order: `getActiveStoreDescriptor` lives in `lib/store/repo.mjs` (which
already imports the client) and reaches the CLIs through the barrel they already
depend on. No `allowedDeps` edge was added.

## 4. Acceptance criteria

1. An explicitly-empty DSN — via **either** `AUDIT_DB_URL` or the
   `AUDIT_POSTGRES_URL` alias, since `airGapDbUrl` blanks both — resolves to
   `null` and suppresses the entire DB group. An **unset** DSN still adopts the
   shared one (negative control: without it, "empty air-gaps" and "the shared
   layer never contributes a DSN" pass identically). ✅
2. `AUDIT_LOOP_DISABLE_SHARED=1` still suppresses the shared layer. ✅
3. The empty-DSN notice names the remedy, and stays silent when the shared file
   had no DSN to offer. ✅
4. The drift report states a symbol count and a store; `null` renders `unknown`,
   `0` renders `0`. ✅
5. No surface publishes a hostname, port, or credential; the label is composed in
   exactly one place. ✅
6. The ledger warning fires on ignored+untracked, stays silent on tracked and on
   degraded git — emitting **no** unrelated warning there either — and never
   blocks a write. ✅
7. No new layering violations — `node --test tests/arm-vocabulary-layering.test.mjs`
   → `6 pass / 0 fail`, including its own vacuous-pass guard. ✅
8. **Every gate in the pre-push `check`**, not only the suite — the AGENTS.md edit
   is subject to a hard 92,000-character cap that `npm test` cannot see
   (plan-audit R1 M3). Measured after the edit: `npm run context:check` →
   `OK  No context drift detected`, AGENTS.md at **90,735 / 92,000 characters
   (1,265 left)**, advisory-only headroom note. Also green: `docs:check`,
   `docs:refs:gate`, `plans:lint`, `plans:index:check`, `plans:status`,
   `skills:check`, `knip:gate`, `size:ratchet:gate`, `cli:flags:gate`,
   `emit:exit:gate`, `gitignore:policy:gate`, `db:enrolment:gate`,
   `parity:check-coupling`, `upstream:coverage:gate`, `arch:coverage-gate`.
   (`status:integrity:gate` fails only while nothing is committed — it resolves
   `--base` to HEAD and refuses to compare a range against itself.) ✅
9. Full suite: `node scripts/run-tests.mjs` → **15,069 tests, 15,030 pass,
   0 fail, 39 skipped** (measured 2026-09-04). A bare "suite green" was the
   claim-without-a-command this plan's own §1 complains about. ✅
10. Live-verified on this repo's real store, not only in unit tests
   (AGENTS.md §pre-ship empirical verify). `node scripts/symbol-index/drift.mjs`
   printed `Store: d5a9d07b91225a93 (db=audit_loop)` and
   `Corpus measured: 5324 symbols` beside `Drift score: 74 / threshold 20`;
   `duplicates.mjs` printed `snapshot: 5324 symbols   store: …` in the text
   render and carried `symbolCount` + `store` in the `--json` envelope. ✅

## 5. Not in scope

The four things the reporter explicitly declined to file as upstream bugs
(`run-guarded-tests.mjs`'s unchecked remedy — verified repo-owned; a repo-wide
`concurrency: group`; CI timing budgets under workstation memory pressure; which
of their two databases is authoritative) are theirs, and the line was drawn
correctly.
