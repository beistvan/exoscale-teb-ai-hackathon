//! Placement legality: a line-by-line port of `challenge/legality.mjs` (`zoneLegal`, `profileLegal`).
//! One illegal create disqualifies a live run, so `tests/legality.rs` checks this against the JS
//! file itself on every (workload, zone, profile) combination of the catalog and on random cases.

use crate::model::{Profile, Workload, Zone};

/// Residency: the one rule that disqualifies a run. Every create goes through this.
pub fn zone_legal(w: &Workload, z: &Zone) -> bool {
    if w.residency == "EU" && !z.eu {
        return false;
    }
    if w.residency == "CH" && z.country != "CH" {
        return false;
    }
    if w.residency != "EU" && w.residency != "CH" && w.residency != "ANYWHERE" {
        return false; // unknown rule → refuse
    }
    if let Some(allowed) = &w.allowed {
        if !allowed.is_empty() && !allowed.contains(&z.country) {
            return false;
        }
    }
    if w.forbidden.contains(&z.country) {
        return false;
    }
    true
}

/// Profile fit (not disqualifying — the API rejects it).
pub fn profile_legal(w: &Workload, p: &Profile) -> bool {
    if p.unit != w.unit {
        return false;
    }
    if let Some(ids) = &w.profile_ids {
        if !ids.is_empty() {
            return ids.contains(&p.id);
        }
    }
    if w.kind == "cpu" {
        return p.family == "cpu";
    }
    if p.family == "cpu" {
        return false;
    }
    if let Some(fams) = &w.families {
        if !fams.is_empty() && !fams.contains(&p.family) {
            return false;
        }
    }
    // JS: `if (w.minVram && p.vram < w.minVram)` — 0 and NaN are falsy
    if w.min_vram != 0.0 && !w.min_vram.is_nan() && p.vram < w.min_vram {
        return false;
    }
    true
}
