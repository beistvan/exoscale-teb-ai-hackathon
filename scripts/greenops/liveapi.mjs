/** Real challenge API adapter for the Controller (EXO2-HMAC signed cloud/work, auth-token grid).
 *  Timeouts are generous on purpose: under load the server answers in 3-17 s, and aborting a slow
 *  but valid reply only to retry it doubles the lag. Creates are never blindly retried (the cloud
 *  API has no idempotent receipts) — an ambiguous create is resolved by looking the name up. */
import crypto from "node:crypto";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeLiveApi({ key, secret, cloudEndpoint, workEndpoint, gridEndpoint, gridSecret, timeoutMs = 45000, onSlow }) {
  const RUN = new URL(cloudEndpoint).pathname.split("/")[2];
  const ORIGIN = new URL(cloudEndpoint).origin;
  const WORK = workEndpoint.replace(/\/$/, "");
  const GRID = gridEndpoint.replace(/\/$/, "");

  // message = "METHOD path" \n body \n query-values \n headers \n expires
  function auth(method, pathname, body = "", query = null) {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const qv = query ? [...query.values()].join("") : "";
    const msg = [`${method} ${pathname}`, body, qv, "", String(expires)].join("\n");
    const sig = crypto.createHmac("sha256", secret).update(msg, "utf8").digest("base64");
    let a = `EXO2-HMAC-SHA256 credential=${key},expires=${expires},signature=${sig}`;
    if (query) a += `,signed-query-args=${[...query.keys()].join(";")}`;
    return a;
  }

  /** fetch with one deadline covering headers AND body. Returns {ok,status,text,json,headers} or throws. */
  async function req(url, opts) {
    const ctrl = new AbortController();
    const t0 = Date.now();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      const text = await res.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      const dt = Date.now() - t0;
      if (dt > 8000 && onSlow) onSlow(`${opts.method ?? "GET"} ${new URL(url).pathname.split("/").slice(-2).join("/")} ${dt}ms`);
      return { ok: res.ok, status: res.status, text, json, headers: res.headers };
    } finally { clearTimeout(timer); }
  }

  async function cloud(zone, method, p, body = null, query = null, { retries = 2 } = {}) {
    const pathname = `/runs/${RUN}/cloud${zone ? `/${zone}` : ""}/v2${p}`;
    const u = new URL(ORIGIN + pathname);
    const q = query ? new URLSearchParams(query) : null;
    if (q) for (const [k, v] of q) u.searchParams.set(k, v);
    const payload = body ? JSON.stringify(body) : "";
    for (let n = 0; ; n++) {
      const headers = { Accept: "application/json", Authorization: auth(method, pathname, payload, q) };
      if (payload) headers["Content-Type"] = "application/json";
      let r;
      try { r = await req(u, { method, headers, body: payload || undefined }); }
      catch (e) {
        if (method === "POST" || n >= retries) return { ok: false, status: 0, ambiguous: method === "POST", text: String(e) };
        await sleep(500); continue;
      }
      if ((r.status === 429 || r.status >= 500) && method !== "POST" && n < retries) { await sleep(1000); continue; }
      if (method === "POST" && r.status >= 500) r.ambiguous = true;
      return r;
    }
  }

  return {
    run: RUN,
    async status() {
      const url = new URL(WORK + "/status");
      for (let n = 0; n < 2; n++) {
        const r = await req(url, { headers: { Accept: "application/json", Authorization: auth("GET", url.pathname) } }).catch(() => null);
        if (r?.ok && r.json) return r.json;
        await sleep(r?.status === 429 ? 1000 : 300);
      }
      return null;
    },
    async forecast(area) {
      const u = new URL(`${GRID}/carbon-intensity/forecast`);
      u.searchParams.set("zone", area);
      u.searchParams.set("horizonHours", "24");
      const r = await req(u, { headers: { Accept: "application/json", "auth-token": gridSecret } }).catch(() => null);
      if (!r?.ok || !r.json) return null;
      return (r.json.forecast ?? []).map((p) => ({ t: Date.parse(p.datetime), v: Number(p.carbonIntensity) })).filter((p) => isFinite(p.t) && isFinite(p.v));
    },
    /** This run's published observations (most recent 24 h), for learning the forecast's errors. */
    async history(area) {
      const u = new URL(`${GRID}/carbon-intensity/history`);
      u.searchParams.set("zone", area);
      const r = await req(u, { headers: { Accept: "application/json", "auth-token": gridSecret } }).catch(() => null);
      if (!r?.ok || !r.json) return null;
      return (r.json.history ?? []).map((p) => ({ t: Date.parse(p.datetime), v: Number(p.carbonIntensity) })).filter((p) => isFinite(p.t) && isFinite(p.v));
    },
    templates: new Map(),
    async create(zone, profId, name, wl) {
      const tid = this.templates.get(zone);
      if (!tid) return { error: `no template for ${zone}` };
      const userData = Buffer.from(JSON.stringify({ greenops: { schema_version: "1.0", workload_id: wl } })).toString("base64");
      const r = await cloud(zone, "POST", "/instance", { name, "instance-type": { id: profId }, template: { id: tid }, disk_size: 10, "user-data": userData });
      const id = r.json?.reference?.id ?? r.json?.id ?? null;
      return id ? { id } : { error: `${r.status} ${String(r.text ?? "").slice(0, 200)}`, ambiguous: Boolean(r.ambiguous) };
    },
    async listInstances(zone) {
      const r = await cloud(zone, "GET", "/instance");
      return r.json?.instances ?? [];
    },
    async findByName(zone, name) {
      for (let n = 0; n < 3; n++) {
        const l = await this.listInstances(zone).catch(() => []);
        const hit = l.find((x) => x.name === name);
        if (hit) return hit.id;
        await sleep(1500);
      }
      return null;
    },
    vmAction(zone, id, verb) { return cloud(zone, "PUT", `/instance/${id}:${verb}`); },
    remove(zone, id) { return cloud(zone, "DELETE", `/instance/${id}`); },
    async getInstance(zone, id) {
      const r = await cloud(zone, "GET", `/instance/${id}`);
      const it = r.json?.["instance-type"];
      return r.ok ? { prof: typeof it === "string" ? it : it?.id ?? null, name: r.json?.name ?? "" } : null;
    },
    /** Discovery before the clock starts: zones, live per-zone offerings, templates — all in parallel. */
    async discover(cat, log) {
      const z = await cloud("", "GET", "/zone", null, null, { retries: 4 });
      const live = new Set((z.json?.zones ?? []).map((x) => x.name));
      if (!live.size) throw new Error(`zone discovery failed: ${z.status} ${String(z.text ?? "").slice(0, 200)}`);
      for (const slug of [...cat.zones.keys()]) if (!live.has(slug)) { cat.zones.delete(slug); log(`[discover] zone ${slug} not offered by this run`); }
      await Promise.all([...cat.zones.keys()].map(async (slug) => {
        const [it, tp] = await Promise.all([cloud(slug, "GET", "/instance-type", null, null, { retries: 4 }), cloud(slug, "GET", "/template", null, { visibility: "public" }, { retries: 4 })]);
        const offered = it.json?.["instance-types"];
        if (Array.isArray(offered)) {
          const ids = new Set(offered.filter((t) => t.authorized !== false).map((t) => t.id));
          for (const p of cat.profiles.values()) if (p.zones.has(slug) && !ids.has(p.id)) { p.zones.delete(slug); log(`[discover] ${p.label} not offered in ${slug}`); }
        } else log(`[discover] instance-type list for ${slug} unavailable (${it.status}); trusting catalog`);
        const ts = tp.json?.templates ?? [];
        const t = ts.find((x) => /ubuntu/i.test(x.name ?? "")) ?? ts[0];
        if (t?.id) this.templates.set(slug, t.id);
      }));
      // a zone whose template lookup failed can reuse another zone's id (templates are global)
      const any = [...this.templates.values()][0];
      for (const slug of cat.zones.keys()) if (!this.templates.has(slug) && any) this.templates.set(slug, any);
      if (!any) throw new Error("no VM template found");
    },
  };
}
