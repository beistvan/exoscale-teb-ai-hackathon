//! Port of `scripts/greenops/glue.mjs`: turns a /work/v1/status snapshot + the controller's VM
//! receipt into the policy's view. Shared by the live controller and the offline mock.

use crate::model::{Catalog, FxMap, FxSet, H, Usage, rate_k};
use crate::policy::{JobView, View, VmView};

/// `/work/v1/status`, reduced to the fields the controller reads.
#[derive(Clone, Debug, Default)]
pub struct StatusDoc {
    /// `Date.parse(virtual_time)` (epoch ms); None when absent or unparsable
    pub virtual_time_ms: Option<f64>,
    /// `Number(speed_multiplier)` (NaN when absent)
    pub speed: f64,
    pub state: String,
    pub qualification: String,
    pub workloads: Vec<WlStatus>,
}

#[derive(Clone, Debug, Default)]
pub struct WlStatus {
    pub id: String,
    pub state: String,
    /// `Number(completed_work ?? 0)`
    pub completed_work: f64,
    pub delivered: bool,
    pub assignments: Vec<Assignment>,
}

#[derive(Clone, Debug, Default)]
pub struct Assignment {
    pub vm_id: String,
    pub zone: Option<String>,
    pub state: String,
}

/// A receipt row as the view sees it (st.vms entry or an in-flight create).
#[derive(Clone, Debug)]
pub struct ReceiptRow {
    pub id: String,
    pub wl: String,
    pub zone: String,
    pub prof: String,
    pub adopted: bool,
}

#[derive(Clone, Debug)]
struct TrackState {
    deployed_h: Option<f64>,
    run_h: f64,
    last_t: f64,
    last_done: f64,
    obs_rate: f64,
    all_run: bool,
    set_key: String,
}

/// Per-job running time and observed compute rate.
#[derive(Default)]
pub struct Tracker {
    m: FxMap<String, TrackState>,
}

impl Tracker {
    /// Update per-job running time and observed compute rate (only across intervals where every
    /// worker ran the whole time and progress moved). Returns (runH, deployedH, obsRate).
    /// `raw` (rawTracker): vm id -> state as the engine reported it. With it, "ran the whole interval" uses
    /// the engine's own states, and the previous state only advances with a new snapshot.
    pub fn observe(
        &mut self,
        wl: &str,
        t_h: f64,
        done: f64,
        vms: &[VmView],
        raw: Option<&FxMap<String, String>>,
    ) -> (f64, Option<f64>, f64) {
        let s = self.m.entry(wl.to_string()).or_insert_with(|| TrackState {
            deployed_h: None,
            run_h: 0.0,
            last_t: t_h,
            last_done: done,
            obs_rate: 0.0,
            all_run: false,
            set_key: String::new(),
        });
        let mut ids: Vec<&str> = vms.iter().map(|v| v.id.as_str()).collect();
        ids.sort_unstable();
        let key = ids.join(",");
        let all_run = !vms.is_empty()
            && vms.iter().all(|v| match raw {
                Some(r) => r.get(&v.id).is_some_and(|st| st == "running"),
                None => v.state == "running",
            });
        let dt = t_h - s.last_t;
        if dt > 0.0 && s.all_run && all_run && key == s.set_key {
            s.run_h += dt;
            let dd = done - s.last_done;
            if dd > 0.0 && dt >= 0.15 {
                let r = dd / dt;
                // EWMA of rate samples where compute advanced the whole interval
                if s.last_done > 0.0 {
                    s.obs_rate = if s.obs_rate > 0.0 { 0.7 * s.obs_rate + 0.3 * r } else { r };
                }
            }
        }
        if !vms.is_empty() && s.deployed_h.is_none() {
            s.deployed_h = Some(t_h);
        }
        if vms.is_empty() {
            s.deployed_h = None;
        }
        if key != s.set_key {
            s.obs_rate = 0.0; // new worker set → rate must be re-learned
        }
        if dt > 0.0 || key != s.set_key {
            s.last_t = t_h;
            s.last_done = done;
        }
        if raw.is_none() || dt > 0.0 || key != s.set_key {
            s.all_run = all_run;
        }
        s.set_key = key;
        (s.run_h, s.deployed_h, s.obs_rate)
    }
}

/// `buildView`: receipt rows in insertion order (VMs this controller created or adopted, then
/// in-flight creates). `fc` is filled by the caller. `t` is the snapshot's own time.
/// `overlay(vm_id, raw_state)` applies the controller's in-flight view: None drops a VM whose delete
/// was acknowledged, otherwise the state to use (an acknowledged stop/start wins over stale status).
pub fn build_view(
    cat: &Catalog,
    status: &StatusDoc,
    overlay: &dyn Fn(&str, &str) -> Option<String>,
    receipt: &[ReceiptRow],
    tracker: &mut Tracker,
    raw: Option<&FxMap<String, String>>,
) -> View {
    let t = (status.virtual_time_ms.unwrap_or(f64::NAN) - cat.t0) / H;
    let mut usage = Usage::default();
    let mut seen: FxSet<&str> = FxSet::default();
    let rec: FxMap<&str, &ReceiptRow> = receipt.iter().map(|r| (r.id.as_str(), r)).collect();
    let add = |usage: &mut Usage, prof: Option<&crate::model::Profile>| {
        usage.vms += 1.0;
        usage.cores += prof.map(|p| p.cores).unwrap_or(40.0); // unknown VM: assume a titan-sized core footprint
        if let Some(p) = prof {
            if !p.is_cpu {
                usage.add_card(&p.family, p.cards);
            }
        }
    };
    let mut jobs = Vec::new();
    for sw in &status.workloads {
        let Some(wi) = cat.workload_index(&sw.id) else { continue };
        let mut vms = Vec::new();
        for a in &sw.assignments {
            let Some(state) = overlay(&a.vm_id, &a.state) else { continue };
            let r = rec.get(a.vm_id.as_str());
            vms.push(VmView {
                id: a.vm_id.clone(),
                zone: a.zone.clone().or_else(|| r.map(|r| r.zone.clone())),
                prof: r.map(|r| r.prof.clone()),
                state,
                adopted: r.is_some_and(|r| r.adopted),
            });
            if seen.insert(a.vm_id.as_str()) {
                add(&mut usage, r.and_then(|r| cat.profile(&r.prof)));
            }
        }
        // receipt rows the status doesn't list yet (just created) still hold quota and belong to w
        for r in receipt {
            if r.wl != sw.id || seen.contains(r.id.as_str()) {
                continue;
            }
            seen.insert(r.id.as_str());
            add(&mut usage, cat.profile(&r.prof));
            vms.push(VmView {
                id: r.id.clone(),
                zone: Some(r.zone.clone()),
                prof: Some(r.prof.clone()),
                state: "creating".into(),
                adopted: false,
            });
        }
        let done = sw.completed_work;
        let (run_h, deployed_h, obs_rate) = tracker.observe(&sw.id, t, done, &vms, raw);
        jobs.push(JobView { w: wi, done, delivered: sw.delivered, vms, run_h, deployed_h, obs_rate, state: sw.state.clone() });
    }
    for r in receipt {
        if seen.insert(r.id.as_str()) {
            add(&mut usage, cat.profile(&r.prof));
        }
    }
    // Engine-vs-catalog speed ratio per work unit, learned from running jobs (conservative: <= 1).
    let mut ratios: Vec<(String, Vec<f64>)> = Vec::new();
    for j in &jobs {
        let Some(p) = j.vms.first().and_then(|v| v.prof.as_deref()).and_then(|id| cat.profile(id)) else { continue };
        if !(j.obs_rate > 0.0) {
            continue;
        }
        let w = &cat.workloads[j.w];
        let r = j.obs_rate / rate_k(w, p, j.vms.len() as f64);
        match ratios.iter_mut().find(|(u, _)| *u == w.unit) {
            Some((_, a)) => a.push(r),
            None => ratios.push((w.unit.clone(), vec![r])),
        }
    }
    let calib = ratios
        .into_iter()
        .map(|(u, mut a)| {
            crate::model::sort_num(&mut a);
            let m = a[a.len() / 2];
            (u, crate::model::jmin(1.0, m))
        })
        .collect();
    View {
        t,
        t_snap: None,
        state: status.state.to_uppercase(),
        usage,
        jobs,
        calib,
        fc: Vec::new(),
        fc_ver: Vec::new(),
        fc_place: None,
        fc_place_ver: Vec::new(),
    }
}
