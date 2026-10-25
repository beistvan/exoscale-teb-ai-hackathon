//! The live entry point (port of `scripts/orchestrator.mjs`): runs the sans-IO controller core on a
//! tokio runtime against the real API. Every API call runs as its own task; replies come back over a
//! channel and are applied as they arrive, between 250 ms decision ticks — the JS event loop's
//! semantics, without ever blocking the loop on a slow call.
//!
//! Modes:
//!   run      until all workloads are delivered or the run ends (starts the clock on the first create)
//!   --dry    read the run, print the first decision, exit — no create/stop/start/delete is ever sent
//!            (the transport refuses any non-GET), no receipt or log files are written
//!   destroy  delete this controller's VMs (receipt + name-prefix sweep)

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc;

use crate::controller::{Call, ControlOpts, Core, CreateReply, HttpReply, Reply, RunState, Tick};
use crate::live::{Creds, LiveApi, LogFn};
use crate::model::Catalog;

pub struct Options {
    pub dry: bool,
    pub destroy: bool,
    pub state: Option<PathBuf>,
    pub catalog: Option<String>,
    /// experiment overrides (`--opt` / `--ctl`); empty for real runs unless deliberately set
    pub policy: crate::tweaks::Tweaks,
    pub ctl: crate::tweaks::Tweaks,
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

fn hms() -> String {
    let s = (now_ms() / 1000.0) as u64 % 86400;
    format!("{:02}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
}

fn writable(d: &Path) -> bool {
    let probe = d.join(format!(".greenops-write-test-{}", std::process::id()));
    match std::fs::File::create(&probe) {
        Ok(_) => {
            let _ = std::fs::remove_file(probe);
            true
        }
        Err(_) => false,
    }
}

/// Receipt + logs directory: GREENOPS_STATE_DIR, else the working directory if writable, else /tmp.
pub fn state_dir() -> PathBuf {
    if let Some(d) = std::env::var_os("GREENOPS_STATE_DIR").filter(|d| !d.is_empty()) {
        return PathBuf::from(d);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    if writable(&cwd) { cwd } else { PathBuf::from("/tmp") }
}

fn load_state(path: &Path, run: &str, log: &LogFn) -> RunState {
    if let Ok(text) = std::fs::read_to_string(path) {
        match serde_json::from_str::<RunState>(&text) {
            Ok(s) if s.run == run => return s,
            Ok(s) => log(&format!("[state] ignoring receipt of another run ({})", s.run)),
            Err(e) => log(&format!("[state] unreadable receipt ignored: {e}")),
        }
    }
    RunState { run: run.to_string(), ..Default::default() }
}

fn save_state(path: &Path, st: &RunState, log: &LogFn) {
    let text = serde_json::to_string_pretty(st).unwrap();
    // write-then-rename so an interrupted write never leaves a truncated receipt
    let tmp = path.with_extension("json.tmp");
    let res = std::fs::write(&tmp, text).and_then(|_| std::fs::rename(&tmp, path));
    if let Err(e) = res {
        log(&format!("[state] save failed {e}"));
    }
}

/// Runs one core entry point; a panic is logged and the loop goes on, like the JS loop's
/// `try { await this.step() } catch (e) { log }` (a failed step must not leave the run uncontrolled).
fn guard<T>(log: &LogFn, what: &str, f: impl FnOnce() -> T) -> Option<T> {
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
        Ok(v) => Some(v),
        Err(e) => {
            let msg = e.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| e.downcast_ref::<String>().cloned()).unwrap_or_default();
            log(&format!("[{what}] error {msg}"));
            None
        }
    }
}

/// Executes the core's calls as tasks. In dry mode the writes are answered locally (as the JS
/// `dryApi` does) and never reach the transport, which would refuse them anyway.
fn dispatch(core: &mut Core, api: &Arc<LiveApi>, dry: bool, tx: &mpsc::UnboundedSender<(u64, Reply)>, ttx: &mpsc::UnboundedSender<u64>) {
    for (id, call) in core.outbox.drain(..) {
        let api = api.clone();
        let tx = tx.clone();
        tokio::spawn(async move {
            let reply = match call {
                Call::Status => Reply::Status(api.status().await),
                Call::Forecast { area } => Reply::Points(api.forecast(&area).await),
                Call::History { area } => Reply::Points(api.history(&area).await),
                Call::GetInstance { zone, id } => Reply::Instance(api.get_instance(zone.as_deref().unwrap_or(""), &id).await),
                Call::Create { name, .. } if dry => {
                    Reply::Create(CreateReply { id: Some(format!("dry-{name}")), error: String::new(), ambiguous: false })
                }
                Call::Create { zone, prof, name, wl } => Reply::Create(api.create(&zone, &prof, &name, &wl).await),
                Call::FindByName { .. } if dry => Reply::Found(None),
                Call::FindByName { zone, name } => Reply::Found(api.find_by_name(&zone, &name).await),
                Call::VmAction { .. } | Call::Remove { .. } if dry => Reply::Http(HttpReply { ok: true, status: 0, text: String::new() }),
                Call::VmAction { zone, id, verb } => Reply::Http(api.vm_action(zone.as_deref().unwrap_or(""), &id, verb.as_str()).await),
                Call::Remove { zone, id } => Reply::Http(api.remove(zone.as_deref().unwrap_or(""), &id).await),
                Call::ListInstances { .. } if dry => Reply::List(vec![]),
                Call::ListInstances { zone } => Reply::List(api.list_instances(&zone).await),
            };
            let _ = tx.send((id, reply));
        });
    }
    for (token, ms) in core.timers.drain(..) {
        let ttx = ttx.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms as u64)).await;
            let _ = ttx.send(token);
        });
    }
}

pub async fn main(opts: Options) -> i32 {
    let creds = match Creds::from_env() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("{e}");
            return 2;
        }
    };
    let dir = state_dir();
    let files = !opts.dry;
    if files {
        let _ = std::fs::create_dir_all(&dir); // a missing log dir must not crash the run
    }
    let logf: Option<Arc<Mutex<std::fs::File>>> = if files {
        std::fs::OpenOptions::new().create(true).append(true).open(dir.join("orchestrator-run.log")).ok().map(|f| Arc::new(Mutex::new(f)))
    } else {
        None
    };
    let log: LogFn = Arc::new(move |m: &str| {
        let line = format!("{} {m}", hms());
        println!("{line}");
        if let Some(f) = &logf {
            let _ = writeln!(f.lock().unwrap(), "{line}");
        }
    });
    let api = match LiveApi::new(&creds, opts.dry, log.clone()) {
        Ok(a) => Arc::new(a),
        Err(e) => {
            log(&format!("[crash] {e}"));
            return 1;
        }
    };
    let run = api.run.clone();
    let state_path = opts.state.clone().unwrap_or_else(|| dir.join("greenops-orchestrator-state.json"));
    let mode = if opts.destroy { "destroy" } else { "run" };
    log(&format!("[boot] run={run} mode={mode}{} state={} (rust)", if opts.dry { " (dry)" } else { "" }, state_path.display()));
    if !opts.policy.is_empty() || !opts.ctl.is_empty() {
        log(&format!("[boot] overrides policy: {} control: {}", opts.policy.describe(), opts.ctl.describe()));
    }
    let mut cat = match Catalog::load(opts.catalog.as_deref()) {
        Ok(c) => c,
        Err(e) => {
            log(&format!("[crash] {e}"));
            return 1;
        }
    };
    if let Err(e) = api.discover(&mut cat).await {
        log(&format!("[crash] {e}"));
        return 1;
    }
    log(&format!("[boot] discovery done: {} zones, templates for {}", cat.zones.len(), api.templates.lock().unwrap().len()));

    let (tx, mut rx) = mpsc::unbounded_channel::<(u64, Reply)>();
    let (ttx, mut trx) = mpsc::unbounded_channel::<u64>();

    if opts.dry {
        // one decision with no side effects (fresh receipt, nothing saved)
        let mut co = ControlOpts::default();
        co.apply(&opts.ctl);
        let mut core = Core::new(cat, RunState { run: run.clone(), ..Default::default() }, &run, co);
        core.set_policy_tweaks(opts.policy.clone());
        let l = log.clone();
        core.set_log(Box::new(move |m: &str| l(m)));
        let deadline = now_ms() + 90_000.0;
        while now_ms() < deadline && !(core.snap.is_some() && core.has_forecasts()) {
            core.poll_status(now_ms());
            if let Some(t) = core.t_now(now_ms()) {
                core.refresh_forecasts(t.floor() as i64);
            }
            dispatch(&mut core, &api, true, &tx, &ttx);
            let sleep = tokio::time::sleep(Duration::from_millis(300));
            tokio::pin!(sleep);
            loop {
                tokio::select! {
                    _ = &mut sleep => break,
                    Some((id, r)) = rx.recv() => core.on_reply(id, r, now_ms()),
                }
            }
        }
        if core.snap.is_none() {
            log("[dry] no status reply within 90 s");
            return 1;
        }
        let state = core.snap.as_ref().map(|s| s.state.clone()).unwrap_or_default();
        log(&format!("[dry] run state {state}; t≈{:.2}h; lat≈{:.2}h", core.t_now(now_ms()).unwrap_or(0.0), core.lat_h()));
        core.step(now_ms());
        for (_, c) in &core.outbox {
            match c {
                Call::Create { zone, prof, name, wl } => log(&format!(
                    "[dry] would create {wl} → {zone} {} ({name})",
                    core.cat.profile(prof).map(|p| p.label.as_str()).unwrap_or(prof)
                )),
                Call::VmAction { id, verb, .. } => log(&format!("[dry] would {} {id}", verb.as_str())),
                Call::Remove { id, .. } => log(&format!("[dry] would delete {id}")),
                _ => {}
            }
        }
        dispatch(&mut core, &api, true, &tx, &ttx);
        let sleep = tokio::time::sleep(Duration::from_millis(200));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep => break,
                Some((id, r)) = rx.recv() => core.on_reply(id, r, now_ms()),
            }
        }
        log("[dry] one decision cycle done");
        return 0;
    }

    let st = load_state(&state_path, &run, &log);
    let mut co = ControlOpts::default();
    co.apply(&opts.ctl);
    let mut core = Core::new(cat, st, &run, co);
    core.set_policy_tweaks(opts.policy.clone());
    let l = log.clone();
    core.set_log(Box::new(move |m: &str| l(m)));
    // one JSON object per line: decisions, acknowledgements (with latency + sim hours elapsed), status replies
    if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("orchestrator-events.jsonl")) {
        let f = Mutex::new(f);
        core.set_event(Box::new(move |v: Value| {
            let _ = writeln!(f.lock().unwrap(), "{v}");
        }));
    }

    if opts.destroy {
        core.start_finalize("destroy requested", now_ms());
    }
    let loop_ms = core.o.loop_ms;
    let tick_now = |core: &mut Core| guard(&log, "step", || core.loop_tick(now_ms())).unwrap_or(Tick::Next(loop_ms));
    let mut tick = if opts.destroy { Tick::Wait } else { tick_now(&mut core) };
    loop {
        dispatch(&mut core, &api, false, &tx, &ttx);
        if core.dirty {
            save_state(&state_path, &core.st, &log);
            core.dirty = false;
        }
        if core.done {
            break;
        }
        let wait = match tick {
            Tick::Next(ms) => Some(ms),
            Tick::Wait => None,
            Tick::Done => break,
        };
        // wait for the next tick, applying replies as they arrive
        let sleep = tokio::time::sleep(Duration::from_millis(wait.unwrap_or(3_600_000.0) as u64));
        tokio::pin!(sleep);
        loop {
            tokio::select! {
                _ = &mut sleep, if wait.is_some() => {
                    tick = tick_now(&mut core);
                    break;
                }
                Some((id, r)) = rx.recv() => {
                    guard(&log, "reply", || core.on_reply(id, r, now_ms()));
                    dispatch(&mut core, &api, false, &tx, &ttx);
                    if core.dirty {
                        save_state(&state_path, &core.st, &log);
                        core.dirty = false;
                    }
                    if core.done {
                        break;
                    }
                }
                Some(token) = trx.recv() => {
                    guard(&log, "timer", || core.on_timer(token));
                }
            }
        }
    }
    if core.dirty {
        save_state(&state_path, &core.st, &log);
    }
    log(&format!(
        "[final] done: {}; receipt {} VM(s) at {}",
        serde_json::to_string(&core.stats).unwrap(),
        core.st.vms.len(),
        state_path.display()
    ));
    0
}
