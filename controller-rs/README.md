# controller-rs: Rust port of the GreenOps live controller (experimental)

A parity-first port of `scripts/orchestrator.mjs` + `scripts/greenops/`. It makes the same decisions as the JS controller: in the offline mock, every seed is bit-identical to `scripts/greenops/mock.mjs` ([PARITY.md](PARITY.md)). The JS controller stays the submission.

| Module | Ports | What it does |
|---|---|---|
| `model.rs` | `model.mjs` | catalog + rules (compiled in from `../challenge/`), rates, score, quota |
| `legality.rs` | `challenge/legality.mjs` | residency / profile rules |
| `policy.rs` | `policy.mjs` `decide()` | where and when to run; defaults only (gate2, points-aware, low-lag overrides) |
| `glue.rs` | `glue.mjs` | status + receipt → the policy's view, per-job rate tracker |
| `controller.rs` | `controller.mjs` | the control loop, sans-IO: API calls go to an outbox, replies come back as `on_reply` |
| `mock.rs`, `cli_mock.rs` | `mock.mjs` | offline engine, synthetic grid, virtual clock, lognormal API latency |
| `live.rs` | `liveapi.mjs` | HTTP (reqwest + rustls), EXO2-HMAC signing, retries; refuses non-GET in dry mode |
| `driver.rs`, `main.rs` | `orchestrator.mjs` | tokio driver: run, `--dry`, `destroy`; receipt + logs in `GREENOPS_STATE_DIR` |
| `jsmath.rs` | V8 `ieee754.cc` | JS-exact `Math.log/exp/cos/pow` (fdlibm, with and without FMA contraction) |

## Keeping parity

Change the JS controller first, then mirror the change here and re-run the checks. The port stays exact because:

- expressions keep the JS operand order (float `+` and `*` aren't associative), maps keep insertion order, sorts are stable with the same comparators, and `Math.max/min/round`, `toFixed` and millisecond timestamps follow JS semantics (`model::jmax/jmin`, `jsmath`);
- each JS promise continuation is an explicit `Cont` in `controller.rs`, and the mock runs one virtual-clock event per JS microtask cascade, so API calls happen in the same order with the same latency draws;
- caches (`bias_for`, corrected forecasts, sorted forecast windows, candidate rates) only memoise pure functions, so they never change a result.

Checks: `cargo test --release` (needs `node` 22: legality on every catalog combination, JS math bit-exactness, request signing vs `liveapi.mjs`, mock seeds vs the JS mock, and the live loop against a local fake API), then `node controller-rs/parity/parity.mjs --extended` for hundreds of seeds.

## Safety

- A live run is single-shot: `greenops-controller` without `--dry` starts the clock on its first create. Run `mock` and `--dry` first.
- `--dry` makes no writes: creates, stops and deletes are answered locally, the HTTP layer refuses any non-GET, and no receipt or log file is written.
- Every create re-checks residency (`legality.rs`) right before the call; an illegal attempt disqualifies a run.
- Credentials come from the environment (or `./.env`, gitignored) and are never written anywhere.
