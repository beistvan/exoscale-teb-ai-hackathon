//! The Rust legality must agree with `challenge/legality.mjs` exactly: one illegal create
//! disqualifies a live run. Checked on every (workload, zone, profile) of the catalog, on the
//! candidate lists the policy chooses from, and on random synthetic cases.
mod common;
use greenops_controller::legality::{profile_legal, zone_legal};
use greenops_controller::model::{Catalog, Profile, Workload, Zone, candidates};
use serde_json::{Value, json};

struct Lcg(u64);
impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = (self.0 * 1664525 + 1013904223) % (1 << 32);
        self.0 as f64 / 4294967296.0
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.next() * xs.len() as f64) as usize]
    }
    fn subset(&mut self, xs: &[&str], p_null: f64) -> Option<Vec<String>> {
        if self.next() < p_null {
            return None;
        }
        Some(xs.iter().filter(|_| self.next() < 0.35).map(|s| s.to_string()).collect())
    }
}

fn workload(v: &Value) -> Workload {
    let list = |k: &str| v[k].as_array().map(|a| a.iter().map(|x| x.as_str().unwrap().to_string()).collect::<Vec<_>>());
    Workload {
        id: "w".into(),
        kind: v["kind"].as_str().unwrap().into(),
        unit: v["unit"].as_str().unwrap().into(),
        required: 1.0,
        release: 0.0,
        deadline: 0.0,
        residency: v["residency"].as_str().unwrap().into(),
        allowed: list("allowed"),
        forbidden: list("forbidden").unwrap_or_default(),
        profile_ids: list("profileIds"),
        families: list("families"),
        min_vram: v["minVram"].as_f64().unwrap(),
        max_workers: 1.0,
        sync: 0.0,
        input_s: 0.0,
        output_s: 0.0,
        checkpoint_s: 0.0,
        restart_from_zero: false,
    }
}

#[test]
fn legality_agrees_with_legality_mjs_on_every_combination_and_random_cases() {
    // random synthetic cases in the normalised shapes legality.mjs takes
    let countries = ["AT", "BG", "CH", "DE", "ES", "FR", "HR", "IT", "US", "LI"];
    let fams = ["cpu", "gpu2", "gpu3", "gpua30", "gpua5000", "gpu3080ti", "gpurtx6000pro"];
    let ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
    let mut r = Lcg(7);
    let mut cases = Vec::new();
    let vrams = [0.0, 12.0, 16.0, 24.0, 48.0, 96.0, 100.0];
    for _ in 0..20000 {
        let min_vram = vrams[(r.next() * 7.0) as usize];
        let w = json!({
            "kind": r.pick(&["cpu", "gpu", "other"]),
            "unit": r.pick(&["vcpu_hour", "tflop"]),
            "residency": r.pick(&["EU", "CH", "ANYWHERE", "OTHER", "", "eu"]),
            "allowed": r.subset(&countries, 0.3),
            "forbidden": r.subset(&countries, 0.0).unwrap(),
            "profileIds": r.subset(&ids, 0.5),
            "families": r.subset(&fams, 0.4),
            "minVram": min_vram,
        });
        let z = json!({ "country": r.pick(&countries), "eu": r.next() < 0.6 });
        let vram = vrams[(r.next() * 6.0) as usize];
        let p = json!({ "id": r.pick(&ids), "family": r.pick(&fams), "unit": r.pick(&["vcpu_hour", "tflop"]), "vram": vram });
        cases.push(json!({ "w": w, "z": z, "p": p }));
    }
    let out = common::node(&["controller-rs/tests/js/legality-all.mjs"], Some(&serde_json::to_string(&cases).unwrap()));
    let js: Value = serde_json::from_str(&out).unwrap();

    // 1. every catalog combination
    let cat = Catalog::builtin();
    let combos = js["combos"].as_array().unwrap();
    assert_eq!(combos.len(), cat.workloads.len() * cat.zones.len() * cat.profiles.len());
    assert_eq!(combos.len(), 15 * 11 * 22);
    let mut n_legal = 0;
    for c in combos {
        let (w, z, p) = (
            cat.workload(c[0].as_str().unwrap()).unwrap(),
            cat.zone(c[1].as_str().unwrap()).unwrap(),
            cat.profile(c[2].as_str().unwrap()).unwrap(),
        );
        assert_eq!(zone_legal(w, z), c[3].as_bool().unwrap(), "zoneLegal {} {}", w.id, z.slug);
        assert_eq!(profile_legal(w, p), c[4].as_bool().unwrap(), "profileLegal {} {}", w.id, p.id);
        assert_eq!(p.offered_in(&z.slug), c[5].as_bool().unwrap(), "offered {} {}", p.id, z.slug);
        if c[3].as_bool().unwrap() && c[4].as_bool().unwrap() && c[5].as_bool().unwrap() {
            n_legal += 1;
        }
    }
    assert!(n_legal > 0);

    // 2. the candidate lists (order included: the policy breaks ties by it)
    for w in &cat.workloads {
        let ours: Vec<String> =
            candidates(&cat, w).iter().map(|c| format!("{}|{}|{}", cat.zones[c.zone].slug, cat.profiles[c.prof].id, c.k)).collect();
        let theirs: Vec<String> = js["cands"][&w.id].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect();
        assert_eq!(ours, theirs, "candidates of {}", w.id);
    }

    // 3. random synthetic cases
    let random = js["random"].as_array().unwrap();
    assert_eq!(random.len(), cases.len());
    let (mut zl, mut pl) = (0, 0);
    for (case, want) in cases.iter().zip(random) {
        let w = workload(&case["w"]);
        let z = Zone {
            slug: "z".into(),
            country: case["z"]["country"].as_str().unwrap().into(),
            area: String::new(),
            eu: case["z"]["eu"].as_bool().unwrap(),
            pue: 1.0,
        };
        let p = Profile {
            id: case["p"]["id"].as_str().unwrap().into(),
            family: case["p"]["family"].as_str().unwrap().into(),
            size: String::new(),
            label: String::new(),
            cores: 1.0,
            cards: 1.0,
            vram: case["p"]["vram"].as_f64().unwrap(),
            watts: 1.0,
            idle_watts: 1.0,
            tput: 1.0,
            unit: case["p"]["unit"].as_str().unwrap().into(),
            boot_s: 120.0,
            zones: vec![],
            is_cpu: case["p"]["family"] == "cpu",
        };
        assert_eq!(zone_legal(&w, &z), want[0].as_bool().unwrap(), "zoneLegal {case}");
        assert_eq!(profile_legal(&w, &p), want[1].as_bool().unwrap(), "profileLegal {case}");
        zl += want[0].as_bool().unwrap() as usize;
        pl += want[1].as_bool().unwrap() as usize;
    }
    // the random cases must exercise both outcomes
    assert!(zl > 1000 && zl < cases.len() - 1000, "zone-legal cases: {zl}");
    assert!(pl > 1000 && pl < cases.len() - 1000, "profile-legal cases: {pl}");
    eprintln!(
        "legality: {} catalog combinations ({n_legal} legal placements), {} random cases — all agree with legality.mjs",
        combos.len(),
        cases.len()
    );
}
