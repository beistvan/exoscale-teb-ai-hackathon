# Exoscale - TEB AI Hackathon

Hackathon Challenge | Carbon-Aware Cloud Orchestration

The Exoscale GreenOps Challenge


Part of The Energy Bridge Critical Infrastructure Hackathon · 23–25 October 2026 · Vienna

Overview and scope

Can your software complete a demanding set of computing workloads with less carbon impact—without missing deadlines or breaking data residency rules?

Your team will build an orchestrator for a simulated European cloud. It will decide when to start workloads, where to place them, which CPU or GPU resources to use, and when to stop or replace those resources. Electricity forecasts will help you plan, but they will not always be right.

You have 15 workloads, 120 simulated hours and a shared resource budget. A full run takes as little as ten minutes, so you can test an idea, inspect the result and try a different approach during the weekend.

The challenge combines software engineering, optimization and energy-system thinking. You can start with a simple scheduler and improve it step by step. The goal is a working program that makes good decisions as information becomes available.



Platform preview. Locations, electricity signals and resource characteristics belong to the challenge simulation.

Context

Electricity carbon intensity changes over time and between locations. For computing work that has some flexibility, choosing when and where to run creates an opportunity to reduce its electricity-related impact.

That flexibility has limits. A workload may need to stay in a particular country, require a scarce GPU, take hours to prepare, or lose progress when restarted. Waiting for a better forecast can also leave too little time to finish.

This challenge puts those decisions into a controlled simulation. You use familiar cloud tools and APIs, while the platform simulates workload progress and accounts for VM electricity use and carbon impact. You do not need to provision real cloud VMs, buy GPU capacity or obtain an electricity-data subscription.

The environmental results are game results. Electricity inputs are synthetic or historical-based approximations; VM power, performance and facility-efficiency factors are fictional coefficients. Accounting covers VM operational electricity, excluding separate network, storage and embodied emissions. It does not represent measured Exoscale footprints or verified real-world emissions savings.

The challenge

Build an autonomous controller that completes the workload collection as efficiently as possible within the rules. Your controller can use the public workload specifications, its own run’s resource and workload status, and electricity observations and forecasts published for that run.

Challenge parameter
What it means for your team
120 simulated hours
Complete work and deliver final outputs before each workload’s deadline.
15 CPU and GPU workloads
Handle different release times, resource requirements, setup delays and restart costs.
11 simulated zones across 8 countries
Choose among legal locations; some locations are fictional additions for the game.
20 allocated VMs and 320 vCPUs
Share capacity across workloads. GPU VMs also consume vCPU quota.
GPU quotas by family
Up to 4 RTX PRO 6000 cards and 8 cards for each other supported family, subject to profile and zone availability. B300 is excluded.
Unlimited attempts
Experiment freely, with at most two unfinished practice runs per team.


Some workloads can move between several countries. Others are restricted to Switzerland or to Germany, Austria and Switzerland. EU residency excludes Switzerland, and each workload’s explicit country restrictions still apply.

Decisions your controller will face

Run now or wait? A cleaner electricity window may be approaching, but the workload still needs time for setup, computation and output delivery.
Stay or move? A different country may offer lower impact, but restarting can lose work or repeat a long setup phase.
Which hardware? Compare throughput, energy use, memory requirements and GPU availability while staying within the shared quotas.
How much parallelism? More workers may finish sooner, but synchronization overhead and competing workloads limit the benefit.
When should resources be deleted? Completed workloads leave VMs idle until you clean them up. Their electricity use still counts.

For example, the workload pack includes a restart-sensitive scientific model restricted to the DACH countries, a Swiss-only reporting job, a large-input analytics job with a two-hour setup, and GPU fine-tuning with specific memory and country requirements.


What we provide

The platform provides a shared team workspace, separate credentials and endpoints for each run, and a dashboard for inspecting progress, electricity forecasts, resource use and results. An allocation timeline helps you understand what happened and why.

The public starter kit includes:

Machine-readable workload definitions, the resource catalog and schemas.
An Exoscale CLI configuration workflow and API documentation.
Fixed-placement examples in Go using egoscale and Python using the Exoscale binding.
A simple Terraform example, using a Python SDK bridge for static VM creation.
A reusable container image with the CLI, Terraform and development tools.

The starter examples deploy two workloads to fixed legal locations. They are a starting point for your controller; your team will extend them to manage the full collection.

You assign a workload by including its ID in the VM’s user-data. The simulator handles setup, computation, checkpoints and final output. Your program polls the work-status API and manages VMs through the supported Exoscale-compatible API subset. No real workload execution or security-group configuration is needed.

API emulation is powered by the open-source Feint project. GreenOps adds the simulation clock, workload engine, quotas, accounting and scoring.

Suggested three-day workflow

Day
Focus
Friday, 23 October — Start with a working deployment
Form your team, explore the workload constraints and connect a starter example to a practice run. Establish a simple, legal scheduling policy.
Saturday, 24 October — Test and improve
Add forecast-aware decisions, resource selection or deadline management. Compare runs and investigate setup overhead, lost progress and idle resources. Use feedback to refine your approach.
Sunday, 25 October — Submit and demonstrate
Prepare reproducible code and instructions, submit your chosen revision and explain your results and trade-offs.


This is a suggested working sequence. The organizers will announce portal access, the submission deadline and pitch arrangements.

Working method

1. Establish a baseline
Start with fixed legal locations and a straightforward admission policy. Make sure your program can deploy workloads, monitor final delivery and delete resources when they are no longer needed. Record completion and carbon impact together.

2. Add one scheduling improvement
Try forecast-aware placement, delaying flexible work, choosing different profiles or reserving capacity for deadlines. Change one part of the policy at a time so you can explain the result.

3. Investigate the trade-offs
Use the dashboard and allocation history to check your assumptions. Did a move save enough carbon to justify lost work? Did a faster GPU help the whole run? Did idle VMs consume resources after their workload finished?

4. Make it reproducible
Run your controller with fresh run credentials. Document its dependencies, configuration and launch command. It should operate automatically once started and handle the information available during that run.







Scoring and competition rules

Higher scores reward more useful work with less realized carbon cost. Workload contributions are weighted using fixed reference energy so CPU and GPU work can be compared. Boot, setup, lost work and retained idle resources all affect the result.

The frozen scoring policy offers up to 20,000 base points, plus a 5,000-point bonus when all required computation and final outputs complete by their deadlines. Qualified partial runs can also rank. Final scores include VM costs through the full 120-hour window; finishing computation early does not erase later idle consumption.

Two rules are essential:

Respect residency. Attempting to place a workload in a forbidden country permanently disqualifies that run, even when the API rejects the request. Check the workload’s restrictions before deploying.
Use only your run’s published electricity information. Current forecasts are valid planning inputs. Harvesting later observations from another run, looking up the scenario’s historical actuals, or embedding a schedule based on known future values is prohibited. General algorithm improvements between attempts are encouraged; transferring scenario-specific future knowledge is not allowed.

Practice runs support pause and speed controls. The first accepted VM deployment starts the clock. Official judging uses a fresh organizer-controlled run at 720× speed, equivalent to approximately ten minutes for the full window.

The preliminary leaderboard shows each team’s best qualified finalized practice result. Official results follow source review and a fresh organizer rerun. Exact score determines rank, with lower realized carbon breaking score ties.

Submission and final presentation

Submit a GitHub repository and an exact commit SHA, identify your practice run, and provide all scheduling logic, input files, dependencies and container build/run instructions. Keep credentials out of source control. You may keep the repository private and give judges access; GitHub sign-in alone does not grant repository access.

In your presentation, explain:

Your approach: how the controller decides when, where and on which resources to run work.
Your evidence: what completed, the resulting impact and score, and how the policy compares with your baseline.
Your trade-offs: where you chose to wait, move, restart or accept higher-impact electricity.
Your limitations: which assumptions failed and what you would improve next.

The competition score comes from the reviewed organizer rerun. Your presentation should make the engineering behind that result understandable.

Expected outcome

By the end of the weekend, your team should have a working orchestrator, a reproducible submission and evidence showing how its decisions affect completion and simulated carbon impact.

There is room for several approaches: a small rule-based controller, a forecast-driven planner or an optimization solver. A good starting point is a few legal VM deployments. The challenge is turning those into a reliable scheduler that handles the whole workload collection—and understanding which improvements actually help.




---

# Project setup & run book

Everything below is specific to **this repo** (webapp + orchestrator), documented as-built.

## What this repo contains

| Part | Location | Purpose |
|---|---|---|
| Simulation (pure, seeded, deterministic) | `src/lib/sim` | Offline mirror of the challenge rules: policies receive only published forecasts (`PolicyView`), residency is enforced by the engine, score uses the frozen offsets (20 000 base + 5 000 bonus, 200 gCO₂e/kWh reference). |
| Web app (TanStack Start + Vite) | `src/routes` | Dashboard + **/live monitor** page that polls a run's APIs read-only and shows VMs, status, forecasts and charts. |
| Docker + Make | `Dockerfile`, `Makefile`, `.dockerignore` | Run everything in a container; no host `node_modules` needed (keeps `/home` disk usage ~0). |
| Helpers | `scripts/` | `greenops-status.mjs` (read-only run status), `make-creds.mjs` (generates `greenops-exo.json` from `.env`), `orchestrator.mjs` (15-workload carbon-aware live controller). |

## Quick start (one command)

```bash
make run          # build image (first time) and start the webapp; prints the real URL (default http://localhost:8080, or another free port)
```

The dev server runs inside the container; `/` is the dashboard, `/live` is the live-run monitor. `make logs`, `make stop`, `make ps`, `make shell`, `make rebuild`, `make clean` are also available (see `make help`).

## Run credentials — never committed

- A run gives you cloud key/secret, cloud/work/grid endpoints and a grid secret (the "Copy environment" button on the runner page).
- Put them in `.env` (from `.env.example`): `EXOSCALE_API_KEY`, `EXOSCALE_API_SECRET`, `GREENOPS_CLOUD_ENDPOINT`, `GREENOPS_WORK_ENDPOINT`, `GREENOPS_GRID_ENDPOINT`, `GREENOPS_GRID_SECRET`.
- `.env`, `env/`, `greenops-exo.json` and the orchestrator receipt are gitignored. The image never contains them: `docker run --env-file .env` injects at runtime.
- The `/live` page uses the server-side `.env` automatically (it only receives booleans, never the values); manual paste into the page still works as a fallback.

## Run commands

```bash
make status        # read-only run state: state, virtual clock, delivered/started workloads, zones
make creds         # write greenops-exo.json (mode 600) for the official starter kit
make starter       # clone the official starter kit (once)
make demo          # official 2-workload demo  — STARTS THE CLOCK (use a fresh run)
make attempt       # 15-workload carbon-aware orchestrator — STARTS THE CLOCK
make attempt-dry   # plan-only preview of the orchestrator (safe, no writes)
make cleanup-run   # delete this controller's VMs via its receipt (after a run)
make dashboard     # print monitor + challenge board URLs
```

`make attempt` and `attempt-dry` run `scripts/orchestrator.mjs` inside the app container (`bun`), so the host needs nothing besides Docker and the `.env`.

## How runs work (facts, verified from the platform docs and API)

- The clock starts on your **first accepted VM deployment**, not at run creation. Creating a run costs nothing until you deploy.
- **Score cap: 20 000 base + 5 000 completion bonus = 25 000 points** (frozen `greenops-score-v2` cohort; electricity-usage basis, 200 gCO₂e/kWh reference, bounded quality = ¾ local + ¼ shared cost). Practically, all 15 workloads must complete before their deadlines to reach >20k.
- Speeds: 1× (5 days), 60× (2 h), 360× (20 min), 720× (10 min for the full window). **Speed does not change the score** — official judging reruns at 720×, so develop at 720×.
- Attempts: unlimited, max **2 unfinished** runs per team; each run sees only its own published forecasts (fair play).
- Residency: an illegal placement attempt disqualifies the run (score 0) — the engine enforces the same rule in simulation.

## The orchestrator (`make attempt`)

Carbon-aware, quote-safe, idempotent 15-workload controller:

- Reads its own run's `/work/v1/status`, `/zone`, `/instance-type` (live profile catalog), `/template` and grid forecasts only — never future actuals.
- Deploys the **cleanest legal (zone, profile, workers) option available now**, ordered by deadline urgency, respecting release times and quotas (20 VMs / 320 vCPU / GPU-family caps), with residency checks. (Forecast-window *waiting* is in the offline policy; the live planner is deliberately conservative about deadlines.)
- Deterministic VM names + a local receipt (`greenops-orchestrator-state.json`, gitignored) make reruns recover accepted creates; VMs of delivered workloads are deleted automatically.
- EXO2 signing follows the official spec (message = `METHOD path` + body + query-values + headers + expiry; signature = base64 HMAC-SHA256; `signed-query-args` pragma for query params).

**Verification status (evidence, not claims):** the read path (zones, per-zone instance lists, instance-type, template, work status, grid forecasts) was exercised end-to-end against the live run — a completed run reports `COMPLETED` + 2/15 delivered and the orchestrator exits 0. The POST/DELETE signatures were accepted by the server (it returned business errors, not auth errors — a completed run rejects all creates with `unknown or unavailable instance type` for bogus and real ids alike). **Writes have not yet been exercised against a live run**, so the first `make attempt` on a fresh run is the real test of create/delete semantics.

## What was fixed / changed (this repo)

- `tsconfig.json` gained `"node"` in `types` (server-side `process.env` access).
- `src/lib/live.functions.ts` / `src/routes/live.tsx`: run credentials read server-side from `.env`; live page auto-detects the config and starts polling; secrets never reach the browser.
- `Makefile` `stop`/`run` force-remove stale containers (a stopped container previously blocked `make run` with a name conflict).
- A policy-parameter sweep (12 seeds × 9 configs) showed the shipped carbon-aware policy is within ±0.2 % of every alternative and the best candidates regress 2/12 seeds — **kept the shipped defaults**; no regression per the contract test ("both shipped policies stay legal and the carbon-aware one emits less").
- Pre-existing, unrelated: tsc errors in `ui/chart.tsx`, `input-otp.tsx`, `sheet.tsx`, `sidebar.tsx`, `routes/index.tsx`, `src/start.ts` (present at HEAD, untouched); `app-routing.test.tsx` fails inside the container image with a Zod resolution quirk (passes on a host install); both are infra noise, not regressions.

## Host-disk notes

`/home` has no headroom, so `node_modules` and Docker's data live elsewhere: Docker's data root is on `/goinfre`; the webapp image builds deps into its own layer. The only host footprint is the source tree (~5 MB). If you ever need host-side `bun test`/`bunx tsc`, symlink `node_modules` into a big mount (`/tmp` or `/sgoinfre`) first.

## Competition entry (the actual submission)

Submit a GitHub repo + immutable commit SHA + claimed practice run + reproducible build/run instructions; organizers review (source stays private to team + organizers; grant repo access manually) and rerun your controller at 720× on their infra — that rerun is your official score. `make attempt` + this README is the reproducible "container entry point launches the orchestrator" story. The CHF 50 Exoscale coupon is for hosting your own controller/live demo — it does not affect scoring (judging reruns on their own machines). There is no deployment to the challenge site: the dashboard is the run's own UI, and this webapp is a second, local, read-only window onto the same run.
