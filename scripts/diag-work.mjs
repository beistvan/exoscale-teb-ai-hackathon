#!/usr/bin/env node
// Read-only: dump work/status workload ids and key fields.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
for (const p of [path.join(root, ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const W = process.env.GREENOPS_WORK_ENDPOINT.replace(/\/$/, "");
const u = new URL(W + "/status");
const e = Math.floor(Date.now() / 1000) + 120;
const msg = ["GET " + u.pathname, "", "", "", String(e)].join("\n");
const sig = crypto.createHmac("sha256", process.env.EXOSCALE_API_SECRET).update(msg).digest("base64");
const res = await fetch(u, { headers: { Accept: "application/json", Authorization: `EXO2-HMAC-SHA256 credential=${process.env.EXOSCALE_API_KEY},expires=${e},signature=${sig}` } });
const j = await res.json();
console.log("state:", j.state, j.virtual_time, "speed:", j.speed_multiplier);
for (const w of j.workloads) {
  console.log("WL:", w.workload_id ?? w.id, "| kind:", w.kind, "| req:", w.required_work, "| rel:", w.release_at, "| dl:", w.deadline_at, "| residency:", w.residency, "| allowed_profiles:", JSON.stringify(w.allowed_profile_ids), "| allowed_families:", JSON.stringify(w.allowed_families), "| minGPUmem:", w.minimum_gpu_memory_gib, "| forbidden:", JSON.stringify(w.forbidden_countries), "| maxW:", w.max_workers);
}
