# Plan: CLAUDE.md Autofix + Skill-Copy Governance Debt (2026-07-26 triage)

- **Date**: 2026-07-26
- **Status**: Draft
- **Author**: Claude (tech-debt backlog triage session)
- **Scope**: backend

> Origin: full `.audit/tech-debt.json` backlog triage (384 entries). Small
> cluster (9 entries) across `scripts/lib/claudemd/autofix.mjs` and
> `scripts/regenerate-skill-copies.mjs`. Verified against current source
> 2026-07-26.

---

## `claudemd/autofix.mjs` (6 entries)

Two related bug classes in the same ~70-line function:

- **No containment check on file paths** (`9e84c80c`, `a4e4089d`) — line 34
  does `path.join(repoRoot, filePath)` with no realpath/containment
  validation before both read (line 37) and write (line 69). `filePath`
  here comes from findings data, not raw user input, so the practical risk
  is lower than a user-facing input — but this repo has an established
  `resolveAndClassify`-style canonicalization pattern (WS-CANON,
  `sensitive-paths.mjs`) specifically for this class of gap, and it isn't
  applied here.
- **Silent skip / no dedup on multi-finding edits** (`04599f13`,
  `2cb7c054`, `380340b7`, `d6673a9c`) — findings are grouped by file and
  sorted by descending line, but never deduped by file+line before the
  splice loop, so two findings on the same line will double-splice and
  corrupt offsets for the rest of the file. Any read error (ENOENT, EACCES,
  bad encoding) is caught identically and the whole file's finding group is
  silently skipped — nothing is pushed to `applied` or `skipped`, so a
  caller can't tell a file was dropped.

**Fix**: add a file+line dedup pass before the splice loop; distinguish
read-error types and record skips explicitly (even a one-line
`skipped.push({file, reason})` closes most of the observability gap); apply
the existing canonicalization helper before both read and write.

## `regenerate-skill-copies.mjs` (3 entries, all HIGH, same bug)

`43795dba`/`859011b3`/`980f2d49` — three audit rounds independently found
the same thing: `--keep-github-skills` still regenerates `.github/skills/`
by default, and `warnGithubSkillsDeprecation()` only *warns* about an
existing `.github/skills/` rather than removing it. This directly
contradicts AGENTS.md's own documented invariant: *"Keeping `.github/skills`
deleted stays load-bearing: a stale resurrected copy is an undefined-
behavior collision"* against the Copilot-native `.claude/skills/` surface
(the ai-organiser 2026-07-21 incident this repo's own docs cite as the
motivating example). **Fix**: flip the default — `.github/skills/` should
be actively removed unless `--keep-github-skills` is explicitly passed, not
merely left alone with a warning.

---

## Full entry table


**`scripts/lib/claudemd/autofix.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `04599f13` | MEDIUM | claudemd/autofix.mjs:31-33 groups by file sorts by line, no dedupe before splice |
| `2cb7c054` | HIGH | claudemd/autofix.mjs:62 splice per finding no dedup guard |
| `380340b7` | LOW | claudemd/autofix.mjs:36-38 catch continue skips whole file group silently |
| `9e84c80c` | HIGH | claudemd/autofix.mjs:34 path.join no containment check |
| `a4e4089d` | HIGH | claudemd/autofix.mjs:34 same join no symlink/../ validation |
| `d6673a9c` | MEDIUM | claudemd/autofix.mjs:36-38 all read errors swallowed identically |

**`scripts/regenerate-skill-copies.mjs`**

| topicId | severity | evidence |
|---|---|---|
| `43795dba` | HIGH | regenerate-skill-copies.mjs:38-43 --keep-github-skills still regenerates .github/skills/ by default |
| `859011b3` | HIGH | regenerate-skill-copies.mjs same governance gap as 43795dba |
| `980f2d49` | HIGH | regenerate-skill-copies.mjs identical governance gap duplicate |

## Rollback

Additive/defensive for `autofix.mjs`. The `regenerate-skill-copies.mjs`
default-flip is a behavior change for anyone currently relying on the
warn-only default — call it out in the commit message and check
`npm run sync:dry` across consumer repos before shipping, per the sync
doctrine in AGENTS.md.
