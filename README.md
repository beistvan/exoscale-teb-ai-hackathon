# GreenOps carbon-aware orchestrator

Team **zero-reference** · Exoscale GreenOps Challenge, The Energy Bridge Critical Infrastructure Hackathon (Vienna, 23–25 October 2026).

An autonomous controller that completes the challenge's 15 CPU/GPU workloads on the simulated European cloud with as little electricity CO₂ as possible, without missing a deadline or breaking a residency rule. It decides **where** each workload runs (zone, machine, number of workers), **when** it runs or pauses, and **when** its VMs are deleted. It uses only the public catalog and the controlled run's own status, forecasts and published grid observations.

**Best practice run:** `d84022b1` — **22 079.8 points**, 13.03 kg CO₂e electricity, 15/15 delivered on time, 1st on the practice leaderboard.

Challenge rules and API: [greenops-challenge-starter-kit](https://github.com/exogmi/greenops-challenge-starter-kit) (`docs/RULES.md`, `docs/API.md`).

## Build and run (official rerun)

The controller needs only Node.js 22 (built-ins only, no npm dependencies). `Dockerfile.controller` packages just `challenge/` (public catalog, rules, legality) and `scripts/`. Its base image is pinned by digest (`node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914`, Node 22.23). It runs as the unprivileged `node` user and writes only to `/tmp`.

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
- **Tested** under the judging limits (`--read-only --tmpfs /tmp --user 65534:65534 --cpus 2 --memory 1g`), built from a clean checkout: the mock passes, and a `--dry` pass works against a live READY run.

## How the controller decides

1. **Where** — each job goes to the legal zone and machine with the lowest expected carbon: energy × the datacenter's PUE × the cheapest forecast hours it will need, with a small penalty for taking a large share of the shared vCPU / GPU quota. Residency is re-checked right before every create; an illegal attempt would disqualify the run.
2. **When** — a job runs in the cleanest hours of the published 24 h forecast, as many as it still needs before its deadline, and is stopped (0 W) in the dirtier ones. Pauses are ranked by the **points** they save, using the exact score formula. With a fast API, a job's VM is created about boot + input time before its release. Its input is then loaded by the time it releases, leaving the whole window for compute (if it would otherwise sit waiting, it is parked at 0 W).
3. **Safety** — before any pause or delayed start it fast-forwards the rest of the schedule: all jobs run flat-out afterwards, and they claim the 320-vCPU quota in deadline order, including jobs not released yet. A pause is kept only if every job still finishes before its deadline minus a margin. While a job that may use several workers waits, its quota is reserved as a single worker, so it can't be pushed to the end and squeezed in.
4. **Forecast correction** — every hour it compares this run's published observations with what its earlier forecasts said. It applies a learned per-lead-time bias (shrunk toward 0, capped at ±30 %). When this run's misses persist from hour to hour (lag-1 correlation ≥ 0.3 over ≥ 12 hourly pairs), it also carries the latest miss forward, fading at the measured rate.
5. **Slow API** — status polls, forecasts and VM actions run in the background, so a slow call never stalls the loop. It extrapolates the simulated clock, plans for when an action will actually land, and widens margins as lag grows. Settings that only pay off with a fast API switch on only below ≈ 0.15 simulated hours of lag (≈ 0.75 s per call at 720×): wider CPU windows, a lower pause bar, a 1 h instead of 4 h minimum deadline margin for CPU jobs, and pre-staging.
6. **Housekeeping** — deterministic VM names and a receipt. It adopts VMs it didn't create, deletes VMs as soon as their job delivers, and deletes the VMs of a job whose deadline has passed.

Code: `scripts/orchestrator.mjs` (entry point) → `scripts/greenops/`: `policy.mjs` decides, `controller.mjs` executes, `model.mjs` holds the catalog, legality and score, `liveapi.mjs` talks to the API, `mock.mjs` tests offline.

## Results

Practice runs (15/15 delivered on time, 0 API errors each):

| Run | Score | Electricity CO₂ | What changed |
|---|---|---|---|
| `427b8228` | 21 820.5 | 14.29 kg | first clean run of this controller |
| `f625ae89` | 21 913.6 | 13.83 kg | pauses ranked by points (exact score formula) |
| `2dd99b04` | 21 972.5 | 13.57 kg | wider CPU windows and a lower pause bar while API lag is low |
| `c2111a37` | 22 028.3 | 13.30 kg | waiting multi-worker jobs reserve quota as one worker (w-14 starts at t≈27, not t≈85) |
| `abbd0823` | 22 023.3 | 13.35 kg | 720×; 1 h deadline margin at low lag for all jobs: CPU jobs gained, GPU jobs lost |
| `952d35db` | 22 033.3 | 13.28 kg | 720×; the 1 h low-lag margin for CPU jobs only (GPU jobs keep 4 h) |
| `d84022b1` | **22 079.8** | **13.03 kg** | 720×; forecast correction from the run's own observations + pre-staging at low lag (w-09 −0.105 kg, w-03 −0.061, w-14 −0.047) |
| `4c6e96e2` | 22 061.1 | 13.14 kg | 720×; test: the current hour's published observation used from t=0 (`nowcastLead0`). Swiss jobs gained, but knock-on quota timing cost the GPU and Spanish jobs. Off by default |
| `10b214d2` | 22 078.9 | 13.04 kg | 360×; the test above + a 9 % GPU early-phase margin (`marginFracGpu: 0.09`). On par with `d84022b1`; off by default |

Tried in the mock and not adopted (neutral or worse):
- giving the big GPU job w-09 two GPUs: it needs 72 vCPUs while CPU jobs hold the quota, −12 to −38 pts;
- quota-penalty variants;
- stricter pause rules while jobs queue;
- smaller runtime margins for CPU jobs;
- staging before release even in dirty hours (`prestageNoDefer`) and pausing the output phase (`pauseOutput`).

Pre-staging cost 11–53 pts at 3–10 s API lag, so it only runs at low lag. Quota contention is the largest remaining loss in the mock (≈ 127 pts versus unlimited quota).

## Platform facts we rely on

Verified from the platform docs, the API and our runs:

- The clock starts on the **first accepted VM create**, not at run creation. Official judging uses a fresh run at **720×** (120 simulated hours in ≈ 10 min), so 1 s of API lag costs 0.2 simulated hours.
- **Score** (frozen `greenops-score-v2`, electricity only): per workload `20000 · (Rᵢ/ΣR) / (1 + 0.75·cᵢ/Rᵢ + 0.25·C/ΣR)`, plus 5 000 if all 15 deliver on time.
  - `Rᵢ` = 200 g/kWh × the workload's reference energy (`challenge/rules.json`), `cᵢ` its electricity CO₂, `C` the total.
  - Fitted on one run's official per-workload breakdown and confirmed on a second (< 0.01 points per workload); implemented as `score()` in `scripts/greenops/model.mjs`.
  - A kg saved on a CPU job is worth ≈ 190–240 points, on the big GPU jobs only ≈ 140.
- **Stopped VMs** draw 0 W and keep all progress, but still hold their quota. **Resuming** continues without a second boot or input staging. **Deleting** loses work since the last checkpoint (all of it for restart-from-zero jobs). Boot and input staging can run before a workload's release; compute waits for it.
- **Grid observations** (`/carbon-intensity/history`, own run only): the newest published point carried the current hour's timestamp (the guide describes a 1 h delay). Forecast misses persisted from hour to hour (lag-1 correlation 0.5–0.85 in DE, ES, IT, HR, AT and BG; below 0.3 in FR and CH), and the average forecast bias was small (≈ 0–4 %). The 6 h forecast is the 24 h one cut short.
- The scenario's grid is the same in every run, so differences between runs come from the controller's decisions. A given controller version is deterministic: runs `4c6e96e2` (720×) and `10b214d2` (360×) produced identical per-job results for every job their settings didn't touch. Small decision changes still cascade through the shared quota and move the total by ±10–20 points. For the same reason, **no grid data is stored or reused across runs** (fair play: only the controlled run's own published data is used, at decision time).

## Development

| Part | Location |
|---|---|
| Challenge data (single source) | `challenge/`: `catalog.json` + `rules.json` from the starter kit, and `legality.mjs`, the one residency/profile check |
| Live controller | `scripts/orchestrator.mjs`, `scripts/greenops/` |
| Offline mock (synthetic grid, simulated API lag) | `scripts/greenops/mock.mjs` |
| Web dashboard + TypeScript simulator | `src/routes` (dashboard, read-only `/live` run monitor), `src/lib/sim` |
| Containers | `Dockerfile.controller` (controller), `Dockerfile` (web app and tools), `Makefile` |

`orchestrator-events.jsonl` has one JSON line per decision and per API reply. It also logs every GPU pause the clean-hour rule wanted but a safety check refused, with the reason (`"k":"why"`).

**Credentials are never committed.** Copy `.env.example` to `.env` and fill in the run's "Copy environment" block. `.env`, `greenops-exo.json`, the receipt, the logs and `runs-archive/` are gitignored and dockerignored.

**A practice attempt, step by step** (a run is single-shot: the clock can't be rewound):

1. Create a fresh run in the portal. Don't run the starter kit's demo on it: its first VM starts the clock (if it happens, the controller adopts those VMs).
2. Put the run's environment block in `.env`.
3. `node scripts/greenops/mock.mjs 20 --lat 3000` — offline check; expect `failures 0/20`.
4. `node scripts/orchestrator.mjs --dry` — read-only preview against the real run; it must be `READY`.
5. `node scripts/orchestrator.mjs` — starts the clock and runs unattended until all 15 workloads are delivered, then deletes its VMs. If interrupted, run it again: the receipt lets it pick up its own VMs; `node scripts/orchestrator.mjs destroy` deletes them.

The same steps run inside the web-app container via `make mock`, `make attempt-dry`, `make attempt` and `make cleanup-run`; `make status` shows the run's state.

**Mock options:** `node scripts/greenops/mock.mjs [seeds] --lat <ms> [--foreign --late <hours>] [--opt key=value] [--ctl key=value]`. It reports mean points (exact score formula), kg CO₂e, a perfect-foresight lower bound and missed deadlines. Stress settings (env):
- `MOCK_SLOW=0.95` — engine slower than the catalog;
- `MOCK_STAGING=idle` — staging at idle power;
- `MOCK_PRESTAGE=0` — no staging before release;
- `MOCK_QUOTA=big` — no quota;
- `MOCK_FC_BIAS=0.3` — biased forecasts;
- `MOCK_FC_ANOM=0.08,0.8` — persistent forecast misses;
- `MOCK_HIST_LAG=0` — observation publication lag.

**Web dashboard (optional):** `make run` builds and starts it (default http://localhost:3005/). `/live` polls a run read-only; credentials stay server-side.
