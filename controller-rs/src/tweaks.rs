//! Named overrides for policy and control parameters (`--opt key=value`, `--ctl key=value`), for
//! offline experiments. Without overrides every value is the JS default, so parity is unchanged.

/// Policy keys. Plain keys set the value in both lag modes (the low-lag block below may still
/// replace `cpu_window_h`, `pressure_value_per_core` and `prestage`); `low.*` keys set the
/// low-lag override itself.
pub const POLICY_KEYS: &[&str] = &[
    "margin_frac",
    "margin_frac_gpu",
    "margin_cpu_only",
    "fit_tol",
    "max_duty",
    "pause_quantum_h",
    "cpu_window_h",
    "buffer_lat_x",
    "min_value_per_core",
    "noise_band",
    "prestage",
    "reserve_single",
    "duty_w",
    "gpu_duty_w",
    "gpu_duty_max_lat_h",
    "gpu_tight_w",
    "gpu_tight_at",
    "scarcity_w",
    "card_w",
    "sticky_tol",
    "cpu_pause_max_lat_h",
    "points_aware",
    "pressure_value_per_core",
    "queue_cushion_h",
    "replace_foreign",
    "replace_min_rel",
    "replace_min_g",
    "staged_gate",
    "picky_frac",
    "picky_min_slack_h",
    "picky_gpu_only",
    "rate_floor",
    "clean_no_pause_i",
    "clean_zone_small_vm",
    "clean_zone_max_i",
    "gpu_margin_cut_h",
    "ext_premium",
    "ext_premium_gpu_only",
    "run_frac",
    "missed_on_server_time",
    "harmless_pauses",
    "harmless_defers",
    "yield_flat",
    "yield_fv_max",
    "yield_slack_h",
    "low_lat_h",
    "low.cpu_window_h",
    "low.pressure_value_per_core",
    "low.prestage",
    "low.margin_cut_h",
    "low.margin_min_h",
];

/// Control-loop keys (ControlOpts).
pub const CONTROL_KEYS: &[&str] = &[
    "loop_ms",
    "status_concurrency",
    "status_gap_ms",
    "base_margin_h",
    "latency_margin_x",
    "min_dwell_h",
    "max_lat_h",
    "learn_bias",
    "bias_shrink_n",
    "bias_cap",
    "nowcast",
    "nowcast_min_n",
    "nowcast_min_rho",
    "lat_robust",
    "fresh_fc",
    "fc_retry_ms",
    "place_vintages",
    "align_boundary",
    "wake_on_data",
    "wake_debounce_ms",
    "info_dwell",
    "stall_buffer_s",
    "stall_base_s",
    "stall_trigger_ms",
    "stall_memory_s",
    "raw_tracker",
    "max_extrap_ms",
    "safe_mode_errors",
    "freeze_ms",
];

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tweaks {
    pub kv: Vec<(String, f64)>,
}

impl Tweaks {
    /// Parse `key=value` items (value: number, or true/false). Unknown keys are an error.
    pub fn parse(items: &[String], allowed: &[&str]) -> Result<Tweaks, String> {
        let mut kv = Vec::new();
        for it in items {
            let (k, v) = it.split_once('=').ok_or_else(|| format!("expected key=value, got {it}"))?;
            if !allowed.contains(&k) {
                return Err(format!("unknown key {k} (known: {})", allowed.join(", ")));
            }
            let x = match v {
                "true" => 1.0,
                "false" => 0.0,
                _ => v.parse::<f64>().map_err(|_| format!("{k}: not a number: {v}"))?,
            };
            kv.push((k.to_string(), x));
        }
        Ok(Tweaks { kv })
    }
    pub fn get(&self, k: &str) -> Option<f64> {
        self.kv.iter().rev().find(|(n, _)| n == k).map(|(_, v)| *v)
    }
    pub fn is_empty(&self) -> bool {
        self.kv.is_empty()
    }
    pub fn describe(&self) -> String {
        self.kv.iter().map(|(k, v)| format!("{k}={v}")).collect::<Vec<_>>().join(" ")
    }
}
