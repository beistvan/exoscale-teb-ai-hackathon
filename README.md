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
| Challenge data (shared) | `challenge/` | `catalog.json` + `rules.json` vendored from the starter kit, and `legality.mjs` — the one residency/profile check used by both the simulator and the live controller. |
| Simulation (pure, seeded, deterministic) | `src/lib/sim` | Offline mirror of the challenge rules on the real catalog (grid carbon is synthetic): policies receive only published forecasts (`PolicyView`), residency is enforced by the engine, score uses the frozen offsets (20 000 base + 5 000 bonus, 200 gCO₂e/kWh reference). |
| Web app (TanStack Start + Vite) | `src/routes` | Dashboard + **/live monitor** page that polls a run's APIs read-only and shows VMs, status, forecasts and charts. |
| Docker + Make | `Dockerfile`, `Dockerfile.controller`, `Makefile`, `.dockerignore` | `Dockerfile`: the webapp and dev tools, so no host `node_modules` is needed (keeps `/home` disk usage ~0). `Dockerfile.controller`: the controller-only image for official reruns (see "Competition entry"). |
| Helpers | `scripts/` | `greenops-status.mjs` (read-only run status), `make-creds.mjs` (generates `greenops-exo.json` from `.env`), `orchestrator.mjs` (entrypoint of the v3 live controller in `scripts/greenops/`: `policy.mjs`, latency-tolerant `controller.mjs`, offline `mock.mjs`), `orchestrator-legacy.mjs` (previous single-file controller, kept for reference). |

## Quick start (one command)

```bash
make run          # build image (first time) and start the webapp; prints the real URL (default http://localhost:8080, or another free port)
```

The dev server runs inside the container; `/` is the dashboard, `/live` is the live-run monitor. `make logs`, `make stop`, `make ps`, `make shell`, `make rebuild`, `make clean` are also available (see `make help`).

## Run credentials — never committed

- A run gives you cloud key/secret, cloud/work/grid endpoints and a grid secret (the "Copy environment" button on the runner page).
- Put them in `.env` (from `.env.example`): `EXOSCALE_API_KEY`, `EXOSCALE_API_SECRET`, `GREENOPS_CLOUD_ENDPOINT`, `GREENOPS_WORK_ENDPOINT`, `GREENOPS_GRID_ENDPOINT`, `GREENOPS_GRID_SECRET`.
- `.env`, `env/`, `greenops-exo.json`, the orchestrator's receipt and logs (`greenops-orchestrator-state.json`, `orchestrator-run.log`, `orchestrator-events.jsonl`) and `runs-archive/` are gitignored and dockerignored. The image never contains them: `docker run --env-file .env` injects at runtime.
- The `/live` page uses the server-side `.env` automatically (it only receives booleans, never the values); manual paste into the page still works as a fallback.

## Run commands

```bash
make status        # read-only run state: state, virtual clock, delivered/started workloads, zones
make creds         # write greenops-exo.json (mode 600) for the official starter kit
make starter       # clone the official starter kit (once)
make demo          # official 2-workload demo  — STARTS THE CLOCK (use a fresh run)
make attempt       # 15-workload carbon-aware orchestrator — STARTS THE CLOCK
make attempt-dry   # plan-only preview of the orchestrator (safe, no writes)
make mock          # offline mock of the engine + slow API driving the real controller (no credentials)
make cleanup-run   # delete this controller's VMs via its receipt (after a run)
make dashboard     # print monitor + challenge board URLs
```

`make attempt` and `attempt-dry` run `scripts/orchestrator.mjs` inside the app container (`bun`), so the host needs nothing besides Docker and the `.env`.

### Running a scoring attempt, step by step

A run is single-shot: its clock starts on the first VM create and cannot be rewound.

1. **Create a fresh run** in the portal (any speed; the official reruns use 720×, ≈ 10 min). **Do not run `make demo` or the starter kit's `static.py` on it** — their first VM starts the clock. (If it happens anyway, the controller adopts those VMs and replaces any that haven't started real work on a dirtier placement.)
2. **Put the run's environment block in `.env`** (see "Run credentials" above).
3. **`make mock`** — offline check of the controller: synthetic grid, simulated API lag, no credentials. Expect `failures 0/20`.
4. **`make status`** — the run must be `READY` (clock not started).
5. **`make attempt-dry`** — reads the real run (zones, live profiles, templates, forecasts) and prints the first decision; it changes nothing on the run.
6. **`make attempt`** — starts the clock and runs unattended until all 15 workloads are delivered, then deletes its VMs and exits. Progress: `orchestrator-run.log` (readable) and `orchestrator-events.jsonl` (one JSON line per decision and per API reply, with latency and simulated hours elapsed).
7. **If interrupted**, rerun `make attempt`: the receipt (`greenops-orchestrator-state.json`) lets it pick up its own VMs. `make cleanup-run` deletes them.

Without Docker (Node ≥ 22): `node scripts/orchestrator.mjs [--dry]` with the same variables in the environment or `.env`. `GREENOPS_STATE_DIR` sets where the receipt and logs go (default: the working directory, or `/tmp` if it isn't writable — as in the judging container).

Mock options: `node scripts/greenops/mock.mjs [seeds] --lat <ms> [--foreign --late <hours>] [--opt key=value] [--ctl key=value]`; env `MOCK_STAGING=idle` (alternative power model), `MOCK_QUOTA=big` (no quota, diagnostic), `MOCK_SLOW=0.95` (engine slower than the catalog), `MOCK_PRESTAGE=0` (engine refuses staging before release), `MOCK_FC_BIAS=0.3` (forecasts biased by up to ±30 %), `MOCK_FC_ANOM=0.08,0.8` (persistent misses the forecast doesn't know), `MOCK_HIST_LAG=0` (observations published without delay). It reports mean points (exact score formula), kg CO₂e, a perfect-foresight lower bound and missed deadlines.

## How runs work (facts, verified from the platform docs, the API and our runs)

- The clock starts on your **first accepted VM deployment**, not at run creation. Creating a run costs nothing until you deploy.
- **Score** (frozen `greenops-score-v2`, electricity only): per workload `20000 · (Rᵢ/ΣR) / (1 + 0.75·cᵢ/Rᵢ + 0.25·C/ΣR)`, plus 5 000 if all 15 deliver on time — `Rᵢ` = 200 g/kWh × the workload's reference energy (`challenge/rules.json`), `cᵢ` its electricity CO₂, `C` the total. Fitted on the official per-workload breakdown of one run and confirmed on a second (< 0.01 points per workload); implemented as `score()` in `scripts/greenops/model.mjs`. Consequence: a kg saved on a CPU job is worth ≈ 190–240 points, on the big GPU jobs only ≈ 140.
- **Speeds**: 1× (5 days), 60× (2 h), 360× (20 min), 720× (10 min). Speed doesn't change the scoring, but API lag (3–20 s per call under load in our early runs, ≈ 10 ms in the latest ones) costs 12× more simulated time at 720× than at 60×. Official judging reruns at 720×; the controller measures the lag and adapts.
- **Stopped VMs** draw 0 W and keep all progress, but still hold their quota. **Resuming** continues where the VM stopped, without a second boot or input staging (starter guide), so a pause costs only the API call. **Deleting** loses work since the last checkpoint (all of it for restart-from-zero jobs). Boot and input staging can run before a workload's release; compute waits for it.
- **Grid observations** (`/carbon-intensity/history`, this run only): in run `d84022b1` the newest published point was always stamped with the current hour, although the guide describes a 1 h publication delay. Forecast misses persisted from hour to hour (lag-1 correlation 0.5–0.85 in DE, ES, IT, HR, AT and BG; below 0.3 in FR and CH), and the average forecast bias was small (≈ 0–4 %). The 6 h forecast is the 24 h one cut short; 48/72 h are rejected.
- The scenario's grid was the same in every run we made (a GPU job placed the same way had the same carbon to 0.03 % in two runs), so differences between runs come from the controller's decisions.
- Attempts: unlimited, max **2 unfinished** runs per team; each run sees only its own published forecasts and observations (fair play).
- Residency: an illegal placement attempt disqualifies the run (score 0) — the engine enforces the same rule in simulation.

## The controller (`make attempt`)

`scripts/orchestrator.mjs` is the entrypoint; the logic lives in `scripts/greenops/` (`policy.mjs` decides, `controller.mjs` executes, `model.mjs` holds the catalog, legality and score, `mock.mjs` tests it offline). It only uses the public catalog and rules (`challenge/`), its own run's status, and its own run's currently published forecasts and grid observations. It never stores grid values: every run shares one scenario grid, so a kept series would be a view of the next run's future.

How it decides, in plain terms:

1. **Where** — each job goes to the legal zone and machine with the lowest expected carbon: energy × the datacenter's PUE × the cheapest forecast hours it will need, with a small penalty for taking a large share of the shared vCPU / GPU quota. Residency is re-checked right before every create.
2. **When** — a job runs in the cleanest hours of the published 24 h forecast, as many as it still needs before its deadline, and is stopped (0 W) in the dirtier ones. Pauses are ranked by **points** saved, using the score formula. With a fast API, a job's VM is created about boot + input time **before** its release, so its input is loaded by the time it releases and the whole window is left for compute (if it would otherwise sit waiting, it is parked at 0 W).
3. **Safety** — before any pause or delayed start it fast-forwards the rest of the schedule (all jobs flat-out afterwards; jobs claim the 320-vCPU quota in deadline order, including jobs not released yet). A pause is kept only if every job still finishes before its deadline minus a margin. While a job that may use several workers waits, its quota is reserved as a single worker, so it can't be pushed to the end and squeezed in.
4. **Forecast correction** — every hour it compares this run's published observations with what its earlier forecasts said. It applies a learned per-lead-time bias (shrunk toward 0, capped at ±30 %). When this run's misses persist from hour to hour (lag-1 correlation ≥ 0.3 over ≥ 12 hourly pairs), it also carries the latest miss forward, fading at the measured rate.
5. **Slow API** — status polls, forecasts and VM actions run in the background, so a slow call never stalls the loop. It extrapolates the simulated clock, plans for when an action will actually land, and widens margins as lag grows. Settings that only pay off with a fast API (wider CPU windows, a lower pause bar, a 1 h instead of 4 h minimum deadline margin for CPU jobs, pre-staging) switch on only below ≈ 0.15 simulated hours of lag (≈ 0.75 s per call at 720×).
6. **Housekeeping** — deterministic VM names + a receipt; it adopts VMs it didn't create, deletes VMs as soon as their job delivers, and deletes VMs of a job whose deadline has passed.

Practice runs with this controller (360× or 720×, 15/15 delivered, 0 API errors each):

| Run | Score | Electricity CO₂ | What changed |
|---|---|---|---|
| `427b8228` | 21 820.5 | 14.29 kg | first clean run of this controller (run pre-started by the demo) |
| `f625ae89` | 21 913.6 | 13.83 kg | pauses ranked by points (exact score formula) |
| `2dd99b04` | 21 972.5 | 13.57 kg | wider CPU windows and a lower pause bar while API lag is low |
| `c2111a37` | 22 028.3 | 13.30 kg | waiting multi-worker jobs reserve quota as one worker (w-14 starts at t≈27, not t≈85) |
| `abbd0823` | 22 023.3 | 13.35 kg | 720×; experimental 1 h deadline margin at low lag for all jobs — CPU jobs gained, GPU jobs lost |
| `952d35db` | 22 033.3 | 13.28 kg | 720×; the 1 h low-lag margin for CPU jobs only (GPU jobs keep 4 h) |
| `d84022b1` | **22 079.8** | **13.03 kg** | 720×; forecast correction from the run's own observations + pre-staging at low lag — w-09 −0.105 kg, w-03 −0.061, w-14 −0.047; **1st on the practice leaderboard** (by 0.2 pts) |

## What was fixed / changed (this repo)

- **Live controller v3** replaces the single-file v2 (kept as `scripts/orchestrator-legacy.mjs`). Problems found in v2: profile data was read from a gitignored folder, so a fresh clone (the judges' rerun) would deploy nothing; datacenter PUE was ignored (`/zone` doesn't report it); GPU jobs never shifted to cleaner hours; network calls blocked the loop, so one slow reply cost hours of simulated time at 720×; paused CPU jobs could starve a late GPU job of quota.
- Bugs found and fixed while testing v3: a stale `READY` snapshot could start the clock more than once; the "deadline-risk" fallback could pick a placement that couldn't meet the deadline anyway; a job with no room before the run's end counted as "infinitely late", hiding harm from other pauses; the controller could mistake its own just-created VM for a foreign one.
- Run `d84022b1` changes, mock vs the run-8 settings: +19 pts at 0.1 s lag, +6.5 at 0.3 s, +12 at 1 s and +4 at 3 s. There were 0 missed deadlines, also in the stress cases: demo-started run, idle-watt staging, slower engine, biased or persistently-wrong forecasts. Pre-staging alone cost 11–53 pts at 3–10 s lag, which is why it only runs at low lag.
- Tried in the mock and **not** adopted (neutral or worse):
  - giving w-09 two GPUs: it needs 72 vCPUs while CPU jobs hold the quota, −12 to −38 pts;
  - quota-penalty variants (`scarcityMode`, `cardW`, contention-aware card shares);
  - stricter pauses while jobs queue (`dynamicBar`, a higher `pressureValuePerCore`, a larger `queueCushionH`);
  - smaller runtime margins for CPU jobs.

  Quota contention remains the largest loss in the mock (≈ 127 pts versus unlimited quota).
- `tsconfig.json` gained `"node"` in `types` (server-side `process.env` access).
- `src/lib/live.functions.ts` / `src/routes/live.tsx`: run credentials read server-side from `.env`; live page auto-detects the config and starts polling; secrets never reach the browser.
- `Makefile` `stop`/`run` force-remove stale containers (a stopped container previously blocked `make run` with a name conflict).
- A policy-parameter sweep (12 seeds × 9 configs) showed the shipped carbon-aware policy is within ±0.2 % of every alternative and the best candidates regress 2/12 seeds — **kept the shipped defaults**; no regression per the contract test ("both shipped policies stay legal and the carbon-aware one emits less").
- Pre-existing, unrelated: tsc errors in `ui/chart.tsx`, `input-otp.tsx`, `sheet.tsx`, `sidebar.tsx`, `routes/index.tsx`, `src/start.ts` (present at HEAD, untouched); `app-routing.test.tsx` fails inside the container image with a Zod resolution quirk (passes on a host install); both are infra noise, not regressions.

## Host-disk notes

`/home` has no headroom, so `node_modules` and Docker's data live elsewhere: Docker's data root is on `/goinfre`; the webapp image builds deps into its own layer. The only host footprint is the source tree (~5 MB). If you ever need host-side `bun test`/`bunx tsc`, symlink `node_modules` into a big mount (`/tmp` or `/sgoinfre`) first.

## Competition entry (the actual submission)

Submit a GitHub repo + immutable commit SHA + claimed practice run + reproducible build/run instructions; organizers review (source stays private to team + organizers; grant repo access manually) and rerun your controller at 720× on their infra — that rerun is your official score. `make attempt` + this README is the reproducible "container entry point launches the orchestrator" story. Best practice run so far: `d84022b1` (22 079.8 pts). It was made by the controller as committed in `bd65e74`; that commit only added comments, docs and a smaller trace format on top, so its decisions are the same.

### Reproducible build and run (official rerun)

The controller needs nothing but Node.js 22 (built-ins only, no npm dependencies). `Dockerfile.controller` packages only `challenge/` (public catalog, rules, legality) and `scripts/`. Its base image is pinned by digest (`node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`, Node 22.23). It runs as the unprivileged `node` user and writes only to `/tmp`.

```bash
# build (repo root, at the submitted commit)
docker build -f Dockerfile.controller -t greenops-controller .

# run against a fresh READY run: starts its clock, runs until all 15 workloads are delivered,
# deletes its VMs and exits 0 (≈ 10 min at 720×)
docker run --rm --read-only --tmpfs /tmp --env-file run.env greenops-controller
```

- **Entry point:** `node scripts/orchestrator.mjs` (the image's `ENTRYPOINT`).
- **Configuration:** environment variables only, from the fresh run's "Copy environment" block:
  - `EXOSCALE_API_KEY`, `EXOSCALE_API_SECRET`
  - `GREENOPS_CLOUD_ENDPOINT`, `GREENOPS_WORK_ENDPOINT`, `GREENOPS_GRID_ENDPOINT`, `GREENOPS_GRID_SECRET`

  `run.env` holds them as plain `KEY=value` lines (no `export`, no quotes), or pass each with `-e KEY`. Optional `GREENOPS_STATE_DIR` (default `/tmp`) holds the receipt `greenops-orchestrator-state.json` and the logs `orchestrator-run.log` and `orchestrator-events.jsonl`.
- **Preflight (optional, read-only):** append `--dry` to the run command. It reads the run and prints the first decision without creating anything, so the clock does not start.
- **Offline self-test (optional):** `docker run --rm --entrypoint node greenops-controller scripts/greenops/mock.mjs 20 --lat 3000` should report `failures 0/20`.
- **Tested** under the judging limits: `--read-only --tmpfs /tmp --user 65534:65534 --cpus 2 --memory 1g`, both with the mock and with a `--dry` pass against a live READY run. The CHF 50 Exoscale coupon is for hosting your own controller/live demo — it does not affect scoring (judging reruns on their own machines). There is no deployment to the challenge site: the dashboard is the run's own UI, and this webapp is a second, local, read-only window onto the same run.
