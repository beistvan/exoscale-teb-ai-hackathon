//! Port of `scripts/greenops/controller.mjs`: the latency-tolerant control loop, written sans-IO.
//!
//! The core never blocks and never performs I/O. Each entry point (`loop_tick`, `on_reply`,
//! `on_timer`) takes the current wall time and queues API calls in `outbox`; a driver executes them
//! (the live tokio driver, or the offline simulator on a virtual clock) and feeds each reply back.
//! The JS controller's promise continuations become explicit `Cont` values, run in the same order,
//! so the decisions match the JS controller step for step:
//!  - status polls run in the background (a few in flight, staggered) and the freshest reply wins;
//!  - simulated "now" is extrapolated from the freshest reply and the run speed;
//!  - decisions are made for the moment an action will land (now + measured API latency), and
//!    deadline margins grow with that latency;
//!  - every create/stop/start/delete is fired asynchronously with in-flight guards, and its
//!    acknowledged effect is overlaid on stale status until a newer snapshot reflects it.

use indexmap::{IndexMap, IndexSet};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::glue::{ReceiptRow, StatusDoc, Tracker, build_view};
use crate::jsmath;
use crate::legality::{profile_legal, zone_legal};
use crate::model::{Catalog, FxBuild, FxMap, FxSet, H, jmax, jmin};
use crate::policy::{ActKind, Action, Memo, Policy, View};

/// CONTROL in controller.mjs.
#[derive(Clone, Debug)]
pub struct ControlOpts {
    /// decision cadence (wall ms)
    pub loop_ms: f64,
    /// status requests in flight at once (staggered) → fresher snapshots
    pub status_concurrency: u32,
    /// min wall gap between status request starts (ms)
    pub status_gap_ms: f64,
    /// deadline margin before latency is added (h)
    pub base_margin_h: f64,
    /// + this many "action latencies" (in sim hours) of extra margin
    pub latency_margin_x: f64,
    /// don't stop the same VM again sooner than this after a toggle (sim hours)
    pub min_dwell_h: f64,
    /// planning latency = median of the last 15 calls (not an EWMA a single stall can blow up)
    pub lat_robust: bool,
    /// fetch each area's forecast (and observations) until the held vintage is the server's current hour
    pub fresh_fc: bool,
    /// ...wall gap between such re-fetches per area (ms)
    pub fc_retry_ms: f64,
    /// placement estimates average the newest N forecast vintages (each corrected for its own lead)
    pub place_vintages: f64,
    /// sleep only until the next hour boundary (action time or server time), not a whole loop
    pub align_boundary: bool,
    /// decide as soon as a newer forecast vintage or observation arrives...
    pub wake_on_data: bool,
    /// ...after this short wait, so one hour's burst of replies triggers one decision (ms)
    pub wake_debounce_ms: f64,
    /// inside the stop dwell, still allow a stop when new data arrived since the last toggle
    pub info_dwell: bool,
    /// wall seconds a paused / not-yet-created job must keep before its deadline while the server shows stress
    pub stall_buffer_s: f64,
    /// ...and always
    pub stall_base_s: f64,
    /// stress = a call slower than this (ms), finished or still in flight,
    pub stall_trigger_ms: f64,
    /// ...within this many wall seconds
    pub stall_memory_s: f64,
    /// measure compute rates from the engine's reported VM states only (see Tracker::observe)
    pub raw_tracker: bool,
    /// never extrapolate the simulated clock more than this past the freshest status reply (ms)
    pub max_extrap_ms: f64,
    /// after this many failed decision steps in a row, start every stopped VM of unfinished work
    pub safe_mode_errors: f64,
    /// a loop gap longer than this (ms) = this process was frozen; wait for a status requested after it
    pub freeze_ms: f64,
    /// cap on the latency used for planning (sim hours)
    pub max_lat_h: f64,
    /// learn each area's forecast error by lead time from this run's own published observations
    pub learn_bias: bool,
    pub bias_shrink_n: f64,
    pub bias_cap: f64,
    /// carry the latest observed forecast miss forward while this run's misses persist
    pub nowcast: bool,
    pub nowcast_min_n: f64,
    pub nowcast_min_rho: f64,
}

impl ControlOpts {
    /// Apply `--ctl key=value` overrides.
    pub fn apply(&mut self, tw: &crate::tweaks::Tweaks) {
        for (k, v) in &tw.kv {
            let v = *v;
            match k.as_str() {
                "loop_ms" => self.loop_ms = v,
                "status_concurrency" => self.status_concurrency = v as u32,
                "status_gap_ms" => self.status_gap_ms = v,
                "base_margin_h" => self.base_margin_h = v,
                "latency_margin_x" => self.latency_margin_x = v,
                "min_dwell_h" => self.min_dwell_h = v,
                "lat_robust" => self.lat_robust = v != 0.0,
                "fresh_fc" => self.fresh_fc = v != 0.0,
                "fc_retry_ms" => self.fc_retry_ms = v,
                "place_vintages" => self.place_vintages = v,
                "align_boundary" => self.align_boundary = v != 0.0,
                "wake_on_data" => self.wake_on_data = v != 0.0,
                "wake_debounce_ms" => self.wake_debounce_ms = v,
                "info_dwell" => self.info_dwell = v != 0.0,
                "stall_buffer_s" => self.stall_buffer_s = v,
                "stall_base_s" => self.stall_base_s = v,
                "stall_trigger_ms" => self.stall_trigger_ms = v,
                "stall_memory_s" => self.stall_memory_s = v,
                "raw_tracker" => self.raw_tracker = v != 0.0,
                "max_extrap_ms" => self.max_extrap_ms = v,
                "safe_mode_errors" => self.safe_mode_errors = v,
                "freeze_ms" => self.freeze_ms = v,
                "max_lat_h" => self.max_lat_h = v,
                "learn_bias" => self.learn_bias = v != 0.0,
                "bias_shrink_n" => self.bias_shrink_n = v,
                "bias_cap" => self.bias_cap = v,
                "nowcast" => self.nowcast = v != 0.0,
                "nowcast_min_n" => self.nowcast_min_n = v,
                "nowcast_min_rho" => self.nowcast_min_rho = v,
                _ => {}
            }
        }
    }
}

impl Default for ControlOpts {
    fn default() -> Self {
        ControlOpts {
            loop_ms: 250.0,
            status_concurrency: 4,
            status_gap_ms: 700.0,
            base_margin_h: 4.0,
            latency_margin_x: 2.5,
            // was 0.6: with fresh vintages a start decided from vintage h-1 that vintage h overturns was held
            // running for most of a dirty hour
            min_dwell_h: 0.1,
            lat_robust: true,
            fresh_fc: true,
            fc_retry_ms: 100.0,
            place_vintages: 3.0,
            align_boundary: true,
            wake_on_data: true,
            wake_debounce_ms: 30.0,
            info_dwell: true,
            stall_buffer_s: 35.0,
            stall_base_s: 10.0,
            stall_trigger_ms: 2000.0,
            stall_memory_s: 60.0,
            raw_tracker: false,
            max_extrap_ms: 10000.0,
            safe_mode_errors: 8.0,
            freeze_ms: 5000.0,
            max_lat_h: 4.0,
            learn_bias: true,
            bias_shrink_n: 24.0,
            bias_cap: 0.3,
            nowcast: true,
            nowcast_min_n: 12.0,
            nowcast_min_rho: 0.3,
        }
    }
}

/// One receipt row: a VM this controller created or adopted (JSON-compatible with the JS receipt).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receipt {
    pub wl: String,
    pub zone: String,
    pub prof: String,
    #[serde(default)]
    pub name: String,
    #[serde(rename = "tH", default, skip_serializing_if = "Option::is_none")]
    pub t_h: Option<f64>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub adopted: bool,
}

/// The persisted receipt (`greenops-orchestrator-state.json`), same shape as the JS controller's.
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct RunState {
    pub run: String,
    #[serde(default)]
    pub vms: IndexMap<String, Receipt>,
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub deleted: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Stats {
    pub creates: u64,
    pub stops: u64,
    pub starts: u64,
    pub deletes: u64,
    pub errors: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Pt {
    /// epoch ms
    pub t: f64,
    pub v: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Verb {
    Start,
    Stop,
}

impl Verb {
    pub fn as_str(&self) -> &'static str {
        match self {
            Verb::Start => "start",
            Verb::Stop => "stop",
        }
    }
}

/// An API request the core wants executed.
#[derive(Clone, Debug)]
pub enum Call {
    Status,
    Forecast { area: String },
    History { area: String },
    Create { zone: String, prof: String, name: String, wl: String },
    FindByName { zone: String, name: String },
    VmAction { zone: Option<String>, id: String, verb: Verb },
    Remove { zone: Option<String>, id: String },
    GetInstance { zone: Option<String>, id: String },
    ListInstances { zone: String },
}

#[derive(Clone, Debug, Default)]
pub struct CreateReply {
    pub id: Option<String>,
    pub error: String,
    pub ambiguous: bool,
}

#[derive(Clone, Debug, Default)]
pub struct HttpReply {
    pub ok: bool,
    pub status: u16,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct InstanceInfo {
    pub prof: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug)]
pub struct InstanceRef {
    pub id: String,
    pub name: String,
}

/// The driver's answer to a `Call`.
#[derive(Clone, Debug)]
pub enum Reply {
    Status(Option<StatusDoc>),
    Points(Option<Vec<Pt>>),
    Create(CreateReply),
    Found(Option<String>),
    Http(HttpReply),
    Instance(Option<InstanceInfo>),
    List(Vec<InstanceRef>),
}

/// Work for the driver, in issue order: an API call to run, or a timer to arm (wall ms). Order matters
/// to the simulator, where each one is a virtual-clock entry like a JS `clock.sleep`.
#[derive(Clone, Debug)]
pub enum Out {
    Call(u64, Call),
    Timer(u64, f64),
}

#[derive(Clone, Debug)]
enum TimerKind {
    /// retry adopting a foreign VM
    Adopt(String),
    /// `wakeUp()`'s debounce: run the next decision now if the loop is asleep
    Wake,
}

/// What to do when a call returns (the JS promise continuations).
#[derive(Clone, Debug)]
enum Cont {
    Status { t0: f64 },
    Forecast { area: String, hour: i64 },
    History { area: String, hour: i64 },
    Create { wl: String, zone: String, prof: String, name: String, t_act: f64, t_now0: f64, t0: f64, why: String },
    CreateFind { wl: String, zone: String, prof: String, name: String, t_act: f64, t_now0: f64, t0: f64, why: String, err: String },
    Vm { delete: bool, verb: Option<Verb>, wl: String, id: String, t_act: f64, t_now0: f64, t0: f64, why: String, ver0: u64 },
    Adopt { wl: String, zone: Option<String>, id: String },
    FinalRemove { id: String },
    FinalList { zone: String },
    FinalOrphan { zone: String, name: String },
}

#[derive(Clone, Debug)]
pub struct Snap {
    pub s: StatusDoc,
    pub vt: f64,
    pub t: f64,
    pub wall_at: f64,
    /// wall time the status request was sent
    pub req_at: f64,
    pub speed: f64,
    pub state: String,
}

/// One area's published observations (epoch ms -> gCO2e/kWh). Hour-aligned stamps (all of them, in
/// practice) live in a dense array; anything else in a map. Same lookups as the JS `Map`.
#[derive(Default)]
struct Obs {
    t0: f64,
    dense: Vec<f64>,
    sparse: FxMap<i64, f64>,
    n: usize,
}

impl Obs {
    fn slot(&self, t: f64) -> Option<usize> {
        let h = (t - self.t0) / H;
        if (0.0..10000.0).contains(&h) && h.fract() == 0.0 && self.t0 + h * H == t { Some(h as usize) } else { None }
    }
    fn get(&self, t: f64) -> Option<f64> {
        match self.slot(t) {
            Some(i) => self.dense.get(i).copied().filter(|v| !v.is_nan()),
            None => self.sparse.get(&(t as i64)).copied(),
        }
    }
    fn set(&mut self, t: f64, v: f64) {
        match self.slot(t) {
            Some(i) => {
                if i >= self.dense.len() {
                    self.dense.resize(i + 1, f64::NAN);
                }
                if self.dense[i].is_nan() {
                    self.n += 1;
                }
                // (a NaN reading would read as missing, like `!(o > 0)` in JS)
                self.dense[i] = v;
            }
            None => {
                if self.sparse.insert(t as i64, v).is_none() {
                    self.n += 1;
                }
            }
        }
    }
}

#[derive(Clone, Debug)]
struct FcEntry {
    hour: i64,
    vh: i64,
    pts: Vec<Pt>,
}

/// Cached corrected forecasts of one area for one hour (planning and placement), with versions.
#[derive(Clone, Debug)]
struct FcView {
    hour_start: f64,
    fc: Option<std::sync::Arc<Vec<f64>>>,
    ver: u64,
    place: Option<std::sync::Arc<Vec<f64>>>,
    place_ver: u64,
}

#[derive(Clone, Debug)]
struct Anom {
    rho: f64,
    a0: f64,
    t0: f64,
}

#[derive(Clone, Debug)]
struct Bias {
    b: [f64; 25],
    anom: Option<Anom>,
}

#[derive(Clone, Debug)]
struct InCreate {
    zone: String,
    prof: String,
    left: u32,
}

#[derive(Clone, Debug)]
struct Override {
    state: &'static str,
    wall_ack: f64,
}

#[derive(Default)]
struct Finalize {
    pending_removes: usize,
    zones_pending: usize,
    orphans_pending: FxMap<String, usize>,
}

/// What the driver should do after `loop_tick`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Tick {
    /// schedule the next tick after `ms`
    Next(f64),
    /// finalize is running; the loop resumes (and ends) when it completes
    Wait,
    /// the controller is done
    Done,
}

/// `(1 - k) * a + k * b` with k = 0.3 (the JS ewma, operand order kept)
fn ewma(a: Option<f64>, b: f64) -> f64 {
    let k = 0.3;
    match a {
        None => b,
        Some(a) => (1.0 - k) * a + k * b,
    }
}

fn fmt3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

pub type LogFn = Box<dyn FnMut(&str) + Send>;
pub type EventFn = Box<dyn FnMut(Value) + Send>;

pub struct Core {
    pub cat: Catalog,
    pub o: ControlOpts,
    pub st: RunState,
    pub run: String,
    pub stats: Stats,
    pub done: bool,
    pub finalizing: bool,
    pub snap: Option<Snap>,
    /// the receipt changed since the driver last persisted it
    pub dirty: bool,
    policy: Policy,
    areas: Vec<String>,
    prefix: String,
    deleted: IndexSet<String>,
    status_inflight: u32,
    last_status_start: f64,
    fc: FxMap<String, FcEntry>,
    fc_inflight: FxSet<String>,
    fc_log: FxMap<String, IndexMap<i64, Vec<Pt>, FxBuild>>,
    obs: FxMap<String, Obs>,
    hist_hour: FxMap<String, i64>,
    hist_inflight: FxSet<String>,
    bias_cache: FxMap<String, Bias>,
    /// corrected forecast per area: (hour start, values, version) — a pure function of the area's
    /// published forecast, its bias and the hour, so it is reused until one of them changes
    fc_view: FxMap<String, FcView>,
    fc_ver: u64,
    in_create: IndexMap<String, InCreate>,
    in_vm: FxMap<String, &'static str>,
    overrides: FxMap<String, Override>,
    last_toggle: FxMap<String, f64>,
    lat_status: Option<f64>,
    lat_cloud: Option<f64>,
    tracker: Tracker,
    memo: FxMap<String, Memo>,
    adopting: FxSet<String>,
    last_hour_logged: i64,
    fin: Option<Finalize>,
    next_id: u64,
    conts: FxMap<u64, Cont>,
    /// calls to execute and timers to arm, in issue order
    pub outbox: Vec<Out>,
    timer_conts: FxMap<u64, TimerKind>,
    // fresh vintages
    fc_ask: FxMap<String, f64>,
    fc_try: FxMap<String, (i64, u32)>,
    hist_try: FxMap<String, (i64, u32, f64)>,
    hist_newest: FxMap<String, i64>,
    hist_lag: Option<i64>,
    /// bumped whenever new forecast or observation data arrives
    data_ver: u64,
    toggle_ver: FxMap<String, u64>,
    // robust latency + stall guard
    lat_recent_status: Vec<f64>,
    lat_recent_cloud: Vec<f64>,
    status_open: Vec<f64>,
    last_slow: Option<f64>,
    // loop timing: `this.wake` is set while the loop sleeps; a debounced wake-up cuts the sleep short
    wake_pending: bool,
    loop_sleeping: bool,
    /// generation of the loop's current sleep (a sleep cut short leaves a stale timer behind)
    pub loop_gen: u64,
    last_loop_wall: Option<f64>,
    freeze_at: Option<f64>,
    /// failed decision steps in a row (the driver counts them; safe mode starts stopped work)
    pub step_errors: u32,
    log: Option<LogFn>,
    event: Option<EventFn>,
}

impl Core {
    pub fn new(cat: Catalog, st: RunState, run: &str, o: ControlOpts) -> Core {
        let policy = Policy::new(&cat);
        let areas = cat.areas();
        let deleted: IndexSet<String> = st.deleted.iter().cloned().collect();
        let prefix = format!("go2-{}-", run.chars().take(8).collect::<String>());
        Core {
            cat,
            o,
            st,
            run: run.to_string(),
            stats: Stats::default(),
            done: false,
            finalizing: false,
            snap: None,
            dirty: false,
            policy,
            areas,
            prefix,
            deleted,
            status_inflight: 0,
            last_status_start: -1e15,
            fc: FxMap::default(),
            fc_inflight: FxSet::default(),
            fc_log: FxMap::default(),
            obs: FxMap::default(),
            hist_hour: FxMap::default(),
            hist_inflight: FxSet::default(),
            bias_cache: FxMap::default(),
            fc_view: FxMap::default(),
            fc_ver: 0,
            in_create: IndexMap::new(),
            in_vm: FxMap::default(),
            overrides: FxMap::default(),
            last_toggle: FxMap::default(),
            lat_status: None,
            lat_cloud: None,
            tracker: Tracker::default(),
            memo: FxMap::default(),
            adopting: FxSet::default(),
            last_hour_logged: -1,
            fin: None,
            next_id: 0,
            conts: FxMap::default(),
            outbox: Vec::new(),
            timer_conts: FxMap::default(),
            fc_ask: FxMap::default(),
            fc_try: FxMap::default(),
            hist_try: FxMap::default(),
            hist_newest: FxMap::default(),
            hist_lag: None,
            data_ver: 0,
            toggle_ver: FxMap::default(),
            lat_recent_status: Vec::new(),
            lat_recent_cloud: Vec::new(),
            status_open: Vec::new(),
            last_slow: None,
            wake_pending: false,
            loop_sleeping: false,
            loop_gen: 0,
            last_loop_wall: None,
            freeze_at: None,
            step_errors: 0,
            log: None,
            event: None,
        }
    }

    /// Policy experiment overrides (`--opt`); empty = the JS defaults.
    pub fn set_policy_tweaks(&mut self, tw: crate::tweaks::Tweaks) {
        self.policy.tweaks = tw;
    }

    pub fn set_log(&mut self, f: LogFn) {
        self.log = Some(f);
    }
    pub fn set_event(&mut self, f: EventFn) {
        self.event = Some(f);
    }
    pub fn vm_name_prefix(&self) -> &str {
        &self.prefix
    }
    pub fn has_forecasts(&self) -> bool {
        self.areas.iter().all(|a| self.fc.contains_key(a))
    }

    fn log(&mut self, msg: impl FnOnce() -> String) {
        if let Some(l) = self.log.as_mut() {
            l(&msg());
        }
    }

    fn event(&mut self, now: f64, f: impl FnOnce() -> Value) {
        if self.event.is_none() {
            return;
        }
        let mut v = f();
        let wall = crate::model::iso_from_ms(now);
        if let Value::Object(m) = &mut v {
            let mut o = serde_json::Map::new();
            o.insert("wall".into(), Value::String(wall));
            o.extend(std::mem::take(m));
            *m = o;
        }
        if let Some(e) = self.event.as_mut() {
            e(v);
        }
    }

    fn call(&mut self, c: Call, k: Cont) {
        self.next_id += 1;
        self.conts.insert(self.next_id, k);
        self.outbox.push(Out::Call(self.next_id, c));
    }

    fn timer(&mut self, kind: TimerKind, ms: f64) {
        self.next_id += 1;
        self.timer_conts.insert(self.next_id, kind);
        self.outbox.push(Out::Timer(self.next_id, ms));
    }

    /// New data arrived: run the next decision soon (debounced, so the hour's burst of replies triggers one step).
    fn wake_up(&mut self) {
        if !self.o.wake_on_data || self.wake_pending {
            return;
        }
        self.wake_pending = true;
        self.timer(TimerKind::Wake, self.o.wake_debounce_ms);
    }

    fn lat_sample(&mut self, cloud: bool, ms: f64, now: f64) {
        let a = if cloud { &mut self.lat_recent_cloud } else { &mut self.lat_recent_status };
        a.push(ms);
        if a.len() > 15 {
            a.remove(0);
        }
        if ms > self.o.stall_trigger_ms {
            self.last_slow = Some(now);
        }
    }

    /// Wall seconds of deadline cushion a paused job needs now: more while the server shows stress.
    pub fn stall_s(&self, now: f64) -> f64 {
        let open = self.status_open.iter().any(|t0| now - t0 > self.o.stall_trigger_ms);
        if open || now - self.last_slow.unwrap_or(-1e15) < self.o.stall_memory_s * 1000.0 {
            self.o.stall_buffer_s
        } else {
            self.o.stall_base_s
        }
    }

    /// Wall ms until the action time or the server clock reaches its next hour (infinite unless running).
    fn ms_to_boundary(&self, now: f64) -> f64 {
        let Some(s) = self.snap.as_ref() else { return f64::INFINITY };
        if s.state != "RUNNING" {
            return f64::INFINITY;
        }
        let t_now = self.t_now(now).unwrap();
        let t_act = t_now + self.lat_h();
        let dh = jmin((t_act + 1e-9).ceil() - t_act, (t_now + 1e-9).ceil() - t_now);
        (dh * H) / s.speed
    }

    fn save(&mut self) {
        self.dirty = true;
    }

    // ---------- background I/O ----------

    pub fn poll_status(&mut self, now: f64) {
        if self.status_inflight >= self.o.status_concurrency || now - self.last_status_start < self.o.status_gap_ms {
            return;
        }
        self.status_inflight += 1;
        self.last_status_start = now;
        self.status_open.push(now);
        self.call(Call::Status, Cont::Status { t0: now });
    }

    /// freshFc: the server issues one vintage per hour, and `hour` (the action time) runs ahead of the
    /// server clock by the API latency — re-fetch while the held vintage is older than the server's hour.
    pub fn refresh_forecasts(&mut self, hour: i64, now: f64) {
        let srv_hour = self.t_now(now).map(|t| t.floor() as i64).unwrap_or(hour);
        for a in self.areas.clone() {
            if self.fc_inflight.contains(&a) {
                continue;
            }
            let tr = self.fc_try.get(&a).copied();
            let skip = if self.o.fresh_fc {
                match self.fc.get(&a) {
                    None => false,
                    Some(held) => {
                        // (at most 4 asks per area per server hour)
                        !(held.vh < srv_hour
                            && now - self.fc_ask.get(&a).copied().unwrap_or(-1e15) >= self.o.fc_retry_ms
                            && !tr.is_some_and(|(h, n)| h == srv_hour && n >= 4))
                    }
                }
            } else {
                self.fc.get(&a).map(|c| c.hour) == Some(hour)
            };
            if skip {
                continue;
            }
            self.fc_ask.insert(a.clone(), now);
            let n = match tr {
                Some((h, n)) if h == srv_hour => n + 1,
                _ => 1,
            };
            self.fc_try.insert(a.clone(), (srv_hour, n));
            self.fc_inflight.insert(a.clone());
            self.call(Call::Forecast { area: a.clone() }, Cont::Forecast { area: a, hour });
        }
    }

    /// Published observations (this run only), fetched once per simulated hour per area.
    pub fn refresh_history(&mut self, hour: i64, now: f64) {
        if !self.o.learn_bias {
            return;
        }
        for a in self.areas.clone() {
            if self.hist_inflight.contains(&a) {
                continue;
            }
            let m = self.hist_try.get(&a).copied();
            if self.hist_hour.get(&a) == Some(&hour) {
                // freshFc: a fetch that reached the server just before its hour turned misses this hour's newest
                // point; re-ask (spaced, at most 3 times an hour) while it is older than this run's publication lag
                let Some(lag) = self.hist_lag else { continue };
                if !self.o.fresh_fc
                    || !(self.hist_newest.get(&a).map(|x| *x as f64).unwrap_or(f64::NEG_INFINITY) < (hour - lag) as f64)
                    || m.is_some_and(|(h, n, ask)| h == hour && (n >= 3 || now - ask < self.o.fc_retry_ms))
                {
                    continue;
                }
            }
            let n = match m {
                Some((h, n, _)) if h == hour => n + 1,
                _ => 1,
            };
            self.hist_try.insert(a.clone(), (hour, n, now));
            self.hist_inflight.insert(a.clone());
            self.call(Call::History { area: a.clone() }, Cont::History { area: a, hour });
        }
    }

    /// Mean relative forecast error per lead hour for an area (forecast / observed - 1), shrunk and
    /// capped, plus the persistent-miss nowcast. Pure function of this run's data (cached until new data).
    fn bias_for(&mut self, area: &str) -> Bias {
        if let Some(b) = self.bias_cache.get(area) {
            return b.clone();
        }
        let mut sum = [0.0f64; 25];
        let mut cnt = [0.0f64; 25];
        let t0 = self.cat.t0;
        let sh = 0.0 * H; // obsShiftH: 0 — an observation stamped h describes hour h
        if let (Some(obs), Some(log)) = (self.obs.get(area), self.fc_log.get(area)) {
            for (h0, pts) in log {
                for p in pts {
                    let Some(o) = obs.get(p.t + sh) else { continue };
                    if !(o > 0.0) {
                        continue;
                    }
                    let lead = jsmath::round((p.t - (t0 + *h0 as f64 * H)) / H);
                    if !(0.0..=24.0).contains(&lead) {
                        continue;
                    }
                    sum[lead as usize] += p.v / o - 1.0;
                    cnt[lead as usize] += 1.0;
                }
            }
        }
        let cap = self.o.bias_cap;
        let mut b = [0.0f64; 25];
        for i in 0..25 {
            b[i] = jmax(-cap, jmin(cap, sum[i] / (cnt[i] + self.o.bias_shrink_n)));
        }
        let anom = if self.o.nowcast { self.anomaly_for(area, &b) } else { None };
        let out = Bias { b, anom };
        self.bias_cache.insert(area.to_string(), out.clone());
        out
    }

    /// The latest observed lead-0 miss beyond the learned bias, and how strongly misses persist from
    /// one hour to the next in this run (lag-1 autocorrelation). None while they don't persist.
    fn anomaly_for(&self, area: &str, b: &[f64; 25]) -> Option<Anom> {
        let log = self.fc_log.get(area)?;
        let obs = self.obs.get(area)?;
        let sh = 0.0 * H;
        let mut a: IndexMap<i64, f64, FxBuild> = IndexMap::default();
        for (h0, pts) in log {
            let Some(p) = pts.first() else { continue };
            if p.t != self.cat.t0 + *h0 as f64 * H {
                continue;
            }
            if let Some(o) = obs.get(p.t + sh) {
                if o > 0.0 {
                    a.insert(*h0, p.v / o - 1.0 - b[0]);
                }
            }
        }
        let (mut sxy, mut sxx, mut n, mut last) = (0.0f64, 0.0f64, 0.0f64, f64::NEG_INFINITY);
        for (h0, x) in &a {
            if (*h0 as f64) > last {
                last = *h0 as f64;
            }
            if let Some(y) = a.get(&(h0 + 1)) {
                sxy += x * y;
                sxx += x * x;
                n += 1.0;
            }
        }
        if n < self.o.nowcast_min_n || !(sxx > 0.0) {
            return None;
        }
        let rho = jmin(0.95, sxy / sxx);
        if rho >= self.o.nowcast_min_rho { Some(Anom { rho, a0: a[&(last as i64)], t0: last }) } else { None }
    }

    /// Simulated hours "now", extrapolated from the freshest snapshot.
    pub fn t_now(&self, now: f64) -> Option<f64> {
        let s = self.snap.as_ref()?;
        if s.state != "RUNNING" {
            return Some(s.t);
        }
        // at most max_extrap_ms past the freshest reply, so a local clock jump or a long freeze can't run the
        // estimate ahead of the server
        Some(s.t + (jmax(0.0, jmin(now - s.wall_at, self.o.max_extrap_ms)) * s.speed) / H)
    }

    pub fn lat_h(&self) -> f64 {
        // latRobust: plan with the median of the last 15 calls — one stalled reply otherwise lifted the EWMA to
        // hours of "latency", switched off every low-lag setting and inflated all margins
        let med = |a: &Vec<f64>| -> Option<f64> {
            if a.is_empty() {
                return None;
            }
            let mut s = a.clone();
            crate::model::sort_num(&mut s);
            Some(s[s.len() / 2])
        };
        let ms = if self.o.lat_robust {
            med(&self.lat_recent_cloud).or_else(|| med(&self.lat_recent_status)).unwrap_or(1000.0)
        } else {
            self.lat_cloud.or(self.lat_status).unwrap_or(1000.0)
        };
        let speed = self.snap.as_ref().map(|s| s.speed).unwrap_or(720.0);
        jmin(self.o.max_lat_h, (ms * speed) / H)
    }

    // ---------- view with in-flight overlay ----------

    fn view(&mut self, t_act: f64) -> View {
        let snap = self.snap.as_ref().unwrap();
        let lat_status = self.lat_status.unwrap_or(0.0);
        // an acknowledged stop/start wins until a snapshot taken after the ack shows the VM
        for w in &snap.s.workloads {
            for a in &w.assignments {
                if self.deleted.contains(&a.vm_id) {
                    continue;
                }
                if let Some(ov) = self.overrides.get(&a.vm_id) {
                    if !(snap.wall_at < ov.wall_ack + lat_status / 2.0) {
                        self.overrides.remove(&a.vm_id);
                    }
                }
            }
        }
        let mut receipt: Vec<ReceiptRow> = self
            .st
            .vms
            .iter()
            .map(|(id, r)| ReceiptRow { id: id.clone(), wl: r.wl.clone(), zone: r.zone.clone(), prof: r.prof.clone(), adopted: r.adopted })
            .collect();
        // in-flight creates count as VMs (quota, and so the policy doesn't create them twice)
        for (wl, c) in &self.in_create {
            for i in 0..c.left {
                let id = format!("pending-{wl}-{i}");
                if let Some(pos) = receipt.iter().position(|r| r.id == id) {
                    receipt.remove(pos);
                }
                receipt.push(ReceiptRow { id, wl: wl.clone(), zone: c.zone.clone(), prof: c.prof.clone(), adopted: false });
            }
        }
        let deleted = &self.deleted;
        let overrides = &self.overrides;
        let overlay = |vm_id: &str, raw: &str| -> Option<String> {
            if deleted.contains(vm_id) {
                return None;
            }
            Some(overrides.get(vm_id).map(|o| o.state).unwrap_or(raw).to_string())
        };
        // rawTracker: rate samples use the engine's own VM states, not the acknowledged-action overlay
        let raw: Option<FxMap<String, String>> = if self.o.raw_tracker {
            Some(snap.s.workloads.iter().flat_map(|w| w.assignments.iter().map(|a| (a.vm_id.clone(), a.state.clone()))).collect())
        } else {
            None
        };
        let mut v = build_view(&self.cat, &snap.s, &overlay, &receipt, &mut self.tracker, raw.as_ref());
        v.t_snap = Some(v.t); // the server's own time at this snapshot
        v.t = t_act;
        let now_hour = t_act.floor();
        let hour_start = self.cat.t0 + now_hour * H;
        let areas = self.areas.clone();
        let place_on = self.o.place_vintages > 1.0 && self.o.learn_bias;
        let (mut fc, mut ver, mut place, mut place_ver) = (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        for a in &areas {
            let hit = self.fc_view.get(a).filter(|c| c.hour_start == hour_start).cloned();
            let e = match hit {
                Some(e) => e,
                None => {
                    let arr = self.fc_for(a, hour_start).map(std::sync::Arc::new);
                    let pl = if place_on { self.fc_place_for(a, hour_start, arr.as_deref()).map(std::sync::Arc::new) } else { None };
                    let mut e = FcView { hour_start, fc: arr, ver: 0, place: pl, place_ver: 0 };
                    if e.fc.is_some() {
                        self.fc_ver += 1;
                        e.ver = self.fc_ver;
                    }
                    if e.place.is_some() {
                        self.fc_ver += 1;
                        e.place_ver = self.fc_ver;
                    }
                    self.fc_view.insert(a.clone(), e.clone());
                    e
                }
            };
            fc.push(e.fc);
            ver.push(e.ver);
            place.push(e.place);
            place_ver.push(e.place_ver);
        }
        v.fc = fc;
        v.fc_ver = ver;
        if place_on {
            v.fc_place = Some(place);
            v.fc_place_ver = place_ver;
        }
        v
    }

    /// The corrected value of a point from the vintage issued at hour vh (its lead decides the bias applied).
    fn corrected(&self, b: &Option<Bias>, vh: i64, p: &Pt) -> f64 {
        let Some(b) = b else { return p.v };
        let cap = 2.0 * self.o.bias_cap;
        let tau = (p.t - self.cat.t0) / H;
        let ix = jmax(0.0, jmin(24.0, jsmath::round(tau - vh as f64)));
        let mut e = if ix.is_nan() { f64::NAN } else { b.b[ix as usize] };
        if let Some(an) = &b.anom {
            e += an.a0 * jsmath::pow(an.rho, jmax(0.0, tau - an.t0));
        }
        p.v / (1.0 + jmax(-cap, jmin(cap, e)))
    }

    /// `v.fcPlace(area)`: each hour is the mean of the newest `placeVintages` vintages that cover it, so one
    /// vintage's level error can't decide a long job's zone.
    fn fc_place_for(&mut self, area: &str, hour_start: f64, fc_now: Option<&Vec<f64>>) -> Option<Vec<f64>> {
        let c = self.fc.get(area)?.clone();
        let pts: Vec<&Pt> = c.pts.iter().filter(|p| p.t >= hour_start).collect();
        if !self.fc_log.contains_key(area) || pts.is_empty() {
            return fc_now.cloned();
        }
        let b = Some(self.bias_for(area));
        let newest = c.vh;
        let log = self.fc_log.get(area).unwrap();
        let mut hs: Vec<i64> = log.keys().copied().filter(|h| *h <= newest).collect();
        hs.sort_by(|a, b| b.cmp(a));
        hs.truncate(self.o.place_vintages as usize);
        let vin: Vec<(FxMap<i64, Pt>, i64)> = hs.iter().map(|h| (log[h].iter().map(|p| (p.t as i64, p.clone())).collect(), *h)).collect();
        Some(
            pts.iter()
                .map(|p| {
                    let (mut sum, mut n) = (0.0f64, 0.0f64);
                    for (m, h) in &vin {
                        if let Some(q) = m.get(&(p.t as i64)) {
                            sum += self.corrected(&b, *h, q);
                            n += 1.0;
                        }
                    }
                    if n > 0.0 { sum / n } else { self.corrected(&b, newest, p) }
                })
                .collect(),
        )
    }

    /// `v.fc(area)`: the published forecast from the current hour on, corrected by this run's learned
    /// per-lead bias and the persistent-miss nowcast.
    fn fc_for(&mut self, area: &str, hour_start: f64) -> Option<Vec<f64>> {
        let c = self.fc.get(area)?.clone();
        let b = if self.o.learn_bias { Some(self.bias_for(area)) } else { None };
        let arr: Vec<f64> = c.pts.iter().filter(|p| p.t >= hour_start).map(|p| self.corrected(&b, c.vh, p)).collect();
        if !arr.is_empty() { Some(arr) } else { Some(vec![self.corrected(&b, c.vh, c.pts.last().unwrap())]) }
    }

    // ---------- actions ----------

    fn fire_create(&mut self, a: &Action, t_act: f64, now: f64) {
        let ActKind::Create { zone, prof, k } = &a.kind else { return };
        let legal = match (self.cat.workload(&a.wl), self.cat.zone(zone), self.cat.profile(prof)) {
            (Some(w), Some(z), Some(p)) => zone_legal(w, z) && profile_legal(w, p) && p.offered_in(zone),
            _ => false,
        };
        // Residency double-check right before the API call: one illegal attempt disqualifies the run.
        if !legal {
            self.log(|| format!("[BLOCKED] illegal create {}@{} {}", a.wl, zone, prof));
            return;
        }
        if self.in_create.contains_key(&a.wl) {
            return;
        }
        let kk = *k as u32;
        self.in_create.insert(a.wl.clone(), InCreate { zone: zone.clone(), prof: prof.clone(), left: kk });
        let label = self.cat.profile(prof).unwrap().label.clone();
        for _ in 0..kk {
            self.st.seq += 1;
            let name = format!("{}{}-{}", self.prefix, a.wl, self.st.seq);
            self.save();
            let t_now0 = self.t_now(now).unwrap_or(t_act);
            self.event(now, || json!({ "k": "act", "type": "create", "wl": a.wl, "zone": zone, "prof": label, "nowH": fmt3(t_now0), "landH": fmt3(t_act), "why": a.why }));
            self.call(
                Call::Create { zone: zone.clone(), prof: prof.clone(), name: name.clone(), wl: a.wl.clone() },
                Cont::Create { wl: a.wl.clone(), zone: zone.clone(), prof: prof.clone(), name, t_act, t_now0, t0: now, why: a.why.clone() },
            );
        }
    }

    fn fire_vm(&mut self, a: &Action, t_act: f64, now: f64) {
        let vm = a.vm.as_ref().unwrap();
        let id = vm.id.clone();
        if self.in_vm.contains_key(&id) || id.starts_with("pending-") {
            return;
        }
        if a.kind == ActKind::Stop {
            // starting is the deadline-safe direction, so only stops are rate-limited
            // (infoDwell: a start decided before the newest data arrived may be undone at once)
            if let Some(&last) = self.last_toggle.get(&id) {
                let newer_data = self.o.info_dwell && self.toggle_ver.get(&id).is_some_and(|v| self.data_ver > *v);
                if t_act - last < self.o.min_dwell_h && !newer_data {
                    return;
                }
            }
        }
        let zone = vm.zone.clone().or_else(|| self.st.vms.get(&id).map(|r| r.zone.clone()));
        let verb = a.verb();
        self.in_vm.insert(id.clone(), verb);
        let t_now0 = self.t_now(now).unwrap_or(t_act);
        self.event(
            now,
            || json!({ "k": "act", "type": verb, "wl": a.wl, "vm": id, "nowH": fmt3(t_now0), "landH": fmt3(t_act), "why": a.why }),
        );
        let (delete, v) = match a.kind {
            ActKind::Delete => (true, None),
            ActKind::Stop => (false, Some(Verb::Stop)),
            _ => (false, Some(Verb::Start)),
        };
        let cont =
            Cont::Vm { delete, verb: v, wl: a.wl.clone(), id: id.clone(), t_act, t_now0, t0: now, why: a.why.clone(), ver0: self.data_ver };
        match v {
            None => self.call(Call::Remove { zone, id }, cont),
            Some(verb) => self.call(Call::VmAction { zone, id, verb }, cont),
        }
    }

    /// Delete every VM in the receipt, then sweep orphans carrying this controller's name prefix.
    pub fn start_finalize(&mut self, reason: &str, now: f64) {
        if self.finalizing {
            return;
        }
        self.finalizing = true;
        let n = self.st.vms.len();
        self.event(now, || json!({ "k": "final", "reason": reason, "vms": n }));
        self.log(|| format!("[final] {reason}: deleting {n} VM(s)"));
        let rows: Vec<(String, String)> = self.st.vms.iter().map(|(id, r)| (id.clone(), r.zone.clone())).collect();
        self.fin = Some(Finalize { pending_removes: rows.len(), ..Default::default() });
        for (id, zone) in &rows {
            self.call(Call::Remove { zone: Some(zone.clone()), id: id.clone() }, Cont::FinalRemove { id: id.clone() });
        }
        if rows.is_empty() {
            self.finalize_sweep();
        }
    }

    fn finalize_sweep(&mut self) {
        self.st.deleted = self.deleted.iter().cloned().collect();
        self.save();
        let zones: Vec<String> = self.cat.zones.iter().map(|z| z.slug.clone()).collect();
        if let Some(f) = self.fin.as_mut() {
            f.zones_pending = zones.len();
        }
        for z in &zones {
            self.call(Call::ListInstances { zone: z.clone() }, Cont::FinalList { zone: z.clone() });
        }
        if zones.is_empty() {
            self.done = true;
        }
    }

    fn finalize_zone_done(&mut self) {
        let f = self.fin.as_mut().unwrap();
        f.zones_pending -= 1;
        if f.zones_pending == 0 {
            self.done = true;
        }
    }

    /// VMs bound to workloads that this controller didn't create (e.g. left by the starter demo):
    /// look up their real instance type so quota, timing and gating are planned exactly.
    fn adopt_foreign(&mut self) {
        let Some(snap) = self.snap.as_ref() else { return };
        let mut todo: Vec<(String, Option<String>, String)> = Vec::new();
        for w in &snap.s.workloads {
            for a in &w.assignments {
                let id = &a.vm_id;
                // a create of ours may have landed before its reply arrived: never treat that VM as foreign
                if self.st.vms.contains_key(id)
                    || self.deleted.contains(id)
                    || self.adopting.contains(id)
                    || self.in_create.contains_key(&w.id)
                {
                    continue;
                }
                if todo.iter().any(|(_, _, i)| i == id) {
                    continue;
                }
                todo.push((w.id.clone(), a.zone.clone(), id.clone()));
            }
        }
        for (wl, zone, id) in todo {
            self.adopting.insert(id.clone());
            self.call(Call::GetInstance { zone: zone.clone(), id: id.clone() }, Cont::Adopt { wl, zone, id });
        }
    }

    // ---------- entry points ----------

    /// One iteration of `runLoop`: poll, then decide.
    pub fn loop_tick(&mut self, now: f64) -> Tick {
        // (the previous sleep is over: `this.wake = null`)
        self.loop_sleeping = false;
        if self.done {
            return Tick::Done;
        }
        // a loop iteration that took far longer than planned means this process was frozen: act again only
        // on a status reply requested after the freeze
        if let Some(last) = self.last_loop_wall {
            if now - last > self.o.freeze_ms {
                self.freeze_at = Some(now);
                let gap = (now - last) / 1000.0;
                self.log(|| format!("[freeze] no loop for {gap:.1} s — waiting for a fresh status before acting"));
            }
        }
        self.last_loop_wall = Some(now);
        self.poll_status(now);
        let frozen = matches!((self.freeze_at, self.snap.as_ref()), (Some(f), Some(s)) if s.req_at < f);
        if self.snap.is_some() && !self.finalizing && !frozen {
            self.step(now);
        }
        if self.done {
            return Tick::Done;
        }
        if self.finalizing {
            return Tick::Wait;
        }
        // alignBoundary: sleep only until the next hour boundary (at 720x a 250 ms loop is 0.05 sim h)
        let ms = if self.o.align_boundary { jmax(2.0, jmin(self.o.loop_ms, self.ms_to_boundary(now) + 2.0)) } else { self.o.loop_ms };
        self.loop_gen += 1;
        self.loop_sleeping = self.o.wake_on_data;
        Tick::Next(ms)
    }

    /// One decision step (`step()` in controller.mjs).
    pub fn step(&mut self, now: f64) {
        let (qual, state, all_delivered) = {
            let s = self.snap.as_ref().unwrap();
            (s.s.qualification.clone(), s.state.clone(), !s.s.workloads.is_empty() && s.s.workloads.iter().all(|w| w.delivered))
        };
        if qual == "DISQUALIFIED" {
            self.log(|| "[fatal] run DISQUALIFIED".into());
            return self.start_finalize("disqualified", now);
        }
        if matches!(state.as_str(), "COMPLETED" | "INVALIDATED" | "UNAVAILABLE") {
            return self.start_finalize(&format!("run {state}"), now);
        }
        if state == "PAUSED" {
            return;
        }
        if all_delivered {
            return self.start_finalize("all delivered", now);
        }
        self.adopt_foreign();
        let t_now = self.t_now(now).unwrap();
        let lat_h = if state == "RUNNING" { self.lat_h() } else { 0.0 };
        let t_act = t_now + lat_h;
        self.refresh_forecasts(t_act.floor() as i64, now);
        self.refresh_history(t_now.floor() as i64, now);
        if !self.has_forecasts() {
            return; // wait for the first forecast fill
        }
        let v = self.view(t_act);
        let hour = t_now.floor() as i64;
        if hour != self.last_hour_logged && self.log.is_some() {
            self.last_hour_logged = hour;
            let snap_t = self.snap.as_ref().unwrap().t;
            let all: Vec<&crate::policy::VmView> = v.jobs.iter().flat_map(|j| j.vms.iter()).collect();
            let msg = format!(
                "[t≈{:.1}h snap={:.1}h lat≈{:.2}h] {} delivered {}/{} vms={} run={} stop={} cores={}",
                t_now,
                snap_t,
                lat_h,
                state,
                v.jobs.iter().filter(|j| j.delivered).count(),
                v.jobs.len(),
                v.usage.vms,
                all.iter().filter(|x| x.state == "running").count(),
                all.iter().filter(|x| x.state == "stopped").count(),
                v.usage.cores
            );
            self.log(|| msg);
        } else if hour != self.last_hour_logged {
            self.last_hour_logged = hour;
        }
        let margin = self.o.base_margin_h + self.o.latency_margin_x * lat_h;
        let speed = self.snap.as_ref().map(|s| s.speed).unwrap_or(720.0);
        let stall_h = (self.stall_s(now) * (if speed == 0.0 || speed.is_nan() { 720.0 } else { speed })) / 3600.0;
        let acts = self.policy.decide(&self.cat, &v, &mut self.memo, margin, lat_h, stall_h);
        for a in &acts {
            if matches!(a.kind, ActKind::Create { .. }) {
                self.fire_create(a, t_act, now);
            } else {
                self.fire_vm(a, t_act, now);
            }
        }
    }

    /// Safe mode (decisions keep failing): start every stopped VM of unfinished work, delete delivered work's VMs.
    pub fn safe_mode(&mut self, now: f64) {
        let Some(snap) = self.snap.clone() else { return };
        let t = self.t_now(now).unwrap_or(0.0);
        let mut n = 0;
        for w in &snap.s.workloads {
            for a in &w.assignments {
                if self.deleted.contains(&a.vm_id) {
                    continue;
                }
                let vm =
                    crate::policy::VmView { id: a.vm_id.clone(), zone: a.zone.clone(), prof: None, state: a.state.clone(), adopted: false };
                if w.delivered {
                    let act = Action { kind: ActKind::Delete, wl: w.id.clone(), vm: Some(vm), why: "safe mode: delivered".into() };
                    self.fire_vm(&act, t, now);
                } else if a.state == "stopped" {
                    let act = Action { kind: ActKind::Start, wl: w.id.clone(), vm: Some(vm), why: "safe mode: decisions failing".into() };
                    self.fire_vm(&act, t, now);
                    n += 1;
                }
            }
        }
        if n > 0 {
            let e = self.step_errors;
            self.log(|| format!("[safe] {e} failed steps in a row: starting {n} stopped VM(s)"));
        }
    }

    /// A timer fired. Returns true when the loop's sleep is cut short: the driver runs `loop_tick` now
    /// (a wake-up after new data), and the sleep's own timer is then stale (`loop_gen` moved on).
    pub fn on_timer(&mut self, token: u64) -> bool {
        match self.timer_conts.remove(&token) {
            Some(TimerKind::Adopt(id)) => {
                self.adopting.remove(&id);
                false
            }
            Some(TimerKind::Wake) => {
                self.wake_pending = false;
                if self.loop_sleeping {
                    self.loop_sleeping = false;
                    true
                } else {
                    false
                }
            }
            None => false,
        }
    }

    fn retry_adopt_later(&mut self, id: String) {
        self.timer(TimerKind::Adopt(id), 5000.0);
    }

    /// A call returned.
    pub fn on_reply(&mut self, id: u64, reply: Reply, now: f64) {
        let Some(cont) = self.conts.remove(&id) else { return };
        match cont {
            Cont::Status { t0 } => {
                let t1 = now;
                self.lat_status = Some(ewma(self.lat_status, t1 - t0));
                self.lat_sample(false, t1 - t0, now);
                if let Reply::Status(Some(s)) = reply {
                    if let Some(vt) = s.virtual_time_ms {
                        let speed = if s.speed.is_nan() || s.speed == 0.0 { 720.0 } else { s.speed };
                        let state = s.state.to_uppercase();
                        let delivered = s.workloads.iter().filter(|w| w.delivered).count();
                        let snap =
                            Snap { vt, t: (vt - self.cat.t0) / H, wall_at: (t0 + t1) / 2.0, req_at: t0, speed, state: state.clone(), s };
                        // freshest wins; READY/PAUSED replies don't advance vt, so prefer the later reply then
                        let take = match &self.snap {
                            None => true,
                            Some(cur) => snap.vt > cur.vt || (snap.vt == cur.vt && snap.wall_at >= cur.wall_at),
                        };
                        let snap_h = snap.t;
                        if take {
                            self.snap = Some(snap);
                        }
                        self.event(now, || json!({ "k": "status", "latMs": (t1 - t0).round(), "snapH": fmt3(snap_h), "state": state, "delivered": delivered }));
                    }
                }
                self.status_inflight -= 1;
                if let Some(i) = self.status_open.iter().position(|x| *x == t0) {
                    self.status_open.remove(i);
                }
            }
            Cont::Forecast { area, hour } => {
                if let Reply::Points(Some(pts)) = reply {
                    if !pts.is_empty() {
                        // vh: the hour the returned vintage starts at (can be hour-1 when asked just past a boundary)
                        let vh = jsmath::round((pts[0].t - self.cat.t0) / H) as i64;
                        let n = pts.len();
                        let newer = self.fc.get(&area).is_none_or(|c| c.vh < vh);
                        if self.o.learn_bias {
                            // (the trace keeps vintage timing only, no grid values: every run shares one
                            // scenario grid, so a kept series would be a view of the next run's future)
                            self.event(now, || json!({ "k": "fc", "area": area, "hour": hour, "vh": vh, "n": n }));
                            let log = self.fc_log.entry(area.clone()).or_default();
                            log.insert(vh, pts.clone());
                            log.retain(|h, _| *h >= hour - 72);
                            // new evidence → recompute corrections (JS drops every area's cache; the cache
                            // is a pure function of each area's own data, so dropping this area's is the same)
                            self.bias_cache.remove(&area);
                            self.data_ver += 1;
                        }
                        self.fc.insert(area.clone(), FcEntry { hour, vh, pts });
                        self.fc_view.remove(&area);
                        if newer {
                            self.wake_up();
                        }
                    }
                }
                self.fc_inflight.remove(&area);
            }
            Cont::History { area, hour } => {
                if let Reply::Points(Some(pts)) = reply {
                    if !pts.is_empty() {
                        let t0 = self.cat.t0;
                        let m = self.obs.entry(area.clone()).or_insert_with(|| Obs { t0, ..Default::default() });
                        for p in &pts {
                            m.set(p.t, p.v);
                        }
                        self.hist_hour.insert(area.clone(), hour);
                        self.bias_cache.remove(&area);
                        self.fc_view.remove(&area);
                        self.data_ver += 1;
                        let newest = pts.iter().map(|p| p.t).fold(f64::NEG_INFINITY, crate::model::jmax);
                        let newest_h = jsmath::round((newest - self.cat.t0) / H) as i64;
                        if self.hist_newest.get(&area).is_none_or(|x| *x < newest_h) {
                            self.wake_up();
                        }
                        let prev = self.hist_newest.get(&area).copied().unwrap_or(i64::MIN);
                        self.hist_newest.insert(area.clone(), prev.max(newest_h));
                        if self.snap.as_ref().is_some_and(|s| s.state == "RUNNING") {
                            let lag = 0i64.max(self.t_now(now).unwrap().floor() as i64 - newest_h);
                            self.hist_lag = Some(self.hist_lag.map_or(lag, |l| l.min(lag)));
                        }
                        if self.event.is_some() {
                            // publication lag as seen by this run (hours between now and the newest published hour)
                            let newest = pts.iter().map(|p| p.t).fold(f64::NEG_INFINITY, f64::max);
                            let n = self.obs.get(&area).map(|m| m.n).unwrap_or(0);
                            let bb = self.bias_for(&area);
                            let t0 = self.cat.t0;
                            self.event(now, || {
                                json!({ "k": "hist", "area": area, "hour": hour, "sh": 0, "lagH": fmt3(hour as f64 - (newest - t0) / H), "n": n, "b0": fmt3(bb.b[0]), "b12": fmt3(bb.b[12]),
                                        "anom": bb.anom.as_ref().map(|a| json!({ "rho": (a.rho * 100.0).round() / 100.0, "a0": fmt3(a.a0), "t0": a.t0 })) })
                            });
                        }
                    }
                }
                self.hist_inflight.remove(&area);
            }
            Cont::Create { wl, zone, prof, name, t_act, t_now0, t0, why } => {
                self.lat_cloud = Some(ewma(self.lat_cloud, now - t0));
                self.lat_sample(true, now - t0, now);
                let Reply::Create(r) = reply else {
                    return self.create_done(None, "bad reply".into(), &wl, &zone, &prof, &name, t_act, t_now0, t0, &why, now);
                };
                if r.id.is_none() && r.ambiguous {
                    // an ambiguous create is resolved by looking the name up (never blindly retried)
                    return self.call(
                        Call::FindByName { zone: zone.clone(), name: name.clone() },
                        Cont::CreateFind { wl, zone, prof, name, t_act, t_now0, t0, why, err: r.error },
                    );
                }
                self.create_done(r.id, r.error, &wl, &zone, &prof, &name, t_act, t_now0, t0, &why, now);
            }
            Cont::CreateFind { wl, zone, prof, name, t_act, t_now0, t0, why, err } => {
                let id = if let Reply::Found(f) = reply { f } else { None };
                self.create_done(id, err, &wl, &zone, &prof, &name, t_act, t_now0, t0, &why, now);
            }
            Cont::Vm { delete, verb, wl, id, t_act, t_now0, t0, why, ver0 } => {
                self.lat_cloud = Some(ewma(self.lat_cloud, now - t0));
                self.lat_sample(true, now - t0, now);
                let r = if let Reply::Http(h) = reply { h } else { HttpReply::default() };
                let tn = self.t_now(now).unwrap_or(t_now0);
                let vstr = if delete { "delete" } else { verb.unwrap().as_str() };
                let okd = r.ok || (delete && r.status == 404);
                self.event(now, || json!({ "k": "ack", "type": vstr, "wl": wl, "vm": id, "ok": okd, "status": r.status, "latMs": (now - t0).round(), "simH": fmt3(tn - t_now0) }));
                if delete {
                    if r.ok || r.status == 404 {
                        self.st.vms.shift_remove(&id);
                        self.deleted.insert(id.clone());
                        self.st.deleted = self.deleted.iter().cloned().collect();
                        self.save();
                        self.stats.deletes += 1;
                        self.log(|| format!("[delete] {wl} {id} ({why}) → ok"));
                    } else {
                        self.stats.errors += 1;
                        let txt: String = r.text.chars().take(120).collect();
                        self.log(|| format!("[delete] {wl} {id} → {} {txt}", r.status));
                    }
                } else {
                    let verb = verb.unwrap();
                    if r.ok {
                        self.overrides
                            .insert(id.clone(), Override { state: if verb == Verb::Stop { "stopped" } else { "running" }, wall_ack: now });
                        let t = self.t_now(now).unwrap_or(t_act);
                        self.last_toggle.insert(id.clone(), t);
                        self.toggle_ver.insert(id.clone(), ver0);
                        if verb == Verb::Stop {
                            self.stats.stops += 1;
                        } else {
                            self.stats.starts += 1;
                        }
                        let short: String = id.chars().take(8).collect();
                        self.log(|| format!("[{}] {wl} {short} t≈{t_act:.1} ({why}) → ok", verb.as_str()));
                    } else {
                        self.stats.errors += 1;
                        let short: String = id.chars().take(8).collect();
                        let txt: String = r.text.chars().take(120).collect();
                        self.log(|| format!("[{}] {wl} {short} → {} {txt}", verb.as_str(), r.status));
                    }
                }
                self.in_vm.remove(&id);
            }
            Cont::Adopt { wl, zone, id } => {
                if self.st.vms.contains_key(&id) || self.deleted.contains(&id) {
                    return; // our create reply got there first
                }
                let info = if let Reply::Instance(i) = reply { i } else { None };
                match info {
                    Some(InstanceInfo { prof: Some(p), name }) if self.cat.profile(&p).is_some() => {
                        let ours = name.starts_with(&self.prefix); // e.g. a lost create reply
                        let label = self.cat.profile(&p).unwrap().label.clone();
                        self.st.vms.insert(
                            id.clone(),
                            Receipt { wl: wl.clone(), zone: zone.clone().unwrap_or_default(), prof: p, name, t_h: None, adopted: !ours },
                        );
                        self.save();
                        let short: String = id.chars().take(8).collect();
                        let z = zone.unwrap_or_default();
                        self.log(|| format!("[{}] {wl} {short} {label}@{z}", if ours { "recover" } else { "adopt" }));
                    }
                    _ => self.retry_adopt_later(id),
                }
            }
            Cont::FinalRemove { id } => {
                let r = if let Reply::Http(h) = reply { h } else { HttpReply::default() };
                if r.ok || r.status == 404 {
                    self.st.vms.shift_remove(&id);
                    self.deleted.insert(id);
                }
                let f = self.fin.as_mut().unwrap();
                f.pending_removes -= 1;
                if f.pending_removes == 0 {
                    self.finalize_sweep();
                }
            }
            Cont::FinalList { zone } => {
                let list = if let Reply::List(l) = reply { l } else { Vec::new() };
                let orphans: Vec<InstanceRef> =
                    list.into_iter().filter(|i| i.name.starts_with(&self.prefix) && !self.deleted.contains(&i.id)).collect();
                if orphans.is_empty() {
                    self.finalize_zone_done();
                } else {
                    self.fin.as_mut().unwrap().orphans_pending.insert(zone.clone(), orphans.len());
                    for i in orphans {
                        self.call(
                            Call::Remove { zone: Some(zone.clone()), id: i.id },
                            Cont::FinalOrphan { zone: zone.clone(), name: i.name },
                        );
                    }
                }
            }
            Cont::FinalOrphan { zone, name } => {
                self.log(|| format!("[final] orphan {name} deleted"));
                let f = self.fin.as_mut().unwrap();
                let n = f.orphans_pending.get_mut(&zone).unwrap();
                *n -= 1;
                if *n == 0 {
                    self.finalize_zone_done();
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn create_done(
        &mut self,
        id: Option<String>,
        err: String,
        wl: &str,
        zone: &str,
        prof: &str,
        name: &str,
        t_act: f64,
        t_now0: f64,
        t0: f64,
        why: &str,
        now: f64,
    ) {
        let tn = self.t_now(now).unwrap_or(t_now0);
        let errs: String = err.chars().take(160).collect();
        self.event(now, || json!({ "k": "ack", "type": "create", "wl": wl, "ok": id.is_some(), "latMs": (now - t0).round(), "simH": fmt3(tn - t_now0), "id": id, "err": if id.is_some() { Value::Null } else { Value::String(errs) } }));
        if let Some(id) = id {
            self.st.vms.insert(
                id.clone(),
                Receipt {
                    wl: wl.to_string(),
                    zone: zone.to_string(),
                    prof: prof.to_string(),
                    name: name.to_string(),
                    t_h: Some(t_act),
                    adopted: false,
                },
            );
            self.stats.creates += 1;
            let label = self.cat.profile(prof).map(|p| p.label.clone()).unwrap_or_default();
            self.log(|| format!("[create] {wl} → {zone} {label} t≈{t_act:.1} ({why}) id={id}"));
        } else {
            self.stats.errors += 1;
            let e: String = err.chars().take(200).collect();
            self.log(|| format!("[create] {wl} FAILED {e}"));
        }
        self.save();
        // finally: the in-flight guard for this workload is released once every worker's call returned
        if let Some(c) = self.in_create.get_mut(wl) {
            c.left = c.left.saturating_sub(1);
            if c.left == 0 {
                self.in_create.shift_remove(wl);
            }
        }
    }
}
