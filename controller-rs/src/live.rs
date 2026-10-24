//! Port of `scripts/greenops/liveapi.mjs`: the real challenge API (EXO2-HMAC signed cloud/work,
//! `auth-token` grid). Timeouts are generous on purpose: under load the server answers in 3-17 s,
//! and aborting a slow but valid reply only to retry it doubles the lag. Creates are never blindly
//! retried (the cloud API has no idempotent receipts) — an ambiguous create is resolved by looking
//! the name up.
//!
//! Dry mode is enforced here, at the transport: a `LiveApi` built with `dry = true` refuses every
//! request that isn't a GET before anything is sent.

use base64::Engine as _;
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::controller::{CreateReply, HttpReply, InstanceInfo, InstanceRef, Pt};
use crate::glue::{Assignment, StatusDoc, WlStatus};
use crate::model::{Catalog, js_number, parse_iso_ms};

/// The run's "Copy environment" block.
#[derive(Clone, Debug)]
pub struct Creds {
    pub key: String,
    pub secret: String,
    pub cloud_endpoint: String,
    pub work_endpoint: String,
    pub grid_endpoint: String,
    pub grid_secret: String,
}

pub const ENV_VARS: [&str; 6] = [
    "EXOSCALE_API_KEY",
    "EXOSCALE_API_SECRET",
    "GREENOPS_CLOUD_ENDPOINT",
    "GREENOPS_WORK_ENDPOINT",
    "GREENOPS_GRID_ENDPOINT",
    "GREENOPS_GRID_SECRET",
];

impl Creds {
    /// From the environment; Err lists the missing variables.
    pub fn from_env() -> Result<Creds, String> {
        let get = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        let missing: Vec<&str> = ENV_VARS.iter().copied().filter(|k| get(k).is_none()).collect();
        if !missing.is_empty() {
            return Err(format!("Missing env: {}", missing.join(", ")));
        }
        Ok(Creds {
            key: get("EXOSCALE_API_KEY").unwrap(),
            secret: get("EXOSCALE_API_SECRET").unwrap(),
            cloud_endpoint: get("GREENOPS_CLOUD_ENDPOINT").unwrap(),
            work_endpoint: get("GREENOPS_WORK_ENDPOINT").unwrap(),
            grid_endpoint: get("GREENOPS_GRID_ENDPOINT").unwrap(),
            grid_secret: get("GREENOPS_GRID_SECRET").unwrap(),
        })
    }
}

/// `KEY=value` lines (blank lines and `#` comments skipped, optional `export `, optional quotes).
/// Variables already set in the environment win.
pub fn load_env_file(path: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    for line in text.lines() {
        let l = line.trim();
        if l.is_empty() || l.starts_with('#') {
            continue;
        }
        let l = l.strip_prefix("export ").unwrap_or(l);
        let Some((k, v)) = l.split_once('=') else { continue };
        let (k, mut v) = (k.trim(), v.trim());
        if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) {
            v = &v[1..v.len() - 1];
        }
        if std::env::var_os(k).is_none() {
            // SAFETY: called once at startup, before any thread is spawned
            unsafe { std::env::set_var(k, v) };
        }
    }
    true
}

/// `EXO2-HMAC-SHA256 credential=KEY,expires=EXP,signature=SIG[,signed-query-args=k1;k2]` where SIG is
/// base64(HMAC-SHA256(secret, "METHOD path\nbody\nquery-values\n\nexpires")).
pub fn exo2_auth(
    key: &str,
    secret: &str,
    method: &str,
    pathname: &str,
    body: &str,
    query: Option<&[(String, String)]>,
    expires: i64,
) -> String {
    let qv: String = query.map(|q| q.iter().map(|(_, v)| v.as_str()).collect()).unwrap_or_default();
    let msg = [format!("{method} {pathname}"), body.to_string(), qv, String::new(), expires.to_string()].join("\n");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC takes any key length");
    mac.update(msg.as_bytes());
    let sig = base64::engine::general_purpose::STANDARD.encode(mac.finalize().into_bytes());
    let mut a = format!("EXO2-HMAC-SHA256 credential={key},expires={expires},signature={sig}");
    if let Some(q) = query {
        a.push_str(",signed-query-args=");
        a.push_str(&q.iter().map(|(k, _)| k.as_str()).collect::<Vec<_>>().join(";"));
    }
    a
}

/// `encodeURIComponent`-style query encoding as URLSearchParams does it (form-urlencoded).
fn form_encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => out.push(b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// A fully built request (pure; tested against the JS adapter's requests in tests/live_requests.rs).
#[derive(Clone, Debug, PartialEq)]
pub struct Req {
    pub method: String,
    pub url: String,
    /// (name, value), in the order the JS adapter sets them
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Resp {
    pub ok: bool,
    pub status: u16,
    pub text: String,
    pub json: Option<Value>,
}

pub type LogFn = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

pub struct LiveApi {
    client: reqwest::Client,
    pub run: String,
    origin: String,
    work: String,
    grid: String,
    key: String,
    secret: String,
    grid_secret: String,
    pub templates: Mutex<HashMap<String, String>>,
    dry: bool,
    log: LogFn,
    /// fixed `Date.now()` for tests (None: the real clock)
    pub fixed_now_ms: Option<i64>,
}

/// `new URL(u)` pieces: (origin, pathname).
fn split_url(u: &str) -> Result<(String, String), String> {
    let url = reqwest::Url::parse(u).map_err(|e| format!("bad URL {u}: {e}"))?;
    Ok((url.origin().ascii_serialization(), url.path().to_string()))
}

impl LiveApi {
    pub fn new(c: &Creds, dry: bool, log: LogFn) -> Result<LiveApi, String> {
        let (origin, path) = split_url(&c.cloud_endpoint)?;
        // RUN = new URL(cloudEndpoint).pathname.split("/")[2]
        let run = path.split('/').nth(2).unwrap_or("").to_string();
        if run.is_empty() {
            return Err(format!("cannot read the run id from GREENOPS_CLOUD_ENDPOINT ({path})"));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(45_000)) // one deadline covering headers AND body
            .build()
            .map_err(|e| e.to_string())?;
        Ok(LiveApi {
            client,
            run,
            origin,
            work: c.work_endpoint.trim_end_matches('/').to_string(),
            grid: c.grid_endpoint.trim_end_matches('/').to_string(),
            key: c.key.clone(),
            secret: c.secret.clone(),
            grid_secret: c.grid_secret.clone(),
            templates: Mutex::new(HashMap::new()),
            dry,
            log,
            fixed_now_ms: None,
        })
    }

    fn expires(&self) -> i64 {
        let now = self.fixed_now_ms.unwrap_or_else(|| {
            std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
        });
        now.div_euclid(1000) + 300
    }

    /// `cloud(zone, method, p, body, query)` request for one attempt.
    pub fn cloud_req(&self, zone: &str, method: &str, p: &str, body: Option<&Value>, query: Option<&[(String, String)]>) -> Req {
        let pathname = format!("/runs/{}/cloud{}/v2{}", self.run, if zone.is_empty() { String::new() } else { format!("/{zone}") }, p);
        let mut url = format!("{}{}", self.origin, pathname);
        if let Some(q) = query {
            url.push('?');
            url.push_str(&q.iter().map(|(k, v)| format!("{}={}", form_encode(k), form_encode(v))).collect::<Vec<_>>().join("&"));
        }
        let payload = body.map(|b| serde_json::to_string(b).unwrap()).unwrap_or_default();
        let mut headers = vec![
            ("Accept".to_string(), "application/json".to_string()),
            ("Authorization".to_string(), exo2_auth(&self.key, &self.secret, method, &pathname, &payload, query, self.expires())),
        ];
        if !payload.is_empty() {
            headers.push(("Content-Type".to_string(), "application/json".to_string()));
        }
        Req { method: method.to_string(), url, headers, body: if payload.is_empty() { None } else { Some(payload) } }
    }

    pub fn status_req(&self) -> Req {
        let url = format!("{}/status", self.work);
        let pathname = split_url(&url).map(|(_, p)| p).unwrap_or_default();
        Req {
            method: "GET".into(),
            url,
            headers: vec![
                ("Accept".into(), "application/json".into()),
                ("Authorization".into(), exo2_auth(&self.key, &self.secret, "GET", &pathname, "", None, self.expires())),
            ],
            body: None,
        }
    }

    pub fn grid_req(&self, what: &str, area: &str) -> Req {
        let mut url = format!("{}/carbon-intensity/{what}?zone={}", self.grid, form_encode(area));
        if what == "forecast" {
            url.push_str("&horizonHours=24");
        }
        Req {
            method: "GET".into(),
            url,
            headers: vec![("Accept".into(), "application/json".into()), ("auth-token".into(), self.grid_secret.clone())],
            body: None,
        }
    }

    /// fetch with one deadline covering headers AND body. Err on network errors and timeouts.
    pub async fn send(&self, r: &Req) -> Result<Resp, String> {
        if self.dry && r.method != "GET" {
            return Err(format!("dry run: refusing {} {}", r.method, r.url));
        }
        let t0 = Instant::now();
        let method = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|e| e.to_string())?;
        let mut rb = self.client.request(method, &r.url);
        for (k, v) in &r.headers {
            rb = rb.header(k, v);
        }
        if let Some(b) = &r.body {
            rb = rb.body(b.clone());
        }
        let res = rb.send().await.map_err(|e| e.to_string())?;
        let status = res.status();
        let text = res.text().await.map_err(|e| e.to_string())?;
        let json = serde_json::from_str::<Value>(&text).ok();
        let dt = t0.elapsed().as_millis();
        if dt > 8000 {
            let p: Vec<&str> = r.url.split('?').next().unwrap_or("").rsplit('/').take(2).collect();
            (self.log)(&format!("[slow] {} {}/{} {dt}ms", r.method, p.get(1).unwrap_or(&""), p.first().unwrap_or(&"")));
        }
        Ok(Resp { ok: status.is_success(), status: status.as_u16(), text, json })
    }

    /// Signed cloud call with retries: GETs/PUTs/DELETEs retry network errors, 429 and 5xx; a POST
    /// never retries and reports an unknown outcome as `ambiguous`.
    pub async fn cloud(
        &self,
        zone: &str,
        method: &str,
        p: &str,
        body: Option<&Value>,
        query: Option<&[(String, String)]>,
        retries: u32,
    ) -> (Resp, bool) {
        let mut n = 0;
        loop {
            let req = self.cloud_req(zone, method, p, body, query);
            match self.send(&req).await {
                Err(e) => {
                    if method == "POST" || n >= retries {
                        return (Resp { ok: false, status: 0, text: e, json: None }, method == "POST");
                    }
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                Ok(r) => {
                    if (r.status == 429 || r.status >= 500) && method != "POST" && n < retries {
                        tokio::time::sleep(Duration::from_millis(1000)).await;
                    } else {
                        let amb = method == "POST" && r.status >= 500;
                        return (r, amb);
                    }
                }
            }
            n += 1;
        }
    }

    pub async fn status(&self) -> Option<StatusDoc> {
        for _ in 0..2 {
            let r = self.send(&self.status_req()).await.ok();
            if let Some(r) = &r {
                if r.ok {
                    if let Some(j) = &r.json {
                        return Some(parse_status(j));
                    }
                }
            }
            let wait = if r.as_ref().is_some_and(|r| r.status == 429) { 1000 } else { 300 };
            tokio::time::sleep(Duration::from_millis(wait)).await;
        }
        None
    }

    async fn grid_points(&self, what: &str, area: &str, key: &str) -> Option<Vec<Pt>> {
        let r = self.send(&self.grid_req(what, area)).await.ok()?;
        if !r.ok {
            return None;
        }
        let j = r.json?;
        Some(parse_points(j.get(key)))
    }

    pub async fn forecast(&self, area: &str) -> Option<Vec<Pt>> {
        self.grid_points("forecast", area, "forecast").await
    }

    /// This run's published observations (most recent 24 h), for learning the forecast's errors.
    pub async fn history(&self, area: &str) -> Option<Vec<Pt>> {
        self.grid_points("history", area, "history").await
    }

    pub fn create_body(&self, zone: &str, prof: &str, name: &str, wl: &str) -> Option<Value> {
        let tid = self.templates.lock().unwrap().get(zone).cloned()?;
        let user_data = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&json!({ "greenops": { "schema_version": "1.0", "workload_id": wl } })).unwrap());
        Some(json!({ "name": name, "instance-type": { "id": prof }, "template": { "id": tid }, "disk_size": 10, "user-data": user_data }))
    }

    pub async fn create(&self, zone: &str, prof: &str, name: &str, wl: &str) -> CreateReply {
        let Some(body) = self.create_body(zone, prof, name, wl) else {
            return CreateReply { id: None, error: format!("no template for {zone}"), ambiguous: false };
        };
        let (r, amb) = self.cloud(zone, "POST", "/instance", Some(&body), None, 2).await;
        let id = r.json.as_ref().and_then(|j| j.pointer("/reference/id").or_else(|| j.get("id"))).and_then(json_id);
        match id {
            Some(id) => CreateReply { id: Some(id), error: String::new(), ambiguous: false },
            None => {
                CreateReply { id: None, error: format!("{} {}", r.status, r.text.chars().take(200).collect::<String>()), ambiguous: amb }
            }
        }
    }

    pub async fn list_instances(&self, zone: &str) -> Vec<InstanceRef> {
        let (r, _) = self.cloud(zone, "GET", "/instance", None, None, 2).await;
        r.json
            .as_ref()
            .and_then(|j| j.get("instances"))
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|i| {
                        Some(InstanceRef {
                            id: json_id(i.get("id")?)?,
                            name: i.get("name").and_then(Value::as_str).unwrap_or("").to_string(),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub async fn find_by_name(&self, zone: &str, name: &str) -> Option<String> {
        for _ in 0..3 {
            let l = self.list_instances(zone).await;
            if let Some(hit) = l.into_iter().find(|x| x.name == name) {
                return Some(hit.id);
            }
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
        None
    }

    pub async fn vm_action(&self, zone: &str, id: &str, verb: &str) -> HttpReply {
        let (r, _) = self.cloud(zone, "PUT", &format!("/instance/{id}:{verb}"), None, None, 2).await;
        HttpReply { ok: r.ok, status: r.status, text: r.text }
    }

    pub async fn remove(&self, zone: &str, id: &str) -> HttpReply {
        let (r, _) = self.cloud(zone, "DELETE", &format!("/instance/{id}"), None, None, 2).await;
        HttpReply { ok: r.ok, status: r.status, text: r.text }
    }

    pub async fn get_instance(&self, zone: &str, id: &str) -> Option<InstanceInfo> {
        let (r, _) = self.cloud(zone, "GET", &format!("/instance/{id}"), None, None, 2).await;
        if !r.ok {
            return None;
        }
        let j = r.json.unwrap_or(Value::Null);
        let it = j.get("instance-type");
        let prof = match it {
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => v.get("id").and_then(json_id),
            None => None,
        };
        Some(InstanceInfo { prof, name: j.get("name").and_then(Value::as_str).unwrap_or("").to_string() })
    }

    /// Discovery before the clock starts: zones, live per-zone offerings, templates — all in parallel.
    pub async fn discover(&self, cat: &mut Catalog) -> Result<(), String> {
        let (z, _) = self.cloud("", "GET", "/zone", None, None, 4).await;
        let live: Vec<String> = z
            .json
            .as_ref()
            .and_then(|j| j.get("zones"))
            .and_then(Value::as_array)
            .map(|a| a.iter().filter_map(|x| x.get("name").and_then(Value::as_str).map(str::to_owned)).collect())
            .unwrap_or_default();
        if live.is_empty() {
            return Err(format!("zone discovery failed: {} {}", z.status, z.text.chars().take(200).collect::<String>()));
        }
        for slug in cat.zones.iter().map(|z| z.slug.clone()).collect::<Vec<_>>() {
            if !live.contains(&slug) {
                cat.remove_zone(&slug);
                (self.log)(&format!("[discover] zone {slug} not offered by this run"));
            }
        }
        let slugs: Vec<String> = cat.zones.iter().map(|z| z.slug.clone()).collect();
        let public = vec![("visibility".to_string(), "public".to_string())];
        let futs = slugs.iter().map(|slug| {
            let public = public.clone();
            async move {
                let (it, tp) = tokio::join!(
                    self.cloud(slug, "GET", "/instance-type", None, None, 4),
                    self.cloud(slug, "GET", "/template", None, Some(&public), 4)
                );
                (slug.clone(), it.0, tp.0)
            }
        });
        let results = futures_join_all(futs).await;
        for (slug, it, tp) in results {
            match it.json.as_ref().and_then(|j| j.get("instance-types")).and_then(Value::as_array) {
                Some(offered) => {
                    let ids: Vec<String> = offered
                        .iter()
                        .filter(|t| t.get("authorized") != Some(&Value::Bool(false)))
                        .filter_map(|t| t.get("id").and_then(json_id))
                        .collect();
                    for p in cat.profiles.iter_mut() {
                        if p.offered_in(&slug) && !ids.contains(&p.id) {
                            p.zones.retain(|z| *z != slug);
                            (self.log)(&format!("[discover] {} not offered in {slug}", p.label));
                        }
                    }
                }
                None => (self.log)(&format!("[discover] instance-type list for {slug} unavailable ({}); trusting catalog", it.status)),
            }
            let ts: Vec<Value> = tp.json.as_ref().and_then(|j| j.get("templates")).and_then(Value::as_array).cloned().unwrap_or_default();
            let t = ts
                .iter()
                .find(|x| x.get("name").and_then(Value::as_str).is_some_and(|n| n.to_lowercase().contains("ubuntu")))
                .or(ts.first());
            if let Some(id) = t.and_then(|t| t.get("id")).and_then(json_id) {
                self.templates.lock().unwrap().insert(slug.clone(), id);
            }
        }
        // a zone whose template lookup failed can reuse another zone's id (templates are global)
        let any = {
            let t = self.templates.lock().unwrap();
            slugs.iter().find_map(|s| t.get(s).cloned())
        };
        let Some(any) = any else { return Err("no VM template found".into()) };
        let mut t = self.templates.lock().unwrap();
        for slug in &slugs {
            t.entry(slug.clone()).or_insert_with(|| any.clone());
        }
        Ok(())
    }
}

/// Run futures concurrently and collect their outputs in order (a tiny `join_all`).
async fn futures_join_all<F: std::future::Future>(futs: impl IntoIterator<Item = F>) -> Vec<F::Output> {
    let mut pinned: Vec<std::pin::Pin<Box<F>>> = futs.into_iter().map(Box::pin).collect();
    let mut out: Vec<Option<F::Output>> = (0..pinned.len()).map(|_| None).collect();
    std::future::poll_fn(|cx| {
        let mut pending = false;
        for (i, f) in pinned.iter_mut().enumerate() {
            if out[i].is_none() {
                match f.as_mut().poll(cx) {
                    std::task::Poll::Ready(v) => out[i] = Some(v),
                    std::task::Poll::Pending => pending = true,
                }
            }
        }
        if pending { std::task::Poll::Pending } else { std::task::Poll::Ready(()) }
    })
    .await;
    out.into_iter().map(|o| o.unwrap()).collect()
}

/// An id as the API returns it (string, or a number rendered like JS would).
fn json_id(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.is_empty() => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn str_of(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) | None => String::new(),
        Some(other) => other.to_string(),
    }
}

/// `{ datetime, carbonIntensity }` points; drops non-finite ones like the JS filter.
pub fn parse_points(v: Option<&Value>) -> Vec<Pt> {
    v.and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|p| {
                    let t = parse_iso_ms(p.get("datetime")?.as_str()?)?;
                    let v = js_number(p.get("carbonIntensity"));
                    (t.is_finite() && v.is_finite()).then_some(Pt { t, v })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `/work/v1/status` JSON → StatusDoc.
pub fn parse_status(j: &Value) -> StatusDoc {
    let vt = match j.get("virtual_time") {
        Some(Value::String(s)) if !s.is_empty() => parse_iso_ms(s),
        _ => None,
    };
    let workloads = j
        .get("workloads")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|w| WlStatus {
                    id: str_of(w.get("id")),
                    state: str_of(w.get("state")),
                    completed_work: match w.get("completed_work") {
                        None | Some(Value::Null) => 0.0,
                        v => js_number(v),
                    },
                    delivered: matches!(w.get("final_output_delivered"), Some(Value::Bool(true))),
                    assignments: w
                        .get("assignments")
                        .and_then(Value::as_array)
                        .map(|aa| {
                            aa.iter()
                                .map(|x| Assignment {
                                    vm_id: str_of(x.get("vm_id")),
                                    zone: x.get("zone").and_then(Value::as_str).map(str::to_owned),
                                    state: str_of(x.get("state")),
                                })
                                .collect()
                        })
                        .unwrap_or_default(),
                })
                .collect()
        })
        .unwrap_or_default();
    StatusDoc {
        virtual_time_ms: vt,
        speed: js_number(j.get("speed_multiplier")),
        state: str_of(j.get("state")),
        qualification: str_of(j.get("qualification")),
        workloads,
    }
}
