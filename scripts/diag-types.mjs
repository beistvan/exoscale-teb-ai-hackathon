#!/usr/bin/env node
// Read-only diagnostic: dump the live run's /instance-type + /template for a zone,
// using the same path construction as scripts/orchestrator.mjs.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
const root = process.cwd();
for (const p of [path.join(root, ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const CLOUD = process.env.GREENOPS_CLOUD_ENDPOINT;
const RUN = /runs\/([^/]+)/.exec(CLOUD)[1];
const hostRoot = CLOUD.slice(0, CLOUD.indexOf(`/runs/${RUN}`));
function sign(secret, m) { return crypto.createHmac("sha256", secret).update(m).digest("base64"); }
async function cloud(zonePath, method, pathname) {
  const u = new URL(`${hostRoot}/runs/${RUN}/cloud${zonePath}/v2${pathname}`);
  const expires = Math.floor(Date.now() / 1000) + 300;
  const signedPath = `${zonePath ? `/runs/${RUN}/cloud${zonePath}/v2` : `/runs/${RUN}/cloud/v2`}${pathname}`;
  const msg = [`${method} ${signedPath}`, "", "", "", String(expires)].join("\n");
  const sig = sign(process.env.EXOSCALE_API_SECRET, msg);
  const headers = { Accept: "application/json", Authorization: `EXO2-HMAC-SHA256 credential=${process.env.EXOSCALE_API_KEY},expires=${expires},signature=${sig}` };
  if (method !== "GET") headers["Content-Type"] = "application/json";
  const res = await fetch(u, { method, headers });
  return { status: res.status, json: await res.json().catch(() => null), text: await res.text().catch(() => "") };
}
const zone = process.argv[2] ?? "at-vie-1";
const zr = await cloud("", "GET", "/zone");
const zss = zr.json?.zones ?? [];
console.log("/zone ->", zr.status, "zones:", zss.map(z=>z.name).join(","));
const z = zss.find(z=>z.name===zone) ?? zss[0];
console.log("using zone:", z?.name, "api-endpoint:", z?.["api-endpoint"]);
const it = await cloud(`/${z.name}`, "GET", "/instance-type");
console.log("\n/<z>/v2/instance-type ->", it.status, JSON.stringify(it.json, null, 1).slice(0, 4000));
const tm = await cloud(`/${z.name}`, "GET", "/template");
console.log("\n/<z>/v2/template ->", tm.status, JSON.stringify(tm.json).slice(0, 600));
