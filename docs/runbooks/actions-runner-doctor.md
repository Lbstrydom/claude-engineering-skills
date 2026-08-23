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

## `local` — inventory + health for THIS machine

A different question from the one above: not "can this repo self-serve a
runner", but *"is a runner actually installed and healthy right here, right
now, and for whom?"* — the question nothing in this repo could answer before
[docs/plans/self-hosted-runner-management.md](../plans/self-hosted-runner-management.md).

```bash
npm run runner:local
npm run runner:local:json
node scripts/actions-runner-doctor.mjs local --json --strict
node scripts/actions-runner-doctor.mjs local --include-wsl
```

**Discovery is exact declared directories, never a filesystem walk** —
`C:\actions-runner`, `%USERPROFILE%\actions-runner` (Windows) or
`~/actions-runner`, `/opt/actions-runner` (Linux/macOS), plus any
`extraRoots` in the local config (below). A root that simply doesn't exist
is `absent`, not an error, and contributes nothing to the result — only a
present-but-broken/escaping root counts as `error`.

**Health comes from GitHub, never the local service manager.** Each
discovered install is looked up by its own `agentId` — one direct API call
per install, never a list — and the verdict is one of:

| verdict | meaning |
|---|---|
| `online-idle` / `online-busy` | healthy |
| `wedged` | registered `offline` but GitHub still shows a job assigned (`busy:true`) — will never report |
| `offline` | registered, not busy, not online |
| `not-registered` | a direct 404 on this install's own agent id — authoritative |
| `unknown` | GitHub couldn't be reached/authenticated/trusted for this host — **never rendered as healthy** |

**Identity findings** are advisory (never gate, never set a non-zero exit on
their own):

| id | fires when |
|---|---|
| `host-name-mismatch` | opt-in only (`agentNameIsHostname: true` in local config) — the agent name asserts a host that isn't this machine |
| `supervision-mismatch` | the install is configured as a service but a `Runner.Listener` is running WITHOUT the service (or the reverse) — the exact shape of the incident that motivated this feature |
| `foreign-owner` | the install's owner isn't acknowledged and doesn't match any git remote of the repo you're standing in |
| `undeclared-install` | the root isn't one of the built-in defaults or a declared `extraRoots` entry |

**Exit codes.** `local` is a diagnostic by default — it exits 0 regardless of
what it finds. Pass **`--strict`** (what the opt-in weekly `runner-health`
maintenance check uses) to map `unhealthy`/`unknown`/`partial-error` rollups
to exit 1; `advisory`-only never gates, even under `--strict`. `--json` and
`--quiet-when-clean` are mutually exclusive — `--json` always emits exactly
one machine-readable line, clean result included.

**WSL runners are invisible unless you pass `--include-wsl`.** Reaching into
a WSL distro starts it — this tool will never do that as a side effect of a
default run. A `wsl`-kind root only exists via `extraRoots` in the local
config; declaring one does not itself start anything.

## `remove` — a two-step, guided teardown

```bash
node scripts/actions-runner-doctor.mjs remove <agentName-or-agentId>
# … run the printed commands, including a service stop first if the runner
#   is (or might be) service-supervised …
node scripts/actions-runner-doctor.mjs remove --verify \
  --host github.com --owner-kind repo --owner OWNER/REPO --agent-id 42
```

Two separate invocations, deliberately — a single process can't request a
token, wait for you to run GitHub's own `config remove` in another
directory, and then re-check. `remove <selector>` (**prepare**) resolves the
selector against your discovered local installs (refusing on ambiguity),
checks the install's status on GitHub, and — for both `available` and
`not-registered` (already orphaned — this IS the case you'd want to clean
up) — requests a removal token and prints the exact next command, verbatim,
with the full non-secret target descriptor filled in. Nothing is persisted
between the two calls.

`remove --verify` re-checks the exact descriptor fresh against GitHub —
never a cached result — and exits:

| exit | meaning |
|---|---|
| `0` | removed — no longer registered |
| `1` | still-registered — `config remove` didn't take effect (yet) |
| `3` | inconclusive: GitHub was unavailable |
| `4` | inconclusive: forbidden |
| `5` | inconclusive: malformed response |
| `6` | inconclusive: the host isn't in `trustedHosts` |

Codes 3-6 are deliberately distinct from both 0 and 1 — "couldn't check" must
never read as either a confirmed success or a confirmed failure.

## Local config — keeping private orgs out of this public repo

Copy [`scripts/lib/runner-hosts.local.example.json`](../../scripts/lib/runner-hosts.local.example.json)
to `runner-hosts.local.json` in the same directory (gitignored — never
committed) to declare:

- `extraRoots` — additional install directories to check, `{kind:'local',
  path}` or `{kind:'wsl', distro, pathInDistro}`
- `expectedHostname` / `hostnameAliases` / `agentNameIsHostname` — this
  machine's own naming convention, for `host-name-mismatch`
- `acknowledgedOwners` — owners to stop flagging as `foreign-owner`
- `trustedHosts` — hosts `local`/`remove` will contact `gh` for (default:
  `['github.com']` only — a GHES host must be explicitly authorised here
  before any request is ever sent to it)

The local config is for **acknowledgement**, not enforcement — it never
affects which of your own tracked files get scanned for a leaked runner
identity; that guard (`tests/runner-leak-guard.test.mjs`) is a structural
shape detector over every tracked file and needs no configuration at all.

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

## Three invariants — two code-enforced, one documentation-only

Worth stating plainly, since they sit next to each other and are easy to
mistake for the same kind of guarantee:

- **Code-enforced**: GitHub is the health oracle, never the local service
  manager — `assessRunnerHealth` never reads `Get-Service`/`systemctl` state
  as the verdict, only as the separate `supervision-mismatch` finding.
- **Code-enforced**: probing WSL starts the distro — `--include-wsl` is the
  one flag that authorises that, and `local`'s default run never reaches a
  `wsl`-kind root.
- **Documentation-only, NOT a technical control**: a self-hosted runner
  should never carry a ruleset-required check on this repo (the invariant
  the wine-cellar wedge incident established — see AGENTS.md). Nothing in
  `local`/`remove` reads or enforces this; it's an operator discipline this
  runbook records, not something the CLI can verify or prevent. Auto-detecting
  a violation would need a separate ruleset-read API surface with its own
  failure modes, deliberately out of scope for a machine-diagnostic tool.
