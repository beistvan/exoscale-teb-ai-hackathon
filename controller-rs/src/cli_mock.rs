//! `greenops-controller mock ...`: the offline simulator CLI (same output as mock.mjs).

use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Instant;

use crate::mock::{MockEnv, SimOpts, SimResult, simulate};

/// JS `x.toFixed(d)` for display (round half up on the exact binary value).
pub fn to_fixed(x: f64, d: usize) -> String {
    if !x.is_finite() {
        return format!("{x}");
    }
    let exact = format!("{:.*}", d + 30, x.abs());
    let (int, frac) = exact.split_once('.').unwrap_or((&exact, ""));
    let mut digits: Vec<u8> = int.bytes().chain(frac.bytes().take(d)).map(|b| b - b'0').collect();
    let round_up = frac.as_bytes().get(d).is_some_and(|&b| b >= b'5');
    if round_up {
        let mut i = digits.len();
        loop {
            if i == 0 {
                digits.insert(0, 1);
                break;
            }
            i -= 1;
            if digits[i] == 9 {
                digits[i] = 0;
            } else {
                digits[i] += 1;
                break;
            }
        }
    }
    let n_int = digits.len() - d;
    let mut s: String = digits[..n_int].iter().map(|d| (b'0' + d) as char).collect();
    if d > 0 {
        s.push('.');
        s.extend(digits[n_int..].iter().map(|d| (b'0' + d) as char));
    }
    let zero = digits.iter().all(|&d| d == 0);
    if x < 0.0 && !zero { format!("-{s}") } else { s }
}

fn stats_json(r: &SimResult) -> String {
    serde_json::to_string(&r.stats).unwrap()
}

pub fn run(args: &[String]) -> i32 {
    let mut seeds = 20usize;
    let mut from = 1u32;
    let mut lat = 3000.0;
    let mut json = false;
    let mut threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1);
    let mut o = SimOpts::default();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let next = |i: usize| args.get(i + 1).cloned().unwrap_or_default();
        match a {
            "--lat" => {
                lat = next(i).parse().unwrap_or(3000.0);
                i += 1;
            }
            "--from" => {
                from = next(i).parse().unwrap_or(1);
                i += 1;
            }
            "--threads" => {
                threads = next(i).parse().unwrap_or(1);
                i += 1;
            }
            "--late" => {
                o.late_start_h = next(i).parse().unwrap_or(0.0);
                i += 1;
            }
            "--fma" => {
                crate::jsmath::set_fma(next(i) == "1");
                i += 1;
            }
            "--no-learn-bias" => o.ctl.learn_bias = false,
            "--no-nowcast" => o.ctl.nowcast = false,
            "--foreign" => o.foreign = true,
            "--verbose" => o.verbose = true,
            "--json" => json = true,
            _ if a.chars().all(|c| c.is_ascii_digit()) => seeds = a.parse().unwrap(),
            _ => {
                eprintln!(
                    "unknown mock option {a}\nusage: mock [seeds=20] [--lat MS=3000] [--from N] [--threads N] [--json] [--fma 0|1] [--foreign] [--late H] [--verbose] [--no-learn-bias] [--no-nowcast]"
                );
                return 2;
            }
        }
        i += 1;
    }
    o.lat_ms = lat;
    o.env = match MockEnv::from_env() {
        Ok(e) => e,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let t0 = Instant::now();
    let next = AtomicUsize::new(0);
    let mut results: Vec<Option<(SimResult, f64)>> = (0..seeds).map(|_| None).collect();
    let slots: Vec<std::sync::Mutex<Option<(SimResult, f64)>>> = (0..seeds).map(|_| std::sync::Mutex::new(None)).collect();
    std::thread::scope(|s| {
        for _ in 0..threads.clamp(1, seeds.max(1)) {
            s.spawn(|| {
                loop {
                    let k = next.fetch_add(1, Ordering::Relaxed);
                    if k >= seeds {
                        break;
                    }
                    let s0 = Instant::now();
                    let r = simulate(from + k as u32, &o);
                    *slots[k].lock().unwrap() = Some((r, s0.elapsed().as_secs_f64() * 1000.0));
                }
            });
        }
    });
    for (k, slot) in slots.into_iter().enumerate() {
        results[k] = slot.into_inner().unwrap();
    }
    let wall = t0.elapsed().as_secs_f64();
    let (mut tot, mut tot_b, mut tot_p, mut fails) = (0.0, 0.0, 0.0, 0);
    for (r, ms) in results.iter().flatten() {
        tot += r.grams;
        tot_b += r.bound;
        tot_p += r.points;
        if !r.late.is_empty() || r.dq {
            fails += 1;
        }
        if json {
            let per: serde_json::Map<String, serde_json::Value> =
                r.per_job.iter().map(|(k, v)| (k.clone(), serde_json::json!(v))).collect();
            println!(
                "{}",
                serde_json::json!({ "seed": r.seed, "lat": lat, "points": r.points, "grams": r.grams, "kwh": r.kwh, "idleG": r.idle_g, "late": r.late, "dq": r.dq,
                    "rejects": r.rejects, "leftVms": r.left_vms, "stats": r.stats, "perJob": per, "ms": ms })
            );
        } else {
            println!(
                "seed {:>2}: {} kg  {} kWh  idle {} kg  {} left={} rej={}{}{}",
                r.seed,
                to_fixed(r.grams / 1000.0, 2),
                to_fixed(r.kwh, 1),
                to_fixed(r.idle_g / 1000.0, 2),
                stats_json(r),
                r.left_vms,
                r.rejects,
                if r.late.is_empty() { String::new() } else { format!("  LATE {}", r.late.join(",")) },
                if r.dq { " DQ" } else { "" }
            );
            if o.verbose {
                for l in &r.lines {
                    println!("    {l}");
                }
            }
        }
    }
    let n = seeds as f64;
    let summary = format!(
        "mean {} pts, {} kg (lower bound {} kg, gap {}%), failures {}/{}  lat={}ms",
        to_fixed(tot_p / n, 1),
        to_fixed(tot / n / 1000.0, 3),
        to_fixed(tot_b / n / 1000.0, 3),
        to_fixed((tot / tot_b - 1.0) * 100.0, 1),
        fails,
        seeds,
        lat
    );
    if json {
        eprintln!("{summary}");
    } else {
        println!("{summary}");
    }
    eprintln!(
        "{seeds} seeds in {wall:.2} s ({:.1} seeds/s, {threads} threads, jsmath {})",
        n / wall,
        if crate::jsmath::fma_enabled() { "fma" } else { "plain" }
    );
    if fails > 0 { 1 } else { 0 }
}
