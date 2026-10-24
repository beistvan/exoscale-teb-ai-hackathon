#!/usr/bin/env node
/** Offline mock of the GreenOps engine to stress-test the policy before touching a live run.
 *  Electricity here is SYNTHETIC (random diurnal curves per area, random day drift, noisy
 *  forecasts) — no real or run-specific series is used. Physics: boot+input setup, compute
 *  at k*r*(1-sync)^(k-1), output, delivery; active watts while working, idle while waiting or
 *  finished, 0 W when stopped; quota counts stopped VMs; illegal zone = disqualified.
 *  Usage: node scripts/greenops/mock.mjs [seeds=20] [--verbose] [--opt key=value ...]
 */
import { loadCatalog, zoneLegal, profileLegal, fitsQuota, rateK, setupH, outputH } from "./model.mjs";
import { decide } from "./policy.mjs";
import { Tracker, buildView } from "./glue.mjs";

const H = 3.6e6;
// physics stress knobs (env): engine slower than the catalog model; boot repeated on each resume
const SLOW = Number(process.env.MOCK_SLOW ?? 1), RESUME_BOOT_H = Number(process.env.MOCK_RESUME_BOOT_S ?? 0) / 3600;
const args = process.argv.slice(2);
const SEEDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const VERBOSE = args.includes("--verbose");
const OPTS = {};
for (let i = 0; i < args.length; i++) if (args[i] === "--opt") { const [k, v] = args[++i].split("="); OPTS[k] = v === "true" ? true : v === "false" ? false : Number(v); }

function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
function gauss(r) { return Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r()); }

// Generic area archetypes (mean, relative amplitude, hour of daily peak). Randomised per seed.
const ARCH = { AT: [155, 0.2, 0], BG: [240, 0.25, 17], CH: [45, 0.3, 23], DE: [380, 0.2, 23], ES: [145, 0.25, 23], FR: [75, 0.3, 5], HR: [290, 0.27, 8], IT: [300, 0.2, 4] };

function makeGrid(seed, hours = 150) {
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
  // forecast issued at hour h for hour h+i: actual * (1 + e), error grows with lead time
  const fcErr = {};
  for (const a of Object.keys(ARCH)) {
    fcErr[a] = [];
    for (let h = 0; h < hours; h++) { const row = []; let e = 0; for (let i = 0; i < 24; i++) { e = 0.8 * e + 0.035 * gauss(r); row.push(e * (1 + i / 12)); } fcErr[a].push(row); }
  }
  const fc = (a, tH) => { const h0 = Math.floor(tH); return Array.from({ length: 24 }, (_, i) => actual[a][Math.min(hours - 1, h0 + i)] * (1 + fcErr[a][Math.min(hours - 1, h0)][i])); };
  return { actual, fc };
}

export function simulate(seed, opts = {}, verbose = false) {
  const cat = loadCatalog();
  cat.T0 = Date.parse("2025-09-30T00:00:00Z");
  const grid = makeGrid(seed);
  const DT = 0.2, END = 120;
  const vms = new Map(); // id -> {id, wl, zone, prof, state}
  const jobs = new Map([...cat.workloads.values()].map((w) => [w.id, { w, phase: "wait", setupLeft: 0, outLeft: 0, done: 0, delivered: false, deliveredAt: null }]));
  const receipt = new Map();
  const tracker = new Tracker();
  let t = 0, started = false, seq = 0, dq = false, grams = 0, kwh = 0, idleG = 0, stops = 0, starts = 0, rejects = 0;
  const log = [];
  const usage = () => { const u = { vms: 0, cores: 0, cards: {} }; for (const v of vms.values()) { const p = cat.profiles.get(v.prof); u.vms++; u.cores += p.cores; if (p.family !== "cpu") u.cards[p.family] = (u.cards[p.family] ?? 0) + p.cards; } return u; };
  while (t < END) {
    const status = {
      virtual_time: new Date(cat.T0 + t * H).toISOString(), state: started ? "RUNNING" : "READY",
      workloads: [...jobs.values()].map((j) => ({ id: j.w.id, completed_work: j.done.toFixed(6), final_output_delivered: j.delivered,
        assignments: [...vms.values()].filter((v) => v.wl === j.w.id).map((v) => ({ vm_id: v.id, zone: v.zone, state: v.state })) })),
    };
    const view = buildView(cat, status, receipt, tracker);
    view.fc = (a) => grid.fc(a, t);
    const acts = decide(cat, view, opts);
    for (const a of acts) {
      if (a.type === "create") {
        const w = cat.workloads.get(a.wl), z = cat.zones.get(a.zone), p = cat.profiles.get(a.prof);
        if (!zoneLegal(w, z) || !profileLegal(w, p)) { dq = true; log.push(`${t.toFixed(1)} DQ ${a.wl}@${a.zone}`); continue; }
        if (!fitsQuota(cat, usage(), p, a.k)) { rejects++; continue; }
        for (let i = 0; i < a.k; i++) { const id = `vm${++seq}`; vms.set(id, { id, wl: a.wl, zone: a.zone, prof: a.prof, state: "running" }); receipt.set(id, { wl: a.wl, zone: a.zone, prof: a.prof }); }
        const j = jobs.get(a.wl); j.phase = j.phase === "wait" ? "wait" : j.phase; j.setupLeft = setupH(w, p); j.outLeft = outputH(w);
        started = true;
        if (verbose) log.push(`${t.toFixed(1)} create ${a.wl} ${a.why}`);
      } else if (a.type === "delete") { vms.delete(a.vm.id); receipt.delete(a.vm.id); }
      else if (a.type === "stop") { const v = vms.get(a.vm.id); if (v) { v.state = "stopped"; stops++; } }
      else if (a.type === "start") { const v = vms.get(a.vm.id); if (v) { v.state = "running"; starts++; const j = jobs.get(v.wl); j.setupLeft += RESUME_BOOT_H; } }
    }
    // physics
    if (started) {
      for (const j of jobs.values()) {
        const mine = [...vms.values()].filter((v) => v.wl === j.w.id);
        if (!mine.length) continue;
        const p = cat.profiles.get(mine[0].prof);
        const run = mine.filter((v) => v.state === "running").length;
        const released = cat.T0 + t * H >= j.w.release;
        let activeFrac = 0;
        if (!j.delivered && released && run === mine.length) {
          let dt = DT;
          if (j.setupLeft > 0) { const u = Math.min(dt, j.setupLeft); j.setupLeft -= u; dt -= u; }
          if (dt > 0 && j.done < j.w.required) { const r = rateK(j.w, p, run) * SLOW; const u = Math.min(dt, (j.w.required - j.done) / r); j.done += r * u; dt -= u; }
          if (dt > 0 && j.done >= j.w.required - 1e-9 && j.outLeft > 0) { const u = Math.min(dt, j.outLeft); j.outLeft -= u; dt -= u; }
          if (j.done >= j.w.required - 1e-9 && j.outLeft <= 1e-9 && !j.delivered) { j.delivered = true; j.deliveredAt = t + DT - dt; if (j.deliveredAt * H + cat.T0 > j.w.deadline) j.late = true; }
          activeFrac = (DT - dt) / DT;
        }
        const z = cat.zones.get(mine[0].zone);
        const I = grid.actual[z.area][Math.floor(t)];
        for (const v of mine) {
          if (v.state !== "running") continue;
          const W = activeFrac * p.watts + (1 - activeFrac) * p.idleWatts;
          const e = (W * DT) / 1000;
          kwh += e; grams += e * z.pue * I; j.g = (j.g ?? 0) + e * z.pue * I;
          if (activeFrac < 1) idleG += ((1 - activeFrac) * p.idleWatts * DT / 1000) * z.pue * I;
        }
      }
    }
    t += DT;
  }
  const late = [...jobs.values()].filter((j) => !j.delivered || j.late || j.deliveredAt * H + cat.T0 > j.w.deadline).map((j) => j.w.id);
  if (verbose) for (const j of jobs.values()) log.push(`${j.w.id.padEnd(22)} ${(j.g ?? 0).toFixed(0).padStart(6)} g  delivered ${j.deliveredAt?.toFixed(1)} / deadline ${((j.w.deadline - cat.T0) / H).toFixed(0)}`);
  return { seed, dq, grams, kwh, idleG, late, stops, starts, rejects, log };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let tot = 0, fails = 0;
  for (let s = 1; s <= SEEDS; s++) {
    const r = simulate(s, OPTS, VERBOSE);
    tot += r.grams;
    if (r.late.length || r.dq) fails++;
    console.log(`seed ${String(s).padStart(2)}: ${(r.grams / 1000).toFixed(2)} kg  ${r.kwh.toFixed(1)} kWh  idle ${(r.idleG / 1000).toFixed(2)} kg  stops ${r.stops}  rejects ${r.rejects}${r.late.length ? `  LATE ${r.late.join(",")}` : ""}${r.dq ? " DQ" : ""}`);
    if (VERBOSE) for (const l of r.log) console.log("   ", l);
  }
  console.log(`mean ${(tot / SEEDS / 1000).toFixed(3)} kg, failures ${fails}/${SEEDS}`, JSON.stringify(OPTS));
}
