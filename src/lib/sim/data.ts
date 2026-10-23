// Sample challenge data. Mirrors the brief's shape (15 workloads, 11 zones / 8 countries,
// 20 VMs, 320 vCPU, GPU family quotas). Replace with the starter kit's files when available.

export type Country = "CH" | "DE" | "AT" | "FR" | "NL" | "BG" | "SE" | "PL";
export const EU_COUNTRIES: Country[] = ["DE", "AT", "FR", "NL", "BG", "SE", "PL"];
export const DACH: Country[] = ["DE", "AT", "CH"];

export interface Zone {
  id: string;
  country: Country;
  fictional: boolean;
  baseIntensity: number; // gCO2/kWh mean
  solarDip: number; // 0..1 midday reduction
  windVolatility: number; // weather noise amplitude
  pue: number;
  gpuFamilies: GpuFamily[];
}

export type GpuFamily = "a5000" | "a40" | "rtxpro6000";

export const ZONES: Zone[] = [
  { id: "ch-gva-2", country: "CH", fictional: false, baseIntensity: 45, solarDip: 0.15, windVolatility: 0.15, pue: 1.25, gpuFamilies: ["a5000", "a40"] },
  { id: "ch-dk-2", country: "CH", fictional: false, baseIntensity: 55, solarDip: 0.2, windVolatility: 0.15, pue: 1.3, gpuFamilies: ["a5000", "rtxpro6000"] },
  { id: "de-fra-1", country: "DE", fictional: false, baseIntensity: 380, solarDip: 0.45, windVolatility: 0.45, pue: 1.3, gpuFamilies: ["a5000", "a40", "rtxpro6000"] },
  { id: "de-muc-1", country: "DE", fictional: false, baseIntensity: 360, solarDip: 0.5, windVolatility: 0.4, pue: 1.28, gpuFamilies: ["a40"] },
  { id: "at-vie-1", country: "AT", fictional: false, baseIntensity: 140, solarDip: 0.35, windVolatility: 0.3, pue: 1.3, gpuFamilies: ["a5000"] },
  { id: "at-vie-2", country: "AT", fictional: false, baseIntensity: 150, solarDip: 0.35, windVolatility: 0.3, pue: 1.22, gpuFamilies: ["a40", "rtxpro6000"] },
  { id: "bg-sof-1", country: "BG", fictional: false, baseIntensity: 420, solarDip: 0.3, windVolatility: 0.2, pue: 1.4, gpuFamilies: ["a5000"] },
  { id: "fr-par-x", country: "FR", fictional: true, baseIntensity: 60, solarDip: 0.1, windVolatility: 0.2, pue: 1.3, gpuFamilies: ["a40"] },
  { id: "se-sto-x", country: "SE", fictional: true, baseIntensity: 30, solarDip: 0.05, windVolatility: 0.35, pue: 1.15, gpuFamilies: ["a5000", "a40"] },
  { id: "nl-ams-x", country: "NL", fictional: true, baseIntensity: 320, solarDip: 0.3, windVolatility: 0.5, pue: 1.25, gpuFamilies: ["a5000"] },
  { id: "pl-waw-x", country: "PL", fictional: true, baseIntensity: 650, solarDip: 0.2, windVolatility: 0.25, pue: 1.4, gpuFamilies: ["rtxpro6000"] },
];

export interface Profile {
  id: string;
  kind: "cpu" | "gpu";
  vcpu: number;
  family?: GpuFamily;
  gpus: number;
  gpuMemGB: number;
  kw: number; // active draw per VM
  idleKw: number;
  throughput: number; // work units per hour
}

export const PROFILES: Profile[] = [
  { id: "standard.large", kind: "cpu", vcpu: 4, gpus: 0, gpuMemGB: 0, kw: 0.09, idleKw: 0.04, throughput: 1 },
  { id: "cpu.extra-large", kind: "cpu", vcpu: 16, gpus: 0, gpuMemGB: 0, kw: 0.3, idleKw: 0.1, throughput: 4 },
  { id: "cpu.mega", kind: "cpu", vcpu: 32, gpus: 0, gpuMemGB: 0, kw: 0.55, idleKw: 0.18, throughput: 8 },
  { id: "gpua5000.small", kind: "gpu", family: "a5000", vcpu: 12, gpus: 1, gpuMemGB: 24, kw: 0.35, idleKw: 0.1, throughput: 10 },
  { id: "gpua40.small", kind: "gpu", family: "a40", vcpu: 12, gpus: 1, gpuMemGB: 48, kw: 0.42, idleKw: 0.12, throughput: 14 },
  { id: "gpua40.medium", kind: "gpu", family: "a40", vcpu: 24, gpus: 2, gpuMemGB: 96, kw: 0.82, idleKw: 0.22, throughput: 27 },
  { id: "gpurtxpro6000.small", kind: "gpu", family: "rtxpro6000", vcpu: 24, gpus: 1, gpuMemGB: 96, kw: 0.68, idleKw: 0.15, throughput: 30 },
];

export const QUOTA = {
  vms: 20,
  vcpu: 320,
  gpus: { a5000: 8, a40: 8, rtxpro6000: 4 } as Record<GpuFamily, number>,
};

export interface Workload {
  id: string;
  name: string;
  kind: "cpu" | "gpu";
  release: number; // hour
  deadline: number; // hour, output must be delivered by then
  work: number; // work units (throughput-hours)
  setupH: number;
  outputH: number;
  countries: Country[]; // allowed countries
  minGpuMemGB: number;
  maxWorkers: number;
  parallelEff: number; // per extra worker efficiency factor
  checkpointH: number | null; // null = restart loses everything
  refEnergyKWh: number; // fixed reference energy (score weight)
  note?: string;
}

const ALL: Country[] = ["CH", ...EU_COUNTRIES];

export const WORKLOADS: Workload[] = [
  { id: "wl-01", name: "Climate model ensemble", kind: "cpu", release: 0, deadline: 96, work: 160, setupH: 1, outputH: 1, countries: DACH, minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.9, checkpointH: null, refEnergyKWh: 14, note: "Restart-sensitive scientific model, DACH only" },
  { id: "wl-02", name: "Swiss regulatory report", kind: "cpu", release: 12, deadline: 48, work: 24, setupH: 0.5, outputH: 0.5, countries: ["CH"], minGpuMemGB: 0, maxWorkers: 2, parallelEff: 0.85, checkpointH: 2, refEnergyKWh: 3 },
  { id: "wl-03", name: "Large-input analytics", kind: "cpu", release: 0, deadline: 72, work: 120, setupH: 2, outputH: 1, countries: EU_COUNTRIES, minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.8, checkpointH: 4, refEnergyKWh: 11, note: "Two-hour data staging setup" },
  { id: "wl-04", name: "LLM fine-tune (EU, 48 GB)", kind: "gpu", release: 6, deadline: 84, work: 280, setupH: 1, outputH: 0.5, countries: ["DE", "AT", "FR"], minGpuMemGB: 48, maxWorkers: 4, parallelEff: 0.85, checkpointH: 1, refEnergyKWh: 22 },
  { id: "wl-05", name: "Image embedding batch", kind: "gpu", release: 0, deadline: 40, work: 90, setupH: 0.5, outputH: 0.5, countries: ALL, minGpuMemGB: 16, maxWorkers: 3, parallelEff: 0.95, checkpointH: 1, refEnergyKWh: 8 },
  { id: "wl-06", name: "Genome alignment", kind: "cpu", release: 24, deadline: 110, work: 140, setupH: 1, outputH: 1, countries: ALL, minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.9, checkpointH: 3, refEnergyKWh: 12 },
  { id: "wl-07", name: "Grid load forecast retrain", kind: "gpu", release: 30, deadline: 70, work: 120, setupH: 0.5, outputH: 0.5, countries: DACH, minGpuMemGB: 24, maxWorkers: 2, parallelEff: 0.9, checkpointH: 1, refEnergyKWh: 9 },
  { id: "wl-08", name: "Video transcode archive", kind: "cpu", release: 0, deadline: 120, work: 200, setupH: 0.5, outputH: 1, countries: ALL, minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.97, checkpointH: 1, refEnergyKWh: 16 },
  { id: "wl-09", name: "Fraud model scoring (EU)", kind: "cpu", release: 36, deadline: 60, work: 40, setupH: 0.5, outputH: 0.5, countries: EU_COUNTRIES, minGpuMemGB: 0, maxWorkers: 3, parallelEff: 0.9, checkpointH: 1, refEnergyKWh: 4 },
  { id: "wl-10", name: "Diffusion training (96 GB)", kind: "gpu", release: 12, deadline: 108, work: 420, setupH: 1.5, outputH: 1, countries: ["DE", "AT", "CH", "PL"], minGpuMemGB: 96, maxWorkers: 4, parallelEff: 0.85, checkpointH: 2, refEnergyKWh: 30 },
  { id: "wl-11", name: "Search index rebuild", kind: "cpu", release: 48, deadline: 96, work: 64, setupH: 1, outputH: 0.5, countries: ALL, minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.85, checkpointH: 2, refEnergyKWh: 6 },
  { id: "wl-12", name: "Speech-to-text backlog", kind: "gpu", release: 20, deadline: 100, work: 150, setupH: 0.5, outputH: 0.5, countries: ALL, minGpuMemGB: 24, maxWorkers: 3, parallelEff: 0.95, checkpointH: 1, refEnergyKWh: 12 },
  { id: "wl-13", name: "Monte Carlo risk (CH)", kind: "cpu", release: 60, deadline: 110, work: 80, setupH: 0.5, outputH: 0.5, countries: ["CH"], minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.95, checkpointH: 1, refEnergyKWh: 7 },
  { id: "wl-14", name: "CFD turbine sweep", kind: "cpu", release: 8, deadline: 90, work: 180, setupH: 1, outputH: 1, countries: ["DE", "AT", "SE", "FR"], minGpuMemGB: 0, maxWorkers: 4, parallelEff: 0.85, checkpointH: null, refEnergyKWh: 15, note: "No checkpoints: any move restarts from zero" },
  { id: "wl-15", name: "Vision QA eval suite", kind: "gpu", release: 72, deadline: 118, work: 60, setupH: 0.5, outputH: 0.5, countries: EU_COUNTRIES, minGpuMemGB: 24, maxWorkers: 2, parallelEff: 0.9, checkpointH: 1, refEnergyKWh: 5 },
];

export const HORIZON_H = 120;
export const BOOT_H = 0.25;
export const DT = 0.25;

export const zoneById = (id: string) => ZONES.find((z) => z.id === id)!;
export const profileById = (id: string) => PROFILES.find((p) => p.id === id)!;

export function isLegal(w: Workload, zoneId: string) {
  return w.countries.includes(zoneById(zoneId).country);
}
export function legalZones(w: Workload) {
  return ZONES.filter((z) => w.countries.includes(z.country));
}
export function feasibleProfiles(w: Workload, zone: Zone) {
  return PROFILES.filter((p) =>
    w.kind === "cpu"
      ? p.kind === "cpu"
      : p.kind === "gpu" && p.gpuMemGB >= w.minGpuMemGB && zone.gpuFamilies.includes(p.family!),
  );
}
