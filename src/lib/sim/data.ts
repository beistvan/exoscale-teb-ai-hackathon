// Challenge data for the simulator, loaded from the vendored starter-kit files in challenge/
// (the same catalog the live controller in scripts/greenops uses). Legality comes from the
// shared challenge/legality.mjs so the simulator and the live run can never disagree.
//
// The catalog has no electricity data, so each zone gets a SYNTHETIC carbon profile below
// (CARBON_MODEL). Only the simulator uses it; the live run reads the grid API.
import catalog from "../../../challenge/catalog.json";
import rules from "../../../challenge/rules.json";
import { profileLegal, zoneLegal } from "../../../challenge/legality.mjs";

export type Country = string;
export type GpuFamily = string;

export interface Zone {
  id: string; // slug, as used by the cloud API
  name: string;
  country: Country;
  eu: boolean;
  fictional: boolean;
  pue: number;
  baseIntensity: number; // synthetic gCO2/kWh mean
  solarDip: number; // synthetic 0..1 midday reduction
  windVolatility: number; // synthetic weather noise amplitude
}

export interface Profile {
  id: string; // catalog UUID, as used by the cloud API
  label: string; // e.g. "cpu.mega"
  kind: "cpu" | "gpu";
  family: GpuFamily | "cpu";
  vcpu: number;
  gpus: number;
  gpuMemGB: number;
  kw: number; // active IT draw per VM, before PUE
  idleKw: number;
  throughput: number; // work units per hour
  unit: string;
  bootH: number;
  zones: string[];
}

export interface Workload {
  id: string; // real workload ID (w-01-…)
  name: string;
  kind: "cpu" | "gpu";
  release: number; // hour since SCENARIO_START
  deadline: number; // hour, output must be delivered by then
  work: number; // work units
  unit: string;
  setupH: number;
  outputH: number;
  residency: string; // "EU" | "CH" | "ANYWHERE"
  allowed: Country[] | null;
  forbidden: Country[];
  profileIds: string[] | null;
  families: string[] | null;
  minVram: number;
  maxWorkers: number;
  parallelEff: number; // per extra worker efficiency factor (1 - sync_overhead)
  checkpointH: number | null; // null = restart loses everything
  refEnergyKWh: number; // fixed reference energy (score weight) from rules.json
}

// Synthetic per-zone carbon profile (sim only). Rough shape of each country's grid.
const CARBON_MODEL: Record<string, Pick<Zone, "baseIntensity" | "solarDip" | "windVolatility">> = {
  "at-vie-1": { baseIntensity: 140, solarDip: 0.35, windVolatility: 0.3 },
  "at-vie-2": { baseIntensity: 150, solarDip: 0.35, windVolatility: 0.3 },
  "bg-sof-1": { baseIntensity: 420, solarDip: 0.3, windVolatility: 0.2 },
  "ch-dk-2": { baseIntensity: 55, solarDip: 0.2, windVolatility: 0.15 },
  "ch-gva-2": { baseIntensity: 45, solarDip: 0.15, windVolatility: 0.15 },
  "de-fra-1": { baseIntensity: 380, solarDip: 0.45, windVolatility: 0.45 },
  "de-muc-1": { baseIntensity: 360, solarDip: 0.5, windVolatility: 0.4 },
  "hr-zag-1": { baseIntensity: 210, solarDip: 0.3, windVolatility: 0.3 },
  "es-mad-1": { baseIntensity: 160, solarDip: 0.55, windVolatility: 0.4 },
  "it-mil-1": { baseIntensity: 300, solarDip: 0.4, windVolatility: 0.25 },
  "fr-par-1": { baseIntensity: 60, solarDip: 0.1, windVolatility: 0.2 },
};
const DEFAULT_CARBON = { baseIntensity: 300, solarDip: 0.3, windVolatility: 0.3 };

/** Hour 0 of the simulation: midnight UTC on the first release day. */
export const SCENARIO_START = Date.UTC(2025, 8, 30);
const hourOf = (iso: string) => (Date.parse(iso) - SCENARIO_START) / 3_600_000;

export const ZONES: Zone[] = catalog.zones.map((z) => ({
  id: z.slug,
  name: z.name,
  country: z.country,
  eu: Boolean(z.eu_member),
  fictional: Boolean(z.fictional),
  pue: Number(z.pue),
  ...(CARBON_MODEL[z.slug] ?? DEFAULT_CARBON),
}));

type RawProfile = (typeof catalog.profiles)[number] & { gpu_memory_gib?: number };
export const PROFILES: Profile[] = (catalog.profiles as RawProfile[]).map((p) => ({
  id: p.id,
  label: `${p.family}.${p.size}`,
  kind: p.family === "cpu" ? "cpu" : "gpu",
  family: p.family,
  vcpu: Number(p.cpu_cores),
  gpus: Number(p.gpu_count ?? 0),
  gpuMemGB: Number(p.gpu_memory_gib ?? 0),
  kw: Number(p.active_watts) / 1000,
  idleKw: Number(p.idle_watts) / 1000,
  // vcpu_hour throughput is per hour; tflop throughput is per second
  throughput: p.work_unit === "tflop" ? Number(p.throughput) * 3600 : Number(p.throughput),
  unit: p.work_unit,
  bootH: Number(p.boot_seconds ?? 120) / 3600,
  zones: p.zones,
}));

export const QUOTA = {
  vms: Number(catalog.max_vms),
  vcpu: Number(catalog.max_vcpus),
  gpus: catalog.gpu_family_quotas as Record<GpuFamily, number>,
};

const REF_ENERGY = rules.rules.reference_energy_kwh as Record<string, string>;

type RawWorkload = (typeof catalog.workloads)[number] & {
  allowed_countries?: string[];
  forbidden_countries?: string[];
  allowed_profile_ids?: string[];
  allowed_families?: string[];
  minimum_gpu_memory_gib?: number;
};
export const WORKLOADS: Workload[] = (catalog.workloads as RawWorkload[]).map((w) => ({
  id: w.id,
  name: w.title,
  kind: w.kind === "gpu" ? "gpu" : "cpu",
  release: hourOf(w.release_at),
  deadline: hourOf(w.deadline_at),
  work: Number(w.required_work),
  unit: w.work_unit,
  setupH: Number(w.input_seconds ?? 0) / 3600,
  outputH: Number(w.output_seconds ?? 0) / 3600,
  residency: String(w.residency ?? "ANYWHERE").toUpperCase(),
  allowed: w.allowed_countries ?? null,
  forbidden: w.forbidden_countries ?? [],
  profileIds: w.allowed_profile_ids ?? null,
  families: w.allowed_families ?? null,
  minVram: Number(w.minimum_gpu_memory_gib ?? 0),
  maxWorkers: Number(w.max_workers ?? 1),
  parallelEff: Math.max(0.05, 1 - Number(w.sync_overhead ?? 0)),
  checkpointH: w.restart_from_zero ? null : Number(w.checkpoint_seconds ?? 0) / 3600 || null,
  refEnergyKWh: Number(REF_ENERGY[w.id] ?? 0),
}));

export const HORIZON_H = Math.ceil(Math.max(...WORKLOADS.map((w) => w.deadline)));
export const DT = 0.25;

const zoneMap = new Map(ZONES.map((z) => [z.id, z]));
const profileMap = new Map(PROFILES.map((p) => [p.id, p]));
export const zoneById = (id: string) => zoneMap.get(id)!;
export const profileById = (id: string) => profileMap.get(id)!;
export const profileByLabel = (label: string) => PROFILES.find((p) => p.label === label);

const legalityProfile = (p: Profile) => ({ id: p.id, family: p.family, unit: p.unit, vram: p.gpuMemGB });

/** Residency check (disqualifying). Unknown zones are illegal. */
export function isLegal(w: Workload, zoneId: string) {
  const z = zoneMap.get(zoneId);
  return Boolean(z) && zoneLegal(w, z);
}
export function legalZones(w: Workload) {
  return ZONES.filter((z) => zoneLegal(w, z));
}
/** Profile offered in the zone and acceptable for the workload (non-disqualifying). */
export function profileFits(w: Workload, profileId: string, zoneId: string) {
  const p = profileMap.get(profileId);
  return Boolean(p) && p!.zones.includes(zoneId) && profileLegal(w, legalityProfile(p!));
}
export function feasibleProfiles(w: Workload, zone: Zone) {
  return PROFILES.filter((p) => profileFits(w, p.id, zone.id));
}
/** Short human description of where a workload may run. */
export function residencyLabel(w: Workload) {
  const parts = [w.residency === "ANYWHERE" ? "any" : w.residency];
  if (w.allowed?.length) parts.push(`only ${w.allowed.join(" ")}`);
  if (w.forbidden.length) parts.push(`not ${w.forbidden.join(" ")}`);
  return parts.join(" · ");
}
