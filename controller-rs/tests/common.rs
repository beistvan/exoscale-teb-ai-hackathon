//! Helpers for tests that compare against the JS reference implementation (needs `node` >= 22).
use std::path::PathBuf;
use std::process::Command;

pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Runs `node <args>` from the repo root and returns stdout. Panics with a clear message when node
/// is missing: these tests exist to prove agreement with the JS controller, so they must not pass
/// silently without it.
pub fn node(args: &[&str], stdin: Option<&str>) -> String {
    use std::io::Write;
    let mut cmd = Command::new(std::env::var("NODE").unwrap_or_else(|_| "node".into()));
    cmd.args(args).current_dir(repo_root());
    cmd.stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::inherit());
    let mut child = cmd.spawn().expect("these tests compare against the JS reference: install node >= 22 (or set NODE=/path/to/node)");
    if let Some(input) = stdin {
        child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    } else {
        drop(child.stdin.take());
    }
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "node {args:?} failed");
    String::from_utf8(out.stdout).unwrap()
}
