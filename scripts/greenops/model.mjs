/** Pure challenge model: public catalog, residency legality, rates and energy.
 *  Source of truth is the vendored public catalog (challenge/catalog.json, a copy of the
 *  starter kit's challenge/catalog.json, shared with the web simulator) — it holds workload specs, zones (with PUE) and
 *  profiles (watts, throughput). It contains no electricity data.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zoneLegal, profileLegal } from "../../challenge/legality.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export function loadCatalog(file = path.join(HERE, "../../challenge/catalog.json")) {
  const c = JSON.parse(fs.readFileSync(file, "utf8"));
  const zones = new Map(c.zones.map((z) => [z.slug, {
    slug: z.slug, country: z.country, area: z.electricity_area ?? z.country, eu: Boolean(z.eu_member), pue: Number(z.pue),
  }]));
  const profiles = new Map(c.profiles.map((p) => [p.id, {
    id: p.id, family: p.family, size: p.size, label: `${p.family}.${p.size}`,
    cores: Number(p.cpu_cores), cards: Number(p.gpu_count ?? 0), vram: Number(p.gpu_memory_gib ?? 0),
    watts: Number(p.active_watts), idleWatts: Number(p.idle_watts), tput: Number(p.throughput),
    unit: p.work_unit, bootS: Number(p.boot_seconds ?? 120), zones: new Set(p.zones),
  }]));
  const workloads = new Map(c.workloads.map((w) => [w.id, {
    id: w.id, kind: w.kind, unit: w.work_unit, required: Number(w.required_work),
    release: Date.parse(w.release_at), deadline: Date.parse(w.deadline_at),
    residency: String(w.residency ?? "ANYWHERE").toUpperCase(),
    allowed: w.allowed_countries ?? null, forbidden: w.forbidden_countries ?? [],
    profileIds: w.allowed_profile_ids ?? null, families: w.allowed_families ?? null,
    minVram: Number(w.minimum_gpu_memory_gib ?? 0), maxWorkers: Number(w.max_workers ?? 1),
    sync: Number(w.sync_overhead ?? 0), inputS: Number(w.input_seconds ?? 0), outputS: Number(w.output_seconds ?? 0),
    checkpointS: Number(w.checkpoint_seconds ?? 0), restartFromZero: Boolean(w.restart_from_zero),
  }]));
  // frozen scoring rules (challenge/rules.json, next to the catalog): reference energies weight each job's points
  let rules = null;
  try { rules = JSON.parse(fs.readFileSync(path.join(path.dirname(file), "rules.json"), "utf8")).rules; } catch {}
  const refG = {};
  const refI = Number(rules?.reference_gco2e_per_kwh ?? 200);
  for (const w of workloads.values()) refG[w.id] = refI * Number(rules?.reference_energy_kwh?.[w.id] ?? 25);
  return {
    zones, profiles, workloads, refG,
    quota: { vms: Number(c.max_vms ?? 20), cores: Number(c.max_vcpus ?? 320), cards: { ...(c.gpu_family_quotas ?? {}) } },
  };
}

/** The frozen score (greenops-score-v2), fitted exactly on a real run's breakdown (error < 0.01 pts):
 *  points_i = 20000 * (R_i/R) / (1 + 0.75 * c_i/R_i + 0.25 * C/R), R_i = 200 g/kWh * reference kWh.
 *  carbon: { wl: grams }, progress: { wl: 0..1 }, allDelivered → +5000. */
export function score(cat, carbon, progress = {}, allDelivered = true) {
  const R = Object.values(cat.refG).reduce((a, b) => a + b, 0);
  const C = Object.values(carbon).reduce((a, b) => a + b, 0);
  let base = 0;
  for (const [id, Ri] of Object.entries(cat.refG)) {
    const q = 1 / (1 + 0.75 * (carbon[id] ?? 0) / Ri + 0.25 * C / R);
    base += 20000 * (Ri / R) * q * Math.max(0, Math.min(1, progress[id] ?? 1));
  }
  return { base, total: base + (allDelivered ? 5000 : 0) };
}

/** Points gained per gram saved on each job at the given carbon state (own local term + shared term). */
export function marginalPoints(cat, carbon) {
  const R = Object.values(cat.refG).reduce((a, b) => a + b, 0);
  const C = Object.values(carbon).reduce((a, b) => a + b, 0);
  const q = {};
  for (const [id, Ri] of Object.entries(cat.refG)) q[id] = 1 / (1 + 0.75 * (carbon[id] ?? 0) / Ri + 0.25 * C / R);
  const shared = Object.entries(cat.refG).reduce((a, [id, Ri]) => a + (Ri / R) * q[id] ** 2, 0);
  return Object.fromEntries(Object.keys(cat.refG).map((id) => [id, (20000 / R) * (0.75 * q[id] ** 2 + 0.25 * shared)]));
}

export { zoneLegal, profileLegal };

/** Work units per hour of ONE VM. vcpu_hour throughput is per hour; tflop throughput is per second. */
export function rate1(p) { return p.unit === "tflop" ? p.tput * 3600 : p.tput; }
/** Aggregate rate of k workers with the engine's sync model: k * r * (1 - sync)^(k-1). */
export function rateK(w, p, k) { return k * rate1(p) * Math.pow(Math.max(0.05, 1 - w.sync), k - 1); }
export function setupH(w, p) { return (p.bootS + w.inputS) / 3600; }
export function outputH(w) { return w.outputS / 3600; }

/** Every legal (zone, profile, workers) placement for w. */
export function candidates(cat, w) {
  const out = [];
  for (const z of cat.zones.values()) {
    if (!zoneLegal(w, z)) continue;
    for (const p of cat.profiles.values()) {
      if (!p.zones.has(z.slug) || !profileLegal(w, p)) continue;
      for (let k = 1; k <= Math.max(1, w.maxWorkers); k++) out.push({ zone: z, prof: p, k });
    }
  }
  return out;
}

export function fitsQuota(cat, usage, p, k) {
  if (usage.vms + k > cat.quota.vms) return false;
  if (usage.cores + p.cores * k > cat.quota.cores) return false;
  if (p.family !== "cpu" && (usage.cards[p.family] ?? 0) + p.cards * k > (cat.quota.cards[p.family] ?? 0)) return false;
  return true;
}

/** Mean of the n cheapest values (n clipped to [1, len]). */
export function cheapestMean(arr, n) {
  if (!arr?.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.min(s.length, Math.max(1, Math.ceil(n)));
  let sum = 0;
  for (let i = 0; i < m; i++) sum += s[i];
  return sum / m;
}
