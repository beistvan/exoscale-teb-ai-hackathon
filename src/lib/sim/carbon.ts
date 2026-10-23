import { DT, HORIZON_H, ZONES, type Zone } from "./data";

export function hash(...parts: (number | string)[]) {
  let h = 2166136261;
  for (const p of parts) {
    const s = String(p);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    h ^= 0x9e3779b9;
  }
  return h >>> 0;
}
export function rand(...parts: (number | string)[]) {
  let t = (hash(...parts) + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function gauss(...parts: (number | string)[]) {
  const u = Math.max(1e-9, rand(...parts, "u"));
  const v = rand(...parts, "v");
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export const STEPS = Math.round(HORIZON_H / DT);

/** Ground-truth intensity (gCO2/kWh) per zone per step. Hidden from policies. */
export function actualIntensity(seed: number): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const z of ZONES) {
    const arr: number[] = [];
    let weather = 0;
    for (let i = 0; i < STEPS; i++) {
      const h = i * DT;
      if (i % 4 === 0) weather = weather * 0.93 + gauss(seed, z.id, "w", i) * 0.12;
      const solar = Math.max(0, Math.sin(((h % 24) - 6) / 12 * Math.PI));
      const evening = Math.exp(-(((h % 24) - 19) ** 2) / 6) * 0.15;
      const v = z.baseIntensity * (1 - z.solarDip * solar + evening + z.windVolatility * weather);
      arr.push(Math.max(8, v));
    }
    out[z.id] = arr;
  }
  return out;
}

/**
 * Forecast published at `issueStep` for step `t`. Past/present = observed value.
 * Future = actual with error growing with lead time, deterministic per (seed, zone, issue hour).
 */
export function makeForecaster(seed: number, actual: Record<string, number[]>, errorScale: number) {
  return (zone: Zone | string, issueStep: number, t: number) => {
    const id = typeof zone === "string" ? zone : zone.id;
    const a = actual[id]![Math.min(t, STEPS - 1)]!;
    if (t <= issueStep) return a;
    const leadH = (t - issueStep) * DT;
    const issueH = Math.floor(issueStep * DT);
    const bias = gauss(seed, id, "bias", issueH) * 0.6;
    const n = gauss(seed, id, "n", issueH, Math.floor(t / 2)) * 0.4;
    return Math.max(5, a * (1 + errorScale * Math.sqrt(leadH / 24) * (bias + n)));
  };
}
