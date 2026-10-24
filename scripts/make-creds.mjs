import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const outArg = process.argv[2]; // optional target path for greenops-exo.json
for (const p of [path.join(root, ".env"), "/app/.env"]) {
  try {
    process.loadEnvFile(p);
    break;
  } catch {}
}

const key = process.env.EXOSCALE_API_KEY;
const secret = process.env.EXOSCALE_API_SECRET;
const endpoint = process.env.GREENOPS_CLOUD_ENDPOINT;
if (!key || !secret || !endpoint) {
  console.error("Missing EXOSCALE_API_KEY / EXOSCALE_API_SECRET / GREENOPS_CLOUD_ENDPOINT in .env");
  process.exit(1);
}

const out = outArg ? path.resolve(root, outArg) : path.join(root, "greenops-exo.json");
const config = {
  defaultaccount: "greenops",
  accounts: [{ name: "greenops", key, secret, endpoint, defaultzone: process.env.GREENOPS_DEFAULT_ZONE ?? "at-vie-1" }],
};
fs.writeFileSync(out, JSON.stringify(config, null, 2) + "\n");
fs.chmodSync(out, 0o600);
console.log(`wrote ${out}`);
