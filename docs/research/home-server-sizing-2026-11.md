# Self-hosted CI inventory, cloud-runner comparison and home-server sizing

<!-- population: not-store-derived — measured from GitHub Actions run history (gh run/job timestamps) and vendor price pages, not from the audit store -->

Date 2026-11-23. Window: jobs in runs created 2026-10-24 → 2026-11-23 (30 days). Every figure is labelled
**measured** (a command's output), **derived** (arithmetic on measured figures), **expected** (a judgement or
vendor claim, not observed here) or **estimate** (a price, dated, with its source).

Repos: **ai-organiser** (public; Windows-service runner), **wine** (the private app repo; WSL2 runner with Docker),
and **the work repo** (Windows interactive runner; employer policy keeps it self-hosted on Windows, so it is out of
scope for moving and its jobs are described generically). All three runners share one desktop: i9-13900K
(24C/32T), 96 GB RAM, one 2 TB NVMe and one 4 TB SATA HDD (**measured**, `Get-CimInstance`, `Get-PhysicalDisk`).
The WSL VM is capped at 16 processors / 32 GB (`.wslconfig`, **measured**).

## Verdict

1. **Split. Cloud for the LAN-free jobs, home for the store-bound ones.** 94% of the personal-repo self-hosted
   minutes (2,767 of 2,933, **derived**) never touch the NAS. They need Docker and the internet, nothing on the
   LAN. A managed runner provider costs an **estimated $15–60/month** for them and removes them from the
   desktop at once. Ubicloud is cheapest; Blacksmith has the best-known speed reputation and 3,000 free
   minutes. Pilot one for a week before committing.
2. **Only three weekly jobs need the NAS audit store**: wine's scoped architectural-drift, ai-organiser's
   architectural-drift and the work repo's drift job. That is about 166 personal-repo minutes a month
   (**measured**). Keep them at home on option (a) below. No tunnel, no managed store.
3. **The home server is not needed for CI on day one under the split.** Buy it when Home Assistant moves or the
   audit store leaves the NAS, whichever comes first. The sizing below is for that machine. Class B (a mini
   workstation) is the recommendation: it has 5-year headroom and runs every CI job at home if the cloud pilot
   disappoints.
4. **Fix the NAS's 100 Mbps link first**, whatever else is chosen. It is the store's link and the future backup
   target's link.

## Part 1 — inventory of self-hosted jobs (30 days)

Durations come from each job's `started_at`/`completed_at`, counting only `status == completed` and excluding
`skipped`. In-progress jobs are excluded, so `updatedAt − createdAt` is never used. "Rounded" means
per-job minutes rounded up to a whole minute, the way per-minute billing counts.

### ai-organiser (Windows service runner, `NETWORK SERVICE`)

| Job | Trigger | Runs | p50 | p90 | Max | Minutes | NAS store | Needs | Could run on x86 Linux? |
|---|---|---|---|---|---|---|---|---|---|
| architectural-drift | weekly cron + dispatch | 6 (5 sched, 1 dispatch) | 14.5 | 30.3 | 30.3 | 108 (112 rounded) | **reads + writes** (`AUDIT_DB_URL`, symbol-index refresh) | Node, LLM API keys, LAN route to NAS | **Yes.** It uses Git Bash by absolute Windows path (`shell: C:\PROGRA~1\Git\bin\bash.exe`), so moving it needs a one-line `shell: bash`. Nothing Windows-specific otherwise |

The PR CI (`ci.yml`) and release jobs are GitHub-hosted, not in scope. The 30.3-minute max equals the 30-minute
timeout: one run was killed at its budget. 2 of 6 runs did not succeed (**measured**).

### wine (WSL2 Ubuntu runner, labels `self-hosted,Linux,X64,wsl2,docker,playwright`)

| Job (generic) | Trigger | Self-hosted runs | p50 | p90 | Max | Minutes | NAS store | Needs |
|---|---|---|---|---|---|---|---|---|
| PR unit tests | PR (picker) | 305 (+149 hosted) | 1.9 | 2.8 | 5.1 | 589 | no | Node; Docker for ephemeral Postgres |
| PR integration tests | PR (picker) | 231 (+126 hosted) | 2.7 | 3.9 | 5.4 | 627 | no; **throwaway Docker Postgres** on tmpfs | Docker, fast disk |
| PR lint | PR (picker) | 231 (+126 hosted) | 0.8 | 1.2 | 5.8 | 225 | no | Node |
| PR Postgres compatibility | PR (picker) | 231 (+126 hosted) | 0.5 | 0.8 | 9.7 | 168 | no; throwaway Docker Postgres | Docker |
| Push/daily prod schema-compat | push + daily | 241 | 1.2 | 2.0 | 5.7 | 363 | no; **production read-only DB over the internet** | Node, prod-read secret |
| Daily schema-baseline staleness | daily | 31 | 0.4 | 0.5 | 0.5 | 12 | no; prod read-only | Node |
| Daily live-API smoke | daily | 31 | 2.2 | 2.5 | 2.5 | 66 | no | Node, LLM API key |
| Daily deploy-config drift | daily + PR | 45 | 0.1 | 0.2 | 0.2 | 7 | no; hosting-provider API | none (no `npm ci`) |
| Daily fixture staleness | daily | 31 | 0.4 | 0.5 | 0.5 | 13 | no | Node |
| Weekly zone-label drift | weekly | 5 | 0.6 | 0.7 | 0.7 | 3 | no; prod read-only | Node |
| Weekly orphan-marker monitor | weekly | 5 | 0.5 | 0.6 | 0.6 | 3 | no; prod read-only | Node |
| **Weekly scoped arch-drift** | weekly | 5 | 11.3 | 20.3 | 20.3 | 51 (54 rounded) | **reads + writes** | Node, LAN route to NAS |

Totals (**measured**): 1,392 self-hosted jobs, 2,127 raw minutes, 2,821 rounded. The four PR jobs are placed by a
picker: self-hosted when the runner is online and its backlog is under 8, otherwise `ubuntu-latest`. In the
window it sent **3,750 raw minutes to GitHub-hosted** (**measured**), so wine already pays for some hosted time.

Speed, same jobs, same window (**measured**, p50): integration **2.7 min self-hosted vs 18.1 hosted (6.7×)**,
unit 1.9 vs 10.2 (5.4×), lint 0.8 vs 1.0, Postgres compatibility 0.5 vs 0.6. The heavy jobs are
Docker-and-disk-bound. Wine's runbook measured test-Postgres startup on Docker Desktop's virtual disk at p50 21 s
under external disk load, and 2.7 s after the data directory moved to tmpfs. Docker's WSL disk image is
**73 GB**, of which 52 GB is build cache (21 GB reclaimable) (**measured**, `docker system df`, vhdx size).

Peak RAM per job was **not measured**: nothing records it, and measuring it would mean running jobs on a shared
host. **Expected**: under 4–6 GB per job (Node test runner plus a tmpfs Postgres). The runner currently uses 1 GB
of the 32 GB WSL allotment at idle (`free -g`, **measured**). One runner runs one job at a time.

Every wine self-hosted job could run on x86 Linux: it already is Linux. Two things are tied to this host:
- the picker's label constant `DESKTOP_RUNNER_LABELS` includes `wsl2`, so a new runner must carry that label or
  the constant must change;
- the integration job serves on the fixed port 3111, which blocks a second runner instance on one host (wine's
  runbook names this as the prerequisite for doubling capacity).

### The work repo (Windows interactive runner, stays)

Six jobs (**measured**). They are described generically because this is a public repo:

| Job class | Trigger | Runs | p50 | p90 | Minutes |
|---|---|---|---|---|---|
| Main gate | PR + push + daily | 505 | 32.4 | 47.1 | 13,084 |
| Packaged-build gate (installer build/install) | push, some PR/sched | 44 | 15.9 | 19.3 | 640 |
| Nightly live smoke | daily | 31 | 3.4 | 5.3 | 115 |
| Nightly rendering QA | daily | 30 | 2.9 | 3.8 | 93 |
| Weekly drift (audit store) | weekly | 7 | 4.4 | 24.8 | 55 |
| Watchdog | daily | 30 | 0.9 | 1.9 | 30 |

It needs Windows with a **real interactive desktop session**: a GUI Electron launch, building and installing an
MSI, pinned office-document rendering, and Playwright. So it stays on this desktop regardless. Total **14,017
self-hosted minutes** in 30 days (**measured**). It is the desktop's dominant CI load, and it is timing-sensitive:
its own workflow documents a 2.5× swing from background load.

### Contention (the 2026-11-23 failure class)

Wall-clock overlap between jobs of different repos on this host, over the 30 days (**derived** from job
start/end intervals): **work repo × wine 1,222 min**, ai-organiser × work repo 34 min, ai-organiser × wine 39 min.
Within one repo nothing overlaps, because each runner runs one job at a time. So the overlap that corrupted the
installer and timed out a gate is almost entirely wine's PR and daily traffic landing on the work repo's gate.
Moving wine's LAN-free jobs off the desktop removes 1,183 of the 1,222 work-repo × wine overlap minutes;
the other 39 are wine's weekly NAS-bound drift job (**derived**, the same interval computation restricted to
that job). That is about 91% of all 1,295 cross-repo overlap minutes.

## Part 1b — what touches the NAS audit store

| Job | Store access |
|---|---|
| wine weekly scoped arch-drift | **reads + writes** (symbol-index refresh) |
| ai-organiser weekly architectural-drift | **reads + writes** |
| work-repo weekly drift | resolves `AUDIT_DB_URL` from a secret or the host's `~/.audit-loop.env` — **which store it points at was not verified here** (see §(c)) |
| every other job above | **none**: a throwaway Docker Postgres, a production read-only DB over the internet, a vendor API, or nothing |

Search used: `AUDIT_DB|audit-loop.env|192.168` over every workflow. In wine it hits only the scoped arch-drift
job's workflow and one already-hosted workflow's comment.

**So if CI moves to cloud runners, the only things that must stay near the NAS are the two weekly personal-repo
drift jobs (about 166 min a month) and the store itself.**

### Store-bound jobs: three options

| | (a) Store stays on the NAS; drift jobs stay home | (b) Tunnel cloud runner → NAS | (c) Managed Postgres, backups to NAS |
|---|---|---|---|
| Cost | $0 | $0 (Tailscale personal tier, **estimate**) | **$19–25+/month** (Neon Launch ~$19–23, Supabase Pro $25; **estimates**, Nov 2026, [Neon](https://neon.com/guides/neon-launch-plan-vs-supabase-pro-plan), [tech-insider](https://tech-insider.org/neon-vs-supabase-2026/)); more if the store outgrows the base compute |
| Local-session latency | LAN (**expected** ~1 ms; not measured, the read-only RTT probe was declined) | unchanged | **expected** 20–40 ms RTT to an EU region per round trip; chatty write paths and full index refreshes slow noticeably |
| Ops | none new | ephemeral auth key per job, ACL tagging runners to NAS:5432 only, key rotation | provider account, migration ledger run against it, backup job to NAS |
| Security | no new exposure | **a LAN path from a third-party VM**. Restrict to scheduled jobs (never PR code), tag-scoped ACL. Louis's call | own-model training data leaves the house to a third party; credentials on the internet |
| Data location | at home | at home | provider region; must be pinned, and the work-repo question below must be settled first |

**Recommendation: (a).** Run the two personal drift jobs on a home runner: the desktop under the host lock
today, the home server later. If neither is available, make their store-dependent steps local-only, the way CES
runs its two declared local-only gates. They are weekly, advisory, and 166 min a month; (b) and (c) add standing
risk or cost to save that. Revisit (c) only if the store needs to be reachable from outside the house for some
other reason.

**Open question before (c) is ever chosen.** The work repo's drift job resolves `AUDIT_DB_URL` from the host's env
file. The brief says work data never goes into the own-model store. Confirm which store that job writes to before
moving any store to a third party. (Verifying it from here needed a DB query, which was declined.)

## Part 1c — cloud options for the LAN-free jobs

Demand, per 30 days (**derived**):
- **D ≈ 3,600 min at desktop speed**: the 2,767 LAN-free self-hosted minutes, plus the 3,750 hosted overflow
  minutes re-expressed at desktop speed (≈ 844).
- **H ≈ 11,800 min at GitHub-hosted 2-core speed**: the picker jobs at their measured hosted means (integration
  16.8, unit 9.6, lint 1.0, Postgres 0.6 min), the light jobs at about 1.2× desktop, plus the 3,750 already
  hosted.
- A 4-vCPU provider runner is **expected** to land between the two: about 5,400–9,000 min. Not measured; the
  pilot is how to measure it.

| Option | Price basis (**estimate**, Nov 2026) | Est. monthly | Speed vs today's desktop | Ops burden | NAS reach |
|---|---|---|---|---|---|
| GitHub-hosted (baseline) | 2-core Linux $0.006/min since 2026-01-01 ([GitHub changelog](https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/), [cicdcost](https://cicdcost.com/github-actions-pricing)). The self-hosted $0.002 fee was announced and then postponed ([northflank](https://northflank.com/blog/github-pricing-change-self-hosted-alternatives-github-actions)) | **~$71** gross at H (~$53 after a Pro plan's 3,000 included minutes) | **measured** 5–7× slower on the heavy PR jobs | none | no route |
| Ubicloud | ~$0.00125/2-vCPU-min, $2.50 monthly credit ([openrunners](https://openrunners.io/github-actions-runner-pricing/), [dev.to](https://dev.to/nedomas/the-cheapest-github-actions-runners-in-2026-what-100000-minutes-cost-2mlc)) | **~$14–23** (4 vCPU at 5,400–9,000 min) | **expected** slower than other managed providers (same sources) | very low: label change | tunnel only |
| Blacksmith | $0.004/2-vCPU-min, $0.008 at 4 vCPU, 3,000 free min ([openrunners](https://openrunners.io/blacksmith-alternatives/), [craci](https://craci.com/compare/github-actions-runner-providers)) | **~$31–60** | **expected** fastest managed class (vendor claim) | very low | tunnel only |
| WarpBuild | $0.004/2-vCPU-min managed; BYOC $0.002/min plus your own compute ([latchkey](https://latchkey.dev/learn/runners/warpbuild-alternatives)) | **~$43–72** managed | expected similar to Blacksmith | very low | tunnel only |
| Depot | $0.004–0.006/2-vCPU-min (sources disagree), plus plan fee | **~$45–110** | expected fast | very low | tunnel only |
| Namespace | $0.002–0.006/2-vCPU-min (sources conflict), 1-minute minimum | **~$22–110** | expected fast | very low | tunnel only |
| RunsOn on a **new** personal AWS account (spot) | AWS spot at cost (~$0.001–0.002/min for 2–4 vCPU, older figure) plus a flat annual license (their example shows $29/month at a large tier; small-tier price unconfirmed) ([runs-on.com](https://runs-on.com/pricing/)) | **~$15–50** | **expected** good (choose the instance size) | **medium–high**: open and secure a new account first (see below), then a CloudFormation stack; spot interruptions fall back to on-demand | tunnel, or a VPN to home |
| philips-labs terraform-aws-github-runner, new AWS account | spot compute only, no license | **~$10–25** | as RunsOn | **high**: new account, plus Terraform, Lambdas, SQS and AMI upkeep | tunnel or VPN |
| GKE + ARC, new GCP account | spot nodes plus an always-on controller node (~$12+); zonal cluster fee covered by the free-tier credit for one cluster | **~$15–40** | good | **highest**: new account, plus a Kubernetes cluster to run | tunnel or VPN |
| Home server (class B below) | capex ~$1,700–2,200 over 60 months, plus power | **~$35–48 all-in**; **~$6–11 marginal** (power only, if the box exists for HA or the store anyway) | **expected** ≈ today's desktop (NVMe, native Docker, no Docker Desktop VHDX) | medium: hardware, Proxmox, OS patching | **LAN: yes** |

Power is **derived** as 25–40 W average idle (18–29 kWh/month) plus 60–100 CI hours at +40–80 W. At an assumed
$0.30/kWh, substitute the local tariff. All cloud prices are snapshots from third-party comparison pages and vendor
pages dated Sep–Nov 2026; verify on the vendor's page before buying.

**The spot-VM rows assume a cloud account Louis does not have.** He has no personal AWS or GCP account, and a
work account must never be used for the personal repos. Those options therefore start with opening a new
personal account (**expected** half a day to a day):
- set up a root user with MFA, then lock it away;
- create an admin identity with SSO or IAM Identity Center;
- in a region chosen for latency to home, give the runners a scoped IAM role.

**Billing safety is non-optional there.** Set up:
- AWS Budgets alerts at, for example, 50/80/100% of a $30 monthly budget, plus a Cost Anomaly Detection
  monitor; GCP budget alerts are the equivalent;
- **a hard cap.** Neither AWS nor GCP stops spend on its own, so wire a budget action (AWS: an SCP or IAM-deny
  budget action, or a Lambda that scales the runner fleet to zero; GCP: a Pub/Sub budget notification that
  disables billing on the project);
- a per-job instance-type allowlist and `timeout-minutes` on every job, so a runaway loop cannot buy large
  instances.

A leaked access key is the main failure mode: public repo CI plus cloud credentials is a known abuse target.
Prefer GitHub OIDC to a role over static keys. Taken together, this setup and the standing billing vigilance
outweigh the $5–30 a month these options save over Ubicloud. **They rank below both the managed providers and
the home server** for this workload.

Two cautions:
- **The prod-read and API secrets move to the provider's VMs.** That is the same trust class as GitHub-hosted,
  which wine already uses for its overflow, but it is a choice to make knowingly.
- **Per-job minimum billing matters here.** Wine's daily monitors run 0.1–0.5 min each, and rounding lifts
  2,127 raw minutes to 2,821 (**measured**). Prefer a provider with per-second or small-minimum billing.

**Recommended split**: wine's LAN-free jobs (all four picker jobs and the daily/weekly monitors) go to a managed
provider. Pilot Blacksmith first (free minutes cover a pilot week) and Ubicloud as the cheap alternative. The two
personal NAS-bound drift jobs stay home on option (a). The work repo stays as is. The picker's job then changes
from "self-hosted or hosted" to "provider label". That is a wine change, a follow-up for the wine coordinator, not
part of this report.

## Part 2 — sizing the home server

Assumption: the home server comes when Home Assistant moves or the store leaves the NAS (Louis: HA stays on the
desktop for now). It must also be able to take **all** personal CI if the cloud pilot fails.

### Load model (expected, per role)

| Role | vCPU | RAM | Disk | Notes |
|---|---|---|---|---|
| CI VM: wine, 2 runner instances (after the fixed-port fix) | 8 | 16 GB | 150 GB NVMe | Docker Engine (not Desktop); Postgres on tmpfs |
| CI VM: ai-organiser + future personal repos | 4 | 8 GB | 80 GB | |
| Postgres audit store (if it leaves the NAS) | 4 | 8 GB | 100 GB+ on the mirror | pgvector; size not measured here |
| Home Assistant OS (later, optional) | 2 | 4 GB | 64 GB | USB passthrough for a Zigbee/Thread dongle |
| Proxmox host + headroom | — | 4 GB | | |
| **Total** | **18** (overcommit is fine for CI) | **40 GB** | ~0.5 TB | → **64 GB now, 96–128 GB possible** |

### Concrete spec

- **CPU**: 12–16 modern x86 cores (Zen 4/5 or Intel 13th gen+). x86 because the runners, Docker images and
  Playwright browsers are all x86 today.
- **RAM**: 64 GB now in 2 modules, with room for 96–128 GB. DDR5 retail is about 6× its mid-2025 level
  (**estimate**, a 2×16 GB kit ~$480 on 2026-10-30, [computingforgeeks](https://computingforgeeks.com/?p=180243);
  2×48 GB kits $850–1,600 during 2026, [guru3d](https://www.guru3d.com/story/eu-ddr5-retail-prices-climb-again-with-highcapacity-kits-near-nine-times-baseline/)).
  So buy 64 GB and leave the upgrade path open; don't pay 2026 prices for 128 GB.
- **Storage**: 2× 2 TB NVMe as a ZFS mirror (VMs, store), plus 1 NVMe for disposable CI scratch (no
  redundancy). CI is disk-bound, which is the lesson from wine. Optionally a SATA bay for a local backup disk.
- **NIC**: 2× 2.5 GbE minimum (one for management/LAN, one for a CI or IoT VLAN); 10 GbE optional.
- **Power / noise**: 25–40 W idle (**expected**); fan audible only under sustained CI load. Add a small UPS with NUT.

### Software layout

- **Proxmox VE** on the host; one **VM** per role. Use VMs, not LXC, for the CI runners: PR code executes there,
  and Docker-in-LXC is fragile.
- **Isolation**: CI VMs on their own bridge/VLAN. Proxmox firewall allows CI → internet and CI → NAS:5432 only;
  no route to HA or IoT. This is stronger than today, where WSL can read `/mnt/c`.
- **HA protection**: CPU `cpuunits` weight (HA 4096 vs CI 512), `cpulimit` on CI VMs, optional core affinity
  (pin HA to 2 cores), no memory ballooning for HA, no RAM overcommit, start order HA first, and disk bandwidth
  limits on CI disks so CI I/O cannot starve HA or the store.
- **Backups**: nightly `vzdump` (snapshot, zstd) of the HA and store VMs to the NAS over NFS (7 daily, 4 weekly),
  plus HA's own backups and `pg_dump`/pgBackRest for the store. CI VMs are cattle: back up their config only and
  rebuild from a script. An offsite copy (Hyper Backup to a cloud bucket) covers the NAS as a single point of
  failure.
- **NAS link**: at 100 Mbps a 32 GB backup takes ~43 min, against ~4.5 min at 1 Gbps (**derived**). Fix the
  cable or switch port. The DS223j's 1 GB RAM also argues for moving the store off it eventually.

### Machine classes (estimates, Nov 2026)

| Class | Example | Est. total | Fit |
|---|---|---|---|
| **A. Low-power mini PC** | Intel N305 8-core, single SO-DIMM (≤32–48 GB), dual 2.5 GbE, ~$480 barebone ([newegg listing](https://www.newegg.com/brenuc-barebone-systems-mini-pc-intel-core-i3-n9np/p/2SW-00B0-00004)) plus 32 GB plus NVMe | **$800–1,100** | Enough for the split path: HA + store + two weekly drift runners. **Not** enough for wine's PR CI or 5-year growth |
| **B. Mini workstation (recommended)** | Minisforum MS-A2 (Ryzen 9 9955HX 16C/32T, 2× DDR5 SO-DIMM to 96 GB, multiple M.2, 2× 10 G SFP+ plus 2× 2.5 G, low-profile PCIe slot), ~$800 barebone ([Liliputing](https://liliputing.com/minisforum-ms-a2-mini-pc-now-available-with-amd-ryzen-processor-options/), [STH review](https://www.servethehome.com/minisforum-ms-a2-review-an-almost-perfect-amd-ryzen-intel-10gbe-homelab-system/3/)) plus 64 GB (~$500–900) plus 3 NVMe (~$400) | **$1,700–2,200** | Runs everything at home with headroom; small and quiet at idle. Limit: 2 RAM slots (96 GB ceiling), laptop-class cooling |
| **C. Quiet µATX/ITX tower** | Ryzen 9 9900 (12C, 65 W) or Ryzen 7 9700X on a B650/B850 board with 4 DIMM slots (ECC UDIMM on some boards), large tower cooler, 2–3 NVMe plus SATA bays | **$1,600–2,400** | Best 5-year path: up to 192 GB, ECC, HDD bays, standard repairable parts, quietest under load. Larger and higher idle draw (~35–50 W, **expected**) |

Pick B for the smallest box that still takes all CI. Pick C if the store, HA and more VMs are likely within the 5
years. A is right only if the cloud split is adopted and holds.

## Migration order

0. Fix the NAS link (cable or port; confirm 1 Gbps negotiated).
1. **Pilot a provider on wine's daily LAN-free monitors** (non-required, cheap): one week, compare durations.
2. **Move wine's four PR picker jobs to the provider** and retire the hosted fallback. This removes the 1,222 min
   a month of overlap with the work repo (**derived**). It needs the label constant change in wine.
3. **Shrink the WSL runner to the one weekly NAS-bound job.** It keeps the host lock, as does ai-organiser's
   runner.
4. **Keep the host lock** while any personal runner stays on the desktop. It is the only interlock between the
   work repo's gate and the remaining weekly drift jobs. It does not cover local dev load, which the work repo's
   own timing notes already flag.
5. When the home server arrives: move ai-organiser's drift job first (one weekly job; Linux needs only the
   `shell: bash` change), then wine's drift job. Then the desktop runs only the work repo and the lock can retire.
   Then HA, then the store, with backups to the NAS from day one.

If the pilot fails (too slow, or flaky Docker), keep the same order with the home server as the target for step
2 instead of the provider.

## Commands

- Runners: `gh api repos/OWNER/REPO/actions/runners` (the work repo via `GH_TOKEN=$(gh auth token --user <work
  account>)`, without switching the active account).
- Runs per self-hosted workflow: `gh api "repos/OWNER/REPO/actions/workflows/ID/runs?created=>=2026-10-24&per_page=100&page=N"`.
- Jobs per run: `gh api repos/OWNER/REPO/actions/runs/RUN/attempts/ATTEMPT/jobs?per_page=100`, keeping `labels`,
  `runner_name`, `status`, `conclusion`, `started_at`, `completed_at`. A job counts as self-hosted when `labels`
  contains `self-hosted`. Percentiles are nearest-rank over completed, non-skipped jobs. Overlap is the pairwise
  interval intersection across repos.
- Host: `Get-CimInstance Win32_Processor`, `Win32_ComputerSystem`, `Get-PhysicalDisk`, `Win32_Service`;
  `wsl -e nproc; free -g; docker system df`.
- Store-access audit: a ripgrep for `AUDIT_DB|audit-loop\.env|192\.168` over each repo's `.github/workflows/`.

Not measured: per-job peak RAM and disk I/O (that would need instrumented runs on a shared host); the audit
store's size and LAN RTT (the read-only query was declined); provider speeds (pilot).
