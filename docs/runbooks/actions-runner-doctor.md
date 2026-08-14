# Actions Runner Doctor

`node scripts/actions-runner-doctor.mjs` (`npm run runner:doctor`) — for a
repo whose CI shows the GHE annotation *"GitHub Actions hosted runners are
disabled for this repository"*, this tests whether a **self-hosted** runner
is actually viable for your current `gh` identity, and prints the choice:
a ready-to-run repo-scoped setup recipe if so, or a pointer at this repo's
own local pre-push-hook fallback if not.

## What it deliberately does NOT do

It does not detect the hosted-runner block itself. That's a GitHub
Enterprise policy with no exposed API field — it only ever shows up as a
workflow-run annotation a human reads. This tool starts from "you already
hit that" and answers the next question: *given the block, is self-hosted a
path open to me, right now, on this repo?*

## Usage

```bash
npm run runner:doctor
```

```bash
node scripts/actions-runner-doctor.mjs --repo OWNER/REPO
```

```bash
npm run runner:doctor:json
```

Requires the `gh` CLI, authenticated (`gh auth status`). Without `--repo`,
the target repo is read from `git remote get-url origin`.

**Side effect, by design.** On a repo where your identity has admin, this
run **requests a real registration token** (`POST
.../actions/runners/registration-token`) — that request *is* the capability
test, the same one `gh api -X POST repos/OWNER/REPO/actions/runners/registration-token`
run by hand performs. The token is short-lived (~1 hour), single-use, and
simply expires if you don't consume it — nothing needs cleanup. Nothing else
is created or modified.

## Verdicts

| Verdict | Meaning | What it prints |
|---|---|---|
| `self-hosted-viable` | This identity has admin; registration succeeded | The registration token + a copy-paste setup recipe (download, `config`, install as a service, and the `runs-on: self-hosted` change) |
| `no-admin-rights` | Actions is enabled, but this identity can't register a runner | The gh error text, and who to ask |
| `actions-disabled` | Actions is off entirely for this repo | A self-hosted runner can't help either — points at the fallback below |
| `unknown` | Both the permissions read and the registration attempt failed | Usually a `gh auth` problem — re-check `gh auth status` |

`self-hosted-viable` only covers the repo it was registered against.
Org-wide coverage (any repo in the org drawing from one shared runner) needs
an org admin to register at the org level instead — this tool only tests
and sets up the repo-scoped path, since that's the one any contributor can
self-serve without waiting on anyone.

## Relationship to the local-maintenance-checks fallback

[`local-maintenance-checks.md`](local-maintenance-checks.md) is this repo's
own answer to the same root problem (an org that blocks GitHub-hosted
runners) for its 5 weekly maintenance workflows — replicate them locally,
triggered opportunistically from the pre-push hook, no runner needed at all.

The two are not competing: a self-hosted runner gets you a **real,
visible-on-GitHub CI check** (required-status-check enforcement, results
reviewers can see on a PR); the local pre-push-hook path gets you
**enforcement with zero infrastructure**, but only as strong as every
contributor actually running the hook — it can't gate a PR server-side and
it's invisible to reviewers. Pick self-hosted when you need a real required
check; pick the local path when you don't, or as the immediate answer while
a self-hosted runner (or org-admin sign-off) is still pending.
