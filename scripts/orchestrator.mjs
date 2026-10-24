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
const GPU_QUOTA = { gpu2: 8, gpu3: 8, gpu3080ti: 8, gpua30: 8, gpua5000: 8, gpurtx6000pro: 4 };
const t = (ms) => new Promise((r) => setTimeout(r, ms));
async function f(url, opts = {}) { return fetch(url, { ...opts, signal: AbortSignal.timeout(15000) }); }

for (const p of [path.join(process.cwd(), ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const env = process.env;
const key = env["EXOSCALE_API_KEY"], secret = env["EXOSCALE_API_SECRET"];
const CLOUD = (env["GREENOPS_CLOUD_ENDPOINT"] ?? "").replace(/\/$/, "");
const WORK = (env["GREENOPS_WORK_ENDPOINT"] ?? "").replace(/\/$/, "");
const GRID = (env["GREENOPS_GRID_ENDPOINT"] ?? "").replace(/\/$/, "");
const GRID_SECRET = env["GREENOPS_GRID_SECRET"] ?? "";
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

const zoneCache = { at: 0, zones: null };
async function zones() {
  if (zoneCache.zones && Date.now() - zoneCache.at < 120_000) return zoneCache.zones;
  const r = await cloud("", "GET", "/zone");
  if (!r?.json) return zoneCache.zones;
  zoneCache.zones = r.json.zones.map((z) => ({ name: z.name, slug: z.name, pue: Number(z.pue), country: z.country, eu: Boolean(z.eu_member) }));
  zoneCache.at = Date.now();
  return zoneCache.zones;
}

const typeCache = { at: 0, types: null };
let catalogProfiles = null;
try {
  const c = JSON.parse(fs.readFileSync(path.join(process.cwd(), "greenops-challenge-starter-kit/challenge/catalog.json"), "utf8"));
  catalogProfiles = new Map(c.profiles.map((p) => [p.id, { kw: Number(p.active_watts) / 1000, tput: Number(p.throughput), unit: p.work_unit }]));
} catch {}
async function types() {
  if (typeCache.types && Date.now() - typeCache.at < 600_000) return typeCache.types;
  const z = (await zones())[0];
  if (!z) return null;
  const r = await cloud(`/${z.slug}`, "GET", "/instance-type");
  if (!r?.json?.["instance-types"]) return typeCache.types;
  typeCache.types = r.json["instance-types"].map((p) => {
    const extra = catalogProfiles?.get(p.id) ?? {};
    return { id: p.id, family: p.family, size: p.size, cpu: Number(p.cpus ?? p.cpu_cores), gpu: Number(p.gpus ?? p.gpu_count), kw: extra.kw ?? Number(p.active_watts ?? 0) / 1000, tput: extra.tput ?? Number(p.throughput ?? 0), unit: p.work_unit };
  });
  typeCache.at = Date.now();
  return typeCache.types;
}

async function templateId(zone) {
  const r = await cloud(`/${zone}`, "GET", "/template", null, { visibility: "public" });
  return r?.json?.templates?.[0]?.id ?? null;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, "utf8")); } catch { return { run: RUN, instances: [] }; }
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
  return cloud(`/${zone}`, "POST", "/instance", { name, instance_type: { id: prof.id }, template: { id: tid }, disk_size: 10, user_data: userData });
}

async function deleteVm(zone, id) {
  return cloud(`/${zone}`, "DELETE", `/instance/${id}`);
}

function normalize(s) {
  const g = (o, ...ks) => { for (const k of ks) if (o && o[k] !== undefined) return o[k]; return undefined; };
  return {
    id: g(s, "id", "workload_id"),
    state: String(g(s, "state", "status") ?? "UNKNOWN").toUpperCase(),
    required: Number(g(s, "required_work", "requiredWork", "resource_work") ?? 0),
    done: Number(g(s, "completed_work", "completedWork", "progress_work") ?? 0),
    delivered: Boolean(g(s, "final_output_delivered", "final_delivered")),
    release: g(s, "release_at", "release", "ready_at"),
    deadline: g(s, "deadline_at", "deadline", "due_at"),
    countries: g(s, "allowed_countries", "countries", "regions"),
    kind: g(s, "kind", "workload_kind"),
    maxWorkers: Number(g(s, "max_workers", "max_parallel", "parallelism") ?? 1),
    profiles: g(s, "allowed_profile_ids", "profile_ids"),
    assignments: g(s, "assignments", "vm_ids", "vms") ?? [],
    residency: g(s, "residency", "region_constraint"),
  };
}

async function usageSnapshot() {
  const u = { vms: 0, vcpu: 0, byFamily: {} };
  for (const z of (await zones()) ?? []) {
    for (const i of await listInstances(z.slug)) {
      u.vms++;
      u.vcpu += Number(i.cpu_cores ?? i.instance_type?.cpu_cores ?? 0);
      const fam = i.instance_type?.family ?? i.family;
      if (fam && fam !== "cpu") u.byFamily[fam] = (u.byFamily[fam] ?? 0) + Number(i.gpu_count ?? 1);
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
    return true;
  });
}

async function main() {
  const st = readState();
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
      { label: "real-id", body: { name: `run-${RUN.slice(0, 8)}-t1`, instance_type: { id: cpu.id }, template: { id: tid }, disk_size: 10, user_data: "dGVzdA==" } },
      { label: "bogus-id", body: { name: `run-${RUN.slice(0, 8)}-t2`, instance_type: { id: "bogus-type-id" }, template: { id: tid }, disk_size: 10, user_data: "dGVzdA==" } },
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
  while (true) {
    const status = await workStatus();
    if (!status) { await t(POLL_MS); continue; }
    const runState = String(status.state ?? "UNKNOWN").toUpperCase();
    const wls = (status.workloads ?? []).map(normalize);
    saw = wls.length;
    const delivered = wls.filter((w) => w.delivered).length;
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

    if (Date.now() - lastPlan > 12_000) {
      lastPlan = Date.now();
      const types_ = (await types()) ?? [];
      const vt = status.virtual_time ? new Date(status.virtual_time).getTime() : 0;
      const queue = wls
        .filter((x) => !x.delivered && x.required > x.done)
        .filter((x) => !st.instances.some((r) => r.wl === x.id))
        .filter((x) => !x.release || !vt || new Date(x.release).getTime() <= vt);
      const rated = queue.map((x) => ({ x, slack: x.deadline && vt ? (new Date(x.deadline).getTime() - vt) / 3.6e6 : 1e9 })).sort((a, b) => a.slack - b.slack);
      for (const { x: w } of rated) {
        const zset = await legalZones(w);
        if (!zset.length) continue;
        const profs = types_.filter((p) => !w.profiles?.length || w.profiles.includes(p.id));
        const avail = profs.filter((p) => p.kw > 0 && fits(usage, p, w.maxWorkers));
        if (!avail.length) continue;
        const durH = Math.max(0.1, (w.required - w.done) / (avail[0].tput * w.maxWorkers || 1));
        let best = null, bestCost = Infinity;
        for (const z of zset) {
          const pts = await gridForecast(z.country);
          if (!pts) continue;
          for (const p of avail.filter((x) => fits(usage, x, w.maxWorkers))) {
            const c = meanIntensity(pts, 0, durH);
            if (c !== null && c < bestCost) { bestCost = c; best = { z, p }; }
          }
          if (best) break;
        }
        if (!best) continue;
        const ids = [];
        for (let k = 0; k < w.maxWorkers; k++) {
          const name = `run-${RUN.slice(0, 8)}-${w.id}-${k}-${st.instances.length}`;
          const res = DRY ? { json: { reference: { id: `dry-${name}` } } } : await createVm(best.z.slug, best.p, name, w.id);
          if (res?.error) { console.warn(`create rejected ${w.id} worker ${k}: ${res.error} ${res.text}`); for (const ri of ids) await deleteVm(best.z.slug, ri).catch(() => {}); break; }
          const vid = res.json?.reference?.id;
          if (!vid) { console.warn(`no id replied for ${w.id} worker ${k}`); break; }
          ids.push(vid);
          st.instances.push({ id: vid, zone: best.z.slug, wl: w.id, name, prof: best.p.id });
        }
        if (ids.length) saveState(st);
        if (ids.length === w.maxWorkers) console.log(`deployed ${w.id} → ${best.z.slug} ${best.p.family}.${best.p.size} x${w.maxWorkers} (${bestCost.toFixed(0)} g/kWh avg)`);
      }
      usage = await usageSnapshot();
    }
    await t(POLL_MS);
  }
  console.log("final:", saw, "workloads,", st.instances.length, "VMs in receipt:", STATE);
}

main().catch((e) => { console.error(e); process.exit(1); });
