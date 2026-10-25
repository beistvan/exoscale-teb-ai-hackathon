#!/usr/bin/env node
/** GreenOps live controller (v3) — entrypoint.
 *
 *  Plans with scripts/greenops/policy.mjs (where + when to run), executes with the latency-tolerant
 *  loop in scripts/greenops/controller.mjs. Knowledge used: the vendored public catalog, this run's
 *  /work/v1/status, this run's currently published 24h forecasts, and this run's published grid
 *  observations (to correct those forecasts). Nothing else — no other run's data.
 *
 *  Usage: node scripts/orchestrator.mjs [--dry] [--state FILE]   run until all delivered / run ends
 *         node scripts/orchestrator.mjs destroy [--state FILE]   delete this controller's VMs
 *  Env:   EXOSCALE_API_KEY, EXOSCALE_API_SECRET, GREENOPS_CLOUD_ENDPOINT, GREENOPS_WORK_ENDPOINT,
 *         GREENOPS_GRID_ENDPOINT, GREENOPS_GRID_SECRET (also read from ./.env or /app/.env)
 *         GREENOPS_STATE_DIR (receipt + log; default: cwd if writable, else /tmp)
 */
import fs from "node:fs";
import path from "node:path";
import { loadCatalog } from "./greenops/model.mjs";
import { Controller } from "./greenops/controller.mjs";
import { makeLiveApi } from "./greenops/liveapi.mjs";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry");
const MODE = argv.includes("destroy") ? "destroy" : "run";
for (const p of [path.join(process.cwd(), ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const env = process.env;
const need = ["EXOSCALE_API_KEY", "EXOSCALE_API_SECRET", "GREENOPS_CLOUD_ENDPOINT", "GREENOPS_WORK_ENDPOINT", "GREENOPS_GRID_ENDPOINT", "GREENOPS_GRID_SECRET"];
const missing = need.filter((k) => !env[k]);
if (missing.length) { console.error(`Missing env: ${missing.join(", ")}`); process.exit(2); }

const writable = (d) => { try { fs.accessSync(d, fs.constants.W_OK); return true; } catch { return false; } };
const STATE_DIR = env.GREENOPS_STATE_DIR || (writable(process.cwd()) ? process.cwd() : "/tmp");
try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch {} // a missing log dir must not crash the run
const _si = argv.indexOf("--state");
const STATE = _si >= 0 && argv[_si + 1] ? argv[_si + 1] : path.join(STATE_DIR, "greenops-orchestrator-state.json");
const logFile = fs.createWriteStream(path.join(STATE_DIR, "orchestrator-run.log"), { flags: "a" });
const log = (...a) => { const s = `${new Date().toISOString().slice(11, 19)} ${a.map(String).join(" ")}`; console.log(s); logFile.write(s + "\n"); };
// one JSON object per line: decisions, acknowledgements (with latency + sim hours elapsed), status replies
const eventFile = fs.createWriteStream(path.join(STATE_DIR, "orchestrator-events.jsonl"), { flags: "a" });
const event = (o) => eventFile.write(JSON.stringify(o) + "\n");

const api = makeLiveApi({
  key: env.EXOSCALE_API_KEY, secret: env.EXOSCALE_API_SECRET,
  cloudEndpoint: env.GREENOPS_CLOUD_ENDPOINT, workEndpoint: env.GREENOPS_WORK_ENDPOINT,
  gridEndpoint: env.GREENOPS_GRID_ENDPOINT, gridSecret: env.GREENOPS_GRID_SECRET,
  onSlow: (m) => log(`[slow] ${m}`),
});
const RUN = api.run;

function loadState() {
  try { const s = JSON.parse(fs.readFileSync(STATE, "utf8")); if (s.run === RUN) return s; log(`[state] ignoring receipt of another run (${s.run})`); } catch {}
  return { run: RUN, vms: {}, seq: 0, deleted: [] };
}
const st = loadState();
const save = () => { try { fs.writeFileSync(STATE, JSON.stringify(st, null, 2)); } catch (e) { log("[state] save failed", e.message); } };

const cat = loadCatalog();
// scenario start = 00:00Z of the first release day (the run's initial virtual_time)
cat.T0 = Math.floor(Math.min(...[...cat.workloads.values()].map((w) => w.release)) / 86400000) * 86400000;

const realClock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
// experiment overrides (JSON objects; unset = the defaults in policy.mjs DEFAULTS / controller.mjs CONTROL)
const jsonEnv = (k) => { try { return env[k] ? JSON.parse(env[k]) : {}; } catch (e) { console.error(`bad ${k}: ${e.message}`); process.exit(2); } };
const policyOpts = jsonEnv("GREENOPS_POLICY_OPTS"), ctlOpts = jsonEnv("GREENOPS_CONTROL_OPTS");

async function main() {
  log(`[boot] run=${RUN} mode=${MODE}${DRY ? " (dry)" : ""} state=${STATE}`);
  if (Object.keys(policyOpts).length || Object.keys(ctlOpts).length) log(`[boot] overrides policy=${JSON.stringify(policyOpts)} control=${JSON.stringify(ctlOpts)}`);
  await api.discover(cat, log);
  log(`[boot] discovery done: ${cat.zones.size} zones, templates for ${api.templates.size}`);
  if (DRY) {
    // one decision with no side effects
    const dryApi = { ...api, create: async (z, p, name) => ({ id: `dry-${name}` }), vmAction: async () => ({ ok: true }), remove: async () => ({ ok: true }), listInstances: async () => [], findByName: async () => null };
    const c = new Controller({ cat, api: dryApi, clock: realClock, log, state: { run: RUN, vms: {}, seq: 0 }, save: () => {}, run: RUN, opts: ctlOpts, policyOpts });
    const areas = [...new Set([...cat.zones.values()].map((z) => z.area))];
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline && !(c.snap && areas.every((a) => c.fc.has(a)))) {
      c.pollStatus(); if (c.snap) c.refreshForecasts(Math.floor(c.tNow())); await realClock.sleep(300);
    }
    c.step();
    await realClock.sleep(200);
    log("[dry] one decision cycle done");
    process.exit(0);
  }
  const ctl = new Controller({ cat, api, clock: realClock, log, state: st, save, run: RUN, event, opts: ctlOpts, policyOpts });
  if (MODE === "destroy") { await ctl.finalize("destroy requested"); return; }
  const stats = await ctl.runLoop();
  log(`[final] done: ${JSON.stringify(stats)}; receipt ${Object.keys(st.vms).length} VM(s) at ${STATE}`);
  process.exit(0);
}

main().catch((e) => { log("[crash]", e?.stack ?? e); process.exit(1); });
