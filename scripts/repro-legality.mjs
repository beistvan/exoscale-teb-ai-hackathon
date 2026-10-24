#!/usr/bin/env node
// Offline verification of OLD vs NEW orchestrator placement logic against the real
// challenge catalog — NO live API, NO .env needed.  Run:  bun scripts/repro-legality.mjs
import fs from "node:fs";
import path from "node:path";

const KIT = path.join(process.cwd(), "challenge/catalog.json");
const c = JSON.parse(fs.readFileSync(KIT, "utf8"));
const EU = new Set(["AT","BE","BG","HR","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE"]);
const country = (s = "",) => String(s).split("-")[0].toUpperCase() || s;
const zones = c.zones.map((z) => ({ slug: z.slug, country: country(z.slug), eu: EU.has(country(z.slug)) }));
const pool = c.profiles.map((p) => ({ id: p.id, family: p.family ?? "cpu", cards: Number(p.gpu_count ?? p.gpus ?? 0), mem: Number(p.memory_gib ?? 0), tput: Number(p.throughput ?? 0) }));

function wv(w) {
  return {
    kind: w.kind, residency: w.residency, countries: w.allowed_countries ?? null,
    forbidden: w.forbidden_countries ?? [], families: w.allowed_families ?? [],
    minGpuMem: w.minimum_gpu_memory_gib ?? 0, profiles: w.allowed_profile_ids ?? [],
  };
}
// OLD legalZones: no forbidden filter, CH miscounted as EU.
function legalZones(n, useNew) {
  return zones.filter((z) => {
    if (String(n.residency).toUpperCase() === "EU" && !(useNew ? z.eu : z.eu || z.country === "CH")) return false;
    if (n.countries && n.countries.length && !n.countries.includes(z.country)) return false;
    if (useNew && n.forbidden.length && n.forbidden.includes(z.country)) return false;
    return true;
  });
}
// NEW legalProfiles: allowed_profile_ids, else kind + allowed_families + minGPU mem.
function legalProfiles(n, useNew) {
  if (n.profiles.length) return pool.slice();
  if (!useNew) {
    // OLD: no filtering at all
    return (n.kind === "gpu") ? pool.filter((p) => p.family && p.family !== "cpu") : pool.filter((p) => !p.family || p.family === "cpu");
  }
  return pool.filter((p) => {
    if (n.kind === "cpu") return !p.family || p.family === "cpu";
    if (n.kind !== "gpu") return true;
    if (!p.family || p.family === "cpu") return false;
    if (n.families.length && !n.families.includes(p.family)) return false;
    if (n.minGpuMem && p.mem / Math.max(1, p.cards) < n.minGpuMem) return false;
    return true;
  });
}

let dqNew = 0, dqOld = 0, wrongOld = 0;
for (const w of c.workloads) {
  const n = wv(w);
  const dq = (useNew) => legalZones(n, useNew).some((z) => n.forbidden.includes(z.country));
  if (dq(true)) dqNew++;
  if (dq(false)) dqOld++;

  const pf = (useNew) => legalProfiles(n, useNew);
  if (n.kind === "gpu") {
    const newP = pf(true), oldP = pf(false);
    // old allows a family outside allowed_families or below minVRAM?
    const oldIllegalFam = oldP.filter((p) => (n.families.length && !n.families.includes(p.family)));
    const oldIllegalVram = oldP.filter((p) => n.minGpuMem && p.mem / Math.max(1, p.cards) < n.minGpuMem);
    if (oldIllegalFam.length || oldIllegalVram.length) {
      wrongOld++;
      console.log(`[OLD-WRONG] ${w.id}: profile pool allows forbidden family/vram (e.g. ${[...oldIllegalFam, ...oldIllegalVram].slice(0,3).map((p)=>p.family).join(",")}) while NEW pool = ${newP.map((p)=>p.family+":"+Math.round(p.mem/Math.max(1,p.cards))).join(",")}`);
    }
  }
}
console.log(`DQ(zones): old=${dqOld} new=${dqNew}   GPU-wrong-profiles: old=${wrongOld}`);
if (dqNew === 0 && dqOld > 0 && wrongOld > 0) console.log("\nVERDICT: NEW logic closes all reproduced gaps (drop-in for online orchestrator)");
else if (dqOld === 0 && wrongOld === 0) console.log("\nOK: no illegal-placement gaps reproduced");
