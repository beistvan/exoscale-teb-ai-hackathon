#!/usr/bin/env node
/** Offline mock of the GreenOps engine + API, driving the real Controller on a virtual clock.
 *
 *  Electricity here is SYNTHETIC (random diurnal curves per area, random day drift, noisy
 *  forecasts) — no real or run-specific series is used. Physics: boot+input setup, compute at
 *  k*r*(1-sync)^(k-1), output, delivery; active watts while working, idle while waiting or done,
 *  0 W when stopped; quota counts stopped VMs; an illegal zone disqualifies.
 *  API calls take a random wall latency (lognormal) and are applied part-way through the call,
 *  like a loaded server; the run advances `speed` simulated seconds per wall second.
 *  (mock-sync.mjs is the older, faster policy-only mock without latency.)
 *
 *  Usage: node scripts/greenops/mock.mjs [seeds=20] [--lat MEDIAN_MS] [--verbose] [--opt k=v ...] [--ctl k=v ...]
 *  Env stress knobs: MOCK_SLOW (engine speed factor vs catalog), MOCK_RESUME_BOOT_S (boot on resume)
 */
import { loadCatalog, zoneLegal, profileLegal, fitsQuota, rateK, setupH, outputH, candidates, score } from "./model.mjs";
import { Controller } from "./controller.mjs";
import { decide as decideV1 } from "./policy-v1.mjs";

const H = 3.6e6;
const SLOW = Number(process.env.MOCK_SLOW ?? 1), RESUME_BOOT_H = Number(process.env.MOCK_RESUME_BOOT_S ?? 0) / 3600;
const STAGING_IDLE = process.env.MOCK_STAGING === "idle"; // power model variant: boot/input staging at idle watts
// The real engine boots and stages input before a job's release (observed live: a VM created at
// t=0 for a t=4 job was computing at t=4.0); compute waits for release. MOCK_PRESTAGE=0 disables.
const PRESTAGE = process.env.MOCK_PRESTAGE !== "0";

function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

// Generic area archetypes (mean, relative amplitude, hour of daily peak), randomised per seed.
const ARCH = { AT: [155, 0.2, 0], BG: [240, 0.25, 17], CH: [45, 0.3, 23], DE: [380, 0.2, 23], ES: [145, 0.25, 23], FR: [75, 0.3, 5], HR: [290, 0.27, 8], IT: [300, 0.2, 4] };

function makeGrid(seed, hours = 160) {
  const r = rng(seed * 7919 + 1);
  const actual = {};
  for (const [a, [m0, amp0, pk0]] of Object.entries(ARCH)) {
    const m = m0 * (0.75 + 0.5 * r()), amp = amp0 * (0.6 + 0.8 * r()), pk = pk0 + (r() - 0.5) * 8;
    let drift = 1;
    const arr = [];
    for (let h = 0; h < hours; h++) {
      if (h % 24 === 0) drift = Math.max(0.6, Math.min(1.5, drift * (1 + 0.18 * gauss(r))));
      arr.push(Math.max(5, m * drift * (1 + amp * Math.cos((2 * Math.PI * (h - pk)) / 24)) * (1 + 0.05 * gauss(r))));
    }
    actual[a] = arr;
  }
  const fcErr = {};
  for (const a of Object.keys(ARCH)) {
    fcErr[a] = [];
    for (let h = 0; h < hours; h++) { const row = []; let e = 0; for (let i = 0; i < 24; i++) { e = 0.8 * e + 0.035 * gauss(r); row.push(e * (1 + i / 12)); } fcErr[a].push(row); }
  }
  const fc = (a, tH) => { const h0 = Math.floor(tH); return Array.from({ length: 24 }, (_, i) => actual[a][Math.min(hours - 1, h0 + i)] * (1 + fcErr[a][Math.min(hours - 1, h0)][i])); };
  return { actual, fc };
}

class VClock {
  constructor() { this.t = 0; this.q = []; this.seq = 0; }
  now() { return this.t; }
  sleep(ms) { return new Promise((r) => this.q.push({ at: this.t + Math.max(0, ms), seq: this.seq++, r })); }
  async drive(stop, wallLimit) {
    while (!stop()) {
      await new Promise((r) => setImmediate(r));
      if (stop() || !this.q.length) break;
      let mi = 0;
      for (let i = 1; i < this.q.length; i++) if (this.q[i].at < this.q[mi].at || (this.q[i].at === this.q[mi].at && this.q[i].seq < this.q[mi].seq)) mi = i;
      const e = this.q.splice(mi, 1)[0];
      this.t = Math.max(this.t, e.at);
      e.r();
      if (this.t > wallLimit) break;
    }
  }
}

class Engine {
  constructor(cat, grid, speed = 720) {
    Object.assign(this, { cat, grid, speed });
    this.started = false; this.wall0 = 0; this.t = 0; this.seq = 0; this.dq = false;
    this.vms = new Map(); // id -> { id, wl, zone, prof, name, state, createdT }
    this.jobs = new Map([...cat.workloads.values()].map((w) => [w.id, { w, setupLeft: null, outLeft: null, done: 0, delivered: false, deliveredAt: null, g: 0 }]));
    this.grams = 0; this.kwh = 0; this.idleG = 0; this.rejects = 0;
  }
  simAt(wall) { return this.started ? Math.min(120, ((wall - this.wall0) * this.speed) / H) : 0; }
  advanceTo(wall) {
    const target = this.simAt(wall);
    while (this.t < target - 1e-9) { const dt = Math.min(0.02, target - this.t); this.physics(dt); this.t += dt; }
  }
  usage() { const u = { vms: 0, cores: 0, cards: {} }; for (const v of this.vms.values()) { const p = this.cat.profiles.get(v.prof); u.vms++; u.cores += p.cores; if (p.family !== "cpu") u.cards[p.family] = (u.cards[p.family] ?? 0) + p.cards; } return u; }
  physics(dt) {
    for (const v of this.vms.values()) if (v.state === "creating" && this.t - v.createdT >= 0.01) v.state = "running";
    for (const j of this.jobs.values()) {
      const mine = [...this.vms.values()].filter((v) => v.wl === j.w.id);
      if (!mine.length) continue;
      const p = this.cat.profiles.get(mine[0].prof);
      const run = mine.filter((v) => v.state === "running").length;
      const released = this.cat.T0 + this.t * H >= j.w.release;
      let activeFrac = 0;
      if (!j.delivered && (released || PRESTAGE) && run === mine.length && run > 0) {
        if (j.setupLeft === null) { j.setupLeft = setupH(j.w, p); j.outLeft = outputH(j.w); }
        let left = dt, setupUsed = 0;
        if (j.setupLeft > 0) { const u = Math.min(left, j.setupLeft); j.setupLeft -= u; left -= u; setupUsed = u; }
        if (!released) left = 0; // staged, waiting for release (idle draw for the rest of the step)
        if (released && left > 0 && j.done < j.w.required) { const r = rateK(j.w, p, run) * SLOW; const u = Math.min(left, (j.w.required - j.done) / r); j.done += r * u; left -= u; }
        if (released && left > 0 && j.done >= j.w.required - 1e-9 && j.outLeft > 0) { const u = Math.min(left, j.outLeft); j.outLeft -= u; left -= u; }
        if (released && j.done >= j.w.required - 1e-9 && j.outLeft <= 1e-9 && !j.delivered) { j.delivered = true; j.deliveredAt = this.t + dt - left; }
        activeFrac = released ? (dt - left - (STAGING_IDLE ? setupUsed : 0)) / dt : (STAGING_IDLE ? 0 : setupUsed / dt);
      }
      const z = this.cat.zones.get(mine[0].zone);
      const I = this.grid.actual[z.area][Math.min(159, Math.floor(this.t))];
      for (const v of mine) {
        if (v.state === "stopped") continue;
        const W = activeFrac * p.watts + (1 - activeFrac) * p.idleWatts;
        const e = (W * dt) / 1000;
        this.kwh += e; this.grams += e * z.pue * I; j.g += e * z.pue * I;
        if (activeFrac < 1) this.idleG += (((1 - activeFrac) * p.idleWatts * dt) / 1000) * z.pue * I;
      }
    }
  }
  state() { return !this.started ? "READY" : this.t >= 120 - 1e-9 ? "COMPLETED" : "RUNNING"; }
  status() {
    return {
      run_id: "mock", virtual_time: new Date(this.cat.T0 + this.t * H).toISOString(), speed_multiplier: this.speed, state: this.state(), qualification: this.dq ? "DISQUALIFIED" : "QUALIFIED",
      workloads: [...this.jobs.values()].map((j) => ({ id: j.w.id, state: j.delivered ? "succeeded" : "running", required_work: String(j.w.required), completed_work: j.done.toFixed(6), work_unit: j.w.unit, lost_work: "0.000000", final_output_delivered: j.delivered,
        assignments: [...this.vms.values()].filter((v) => v.wl === j.w.id).map((v) => ({ vm_id: v.id, zone: v.zone, state: v.state })) })),
    };
  }
  create(zone, profId, name, wl, wall) {
    if (this.state() === "COMPLETED") return { error: "run completed" };
    const w = this.cat.workloads.get(wl), z = this.cat.zones.get(zone), p = this.cat.profiles.get(profId);
    if (!zoneLegal(w, z) || !profileLegal(w, p)) { this.dq = true; return { error: "residency violation" }; }
    if (!fitsQuota(this.cat, this.usage(), p, 1)) { this.rejects++; return { error: "409 quota" }; }
    if (!this.started) { this.started = true; this.wall0 = wall; }
    const id = `vm-${++this.seq}`;
    this.vms.set(id, { id, wl, zone, prof: profId, name, state: "creating", createdT: this.t });
    return { id };
  }
  vmAction(id, verb) {
    const v = this.vms.get(id);
    if (!v) return { ok: false, status: 404 };
    if (verb === "stop" && v.state === "running") v.state = "stopped";
    else if (verb === "start" && v.state === "stopped") { v.state = "running"; const j = this.jobs.get(v.wl); if (j.setupLeft !== null) j.setupLeft += RESUME_BOOT_H; }
    return { ok: true, status: 200 };
  }
  remove(id) {
    const v = this.vms.get(id);
    if (!v) return { ok: false, status: 404 };
    const j = this.jobs.get(v.wl);
    const k = [...this.vms.values()].filter((x) => x.wl === v.wl).length;
    this.vms.delete(id);
    // engine rule: deletion discards uncheckpointed work (restart_from_zero: all of it); a job left
    // without VMs must boot and stage its input again on the next create
    if (j && !j.delivered && j.done < j.w.required) {
      const p = this.cat.profiles.get(v.prof);
      const ckW = rateK(j.w, p, k) * SLOW * (j.w.checkpointS / 3600);
      const kept = j.w.restartFromZero || !(ckW > 0) ? 0 : Math.floor(j.done / ckW + 1e-9) * ckW;
      if (k === 1) { this.lost = (this.lost ?? 0) + (j.done - kept); j.done = kept; j.setupLeft = null; }
      else { const share = (j.done - kept) / k; this.lost = (this.lost ?? 0) + share; j.done -= share; }
    }
    return { ok: true, status: 200 };
  }
  forecast(area) { const h0 = Math.floor(this.t); return this.grid.fc(area, this.t).map((v, i) => ({ t: this.cat.T0 + (h0 + i) * H, v })); }
}

function makeMockApi(engine, clock, latMs, r) {
  const lat = () => latMs * Math.exp(0.6 * gauss(r));
  const call = async (fn) => {
    const L = lat(), u = 0.3 + 0.6 * r();
    await clock.sleep(L * u);
    engine.advanceTo(clock.now());
    const res = fn();
    await clock.sleep(L * (1 - u));
    return res;
  };
  return {
    templates: new Map(),
    status: () => call(() => engine.status()),
    forecast: (a) => call(() => engine.forecast(a)),
    create: (zone, profId, name, wl) => call(() => engine.create(zone, profId, name, wl, clock.now())),
    listInstances: (zone) => call(() => [...engine.vms.values()].filter((v) => v.zone === zone).map((v) => ({ id: v.id, name: v.name }))),
    findByName: (zone, name) => call(() => [...engine.vms.values()].find((v) => v.name === name)?.id ?? null),
    vmAction: (zone, id, verb) => call(() => engine.vmAction(id, verb)),
    remove: (zone, id) => call(() => engine.remove(id)),
    getInstance: (zone, id) => call(() => { const v = engine.vms.get(id); return v ? { prof: v.prof, name: v.name } : null; }),
  };
}

/** Lower bound (perfect foresight, no quota, no latency): every job alone on its best legal single VM,
 *  running only in the cleanest actual hours between release and deadline. Not achievable — it
 *  shows how much headroom any scheduler could still find. */
export function lowerBound(cat, grid, per = {}) {
  let total = 0;
  for (const w of cat.workloads.values()) {
    const r0 = Math.ceil((w.release - cat.T0) / H), d0 = Math.floor((w.deadline - cat.T0) / H);
    let best = Infinity;
    for (const c of candidates(cat, w)) {
      if (c.k !== 1) continue;
      const need = setupH(w, c.prof) + w.required / rateK(w, c.prof, 1) + outputH(w);
      const hours = grid.actual[c.zone.area].slice(r0, d0).slice().sort((a, b) => a - b);
      if (hours.length < Math.ceil(need)) continue;
      let sum = 0, left = need;
      for (const v of hours) { const u = Math.min(1, left); sum += v * u; left -= u; if (left <= 0) break; }
      const activeH = STAGING_IDLE ? need - setupH(w, c.prof) : need;
      const g = (c.prof.watts / 1000) * c.zone.pue * sum * (activeH / need) + (STAGING_IDLE ? (c.prof.idleWatts / 1000) * c.zone.pue * (sum / need) * setupH(w, c.prof) : 0);
      if (g < best) best = g;
    }
    total += best; per[w.id] = best;
  }
  return total;
}

export async function simulate(seed, { latMs = 3000, policyOpts = {}, ctlOpts = {}, verbose = false, lateStartH = 0, foreign = false } = {}) {
  const cat = loadCatalog();
  // diagnostic: MOCK_QUOTA=big removes the shared quota (to measure what contention costs)
  if (process.env.MOCK_QUOTA === "big") cat.quota = { vms: 500, cores: 100000, cards: Object.fromEntries(Object.keys(cat.quota.cards).map((f) => [f, 100])) };
  cat.T0 = Date.parse("2025-09-30T00:00:00Z");
  const grid = makeGrid(seed);
  const clock = new VClock();
  const engine = new Engine(cat, grid);
  const api = makeMockApi(engine, clock, latMs, rng(seed * 31 + 7));
  const lines = [];
  const st = { run: "mock", vms: {}, seq: 0, deleted: [] };
  if (foreign || lateStartH > 0) {
    // replay of a run someone else started: the starter demo's two VMs, then our controller joins late
    if (foreign) {
      engine.create("at-vie-1", "20000000-0000-4000-8000-000000000002", "baseline-cpu", "w-01-dach-research", 0);
      engine.create("ch-gva-2", "20000000-0000-4000-8000-000000000011", "baseline-gpu", "w-08-ch-imaging", 0);
    } else { engine.started = true; engine.wall0 = 0; }
    clock.t = (lateStartH * H) / engine.speed;
    engine.advanceTo(clock.t);
  }
  const ctl = new Controller({ cat, api, clock, log: (...a) => { if (verbose) lines.push(`${engine.t.toFixed(1)}h ${a.join(" ")}`); }, state: st, save: () => {}, run: "mockrun0", opts: ctlOpts, policyOpts, ...(process.env.MOCK_POLICY === "v1" ? { decideFn: decideV1 } : {}) });
  ctl.runLoop();
  await clock.drive(() => ctl.done, 2.0e6);
  // carbon counts through the full window: let the engine run to 120h with whatever is left
  engine.advanceTo(engine.wall0 + (120 * H) / engine.speed + 1);
  const late = [...engine.jobs.values()].filter((j) => !j.delivered || j.deliveredAt * H + cat.T0 > j.w.deadline).map((j) => j.w.id);
  if (verbose) for (const j of engine.jobs.values()) lines.push(`${j.w.id.padEnd(22)} ${j.g.toFixed(0).padStart(6)} g  delivered ${j.deliveredAt?.toFixed(1)} / deadline ${((j.w.deadline - cat.T0) / H).toFixed(0)}`);
  const boundPer = {};
  const carbonPer = Object.fromEntries([...engine.jobs.values()].map((j) => [j.w.id, j.g]));
  const lateSet = new Set(late);
  const progress = Object.fromEntries([...engine.jobs.values()].map((j) => [j.w.id, lateSet.has(j.w.id) ? 0.5 * Math.min(1, j.done / j.w.required) : 1]));
  const pts = score(cat, carbonPer, progress, late.length === 0 && !engine.dq);
  const perJob = Object.fromEntries([...engine.jobs.values()].map((j) => [j.w.id, j.g]));
  return { seed, points: engine.dq ? 0 : pts.total, bound: lowerBound(cat, grid, boundPer), boundPer, perJob, dq: engine.dq, grams: engine.grams, kwh: engine.kwh, idleG: engine.idleG, late, rejects: engine.rejects, stats: ctl.stats, leftVms: engine.vms.size, lines };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const SEEDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
  const VERBOSE = args.includes("--verbose");
  const ls = args.indexOf("--late");
  const LATE = ls >= 0 ? Number(args[ls + 1]) : 0;
  const FOREIGN = args.includes("--foreign");
  const li = args.indexOf("--lat");
  const LAT = li >= 0 ? Number(args[li + 1]) : 3000;
  const P = {}, C = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--opt" || args[i] === "--ctl") { const [k, v] = args[i + 1].split("="); (args[i] === "--opt" ? P : C)[k] = v === "true" ? true : v === "false" ? false : isNaN(Number(v)) ? v : Number(v); i++; }
  }
  let tot = 0, fails = 0, totB = 0, totP = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = await simulate(s, { latMs: LAT, policyOpts: P, ctlOpts: C, verbose: VERBOSE, lateStartH: LATE, foreign: FOREIGN });
    tot += r.grams; totB += r.bound; totP += r.points;
    if (r.late.length || r.dq) fails++;
    console.log(`seed ${String(s).padStart(2)}: ${(r.grams / 1000).toFixed(2)} kg  ${r.kwh.toFixed(1)} kWh  idle ${(r.idleG / 1000).toFixed(2)} kg  ${JSON.stringify(r.stats)} left=${r.leftVms} rej=${r.rejects}${r.late.length ? `  LATE ${r.late.join(",")}` : ""}${r.dq ? " DQ" : ""}`);
    if (VERBOSE) for (const l of r.lines) console.log("   ", l);
  }
  console.log(`mean ${(totP / SEEDS).toFixed(1)} pts, ${(tot / SEEDS / 1000).toFixed(3)} kg (lower bound ${(totB / SEEDS / 1000).toFixed(3)} kg, gap ${((tot / totB - 1) * 100).toFixed(1)}%), failures ${fails}/${SEEDS}  lat=${LAT}ms`, JSON.stringify(P), JSON.stringify(C));
}
