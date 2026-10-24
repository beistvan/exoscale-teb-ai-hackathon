import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
for (const p of [path.join(root, ".env"), "/app/.env"]) {
  try {
    process.loadEnvFile(p);
    break;
  } catch {}
}

function sign(secret, message) {
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

async function exoGet(baseUrl, pathname) {
  const url = new URL(baseUrl.replace(/\/$/, "") + pathname);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const msg = [`GET ${url.pathname}`, "", "", "", String(expires)].join("\n");
  const signature = sign(process.env.EXOSCALE_API_SECRET, msg);
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      Authorization: `EXO2-HMAC-SHA256 credential=${process.env.EXOSCALE_API_KEY},expires=${expires},signature=${signature}`,
    },
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const missing = ["EXOSCALE_API_KEY", "EXOSCALE_API_SECRET", "GREENOPS_CLOUD_ENDPOINT", "GREENOPS_WORK_ENDPOINT", "GREENOPS_GRID_ENDPOINT", "GREENOPS_GRID_SECRET"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error("Missing .env values:", missing.join(", "));
  process.exit(1);
}

const st = await exoGet(process.env.GREENOPS_WORK_ENDPOINT, "/status");
if (!st.body || !st.body.workloads) {
  console.log("GET /status ->", st.status, JSON.stringify(st.body ?? null));
  process.exit(1);
}
const wl = st.body.workloads;
const done = wl.filter((w) => w.final_output_delivered).length;
const started = wl.filter((w) => w.vm_ids?.length).length;
console.log(`run state   : ${st.body.state}`);
console.log(`virtual time: ${st.body.virtual_time}  (speed ${st.body.speed_multiplier}x)`);
console.log(`workloads   : ${done}/${wl.length} delivered, ${started} started`);
for (const w of wl) {
  const ids = w.vm_ids?.length ?? 0;
  if (ids || w.final_output_delivered) console.log(`  ${String(w.workload_id ?? w.id).padEnd(20)} vms=${ids} delivered=${w.final_output_delivered}`);
}
const z = await exoGet(process.env.GREENOPS_CLOUD_ENDPOINT, "/zone");
console.log(`zones       : ${z.body?.zones?.length ?? "?"} available`);
