#!/usr/bin/env node
// One-shot: enumerate every VM in the run across all zones and delete them all.
// Used to reset quota after a mess. Mirrors orchestrator.mjs signing exactly.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

for (const p of [path.join(process.cwd(), ".env"), "/app/.env"]) { try { process.loadEnvFile(p); break; } catch {} }
const env = process.env;
const key = env["EXOSCALE_API_KEY"], secret = env["EXOSCALE_API_SECRET"];
const CLOUD = (env["GREENOPS_CLOUD_ENDPOINT"] ?? "").replace(/\/$/, "");
if (!key || !secret || !CLOUD) { console.error("Missing env"); process.exit(2); }
const RUN = new URL(CLOUD).pathname.split("/")[2];
const hostRoot = CLOUD.slice(0, CLOUD.indexOf(`/runs/${RUN}`));

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
async function cloud(zonePath, method, pathname, body, query) {
  const u = new URL(`${hostRoot}/runs/${RUN}/cloud${zonePath}/v2${pathname}`);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const payload = body ? JSON.stringify(body) : undefined;
  const { auth } = sign(method, `${zonePath ? `/runs/${RUN}/cloud${zonePath}/v2` : `/runs/${RUN}/cloud/v2`}${pathname}`, { body: payload, query });
  const headers = { Accept: "application/json", Authorization: auth };
  if (payload) headers["Content-Type"] = "application/json";
  const res = await fetch(u, { method, headers, body: payload });
  if (res.status >= 400) return { error: res.status, text: await res.text().catch(() => "") };
  return { json: await res.json().catch(() => null), status: res.status };
}
(async () => {
  const zr = await cloud("", "GET", "/zone");
  const zones = zr?.json?.zones ?? [];
  console.log("zones", zones.length);
  const all = [];
  for (const z of zones) {
    const zname = z.name;
    const r = await cloud(`/${zname}`, "GET", "/instance");
    const insts = r?.json?.instances ?? [];
    for (const i of insts) all.push({ zone: zname, id: i.id, name: i.name });
  }
  console.log("total instances", all.length);
  for (const i of all) {
    const d = await cloud(`/${i.zone}`, "DELETE", `/instance/${i.id}`);
    console.log("deleted", i.name, d.error ? `ERR ${d.error} ${d.text}` : "ok");
  }
  console.log("done");
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
