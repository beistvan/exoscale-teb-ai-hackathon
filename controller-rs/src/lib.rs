//! Experimental Rust port of the GreenOps live controller (`scripts/greenops`), parity-first:
//! it makes the same decisions as the JS controller (bit-identical in the offline mock).
//!
//! - `model`, `legality`: the public catalog, the frozen score, residency/profile rules
//! - `policy`: where and when to run (port of policy.mjs `decide()` with its defaults)
//! - `glue`: status + receipt → the policy's view
//! - `controller`: the latency-tolerant control loop, sans-IO
//! - `mock`: the offline simulator (synthetic grid, virtual clock, simulated API latency)
//! - `live`, `driver`: the real API (EXO2-HMAC) and the tokio driver (run / --dry / destroy)
//! - `jsmath`: JavaScript-exact Math functions (V8's fdlibm)
// `!(x > 0.0)` is deliberate: it is how the JS code treats NaN/undefined, and the port keeps it;
// nested `if`s mirror the JS line structure.
#![allow(clippy::neg_cmp_op_on_partial_ord, clippy::collapsible_if)]

pub mod cli_mock;
pub mod controller;
pub mod driver;
pub mod glue;
pub mod jsmath;
pub mod legality;
pub mod live;
pub mod mock;
pub mod model;
pub mod policy;
pub mod tweaks;
