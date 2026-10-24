/** Read-only probe: score endpoint discovery + grid forecast formats. Prints no credentials. */
import fs from "fs";
import { createHmac } from "crypto";

const env = process.env;
const key = env.EXOSCALE_API_KEY, secret = env.EXOSCALE_API_SECRET;
const WORK = (env.GREENOPS_WORK_ENDPOINT ?? "").replace(/\/$/, "");
const GRID = (env.GREENOPS_GRID_ENDPOINT ?? "").replace(/\/$/, "");
const GRID_SECRET = env.GREENOPS_GRID_SECRET ?? "";

function sign(method, pathname) {
  const expires = Math.floor(Date.now() / 1000) + 120;
  const msg = [`${method} ${pathname}`, "", "", "", String(expires)].join("\n");
  return `EXO2-HMAC-SHA256 credential=${key},expires=${expires},signature=${createHmac("sha256", secret).update(msg, "utf8").digest("base64")}`;
}

for (const p of ["/score", "/v1/score", "/status/score"]) {
  const url = WORK + p; const path = new URL(url).pathname;
  const r = await fetch(url, { headers: { Accept: "application/json", Authorization: sign("GET", path) } });
  const t = await r.text();
  console.log("GET", p, r.status, t.slice(0, 1500));
}

for (const q of ["?zone=HR&horizonHours=24", "?zone=HR&horizonHours=72", "?electricity_area=HR&horizonHours=24", "?area=HR&horizonHours=24"]) {
  const r = await fetch(`${GRID}/carbon-intensity/forecast${q}`, { headers: { Accept: "application/json", "auth-token": GRID_SECRET } });
  const t = await r.text();
  console.log("GRID", q, r.status, t.slice(0, 400).replace(/\n/g, " "));
}
