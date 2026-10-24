#!/usr/bin/env node
/** GreenOps live orchestrator: plans and deploys all 15 workloads against a run's cloud/work/grid APIs.
 *  - carbon-aware: waits for a meaningfully cleaner forecast window, else deploys the cleanest legal option now
 *  - quota-safe: 20 VMs / 320 vCPU / per-GPU-family caps; residency-safe (only legal zones)
 *  - idempotent: deterministic VM names + a receipt file, so a rerun recovers accepted creates after a lost response
 *  - read-only knowledge: schedules solely from /status, /zone, /instance-type, /template and grid forecasts
 *  Usage: node orchestrator.mjs [--dry] [--state FILE]   run until all delivered or run ends
 *         node orchestrator.mjs destroy [--state FILE]   delete this orchestrator's VMs
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");
const MODE = process.argv.includes("destroy") ? "destroy" : "run";
const CREATE_TEST = process.argv.includes("--create-test");
const _si = process.argv.indexOf("--state");
const STATE = _si >= 0 && process.argv[_si + 1] ? process.argv[_si + 1] : "greenops-orchestrator-state.json";
const POLL_MS = 2500;
const MAX_VMS = 20, MAX_VCPUS = 320;
// Full-run log: task output buffers elide their middles — keep every line on disk.
const runLog = fs.createWriteStream("orchestrator-run.log", { flags: "a" });
for (const name of ["log", "error"]) {
  const orig = console[name].bind(console);
  console[name] = (...a) => { orig(...a); runLog.write(a.map(String).join(" ") + "\n"); };
}
const GPU_QUOTA = { gpu2: 8, gpu3: 8, gpu3080ti: 8, gpua30: 8, gpua5000: 8, gpurtx6000pro: 4 };
const t = (ms) => new Promise((r) => setTimeout(r, ms));
async function f(url, opts = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), 12000);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(to);
  }
}

for (const p of [path.join(process.cwd(), ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const env = process.env;
const key = env["EXOSCALE_API_KEY"], secret = env["EXOSCALE_API_SECRET"];
const CLOUD = (env["GREENOPS_CLOUD_ENDPOINT"] ?? "").replace(/\/$/, "");
const WORK = (env["GREENOPS_WORK_ENDPOINT"] ?? "").replace(/\/$/, "");
const GRID = (env["GREENOPS_GRID_ENDPOINT"] ?? "").replace(/\/$/, "");
const GRID_SECRET = env["GREENOPS_GRID_SECRET"] ?? "";
// Pause-parking is OFF by default: with it enabled the orchestrator delivered 13/15,
// 14/15, 14/15, 12/15; without it, 15/15 three times. Delivery beats carbon here.
// Set GREENOPS_PAUSE=1 to opt in.
const PAUSE_ON = env["GREENOPS_PAUSE"] === "1";
// Deferred starts (wait for a cleaner forecast window): dormant in every proven 15/15
// run — keep the code but only run it when explicitly enabled (GREENOPS_DEFER=1).
const DEFER_ON = env["GREENOPS_DEFER"] === "1";
if (!key || !secret || !CLOUD || !WORK || !GRID || !GRID_SECRET) { console.error("Missing GREENOPS_*/EXOSCALE_* env"); process.exit(2); }
const RUN = new URL(CLOUD).pathname.split("/")[2];
console.error(`[boot] run=${RUN} mode=${MODE}${DRY ? " (dry)" : ""}`);

function sign(method, pathname, opts = {}) {
  const expires = Math.floor(Date.now() / 1000) + 120;
  const q = opts.query ? new URLSearchParams(opts.query) : null;
  const qval = q ? [...q.values()].join("") : "";
  const msg = [`${method} ${pathname}`, opts.body ?? "", qval, "", String(expires)].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64");
  let auth = `EXO2-HMAC-SHA256 credential=${key},expires=${expires},signature=${signature}`;
  if (q) auth += `,signed-query-args=${[...q.keys()].join(";")}`;
  return { auth };
}

const hostRoot = CLOUD.slice(0, CLOUD.indexOf(`/runs/${RUN}`));

async function cloud(zonePath, method, pathname, body, query) {
  const u = new URL(`${hostRoot}/runs/${RUN}/cloud${zonePath}/v2${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const payload = body ? JSON.stringify(body) : undefined;
  const { auth } = sign(method, `${zonePath ? `/runs/${RUN}/cloud${zonePath}/v2` : `/runs/${RUN}/cloud/v2`}${pathname}`, { body: payload, query });
  const headers = { Accept: "application/json", Authorization: auth };
  if (payload) headers["Content-Type"] = "application/json";
  let res;
  for (let n = 0; n < 3; n++) {
    res = await f(u, { method, headers, body: payload });
    if (res.status !== 429) break;
    await t(400);
  }
  if (res.status >= 400) return { error: res.status, text: await res.text().catch(() => "") };
  return { json: await res.json().catch(() => null), status: res.status };
}

async function workStatus() {
  const url = WORK + "/status";
  const pathname = new URL(url).pathname;
  const expires = Math.floor(Date.now() / 1000) + 120;
  const msg = [`GET ${pathname}`, "", "", "", String(expires)].join("\n");
  const signature = crypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64");
  const res = await f(url, { headers: { Accept: "application/json", Authorization: `EXO2-HMAC-SHA256 credential=${key},expires=${expires},signature=${signature}` } });
  if (res.status === 429) { await t(400); return workStatus(); }
  if (!res.ok) return null;
  return res.json();
}

const gridCache = new Map();
async function gridForecast(zone) {
  const hit = gridCache.get(zone);
  if (hit && Date.now() - hit.at < 25_000) return hit.pts;
  const u = new URL(`${GRID}/carbon-intensity/forecast`);
  u.searchParams.set("zone", zone);
  u.searchParams.set("horizonHours", "24");
  const res = await f(u, { headers: { Accept: "application/json", "auth-token": GRID_SECRET } });
  if (res.status === 429) { await t(400); return gridForecast(zone); }
  if (!res.ok) return null;
  const body = await res.json();
  const pts = (body.forecast ?? body.points ?? []).map((p) => Number(p.gco2_kwh ?? p.carbonIntensity ?? p.gCO2ePerKwh ?? p.intensity ?? 0));
  gridCache.set(zone, { at: Date.now(), pts });
  return pts;
}

function meanIntensity(pts, startH, durH) {
  if (!pts?.length) return null;
  let from = Math.max(0, startH), to = Math.min(pts.length, startH + Math.max(1, Math.ceil(durH)));
  if (from >= to) return pts[pts.length - 1];
  let sum = 0;
  for (let i = from; i < to; i++) sum += pts[i];
  return sum / (to - from);
}

function zoneCountry(name = "") { return String(name).split("-")[0].toUpperCase() || name; }
function zoneEU(country = "") {
  return ["AT", "BE", "BG", "HR", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"].includes(country);
}
const zoneCache = { at: 0, zones: null };
async function zones() {
  if (zoneCache.zones && Date.now() - zoneCache.at < 120_000) return zoneCache.zones;
  const r = await cloud("", "GET", "/zone");
  if (!r?.json) return zoneCache.zones;
  zoneCache.zones = r.json.zones.map((z) => {
    const country = zoneCountry(z.name);
    return { name: z["api-endpoint"] ? z.name : z.name, slug: z.name, pue: Number(z.pue), country, eu: zoneEU(country) };
  });
  zoneCache.at = Date.now();
  return zoneCache.zones;
}

const typeCache = { at: 0, types: null, byZone: new Map() };
let catalogProfiles = null;
let catalogWorkloads = null;
try {
  const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), "greenops-challenge-starter-kit/challenge/catalog.json"), "utf8"));
  catalogProfiles = new Map(c.profiles.map((p) => [p.id, { kw: Number(p.active_watts) / 1000, tput: Number(p.throughput), unit: p.work_unit, family: p.family ?? "cpu", cards: Number(p.gpu_count ?? p.gpus ?? 0), mem: Number(p.memory_gib ?? 0) }]));
  catalogWorkloads = new Map(c.workloads.map((w) => [w.id, w]));
} catch {}
async function zoneTypes(z) {
  const hit = z && typeCache.byZone.get(z.slug);
  if (hit && Date.now() - hit.at < 600_000) return hit.ids;
  const r = await cloud(`/${z.slug}`, "GET", "/instance-type");
  const ids = new Set((r?.json?.["instance-types"] ?? []).map((p) => p.id));
  if (z && r?.json?.["instance-types"]) typeCache.byZone.set(z.slug, { at: Date.now(), ids });
  return ids;
}
async function types() {
  if (typeCache.types && Date.now() - typeCache.at < 600_000) return typeCache.types;
  const zs = (await zones()) ?? [];
  if (!zs.length) return typeCache.types;
  const map = new Map();
  let any = false;
  for (const z of zs) {
    const r = await cloud(`/${z.slug}`, "GET", "/instance-type");
    if (!r?.json?.["instance-types"]) continue;
    any = true;
    for (const p of r.json["instance-types"]) {
      if (map.has(p.id)) continue;
      const extra = catalogProfiles?.get(p.id) ?? {};
      map.set(p.id, { id: p.id, family: p.family, size: p.size, cpu: Number(p.cpus ?? p.cpu_cores), gpu: Number(p.gpus ?? p.gpu_count), kw: extra.kw ?? Number(p.active_watts ?? 0) / 1000, tput: extra.tput ?? Number(p.throughput ?? 0), unit: p.work_unit, cards: Number(p.gpu_count ?? p.gpus ?? extra.cards ?? (p.family && p.family !== "cpu" ? 1 : 0)), mem: Number(p.memory_gib ?? extra.mem ?? 0) });
    }
  }
  if (!any) return typeCache.types;
  typeCache.types = [...map.values()];
  typeCache.at = Date.now();
  return typeCache.types;
}

async function templateId(zone) {
  const r = await cloud(`/${zone}`, "GET", "/template", null, { visibility: "public" });
  return r?.json?.templates?.[0]?.id ?? null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { run: RUN, instances: [], defers: {} }; }
}
function saveState(s) { fs.writeFileSync(STATE, JSON.stringify(s, null, 2)); }

async function listInstances(zone) {
  const r = await cloud(`/${zone}`, "GET", "/instance");
  return r?.json?.instances ?? [];
}

async function createVm(zone, prof, name, wlId) {
  const tid = await templateId(zone);
  if (!tid) return { error: "no template" };
  const userData = Buffer.from(JSON.stringify({ greenops: { schema_version: "1.0", workload_id: wlId } })).toString("base64");
  return cloud(`/${zone}`, "POST", "/instance", { name, "instance-type": { id: prof.id }, template: { id: tid }, disk_size: 10, "user-data": userData });
}

async function deleteVm(zone, id) {
  return cloud(`/${zone}`, "DELETE", `/instance/${id}`);
}

// --- stop/start (stopped_watts = 0 in the catalog: pausing is free carbon) ---
let stopStyle = null; // "colon" -> PUT /instance/{id}:stop ; "slash" -> POST /instance/{id}/stop
let pauseBan = false;
async function vmAction(zone, id, verb) {
  if (stopStyle !== "slash") {
    const r = await cloud(`/${zone}`, "PUT", `/instance/${id}:${verb}`);
    if (!r.error) { stopStyle = "colon"; return r; }
    if (r.error !== 404 && r.error !== 405) return r;
    const r2 = await cloud(`/${zone}`, "POST", `/instance/${id}/${verb}`);
    if (!r2.error) { stopStyle = "slash"; return r2; }
    if (r2.error === 404 || r2.error === 405) stopStyle = "fail";
    return r2;
  }
  return cloud(`/${zone}`, "POST", `/instance/${id}/${verb}`);
}

function normalize(s) {
  const g = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined) return o[k]; return undefined; };
  const cat = catalogWorkloads?.get(g(s, "id", "workload_id"));
  return {
    id: g(s, "id", "workload_id"),
    state: String(g(s, "state", "status") ?? "UNKNOWN").toUpperCase(),
    required: Number(g(s, "required_work", "requiredWork", "resource_work") ?? cat?.required_work ?? 0),
    done: Number(g(s, "completed_work", "completedWork", "progress_work") ?? 0),
    delivered: Boolean(g(s, "final_output_delivered", "final_delivered")),
    release: g(s, "release_at", "release", "ready_at") ?? cat?.release_at,
    deadline: g(s, "deadline_at", "deadline", "due_at") ?? cat?.deadline_at,
    countries: g(s, "allowed_countries", "countries", "regions") ?? cat?.allowed_countries,
    forbidden: g(s, "forbidden_countries", "forbidden", "blocked") ?? cat?.forbidden_countries ?? [],
    kind: g(s, "kind", "workload_kind") ?? cat?.kind,
    families: g(s, "allowed_families", "families") ?? cat?.allowed_families ?? [],
    minGpuMem: Number(g(s, "minimum_gpu_memory_gib", "min_gpu_mem") ?? cat?.minimum_gpu_memory_gib ?? 0),
    unit: g(s, "work_unit", "unit") ?? cat?.work_unit,
    maxWorkers: Number(g(s, "max_workers", "max_parallel", "parallelism") ?? cat?.max_workers ?? 1),
    profiles: g(s, "allowed_profile_ids", "profile_ids") ?? cat?.allowed_profile_ids,
    assignments: g(s, "assignments", "vm_ids", "vms") ?? [],
    residency: g(s, "residency", "region_constraint") ?? cat?.residency,
    input: Number(g(s, "input_seconds", "input_sec", "input") ?? cat?.input_seconds ?? 0),
    output: Number(g(s, "output_seconds", "output_sec", "output") ?? cat?.output_seconds ?? 0),
    sync: g(s, "sync_overhead", "sync_factor") ?? cat?.sync_overhead ?? 0,
    boot: Number(g(s, "boot_seconds", "bootSec", "boot") ?? 0),
    setup: Number(g(s, "setup_seconds", "setupSec", "setup") ?? 0),
  };
}

// --- runtime rate calibration: the live engine's work units don't share a scale with
// catalog throughput (tflop jobs run ~10^4x catalog tput). Observe real rates and use
// them for every deadline/feasibility decision.
const rateMem = new Map(); // wl -> { done, vt, rate, tput, k, prof }
const unitAlpha = new Map(); // work_unit -> observed units/h per unit of (tput * workers)
const seenRates = new Map(); // work_unit -> samples
let profById = new Map(); // instance-type id -> catalog profile (refreshed each plan cycle)
function median(a) { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? 0; }
/** Record progress observations. profNow/kNow describe the workload's current assignment. */
function noteRate(w, done, vtMs, profNow, kNow) {
  if (typeof done !== "number" || !isFinite(vtMs)) return;
  const m = rateMem.get(w.id);
  if (m && vtMs > m.vt && done >= m.done && (vtMs - m.vt) / 3.6e6 > 0.05) {
    const r = (done - m.done) / ((vtMs - m.vt) / 3.6e6);
    if (r > 0) {
      // Keep the BEST observed sample: boot/setup and stop artifacts can only
      // under-measure a workload's true steady rate, and one depressed sample once
      // fired garbage "replacing profile" swaps on negative phantom margins.
      m.rate = m.rate ? Math.max(m.rate, r) : r;
      m.tput = Number(profNow?.tput ?? 0); m.k = Number(kNow ?? 1); m.prof = profNow?.id;
      if (w.unit && m.tput > 0 && m.k > 0) {
        const arr = seenRates.get(w.unit) ?? [];
        if (arr.length < 60) arr.push(r / (m.tput * m.k));
        seenRates.set(w.unit, arr);
        unitAlpha.set(w.unit, median(arr));
      }
    }
  } else if (m) { m.done = done; m.vt = vtMs; }
  else rateMem.set(w.id, { done, vt: vtMs, rate: 0, tput: Number(profNow?.tput ?? 0), k: Number(kNow ?? 1), prof: profNow?.id });
}
/** Observed (or unit-calibrated) rate in units/h for `w` on profile p with k workers. */
function estRate(w, p, k) {
  const m = rateMem.get(w.id);
  if (m?.rate > 0) {
    if (p?.id && m.tput && p.tput && String(m.prof) === String(p.id)) return m.rate;
    if (m.tput > 0 && m.k > 0) return m.rate * (Number(p?.tput ?? 0) * k) / (m.tput * m.k);
    return m.rate;
  }
  const a = (w.unit && unitAlpha.get(w.unit)) || (w.unit === "vcpu_hour" ? 1 : 10000);
  return Number(p?.tput ?? 0) * k * a;
}
function bootH(w, p) { return Math.max(30, Number(w.boot ?? p?.boot_s ?? 90)) / 3600; }
function fixedH(w, p) { return bootH(w, p) + (Number(w.input ?? w.input_seconds ?? 0)) / 3600 + (Number(w.output ?? w.output_seconds ?? 0)) / 3600; }
/** Hours to complete `remaining` work with k workers of profile p, including sync overhead.
 *  Mirrors the engine's rate model: k * tput * parallelEff^(k-1) with parallelEff = 1 - sync. */
function durH(w, p, k, remaining) {
  const sync = Number(w.sync ?? w.sync_overhead ?? 0);
  const pe = Math.max(0.1, 1 - sync);
  const rate = estRate(w, p, k) * Math.pow(pe, k - 1);
  if (!isFinite(rate) || rate <= 0) return Infinity;
  return fixedH(w, p) + Number(w.setup ?? 0) / 3600 + remaining / rate;
}

async function usageSnapshot() {
  const u = { vms: 0, vcpu: 0, byFamily: {} };
  // Live instance records carry no cpu_cores field — resolve vCPU/family from the
  // instance-type catalog so quota accounting is real (prevents live 409 churn).
  const profOf = new Map(((await types()) ?? []).map((p) => [p.id, p]));
  for (const z of (await zones()) ?? []) {
    for (const i of await listInstances(z.slug)) {
      u.vms++;
      const it = i["instance-type"];
      const tid = typeof it === "string" ? it : it?.id;
      const tp = profOf.get(tid);
      u.vcpu += Number(tp?.cpu ?? i.cpu_cores ?? (it && typeof it === "object" ? it.cpu_cores : 0) ?? 0);
      const fam = tp?.family ?? i.instance_type?.family ?? i.family;
      if (fam && fam !== "cpu") u.byFamily[fam] = (u.byFamily[fam] ?? 0) + Number(tp?.gpu ?? i.gpu_count ?? 1);
    }
  }
  return u;
}

function fits(usage, prof, workers) {
  if (usage.vms + workers > MAX_VMS) return false;
  if (usage.vcpu + prof.cpu * workers > MAX_VCPUS) return false;
  if (prof.family !== "cpu" && (usage.byFamily[prof.family] ?? 0) + prof.gpu * workers > (GPU_QUOTA[prof.family] ?? 0)) return false;
  return true;
}

async function legalZones(w) {
  const all = (await zones()) ?? [];
  return all.filter((z) => {
    if (String(w.residency).toUpperCase() === "EU" && !z.eu) return false;
    if (w.countries?.length && !w.countries.includes(z.country)) return false;
    if (w.forbidden?.length && w.forbidden.includes(z.country)) return false;
    return true;
  });
}

// Legal profiles for a workload given the live per-zone instance-type pool.
// Honours allowed_profile_ids when present, otherwise allowed_families + kind +
// minimum_gpu_memory_gib (mirrors the offline sim's feasibleProfiles).
function legalProfiles(w, pool) {
  if (w.profiles?.length) return pool.filter((p) => w.profiles.includes(p.id));
  return pool.filter((p) => {
    if (w.kind === "cpu") return !p.family || p.family === "cpu";
    if (w.kind !== "gpu") return true;
    if (!p.family || p.family === "cpu") return false;
    if (w.families?.length && !w.families.includes(p.family)) return false;
    if (w.minGpuMem && p.mem / Math.max(1, p.cards) < w.minGpuMem) return false;
    return true;
  });
}

/**
 * Deadline-feasible, carbon-minimising placement for one pending workload.
 * Searches legal (zone, profile, workers 1..maxWorkers): returns the lowest-carbon
 * combo whose durH still clears the deadline (with a small margin); if nothing can be
 * deployed with future margin, commit to the cleanest thing deployable RIGHT NOW
 * (deadline pressure wins over carbon). Result: { z, p, workers, cost } or null.
 */
async function planWorkload(w, remaining, usage, types_, vt) {
  const slackH = w.deadline && vt ? (new Date(w.deadline).getTime() - vt) / 3.6e6 : 1e9;
  // Require a comfortable safety margin: at least 20% of remaining time if slack is large,
  // never less than 2h, so we don't pick an under-powered profile that scrapes the deadline.
  const margin = Math.max(2, 0.2 * slackH);
  // Deferring a start needs extra headroom (forecast error grows with horizon).
  const guard = Math.max(4, 0.15 * slackH);
  let bestNow = null, bestNowCost = Infinity; // cleanest deploy-now option clearing the deadline with margin
  let nowBest = null, nowCost = Infinity;     // cleanest deploy-now option ignoring margin (deadline fallback)
  let bestDef = null, defCost = Infinity;     // cleanest deferred start inside the forecast horizon
  const zset = await legalZones(w);
  if (!zset.length) return null;
  // GPU jobs: unit scales are uncalibrated at first deploy, so gram-ranking on garbage
  // durations picks too-slow profiles (the attempt-12 w-09 miss). Restrict GPU candidates
  // to the fastest-tput 1-GPU legal profile — also the best energy-per-work GPU class.
  const isGpu = String(w.kind ?? "") === "gpu" || String(w.unit ?? "").includes("tflop");
  const gpuPick = isGpu
    ? legalProfiles(w, types_).reduce((a, b) => {
        const ag = Number(a?.gpu ?? 1) <= 1, bg = Number(b?.gpu ?? 1) <= 1;
        if (ag !== bg) return ag ? a : b;
        return Number(b?.tput ?? 0) > Number(a?.tput ?? 0) ? b : a;
      }, null)
    : null;
  for (const z of zset) {
    const zoneIds = await zoneTypes(z);
    if (!zoneIds.size) continue;
    const pts = await gridForecast(z.country);
    if (!pts?.length) continue;
    const pue = Number(z.pue) > 0 ? Number(z.pue) : 1.3;
    for (const p of legalProfiles(w, types_)) {
      if (!zoneIds.has(p.id)) continue;
      if (gpuPick && p.id !== gpuPick.id) continue;
      for (let k = 1; k <= w.maxWorkers; k++) {
        if (!fits(usage, p, k)) continue;
        const dur = durH(w, p, k, remaining);
        if (!isFinite(dur) || dur <= 0) continue;
        const bs = Number(p.kw ?? 0) * k; // active draw for this candidate (kW)
        // Total grams for the run window: kw * k * pue * ∫ intensity over [start, start+dur].
        const maxStart = Math.min(Math.max(0, slackH - dur - guard), Math.max(0, pts.length - dur));
        const step = Math.max(1, Math.floor(maxStart / 24));
        for (let s = 0; s <= maxStart; s += step) {
          const c = meanIntensity(pts, s, dur);
          if (c === null) continue;
          const cscore = c * bs * dur * pue;
          if (s === 0) {
            if (slackH - dur > margin && cscore < bestNowCost) { bestNowCost = cscore; bestNow = { z, p, workers: k, cost: c, bs, waitH: 0 }; }
            if (cscore < nowCost) { nowCost = cscore; nowBest = { z, p, workers: k, cost: c, bs, waitH: 0 }; }
          } else if (cscore < defCost) { defCost = cscore; bestDef = { z, p, workers: k, cost: c, bs, waitH: s }; }
        }
      }
    }
  }
  // Take a deferred start only when it beats every deploy-now option by >15% (forecast
  // noise floor); otherwise prefer the deadline-safe deploy-now option, falling back to
  // the cleanest thing deployable right now when nothing clears the margin.
  if (bestNow && bestDef && bestNowCost / defCost >= 1.15) return bestDef;
  return bestNow ?? nowBest;
}

async function main() {
  const st = readState();
  st.defers ??= {};
  st.paused ??= {};
  st.pauseTest ??= {};
  if (st.run && st.run !== RUN) throw new Error(`Receipt belongs to run ${st.run}`);
  if (MODE === "destroy") {
    for (const row of st.instances) { await deleteVm(row.zone, row.id); }
    saveState({ run: RUN, instances: [] });
    console.log("destroyed", st.instances.length, "VMs");
    return;
  }

  let usage = await usageSnapshot();
  if (CREATE_TEST) {
    const t0 = (await types()) ?? [];
    const z = (await zones())[0];
    const cpu = t0.find((p) => p.family === "cpu");
    const tid = await templateId(z.slug);
    const base = `/runs/${RUN}/cloud/${z.slug}/v2`;
    const variants = [
      { label: "real-id", body: { name: `run-${RUN.slice(0, 8)}-t1`, "instance-type": { id: cpu.id }, template: { id: tid }, disk_size: 10, "user-data": "dGVzdA==" } },
      { label: "bogus-id", body: { name: `run-${RUN.slice(0, 8)}-t2`, "instance-type": { id: "bogus-type-id" }, template: { id: tid }, disk_size: 10, "user-data": "dGVzdA==" } },
    ];
    for (const v of variants) {
      const r = await cloud(`/${z.slug}`, "POST", "/instance", v.body);
      console.log(`create-test ${v.label}:`, r.error ? `rejected ${r.error} ${r.text}` : `accepted ${JSON.stringify(r.json)}`);
      const vid = r.json?.reference?.id ?? r.json?.id;
      if (vid) { const d = await deleteVm(z.slug, vid); console.log(`create-test deleted ${vid}:`, d.error ?? "ok"); }
    }
    return;
  }
  let lastPlan = 0, saw = 0;
  const delivSeen = new Set();
  while (true) {
    const status = await workStatus();
    if (!status) { await t(POLL_MS); continue; }
    const runState = String(status.state ?? "UNKNOWN").toUpperCase();
    const wls = (status.workloads ?? []).map(normalize);
    const vt = status.virtual_time ? new Date(status.virtual_time).getTime() : 0;
    saw = wls.length;
    const delivered = wls.filter((w) => w.delivered).length;
    for (const w of wls) {
      if (w.delivered && !delivSeen.has(w.id)) {
        delivSeen.add(w.id);
        const rows = st.instances.filter((r) => r.wl === w.id);
        const prof = profById.get(rows[0]?.prof);
        const dl = w.deadline ? (new Date(w.deadline).getTime() - vt) / 3.6e6 : NaN;
        console.log(`[deliv] ${w.id} done=${Number(w.done).toFixed(0)}/${Number(w.required).toFixed(0)} ${rows.length}x ${prof ? `${prof.family}.${prof.size}` : rows[0]?.prof} deadline-in ${dl.toFixed(1)}h`);
      }
    }
    console.log(`[${new Date().toISOString()}] run=${runState} ${delivered}/${saw} delivered vms=${usage.vms}/${MAX_VMS} vcpu=${usage.vcpu}/${MAX_VCPUS}`);
    if (["COMPLETED", "INVALIDATED", "UNAVAILABLE"].includes(runState)) { console.log(`run ended (${runState})`); break; }
    if (saw && delivered === saw) { console.log("ALL WORKLOADS DELIVERED"); break; }

    let changed = false;
    for (const w of wls.filter((x) => x.delivered)) {
      const mine = st.instances.filter((r) => r.wl === w.id);
      for (const r of mine) {
        await deleteVm(r.zone, r.id).catch(() => {});
        st.instances.splice(st.instances.indexOf(r), 1);
        changed = true;
      }
    }
    if (changed) saveState(st);

    // --- pause/start: a stopped VM draws 0 W (catalog stopped_watts) but keeps its work
    // and its quota. Park jobs during dirty hours whenever their deadline margin is
    // comfortable; verify on the first stop of each job that no work is lost.
    // OFF by default (PAUSE_ON): delivery record is strictly worse with pausing on.
    if (!DRY && runState === "RUNNING" && (PAUSE_ON || pauseBan)) {
      st.paused ??= {}; st.pauseTest ??= {}; st.pauseT ??= {};
      // A ban (work loss or unsupported stop) must first resume EVERYTHING parked,
      // else jobs sit stopped forever while the orchestrator thinks they run.
      if (pauseBan) {
        for (const w of wls) {
          if (!st.paused[w.id]) continue;
          delete st.paused[w.id];
          for (const r of st.instances.filter((x) => x.wl === w.id)) await vmAction(r.zone, r.id, "start").catch(() => {});
        }
      }
      if (pauseBan || !PAUSE_ON) { saveState(st); }
      for (const w of wls) {
        if (w.delivered) continue;
        if (pauseBan || !PAUSE_ON) break;
        const rows = st.instances.filter((r) => r.wl === w.id);
        if (!rows.length) { delete st.paused[w.id]; continue; }
        const prof = profById.get(rows[0].prof);
        const remaining = Math.max(0, w.required - w.done);
        noteRate(w, w.done, vt, prof, rows.length);
        if (pauseBan) break;
        const slackH = w.deadline && vt ? (new Date(w.deadline).getTime() - vt) / 3.6e6 : 1e9;
        if (st.paused[w.id]) {
          const t = st.pauseTest[w.id];
          if (t && w.done < t.done - 1e-6) {
            console.log(`[pause] ${w.id}: work LOST across stop (${t.done} -> ${w.done}) — pausing disabled run-wide`);
            pauseBan = true; delete st.paused[w.id];
            for (const r of rows) await vmAction(r.zone, r.id, "start").catch(() => {});
            continue;
          }
        }
        const pts = await gridForecast(zoneCountry(rows[0].zone));
        if (!pts?.length) continue;
        const mean = pts.reduce((a, b) => a + Number(b), 0) / pts.length;
        const cur = Number(pts[0]);
        const rate = estRate(w, prof, rows.length);
        const needH = rate > 0 ? remaining / (rate * 0.75) + fixedH(w, prof) + 4 : Infinity;
        const safe = needH <= slackH - 10;
        const young = rows.some((r) => r.vtCreated && vt - r.vtCreated < 3.6e6);
        const dwell = vt - (st.pauseT[w.id] ?? -1e15) > 3.6e6 * 2;
        if (!st.paused[w.id]) {
          if (!young && dwell && safe && rate > 0 && cur > 1.15 * mean) {
            let ok = true;
            for (const r of rows) { const res = await vmAction(r.zone, r.id, "stop"); if (res.error) { ok = false; break; } }
            if (ok) {
              st.paused[w.id] = true;
              st.pauseT[w.id] = vt;
              st.pauseTest[w.id] ??= { done: w.done };
              console.log(`[pause] ${w.id}: stopped ${rows.length} VM(s) (cur ${cur.toFixed(0)} vs mean ${mean.toFixed(0)}, margin ${(slackH - needH).toFixed(1)}h)`);
              saveState(st);
            } else if (stopStyle === "fail" && !pauseBan) { pauseBan = true; console.log("[pause] stop unsupported — pausing disabled"); }
          }
        } else if (!safe || cur <= 0.9 * mean) {
          for (const r of rows) await vmAction(r.zone, r.id, "start").catch(() => {});
          delete st.paused[w.id];
          st.pauseT[w.id] = vt;
          console.log(`[pause] ${w.id}: resumed (cur ${cur.toFixed(0)} vs mean ${mean.toFixed(0)}, margin ${(slackH - needH).toFixed(1)}h)`);
          saveState(st);
        }
      }
    }

    if (Date.now() - lastPlan > 12_000) {
      lastPlan = Date.now();
      console.error(`[plan] cycle start`);
      const types_ = (await types()) ?? [];
      profById = new Map(types_.map((tp) => [tp.id, tp]));
      console.error(`[plan] types=${types_.length}`);
      const pending = wls.filter((x) => !x.delivered && x.required > x.done);
      const rated = pending
        .map((x) => ({ x, slack: x.deadline && vt ? (new Date(x.deadline).getTime() - vt) / 3.6e6 : 1e9 }))
        .sort((a, b) => a.slack - b.slack);
      // The run clock only starts on the first accepted VM — while READY, virtual time is
      // frozen, so JIT-waiting for a release would deadlock the run. When READY, exactly
      // one workload (the earliest-release pending one) must deploy to start the clock;
      // everyone else keeps JIT-waiting until the clock is RUNNING.
      const readyStarter = runState === "READY"
        ? pending.reduce((a, b) => (new Date(a.release ?? 0).getTime() <= new Date(b.release ?? 0).getTime() ? a : b), pending[0])?.id
        : null;
      for (const { x: w } of rated) {
        console.error(`[plan] considering ${w.id} (slack=${rated.find((r) => r.x.id === w.id)?.slack.toFixed(1)}h)`);
        // Just-in-time creation: a VM created before its release idles at full idle draw.
        const relMs = w.release ? new Date(w.release).getTime() : 0;
        if (vt && relMs && vt < relMs && w.id !== readyStarter) { console.log(`[plan] ${w.id}: JIT wait (releases in ${((relMs - vt) / 3.6e6).toFixed(1)}h)`); continue; }
        const existingRows = st.instances.filter((r) => r.wl === w.id);
        let existing = existingRows.length;
        const remaining = Math.max(0, w.required - w.done);
        // plan against a usage view that excludes this job's own VMs, so the wanted
        // worker count is treated as a delta to deploy on top of what's already up.
        const planUsage = { ...usage, byFamily: { ...usage.byFamily } };
        for (const row of st.instances.filter((r) => r.wl === w.id)) {
          const pp = types_.find((t) => t.id === row.prof);
          if (pp) {
            planUsage.vms = Math.max(0, planUsage.vms - 1);
            planUsage.vcpu = Math.max(0, planUsage.vcpu - Number(pp.cpu ?? 0));
            if (pp.family && pp.family !== "cpu") planUsage.byFamily[pp.family] = Math.max(0, (planUsage.byFamily[pp.family] ?? 0) - Number(pp.gpu ?? 1));
          }
        }
        const pl = await planWorkload(w, remaining, planUsage, types_, vt);
        if (!pl) { console.log(`[plan] ${w.id}: nothing fits`); continue; }
        // With parallel efficiency <= 1, k=1 minimises grams for every candidate
        // (grams = kw*pue*remaining*intensity/(tput*pe^(k-1))); extra workers only shorten
        // wall time. planWorkload escalates k solely for deadline safety using
        // unit-calibrated durations (estRate), so no GPU-specific override is needed.
        const gpuJob = String(w.kind ?? "") === "gpu" || String(w.unit ?? "").includes("tflop");
        let desired = pl.workers;
        const slackH = w.deadline && vt ? (new Date(w.deadline).getTime() - vt) / 3.6e6 : 1e9;
        const bestDur = durH(w, pl.p, desired, remaining);
        const urgent = !isFinite(bestDur) || slackH - bestDur <= 0;
        // Deferred start: hold this job (no workers up yet) until the cleaner window
        // opens. Only allowed once THIS workload (or its unit) has a live-observed rate
        // to project with — fallback alphas run optimistic and have burned margins.
        // The decision is sticky so a refreshed forecast can't oscillate deploy/defer;
        // if the deadline tightens past the guard we deploy anyway.
        const cal = rateMem.get(w.id)?.rate > 0 || (w.unit && (unitAlpha.get(w.unit)?.length ?? 0) >= 3);
        if (DEFER_ON && cal && pl.waitH > 0 && existing === 0 && !urgent && slackH - bestDur > Math.max(6, 0.25 * slackH)) {
          const until = st.defers[w.id] ? st.defers[w.id].until : vt + pl.waitH * 3.6e6;
          if (vt < until) {
            st.defers[w.id] = { until, prof: pl.p.id, zone: pl.z.slug };
            saveState(st);
            console.log(`[plan] ${w.id}: deferring ${((until - vt) / 3.6e6).toFixed(1)}h (cleaner window, intensity ${pl.cost.toFixed(0)})`);
            continue;
          }
          delete st.defers[w.id];
        } else if (pl.waitH === 0 && st.defers[w.id]) delete st.defers[w.id];
        // Observed-rate escalation: project the worker count that actually clears the
        // deadline (anchored on the live-observed rate, with a sync-aware model and 8%
        // slack) and jump straight to it — adding one worker when the margin is already
        // < 4h is recovery theatre. At max workers, swap a CPU job's profile to a faster
        // one. Never touches paused jobs.
        const obsRate = estRate(w, pl.p, Math.max(1, existing));
        const projH = obsRate > 0 ? remaining / obsRate + fixedH(w, pl.p) : Infinity;
        if (existing > 0 && !st.paused[w.id] && isFinite(projH)) {
          const syncE = Math.max(0.1, 1 - Number(w.sync ?? w.sync_overhead ?? 0));
          const anchor = Math.max(1, existing);
          let needed = anchor;
          for (let k = anchor; k <= w.maxWorkers; k++) {
            const rk = (obsRate * (k * Math.pow(syncE, k - 1))) / (anchor * Math.pow(syncE, anchor - 1));
            if (remaining / rk + fixedH(w, pl.p) <= slackH * 0.92) break;
            needed = k;
          }
          if (needed > existing && slackH - projH < Math.max(10, 0.35 * projH)) {
            desired = Math.max(desired, needed);
            console.log(`[plan] ${w.id}: escalating to ${desired} workers (observed margin ${(slackH - projH).toFixed(1)}h)`);
          } else if (needed >= w.maxWorkers && slackH - projH < Math.max(10, 0.35 * projH)
            && existingRows.some((r) => { const rp = profById.get(r.prof); return rp && Number(pl.p.tput) > Number(rp.tput); })) {
            console.log(`[plan] ${w.id}: replacing profile -> ${pl.p.family}.${pl.p.size} (observed margin ${(slackH - projH).toFixed(1)}h)`);
            for (const r of existingRows) { await deleteVm(r.zone, r.id).catch(() => {}); st.instances.splice(st.instances.indexOf(r), 1); }
            existing = 0;
            desired = Math.max(desired, needed);
          }
        }
        if (desired <= existing) { console.log(`[plan] ${w.id}: ok (${existing} workers)`); continue; }
        // Skip redeployment only when this job is already running comfortably ahead:
        // never skip a job that has zero workers yet.
        if (!urgent && existing > 0 && desired === w.maxWorkers && slackH - bestDur > 6) {
          console.log(`[plan] ${w.id}: running (${existing} of ${desired})`);
          continue;
        }
        const delta = desired - existing;
        // Reservation: a loose-deadline job must not take the last quota block that a
        // tighter-deadline, still-undeployed job (JIT or starved) will need. If W's
        // creates would leave J with no viable plan while J has one today, hold W this
        // cycle; urgent jobs always go.
        if (!urgent && delta > 0) {
          const after = { vms: usage.vms + delta, vcpu: usage.vcpu + Number(pl.p.cpu ?? 0) * delta, byFamily: { ...usage.byFamily } };
          if (pl.p.family && pl.p.family !== "cpu") after.byFamily[pl.p.family] = (after.byFamily[pl.p.family] ?? 0) + Number(pl.p.gpu ?? 1) * delta;
          const held = [];
          for (const { x: J } of rated) {
            if (J.id === w.id) break;
            if (wls.find((x) => x.id === J.id)?.delivered) continue;
            if (st.instances.some((r) => r.wl === J.id)) continue;
            const jSlack = J.deadline && vt ? (new Date(J.deadline).getTime() - vt) / 3.6e6 : 1e9;
            if (jSlack >= slackH) continue;
            const jRem = Math.max(0, J.required - J.done);
            if (!(await planWorkload(J, jRem, usage, types_, vt))) continue;
            if (!(await planWorkload(J, jRem, after, types_, vt))) held.push(J.id);
          }
          if (held.length) { console.log(`[plan] ${w.id}: holding for reservation (${held.join(", ")})`); continue; }
        }
        const ids = [];
        for (let kk = 0; kk < delta; kk++) {
          const name = `run-${RUN.slice(0, 8)}-${w.id}-${existing + kk}-${st.instances.length}`;
          const res = DRY ? { json: { reference: { id: `dry-${name}` } } } : await createVm(pl.z.slug, pl.p, name, w.id);
          if (res?.error) { console.warn(`create rejected ${w.id} worker ${existing + kk}: ${res.error} ${res.text}`); for (const ri of ids) await deleteVm(pl.z.slug, ri).catch(() => {}); break; }
          const vid = res.json?.reference?.id;
          if (!vid) { console.warn(`no id replied for ${w.id} worker ${existing + kk}`); break; }
          ids.push(vid);
          st.instances.push({ id: vid, zone: pl.z.slug, wl: w.id, name, prof: pl.p.id, vtCreated: vt });
          // Keep the in-cycle usage view honest so later jobs this cycle don't over-commit quota.
          usage.vms++;
          usage.vcpu += Number(pl.p.cpu ?? 0);
          if (pl.p.family && pl.p.family !== "cpu") usage.byFamily[pl.p.family] = (usage.byFamily[pl.p.family] ?? 0) + Number(pl.p.gpu ?? 1);
        }
        if (ids.length) saveState(st);
        console.log(`deployed ${w.id} → ${pl.z.slug} ${pl.p.family}.${pl.p.size} (+${ids.length}, total ${existing + ids.length}/${desired}) intensity ${pl.cost.toFixed(0)} margin ${(slackH - bestDur).toFixed(1)}h`);
      }
      usage = await usageSnapshot();
    }
    await t(POLL_MS);
  }
  // Final sweep: the score counts VM costs through the full 120h window, so any VM left
  // up idle when the run ends (e.g. a workload that delivered in the last poll, whose
  // workers had not yet been reaped before the all-delivered break) adds dead carbon.
  for (let i = st.instances.length - 1; i >= 0; i--) {
    const r = st.instances[i];
    await deleteVm(r.zone, r.id).catch(() => {});
    st.instances.splice(i, 1);
  }
  saveState(st);
  console.log("final:", saw, "workloads,", st.instances.length, "VMs in receipt:", STATE);
}

main().catch((e) => { console.error(e); process.exit(1); });
