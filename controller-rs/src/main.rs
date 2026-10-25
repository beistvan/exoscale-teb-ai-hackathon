//! greenops-controller: experimental Rust port of the GreenOps live controller.
//!
//!   greenops-controller [run] [--dry] [--state FILE]   run until all delivered / run ends
//!   greenops-controller destroy [--state FILE]          delete this controller's VMs
//!   greenops-controller mock [seeds] [--lat MS] ...     offline simulator (no credentials, no API)
//!
//! Env: EXOSCALE_API_KEY, EXOSCALE_API_SECRET, GREENOPS_CLOUD_ENDPOINT, GREENOPS_WORK_ENDPOINT,
//!      GREENOPS_GRID_ENDPOINT, GREENOPS_GRID_SECRET (also read from ./.env or /app/.env);
//!      GREENOPS_STATE_DIR (receipt + logs; default: the working directory if writable, else /tmp).
use greenops_controller::{cli_mock, driver, live};

const USAGE: &str = "usage:
  greenops-controller [run] [--dry] [--state FILE] [--catalog FILE]   live controller (starts the run's clock unless --dry)
  greenops-controller destroy [--state FILE]                          delete this controller's VMs
  greenops-controller mock [seeds=20] [--lat MS=3000] [--from N] [--threads N] [--json] [--fma 0|1]
                           [--foreign] [--late H] [--verbose]           offline simulator (MOCK_* env knobs as mock.mjs)";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = match args.first().map(String::as_str) {
        Some("mock") => cli_mock::run(&args[1..]),
        Some("-h" | "--help" | "help") => {
            println!("{USAGE}");
            0
        }
        _ => {
            let mut o = driver::Options {
                dry: false,
                destroy: false,
                state: None,
                catalog: None,
                policy: Default::default(),
                ctl: Default::default(),
            };
            let (mut popt, mut copt): (Vec<String>, Vec<String>) = (vec![], vec![]);
            let mut i = 0;
            while i < args.len() {
                match args[i].as_str() {
                    "run" => {}
                    "destroy" => o.destroy = true,
                    "--dry" => o.dry = true,
                    "--state" => {
                        o.state = args.get(i + 1).map(Into::into);
                        i += 1;
                    }
                    "--catalog" => {
                        o.catalog = args.get(i + 1).cloned();
                        i += 1;
                    }
                    "--opt" => {
                        popt.push(args.get(i + 1).cloned().unwrap_or_default());
                        i += 1;
                    }
                    "--ctl" => {
                        copt.push(args.get(i + 1).cloned().unwrap_or_default());
                        i += 1;
                    }
                    other => {
                        eprintln!("unknown argument {other}\n{USAGE}");
                        std::process::exit(2);
                    }
                }
                i += 1;
            }
            match (
                greenops_controller::tweaks::Tweaks::parse(&popt, greenops_controller::tweaks::POLICY_KEYS),
                greenops_controller::tweaks::Tweaks::parse(&copt, greenops_controller::tweaks::CONTROL_KEYS),
            ) {
                (Ok(p), Ok(c)) => {
                    o.policy = p;
                    o.ctl = c;
                }
                (Err(e), _) | (_, Err(e)) => {
                    eprintln!("{e}");
                    std::process::exit(2);
                }
            }
            if o.dry && o.destroy {
                eprintln!("--dry and destroy don't mix");
                std::process::exit(2);
            }
            for p in [std::env::current_dir().map(|d| d.join(".env")).ok(), Some("/app/.env".into())].into_iter().flatten() {
                if live::load_env_file(&p) {
                    break;
                }
            }
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build().expect("tokio runtime");
            rt.block_on(driver::main(o))
        }
    };
    std::process::exit(code);
}
