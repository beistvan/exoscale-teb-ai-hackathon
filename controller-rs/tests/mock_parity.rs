//! The Rust simulator + controller must reproduce the JS mock (scripts/greenops/mock.mjs driving the
//! JS controller) exactly: same points, grams, per-job grams and action counts, bit for bit.
//! A few seeds here; `node controller-rs/parity/parity.mjs --extended` runs hundreds.
mod common;
use greenops_controller::jsmath;
use greenops_controller::mock::{SimOpts, simulate};
use serde_json::Value;

fn check(lat: f64, seeds: u32) {
    let out = common::node(&["controller-rs/parity/js-seeds.mjs", &seeds.to_string(), "--lat", &lat.to_string()], None);
    let js: Vec<Value> = out.lines().map(|l| serde_json::from_str(l).unwrap()).collect();
    assert_eq!(js.len(), seeds as usize);
    let o = SimOpts { lat_ms: lat, ..Default::default() };
    for j in &js {
        let seed = j["seed"].as_u64().unwrap() as u32;
        let r = simulate(seed, &o);
        let f = |k: &str| j[k].as_f64().unwrap().to_bits();
        assert_eq!(r.points.to_bits(), f("points"), "seed {seed} lat {lat}: points {} vs JS {}", r.points, j["points"]);
        assert_eq!(r.grams.to_bits(), f("grams"), "seed {seed} lat {lat}: grams");
        assert_eq!(r.kwh.to_bits(), f("kwh"), "seed {seed} lat {lat}: kwh");
        assert_eq!(r.idle_g.to_bits(), f("idleG"), "seed {seed} lat {lat}: idle grams");
        for (id, g) in &r.per_job {
            assert_eq!(g.to_bits(), j["perJob"][id].as_f64().unwrap().to_bits(), "seed {seed} lat {lat}: {id} grams");
        }
        assert_eq!(serde_json::to_value(r.stats).unwrap(), j["stats"], "seed {seed} lat {lat}: stats");
        assert_eq!(r.late.len(), j["late"].as_array().unwrap().len(), "seed {seed} lat {lat}: late jobs");
        assert_eq!(r.rejects, j["rejects"].as_u64().unwrap());
        assert_eq!(r.left_vms as u64, j["leftVms"].as_u64().unwrap());
        assert!(!r.dq && r.late.is_empty(), "seed {seed} lat {lat}: failure");
    }
}

#[test]
fn mock_matches_js_mock_exactly() {
    if let Ok(v) = std::env::var("JSMATH_FMA") {
        jsmath::set_fma(v == "1");
    }
    let a = std::thread::spawn(|| check(100.0, 3));
    let b = std::thread::spawn(|| check(3000.0, 3));
    a.join().unwrap();
    b.join().unwrap();
}
