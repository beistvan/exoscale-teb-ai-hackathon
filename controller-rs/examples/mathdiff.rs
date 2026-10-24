//! Which `jsmath` variant matches a given Node build? Generate vectors with that Node
//! (`node controller-rs/tests/js/jsmath-vectors.mjs 100000 > vec.txt`) and run
//! `cargo run --release --example mathdiff -- vec.txt`: it counts mismatches per function for the
//! plain fdlibm variant (x86-64 V8) and the FMA-contracted one (arm64 V8 built with clang).
use greenops_controller::jsmath::*;
use std::io::BufRead;
fn bits(h: &str) -> f64 {
    f64::from_bits(u64::from_str_radix(h, 16).unwrap())
}
fn main() {
    let path = std::env::args().nth(1).unwrap();
    let f = std::io::BufReader::new(std::fs::File::open(path).unwrap());
    let mut stats: std::collections::BTreeMap<String, [usize; 3]> = Default::default();
    let mut shown = 0;
    for line in f.lines() {
        let line = line.unwrap();
        let p: Vec<&str> = line.split(' ').collect();
        let (want, plain, fused) = match p[0] {
            "log" => (bits(p[2]), log_v::<false>(bits(p[1])), log_v::<true>(bits(p[1]))),
            "exp" => (bits(p[2]), exp_v::<false>(bits(p[1])), exp_v::<true>(bits(p[1]))),
            "cos" => (bits(p[2]), cos_v::<false>(bits(p[1])), cos_v::<true>(bits(p[1]))),
            _ => (bits(p[3]), pow_v::<false>(bits(p[1]), bits(p[2])), pow_v::<true>(bits(p[1]), bits(p[2]))),
        };
        let e = stats.entry(p[0].to_string()).or_default();
        e[0] += 1;
        if want.to_bits() != plain.to_bits() {
            e[1] += 1;
        }
        if want.to_bits() != fused.to_bits() {
            e[2] += 1;
            if shown < 8 {
                shown += 1;
                println!("fma mismatch: {line} -> {:016x}", fused.to_bits());
            }
        }
    }
    for (k, v) in stats {
        println!("{k}: n={} plain-mismatch={} fma-mismatch={}", v[0], v[1], v[2]);
    }
}
