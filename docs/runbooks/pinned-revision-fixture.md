# Runbook: pinned-revision fixture for spend-bearing runs

**What it is** — a detached git worktree pinned at one explicit commit, with
`node_modules` linked and every provider credential verified, so a long
evidence-collecting run cannot be invalidated by someone else committing while
it runs.

**When you need it** — any run that (a) costs real money, (b) takes long enough
that HEAD can move underneath it, and (c) stamps its evidence with a revision.
Today that is bake-off campaign collection, arm-eval collection, solo-control
sweeps, model-eval harness runs, and multi-hour audit replays. Bake-off is the
only one wired in so far; the fixture itself is generic.

**Why it exists, measured** — a bake-off snapshot spawns 6 arms over 15–25
minutes and the campaign store refuses a snapshot whose arms disagree about the
commit ("one snapshot is one revision"). Two snapshots and ~$13 of provider
spend were destroyed on 2026-08-17: once by a rebase mid-collection, once by a
**concurrent agent session** committing while collection ran. Several sessions
routinely work this repo in one shared working tree, so "be careful" is not a
control.

**Cross-agent.** Everything below works from Claude Code, Codex CLI, GitHub
Copilot, Cursor and Windsurf. Nothing here depends on a Claude-specific hook,
directory or setting — the fixture explicitly suppresses the repo's
`post-checkout` hook so a non-Claude user does not inherit Claude-specific side
effects.

**Design + rationale**: [`docs/plans/pinned-revision-fixture.md`](../plans/pinned-revision-fixture.md).

> **Every command below pastes as-is.** Real values, never `<angle-brackets>` —
> PowerShell reserves `<`, and an unpasteable example is an example nobody runs.
> Substitute your own fixture name, revision and campaign id.

---

## The three steps

```
create ──▶ (run your long job in the fixture) ──▶ remove
             verify at any time
```

## 1. Create

From the main checkout:

```bash
npm run fixture:create -- --name bakeoff-2026q3 --rev HEAD --campaign final-review-scoped-2026q3
```

The `--` is load-bearing: without it npm eats the flags as its own config.

What it does, in order — and it stops at the first failure, before any spend:

1. Resolves `--rev` to a full 40-char sha **once**. The pin is a commit, never a
   branch: a worktree on a branch follows that branch, which is the same race
   through a different door.
2. `git worktree add --detach` at that sha, with **all hooks suppressed** for
   that one invocation.
3. Links `node_modules` from the checkout that owns it. If the pinned revision's
   dependency set differs, it runs `npm ci` instead — linking there would test
   the pinned code against the wrong dependency tree.
4. Runs the **credential preflight** with `cwd` inside the fixture, so it
   verifies the environment the run will actually see.

If any credential is missing it prints what and why, **removes the
half-made fixture, and exits non-zero.** Nothing is spent.

```
credential preflight FAILED for campaign final-review-scoped-2026q3 — 1 of 10 requirement(s) unmet:
  ALIBABA_CLOUD_API_KEY + ALIBABA_CLOUD_BASE_URL
      needed by: arm qwen (qwen3.8-max)
      why: without it resolveShadow returns 'skipped-no-key', the arm records as SKIPPED,
           and the snapshot is rejected after the other arms have billed
```

That refusal is the whole point. A missing key does **not** error at runtime —
the arm records as SKIPPED and the snapshot dies at the completeness check,
after the other five arms have been paid for.

Fixtures default to a sibling of the main checkout,
`../claude-engineering-skills-pinned/<name>`. Override with `--root`.
Use `--install` to force `npm ci` instead of linking.

## 2. Run your job — three things that will otherwise mislead you

Gitignored files are **absent** from a fixture. Three consequences:

### `.env` — handled for you

A fixture has no `.env` of its own and resolves the **main checkout's**
automatically. Verified with a competing stray `.env` in an ancestor directory:
the repository wins over proximity. Nothing to do.

### Transcripts — pass ABSOLUTE paths

`.audit/` is gitignored, so the fixture has none of your transcripts. Pass them
by absolute path from the main checkout:

```bash
node scripts/bakeoff-collect.mjs --transcript C:/GIT/claude-engineering-skills/.audit/transcript.json --plan docs/plans/model-comparison-campaigns.md
```

**Where to look for one**: `.audit/` in the main checkout holds the working
copies (capped at the newest 25 by `audit-clean.mjs`), and
**`.audit/transcripts/` in the main checkout is the durable archive** — every
transcript ever written, including those produced inside throwaway agent
worktrees that no longer exist. Prefer the archive when a transcript you
remember is no longer in `.audit/`. `--transcript` takes any absolute path; the
consumption contract is unchanged. Plan:
[`audit-transcript-durability.md`](../plans/audit-transcript-durability.md).

### Progress — trust the STORE, not the local log

**This one costs people an hour if they do not know it.** The bake-off log path
is repo-relative (`.audit/bakeoff-log.jsonl`) and `.audit/` is gitignored, so a
fixture writes its **own, empty** log. Running `--progress` inside a fresh
fixture reads near-zero **regardless of real campaign progress**, and it looks
exactly like lost work.

It is not. The store is the only trustworthy count:

```bash
node scripts/campaign.mjs reconcile --campaign final-review-scoped-2026q3
```

`npm run fixture:verify` prints the fixture-local entry count beside a label
saying it is not campaign progress, so the two cannot be confused.

### Synced tooling

`scripts/.claude-skills/` is gitignored too, so it is absent. If a command needs
it, run `npm run skills:hydrate` in the fixture first.

## 3. Verify

At any time, from the main checkout:

```bash
npm run fixture:verify -- --name bakeoff-2026q3 --campaign final-review-scoped-2026q3
```

```
Fixture: C:\GIT\claude-engineering-skills-pinned\bakeoff-2026q3
  ok   exists        C:\GIT\claude-engineering-skills-pinned\bakeoff-2026q3
  ok   detached      HEAD is detached — the pin cannot follow a branch
  ok   pinned        606537eef141c457de112bb2c4f33296679044f1
  ok   clean         working tree clean
  ok   node_modules  link -> C:\GIT\claude-engineering-skills\node_modules
  ok   credentials   10/10 present for final-review-scoped-2026q3

  local .audit/bakeoff-log.jsonl entries: 0  <- fixture-local only, NOT campaign progress.
```

The four git properties are reported separately because they fail
independently: a fixture can be detached at the wrong commit, or at the right
commit with a dirty tree that changes what the run reads.

## 4. Remove

```bash
npm run fixture:remove -- --name bakeoff-2026q3
```

Idempotent — removing an already-removed fixture succeeds.

**Do not hand-remove a fixture with `rm -rf` or `git worktree remove` alone.**
Both were measured to leave orphans:

- `fs.rmSync` / `rm -rf` over a tree containing the `node_modules` junction
  fails `EBUSY` and leaves the junction and its parent directory behind.
- `git worktree remove` can fail with `Permission denied` and **still
  deregister** the worktree — a second call says "is not a working tree" while
  the directory is still on disk.

That pair produced the 11 orphaned directories under `.claude/worktrees/` (3
registered), each containing nothing but a dangling junction. `fixture:remove`
unlinks first, tolerates git's failure, prunes the registry, then reconciles
whatever is left on disk.

If the removal fails with `EBUSY` or `Permission denied`, **check whether a
shell is still sitting inside the fixture** — that is the usual cause. `cd`
out and re-run.

---

## Troubleshooting

**"already exists"** — `create` refuses to reuse a directory whose revision it
did not pin. Run `fixture:verify` to see what is there, then `fixture:remove`.

**Tooling inside the fixture behaves like an older version.** It *is* an older
version. A fixture runs the tooling **at the pinned revision**, which is the
whole point and also its sharpest edge. This bit the author while writing the
fixture: a probe pinned at `e9305550` reported an env-resolution bug that had
been fixed in `606537ee` — the probe had imported the old resolver. If you are
debugging tooling behaviour inside a fixture, check `fixture:verify`'s pinned
sha before believing the result.

**A gate or test behaves oddly in the main checkout after using fixtures.** It
should not — fixtures live outside the repository by default, so no repo-walking
tool can reach them. If you pointed `--root` inside the repo, that is supported
(`.claude/worktrees/` is gitignored and every gate was verified to pass with 11
such directories present), but outside is the default for a reason.

**A consumer repo forces `npm ci` on every create.** Check for
`.gitattributes` with `eol=lf`. Git for Windows sets `core.autocrlf=true` at the
**system** level, so a fresh worktree checkout gets CRLF while the main working
tree holds LF. The lockfile comparison canonicalises line endings precisely so
this does not force a needless install — if you see installs anyway, the
dependency set really did change.
