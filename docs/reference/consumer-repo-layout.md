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

## Six shapes consumers keep reporting

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
