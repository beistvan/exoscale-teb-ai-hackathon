//! Port of `scripts/greenops/policy.mjs` `decide()` with its DEFAULTS (pauseMode "gate2",
//! strictPauses, pointsAware, reserveSingle, the low-lag overrides). The experimental switches
//! (nowcastLead0, marginFracGpu, prestageNoDefer, prestageExtraH, windowDist, forceProfile, preempt,
//! dynamicBar, hourlyGate, ...) are not ported; their default values are folded in.
//!
//! Every expression keeps the JS operand order: the controller must make the same decisions as the
//! JS one, and floating-point sums and products are not associative.
//!
//! 1. WHERE: each job goes to the legal (zone, profile, workers) with the lowest expected carbon:
//!    energy x datacenter PUE x the mean of the cheapest forecast hours it will need.
//! 2. WHEN: a job runs only in the cheapest hours of the published 24h forecast and pauses (stop =
//!    0 W, keeps progress) in the dirtier ones. Starts are timed the same way.
//! 3. SAFETY: stopped VMs still hold quota, so every pause / delayed start is checked by fast-
//!    forwarding the whole remaining schedule; a pause is kept only if every job still finishes
//!    before its deadline minus a margin.

use std::sync::Arc;

use crate::model::{Cand, Catalog, FxMap, H, Usage, candidates, fits_quota, jmax, jmin, marginal_points, output_h, rate_k, setup_h};
use crate::tweaks::Tweaks;

/// Policy options after the controller's per-step overrides (marginMinH, latH) and the low-lag
/// overrides. Field names follow DEFAULTS in policy.mjs.
#[derive(Clone, Debug)]
pub struct Opts {
    pub margin_min_h: f64,
    pub margin_min_h_gpu: Option<f64>,
    pub margin_frac: f64,
    pub margin_cpu_only: bool,
    pub fit_tol: f64,
    pub max_duty: f64,
    pub pause_quantum_h: f64,
    pub lat_h: f64,
    pub cpu_window_h: f64,
    pub buffer_lat_x: f64,
    pub min_value_per_core: f64,
    pub noise_band: f64,
    pub prestage: bool,
    pub reserve_single: bool,
    pub duty_w: f64,
    pub gpu_duty_w: f64,
    pub gpu_duty_max_lat_h: f64,
    pub gpu_tight_w: f64,
    pub gpu_tight_at: f64,
    pub scarcity_w: f64,
    pub card_w: f64,
    pub sticky_tol: f64,
    pub cpu_pause_max_lat_h: f64,
    pub points_aware: bool,
    pub pressure_value_per_core: f64,
    pub queue_cushion_h: f64,
    pub replace_foreign: bool,
    pub replace_min_rel: f64,
    pub replace_min_g: f64,
    /// GPU jobs' runtime-proportional margin (None: margin_frac)
    pub margin_frac_gpu: Option<f64>,
    /// with prestage: a staged job releasing within the action lead is gated on its release hour
    pub staged_gate: bool,
    /// sim hours a stopped job must keep before its deadline (set by the controller each step)
    pub stall_h: f64,
    /// <1: a fresh job with slack > picky_min_slack_h starts only in this fraction of its gate's clean hours
    pub picky_frac: f64,
    pub picky_min_slack_h: f64,
    pub picky_gpu_only: bool,
    /// plan with at least this fraction of the catalog speed (0: trust the learned speed fully)
    pub rate_floor: f64,
}

impl Opts {
    /// DEFAULTS + the controller's `{ marginMinH, latH }`, then the `lowLat` overrides at or below
    /// `lowLatH` (0.15 sim hours): `cpuWindowH: 1e9, pressureValuePerCore: 0.08, marginCutH: 3,
    /// prestage: true`, and the deadline-margin cut for CPU jobs (GPU jobs keep the full margin).
    pub fn resolve(margin_min_h: f64, lat_h: f64) -> Opts {
        Opts::resolve_with(margin_min_h, lat_h, &Tweaks::default())
    }

    /// `resolve` with named overrides applied (experiments; no overrides = the JS defaults).
    pub fn resolve_with(margin_min_h: f64, lat_h: f64, tw: &Tweaks) -> Opts {
        let mut o = Opts {
            margin_min_h,
            margin_min_h_gpu: None,
            margin_frac: 0.12,
            margin_cpu_only: true,
            fit_tol: 0.08,
            max_duty: 0.92,
            pause_quantum_h: 1.0,
            lat_h,
            cpu_window_h: 72.0,
            buffer_lat_x: 2.0,
            min_value_per_core: 0.0,
            noise_band: 0.05,
            prestage: false,
            reserve_single: true,
            duty_w: 0.0,
            gpu_duty_w: 0.0,
            gpu_duty_max_lat_h: 0.5,
            gpu_tight_w: 0.0,
            gpu_tight_at: 0.6,
            scarcity_w: 0.25,
            card_w: 1.0,
            sticky_tol: 0.15,
            cpu_pause_max_lat_h: 1.5,
            points_aware: true,
            pressure_value_per_core: 0.15,
            queue_cushion_h: 4.0,
            replace_foreign: true,
            replace_min_rel: 0.15,
            replace_min_g: 100.0,
            margin_frac_gpu: None,
            staged_gate: true,
            stall_h: 0.0,
            picky_frac: 1.0,
            picky_min_slack_h: 24.0,
            picky_gpu_only: true,
            rate_floor: 0.0,
        };
        if !tw.is_empty() {
            let b = |v: f64| v != 0.0;
            for (k, v) in &tw.kv {
                let v = *v;
                match k.as_str() {
                    "margin_frac" => o.margin_frac = v,
                    "margin_frac_gpu" => o.margin_frac_gpu = Some(v),
                    "margin_cpu_only" => o.margin_cpu_only = b(v),
                    "fit_tol" => o.fit_tol = v,
                    "max_duty" => o.max_duty = v,
                    "pause_quantum_h" => o.pause_quantum_h = v,
                    "cpu_window_h" => o.cpu_window_h = v,
                    "buffer_lat_x" => o.buffer_lat_x = v,
                    "min_value_per_core" => o.min_value_per_core = v,
                    "noise_band" => o.noise_band = v,
                    "prestage" => o.prestage = b(v),
                    "reserve_single" => o.reserve_single = b(v),
                    "duty_w" => o.duty_w = v,
                    "gpu_duty_w" => o.gpu_duty_w = v,
                    "gpu_duty_max_lat_h" => o.gpu_duty_max_lat_h = v,
                    "gpu_tight_w" => o.gpu_tight_w = v,
                    "gpu_tight_at" => o.gpu_tight_at = v,
                    "scarcity_w" => o.scarcity_w = v,
                    "card_w" => o.card_w = v,
                    "sticky_tol" => o.sticky_tol = v,
                    "cpu_pause_max_lat_h" => o.cpu_pause_max_lat_h = v,
                    "points_aware" => o.points_aware = b(v),
                    "pressure_value_per_core" => o.pressure_value_per_core = v,
                    "queue_cushion_h" => o.queue_cushion_h = v,
                    "replace_foreign" => o.replace_foreign = b(v),
                    "replace_min_rel" => o.replace_min_rel = v,
                    "replace_min_g" => o.replace_min_g = v,
                    "staged_gate" => o.staged_gate = b(v),
                    "picky_frac" => o.picky_frac = v,
                    "picky_min_slack_h" => o.picky_min_slack_h = v,
                    "picky_gpu_only" => o.picky_gpu_only = b(v),
                    "rate_floor" => o.rate_floor = v,
                    _ => {}
                }
            }
        }
        let low_lat_h = tw.get("low_lat_h").unwrap_or(0.15);
        let margin_cut_h = tw.get("low.margin_cut_h").unwrap_or(3.0);
        let low_lat_margin_min_h = tw.get("low.margin_min_h").unwrap_or(1.0);
        if lat_h <= low_lat_h {
            o.cpu_window_h = tw.get("low.cpu_window_h").unwrap_or(1e9);
            o.pressure_value_per_core = tw.get("low.pressure_value_per_core").unwrap_or(0.08);
            o.prestage = tw.get("low.prestage").map(|v| v != 0.0).unwrap_or(true);
            if margin_cut_h > 0.0 {
                o.margin_min_h_gpu = Some(margin_min_h);
                o.margin_min_h = jmax(low_lat_margin_min_h, margin_min_h - margin_cut_h);
            }
        }
        o
    }
}

fn margin_h(o: &Opts, need_h: f64, gpu: bool) -> f64 {
    let base = match o.margin_min_h_gpu {
        Some(g) if gpu && o.margin_cpu_only => g,
        _ => o.margin_min_h,
    };
    let frac = match o.margin_frac_gpu {
        Some(f) if gpu => f,
        _ => o.margin_frac,
    };
    jmax(base, frac * need_h)
}

/// One VM as the policy sees it (status assignment, or a receipt row not listed yet).
#[derive(Clone, Debug)]
pub struct VmView {
    pub id: String,
    pub zone: Option<String>,
    pub prof: Option<String>,
    pub state: String,
    pub adopted: bool,
}

#[derive(Clone, Debug)]
pub struct JobView {
    /// workload index in the catalog
    pub w: usize,
    pub done: f64,
    pub delivered: bool,
    pub vms: Vec<VmView>,
    pub run_h: f64,
    pub deployed_h: Option<f64>,
    pub obs_rate: f64,
    pub state: String,
}

#[derive(Clone, Debug, Default)]
pub struct View {
    /// sim hours since T0 at which the actions will land
    pub t: f64,
    pub state: String,
    pub usage: Usage,
    pub jobs: Vec<JobView>,
    /// engine-vs-catalog speed ratio per work unit (insertion order kept)
    pub calib: Vec<(String, f64)>,
    /// corrected forecast per electricity area (index = position in `Catalog::areas()`)
    pub fc: Vec<Option<Arc<Vec<f64>>>>,
    /// version of each area's forecast (same version = same values; lets the policy reuse its windows)
    pub fc_ver: Vec<u64>,
    /// placement forecast per area: the mean of the newest vintages (`view.fcPlace`); None = use `fc`
    pub fc_place: Option<Vec<Option<Arc<Vec<f64>>>>>,
    pub fc_place_ver: Vec<u64>,
}

impl View {
    fn calib_for(&self, unit: &str) -> f64 {
        self.calib.iter().find(|(u, _)| u == unit).map(|(_, v)| *v).unwrap_or(1.0)
    }
    /// `calOf`: the learned engine speed, never below `rate_floor` x the catalog
    fn cal_of(&self, unit: &str, o: &Opts) -> f64 {
        jmax(o.rate_floor, self.calib_for(unit))
    }
}

/// The policy's sticky reservation for a waiting job (`view.memo` in JS).
#[derive(Clone, Debug, PartialEq)]
pub struct Memo {
    pub zone: String,
    pub prof: String,
    pub k: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ActKind {
    Create { zone: String, prof: String, k: f64 },
    Start,
    Stop,
    Delete,
}

#[derive(Clone, Debug)]
pub struct Action {
    pub kind: ActKind,
    pub wl: String,
    /// the VM (start / stop / delete)
    pub vm: Option<VmView>,
    pub why: String,
}

impl Action {
    pub fn verb(&self) -> &'static str {
        match self.kind {
            ActKind::Create { .. } => "create",
            ActKind::Start => "start",
            ActKind::Stop => "stop",
            ActKind::Delete => "delete",
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct Placement {
    zone: usize,
    prof: usize,
    k: f64,
    need_h: f64,
    hard_h: f64,
    slack_h: f64,
    exp_i: f64,
    grams: f64,
    rank: Option<f64>,
    forced: bool,
    doomed: bool,
}

impl Placement {
    fn key(&self) -> f64 {
        self.rank.unwrap_or(self.grams)
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct Fp {
    vms: f64,
    cores: f64,
    /// GPU family index into the quota's card families (None: CPU / unknown)
    fam: Option<usize>,
    cards: f64,
}

#[derive(Clone, Debug)]
struct Item {
    /// workload index
    wi: usize,
    fp: Fp,
    need_h: f64,
    due: f64,
    deployed: bool,
    start_at: f64,
    avail: f64,
}

struct FfResult {
    worst: f64,
    start: Vec<Option<f64>>,
    finish: Vec<Option<f64>>,
}

impl FfResult {
    fn late(&self, i: usize, items: &[Item]) -> f64 {
        self.finish[i].unwrap_or(f64::INFINITY) - items[i].due
    }
    fn starts_now(&self, i: usize, t_h: f64) -> bool {
        self.start[i].unwrap_or(f64::INFINITY) <= t_h + 1e-6
    }
}

struct Deployed {
    job: usize,
    item: usize,
    pausable: bool,
    gate_run: bool,
    value: f64,
    est_g: f64,
    why: String,
}

struct Fresh {
    job: usize,
    item: usize,
    pick: Option<Placement>,
    use_: Placement,
    gate_now: bool,
    value: f64,
    list: Vec<Placement>,
}

/// One area's corrected forecast with every prefix fc[..W] pre-sorted (and its running sums in
/// ascending order), so `cheapestMean` and the gate's thresholds don't re-sort per candidate. The
/// sums are accumulated in exactly the order the JS loops use.
#[derive(Default)]
pub struct Win {
    fc: Vec<f64>,
    sorted: Vec<Vec<f64>>,
    sums: Vec<Vec<f64>>,
}

impl Win {
    pub fn new(fc: &[f64]) -> Win {
        let mut sorted = vec![Vec::new()];
        let mut sums = vec![vec![0.0]];
        let mut cur: Vec<f64> = Vec::with_capacity(fc.len());
        for &v in fc {
            let pos = cur.partition_point(|x| *x <= v);
            cur.insert(pos, v);
            let mut ps = Vec::with_capacity(cur.len() + 1);
            let mut acc = 0.0;
            ps.push(acc);
            for x in &cur {
                acc += x;
                ps.push(acc);
            }
            sorted.push(cur.clone());
            sums.push(ps);
        }
        Win { fc: fc.to_vec(), sorted, sums }
    }
    fn len(&self) -> usize {
        self.fc.len()
    }
    fn is_empty(&self) -> bool {
        self.fc.is_empty()
    }
    /// `cheapestMean(fc.slice(0, w), n)` (w >= 1)
    fn cheapest_mean(&self, w: usize, n: f64) -> f64 {
        let m = jmin(w as f64, jmax(1.0, n.ceil()));
        if m.is_nan() {
            return 0.0 / m;
        }
        self.sums[w][m as usize] / m
    }
    /// `fc.slice(0, W).sort((a, b) => a - b)[n - 1]`
    fn nth(&self, w: usize, n: f64) -> Option<f64> {
        if !(n >= 1.0) || n > w as f64 {
            return None;
        }
        Some(self.sorted[w][n as usize - 1])
    }
    /// `withinNoise()`'s window: W hours, run in the n cheapest.
    fn window(&self, need_h: f64, avail_h: f64) -> (usize, f64) {
        let w = jmax(1.0, jmin(self.len() as f64, avail_h.floor()));
        let n = jmin(w, ((w * need_h) / avail_h + 1e-9).ceil());
        (if w.is_nan() { 0 } else { w as usize }, n)
    }
    /// `gate()` / `hourSaving()`'s window: as above, at least 1 hour, and only the cheapest `frac` of
    /// them (`pickyFrac`; 1 = all).
    fn window_frac(&self, need_h: f64, avail_h: f64, frac: f64) -> (usize, f64) {
        let w = jmax(1.0, jmin(self.len() as f64, avail_h.floor()));
        let n = jmin(w, jmax(1.0, ((frac * w * need_h) / avail_h + 1e-9).ceil()));
        (if w.is_nan() { 0 } else { w as usize }, n)
    }
}

/// Proportional rule: within the visible window, run in the cheapest ceil(W*need/avail) hours
/// (frac < 1: only the cheapest frac of those — a pickier start).
fn gate(fc: &Win, need_h: f64, avail_h: f64, frac: f64) -> bool {
    if need_h <= 0.0 {
        return true;
    }
    if fc.is_empty() || need_h >= avail_h - 0.25 {
        return true;
    }
    let (w, n) = fc.window_frac(need_h, avail_h, frac);
    match fc.nth(w, n) {
        Some(thr) => fc.fc[0] <= thr + 1e-9,
        None => false, // JS: fc[0] <= undefined + 1e-9 is false
    }
}

/// True when waiting would save less than `band` (relative) — i.e. within forecast noise.
fn within_noise(fc: &Win, need_h: f64, avail_h: f64, band: f64) -> bool {
    if !(band > 0.0) || fc.is_empty() || need_h >= avail_h - 0.25 {
        return false;
    }
    let (w, n) = fc.window(need_h, avail_h);
    match fc.nth(w, n) {
        Some(thr) => fc.fc[0] - thr < band * jmax(1.0, thr),
        None => false,
    }
}

/// gCO2e/kWh saved by moving the current hour of work to the hour the gate would use instead.
fn hour_saving(fc: &Win, need_h: f64, avail_h: f64, frac: f64) -> f64 {
    if fc.is_empty() || need_h >= avail_h - 0.25 {
        return 0.0;
    }
    let (w, n) = fc.window_frac(need_h, avail_h, frac);
    match fc.nth(w, n) {
        Some(thr) => jmax(0.0, fc.fc[0] - thr),
        None => f64::NAN,
    }
}

/// Decision engine. Holds per-catalog caches (legal candidates per workload) and scratch buffers.
pub struct Policy {
    cands: Vec<Vec<Cand>>,
    /// zone index -> area index
    zone_area: Vec<usize>,
    /// profile index -> quota card-family index (GPU profiles)
    prof_fam: Vec<Option<usize>>,
    ff_vms: Vec<f64>,
    ff_cores: Vec<f64>,
    ff_cards: Vec<Vec<f64>>,
    /// sorted forecast windows by area index, with the forecast version they were built from
    wins: Vec<Win>,
    win_ver: Vec<u64>,
    /// the same for the placement forecast (`fcPlace`), when the view has one
    place_wins: Vec<Win>,
    place_ver: Vec<u64>,
    use_place: bool,
    empty: Win,
    /// experiment overrides (empty: the JS defaults)
    pub tweaks: Tweaks,
}

impl Policy {
    pub fn new(cat: &Catalog) -> Policy {
        let areas = cat.areas();
        Policy {
            cands: cat.workloads.iter().map(|w| candidates(cat, w)).collect(),
            zone_area: cat.zones.iter().map(|z| areas.iter().position(|a| *a == z.area).unwrap()).collect(),
            prof_fam: cat.profiles.iter().map(|p| if p.is_cpu { None } else { cat.quota.cards.get_index_of(&p.family) }).collect(),
            ff_vms: Vec::new(),
            ff_cores: Vec::new(),
            ff_cards: vec![Vec::new(); cat.quota.cards.len()],
            wins: Vec::new(),
            win_ver: Vec::new(),
            place_wins: Vec::new(),
            place_ver: Vec::new(),
            use_place: false,
            empty: Win::new(&[]),
            tweaks: Tweaks::default(),
        }
    }

    /// The corrected forecast window for a zone's area (empty when the area has no forecast).
    fn win(&self, zone: usize) -> &Win {
        self.wins.get(self.zone_area[zone]).unwrap_or(&self.empty)
    }

    /// The placement forecast window (`view.fcPlace ?? view.fc`).
    fn place_win(&self, zone: usize) -> &Win {
        if self.use_place { self.place_wins.get(self.zone_area[zone]).unwrap_or(&self.empty) } else { self.win(zone) }
    }

    fn footprint(&self, cat: &Catalog, prof: usize, k: f64) -> Fp {
        let p = &cat.profiles[prof];
        Fp {
            vms: k,
            cores: p.cores * k,
            fam: if p.is_cpu { None } else { self.prof_fam[prof] },
            cards: if p.is_cpu { 0.0 } else { p.cards * k },
        }
    }

    /// Expected carbon (g) of a fresh placement started at t_h, plus its timing numbers.
    #[allow(clippy::too_many_arguments)]
    fn score_placement(
        &self,
        cat: &Catalog,
        wi: usize,
        c: Cand,
        rem: f64,
        t_h: f64,
        o: &Opts,
        max_duty: f64,
        calib: f64,
    ) -> Option<Placement> {
        let w = &cat.workloads[wi];
        let p = &cat.profiles[c.prof];
        let rate = c.rate * calib;
        let need_h = setup_h(w, p) + rem / rate + output_h(w);
        let deadline_h = (w.deadline - cat.t0) / H;
        let hard_h = deadline_h - t_h - margin_h(o, need_h, !p.is_cpu);
        if !(hard_h > 0.0) || need_h > hard_h * max_duty {
            return None;
        }
        let avail_h = if p.is_cpu { jmax(need_h / max_duty, jmin(hard_h, o.cpu_window_h)) } else { hard_h };
        let fc = self.place_win(c.zone);
        if fc.is_empty() {
            return None;
        }
        let ww = jmax(1.0, jmin(fc.len() as f64, avail_h.floor()));
        let exp_i = fc.cheapest_mean(ww as usize, (ww * need_h) / avail_h);
        let kwh = (c.k * p.watts * need_h) / 1000.0;
        let z = &cat.zones[c.zone];
        Some(Placement {
            zone: c.zone,
            prof: c.prof,
            k: c.k,
            need_h,
            hard_h,
            slack_h: hard_h - need_h,
            exp_i,
            grams: kwh * z.pue * exp_i,
            rank: None,
            forced: false,
            doomed: false,
        })
    }

    /// All legal placements for a job not yet deployed, best (lowest expected grams) first. If none
    /// clears its margin, deadline-feasible ones by carbon, then the fastest — it still has to go.
    fn placements(&self, cat: &Catalog, view: &View, o: &Opts, memo: &FxMap<String, Memo>, j: &JobView, t_plan: f64) -> Vec<Placement> {
        let w = &cat.workloads[j.w];
        let rem = jmax(0.0, w.required - j.done);
        let cal = view.cal_of(&w.unit, o);
        let mut scored: Vec<Placement> =
            self.cands[j.w].iter().filter_map(|&c| self.score_placement(cat, j.w, c, rem, t_plan, o, o.max_duty, cal)).collect();
        // rank = estimated grams x a quota-scarcity factor (scarcityMode "cores": span 1)
        for c in scored.iter_mut() {
            let p = &cat.profiles[c.prof];
            let span = 1.0;
            let card_share =
                if !p.is_cpu { o.card_w * (p.cards * c.k) / jmax(1.0, cat.quota_cards(&p.family).unwrap_or(1.0)) } else { 0.0 };
            let duty = if p.is_cpu {
                o.duty_w
            } else if o.lat_h <= o.gpu_duty_max_lat_h {
                o.gpu_duty_w
            } else {
                0.0
            };
            let tight = if p.is_cpu { 0.0 } else { o.gpu_tight_w };
            c.rank = Some(
                c.grams
                    * (1.0 + o.scarcity_w * span * ((p.cores * c.k) / cat.quota.cores + card_share))
                    * (1.0 + duty * jmin(1.0, c.need_h / jmax(1e-6, c.hard_h)))
                    * (1.0 + tight * jmax(0.0, jmin(1.0, c.need_h / jmax(1e-6, c.hard_h)) - o.gpu_tight_at)),
            );
        }
        scored.sort_by(|a, b| {
            let d = a.key() - b.key();
            if d != 0.0 && !d.is_nan() {
                return d.partial_cmp(&0.0).unwrap();
            }
            let ca = cat.profiles[a.prof].cores * a.k;
            let cb = cat.profiles[b.prof].cores * b.k;
            (ca - cb).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        // sticky: a job already holding a reservation keeps that placement unless another is clearly better
        if let Some(m) = memo.get(&w.id) {
            if let Some(i) = scored.iter().position(|c| cat.zones[c.zone].slug == m.zone && cat.profiles[c.prof].id == m.prof && c.k == m.k)
            {
                if i > 0 && scored[i].key() <= scored[0].key() * (1.0 + o.sticky_tol) {
                    let c = scored.remove(i);
                    scored.insert(0, c);
                }
            }
        }
        if !scored.is_empty() {
            return scored;
        }
        let deadline_h = (w.deadline - cat.t0) / H;
        let all: Vec<Placement> = self.cands[j.w]
            .iter()
            .map(|&c| {
                let p = &cat.profiles[c.prof];
                let z = &cat.zones[c.zone];
                let need_h = setup_h(w, p) + rem / (c.rate * cal) + output_h(w);
                let fc = self.place_win(c.zone);
                let mean = if fc.is_empty() { 1e3 } else { fc.cheapest_mean(fc.len(), 24.0) };
                let grams = (c.k * p.watts * need_h * z.pue * mean) / 1000.0;
                Placement {
                    zone: c.zone,
                    prof: c.prof,
                    k: c.k,
                    need_h,
                    hard_h: deadline_h - t_plan,
                    slack_h: deadline_h - t_plan - need_h,
                    exp_i: 0.0,
                    grams,
                    rank: None,
                    forced: true,
                    doomed: false,
                }
            })
            .collect();
        // deadline-feasible ones first (by carbon); "doomed" ones (can't finish in time) only by speed
        let min_slack = 1.0 + 2.0 * o.lat_h;
        let mut ok: Vec<Placement> = all.iter().filter(|c| c.slack_h > min_slack).copied().collect();
        ok.sort_by(|a, b| a.grams.partial_cmp(&b.grams).unwrap_or(std::cmp::Ordering::Equal));
        let mut fast: Vec<Placement> = all
            .iter()
            .filter(|c| !(c.slack_h > min_slack))
            .copied()
            .map(|mut c| {
                c.doomed = true;
                c
            })
            .collect();
        fast.sort_by(|a, b| a.need_h.partial_cmp(&b.need_h).unwrap_or(std::cmp::Ordering::Equal));
        ok.extend(fast);
        ok
    }

    /// Fast-forward the remaining schedule with reservations (conservative backfilling).
    /// Deployed items hold their quota from now until they finish (paused ones too — stopped VMs keep
    /// quota). Waiting items, in deadline order, each reserve the earliest window of length needH at
    /// or after `avail` where quota is free for the whole window.
    fn fast_forward(&mut self, cat: &Catalog, t0: f64, base: &Usage, items: &[Item]) -> FfResult {
        const DT: f64 = 0.5;
        let n = jmax(16.0, ((300.0 - t0) / DT).ceil() + 2.0) as usize;
        self.ff_vms.clear();
        self.ff_vms.resize(n, 0.0);
        self.ff_cores.clear();
        self.ff_cores.resize(n, 0.0);
        for c in self.ff_cards.iter_mut() {
            c.clear();
            c.resize(n, 0.0);
        }
        let cap_c = cat.quota.cores;
        let cap_v = cat.quota.vms;
        let caps: Vec<f64> = cat.quota.cards.values().copied().collect();
        let clamp = |x: f64| -> usize {
            if x.is_nan() || x <= 0.0 {
                0
            } else if x >= n as f64 {
                n
            } else {
                x as usize
            }
        };
        fn hold(vms: &mut [f64], cores: &mut [f64], cards: &mut [Vec<f64>], fp: &Fp, s0: usize, s1: usize) {
            for i in s0..s1.max(s0) {
                vms[i] += fp.vms;
                cores[i] += fp.cores;
                if fp.cards != 0.0 {
                    if let Some(f) = fp.fam {
                        cards[f][i] += fp.cards;
                    }
                }
            }
        }
        // delivered-but-not-yet-deleted / unknown VMs: assume they're gone in ~2h
        let two = clamp((2.0 / DT).ceil());
        hold(
            &mut self.ff_vms,
            &mut self.ff_cores,
            &mut self.ff_cards,
            &Fp { vms: base.vms, cores: base.cores, fam: None, cards: 0.0 },
            0,
            two,
        );
        for (fam, c) in base.cards.iter() {
            if *c > 0.0 {
                if let Some(fi) = cat.quota.cards.get_index_of(fam) {
                    hold(
                        &mut self.ff_vms,
                        &mut self.ff_cores,
                        &mut self.ff_cards,
                        &Fp { vms: 0.0, cores: 0.0, fam: Some(fi), cards: *c },
                        0,
                        two,
                    );
                }
            }
        }
        let mut start = vec![None; items.len()];
        let mut finish = vec![None; items.len()];
        for (i, it) in items.iter().enumerate() {
            if it.deployed {
                let end = it.start_at + it.need_h;
                hold(&mut self.ff_vms, &mut self.ff_cores, &mut self.ff_cards, &it.fp, 0, clamp(((end - t0) / DT).ceil()));
                start[i] = Some(it.start_at);
                finish[i] = Some(end);
            }
        }
        let mut waiting: Vec<usize> = (0..items.len()).filter(|&i| !items[i].deployed).collect();
        waiting.sort_by(|&a, &b| {
            let d = items[a].due - items[b].due;
            if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { std::cmp::Ordering::Equal }
        });
        for wi in waiting {
            let it = &items[wi];
            let d = jmax(1.0, (it.need_h / DT).ceil());
            let mut s = jmax(0.0, ((it.avail - t0) / DT - 1e-9).ceil());
            let cap_f = if it.fp.cards != 0.0 { it.fp.fam.map(|f| caps[f]).unwrap_or(0.0) } else { 0.0 };
            for _guard in 0..n {
                // violation(fp, s, d): first blocked slot, -2 past the horizon, -1 free
                let mut v: f64 = -1.0;
                let mut i = s;
                while i < s + d {
                    if i >= n as f64 {
                        v = -2.0;
                        break;
                    }
                    let ix = i as usize;
                    if self.ff_vms[ix] + it.fp.vms > cap_v
                        || self.ff_cores[ix] + it.fp.cores > cap_c
                        || (it.fp.cards != 0.0 && it.fp.fam.map(|f| self.ff_cards[f][ix]).unwrap_or(0.0) + it.fp.cards > cap_f)
                    {
                        v = i;
                        break;
                    }
                    i += 1.0;
                }
                if v == -1.0 {
                    let (s0, s1) = (clamp(s), clamp(s + d));
                    let fp = it.fp;
                    hold(&mut self.ff_vms, &mut self.ff_cores, &mut self.ff_cards, &fp, s0, s1);
                    start[wi] = Some(t0 + s * DT);
                    finish[wi] = Some(t0 + (s + d) * DT);
                    break;
                }
                if v == -2.0 {
                    break; // doesn't fit before the end of the run
                }
                s = v + 1.0;
            }
        }
        let mut worst = f64::NEG_INFINITY;
        for (i, it) in items.iter().enumerate() {
            let late = finish[i].unwrap_or(f64::INFINITY) - it.due;
            if late > worst {
                worst = late;
            }
        }
        FfResult { worst, start, finish }
    }

    /// One decision. `margin_min_h` and `lat_h` are the controller's per-step overrides.
    /// Returns actions in the JS order (deletes, staged stops, pauses/resumes, creates, clock start).
    pub fn decide(
        &mut self,
        cat: &Catalog,
        view: &View,
        memo: &mut FxMap<String, Memo>,
        margin_min_h: f64,
        lat_h: f64,
        stall_h: f64,
    ) -> Vec<Action> {
        let mut o = Opts::resolve_with(margin_min_h, lat_h, &self.tweaks);
        o.stall_h = stall_h;
        if self.wins.len() != view.fc.len() {
            self.wins = view.fc.iter().map(|_| Win::new(&[])).collect();
            self.win_ver = vec![u64::MAX; view.fc.len()];
        }
        for (i, f) in view.fc.iter().enumerate() {
            let ver = view.fc_ver.get(i).copied().unwrap_or(u64::MAX - 1);
            if self.win_ver[i] != ver || ver == 0 {
                self.wins[i] = Win::new(f.as_ref().map(|a| a.as_slice()).unwrap_or(&[]));
                self.win_ver[i] = ver;
            }
        }
        self.use_place = view.fc_place.is_some();
        if let Some(fp) = &view.fc_place {
            if self.place_wins.len() != fp.len() {
                self.place_wins = fp.iter().map(|_| Win::new(&[])).collect();
                self.place_ver = vec![u64::MAX; fp.len()];
            }
            for (i, f) in fp.iter().enumerate() {
                let ver = view.fc_place_ver.get(i).copied().unwrap_or(u64::MAX - 1);
                if self.place_ver[i] != ver || ver == 0 {
                    self.place_wins[i] = Win::new(f.as_ref().map(|a| a.as_slice()).unwrap_or(&[]));
                    self.place_ver[i] = ver;
                }
            }
        }
        let mut acts: Vec<Action> = Vec::new();
        let t_h = view.t;
        let rel_h = |j: &JobView| (cat.workloads[j.w].release - cat.t0) / H;
        let deadline_h = |j: &JobView| (cat.workloads[j.w].deadline - cat.t0) / H;
        let wid = |j: &JobView| cat.workloads[j.w].id.clone();
        let vm_act = |kind: ActKind, j: &JobView, vm: &VmView, why: String| Action {
            kind,
            wl: cat.workloads[j.w].id.clone(),
            vm: Some(vm.clone()),
            why,
        };

        for j in &view.jobs {
            if j.delivered {
                for vm in &j.vms {
                    acts.push(vm_act(ActKind::Delete, j, vm, "delivered".into()));
                }
            }
        }
        // past its deadline: work no longer counts but electricity does — free the VMs, stop planning it
        let missed = |j: &JobView| !j.delivered && (j.state.to_lowercase() == "deadline_missed" || t_h > deadline_h(j) + 0.25);
        for j in &view.jobs {
            if missed(j) {
                for vm in &j.vms {
                    acts.push(vm_act(ActKind::Delete, j, vm, "deadline passed".into()));
                }
            }
        }
        let open: Vec<usize> = (0..view.jobs.len()).filter(|&i| !view.jobs[i].delivered && !missed(&view.jobs[i])).collect();

        let cpu_pause = o.lat_h <= o.cpu_pause_max_lat_h;
        let mut items: Vec<Item> = Vec::new();
        let mut deployed: Vec<Deployed> = Vec::new();
        let mut fresh: Vec<Fresh> = Vec::new();
        let mut held_open = Usage::default();
        let add_held = |h: &mut Usage, f: &Fp| {
            h.vms += f.vms;
            h.cores += f.cores;
            if f.cards != 0.0 {
                if let Some(fi) = f.fam {
                    let fam = cat.quota.cards.get_index(fi).unwrap().0;
                    h.add_card(fam, f.cards);
                }
            }
        };

        for &ji in &open {
            let j = &view.jobs[ji];
            if j.vms.is_empty() {
                continue;
            }
            let w = &cat.workloads[j.w];
            let prof_i = j.vms[0].prof.as_deref().and_then(|p| cat.profile_index(p));
            let zone_i = j.vms[0].zone.as_deref().and_then(|z| cat.zone_index(z));
            let (Some(pi), Some(zi)) = (prof_i, zone_i) else {
                // a VM we can't identify yet: left running; assume it holds a titan-sized share until the deadline
                let n = j.vms.len() as f64;
                let f = Fp { vms: n, cores: 40.0 * n, fam: None, cards: 0.0 };
                add_held(&mut held_open, &f);
                items.push(Item {
                    wi: j.w,
                    fp: f,
                    need_h: jmax(0.5, deadline_h(j) - t_h),
                    due: deadline_h(j),
                    deployed: true,
                    start_at: t_h,
                    avail: 0.0,
                });
                continue;
            };
            let prof = &cat.profiles[pi];
            let zone = &cat.zones[zi];
            let k = j.vms.len() as f64;
            let rem = jmax(0.0, w.required - j.done);
            // A VM someone else left (e.g. the starter demo) on a clearly dirtier placement, before its
            // job has done any real work: replace it — nothing is lost.
            if o.replace_foreign && j.vms.iter().all(|v| v.adopted) && j.done <= 0.0 && t_h - rel_h(j) < 0.5 {
                let t_p = jmax(t_h, rel_h(j));
                let best = self.placements(cat, view, &o, memo, j, t_p).into_iter().next();
                let cur = self.score_placement(
                    cat,
                    j.w,
                    Cand { zone: zi, prof: pi, k, rate: rate_k(w, prof, k) },
                    rem,
                    t_p,
                    &o,
                    1.0,
                    view.cal_of(&w.unit, &o),
                );
                if let (Some(best), Some(cur)) = (best, cur) {
                    if !best.forced && best.grams < cur.grams * (1.0 - o.replace_min_rel) && cur.grams - best.grams > o.replace_min_g {
                        for vm in &j.vms {
                            let why = format!(
                                "replace foreign {}@{} (est {:.0}g) by {}@{} (est {:.0}g)",
                                prof.label, zone.slug, cur.grams, cat.profiles[best.prof].label, cat.zones[best.zone].slug, best.grams
                            );
                            acts.push(vm_act(ActKind::Delete, j, vm, why));
                        }
                        continue; // re-placed as a fresh job once the delete lands
                    }
                }
            }
            let model = rate_k(w, prof, k) * view.cal_of(&w.unit, &o);
            let rate = if j.obs_rate > 0.0 { jmin(jmax(j.obs_rate, rate_k(w, prof, k) * o.rate_floor), model * 1.05) } else { model };
            let wait = jmax(0.0, rel_h(j) - t_h);
            let setup_left = if j.done > 0.0 { 0.0 } else { jmax(0.0, setup_h(w, prof) - j.run_h) };
            let run_need = setup_left + rem / rate + output_h(w);
            let due = deadline_h(j) - margin_h(&o, run_need, !prof.is_cpu);
            let f = self.footprint(cat, pi, k);
            add_held(&mut held_open, &f);
            // staging may run before release (the engine allows it), so it overlaps the wait
            let need_h = (if o.prestage { jmax(wait, setup_left) - setup_left } else { wait }) + run_need;
            let item = Item { wi: j.w, fp: f, need_h, due, deployed: true, start_at: t_h, avail: 0.0 };
            // staged and still waiting for release: stop it (0 W, keeps the staged input) until release
            let all_rs = j.vms.iter().all(|v| v.state == "running" || v.state == "stopped");
            let staged_waiting = o.prestage && wait > o.lat_h + 0.15 && setup_left <= 0.0 && j.done <= 0.0 && all_rs;
            if staged_waiting {
                for vm in &j.vms {
                    if vm.state == "running" {
                        acts.push(vm_act(ActKind::Stop, j, vm, format!("staged, waiting {:.1}h for release", wait)));
                    }
                }
                items.push(item);
                continue;
            }
            // stagedGate: staged and releasing within the action lead — judge the release hour now instead of
            // starting unconditionally (a start just before a dirty release hour was then held running)
            let near_rel = o.staged_gate && o.prestage && wait > 0.0 && setup_left <= 0.0 && j.done <= 0.0;
            let pausable = (cpu_pause || !prof.is_cpu) && rem > 1e-6 && (wait <= 0.0 || near_rel) && all_rs;
            let fc_now = self.win(zi);
            let sliced;
            let fc: &Win = if near_rel && fc_now.len() > 1 {
                let from = jmin(fc_now.len() as f64 - 1.0, jmax(0.0, crate::jsmath::round(rel_h(j)) - t_h.floor())) as usize;
                sliced = Win::new(&fc_now.fc[from..]);
                &sliced
            } else {
                fc_now
            };
            let since_h = t_h - j.deployed_h.unwrap_or(t_h);
            let avail_h = (if prof.is_cpu { jmin(due - t_h, jmax(run_need, o.cpu_window_h - since_h)) } else { due - t_h })
                - (if near_rel { wait } else { 0.0 });
            let gate_run = !pausable || gate(fc, run_need, avail_h, 1.0) || within_noise(fc, run_need, avail_h, o.noise_band);
            let value =
                if pausable && !gate_run { ((prof.watts * k) / 1000.0) * zone.pue * hour_saving(fc, run_need, avail_h, 1.0) } else { 0.0 };
            let fc_mean = if !fc.is_empty() { fc.fc.iter().fold(0.0, |a, b| a + b) / fc.len() as f64 } else { 0.0 };
            let est_g =
                ((prof.watts * k) / 1000.0) * (setup_h(w, prof) + w.required / rate_k(w, prof, k) + output_h(w)) * zone.pue * fc_mean;
            let why = format!("need={:.1}h avail={:.1}h", run_need, due - t_h);
            items.push(item);
            deployed.push(Deployed { job: ji, item: items.len() - 1, pausable, gate_run, value, est_g, why });
        }
        let base = Usage {
            vms: jmax(0.0, view.usage.vms - held_open.vms),
            cores: jmax(0.0, view.usage.cores - held_open.cores),
            cards: cat.quota.cards.keys().map(|f| (f.clone(), jmax(0.0, view.usage.card(f) - held_open.card(f)))).collect(),
        };

        // While a multi-worker job waits, reserve its quota as ONE worker (its most efficient shape).
        let single = |list: &[Placement], best: Option<&Placement>| -> Option<Placement> {
            let b = best?;
            if !o.reserve_single || b.k <= 1.0 || b.forced {
                return Some(*b);
            }
            let mut ones: Vec<&Placement> = list.iter().filter(|c| c.k == 1.0 && !c.doomed && !c.forced).collect();
            ones.sort_by(|a, b| a.key().partial_cmp(&b.key()).unwrap_or(std::cmp::Ordering::Equal));
            Some(ones.first().map(|c| **c).unwrap_or(*b))
        };
        // Released jobs without VMs: admit now, first-fit in deadline order, each with its cleanest
        // placement that fits within fitTol.
        let mut free = Usage { vms: view.usage.vms, cores: view.usage.cores, cards: view.usage.cards.clone() };
        // jobs released by now — plus, with pre-staging, jobs releasing within their boot + input time
        let lead = |j: &JobView| if o.prestage { (120.0 + cat.workloads[j.w].input_s) / 3600.0 + o.lat_h + 0.1 + 0.0 } else { 0.0 };
        let released_or_soon = |j: &JobView| rel_h(j) <= t_h + lead(j) + 1e-9;
        let mut waiting_now: Vec<(usize, Vec<Placement>)> = open
            .iter()
            .filter(|&&ji| view.jobs[ji].vms.is_empty() && released_or_soon(&view.jobs[ji]))
            .map(|&ji| {
                let j = &view.jobs[ji];
                (ji, self.placements(cat, view, &o, memo, j, jmax(t_h, rel_h(j) - lead(j))))
            })
            .filter(|(_, l)| !l.is_empty())
            .collect();
        waiting_now.sort_by(|(ja, la), (jb, lb)| {
            let d = (la[0].hard_h - la[0].need_h) - (lb[0].hard_h - lb[0].need_h);
            if d != 0.0 && !d.is_nan() {
                return d.partial_cmp(&0.0).unwrap();
            }
            let e = deadline_h(&view.jobs[*ja]) - deadline_h(&view.jobs[*jb]);
            if e != 0.0 && !e.is_nan() { e.partial_cmp(&0.0).unwrap() } else { std::cmp::Ordering::Equal }
        });
        for (ji, list) in waiting_now {
            let j = &view.jobs[ji];
            let best = &list[0];
            // while any placement can still make the deadline, never settle for one that can't
            let any_ok = list.iter().any(|c| !c.doomed);
            let mut pick: Option<Placement> = None;
            for c in &list {
                if any_ok && c.doomed {
                    continue;
                }
                if !fits_quota(cat, &free, &cat.profiles[c.prof], c.k) {
                    continue;
                }
                if c.key() <= best.key() * (1.0 + o.fit_tol) || best.forced || c.forced {
                    pick = Some(*c);
                    break;
                }
            }
            let use_ = match &pick {
                Some(p) => *p,
                None => single(&list, Some(best)).unwrap(),
            };
            let f = self.footprint(cat, use_.prof, use_.k);
            let up = &cat.profiles[use_.prof];
            let due = deadline_h(j) - margin_h(&o, use_.need_h, !up.is_cpu);
            items.push(Item { wi: j.w, fp: f, need_h: use_.need_h, due, deployed: false, start_at: 0.0, avail: t_h });
            if pick.is_some() {
                free.vms += f.vms;
                free.cores += f.cores;
                if f.cards != 0.0 {
                    free.add_card(&up.family, f.cards);
                }
            }
            let fc = self.win(use_.zone);
            // pickyStart: a job with much more slack than its forecast can see starts (and commits its zone)
            // only in its very cleanest hours, so later forecasts can still move it
            let win = jmin(use_.hard_h, o.cpu_window_h);
            let fr = if o.picky_frac < 1.0
                && pick.is_some()
                && !use_.forced
                && (!o.picky_gpu_only || !up.is_cpu)
                && use_.hard_h - use_.need_h > o.picky_min_slack_h
            {
                o.picky_frac
            } else {
                1.0
            };
            let gate_now = use_.forced
                || pick.is_none()
                || (!cpu_pause && up.is_cpu)
                || gate(fc, use_.need_h, win, fr)
                || (fr == 1.0 && within_noise(fc, use_.need_h, win, o.noise_band));
            let value = if pick.is_some() && !gate_now {
                ((up.watts * use_.k) / 1000.0) * cat.zones[use_.zone].pue * hour_saving(fc, use_.need_h, win, fr)
            } else {
                0.0
            };
            if pick.is_none() {
                memo.insert(wid(j), Memo { zone: cat.zones[use_.zone].slug.clone(), prof: up.id.clone(), k: use_.k });
            } else {
                memo.remove(&wid(j));
            }
            fresh.push(Fresh { job: ji, item: items.len() - 1, pick, use_, gate_now, value, list });
        }
        // Future releases take part in the fast-forward with their best placement at release time.
        for &ji in &open {
            let j = &view.jobs[ji];
            if !j.vms.is_empty() || released_or_soon(j) {
                continue;
            }
            let list = self.placements(cat, view, &o, memo, j, rel_h(j));
            let Some(best) = single(&list, list.first()) else { continue };
            let gpu = !cat.profiles[best.prof].is_cpu;
            items.push(Item {
                wi: j.w,
                fp: self.footprint(cat, best.prof, best.k),
                need_h: best.need_h,
                due: deadline_h(j) - margin_h(&o, best.need_h, gpu),
                deployed: false,
                start_at: 0.0,
                avail: rel_h(j),
            });
        }

        // Waiting for a preferred placement is only OK if the projection says it's safe; otherwise
        // take the cleanest placement that fits right now.
        let buffer = o.buffer_lat_x * o.lat_h;
        let mut base_run = self.fast_forward(cat, t_h, &base, &items);
        let mut order: Vec<usize> = (0..fresh.len()).filter(|&i| fresh[i].pick.is_none()).collect();
        order.sort_by(|&a, &b| {
            let d = items[fresh[a].item].due - items[fresh[b].item].due;
            if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { std::cmp::Ordering::Equal }
        });
        for xi in order {
            let it_i = fresh[xi].item;
            let late = base_run.late(it_i, &items);
            if late <= -buffer {
                continue;
            }
            let any_ok = fresh[xi].list.iter().any(|c| !c.doomed);
            let Some(alt) =
                fresh[xi].list.iter().find(|c| !(any_ok && c.doomed) && fits_quota(cat, &free, &cat.profiles[c.prof], c.k)).copied()
            else {
                continue;
            };
            let saved = items[it_i].clone();
            let gpu = !cat.profiles[alt.prof].is_cpu;
            items[it_i].fp = self.footprint(cat, alt.prof, alt.k);
            items[it_i].need_h = alt.need_h;
            items[it_i].due = deadline_h(&view.jobs[fresh[xi].job]) - margin_h(&o, alt.need_h, gpu);
            let r = self.fast_forward(cat, t_h, &base, &items);
            let late_alt = r.late(it_i, &items);
            if late_alt < late - 0.25 {
                let f = items[it_i].fp;
                fresh[xi].pick = Some(alt);
                fresh[xi].use_ = alt;
                fresh[xi].gate_now = true;
                base_run = r;
                free.vms += f.vms;
                free.cores += f.cores;
                if f.cards != 0.0 {
                    free.add_card(&cat.profiles[alt.prof].family, f.cards);
                }
            } else {
                items[it_i] = saved;
            }
        }

        // gate2: pauses / delayed starts the clean-hour rule wants, ranked by POINTS saved per hour,
        // each checked by the projection.
        let q = o.pause_quantum_h + o.lat_h;
        let mut plan = base_run;
        let safe = plan.worst <= 0.0;
        let mut paused: Vec<usize> = Vec::new(); // item indices
        let mut deferred: Vec<usize> = Vec::new();
        let blocked = fresh.iter().any(|x| !plan.starts_now(x.item, t_h));
        // points per gram differ by job (score formula): a CPU job's gram is worth ~1.7x a big GPU job's
        let mut wt: Vec<f64> = vec![1.0; cat.workloads.len()];
        if o.points_aware {
            let mut est: Vec<(usize, f64)> = Vec::new();
            for d in &deployed {
                est.push((view.jobs[d.job].w, d.est_g));
            }
            for x in &fresh {
                est.push((view.jobs[x.job].w, x.use_.grams));
            }
            let m = marginal_points(cat, &est);
            let mean = m.iter().fold(0.0, |a, b| a + b) / jmax(1.0, m.len() as f64);
            wt = m.iter().map(|v| v / mean).collect();
        }
        let bar = |fp: &Fp| if blocked { o.pressure_value_per_core * fp.cores } else { o.min_value_per_core * fp.cores };
        struct CandP {
            pause: bool,
            item: usize,
            value: f64,
        }
        let mut cands: Vec<CandP> = Vec::new();
        for d in &deployed {
            let wv = d.value * wt[view.jobs[d.job].w];
            if d.pausable && !d.gate_run && d.value > 0.0 && wv >= bar(&items[d.item].fp) {
                cands.push(CandP { pause: true, item: d.item, value: wv });
            }
        }
        for x in &fresh {
            let wv = x.value * wt[view.jobs[x.job].w];
            if x.pick.is_some() && !x.gate_now && x.value > 0.0 && wv >= bar(&items[x.item].fp) {
                cands.push(CandP { pause: false, item: x.item, value: wv });
            }
        }
        cands.sort_by(|a, b| {
            let d = b.value - a.value;
            if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { std::cmp::Ordering::Equal }
        });
        {
            let base0: Vec<f64> = (0..items.len()).map(|i| plan.late(i, &items)).collect();
            // jobs still queued for quota pay for other jobs' pauses later: while anyone is queued, a
            // pause must leave every job a bigger cushion
            let cushion = if blocked { jmax(buffer, o.queue_cushion_h) } else { buffer };
            for c in &cands {
                let saved = items[c.item].clone();
                if c.pause {
                    items[c.item].start_at = t_h + q;
                } else {
                    items[c.item].avail = t_h + q;
                }
                let r = self.fast_forward(cat, t_h, &base, &items);
                let mut ok = r.late(c.item, &items) <= -buffer;
                // stall guard: a stopped (or not yet created) job must still finish stall_h before its real
                // deadline, so a start/create that the server holds that long still lands in time
                if ok
                    && o.stall_h > 0.0
                    && r.finish[c.item].unwrap_or(f64::INFINITY) > (cat.workloads[items[c.item].wi].deadline - cat.t0) / H - o.stall_h
                {
                    ok = false;
                }
                if ok {
                    for (i, b0) in base0.iter().enumerate() {
                        if r.late(i, &items) > jmax(*b0, -cushion) + 1e-6 {
                            ok = false;
                            break;
                        }
                    }
                }
                if ok {
                    if c.pause {
                        paused.push(c.item);
                    } else {
                        deferred.push(c.item);
                    }
                    plan = r;
                } else {
                    items[c.item] = saved;
                }
            }
        }

        for d in &deployed {
            let j = &view.jobs[d.job];
            let stop = paused.contains(&d.item);
            for vm in &j.vms {
                if vm.state == "running" && stop {
                    acts.push(vm_act(ActKind::Stop, j, vm, format!("{} saves≈{:.1}g/h", d.why, d.value)));
                } else if vm.state == "stopped" && !stop {
                    acts.push(vm_act(ActKind::Start, j, vm, format!("{}{}", d.why, if safe { "" } else { " deadline-risk" })));
                }
            }
        }
        for x in &fresh {
            // create only what the reservation plan starts now (an earlier-deadline job may own the room)
            let Some(p) = &x.pick else { continue };
            if deferred.contains(&x.item) || !plan.starts_now(x.item, t_h) {
                continue;
            }
            let pr = &cat.profiles[p.prof];
            let zs = &cat.zones[p.zone].slug;
            acts.push(Action {
                kind: ActKind::Create { zone: zs.clone(), prof: pr.id.clone(), k: p.k },
                wl: wid(&view.jobs[x.job]),
                vm: None,
                why: format!(
                    "{}x{}@{} need={:.1}h slack={:.1}h expI={:.0} est={:.0}g{}{}",
                    pr.label,
                    p.k,
                    zs,
                    p.need_h,
                    p.slack_h,
                    p.exp_i,
                    p.grams,
                    if p.forced { " FORCED" } else { "" },
                    if safe { "" } else { " deadline-risk" }
                ),
            });
        }

        // The clock only starts on the first accepted create: with nothing released and nothing
        // existing (or in flight), deploy the earliest-release job now; it waits for its release.
        if view.state == "READY" && view.usage.vms == 0.0 && !acts.iter().any(|a| matches!(a.kind, ActKind::Create { .. })) {
            let mut first: Vec<usize> = open.iter().copied().filter(|&ji| view.jobs[ji].vms.is_empty()).collect();
            first.sort_by(|&a, &b| {
                let d = cat.workloads[view.jobs[a].w].release - cat.workloads[view.jobs[b].w].release;
                if d != 0.0 && !d.is_nan() { d.partial_cmp(&0.0).unwrap() } else { std::cmp::Ordering::Equal }
            });
            if let Some(&fi) = first.first() {
                let j = &view.jobs[fi];
                if let Some(p) = self.placements(cat, view, &o, memo, j, jmax(t_h, rel_h(j))).into_iter().next() {
                    let pr = &cat.profiles[p.prof];
                    let zs = cat.zones[p.zone].slug.clone();
                    acts.push(Action {
                        kind: ActKind::Create { zone: zs.clone(), prof: pr.id.clone(), k: p.k },
                        wl: wid(j),
                        vm: None,
                        why: format!("clock start: {}x{}@{} est={:.0}g", pr.label, p.k, zs, p.grams),
                    });
                }
            }
        }
        acts
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{cheapest_mean, sort_num};

    /// The cached windows give exactly what `cheapestMean(fc.slice(0, W), n)` and
    /// `fc.slice(0, W).sort()[n - 1]` give, sums included (same summation order).
    #[test]
    fn window_cache_equals_direct_computation() {
        let mut s = 12345u64;
        let mut r = || {
            s = (s * 1664525 + 1013904223) % (1 << 32);
            s as f64 / 4294967296.0
        };
        for _ in 0..500 {
            let len = 1 + (r() * 30.0) as usize;
            // repeated values on purpose: ties must not change sums or order statistics
            let fc: Vec<f64> = (0..len).map(|_| if r() < 0.2 { 100.0 } else { 20.0 + r() * 400.0 }).collect();
            let win = Win::new(&fc);
            for w in 1..=len {
                let mut sorted = fc[..w].to_vec();
                sort_num(&mut sorted);
                for k in 0..=w + 2 {
                    let n = k as f64 * 0.7;
                    let a = win.cheapest_mean(w, n);
                    let b = cheapest_mean(&fc[..w], n).unwrap();
                    assert_eq!(a.to_bits(), b.to_bits(), "w={w} n={n}");
                    if k >= 1 && k <= w {
                        assert_eq!(win.nth(w, k as f64), Some(sorted[k - 1]));
                    }
                }
            }
        }
    }

    #[test]
    fn low_lag_overrides() {
        let fast = Opts::resolve(4.0 + 2.5 * 0.1, 0.1);
        assert_eq!(fast.cpu_window_h, 1e9);
        assert!(fast.prestage);
        assert_eq!(fast.margin_min_h, 1.25); // 4.25 - 3
        assert_eq!(fast.margin_min_h_gpu, Some(4.25)); // GPU jobs keep the full margin
        let slow = Opts::resolve(4.0 + 2.5 * 0.6, 0.6);
        assert_eq!(slow.cpu_window_h, 72.0);
        assert!(!slow.prestage);
        assert_eq!(slow.margin_min_h_gpu, None);
        assert_eq!(margin_h(&fast, 10.0, true), 4.25);
        assert_eq!(margin_h(&fast, 10.0, false), 1.25);
        assert_eq!(margin_h(&fast, 100.0, false), 12.0);
    }
}
