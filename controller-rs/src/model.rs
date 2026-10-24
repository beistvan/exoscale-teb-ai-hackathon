//! Pure challenge model (port of `scripts/greenops/model.mjs`): the public catalog, rates, energy,
//! the frozen score and the quota check. The catalog is `challenge/catalog.json` +
//! `challenge/rules.json`, the single source shared with the JS controller; both files are compiled
//! in from `../challenge` (no second copy), and `--catalog` can point at another catalog.json.

use indexmap::IndexMap;
use serde_json::Value;
use std::collections::HashMap;

use crate::jsmath;
use crate::legality::{profile_legal, zone_legal};

pub const H: f64 = 3.6e6; // ms per hour

/// Small, fast, deterministic hasher (string and integer keys; no DoS concern here).
#[derive(Default, Clone, Copy)]
pub struct Fx(u64);
impl std::hash::Hasher for Fx {
    fn finish(&self) -> u64 {
        self.0
    }
    fn write(&mut self, bytes: &[u8]) {
        for &b in bytes {
            self.0 = (self.0.rotate_left(5) ^ b as u64).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
        }
    }
    fn write_u64(&mut self, i: u64) {
        self.0 = (self.0.rotate_left(5) ^ i).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
    fn write_i64(&mut self, i: i64) {
        self.write_u64(i as u64);
    }
}
pub type FxBuild = std::hash::BuildHasherDefault<Fx>;
pub type FxMap<K, V> = std::collections::HashMap<K, V, FxBuild>;
pub type FxSet<K> = std::collections::HashSet<K, FxBuild>;

pub const CATALOG_JSON: &str = include_str!("../../challenge/catalog.json");
pub const RULES_JSON: &str = include_str!("../../challenge/rules.json");

#[derive(Clone, Debug)]
pub struct Zone {
    pub slug: String,
    pub country: String,
    pub area: String,
    pub eu: bool,
    pub pue: f64,
}

#[derive(Clone, Debug)]
pub struct Profile {
    pub id: String,
    pub family: String,
    pub size: String,
    pub label: String,
    pub cores: f64,
    pub cards: f64,
    pub vram: f64,
    pub watts: f64,
    pub idle_watts: f64,
    pub tput: f64,
    pub unit: String,
    pub boot_s: f64,
    /// zone slugs offering this profile (catalog order; discovery may remove some)
    pub zones: Vec<String>,
    pub is_cpu: bool,
}

impl Profile {
    pub fn offered_in(&self, slug: &str) -> bool {
        self.zones.iter().any(|z| z == slug)
    }
}

#[derive(Clone, Debug)]
pub struct Workload {
    pub id: String,
    pub kind: String,
    pub unit: String,
    pub required: f64,
    /// epoch ms
    pub release: f64,
    pub deadline: f64,
    pub residency: String,
    pub allowed: Option<Vec<String>>,
    pub forbidden: Vec<String>,
    pub profile_ids: Option<Vec<String>>,
    pub families: Option<Vec<String>>,
    pub min_vram: f64,
    pub max_workers: f64,
    pub sync: f64,
    pub input_s: f64,
    pub output_s: f64,
    pub checkpoint_s: f64,
    pub restart_from_zero: bool,
}

#[derive(Clone, Debug)]
pub struct Quota {
    pub vms: f64,
    pub cores: f64,
    /// GPU family -> cards (catalog key order)
    pub cards: IndexMap<String, f64>,
}

#[derive(Clone, Debug)]
pub struct Catalog {
    pub zones: Vec<Zone>,
    pub profiles: Vec<Profile>,
    pub workloads: Vec<Workload>,
    /// reference grams per workload, aligned with `workloads` (score weights)
    pub ref_g: Vec<f64>,
    pub quota: Quota,
    /// scenario start (epoch ms): hour 0 of the run
    pub t0: f64,
    zone_ix: HashMap<String, usize>,
    prof_ix: HashMap<String, usize>,
    wl_ix: HashMap<String, usize>,
}

/// JS `Number(v)` for the value shapes the catalog uses (numbers and numeric strings).
pub fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) }
        }
        Some(_) => f64::NAN,
    }
}

/// `Number(v ?? dflt)`
fn num_or(v: Option<&Value>, dflt: f64) -> f64 {
    match v {
        None | Some(Value::Null) => dflt,
        _ => js_number(v),
    }
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn str_list(v: Option<&Value>) -> Result<Option<Vec<String>>, String> {
    match v {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Array(a)) => a
            .iter()
            .map(|x| x.as_str().map(str::to_owned).ok_or_else(|| format!("expected a string list, got {x}")))
            .collect::<Result<Vec<_>, _>>()
            .map(Some),
        Some(other) => Err(format!("expected a list, got {other}")),
    }
}

fn s(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(x)) => x.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// `Date.parse` for the ISO-8601 timestamps the catalog and the API use
/// (`YYYY-MM-DDTHH:MM[:SS[.fff]][Z|+HH:MM|-HH:MM]`, also `YYYY-MM-DD`). Returns epoch ms.
/// A missing offset is read as UTC (JS would use local time; containers run in UTC).
pub fn parse_iso_ms(t: &str) -> Option<f64> {
    let b = t.trim().as_bytes();
    let dig = |i: usize, n: usize| -> Option<i64> {
        if i + n > b.len() {
            return None;
        }
        let mut v = 0i64;
        for &c in &b[i..i + n] {
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        Some(v)
    };
    let y = dig(0, 4)?;
    if b.get(4) != Some(&b'-') {
        return None;
    }
    let mo = dig(5, 2)?;
    if b.get(7) != Some(&b'-') {
        return None;
    }
    let d = dig(8, 2)?;
    let (mut hh, mut mi, mut ss, mut ms) = (0i64, 0i64, 0i64, 0f64);
    let mut i = 10;
    let mut off_min = 0i64;
    if i < b.len() && (b[i] == b'T' || b[i] == b't' || b[i] == b' ') {
        hh = dig(i + 1, 2)?;
        if b.get(i + 3) != Some(&b':') {
            return None;
        }
        mi = dig(i + 4, 2)?;
        i += 6;
        if b.get(i) == Some(&b':') {
            ss = dig(i + 1, 2)?;
            i += 3;
            if b.get(i) == Some(&b'.') {
                let st = i + 1;
                let mut e = st;
                while e < b.len() && b[e].is_ascii_digit() {
                    e += 1;
                }
                if e == st {
                    return None;
                }
                // JS keeps whole milliseconds (extra digits are truncated)
                let frac = std::str::from_utf8(&b[st..e]).ok()?;
                let f3: String = frac.chars().chain("000".chars()).take(3).collect();
                ms = f3.parse::<f64>().ok()?;
                i = e;
            }
        }
        match b.get(i) {
            None => {}
            Some(b'Z') | Some(b'z') if i + 1 == b.len() => {}
            Some(&c) if (c == b'+' || c == b'-') => {
                let oh = dig(i + 1, 2)?;
                let om = if b.get(i + 3) == Some(&b':') { dig(i + 4, 2)? } else { dig(i + 3, 2)? };
                off_min = (oh * 60 + om) * if c == b'-' { -1 } else { 1 };
            }
            _ => return None,
        }
    } else if i != b.len() {
        return None;
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || hh > 24 || mi > 59 || ss > 59 {
        return None;
    }
    // days from civil (Howard Hinnant)
    let (yy, m) = if mo <= 2 { (y - 1, mo + 9) } else { (y, mo - 3) };
    let era = if yy >= 0 { yy } else { yy - 399 } / 400;
    let yoe = yy - era * 400;
    let doy = (153 * m + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let secs = days * 86400 + hh * 3600 + mi * 60 + ss - off_min * 60;
    Some(secs as f64 * 1000.0 + ms)
}

/// `new Date(ms).toISOString()`
pub fn iso_from_ms(ms: f64) -> String {
    let ms = ms.trunc() as i64;
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{:03}Z", rem / 3_600_000, (rem / 60_000) % 60, (rem / 1000) % 60, rem % 1000)
}

impl Catalog {
    /// The compiled-in catalog (challenge/catalog.json + rules.json).
    pub fn builtin() -> Catalog {
        Catalog::from_json(CATALOG_JSON, Some(RULES_JSON)).expect("challenge/catalog.json is valid")
    }

    pub fn load(path: Option<&str>) -> Result<Catalog, String> {
        match path {
            None => Ok(Catalog::builtin()),
            Some(p) => {
                let cat = std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?;
                let rules_path = std::path::Path::new(p).with_file_name("rules.json");
                let rules = std::fs::read_to_string(rules_path).ok();
                Catalog::from_json(&cat, rules.as_deref())
            }
        }
    }

    pub fn from_json(catalog: &str, rules: Option<&str>) -> Result<Catalog, String> {
        let c: Value = serde_json::from_str(catalog).map_err(|e| format!("catalog: {e}"))?;
        let empty = vec![];
        let arr = |k: &str| c.get(k).and_then(Value::as_array).unwrap_or(&empty);
        let mut zones = Vec::new();
        for z in arr("zones") {
            let country = s(z.get("country"));
            let area = match z.get("electricity_area") {
                None | Some(Value::Null) => country.clone(),
                v => s(v),
            };
            zones.push(Zone { slug: s(z.get("slug")), country, area, eu: truthy(z.get("eu_member")), pue: js_number(z.get("pue")) });
        }
        let mut profiles = Vec::new();
        for p in arr("profiles") {
            let family = s(p.get("family"));
            let size = s(p.get("size"));
            profiles.push(Profile {
                id: s(p.get("id")),
                label: format!("{family}.{size}"),
                is_cpu: family == "cpu",
                family,
                size,
                cores: js_number(p.get("cpu_cores")),
                cards: num_or(p.get("gpu_count"), 0.0),
                vram: num_or(p.get("gpu_memory_gib"), 0.0),
                watts: js_number(p.get("active_watts")),
                idle_watts: js_number(p.get("idle_watts")),
                tput: js_number(p.get("throughput")),
                unit: s(p.get("work_unit")),
                boot_s: num_or(p.get("boot_seconds"), 120.0),
                zones: str_list(p.get("zones"))?.unwrap_or_default(),
            });
        }
        let mut workloads = Vec::new();
        for w in arr("workloads") {
            let residency = match w.get("residency") {
                None | Some(Value::Null) => "ANYWHERE".to_string(),
                v => s(v).to_uppercase(),
            };
            let id = s(w.get("id"));
            let release = parse_iso_ms(&s(w.get("release_at"))).ok_or(format!("{id}: bad release_at"))?;
            let deadline = parse_iso_ms(&s(w.get("deadline_at"))).ok_or(format!("{id}: bad deadline_at"))?;
            workloads.push(Workload {
                id,
                kind: s(w.get("kind")),
                unit: s(w.get("work_unit")),
                required: js_number(w.get("required_work")),
                release,
                deadline,
                residency,
                allowed: str_list(w.get("allowed_countries"))?,
                forbidden: str_list(w.get("forbidden_countries"))?.unwrap_or_default(),
                profile_ids: str_list(w.get("allowed_profile_ids"))?,
                families: str_list(w.get("allowed_families"))?,
                min_vram: num_or(w.get("minimum_gpu_memory_gib"), 0.0),
                max_workers: num_or(w.get("max_workers"), 1.0),
                sync: num_or(w.get("sync_overhead"), 0.0),
                input_s: num_or(w.get("input_seconds"), 0.0),
                output_s: num_or(w.get("output_seconds"), 0.0),
                checkpoint_s: num_or(w.get("checkpoint_seconds"), 0.0),
                restart_from_zero: truthy(w.get("restart_from_zero")),
            });
        }
        // frozen scoring rules: reference energies weight each job's points
        let rules: Option<Value> = rules.and_then(|r| serde_json::from_str::<Value>(r).ok()).and_then(|v| v.get("rules").cloned());
        let ref_i = num_or(rules.as_ref().and_then(|r| r.get("reference_gco2e_per_kwh")), 200.0);
        let ref_g = workloads
            .iter()
            .map(|w| ref_i * num_or(rules.as_ref().and_then(|r| r.get("reference_energy_kwh")).and_then(|e| e.get(&w.id)), 25.0))
            .collect();
        let mut cards = IndexMap::new();
        if let Some(Value::Object(q)) = c.get("gpu_family_quotas") {
            for (k, v) in q {
                cards.insert(k.clone(), js_number(Some(v)));
            }
        }
        let quota = Quota { vms: num_or(c.get("max_vms"), 20.0), cores: num_or(c.get("max_vcpus"), 320.0), cards };
        // scenario start = 00:00Z of the first release day (the run's initial virtual_time)
        let first = workloads.iter().map(|w| w.release).fold(f64::INFINITY, f64::min);
        let t0 = (first / 86_400_000.0).floor() * 86_400_000.0;
        let mut cat = Catalog {
            zones,
            profiles,
            workloads,
            ref_g,
            quota,
            t0,
            zone_ix: HashMap::new(),
            prof_ix: HashMap::new(),
            wl_ix: HashMap::new(),
        };
        cat.reindex();
        Ok(cat)
    }

    pub fn reindex(&mut self) {
        self.zone_ix = self.zones.iter().enumerate().map(|(i, z)| (z.slug.clone(), i)).collect();
        self.prof_ix = self.profiles.iter().enumerate().map(|(i, p)| (p.id.clone(), i)).collect();
        self.wl_ix = self.workloads.iter().enumerate().map(|(i, w)| (w.id.clone(), i)).collect();
    }

    pub fn zone(&self, slug: &str) -> Option<&Zone> {
        self.zone_ix.get(slug).map(|&i| &self.zones[i])
    }
    pub fn zone_index(&self, slug: &str) -> Option<usize> {
        self.zone_ix.get(slug).copied()
    }
    pub fn profile(&self, id: &str) -> Option<&Profile> {
        self.prof_ix.get(id).map(|&i| &self.profiles[i])
    }
    pub fn profile_index(&self, id: &str) -> Option<usize> {
        self.prof_ix.get(id).copied()
    }
    pub fn workload(&self, id: &str) -> Option<&Workload> {
        self.wl_ix.get(id).map(|&i| &self.workloads[i])
    }
    pub fn workload_index(&self, id: &str) -> Option<usize> {
        self.wl_ix.get(id).copied()
    }

    /// Electricity areas in order of first appearance among the zones (`new Set(zones.map(z => z.area))`).
    pub fn areas(&self) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for z in &self.zones {
            if !out.contains(&z.area) {
                out.push(z.area.clone());
            }
        }
        out
    }

    /// Remove a zone (discovery: not offered by this run).
    pub fn remove_zone(&mut self, slug: &str) {
        self.zones.retain(|z| z.slug != slug);
        self.reindex();
    }

    pub fn quota_cards(&self, fam: &str) -> Option<f64> {
        self.quota.cards.get(fam).copied()
    }
}

/// The frozen score (greenops-score-v2): points_i = 20000 * (R_i/R) / (1 + 0.75 c_i/R_i + 0.25 C/R),
/// plus 5000 if all delivered. `carbon` (grams) and `progress` (0..1) are aligned with `cat.workloads`.
pub fn score(cat: &Catalog, carbon: &[f64], progress: &[f64], all_delivered: bool) -> (f64, f64) {
    let r: f64 = cat.ref_g.iter().fold(0.0, |a, b| a + b);
    let c: f64 = carbon.iter().fold(0.0, |a, b| a + b);
    let mut base = 0.0;
    for (i, ri) in cat.ref_g.iter().enumerate() {
        let q = 1.0 / (1.0 + 0.75 * carbon[i] / ri + 0.25 * c / r);
        base += 20000.0 * (ri / r) * q * jmax(0.0, jmin(1.0, progress[i]));
    }
    (base, base + if all_delivered { 5000.0 } else { 0.0 })
}

/// Points gained per gram saved on each job at the given carbon state (own local term + shared term).
/// `carbon`: (workload index, grams) in insertion order; jobs not listed count 0 g. Returns per workload.
pub fn marginal_points(cat: &Catalog, carbon: &[(usize, f64)]) -> Vec<f64> {
    let r: f64 = cat.ref_g.iter().fold(0.0, |a, b| a + b);
    let c: f64 = carbon.iter().fold(0.0, |a, (_, g)| a + g);
    let mut by = vec![0.0; cat.workloads.len()];
    for &(i, g) in carbon {
        by[i] = g;
    }
    let q: Vec<f64> = cat.ref_g.iter().enumerate().map(|(i, ri)| 1.0 / (1.0 + 0.75 * by[i] / ri + 0.25 * c / r)).collect();
    let shared = cat.ref_g.iter().enumerate().fold(0.0, |a, (i, ri)| a + (ri / r) * jsmath::pow(q[i], 2.0));
    q.iter().map(|qi| (20000.0 / r) * (0.75 * jsmath::pow(*qi, 2.0) + 0.25 * shared)).collect()
}

/// Work units per hour of ONE VM. vcpu_hour throughput is per hour; tflop throughput is per second.
pub fn rate1(p: &Profile) -> f64 {
    if p.unit == "tflop" { p.tput * 3600.0 } else { p.tput }
}
/// Aggregate rate of k workers with the engine's sync model: k * r * (1 - sync)^(k-1).
pub fn rate_k(w: &Workload, p: &Profile, k: f64) -> f64 {
    k * rate1(p) * jsmath::pow(jmax(0.05, 1.0 - w.sync), k - 1.0)
}
pub fn setup_h(w: &Workload, p: &Profile) -> f64 {
    (p.boot_s + w.input_s) / 3600.0
}
pub fn output_h(w: &Workload) -> f64 {
    w.output_s / 3600.0
}

/// A legal (zone, profile, workers) placement (indices into the catalog) and its `rateK`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cand {
    pub zone: usize,
    pub prof: usize,
    pub k: f64,
    pub rate: f64,
}

/// Every legal (zone, profile, workers) placement for w, in catalog order.
pub fn candidates(cat: &Catalog, w: &Workload) -> Vec<Cand> {
    let mut out = Vec::new();
    for (zi, z) in cat.zones.iter().enumerate() {
        if !zone_legal(w, z) {
            continue;
        }
        for (pi, p) in cat.profiles.iter().enumerate() {
            if !p.offered_in(&z.slug) || !profile_legal(w, p) {
                continue;
            }
            let mut k = 1.0;
            while k <= jmax(1.0, w.max_workers) {
                out.push(Cand { zone: zi, prof: pi, k, rate: rate_k(w, p, k) });
                k += 1.0;
            }
        }
    }
    out
}

/// Quota usage: VMs, vCPUs and GPU cards per family.
#[derive(Clone, Debug, Default)]
pub struct Usage {
    pub vms: f64,
    pub cores: f64,
    pub cards: IndexMap<String, f64>,
}

impl Usage {
    pub fn card(&self, fam: &str) -> f64 {
        self.cards.get(fam).copied().unwrap_or(0.0)
    }
    pub fn add_card(&mut self, fam: &str, n: f64) {
        let e = self.cards.entry(fam.to_string()).or_insert(0.0);
        *e += n;
    }
}

pub fn fits_quota(cat: &Catalog, usage: &Usage, p: &Profile, k: f64) -> bool {
    if usage.vms + k > cat.quota.vms {
        return false;
    }
    if usage.cores + p.cores * k > cat.quota.cores {
        return false;
    }
    if !p.is_cpu && usage.card(&p.family) + p.cards * k > cat.quota_cards(&p.family).unwrap_or(0.0) {
        return false;
    }
    true
}

/// Mean of the n cheapest values (n clipped to [1, len]); None for an empty slice.
pub fn cheapest_mean(arr: &[f64], n: f64) -> Option<f64> {
    if arr.is_empty() {
        return None;
    }
    let mut s = arr.to_vec();
    sort_num(&mut s);
    let m = jmin(s.len() as f64, jmax(1.0, n.ceil()));
    let mut sum = 0.0;
    let mut i = 0usize;
    while (i as f64) < m {
        sum += s[i];
        i += 1;
    }
    Some(sum / m)
}

/// `Math.max(a, b)`: NaN wins, +0 beats -0.
#[inline]
pub fn jmax(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else if b > a || (a == 0.0 && a.is_sign_negative()) {
        b
    } else {
        a
    }
}

/// `Math.min(a, b)`: NaN wins, -0 beats +0.
#[inline]
pub fn jmin(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else if b < a || (a == 0.0 && b.is_sign_negative()) {
        b
    } else {
        a
    }
}

/// `arr.sort((a, b) => a - b)` for finite values.
pub fn sort_num(v: &mut [f64]) {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
}
