/** Turns raw /work/v1/status + the controller's VM receipt into the policy's view.
 *  Shared by the live controller and the offline mock so the mock exercises the same code. */
const H = 3.6e6;

export class Tracker {
  constructor() { this.m = new Map(); } // wl -> { runH, lastT, lastDone, obsRate, setKey }
  /** Update per-job running time and observed compute rate (only across intervals where every
   *  worker ran the whole time and progress moved).
   *  raw (optional): vmId -> state as the engine reported it. With it, "ran the whole interval" uses the
   *  engine's own states at both snapshots, and the previous state only advances with a new snapshot —
   *  otherwise an acknowledged start (overlaid as "running" on the older snapshot) made the interval in
   *  which the VM was still stopped count as running, and the rate sample came out far too low. */
  observe(wl, tH, done, vms, raw = null) {
    const s = this.m.get(wl) ?? { deployedH: null, runH: 0, lastT: tH, lastDone: done, obsRate: 0, allRun: false, setKey: "" };
    const key = vms.map((v) => v.id).sort().join(",");
    const allRun = vms.length > 0 && vms.every((v) => (raw ? raw.get(v.id) : v.state) === "running");
    const dt = tH - s.lastT;
    if (dt > 0 && s.allRun && allRun && key === s.setKey) {
      s.runH += dt;
      const dd = done - s.lastDone;
      if (dd > 0 && dt >= 0.15) {
        const r = dd / dt;
        // EWMA of rate samples where compute advanced the whole interval (s.lastDone > 0 means
        // setup was already over at the interval start, so the sample isn't diluted by staging).
        if (s.lastDone > 0) s.obsRate = s.obsRate > 0 ? 0.7 * s.obsRate + 0.3 * r : r;
      }
    }
    if (vms.length && s.deployedH === null) s.deployedH = tH;
    if (!vms.length) s.deployedH = null;
    if (key !== s.setKey) s.obsRate = 0; // new worker set → rate must be re-learned
    if (dt > 0 || key !== s.setKey) { s.lastT = tH; s.lastDone = done; }
    if (!raw || dt > 0 || key !== s.setKey) s.allRun = allRun;
    s.setKey = key;
    this.m.set(wl, s);
    return s;
  }
}

import { rateK } from "./model.mjs";

/** receipt: Map vmId -> { wl, zone, prof } (VMs this controller created or adopted). */
export function buildView(cat, status, receipt, tracker, raw = null) {
  const t = (Date.parse(status.virtual_time) - cat.T0) / H;
  const usage = { vms: 0, cores: 0, cards: {} };
  const seen = new Set();
  const add = (prof) => {
    usage.vms++;
    usage.cores += prof ? prof.cores : 40; // unknown VM: assume a titan-sized core footprint
    if (prof && prof.family !== "cpu") usage.cards[prof.family] = (usage.cards[prof.family] ?? 0) + prof.cards;
  };
  const jobs = [];
  for (const sw of status.workloads ?? []) {
    const w = cat.workloads.get(sw.id);
    if (!w) continue;
    const vms = [];
    for (const a of sw.assignments ?? []) {
      const r = receipt.get(a.vm_id);
      vms.push({ id: a.vm_id, zone: a.zone ?? r?.zone, prof: r?.prof, state: a.state, adopted: Boolean(r?.adopted) });
      if (!seen.has(a.vm_id)) { seen.add(a.vm_id); add(r ? cat.profiles.get(r.prof) : null); }
    }
    // receipt rows the status doesn't list yet (just created) still hold quota and belong to w
    for (const [id, r] of receipt) {
      if (r.wl !== sw.id || seen.has(id)) continue;
      seen.add(id); add(cat.profiles.get(r.prof));
      vms.push({ id, zone: r.zone, prof: r.prof, state: "creating" });
    }
    const done = Number(sw.completed_work ?? 0);
    const tr = tracker.observe(sw.id, t, done, vms, raw);
    jobs.push({ w, done, delivered: Boolean(sw.final_output_delivered), vms, runH: tr.runH, deployedH: tr.deployedH, obsRate: tr.obsRate, state: sw.state });
  }
  for (const [id, r] of receipt) if (!seen.has(id)) { seen.add(id); add(cat.profiles.get(r.prof)); }
  // Engine-vs-catalog speed ratio per work unit, learned from running jobs (conservative: <= 1).
  const ratios = {};
  for (const j of jobs) {
    const p = j.vms[0]?.prof && cat.profiles.get(j.vms[0].prof);
    if (!p || !(j.obsRate > 0)) continue;
    (ratios[j.w.unit] ??= []).push(j.obsRate / rateK(j.w, p, j.vms.length));
  }
  const calib = {};
  for (const [u, a] of Object.entries(ratios)) { a.sort((x, y) => x - y); calib[u] = Math.min(1, a[Math.floor(a.length / 2)]); }
  return { t, state: String(status.state ?? "").toUpperCase(), usage, jobs, calib };
}
