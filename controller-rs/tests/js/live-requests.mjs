// Ground truth for tests/live_requests.rs: the exact requests scripts/greenops/liveapi.mjs sends
// (fetch stubbed, clock fixed), so the Rust adapter's URLs, bodies and EXO2-HMAC signatures can be
// compared byte for byte. Fake credentials; nothing leaves the process.
import { makeLiveApi } from "../../../scripts/greenops/liveapi.mjs";
import { loadCatalog } from "../../../scripts/greenops/model.mjs";

Date.now = () => 1761300000123;
const seen = [];
const reply = (url, method) => {
  const p = new URL(url).pathname;
  if (p.endsWith("/status")) return { run_id: "x", virtual_time: "2025-09-30T00:00:00Z", workloads: [] };
  if (p.endsWith("/carbon-intensity/forecast")) return { forecast: [{ datetime: "2025-09-30T00:00:00Z", carbonIntensity: 123.4 }] };
  if (p.endsWith("/carbon-intensity/history")) return { history: [{ datetime: "2025-09-29T23:00:00Z", carbonIntensity: 99 }] };
  if (p.endsWith("/zone")) return { zones: [{ name: "at-vie-1" }, { name: "de-fra-1" }] };
  if (p.endsWith("/instance-type")) return { "instance-types": [{ id: "20000000-0000-4000-8000-000000000001" }] };
  if (p.endsWith("/template")) return { templates: [{ id: "tmpl-ubuntu", name: "Ubuntu 24.04 LTS" }] };
  if (method === "POST") return { reference: { id: "vm-new" } };
  if (p.endsWith("/instance")) return { instances: [{ id: "vm-1", name: "go2-01234567-w-01-dach-research-1" }] };
  return { id: "vm-1", name: "n", "instance-type": { id: "p" } };
};
globalThis.fetch = async (url, opts = {}) => {
  const h = opts.headers ?? {};
  seen.push({ method: opts.method ?? "GET", url: String(url), auth: h.Authorization ?? null, token: h["auth-token"] ?? null, ctype: h["Content-Type"] ?? null, body: opts.body ?? null });
  return new Response(JSON.stringify(reply(String(url), opts.method ?? "GET")), { status: 200 });
};
const api = makeLiveApi({
  key: "EXOtestkey0123", secret: "test-secret-not-real",
  cloudEndpoint: "https://example.test/runs/0123456789abcdef01234567/cloud/v2",
  workEndpoint: "https://example.test/runs/0123456789abcdef01234567/work/v1/",
  gridEndpoint: "https://example.test/runs/0123456789abcdef01234567/grid/v4/",
  gridSecret: "grid-token-not-real",
});
await api.discover(loadCatalog(), () => {});
await api.status();
await api.forecast("DE");
await api.history("CH");
await api.create("de-fra-1", "20000000-0000-4000-8000-000000000001", "go2-01234567-w-01-dach-research-1", "w-01-dach-research");
await api.vmAction("de-fra-1", "vm-1", "stop");
await api.vmAction("de-fra-1", "vm-1", "start");
await api.remove("de-fra-1", "vm-1");
await api.getInstance("at-vie-1", "vm-1");
await api.listInstances("at-vie-1");
process.stdout.write(JSON.stringify({ run: api.run, templates: [...api.templates], seen }));
