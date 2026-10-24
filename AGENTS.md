<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Challenge data has one source: `challenge/catalog.json` + `challenge/rules.json` (vendored from the starter kit). The simulator (`src/lib/sim/data.ts`) and the live controller (`scripts/greenops/model.mjs`) both load it — never add a second copy or hand-typed workload/zone/profile data. To update, replace those files with the starter kit's.
- Legality has one implementation: `challenge/legality.mjs` (`zoneLegal`, `profileLegal`). The engine and the controller both call it; change rules there only, and keep `legality.d.mts` in sync.
- Simulation lives in `src/lib/sim` as pure, deterministic TS (seeded); policies receive only `PolicyView` (forecast published at the current step) so they can never read future actuals — mirrors the challenge's fair-play rule. Grid carbon in the simulator is synthetic (`CARBON_MODEL` in `data.ts`); the catalog has no electricity data.
- Residency is checked in the engine: any illegal deploy attempt disqualifies the run (score 0), matching the challenge rule.
- The web app is read-only: live-run API calls go through the `exoGet` server function (EXO2-HMAC signing, GET only); credentials are passed per call and never stored.

## Live controller (`scripts/orchestrator.mjs` → `scripts/greenops/`)
- This is the only code that writes to a run (creates, stops, deletes VMs). `orchestrator-legacy.mjs` is the superseded v1, kept for reference — don't extend it.
- A run is single-shot: the clock starts on the first create. Before any live attempt, run `make mock` (offline, synthetic grid, simulated API latency) and `make attempt-dry` (plan-only against the real run); only then `make attempt`.
- The API can take 3–20 s per call, so controller logic must stay async and tolerate slow/lost responses (receipts + deterministic VM names). Test changes with `mock.mjs --lat`.
- Fair play: decisions may use only this run's own published data (status, forecasts, grid observations), at decision time. Never store, archive or reuse grid series across runs, and never tune the policy or mock to them — every run shares one scenario grid, so that would be a view of the future. The mock grid stays synthetic.
- Secrets and run artifacts (`.env`, `greenops-exo.json`, `greenops-orchestrator-state.json`, `orchestrator-events.jsonl`, `runs-archive/`) are gitignored and dockerignored; keep it that way.
