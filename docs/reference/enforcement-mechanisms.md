# Where enforcement lives — and why not a `$PATH` wrapper

> **Decided 2026-11-15.** Read this before proposing any mechanism that makes a
> rule "apply to every host". It answers the recurring question *"Copilot and
> Cursor get no `.claude/hooks/**` — how do we give them the same protection?"*

## The rule

**Enforcement goes into the code that performs the action — host-agnostic and
fail-closed.** Not into the shell, not into the environment, not into a host's
hook system. A hook is an *accelerator* for one host; the code path is the only
thing every host must go through.

The pattern to copy is `assertDisposableDbUrl`
([`scripts/lib/db/client.mjs`](../../scripts/lib/db/client.mjs)): the suites that
`DROP SCHEMA public CASCADE` cannot run against a non-loopback DSN, because **the
code refuses** — on Claude Code, on Copilot, on Cursor, in CI, in a bare
`node` invocation, with no `PATH` and no hook involved. Same shape:
`unserviceableCliParams` throwing on a param `cli` cannot honour,
`resolveSkillTargets` throwing on a machine-global skill root, `redactSecrets`
returning `[REDACTED:redaction-failed]` rather than leaking a payload.

**Its limit is the honest part of it**: it only covers actions that go *through
repo code*. A raw-shell gotcha — "never bare `git stash` in a shared tree" — has
no interception point, and therefore stays prose on every host. Say that plainly
rather than reaching for a mechanism that appears to close the gap and does not.

## What was rejected: a `$PATH`-wrapper layer

The proposal was a `.bin/` directory prepended to `PATH`, holding scripts that
shadow `git`, `npm` and friends, inspect the invocation, and abort on a dangerous
one (`git add -A`, bare `git stash`, `git push --no-verify`). Rejected, for four
reasons, any one of which is sufficient.

### 1. It is machine/shell-global state, which this repo has rejected twice on principle

`~/.claude/skills/` is retired and `.githooks/post-merge` was deleted, both
because **no correct content exists for a layout-agnostic surface** — a file
installed outside the repo cannot know which repo layout it is being asked about.
A `PATH` mutation is exactly that shape: it is set once per shell, applies to
every repo that shell later visits, and the wrapper has no reliable way to tell
which one it is in. See AGENTS.md §Skill Chain invariant (2).

### 2. It shadows the repo's own tooling

`spawnSync('git', …)` resolves through `PATH`. So the wrapper would sit underneath
the gates themselves: the pin census's corpus enumeration,
[`disowned-paths.mjs`](../../scripts/lib/disowned-paths.mjs) (which asks git for
ignored-and-untracked state), [`push-range.mjs`](../../scripts/lib/push-range.mjs),
and the poison-pill sandbox's `git ls-files`. **A bug in the wrapper breaks the
measurement apparatus**, and it breaks it in the direction that reads clean —
exactly the `Layering violations: 0` failure mode recorded in AGENTS.md's preamble.

### 3. Windows

`PATH` shadowing resolves differently in Git Bash, PowerShell and `cmd` —
`PATHEXT`, `.cmd` wrappers, and each shell's own precedence rules. This repo
already carries scar tissue here: `npx` must be `npx.cmd` for Claude Code's
process spawner, and
[`package-manager.mjs`](../../scripts/lib/package-manager.mjs) deliberately
**refuses to guess** between two package managers rather than pick wrong. A
wrapper layer would have to be correct in three shells on two platforms before it
protected anything.

### 4. It is bypassable, and the bypass is invisible

`/usr/bin/git`, an absolute path, an IDE's own bundled git integration, or any
tool that does not inherit the shell's `PATH` all route around it silently. That
makes it an **accelerator** — the same category as
`.claude/hooks/arch-memory-check.sh` — but at far higher blast radius than a hook
that only emits a `<system-reminder>` and never blocks. We already have
accelerators; this one would buy no new guarantee while sitting in the dependency
path of every gate.

## The forcing question for the next proposal

Before proposing a mechanism that "applies to every host", answer:

1. **Is there a code path the action must go through?** If yes, put the refusal
   there, fail closed, and test it. That is the whole job.
2. **If no — is the mechanism enforcement or an accelerator?** If it is bypassable
   it is an accelerator; say so, and weigh its blast radius against what a nudge
   is worth.
3. **Does it mutate state outside the repo?** If yes, it is the retired-surface
   shape; expect it to be refused.
4. **Does the repo's own tooling run through it?** If yes, it can break the gates,
   and a broken gate reads as a passing one.

## The two accelerators, and what is resident about them

Two rules in `AGENTS.md` are host-neutral and mandatory, and each has a
Claude-Code-only hook that merely *accelerates* it. The distinction is the whole
point of this document: **the rule binds every host; the hook binds one.** What
stays resident in `AGENTS.md` is the rule and the fact that other hosts get no
hook. The mechanics below are here because an agent that needs them is already
looking the subsystem up.

### Architectural memory — `.claude/hooks/arch-memory-check.sh`

Fires on `UserPromptSubmit` when the prompt carries an intent verb
(`fix`/`add`/`implement`/…; the list lives in the hook). When it fires it injects
a `> **Architectural-memory consultation**` callout — seeing that callout means
the consultation already happened, and it is authoritative.

- Disable: `ARCH_MEMORY_HOOK_DISABLE=1`.
- Cost: ~$0.0003 + one RPC, disk-cached 24h keyed on
  `(intentDescription, model, dim)`.
- **Hosts that do not run the hook get none.** The VS Code Copilot harness reads this repo's
  `.claude/settings.json` hooks (Preview; Claude matcher semantics for PascalCase events), but drops
  `UserPromptSubmit` command output, so the callout never reaches the model there; Cursor and others
  run no hook. Where it did not fire, the `get-neighbourhood` call is run by hand — and so must Claude, when the hook did
  not fire because a question turned into a fix mid-conversation.

### Quick-fix detection — `.claude/hooks/quickfix-scan.mjs`

Fires on every Edit/Write (`PostToolUse`), pure-regex over ~12 mechanical
signatures (empty catch, unjustified `@ts-ignore`, masked errors, hardcoded
localhost, …; patterns in `scripts/lib/quickfix-patterns.mjs`). It emits a
`<system-reminder>` and **never blocks**.

- Opt-outs: `QUICKFIX_HOOK_DISABLE=1`, a `// quickfix-hook:ignore` comment, a
  >80K-char diff bail, and a sensitive-path short-circuit.
- The portable half is Layer 2, the `quickfix` wave in `/audit-code`.
- **Cadence is not equivalent** and the difference must be stated rather than
  implied: hook = every edit, wave = once per audit, so on a host without the
  hook a shortcut is caught later and only within audited changes.

## AGENTS.md is near its irreducible size (measured 2026-11-15)

The 2026-11-15 condensation took `AGENTS.md` from 78,941 to 71,987 of its 79,000
cap. Composition of the 8,168 characters removed, classified honestly: **~3,600
relocated** (the text now lives in `docs/`), **~1,500 deleted as genuinely
redundant** (a "Why" paragraph restating its own bullets, duplicate pointers at
the head and foot of one section, clauses repeated between the preamble and a
section), **~3,000 prose tightened** in retained content, spread across ~25
sections. The final ~600 were won by word-level trimming to cross a target — the
thing the file's own preamble warns about, recorded here rather than hidden.

**The negative result is the useful part.** Both host-accelerator paragraphs
(above) were then moved into this file properly, rule left resident, mechanics
relocated. **Net saving: one character** — the pointer stubs cost what the
mechanics did.

That is the messy middle in miniature, and it generalises: **what remains in
`AGENTS.md` is tripwire-dense, not dossier-dense, so stubbing it trades warnings
for links at roughly 1:1.** The large sections left are Consumer-repo layout
6,766 · Architecture 6,880 · Postgres-Parity 5,731 · the preamble 11,994, and
each is a run of imperatives with its depth already elsewhere — there is no
dossier left in them to move.

**The consequence, stated as a limit:** the ~7,000 characters of headroom is what
the file has left, and it cannot be won back a second time by condensing. So the
next invariant that does not fit is **not** a signal to run the condensation task
again. It is a signal that either the invariant needs a different home, or — the
better answer, and the reason this limit is recorded in *this* file — the thing
it warns about needs enforcing in the code that performs the action, so the prose
can be deleted rather than shortened. A tripwire that becomes a fail-closed
refusal stops costing always-loaded context at all.
