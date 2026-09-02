---
summary: Where a skill's arguments come from on any host, and what to do when there are none.
---

# Input Acquisition — the `$ARGUMENTS` contract

> **GENERATED COPY — do not edit.** The canonical is
> [`docs/audit/shared-references/input-acquisition.md`](../../../docs/audit/shared-references/input-acquisition.md).
> Regenerate with `node scripts/sync-shared-audit-refs.mjs`; `npm run check`
> fails on drift. Relative links above were rewritten for this location,
> so this file is NOT byte-identical to the canonical by design.

`$ARGUMENTS` names *what the user asked this skill to act on*. It is Claude Code
slash-command idiom, and **no other host substitutes it** — VS Code Copilot
discovers the same `.claude/skills/` tree but supplies no such variable, and its
`argument-hint` frontmatter field is display-only hint text, not a delivery
mechanism. So the token cannot be left to mean "whatever the host puts here":
without the rules below, a skill on Copilot either stalls or, worse, invents an
argument from the surrounding conversation.

## 1. Where input comes from — in priority order

1. **Orchestrator-supplied.** When another skill delegates (`/cycle` running
   `/audit-code`, say), it passes this skill's arguments **literally** — the
   plan path, sub-command and flags it already holds. This is not inference: the
   orchestrator knows those values. It may pass **only** what it was given or
   derived from a plan, never something invented.
2. **The host's verbatim invocation suffix**, when the host supplies one —
   everything the user typed after the skill name.
3. **The designated text**: *the span of the user's current message that names
   this skill or its subject.* In that message only.

## 2. Never infer

Flags, paths and sub-commands are read **only** from the source above. Never
from earlier turns, and never from surrounding prose that happens to mention
something plausible.

This clause is load-bearing rather than decorative. `/ship` accepts
`--no-tests`, `--ignore-p0` and `--skip-ux-lock`, each of which **disables a
gate**; a conversation that mentions skipping tests must never become an
argument that skips them. The same reasoning covers any destructive or
scope-widening flag in any skill.

Three consequences of the "current message only" rule, so it is followable:

- an earlier turn is **not** designated text;
- a path mentioned while discussing something else is **not** designated;
- if the current message names no such span, the input is **empty** — go to §3.

When in doubt, treat it as empty. That routes to ask-and-stop, which is the safe
direction.

## 3. Empty input is a defined state

Every site declares which of these it is — there is no third option, and
"proceed with a guess" is never one of them.

| Site kind | On empty input |
|---|---|
| **has a documented default** | take the default, and say which one you took |
| **requires input** | ask **one** prescribed clarification question and **stop before any side effect** |

"Stop before any side effect" means before writing a file, calling a provider,
or touching the store — not after.

## 4. Grammar class, declared per site

The sites are not one kind, and a reader needs to know which they are looking at:

| Class | Shape | Example skills |
|---|---|---|
| `free-text` | prose; no parsing beyond trimming | `/plan`, `/brainstorm` |
| `subcommand` | first token selects a branch | `/persona-test`, `/ux-lock`, `/ai-context-management` |
| `path+flags` | a path, plus optional flags | `/ship`, `/audit-code`, `/audit-plan`, `/click-test` |

## 5. Every site, not just the first

A skill states this contract once, at its first `$ARGUMENTS` use. **Every other
site in that skill carries its own grammar class and empty-input behaviour
inline**, because that is the site an implementer actually reads. A skill whose
sites differ in kind — `/persona-test` dispatches sub-commands, parses quoted
strings, and detects flags across seven of them — is exactly the case a
first-use-only statement fails.

The machine-readable form each site carries:

```
<!-- host-contract: input-acquisition; grammar=<class>; empty=<default|ask-and-stop> -->
```
