//! End-to-end test of the live path (driver + HTTP adapter + controller core) against a local
//! stand-in for the challenge API, so the live code runs without ever touching a real run.
//!
//! The fake server serves the API.md shapes, backed by the offline engine (`mock::Engine`) on a fast
//! wall clock. It checks every EXO2-HMAC signature (and the grid's auth-token), and records every
//! request. The test runs `--dry` first (no write may reach the server, the clock must not start),
//! then a full run, which must finish with every VM deleted.
use base64::Engine as _;
use greenops_controller::controller::{Call, Reply, Verb};
use greenops_controller::driver;
use greenops_controller::live::exo2_auth;
use greenops_controller::mock::{Engine, Grid, MockEnv};
use greenops_controller::model::{Catalog, iso_from_ms};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const RUN: &str = "fake0123456789abcdef0123";
const KEY: &str = "EXOfakekey";
const SECRET: &str = "fake-secret";
const GRID_TOKEN: &str = "fake-grid-token";
const SPEED: f64 = 28800.0; // 120 simulated hours in 15 s

#[derive(Default)]
struct Log {
    gets: usize,
    writes: Vec<String>,
    bad_auth: Vec<String>,
    unknown: Vec<String>,
}

struct Fake {
    engine: Engine<'static>,
    cat: &'static Catalog,
    t0: Instant,
    log: Log,
}

impl Fake {
    fn wall(&self) -> f64 {
        self.t0.elapsed().as_secs_f64() * 1000.0
    }
}

fn status_json(f: &Fake) -> Value {
    let s = f.engine.status();
    json!({
        "run_id": RUN, "virtual_time": iso_from_ms(s.virtual_time_ms.unwrap()), "speed_multiplier": SPEED,
        "state": s.state, "qualification": s.qualification,
        "workloads": s.workloads.iter().map(|w| json!({
            "id": w.id, "state": w.state, "completed_work": format!("{:.6}", w.completed_work), "final_output_delivered": w.delivered,
            "assignments": w.assignments.iter().map(|a| json!({ "vm_id": a.vm_id, "zone": a.zone, "state": a.state })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn points(pts: &[greenops_controller::controller::Pt]) -> Value {
    Value::Array(pts.iter().map(|p| json!({ "datetime": iso_from_ms(p.t), "carbonIntensity": p.v })).collect())
}

/// Route one request; returns (status, json body).
fn handle(f: &mut Fake, method: &str, target: &str, headers: &[(String, String)], body: &str) -> (u16, Value) {
    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let hdr = |k: &str| headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(k)).map(|(_, v)| v.clone());
    let qp = |k: &str| query.split('&').find_map(|kv| kv.split_once('=').filter(|(a, _)| *a == k).map(|(_, b)| b.to_string()));
    if method == "GET" {
        f.log.gets += 1;
    } else {
        f.log.writes.push(format!("{method} {path}"));
    }
    let grid = format!("/runs/{RUN}/grid/v4/carbon-intensity/");
    if let Some(what) = path.strip_prefix(&grid) {
        if hdr("auth-token").as_deref() != Some(GRID_TOKEN) {
            f.log.bad_auth.push(target.to_string());
            return (401, json!({ "error": { "code": "unauthorized" } }));
        }
        let area = qp("zone").unwrap_or_default();
        let wall = f.wall();
        f.engine.advance_to(wall);
        return match what {
            "forecast" => (200, json!({ "zone": area, "forecast": points(&f.engine.forecast(&area)) })),
            "history" => (200, json!({ "zone": area, "history": points(&f.engine.history(&area)) })),
            _ => (404, json!({})),
        };
    }
    // EXO2-HMAC: recompute the signature over "METHOD path\nbody\nquery-values\n\nexpires"
    let auth = hdr("authorization").unwrap_or_default();
    let field = |k: &str| auth.split(&[' ', ','][..]).find_map(|p| p.strip_prefix(&format!("{k}=")).map(str::to_owned));
    let expires: i64 = field("expires").and_then(|e| e.parse().ok()).unwrap_or(0);
    let signed: Option<Vec<(String, String)>> =
        field("signed-query-args").map(|ks| ks.split(';').map(|k| (k.to_string(), qp(k).unwrap_or_default())).collect());
    let want = exo2_auth(KEY, SECRET, method, path, body, signed.as_deref(), expires);
    let now_s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
    if auth != want || expires < now_s {
        f.log.bad_auth.push(format!("{method} {target}"));
        return (401, json!({ "message": "bad signature" }));
    }
    let wall = f.wall();
    f.engine.advance_to(wall);
    if path == format!("/runs/{RUN}/work/v1/status") {
        return (200, status_json(f));
    }
    let Some(rest) = path.strip_prefix(&format!("/runs/{RUN}/cloud")) else {
        f.log.unknown.push(format!("{method} {target}"));
        return (404, json!({}));
    };
    if rest == "/v2/zone" {
        return (200, json!({ "zones": f.cat.zones.iter().map(|z| json!({ "name": z.slug })).collect::<Vec<_>>() }));
    }
    let rest = rest.strip_prefix('/').unwrap_or(rest);
    let (zone, p) = rest.split_once("/v2").unwrap_or(("", rest));
    let zone = zone.to_string();
    let r = |c: Call, f: &mut Fake| f.engine.exec(&c, wall);
    match (method, p) {
        ("GET", "/instance-type") => (
            200,
            json!({ "instance-types": f.cat.profiles.iter().filter(|p| p.offered_in(&zone)).map(|p| json!({ "id": p.id, "authorized": true })).collect::<Vec<_>>() }),
        ),
        ("GET", "/template") => (
            200,
            json!({ "templates": [{ "id": "tmpl-debian", "name": "Debian 12" }, { "id": "tmpl-ubuntu", "name": "Ubuntu 24.04 LTS" }] }),
        ),
        ("GET", "/instance") => match r(Call::ListInstances { zone }, f) {
            Reply::List(l) => (200, json!({ "instances": l.iter().map(|i| json!({ "id": i.id, "name": i.name })).collect::<Vec<_>>() })),
            _ => (500, json!({})),
        },
        ("POST", "/instance") => {
            let b: Value = serde_json::from_str(body).unwrap_or(Value::Null);
            let ud = base64::engine::general_purpose::STANDARD.decode(b["user-data"].as_str().unwrap_or("")).unwrap_or_default();
            let wl = serde_json::from_slice::<Value>(&ud)
                .ok()
                .and_then(|v| v["greenops"]["workload_id"].as_str().map(str::to_owned))
                .unwrap_or_default();
            assert_eq!(b["template"]["id"], "tmpl-ubuntu", "the ubuntu template is preferred");
            let c = Call::Create {
                zone,
                prof: b["instance-type"]["id"].as_str().unwrap_or("").into(),
                name: b["name"].as_str().unwrap_or("").into(),
                wl,
            };
            match r(c, f) {
                Reply::Create(c) if c.id.is_some() => (200, json!({ "id": "op-1", "reference": { "id": c.id } })),
                Reply::Create(c) => (if c.error.contains("409") { 409 } else { 403 }, json!({ "message": c.error })),
                _ => (500, json!({})),
            }
        }
        (m, p) if p.starts_with("/instance/") => {
            let tail = &p["/instance/".len()..];
            match (m, tail.split_once(':')) {
                ("PUT", Some((id, verb))) => {
                    let v = if verb == "stop" { Verb::Stop } else { Verb::Start };
                    match r(Call::VmAction { zone: Some(zone), id: id.into(), verb: v }, f) {
                        Reply::Http(h) => (h.status, json!({})),
                        _ => (500, json!({})),
                    }
                }
                ("DELETE", None) => match r(Call::Remove { zone: Some(zone), id: tail.into() }, f) {
                    Reply::Http(h) => (h.status, json!({})),
                    _ => (500, json!({})),
                },
                ("GET", None) => match r(Call::GetInstance { zone: Some(zone), id: tail.into() }, f) {
                    Reply::Instance(Some(i)) => (200, json!({ "id": tail, "name": i.name, "instance-type": { "id": i.prof } })),
                    _ => (404, json!({})),
                },
                _ => (404, json!({})),
            }
        }
        _ => {
            f.log.unknown.push(format!("{method} {target}"));
            (404, json!({}))
        }
    }
}

async fn serve(stream: tokio::net::TcpStream, fake: Arc<Mutex<Fake>>) {
    let mut stream = stream;
    let mut buf: Vec<u8> = Vec::new();
    loop {
        // headers
        let end = loop {
            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break i;
            }
            let mut chunk = [0u8; 8192];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        };
        let head = String::from_utf8_lossy(&buf[..end]).to_string();
        let mut lines = head.split("\r\n");
        let mut rl = lines.next().unwrap_or("").split(' ');
        let (method, target) = (rl.next().unwrap_or("").to_string(), rl.next().unwrap_or("").to_string());
        let headers: Vec<(String, String)> =
            lines.filter_map(|l| l.split_once(':').map(|(k, v)| (k.trim().to_string(), v.trim().to_string()))).collect();
        let len: usize =
            headers.iter().find(|(k, _)| k.eq_ignore_ascii_case("content-length")).and_then(|(_, v)| v.parse().ok()).unwrap_or(0);
        while buf.len() < end + 4 + len {
            let mut chunk = [0u8; 8192];
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => return,
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
            }
        }
        let body = String::from_utf8_lossy(&buf[end + 4..end + 4 + len]).to_string();
        buf.drain(..end + 4 + len);
        let (code, json) = handle(&mut fake.lock().unwrap(), &method, &target, &headers, &body);
        let text = json.to_string();
        let resp = format!(
            "HTTP/1.1 {code} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: keep-alive\r\n\r\n{text}",
            text.len()
        );
        if stream.write_all(resp.as_bytes()).await.is_err() {
            return;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_driver_dry_then_full_run_against_a_local_fake_api() {
    let cat: &'static Catalog = Box::leak(Box::new({
        let mut c = Catalog::builtin();
        c.t0 = greenops_controller::model::parse_iso_ms("2025-09-30T00:00:00Z").unwrap();
        c
    }));
    let env: &'static MockEnv = Box::leak(Box::new(MockEnv::default()));
    let grid: &'static Grid = Box::leak(Box::new(Grid::new(7, 160, env)));
    let fake = Arc::new(Mutex::new(Fake { engine: Engine::new(cat, grid, env, SPEED), cat, t0: Instant::now(), log: Log::default() }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let f2 = fake.clone();
    tokio::spawn(async move {
        while let Ok((s, _)) = listener.accept().await {
            tokio::spawn(serve(s, f2.clone()));
        }
    });
    let dir = std::env::temp_dir().join(format!("greenops-rs-test-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    // SAFETY: this test binary has this single test; nothing else reads the environment concurrently
    unsafe {
        std::env::set_var("EXOSCALE_API_KEY", KEY);
        std::env::set_var("EXOSCALE_API_SECRET", SECRET);
        std::env::set_var("GREENOPS_CLOUD_ENDPOINT", format!("{base}/runs/{RUN}/cloud/v2"));
        std::env::set_var("GREENOPS_WORK_ENDPOINT", format!("{base}/runs/{RUN}/work/v1"));
        std::env::set_var("GREENOPS_GRID_ENDPOINT", format!("{base}/runs/{RUN}/grid/v4"));
        std::env::set_var("GREENOPS_GRID_SECRET", GRID_TOKEN);
        std::env::set_var("GREENOPS_STATE_DIR", &dir);
    }

    // 1. --dry: reads only, the clock must not start, nothing is written locally
    let code = driver::main(driver::Options {
        dry: true,
        destroy: false,
        state: None,
        catalog: None,
        policy: Default::default(),
        ctl: Default::default(),
    })
    .await;
    assert_eq!(code, 0);
    {
        let f = fake.lock().unwrap();
        assert!(f.log.writes.is_empty(), "dry run sent writes: {:?}", f.log.writes);
        assert!(f.log.gets > 20, "dry run read the run ({} GETs)", f.log.gets);
        assert!(!f.engine.started, "dry run must not start the clock");
        assert!(f.log.bad_auth.is_empty(), "bad signatures: {:?}", f.log.bad_auth);
    }
    assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0, "dry run must not write files");

    // 2. the full run: until every workload is delivered (or the run ends), then every VM deleted
    let t = Instant::now();
    let code = driver::main(driver::Options {
        dry: false,
        destroy: false,
        state: None,
        catalog: None,
        policy: Default::default(),
        ctl: Default::default(),
    })
    .await;
    assert_eq!(code, 0);
    let f = fake.lock().unwrap();
    assert!(f.log.bad_auth.is_empty(), "bad signatures: {:?}", f.log.bad_auth);
    assert!(f.log.unknown.is_empty(), "unknown routes: {:?}", f.log.unknown);
    assert!(!f.engine.dq, "disqualified");
    let creates = f.log.writes.iter().filter(|w| w.starts_with("POST")).count();
    let deletes = f.log.writes.iter().filter(|w| w.starts_with("DELETE")).count();
    assert!(creates >= 15, "every workload got VMs ({creates} creates)");
    assert!(deletes >= creates, "every VM deleted ({deletes} deletes for {creates} creates)");
    assert!(f.log.writes.iter().any(|w| w.ends_with(":stop")), "clean-hour pauses happened");
    let st: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("greenops-orchestrator-state.json")).unwrap()).unwrap();
    assert_eq!(st["run"], RUN);
    assert_eq!(st["vms"].as_object().unwrap().len(), 0, "receipt empty at the end");
    let events = std::fs::read_to_string(dir.join("orchestrator-events.jsonl")).unwrap();
    assert!(events.lines().count() > 100);
    assert!(events.lines().all(|l| serde_json::from_str::<Value>(l).is_ok()));
    let s = f.engine.status();
    let delivered = s.workloads.iter().filter(|w| w.delivered).count();
    eprintln!(
        "fake run: {:.1} s wall, {creates} creates, {deletes} deletes, {} GETs, delivered {delivered}/15, state {}",
        t.elapsed().as_secs_f64(),
        f.log.gets,
        s.state
    );
    let _ = std::fs::remove_dir_all(&dir);
}
