//! Port of `scripts/greenops/mock.mjs`: offline mock of the GreenOps engine + API, driving the real
//! controller core on a virtual clock.
//!
//! Electricity here is SYNTHETIC (random diurnal curves per area, random day drift, noisy
//! forecasts) — no real or run-specific series is used. Physics: boot+input setup, compute at
//! k*r*(1-sync)^(k-1), output, delivery; active watts while working, idle while waiting or done,
//! 0 W when stopped; quota counts stopped VMs; an illegal zone disqualifies.
//! API calls take a random wall latency (lognormal) and are applied part-way through the call, like
//! a loaded server; the run advances `speed` simulated seconds per wall second.
//!
//! Event order, RNG draws and float arithmetic follow the JS mock exactly (one virtual-clock event
//! per JS microtask cascade), so a seed gives the same run as `node scripts/greenops/mock.mjs`.

use indexmap::IndexMap;
use std::cmp::Ordering;
use std::collections::BinaryHeap;

use crate::controller::{
    Call, ControlOpts, Core, CreateReply, HttpReply, InstanceInfo, InstanceRef, Pt, Reply, RunState, Stats, Tick, Verb,
};
use crate::glue::{Assignment, StatusDoc, WlStatus};
use crate::jsmath;
use crate::legality::{profile_legal, zone_legal};
use crate::model::{Catalog, H, Usage, candidates, fits_quota, jmax, jmin, output_h, parse_iso_ms, rate_k, score, setup_h};

/// The mock's env stress knobs (same names and defaults as mock.mjs).
#[derive(Clone, Debug)]
pub struct MockEnv {
    /// MOCK_SLOW: engine speed factor vs catalog
    pub slow: f64,
    /// MOCK_RESUME_BOOT_S (hours here)
    pub resume_boot_h: f64,
    /// MOCK_STAGING=idle: staging at idle watts
    pub staging_idle: bool,
    /// MOCK_PRESTAGE=0 disables staging before release
    pub prestage: bool,
    /// MOCK_HIST_LAG (default 2), MOCK_HIST_SHIFT (default 0)
    pub hist_lag: f64,
    pub hist_shift: f64,
    /// MOCK_DRIFT='{"DE":[sigma,rho],...}'
    pub drift: Vec<(String, f64, f64)>,
    /// MOCK_FC_ANOM="sigma,rho"
    pub fc_anom: (f64, f64),
    /// MOCK_FC_ANOM_AREA='{"ES":[sigma,rho],...}'
    pub fc_anom_area: Vec<(String, f64, f64)>,
    /// MOCK_FC_BIAS
    pub fc_bias: f64,
    /// MOCK_FC_PERFECT (oracle: forecast = actuals, this many hours)
    pub fc_perfect: f64,
    /// MOCK_QUOTA=big
    pub quota_big: bool,
    /// MOCK_CORES
    pub cores: Option<f64>,
}

impl Default for MockEnv {
    fn default() -> Self {
        MockEnv {
            slow: 1.0,
            resume_boot_h: 0.0,
            staging_idle: false,
            prestage: true,
            hist_lag: 2.0,
            hist_shift: 0.0,
            drift: vec![],
            fc_anom: (0.0, 0.0),
            fc_anom_area: vec![],
            fc_bias: 0.0,
            fc_perfect: 0.0,
            quota_big: false,
            cores: None,
        }
    }
}

fn parse_area_pairs(s: &str) -> Result<Vec<(String, f64, f64)>, String> {
    let v: serde_json::Value = serde_json::from_str(s).map_err(|e| e.to_string())?;
    let obj = v.as_object().ok_or("expected an object")?;
    let mut out = Vec::new();
    for (k, a) in obj {
        let a = a.as_array().ok_or("expected [sigma, rho]")?;
        out.push((
            k.clone(),
            a.first().and_then(|x| x.as_f64()).unwrap_or(f64::NAN),
            a.get(1).and_then(|x| x.as_f64()).unwrap_or(f64::NAN),
        ));
    }
    Ok(out)
}

impl MockEnv {
    pub fn from_env() -> Result<MockEnv, String> {
        let var = |k: &str| std::env::var(k).ok();
        let num = |k: &str, d: f64| var(k).map(|v| crate::model::js_number(Some(&serde_json::Value::String(v)))).unwrap_or(d);
        let mut e = MockEnv { slow: num("MOCK_SLOW", 1.0), resume_boot_h: num("MOCK_RESUME_BOOT_S", 0.0) / 3600.0, ..Default::default() };
        e.staging_idle = var("MOCK_STAGING").as_deref() == Some("idle");
        e.prestage = var("MOCK_PRESTAGE").as_deref() != Some("0");
        e.hist_lag = num("MOCK_HIST_LAG", 2.0);
        e.hist_shift = num("MOCK_HIST_SHIFT", 0.0);
        if let Some(d) = var("MOCK_DRIFT") {
            e.drift = parse_area_pairs(&d).map_err(|x| format!("MOCK_DRIFT: {x}"))?;
        }
        if let Some(a) = var("MOCK_FC_ANOM") {
            let p: Vec<f64> = a.split(',').map(|x| crate::model::js_number(Some(&serde_json::Value::String(x.into())))).collect();
            e.fc_anom = (p.first().copied().unwrap_or(f64::NAN), p.get(1).copied().unwrap_or(f64::NAN));
        }
        if let Some(a) = var("MOCK_FC_ANOM_AREA") {
            e.fc_anom_area = parse_area_pairs(&a).map_err(|x| format!("MOCK_FC_ANOM_AREA: {x}"))?;
        }
        e.fc_bias = num("MOCK_FC_BIAS", 0.0);
        e.fc_perfect = num("MOCK_FC_PERFECT", 0.0);
        e.quota_big = var("MOCK_QUOTA").as_deref() == Some("big");
        e.cores = var("MOCK_CORES").map(|v| crate::model::js_number(Some(&serde_json::Value::String(v))));
        Ok(e)
    }
}

/// The mock's LCG (`rng(seed)` in mock.mjs).
pub struct Rng(u32);
impl Rng {
    pub fn new(seed: f64) -> Rng {
        // (seed >>> 0) || 1
        let s = if seed.is_finite() { (seed.trunc().rem_euclid(4294967296.0)) as u32 } else { 0 };
        Rng(if s == 0 { 1 } else { s })
    }
    pub fn next_f64(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1664525).wrapping_add(1013904223);
        self.0 as f64 / 4294967296.0
    }
}

pub fn gauss(r: &mut Rng) -> f64 {
    let a = r.next_f64();
    let l = jsmath::log(a + 1e-12);
    let b = r.next_f64();
    (-2.0 * l).sqrt() * jsmath::cos(2.0 * std::f64::consts::PI * b)
}

/// Generic area archetypes (mean, relative amplitude, hour of daily peak), randomised per seed.
const ARCH: [(&str, f64, f64, f64); 8] = [
    ("AT", 155.0, 0.2, 0.0),
    ("BG", 240.0, 0.25, 17.0),
    ("CH", 45.0, 0.3, 23.0),
    ("DE", 380.0, 0.2, 23.0),
    ("ES", 145.0, 0.25, 23.0),
    ("FR", 75.0, 0.3, 5.0),
    ("HR", 290.0, 0.27, 8.0),
    ("IT", 300.0, 0.2, 4.0),
];

pub struct Grid {
    hours: usize,
    pub areas: Vec<String>,
    pub actual: Vec<Vec<f64>>,
    base: Vec<Vec<f64>>,
    fc_err: Vec<Vec<[f64; 24]>>,
    sign: Vec<f64>,
    bias: f64,
    perfect: f64,
}

impl Grid {
    pub fn area_index(&self, a: &str) -> Option<usize> {
        self.areas.iter().position(|x| x == a)
    }

    /// `makeGrid(seed, hours)`
    pub fn new(seed: u32, hours: usize, env: &MockEnv) -> Grid {
        let mut r = Rng::new(seed as f64 * 7919.0 + 1.0);
        let mut actual = Vec::new();
        for (a, m0, amp0, pk0) in ARCH {
            let m = m0 * (0.75 + 0.5 * r.next_f64());
            let amp = amp0 * (0.6 + 0.8 * r.next_f64());
            let pk = pk0 + (r.next_f64() - 0.5) * 8.0;
            let mut drift = 1.0;
            let dr = env.drift.iter().find(|(k, _, _)| k == a);
            let mut arr = Vec::with_capacity(hours);
            for h in 0..hours {
                // day-to-day level: a random walk (default) or MOCK_DRIFT's mean-reverting AR(1)
                if h % 24 == 0 {
                    drift = match dr {
                        Some((_, sg, rh)) => jmax(0.3, jmin(2.0, 1.0 + rh * (drift - 1.0) + sg * gauss(&mut r))),
                        None => jmax(0.6, jmin(1.5, drift * (1.0 + 0.18 * gauss(&mut r)))),
                    };
                }
                let c = jsmath::cos((2.0 * std::f64::consts::PI * (h as f64 - pk)) / 24.0);
                let v = m * drift * (1.0 + amp * c) * (1.0 + 0.05 * gauss(&mut r));
                arr.push(jmax(5.0, v));
            }
            actual.push(arr);
        }
        // MOCK_FC_ANOM / MOCK_FC_ANOM_AREA: a persistent deviation of the actuals the forecast doesn't know
        let mut base = Vec::new();
        for (ai, (a, ..)) in ARCH.iter().enumerate() {
            base.push(actual[ai].clone());
            let (sg, rh) = env.fc_anom_area.iter().find(|(k, _, _)| k == a).map(|(_, s, r)| (*s, *r)).unwrap_or(env.fc_anom);
            if sg > 0.0 {
                let mut x = 0.0;
                for v in actual[ai].iter_mut() {
                    x = rh * x + (1.0 - rh * rh).sqrt() * sg * gauss(&mut r);
                    *v = jmax(5.0, *v * (1.0 + x));
                }
            }
        }
        let mut fc_err = Vec::new();
        for _ in ARCH {
            let mut rows = Vec::with_capacity(hours);
            for _ in 0..hours {
                let mut row = [0.0; 24];
                let mut e = 0.0;
                for (i, slot) in row.iter_mut().enumerate() {
                    e = 0.8 * e + 0.035 * gauss(&mut r);
                    *slot = e * (1.0 + i as f64 / 12.0);
                }
                rows.push(row);
            }
            fc_err.push(rows);
        }
        let sign = ARCH.iter().map(|_| if r.next_f64() < 0.5 { -1.0 } else { 1.0 }).collect();
        Grid {
            hours,
            areas: ARCH.iter().map(|a| a.0.to_string()).collect(),
            actual,
            base,
            fc_err,
            sign,
            bias: env.fc_bias,
            perfect: env.fc_perfect,
        }
    }

    /// The forecast published at sim hour t_h for area index ai.
    pub fn fc(&self, ai: usize, t_h: f64) -> Vec<f64> {
        let h0 = t_h.floor() as i64;
        let last = self.hours as i64 - 1;
        let ix = |i: i64| (h0 + i).min(last).max(0) as usize;
        if self.perfect > 0.0 {
            let n = self.perfect as i64;
            return (0..n).map(|i| self.actual[ai][ix(i)]).collect();
        }
        let row = &self.fc_err[ai][h0.min(last).max(0) as usize];
        (0..24).map(|i| self.base[ai][ix(i)] * (1.0 + row[i as usize]) * (1.0 + self.sign[ai] * self.bias * (i as f64 / 24.0))).collect()
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum VmState {
    Creating,
    Running,
    Stopped,
}

impl VmState {
    fn as_str(&self) -> &'static str {
        match self {
            VmState::Creating => "creating",
            VmState::Running => "running",
            VmState::Stopped => "stopped",
        }
    }
}

struct Vm {
    wl: usize,
    zone: String,
    prof: usize,
    name: String,
    state: VmState,
    created_t: f64,
}

struct Job {
    setup_left: Option<f64>,
    out_left: f64,
    done: f64,
    delivered: bool,
    delivered_at: Option<f64>,
    g: f64,
}

pub struct Engine<'a> {
    cat: &'a Catalog,
    grid: &'a Grid,
    env: &'a MockEnv,
    speed: f64,
    pub started: bool,
    pub wall0: f64,
    pub t: f64,
    seq: u64,
    pub dq: bool,
    vms: IndexMap<String, Vm>,
    jobs: Vec<Job>,
    zone_area: Vec<usize>,
    pub grams: f64,
    pub kwh: f64,
    pub idle_g: f64,
    pub rejects: u64,
    pub lost: f64,
}

impl<'a> Engine<'a> {
    pub fn new(cat: &'a Catalog, grid: &'a Grid, env: &'a MockEnv, speed: f64) -> Engine<'a> {
        Engine {
            cat,
            grid,
            env,
            speed,
            started: false,
            wall0: 0.0,
            t: 0.0,
            seq: 0,
            dq: false,
            vms: IndexMap::new(),
            jobs: cat
                .workloads
                .iter()
                .map(|_| Job { setup_left: None, out_left: 0.0, done: 0.0, delivered: false, delivered_at: None, g: 0.0 })
                .collect(),
            zone_area: cat.zones.iter().map(|z| grid.area_index(&z.area).expect("mock grid covers every catalog area")).collect(),
            grams: 0.0,
            kwh: 0.0,
            idle_g: 0.0,
            rejects: 0,
            lost: 0.0,
        }
    }

    fn sim_at(&self, wall: f64) -> f64 {
        if self.started { jmin(120.0, ((wall - self.wall0) * self.speed) / H) } else { 0.0 }
    }

    pub fn advance_to(&mut self, wall: f64) {
        let target = self.sim_at(wall);
        while self.t < target - 1e-9 {
            let dt = jmin(0.02, target - self.t);
            self.physics(dt);
            self.t += dt;
        }
    }

    fn usage(&self) -> Usage {
        let mut u = Usage::default();
        for v in self.vms.values() {
            let p = &self.cat.profiles[v.prof];
            u.vms += 1.0;
            u.cores += p.cores;
            if !p.is_cpu {
                u.add_card(&p.family, p.cards);
            }
        }
        u
    }

    fn physics(&mut self, dt: f64) {
        for v in self.vms.values_mut() {
            if v.state == VmState::Creating && self.t - v.created_t >= 0.01 {
                v.state = VmState::Running;
            }
        }
        let env = self.env;
        for ji in 0..self.jobs.len() {
            let mut n = 0usize;
            let mut run = 0usize;
            let mut first: Option<(usize, usize)> = None;
            for v in self.vms.values() {
                if v.wl == ji {
                    if first.is_none() {
                        first = Some((v.prof, self.cat.zone_index(&v.zone).unwrap()));
                    }
                    n += 1;
                    if v.state == VmState::Running {
                        run += 1;
                    }
                }
            }
            let Some((pi, zi)) = first else { continue };
            let p = &self.cat.profiles[pi];
            let w = &self.cat.workloads[ji];
            let j = &mut self.jobs[ji];
            let released = self.cat.t0 + self.t * H >= w.release;
            let mut active_frac = 0.0;
            if !j.delivered && (released || env.prestage) && run == n && run > 0 {
                if j.setup_left.is_none() {
                    j.setup_left = Some(setup_h(w, p));
                    j.out_left = output_h(w);
                }
                let mut left = dt;
                let mut setup_used = 0.0;
                let sl = j.setup_left.unwrap();
                if sl > 0.0 {
                    let u = jmin(left, sl);
                    j.setup_left = Some(sl - u);
                    left -= u;
                    setup_used = u;
                }
                if !released {
                    left = 0.0; // staged, waiting for release (idle draw for the rest of the step)
                }
                if released && left > 0.0 && j.done < w.required {
                    let r = rate_k(w, p, run as f64) * env.slow;
                    let u = jmin(left, (w.required - j.done) / r);
                    j.done += r * u;
                    left -= u;
                }
                if released && left > 0.0 && j.done >= w.required - 1e-9 && j.out_left > 0.0 {
                    let u = jmin(left, j.out_left);
                    j.out_left -= u;
                    left -= u;
                }
                if released && j.done >= w.required - 1e-9 && j.out_left <= 1e-9 && !j.delivered {
                    j.delivered = true;
                    j.delivered_at = Some(self.t + dt - left);
                }
                active_frac = if released {
                    (dt - left - if env.staging_idle { setup_used } else { 0.0 }) / dt
                } else if env.staging_idle {
                    0.0
                } else {
                    setup_used / dt
                };
            }
            let z = &self.cat.zones[zi];
            let ii = (self.t.floor() as usize).min(159);
            let intensity = self.grid.actual[self.zone_area[zi]][ii];
            for v in self.vms.values() {
                if v.wl != ji || v.state == VmState::Stopped {
                    continue;
                }
                let watts = active_frac * p.watts + (1.0 - active_frac) * p.idle_watts;
                let e = (watts * dt) / 1000.0;
                self.kwh += e;
                self.grams += e * z.pue * intensity;
                j.g += e * z.pue * intensity;
                if active_frac < 1.0 {
                    self.idle_g += (((1.0 - active_frac) * p.idle_watts * dt) / 1000.0) * z.pue * intensity;
                }
            }
        }
    }

    pub fn state(&self) -> &'static str {
        if !self.started {
            "READY"
        } else if self.t >= 120.0 - 1e-9 {
            "COMPLETED"
        } else {
            "RUNNING"
        }
    }

    pub fn status(&self) -> StatusDoc {
        StatusDoc {
            // new Date(T0 + t*H).toISOString() read back with Date.parse: whole milliseconds
            virtual_time_ms: Some(jsmath::ms_trunc(self.cat.t0 + self.t * H)),
            speed: self.speed,
            state: self.state().to_string(),
            qualification: if self.dq { "DISQUALIFIED" } else { "QUALIFIED" }.to_string(),
            workloads: self
                .jobs
                .iter()
                .enumerate()
                .map(|(ji, j)| WlStatus {
                    id: self.cat.workloads[ji].id.clone(),
                    state: if j.delivered { "succeeded" } else { "running" }.to_string(),
                    // completed_work: done.toFixed(6), read back with Number()
                    completed_work: jsmath::fixed6(j.done),
                    delivered: j.delivered,
                    assignments: self
                        .vms
                        .iter()
                        .filter(|(_, v)| v.wl == ji)
                        .map(|(id, v)| Assignment { vm_id: id.clone(), zone: Some(v.zone.clone()), state: v.state.as_str().to_string() })
                        .collect(),
                })
                .collect(),
        }
    }

    pub fn create(&mut self, zone: &str, prof: &str, name: &str, wl: &str, wall: f64) -> CreateReply {
        if self.state() == "COMPLETED" {
            return CreateReply { id: None, error: "run completed".into(), ambiguous: false };
        }
        let (w, z, p) = (self.cat.workload(wl), self.cat.zone(zone), self.cat.profile(prof));
        let legal = match (w, z, p) {
            (Some(w), Some(z), Some(p)) => zone_legal(w, z) && profile_legal(w, p),
            _ => false,
        };
        if !legal {
            self.dq = true;
            return CreateReply { id: None, error: "residency violation".into(), ambiguous: false };
        }
        let p = p.unwrap();
        if !fits_quota(self.cat, &self.usage(), p, 1.0) {
            self.rejects += 1;
            return CreateReply { id: None, error: "409 quota".into(), ambiguous: false };
        }
        if !self.started {
            self.started = true;
            self.wall0 = wall;
        }
        self.seq += 1;
        let id = format!("vm-{}", self.seq);
        let vm = Vm {
            wl: self.cat.workload_index(wl).unwrap(),
            zone: zone.to_string(),
            prof: self.cat.profile_index(prof).unwrap(),
            name: name.to_string(),
            state: VmState::Creating,
            created_t: self.t,
        };
        self.vms.insert(id.clone(), vm);
        CreateReply { id: Some(id), error: String::new(), ambiguous: false }
    }

    pub fn vm_action(&mut self, id: &str, verb: Verb) -> HttpReply {
        let Some(v) = self.vms.get_mut(id) else { return HttpReply { ok: false, status: 404, text: String::new() } };
        if verb == Verb::Stop && v.state == VmState::Running {
            v.state = VmState::Stopped;
        } else if verb == Verb::Start && v.state == VmState::Stopped {
            v.state = VmState::Running;
            let j = &mut self.jobs[v.wl];
            if let Some(s) = j.setup_left {
                j.setup_left = Some(s + self.env.resume_boot_h);
            }
        }
        HttpReply { ok: true, status: 200, text: String::new() }
    }

    pub fn remove(&mut self, id: &str) -> HttpReply {
        let Some(v) = self.vms.get(id) else { return HttpReply { ok: false, status: 404, text: String::new() } };
        let (wl, prof) = (v.wl, v.prof);
        let k = self.vms.values().filter(|x| x.wl == wl).count();
        self.vms.shift_remove(id);
        // engine rule: deletion discards uncheckpointed work (restart_from_zero: all of it); a job left
        // without VMs must boot and stage its input again on the next create
        let w = &self.cat.workloads[wl];
        let j = &mut self.jobs[wl];
        if !j.delivered && j.done < w.required {
            let p = &self.cat.profiles[prof];
            let ck_w = rate_k(w, p, k as f64) * self.env.slow * (w.checkpoint_s / 3600.0);
            let kept = if w.restart_from_zero || !(ck_w > 0.0) { 0.0 } else { (j.done / ck_w + 1e-9).floor() * ck_w };
            if k == 1 {
                self.lost += j.done - kept;
                j.done = kept;
                j.setup_left = None;
            } else {
                let share = (j.done - kept) / k as f64;
                self.lost += share;
                j.done -= share;
            }
        }
        HttpReply { ok: true, status: 200, text: String::new() }
    }

    pub fn forecast(&self, area: &str) -> Vec<Pt> {
        let h0 = self.t.floor();
        let ai = self.grid.area_index(area).unwrap();
        self.grid.fc(ai, self.t).into_iter().enumerate().map(|(i, v)| Pt { t: self.cat.t0 + (h0 + i as f64) * H, v }).collect()
    }

    /// published observations: hours up to floor(t) - MOCK_HIST_LAG, most recent 24
    pub fn history(&self, area: &str) -> Vec<Pt> {
        let ai = self.grid.area_index(area).unwrap();
        let h1 = self.t.floor() + 1.0 - self.env.hist_lag;
        let mut out = Vec::new();
        let mut h = jmax(0.0, h1 - 24.0);
        while h < h1 {
            let src = jmax(0.0, h - self.env.hist_shift) as usize;
            out.push(Pt { t: self.cat.t0 + h * H, v: self.grid.actual[ai][src] });
            h += 1.0;
        }
        out
    }

    pub fn exec(&mut self, call: &Call, wall: f64) -> Reply {
        match call {
            Call::Status => Reply::Status(Some(self.status())),
            Call::Forecast { area } => Reply::Points(Some(self.forecast(area))),
            Call::History { area } => Reply::Points(Some(self.history(area))),
            Call::Create { zone, prof, name, wl } => Reply::Create(self.create(zone, prof, name, wl, wall)),
            Call::ListInstances { zone } => Reply::List(
                self.vms
                    .iter()
                    .filter(|(_, v)| v.zone == *zone)
                    .map(|(id, v)| InstanceRef { id: id.clone(), name: v.name.clone() })
                    .collect(),
            ),
            Call::FindByName { name, .. } => Reply::Found(self.vms.iter().find(|(_, v)| v.name == *name).map(|(id, _)| id.clone())),
            Call::VmAction { id, verb, .. } => Reply::Http(self.vm_action(id, *verb)),
            Call::Remove { id, .. } => Reply::Http(self.remove(id)),
            Call::GetInstance { id, .. } => Reply::Instance(
                self.vms.get(id).map(|v| InstanceInfo { prof: Some(self.cat.profiles[v.prof].id.clone()), name: v.name.clone() }),
            ),
        }
    }
}

enum Ev {
    Tick,
    Mid { id: u64, call: Call, l: f64, u: f64 },
    End { id: u64, reply: Reply },
    Timer { token: u64 },
}

struct Entry {
    at: f64,
    seq: u64,
    ev: Ev,
}
impl PartialEq for Entry {
    fn eq(&self, o: &Self) -> bool {
        self.at == o.at && self.seq == o.seq
    }
}
impl Eq for Entry {}
impl PartialOrd for Entry {
    fn partial_cmp(&self, o: &Self) -> Option<Ordering> {
        Some(self.cmp(o))
    }
}
impl Ord for Entry {
    // BinaryHeap is a max-heap: invert so the earliest (at, seq) pops first
    fn cmp(&self, o: &Self) -> Ordering {
        o.at.total_cmp(&self.at).then(o.seq.cmp(&self.seq))
    }
}

/// `VClock`: virtual wall time (ms) and the sleepers queue.
struct VClock {
    t: f64,
    seq: u64,
    q: BinaryHeap<Entry>,
}
impl VClock {
    fn sleep(&mut self, ms: f64, ev: Ev) {
        let at = self.t + jmax(0.0, ms);
        self.q.push(Entry { at, seq: self.seq, ev });
        self.seq += 1;
    }
}

#[derive(Clone, Debug)]
pub struct SimOpts {
    pub lat_ms: f64,
    pub ctl: ControlOpts,
    /// policy experiment overrides (empty: the JS defaults)
    pub policy: crate::tweaks::Tweaks,
    pub late_start_h: f64,
    pub foreign: bool,
    pub verbose: bool,
    pub env: MockEnv,
}

impl Default for SimOpts {
    fn default() -> Self {
        SimOpts {
            lat_ms: 3000.0,
            ctl: ControlOpts::default(),
            policy: crate::tweaks::Tweaks::default(),
            late_start_h: 0.0,
            foreign: false,
            verbose: false,
            env: MockEnv::default(),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SimResult {
    pub seed: u32,
    pub points: f64,
    pub bound: f64,
    /// per-job perfect-foresight lower bound (grams), aligned with per_job
    pub bound_per: Vec<f64>,
    pub per_job: Vec<(String, f64)>,
    pub dq: bool,
    pub grams: f64,
    pub kwh: f64,
    pub idle_g: f64,
    pub late: Vec<String>,
    pub rejects: u64,
    pub stats: Stats,
    pub left_vms: usize,
    pub lines: Vec<String>,
}

/// Lower bound (perfect foresight, no quota, no latency): every job alone on its best legal single
/// VM, running only in the cleanest actual hours between release and deadline.
pub fn lower_bound(cat: &Catalog, grid: &Grid, env: &MockEnv) -> f64 {
    lower_bound_per(cat, grid, env).0
}

/// `lowerBound` with its per-job values (`per` in mock.mjs).
pub fn lower_bound_per(cat: &Catalog, grid: &Grid, env: &MockEnv) -> (f64, Vec<f64>) {
    let mut per = Vec::with_capacity(cat.workloads.len());
    let mut total = 0.0;
    for w in &cat.workloads {
        let r0 = ((w.release - cat.t0) / H).ceil();
        let d0 = ((w.deadline - cat.t0) / H).floor();
        let mut best = f64::INFINITY;
        for c in candidates(cat, w) {
            if c.k != 1.0 {
                continue;
            }
            let p = &cat.profiles[c.prof];
            let z = &cat.zones[c.zone];
            let need = setup_h(w, p) + w.required / rate_k(w, p, 1.0) + output_h(w);
            let act = &grid.actual[grid.area_index(&z.area).unwrap()];
            let (a, b) = ((r0.max(0.0) as usize).min(act.len()), (d0.max(0.0) as usize).min(act.len()));
            let mut hours: Vec<f64> = if a < b { act[a..b].to_vec() } else { vec![] };
            crate::model::sort_num(&mut hours);
            if (hours.len() as f64) < need.ceil() {
                continue;
            }
            let (mut sum, mut left) = (0.0, need);
            for v in &hours {
                let u = jmin(1.0, left);
                sum += v * u;
                left -= u;
                if left <= 0.0 {
                    break;
                }
            }
            let active_h = if env.staging_idle { need - setup_h(w, p) } else { need };
            let g = (p.watts / 1000.0) * z.pue * sum * (active_h / need)
                + if env.staging_idle { (p.idle_watts / 1000.0) * z.pue * (sum / need) * setup_h(w, p) } else { 0.0 };
            if g < best {
                best = g;
            }
        }
        total += best;
        per.push(best);
    }
    (total, per)
}

/// One seeded mock run (`simulate()` in mock.mjs).
pub fn simulate(seed: u32, o: &SimOpts) -> SimResult {
    let env = &o.env;
    let mut cat = Catalog::builtin();
    // diagnostic: MOCK_QUOTA=big removes the shared quota (to measure what contention costs)
    if env.quota_big {
        cat.quota.vms = 500.0;
        cat.quota.cores = 100000.0;
        for v in cat.quota.cards.values_mut() {
            *v = 100.0;
        }
    }
    if let Some(c) = env.cores {
        cat.quota.cores = c;
    }
    cat.t0 = parse_iso_ms("2025-09-30T00:00:00Z").unwrap();
    let grid = Grid::new(seed, 160, env);
    let engine_cat = cat.clone();
    let mut engine = Engine::new(&engine_cat, &grid, env, 720.0);
    let mut clock = VClock { t: 0.0, seq: 0, q: BinaryHeap::new() };
    let mut api_rng = Rng::new(seed as f64 * 31.0 + 7.0);
    let lines = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    if o.foreign || o.late_start_h > 0.0 {
        // replay of a run someone else started: the starter demo's two VMs, then our controller joins late
        if o.foreign {
            engine.create("at-vie-1", "20000000-0000-4000-8000-000000000002", "baseline-cpu", "w-01-dach-research", 0.0);
            engine.create("ch-gva-2", "20000000-0000-4000-8000-000000000011", "baseline-gpu", "w-08-ch-imaging", 0.0);
        } else {
            engine.started = true;
            engine.wall0 = 0.0;
        }
        clock.t = (o.late_start_h * H) / 720.0;
        engine.advance_to(clock.t);
    }
    let st = RunState { run: "mock".into(), vms: IndexMap::new(), seq: 0, deleted: vec![] };
    let mut core = Core::new(cat.clone(), st, "mockrun0", o.ctl.clone());
    core.set_policy_tweaks(o.policy.clone());
    if o.verbose {
        let sink = lines.clone();
        // the engine clock isn't visible here; log lines carry the controller's own sim time
        core.set_log(Box::new(move |m: &str| sink.lock().unwrap().push(m.to_string())));
    }

    let lat_ms = o.lat_ms;
    let flush = |core: &mut Core, clock: &mut VClock, rng: &mut Rng| {
        for (id, call) in core.outbox.drain(..) {
            let l = lat_ms * jsmath::exp(0.6 * gauss(rng));
            let u = 0.3 + 0.6 * rng.next_f64();
            clock.sleep(l * u, Ev::Mid { id, call, l, u });
        }
        for (token, ms) in core.timers.drain(..) {
            clock.sleep(ms, Ev::Timer { token });
        }
    };
    // runLoop's first iteration runs synchronously when it is called
    let t = core.loop_tick(clock.t);
    flush(&mut core, &mut clock, &mut api_rng);
    if let Tick::Next(ms) = t {
        clock.sleep(ms, Ev::Tick);
    }
    const WALL_LIMIT: f64 = 2.0e6;
    while !core.done {
        let Some(e) = clock.q.pop() else { break };
        clock.t = clock.t.max(e.at);
        match e.ev {
            Ev::Tick => {
                let t = core.loop_tick(clock.t);
                flush(&mut core, &mut clock, &mut api_rng);
                if let Tick::Next(ms) = t {
                    clock.sleep(ms, Ev::Tick);
                }
            }
            Ev::Mid { id, call, l, u } => {
                engine.advance_to(clock.t);
                let reply = engine.exec(&call, clock.t);
                clock.sleep(l * (1.0 - u), Ev::End { id, reply });
            }
            Ev::End { id, reply } => {
                core.on_reply(id, reply, clock.t);
                flush(&mut core, &mut clock, &mut api_rng);
            }
            Ev::Timer { token } => {
                core.on_timer(token);
                flush(&mut core, &mut clock, &mut api_rng);
            }
        }
        if clock.t > WALL_LIMIT {
            break;
        }
    }
    // carbon counts through the full window: let the engine run to 120h with whatever is left
    engine.advance_to(engine.wall0 + (120.0 * H) / 720.0 + 1.0);
    let late: Vec<String> = engine
        .jobs
        .iter()
        .enumerate()
        .filter(|(i, j)| !j.delivered || j.delivered_at.unwrap() * H + cat.t0 > cat.workloads[*i].deadline)
        .map(|(i, _)| cat.workloads[i].id.clone())
        .collect();
    let carbon: Vec<f64> = engine.jobs.iter().map(|j| j.g).collect();
    let progress: Vec<f64> = engine
        .jobs
        .iter()
        .enumerate()
        .map(|(i, j)| if late.contains(&cat.workloads[i].id) { 0.5 * jmin(1.0, j.done / cat.workloads[i].required) } else { 1.0 })
        .collect();
    let (_, total) = score(&cat, &carbon, &progress, late.is_empty() && !engine.dq);
    let mut out_lines = lines.lock().unwrap().clone();
    if o.verbose {
        for (i, j) in engine.jobs.iter().enumerate() {
            out_lines.push(format!(
                "{:<22} {:>6} g  delivered {} / deadline {:.0}",
                cat.workloads[i].id,
                format!("{:.0}", j.g),
                j.delivered_at.map(|d| format!("{d:.1}")).unwrap_or_else(|| "undefined".into()),
                (cat.workloads[i].deadline - cat.t0) / H
            ));
        }
    }
    let (bound, bound_per) = lower_bound_per(&cat, &grid, env);
    SimResult {
        seed,
        points: if engine.dq { 0.0 } else { total },
        bound,
        bound_per,
        per_job: engine.jobs.iter().enumerate().map(|(i, j)| (cat.workloads[i].id.clone(), j.g)).collect(),
        dq: engine.dq,
        grams: engine.grams,
        kwh: engine.kwh,
        idle_g: engine.idle_g,
        late,
        rejects: engine.rejects,
        stats: core.stats,
        left_vms: engine.vms.len(),
        lines: out_lines,
    }
}
