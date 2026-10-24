#!/usr/bin/env node
// create-probe v9 - confirm POST signing: raw-body vs body-hash, and body omitted.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
for (const p of [path.join(root, ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const CLOUD = process.env.GREENOPS_CLOUD_ENDPOINT;
const RUN = /runs\/([^/]+)/.exec(CLOUD)[1];
const hostRoot = CLOUD.slice(0, CLOUD.indexOf(`/runs/${RUN}`));
function sig(secret, m) { return crypto.createHmac("sha256", secret).update(m).digest("base64"); }
async function tryCreate(body, secondField) {
  const u = new URL(`${hostRoot}/runs/${RUN}/cloud/at-vie-1/v2/instance`);
  const expires = Math.floor(Date.now() / 1000) + 120;
  const sPath = `/runs/${RUN}/cloud/at-vie-1/v2/instance`;
  const payload = JSON.stringify(body);
  const line2 = secondField === "hash" ? crypto.createHash("sha256").update(payload).digest("base64") : (secondField === "raw" ? payload : "");
  const msg = [`POST ${sPath}`, line2, "", "", String(expires)].join("\n");
  const signature = sig(process.env.EXOSCALE_API_SECRET, msg);
  const headers = { Accept: "application/json", Authorization: `EXO2-HMAC-SHA256 credential=${process.env.EXOSCALE_API_KEY},expires=${expires},signature=${signature}`, "Content-Type": "application/json" };
  const res = await fetch(u, { method: "POST", headers, body: payload });
  const vid = res.status < 300 ? (res.jsony?.id) : null;
  return { status: res.status, body: await res.json().catch(() => null) };
}
const TEMPLATE = "11111111-1111-4111-8111-111111111111";
const body = { name: `s-${Date.now()}`, instance_type: { id: "20000000-0000-4000-8000-000000000004" }, template: { id: TEMPLATE }, disk_size: 10, user_data: Buffer.from(JSON.stringify({ greenops: { schema_version: "1.0", workload_id: "w-02-ch-reporting" } })).toString("base64") };
for (const style of ["raw", "hash", "empty"]) {
  const r = await tryCreate(body, style);
  console.log(`sign-style=${style}: HTTP ${r.status} ${JSON.stringify(r.body)}`);
}
