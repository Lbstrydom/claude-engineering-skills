---
summary: Why ADD and record-correlation payloads go through a Write-tool file on stdin, never a shell-quoted --json string.
---

# Shell-safe payloads — why a file, never a quoted argument

Applies to `/persona-test add` (the `add-persona --stdin` recipe) and the
Phase 6b manual-repair `record-correlation --stdin` recipe.

## ADD — why a file

> **Why a file.** `name` and `description` are free text the user typed. An
> apostrophe — *"Pieter's tasting notes"* — closes the surrounding `'…'` and the
> rest of the value is handed to the shell as command text; the same input can
> break the JSON quoting inside it. This is the identical class the ledger
> writer already documents ("write it with the `Write` tool, never as a shell
> string"), where the workaround people reached for was stripping apostrophes
> out of their own prose to satisfy a quoting rule. A file has no shell in the
> loop, so the value stays the value.
>
> `--stdin` is the verified flag (probed 2026-09-02: it parses the payload and
> reports validation errors, rather than refusing as unknown). Do not reach for
> `--name`/`--description`/`--url` instead — those put the same free text back
> on the command line and reintroduce exactly this defect.

The pipe form (`cat file | node … --stdin`) is used rather than `<`
redirection because PowerShell does not support `<`; `cat | …` parses the same
way in bash and PowerShell (`cat` is a built-in PowerShell alias for
`Get-Content`).

## Manual correlation repair — why a file

**Never inline free text into a shell-quoted `--json '...'` string** — `matchRationale`
and other text fields come from model-composed or persona-observed prose that
can contain quotes or shell metacharacters. Always write the payload to a JSON file with the **Write tool** — never a
shell heredoc (same convention as the `add-persona` recipe above) — and pipe
it via `--stdin` (same convention as `/brainstorm`). Session artifacts live
under `.audit/`, never `/tmp/` (the two disagree on Windows — see the `.audit/`
vs `/tmp/` note elsewhere in this repo).
