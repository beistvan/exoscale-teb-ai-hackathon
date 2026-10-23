import { BOOT_H, DT, HORIZON_H, ZONES, feasibleProfiles, legalZones, type Workload } from "./data";
import { STEPS } from "./carbon";
import { fitsQuota, ratePerHour, type Action, type Policy, type PolicyView, type Usage } from "./engine";
import { profileById, zoneById } from "./data";

/** Total hours from deploy to delivered output, given remaining work. */
export function durationH(w: Workload, profileId: string, workers: number, remaining: number) {
  return BOOT_H + w.setupH + remaining / ratePerHour(w, profileId, workers) + w.outputH;
}
const ceilStep = (h: number) => Math.ceil(h / DT - 1e-9);

function cleanup(v: PolicyView): Action[] {
  const ids: string[] = [];
  for (const s of v.workloads) if ((s.phase === "done" || s.phase === "missed") && s.vmIds.length) ids.push(...s.vmIds);
  return ids.length ? [{ type: "delete", vmIds: ids, reason: "workload finished, releasing resources" }] : [];
}

function remainingOf(s: PolicyView["workloads"][number]) {
  return s.w.work - (s.w.checkpointH === null ? 0 : s.saved);
}

function addUsage(u: Usage, profileId: string, workers: number): Usage {
  const p = profileById(profileId);
  const g = { ...u.gpus };
  if (p.family) g[p.family] += p.gpus * workers;
  return { vms: u.vms + workers, vcpu: u.vcpu + p.vcpu * workers, gpus: g };
}

// Baseline home-zone preference (a typical static deployment), regardless of carbon.
const HOME = ["de-fra-1", "at-vie-1", "at-vie-2", "de-muc-1", "ch-gva-2", "ch-dk-2", "fr-par-x", "nl-ams-x", "bg-sof-1", "pl-waw-x", "se-sto-x"];

/** Baseline: fixed first legal zone, start on release, fastest profile, minimum workers that meet the deadline. */
export const baselinePolicy: Policy = {
  id: "baseline",
  name: "Baseline (start ASAP, fixed zone)",
  decide(v) {
    const actions = cleanup(v);
    let usage = v.usage;
    for (const s of v.workloads) {
      if (s.phase !== "pending" || v.hour < s.w.release) continue;
      const zone = [...legalZones(s.w)]
        .sort((a, b) => HOME.indexOf(a.id) - HOME.indexOf(b.id))
        .find((z) => feasibleProfiles(s.w, z).length > 0);
      if (!zone) continue;
      const profile = [...feasibleProfiles(s.w, zone)].sort((a, b) => b.throughput - a.throughput)[0]!;
      const rem = remainingOf(s);
      let workers = 1;
      while (workers < s.w.maxWorkers && v.hour + durationH(s.w, profile.id, workers, rem) > s.w.deadline) workers++;
      if (!fitsQuota(usage, profile.id, workers)) continue;
      usage = addUsage(usage, profile.id, workers);
      actions.push({ type: "deploy", wl: s.w.id, zone: zone.id, profile: profile.id, workers, reason: "baseline: first legal zone" });
    }
    return actions;
  },
};

export interface Candidate { zone: string; profile: string; workers: number; startStep: number; carbonG: number; durSteps: number; }

/**
 * Best (zone, profile, workers, start) by forecast carbon for one workload, keeping a safety
 * margin before the deadline. Uses prefix sums of the current forecast per zone.
 */
export function planWorkload(
  w: Workload, remaining: number, v: Pick<PolicyView, "step" | "forecast">,
  prefix: Record<string, Float64Array>, safety = 0.15,
): { best: Candidate | null; bestNow: (Candidate & { usageOk?: boolean })[] } {
  let best: Candidate | null = null;
  const nowList: Candidate[] = [];
  const deadlineStep = Math.floor(w.deadline / DT);
  for (const z of legalZones(w)) {
    const pre = prefix[z.id]!;
    for (const p of feasibleProfiles(w, z)) {
      for (let k = 1; k <= w.maxWorkers; k++) {
        const dur = durationH(w, p.id, k, remaining);
        const durSteps = ceilStep(dur);
        const marginSteps = ceilStep(dur * safety + 1);
        const latest = deadlineStep - durSteps - marginSteps;
        if (latest < v.step) {
          // no slack left even with margin: still consider "now" if it fits the hard deadline
          if (v.step + durSteps <= deadlineStep) {
            const c = cost(pre, v.step, durSteps, p.kw * k * z.pue);
            nowList.push({ zone: z.id, profile: p.id, workers: k, startStep: v.step, carbonG: c, durSteps });
          }
          continue;
        }
        const end = Math.min(latest, STEPS - durSteps);
        for (let s = v.step; s <= end; s += s === v.step ? 1 : 4) {
          const c = cost(pre, s, durSteps, p.kw * k * z.pue);
          const cand = { zone: z.id, profile: p.id, workers: k, startStep: s, carbonG: c, durSteps };
          if (s === v.step) nowList.push(cand);
          if (!best || c < best.carbonG) best = cand;
        }
      }
    }
  }
  nowList.sort((a, b) => a.carbonG - b.carbonG);
  return { best, bestNow: nowList };
}

function cost(pre: Float64Array, s: number, n: number, kw: number) {
  return (pre[s + n]! - pre[s]!) * kw * DT;
}

export function buildPrefix(v: Pick<PolicyView, "step" | "forecast">) {
  const out: Record<string, Float64Array> = {};
  for (const z of ZONES) {
    const a = new Float64Array(STEPS + 1);
    for (let t = 0; t < STEPS; t++) a[t + 1] = a[t]! + v.forecast(z.id, t);
    out[z.id] = a;
  }
  return out;
}

/**
 * Carbon-aware: replans every hour on the latest forecast. Waits while a clearly cleaner
 * window remains reachable with margin; otherwise deploys the cleanest option available now.
 * Tightest-slack workloads claim quota first. Deletes VMs as soon as output is delivered.
 */
export function makeCarbonAwarePolicy(opts: { safety?: number; waitGain?: number } = {}): Policy {
  const safety = opts.safety ?? 0.2;
  const waitGain = opts.waitGain ?? 0.08; // wait only if future window saves >8%
  let prefix: Record<string, Float64Array> | null = null;
  let prefixHour = -1;
  return {
    id: "carbon-aware",
    name: "Carbon-aware (forecast window + zone + profile)",
    decide(v) {
      const actions = cleanup(v);
      if (v.step % 4 !== 0 && !v.workloads.some((s) => s.phase === "pending" && v.hour === s.w.release)) {
        // decide on the hour, plus at releases
        if (v.step % 4 !== 0) return actions;
      }
      const h = Math.floor(v.hour);
      if (!prefix || h !== prefixHour) { prefix = buildPrefix(v); prefixHour = h; }
      let usage = v.usage;
      const pending = v.workloads
        .filter((s) => s.phase === "pending" && v.hour >= s.w.release)
        .map((s) => ({ s, rem: remainingOf(s) }))
        .map((x) => ({ ...x, slack: x.s.w.deadline - v.hour - x.rem / maxRate(x.s.w) }))
        .sort((a, b) => a.slack - b.slack);
      for (const { s, rem } of pending) {
        const { best, bestNow } = planWorkload(s.w, rem, v, prefix, safety);
        const deployable = bestNow.filter((c) => fitsQuota(usage, c.profile, c.workers));
        const urgent = !best; // no future slack left
        const nowBest = deployable[0];
        if (!nowBest) continue;
        const shouldWait = !urgent && best!.startStep > v.step && best!.carbonG < nowBest.carbonG * (1 - waitGain);
        if (shouldWait) continue;
        usage = addUsage(usage, nowBest.profile, nowBest.workers);
        actions.push({
          type: "deploy", wl: s.w.id, zone: nowBest.zone, profile: nowBest.profile, workers: nowBest.workers,
          reason: urgent ? "deadline pressure" : `forecast ${(nowBest.carbonG / 1000).toFixed(2)} kg, cleanest reachable window`,
        });
      }
      return actions;
    },
  };
}

function maxRate(w: Workload) {
  let r = 0;
  for (const z of legalZones(w)) for (const p of feasibleProfiles(w, z)) r = Math.max(r, ratePerHour(w, p.id, w.maxWorkers));
  return r || 1;
}

export const carbonAwarePolicy = makeCarbonAwarePolicy();
export const POLICIES = [baselinePolicy, carbonAwarePolicy];
export { HORIZON_H, zoneById };
