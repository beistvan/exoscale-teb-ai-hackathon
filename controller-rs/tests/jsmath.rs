//! src/jsmath.rs must reproduce Node's Math.log/exp/cos/pow bit for bit on the inputs the mock and
//! the controller use (and on wide random ranges).
mod common;
use greenops_controller::jsmath;

fn bits(h: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(h, 16).unwrap())
}

#[test]
fn math_matches_node_bit_for_bit() {
    let n = std::env::var("JSMATH_N").unwrap_or_else(|_| "100000".into());
    if let Ok(v) = std::env::var("JSMATH_FMA") {
        jsmath::set_fma(v == "1");
    }
    let out = common::node(&["controller-rs/tests/js/jsmath-vectors.mjs", &n], None);
    let (mut total, mut bad) = (0usize, Vec::new());
    for line in out.lines() {
        let f: Vec<&str> = line.split(' ').collect();
        let (want, got) = match f[0] {
            "log" => (bits(f[2]), jsmath::log(bits(f[1]))),
            "exp" => (bits(f[2]), jsmath::exp(bits(f[1]))),
            "cos" => (bits(f[2]), jsmath::cos(bits(f[1]))),
            "pow" => (bits(f[3]), jsmath::pow(bits(f[1]), bits(f[2]))),
            other => panic!("unknown fn {other}"),
        };
        total += 1;
        if want.to_bits() != got.to_bits() && !(want.is_nan() && got.is_nan()) {
            bad.push(format!("{line} -> rust {:016x}", got.to_bits()));
        }
    }
    assert!(total > 1000, "too few vectors");
    assert!(bad.is_empty(), "{} of {total} differ, e.g.:\n{}", bad.len(), bad.iter().take(20).cloned().collect::<Vec<_>>().join("\n"));
}
