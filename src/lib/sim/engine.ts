import {
  BOOT_H, DT, HORIZON_H, QUOTA, WORKLOADS, isLegal, profileById, zoneById,
  type GpuFamily, type Workload,
} from "./data";
import { STEPS, actualIntensity, makeForecaster } from "./carbon";

export type Phase = "pending" | "boot" | "setup" | "compute" | "output" | "done" | "missed";

export interface VM { id: string; wl: string; zone: string; profile: string; created: number; deleted: number | null; }

export interface WlState {
  w: Workload;
  phase: Phase;
  vmIds: string[];
  phaseLeft: number; // hours left in boot/setup/output
  progress: number; // work units
  saved: number; // checkpointed work units
  sinceCkpt: number; // compute hours since last checkpoint
  energyKWh: number;
  carbonG: number;
  doneAt: number | null;
  restarts: number;
  zone: string | null;
  profile: string | null;
  workers: number;
}

export type Action =
  | { type: "deploy"; wl: string; zone: string; profile: string; workers: number; reason?: string }
  | { type: "delete"; vmIds: string[]; reason?: string };

export interface PolicyView {
  step: number;
  hour: number;
  workloads: readonly Readonly<WlState>[];
  vms: readonly Readonly<VM>[];
  usage: Usage;
  /** Forecast published for this run at the current step. Only source of electricity information. */
  forecast: (zone: string, t: number) => number;
}
export type Policy = { id: string; name: string; decide: (v: PolicyView) => Action[] };

export interface Usage { vms: number; vcpu: number; gpus: Record<GpuFamily, number>; }

export interface Segment { wl: string; zone: string; profile: string; workers: number; phase: Phase | "idle"; start: number; end: number; }
export interface Event { hour: number; kind: "deploy" | "delete" | "reject" | "violation" | "done" | "missed"; text: string; }

export interface RunResult {
  policy: string;
  seed: number;
  disqualified: boolean;
  workloads: WlState[];
  segments: Segment[];
  events: Event[];
  carbonSeries: { hour: number; gPerH: number; kW: number }[];
  totalCarbonKg: number;
  idleCarbonKg: number;
  totalEnergyKWh: number;
  score: Score;
  actual: Record<string, number[]>;
}

export interface Score { base: number; bonus: number; total: number; perWorkload: Record<string, number>; }

export const REF_INTENSITY = 250; // gCO2/kWh reference grid for score normalisation
export const BASE_POINTS = 20000;
export const BONUS_POINTS = 5000;

export function usageOf(vms: readonly VM[]): Usage {
  const u: Usage = { vms: 0, vcpu: 0, gpus: { a5000: 0, a40: 0, rtxpro6000: 0 } };
  for (const vm of vms) {
    if (vm.deleted !== null) continue;
    const p = profileById(vm.profile);
    u.vms++;
    u.vcpu += p.vcpu;
    if (p.family) u.gpus[p.family] += p.gpus;
  }
  return u;
}

export function fitsQuota(u: Usage, profileId: string, workers: number) {
  const p = profileById(profileId);
  if (u.vms + workers > QUOTA.vms) return false;
  if (u.vcpu + p.vcpu * workers > QUOTA.vcpu) return false;
  if (p.family && u.gpus[p.family] + p.gpus * workers > QUOTA.gpus[p.family]) return false;
  return true;
}

export function ratePerHour(w: Workload, profileId: string, workers: number) {
  return workers * profileById(profileId).throughput * Math.pow(w.parallelEff, workers - 1);
}

/** Approximate scoring model (official policy is frozen by the organisers). */
export function scoreRun(ws: WlState[], disqualified: boolean): Score {
  const refSum = ws.reduce((s, x) => s + x.w.refEnergyKWh, 0);
  const perWorkload: Record<string, number> = {};
  let base = 0;
  for (const s of ws) {
    const share = (BASE_POINTS * s.w.refEnergyKWh) / refSum;
    const done = s.phase === "done";
    const credit = done ? 1 : 0.5 * Math.min(1, s.progress / s.w.work);
    const refC = s.w.refEnergyKWh * REF_INTENSITY;
    // smooth carbon efficiency: 1 at zero carbon, 0.5 at reference carbon, -> 0 as carbon grows
    const eff = refC / (refC + s.carbonG);
    const pts = share * credit * eff;
    perWorkload[s.w.id] = pts;
    base += pts;
  }
  const allDone = ws.every((s) => s.phase === "done");
  const bonus = allDone ? BONUS_POINTS : 0;
  if (disqualified) return { base: 0, bonus: 0, total: 0, perWorkload };
  return { base, bonus, total: base + bonus, perWorkload };
}

export function runSimulation(policy: Policy, seed: number, forecastError = 0.25, workloads = WORKLOADS): RunResult {
  const actual = actualIntensity(seed);
  const fc = makeForecaster(seed, actual, forecastError);
  const ws: WlState[] = workloads.map((w) => ({
    w, phase: "pending", vmIds: [], phaseLeft: 0, progress: 0, saved: 0, sinceCkpt: 0,
    energyKWh: 0, carbonG: 0, doneAt: null, restarts: 0, zone: null, profile: null, workers: 0,
  }));
  const byId = new Map(ws.map((s) => [s.w.id, s]));
  const vms: VM[] = [];
  const events: Event[] = [];
  const segments: Segment[] = [];
  const open = new Map<string, Segment>();
  const carbonSeries: RunResult["carbonSeries"] = [];
  let disqualified = false;
  let idleCarbon = 0;
  let vmSeq = 0;

  const closeSeg = (wl: string, hour: number) => {
    const s = open.get(wl);
    if (s) { s.end = hour; if (s.end > s.start) segments.push(s); open.delete(wl); }
  };
  const markSeg = (s: WlState, phase: Segment["phase"], hour: number) => {
    const cur = open.get(s.w.id);
    if (cur && cur.phase === phase && cur.zone === s.zone) return;
    closeSeg(s.w.id, hour);
    open.set(s.w.id, { wl: s.w.id, zone: s.zone!, profile: s.profile!, workers: s.workers, phase, start: hour, end: hour });
  };

  for (let step = 0; step < STEPS; step++) {
    const hour = step * DT;
    const live = vms.filter((v) => v.deleted === null);
    const view: PolicyView = {
      step, hour, workloads: ws, vms: live, usage: usageOf(vms),
      forecast: (z, t) => fc(z, step, t),
    };
    const actions = policy.decide(view);

    for (const a of actions) {
      if (a.type === "delete") {
        for (const id of a.vmIds) {
          const vm = vms.find((v) => v.id === id && v.deleted === null);
          if (!vm) continue;
          vm.deleted = hour;
          const s = byId.get(vm.wl)!;
          s.vmIds = s.vmIds.filter((x) => x !== id);
          if (s.vmIds.length === 0 && s.phase !== "done" && s.phase !== "missed" && s.phase !== "pending") {
            // interrupted: roll back to last checkpoint, repeat boot + setup on redeploy
            s.progress = s.w.checkpointH === null ? 0 : s.saved;
            s.saved = s.progress;
            s.phase = "pending";
            s.restarts++;
          }
          if (s.vmIds.length === 0) closeSeg(s.w.id, hour);
        }
        events.push({ hour, kind: "delete", text: `${a.vmIds.length} VM(s) deleted${a.reason ? ` — ${a.reason}` : ""}` });
        continue;
      }
      const s = byId.get(a.wl);
      if (!s) continue;
      if (!isLegal(s.w, a.zone)) {
        disqualified = true;
        events.push({ hour, kind: "violation", text: `${a.wl} attempted in ${a.zone} — residency violation, run disqualified` });
        continue;
      }
      if (s.phase !== "pending" || hour < s.w.release) {
        events.push({ hour, kind: "reject", text: `${a.wl} not deployable now` });
        continue;
      }
      if (!fitsQuota(usageOf(vms), a.profile, a.workers)) {
        events.push({ hour, kind: "reject", text: `${a.wl} rejected: quota exceeded` });
        continue;
      }
      const ids: string[] = [];
      for (let i = 0; i < a.workers; i++) {
        const vm: VM = { id: `vm-${++vmSeq}`, wl: s.w.id, zone: a.zone, profile: a.profile, created: hour, deleted: null };
        vms.push(vm);
        ids.push(vm.id);
      }
      Object.assign(s, { vmIds: ids, phase: "boot", phaseLeft: BOOT_H, zone: a.zone, profile: a.profile, workers: a.workers, sinceCkpt: 0 });
      events.push({ hour, kind: "deploy", text: `${s.w.id} → ${a.zone} · ${a.workers}× ${a.profile}${a.reason ? ` — ${a.reason}` : ""}` });
    }

    // advance physics for one step
    let gThisStep = 0;
    let kwThisStep = 0;
    for (const s of ws) {
      if (s.vmIds.length === 0) {
        if (s.phase === "pending" && hour + DT > s.w.deadline && s.doneAt === null) {
          s.phase = "missed";
          events.push({ hour, kind: "missed", text: `${s.w.id} missed its deadline` });
        }
        continue;
      }
      const z = zoneById(s.zone!);
      const p = profileById(s.profile!);
      const active = s.phase !== "done" && s.phase !== "missed";
      const kw = (active ? p.kw : p.idleKw) * s.workers * z.pue;
      const e = kw * DT;
      const g = e * actual[z.id]![step]!;
      s.energyKWh += e;
      s.carbonG += g;
      if (!active) idleCarbon += g;
      gThisStep += g;
      kwThisStep += kw;
      markSeg(s, active ? s.phase : "idle", hour);

      if (s.phase === "boot" || s.phase === "setup" || s.phase === "output") {
        s.phaseLeft -= DT;
        if (s.phaseLeft <= 1e-9) {
          if (s.phase === "boot") { s.phase = "setup"; s.phaseLeft = s.w.setupH; }
          else if (s.phase === "setup") { s.phase = "compute"; }
          else { s.phase = "done"; s.doneAt = hour + DT; events.push({ hour: hour + DT, kind: "done", text: `${s.w.id} delivered output` }); }
        }
      } else if (s.phase === "compute") {
        s.progress = Math.min(s.w.work, s.progress + ratePerHour(s.w, s.profile!, s.workers) * DT);
        s.sinceCkpt += DT;
        if (s.w.checkpointH !== null && s.sinceCkpt >= s.w.checkpointH - 1e-9) { s.saved = s.progress; s.sinceCkpt = 0; }
        if (s.progress >= s.w.work - 1e-9) { s.phase = "output"; s.phaseLeft = s.w.outputH; }
      }
      if (s.phase !== "done" && s.phase !== "missed" && hour + DT >= s.w.deadline - 1e-9 && s.doneAt === null) {
        s.phase = "missed";
        events.push({ hour: hour + DT, kind: "missed", text: `${s.w.id} missed its deadline` });
      }
    }
    carbonSeries.push({ hour, gPerH: gThisStep / DT, kW: kwThisStep });
  }
  for (const s of ws) closeSeg(s.w.id, HORIZON_H);

  const totalCarbon = ws.reduce((a, s) => a + s.carbonG, 0);
  return {
    policy: policy.id, seed, disqualified, workloads: ws, segments, events, carbonSeries,
    totalCarbonKg: totalCarbon / 1000, idleCarbonKg: idleCarbon / 1000,
    totalEnergyKWh: ws.reduce((a, s) => a + s.energyKWh, 0),
    score: scoreRun(ws, disqualified), actual,
  };
}
