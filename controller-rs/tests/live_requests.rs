//! The Rust API adapter must send byte-identical requests to the JS one (scripts/greenops/liveapi.mjs):
//! same URLs, bodies, EXO2-HMAC signatures and grid auth header. The JS side runs with fetch stubbed
//! and Date.now fixed; the Rust side builds the same requests with the same fixed clock.
mod common;
use greenops_controller::live::{Creds, LiveApi, exo2_auth};
use serde_json::Value;
use std::sync::Arc;

#[test]
fn requests_match_liveapi_mjs_byte_for_byte() {
    let js: Value = serde_json::from_str(&common::node(&["controller-rs/tests/js/live-requests.mjs"], None)).unwrap();
    let creds = Creds {
        key: "EXOtestkey0123".into(),
        secret: "test-secret-not-real".into(),
        cloud_endpoint: "https://example.test/runs/0123456789abcdef01234567/cloud/v2".into(),
        work_endpoint: "https://example.test/runs/0123456789abcdef01234567/work/v1/".into(),
        grid_endpoint: "https://example.test/runs/0123456789abcdef01234567/grid/v4/".into(),
        grid_secret: "grid-token-not-real".into(),
    };
    let mut api = LiveApi::new(&creds, false, Arc::new(|_: &str| {})).unwrap();
    api.fixed_now_ms = Some(1761300000123);
    assert_eq!(api.run, js["run"].as_str().unwrap());
    // discovery kept at-vie-1 and de-fra-1, both with the ubuntu template
    api.templates.lock().unwrap().insert("de-fra-1".into(), "tmpl-ubuntu".into());
    let q = vec![("visibility".to_string(), "public".to_string())];
    let body = api
        .create_body("de-fra-1", "20000000-0000-4000-8000-000000000001", "go2-01234567-w-01-dach-research-1", "w-01-dach-research")
        .unwrap();
    let ours = vec![
        api.cloud_req("", "GET", "/zone", None, None),
        api.cloud_req("at-vie-1", "GET", "/instance-type", None, None),
        api.cloud_req("at-vie-1", "GET", "/template", None, Some(&q)),
        api.cloud_req("de-fra-1", "GET", "/instance-type", None, None),
        api.cloud_req("de-fra-1", "GET", "/template", None, Some(&q)),
        api.status_req(),
        api.grid_req("forecast", "DE"),
        api.grid_req("history", "CH"),
        api.cloud_req("de-fra-1", "POST", "/instance", Some(&body), None),
        api.cloud_req("de-fra-1", "PUT", "/instance/vm-1:stop", None, None),
        api.cloud_req("de-fra-1", "PUT", "/instance/vm-1:start", None, None),
        api.cloud_req("de-fra-1", "DELETE", "/instance/vm-1", None, None),
        api.cloud_req("at-vie-1", "GET", "/instance/vm-1", None, None),
        api.cloud_req("at-vie-1", "GET", "/instance", None, None),
    ];
    let seen = js["seen"].as_array().unwrap();
    assert_eq!(seen.len(), ours.len(), "request count");
    let h = |r: &greenops_controller::live::Req, k: &str| r.headers.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
    for (j, r) in seen.iter().zip(&ours) {
        assert_eq!(r.method, j["method"].as_str().unwrap());
        assert_eq!(r.url, j["url"].as_str().unwrap());
        assert_eq!(h(r, "Authorization").as_deref(), j["auth"].as_str(), "Authorization for {} {}", r.method, r.url);
        assert_eq!(h(r, "auth-token").as_deref(), j["token"].as_str(), "auth-token for {}", r.url);
        assert_eq!(h(r, "Content-Type").as_deref(), j["ctype"].as_str(), "Content-Type for {}", r.url);
        assert_eq!(r.body.as_deref(), j["body"].as_str(), "body for {} {}", r.method, r.url);
    }
}

#[test]
fn exo2_signature_matches_a_known_vector() {
    // node: crypto.createHmac("sha256", "k").update("GET /runs/r/work/v1/status\n\n\n\n1761300423").digest("base64")
    let a = exo2_auth("EXOkey", "k", "GET", "/runs/r/work/v1/status", "", None, 1761300423);
    assert_eq!(a, "EXO2-HMAC-SHA256 credential=EXOkey,expires=1761300423,signature=rE79lsonyF58QW341dG/LWmw54b4GTOG3LBXFB9EoT4=");
}
