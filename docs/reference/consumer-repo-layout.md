# Consumer-repo layout — the dossier

**What it is**: the detail behind AGENTS.md's *Consumer-repo layout (isolation)*
section — the recurring defect shapes consumers report, and how "is this file
mine to fix?" is answered offline.

**When you need it**: adding a gate or a nudge that will reach a consumer;
triaging an upstream report; or changing how ownership is decided.

**Why it lives here**: AGENTS.md is loaded every session and enforced at
92,000 characters. Its own rule is that subsystem-grade depth belongs in `docs/`
behind a short stub, and that condensing is the remedy rather than shaving
words. This file is that condensation; the load-bearing invariants stay inline
there.

---

## Seven shapes consumers keep reporting

Check for these when adding a gate or a nudge. Each was measured in a real
consumer repo, and each has a gate now.

### 1. A read handing back a key its writer rejects

A close-this-row nudge that renders an identifier the corresponding writer will
not accept. A new nudge means a new row in
[`view-writer-key-contract.test.mjs`](../../tests/view-writer-key-contract.test.mjs)
— the contract is only real where something compares the two spellings.

### 2. A gate judging files the repo does not own

The predicate is **ignored AND untracked**, asked of the **candidates**, never
of the repo. `git check-ignore` reports a *tracked* file as ignored whenever a
pattern matches it, so ignore-status alone stops judging committed files that
happen to match one. Asking it of the whole repo instead of the candidate set
enumerates `node_modules` and dies past `spawnSync`'s buffer.

### 3. A check verifying one direction only

Of any set comparison ask: **which side am I iterating, and what is
unrepresentable from it?** A walk over declared entries can never see an
undeclared one; a walk over the filesystem can never see a declaration with no
file.

### 4. A documented command whose tooling cannot be present where it runs

**Only tracked content reaches a linked worktree**, so a remedy that lives in a
gitignored directory is absent exactly where the failure occurs. A remedy must
ride on `package.json`. Gate: `npm run worktree:preflight:gate`.

### 5. A synced SKILL.md naming an `npm run` alias or an out-of-closure `docs/` file

Claims about another repo that nothing can make true — the sync never adds npm
scripts, and `--if-present` **exits 0 having run nothing**, so the failure is
silent. **Name synced tooling by path**: `node scripts/<name>.mjs`. Gate:
`npm run skills:consumer-refs:gate`, a ratchet.

### 6. A relative link in synced markdown

An href resolves where the file **lands**, and the sync changes its depth — 47
were dead in `.claude/skills/**` and in every consumer while resolving correctly
from `skills/**`. The two gates above read `docs/…md` *tokens* and see no href
at all, which is why this shape survived both. Use an absolute upstream URL
unless the target is inside `skills/`. Gate: `npm run docs:synced-links:gate`.

### 7. A synced SKILL.md resolving its own subject through the SHELL

`/ship-checked` Step 0.5a read the persona P0 gate as
`persona-outcomes summary --repo "$PERSONA_TEST_REPO_NAME"`. A Claude Code
session inherits neither the consumer's `.env` nor `~/.audit-loop.env`, so the
variable was unset in the shell and the flag arrived **empty**; on Windows the
PowerShell form (`$env:NAME`) differs again, so the same line is empty there for
a second, independent reason. The only place the value reliably lived was
`settings.json`'s `env` block — which the sync owns and overwrites.

Measured in a consumer 2026-09-07: the store held a 2026-08-25 session with
**2 open P0 and 2 P1**, and every ship since had printed `gate silent` — a phrase
that means *no session exists* being used to report *nobody asked*. The
consumer's own `/persona-test` had resolved the repo from
`git remote get-url origin` since its Phase 0c; only the gate had not.

Two rules, and the second is the one that generalises past this bug:

- **A synced SKILL.md may not interpolate an env var into a command.** The
  runner already loads `.env` (`lib/load-env.mjs`); let the CLI read the
  variable, and document the command **bare**. Anything the prose expands is
  resolved by whichever shell the host happened to spawn.
- **A gate's subject is resolved by a CHAIN that ends in `measured:false`, never
  in a refusal and never in a zero.** `--repo` → env → ambient `git remote` →
  `{measured:false, reason}`. `persona-outcomes summary`,
  `persona-outcomes --worksheet` and `get-persona-sessions-by-repo` all take
  that chain (scope mode `explicit-preferred`) and echo
  `scope:{mode,repoId,slug}`, so an unmeasured gate is visible in the ship
  transcript. An explicitly-NAMED repo still wins over the ambient checkout, and
  an unknown name is still an error — the fallback must never rescue a typo into
  an answer about a different repo (F4/F10).

Writes keep requiring `--repo`: `persona-outcomes label` derives its repo from
the addressed session, and `backfill-hash` validates the flag before resolving.
No gate; the shape is pinned by `tests/cross-skill-store-calls.test.mjs`
("the ambient READ fallback") and `tests/cross-skill-scope-resolver.test.mjs`.

---

## Consumers are not all on ONE store

A consumer files into whatever store ITS `AUDIT_DB_URL` names — not this repo's.
So a single-store read is blind to a consumer *and renders that blindness as good
news*: `/ship-checked` printed `0 open` against a consumer holding **8** open reports,
four of them HIGH. **An unasked question must never render as an empty result.**

`npm run upstream:queues` (and `npm run stores:drift`) fan out over every
registered consumer, resolving each one's store the way that consumer's own
tooling does — its `.env`, then the shared `~/.audit-loop.env` — and deduping by
`storeFingerprint` so repos sharing a store are asked once. Read the
`unqueried` / `no store` lines: a store nobody could reach and a consumer whose
DSN would not resolve are reported explicitly rather than counted as zero, and
when NO store answers the card says `NOTHING WAS CHECKED`.

**A store is named to operators by fingerprint + the consumers using it, never a
hostname.** This repo is public and one consumer's store is a corporate internal
host. `storeDescriptor` is the one oracle for that rendering, and it rides beside
a symbol count in the drift report and the map header.

**An EMPTY DSN env var is the AIR-GAP signal**, not a misconfiguration —
`airGapDbUrl`, relied on by 20 suites, some of which `DROP SCHEMA`. Never "fix" it
by falling through to `~/.audit-loop.env`; say so loudly instead.

**A verdict names what it was measured FROM — the population line.** A verdict
computed from N stores reads as one about everyone, so every cross-store verdict
writer (`STORE_VERDICT_WRITERS` in `scripts/lib/population.mjs`) prints
`Population: measured from 2 stores — <fp> (<alias>, <alias>), … Not measured: <alias>
(<reason>). …` and carries the `population/v1` object in its JSON. Labels are
registry aliases and 8-hex store fingerprints, never repo names or hostnames (the line
is pasted into public `docs/research/`). A consumer that declares
`"upstreamReachable": false` in `.audit-loop/store-setup.json` is never queried and is
listed `unreachable-by-policy`; a figure it reports by hand is a separate
`Consumer-reported, unverified (not pooled)` entry, never added to a store count. In a
consumer, where the registry's private half is absent, the line says
`other consumers: not known here` rather than claiming "all". `tests/population-writers.test.mjs`
and `tests/research-population-line.test.mjs` enforce it (a census over the filesystem for
a store-reading CLI no registry names; each `docs/research/*.md` needs a line, a
`<!-- population: not-store-derived — <reason> -->` marker, or a hash-pinned grandfather entry).

**Triage against the store that owns the row.** `upstream ack|fix|wont-fix` writes
to the ambient `AUDIT_DB_URL`, which is only one of them — run the transition with
that consumer's DSN in the environment, and use the FULL uuid (a prefix resolves,
but the committed disposition ledger records what you typed and
`upstream:coverage:gate` rejects a non-uuid key).

---

## Declared divergence — overrides, and the pin guard

The three-way base is below; these are the rules around it.

**`.sync-overrides.json` is committed, and every entry needs a `reason`.** A
malformed file **ABORTS** the sync rather than failing open — an override file
nobody can parse must not silently become "no overrides". `scripts/.claude-skills/**`
may never be claimed: a defect there is an upstream report, and holding it would
freeze the bug locally for one consumer while leaving it live everywhere else.

Once upstream's version of a held path changes, the sync reports `upstreamMoved`
on every run. Review those rather than letting an override go quietly stale — an
override whose justification has been fixed upstream is exactly the state a
`/ship-checked` should retire (measured 2026-09-07: storyline's `.claude/settings.json`
hold, whose stated reason named a shell-expansion defect that upstream had since
removed).

**Adding a co-owned config? A merge may never move a launcher from a pinned path
to an unpinned fetch.** `sync-pin-guard.mjs` is the guard, and it is paired with
an independent post-condition rather than trusted alone — a guard that is also its
own verifier cannot report its own absence.

### Block holds — keep one block, not the whole file

**Need one repo-specific block inside a synced SKILL.md? Declare a block, not a
whole-file override.** A whole-file hold stops every upstream fix to that skill
(measured 2026-11-28: four held SKILL.md files had drifted 51–692 lines to keep
one inserted adapter block each). A block hold keeps only the block:

- **Upstream** declares where a block may go with one line in its own source,
  `<!-- sync-slot:<name> -->` (column 0, outside frontmatter and fenced code, once
  per name; linted by `scripts/check-skill-slots.mjs` in `skills:check`). Today:
  `target-adapter` in click-test, nav-audit, persona-test and visual-audit.
- **The consumer** commits a fragment file (by convention `.sync-blocks/<skill>.<slot>.md`)
  and declares it in `.sync-overrides.json`:
  `"blocks": [{ "path": ".claude/skills/nav-audit/SKILL.md", "slot": "target-adapter", "from": ".sync-blocks/nav-audit.target-adapter.md", "reason": "…" }]`.
- **The sync** splices the fragment's bytes in verbatim (after the command
  rewriter, so a consumer's own command lines are never rewritten), as a
  `sync-slot:<name>:start` … `:end` span, on every run. The rest of the file keeps
  receiving upstream, the manifest records the spliced bytes as the base, and
  `sync-isolation-verify` gate 2B checks the file like any other.

**A block is never silently dropped.** A declared slot upstream no longer has
(`slot-missing`), a duplicated or misplaced marker, a fragment that cannot be read,
or a declaration for a path this repo is never sent (`block-dest-unknown`) FAILS
the file or the target with a non-zero exit, leaves the consumer's file as it is,
and is recorded in the receipt's `blockErrors`. A slot that MOVED under another
heading still lands and is reported (`anchorMoved`, heading-level only).
**Supported markup:** a fragment, and any upstream file that carries a slot, may
contain no block-level raw HTML except a comment that closes on its own line
(delimiter comments such as `<!-- my-adapter:start -->` are fine; inline HTML
mid-line is fine), because an open HTML block would run past the slot boundary.
Edit the
fragment, never the spliced span: a hand edit of the span is a divergence and is
refused like any other. Migration from a whole-file hold:
[consumer-adoption.md](../runbooks/consumer-adoption.md) §Migrating a whole-file
hold to a block hold. Design: [plan](../plans/sync-skill-block-holds.md).

---

## "Is this file mine to fix?" must be answerable OFFLINE

Three ownership signals, each with a hole:

| Signal | Hole |
|---|---|
| git-ignore state | misses `.claude/hooks/**` and `.claude/skills/**` — consumers **commit** them |
| the content banner | misses both too: a `SKILL.md` cannot carry one, because frontmatter must be the first bytes |
| `scripts/.sync-manifest.json` | covers everything, but is gitignored on both sides and therefore absent from CI |

**What the gap cost, measured.** A consumer's duplication gate read **32
violations / 1 mixed-owner without the manifest, 31 / 0 with it**. The extra one
was this bundle's own `readStdin` across three hooks — reported to them as their
code to fix.

**The fix.** Every sync writes the **committed** `scripts/.sync-owned.json` — a
path SET only, no clock or sha, so it is a category-B artifact — and
`createUpstreamOwnershipOracle` unions it with git-ignore state as the one
predicate.

**Compare case-insensitively.** A ledger citing `skill.md` against a manifest
spelling `SKILL.md` misfiled six upstream-owned entries as the consumer's own
work.

**`debt:review` partitions on it.** Upstream-owned entries are LISTED but never
leverage-ranked, because the only action the CLI offers (`debt-resolve.mjs`)
*deletes* the record of a still-open defect.

---

## `skills:hydrate` cannot run in CI, by construction

**The diagnosis.** In a plain clone — what `actions/checkout` produces — the git
common dir IS the clone, so `skills:hydrate` resolved the clone as its own main
checkout, found "nothing to do", and exited **0 having copied nothing**. The next
`arch:*` step then died on a bare `MODULE_NOT_FOUND`, which named the missing
module rather than the reason it was missing.

**What it does now.** It FAILS in that situation and names the real remedy:

```bash
npx github:Lbstrydom/claude-engineering-skills .
```

It also accepts `--from <path>` / `SKILLS_SOURCE` for a runner-local checkout of
this repo, which is the correct shape when CI already has one on disk.

**The generalisation.** Hydration copies from a *main checkout* into a *linked
worktree*; a clone is neither, so the predicate that distinguishes them had no
answer and returned the benign one. A resolver whose "no work to do" branch and
its "I cannot tell" branch share an exit code will report the second as the
first.

---

## Consumer divergence — the three-way base

`disk === base` (the manifest hash) means the sync may overwrite freely;
`disk !== base` is consumer content. Basing the comparison on the **manifest**
rather than on HEAD is what stops it firing on ordinary updates — a HEAD-based
base treats every upstream change as consumer divergence.

`.sync-receipt.json` is a deliberate exception to the generated-artifact policy:
it is committed because **its dirtiness is the only evidence a sync ran**, the
sync never commits on the consumer's behalf. It is append-only (newest-first)
because a second sync used to erase the first, which is precisely the evidence
the file exists to preserve.

---

## The CLI smoke contract (`--selfcheck-relocation`)

> Condensed out of `AGENTS.md` on 2026-11-15; the two imperatives (implement the
> handler in `CLI_SMOKE_SET` scripts; use `isInvokedAsScript`, never a hand
> comparison) stay resident there.

A synced CLI runs from a **different absolute path** than the one it was written
at, so every top-level CLI script that needs to prove its imports survive
relocation implements, at the head of `main()`:

```js
if (process.argv.includes('--selfcheck-relocation')) { console.log('OK'); process.exit(0); }
```

Today: `check-setup.mjs`, `doctor.mjs`, `cross-skill.mjs`, plus the others in
`CLI_SMOKE_SET`. The CI guard fails if a `CLI_SMOKE_SET` script lacks the handler.
Library modules (no `main()`) cannot carry it, so they get an import-test in
[`tests/relocation-guard.test.mjs`](../../tests/relocation-guard.test.mjs) instead.

### The entry guard is `isInvokedAsScript`, never a hand comparison

The guard itself is `if (isInvokedAsScript(import.meta.url))`
([cli-entry.mjs](../../scripts/lib/cli-entry.mjs)). A hand comparison of
`process.argv[1]` with `import.meta.url` is wrong: Node realpaths one side and
not the other, so **through a symlink or junction the hand guard is false and the
CLI exits 0 having run nothing** — 16 of 26 did, measured 2026-10-13.

No smoke run goes through a link, so the smoke contract above cannot catch this.
The census in [`tests/cli-entry-guards.test.mjs`](../../tests/cli-entry-guards.test.mjs)
is what enforces it — the filesystem is the only side that can see a script no
list mentions.
