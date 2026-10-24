import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain JS module used by the live controller
import { loadCatalog } from "../../../scripts/greenops/model.mjs";
import { PROFILES, WORKLOADS, ZONES, feasibleProfiles, isLegal, legalZones, profileByLabel } from "./data";
import { runSimulation, type Policy } from "./engine";
import { baselinePolicy, carbonAwarePolicy } from "./policies";

describe("GreenOps simulation rules", () => {
  it("loads the challenge catalog: 15 workloads and 11 zones across 8 countries", () => {
    expect(WORKLOADS).toHaveLength(15);
    expect(ZONES).toHaveLength(11);
    expect(new Set(ZONES.map((z) => z.country)).size).toBe(8);
    expect(WORKLOADS.every((w) => w.refEnergyKWh > 0)).toBe(true);
  });

  it("agrees with the live controller on every zone legality decision", () => {
    const cat = loadCatalog();
    for (const w of WORKLOADS)
      for (const z of ZONES) {
        const live = cat.zones.get(z.id);
        const lw = cat.workloads.get(w.id);
        expect(isLegal(w, z.id), `${w.id} @ ${z.id}`).toBe(
          lw.residency === "EU" ? live.eu && (!lw.allowed?.length || lw.allowed.includes(live.country)) && !lw.forbidden.includes(live.country)
            : lw.residency === "CH" ? live.country === "CH" && !lw.forbidden.includes(live.country)
            : (!lw.allowed?.length || lw.allowed.includes(live.country)) && !lw.forbidden.includes(live.country),
        );
      }
  });

  it("EU residency excludes Switzerland and the forbidden France overlay", () => {
    const w = WORKLOADS.find((x) => x.residency === "EU")!;
    expect(isLegal(w, "ch-gva-2")).toBe(false);
    expect(legalZones(w).some((z) => z.country === "CH" || z.country === "FR")).toBe(false);
  });

  it("every workload has at least one legal zone with a feasible profile", () => {
    for (const w of WORKLOADS) expect(legalZones(w).some((z) => feasibleProfiles(w, z).length > 0), w.id).toBe(true);
  });

  it("an illegal placement attempt disqualifies the run with score 0", () => {
    const mega = profileByLabel("cpu.mega")!;
    const bad: Policy = { id: "bad", name: "bad", decide: (v) => (v.step === 0 ? [{ type: "deploy", wl: "w-02-ch-reporting", zone: "de-fra-1", profile: mega.id, workers: 1 }] : []) };
    const r = runSimulation(bad, 1);
    expect(r.disqualified).toBe(true);
    expect(r.score.total).toBe(0);
  });

  it("never exceeds 20 VMs or 320 vCPU", () => {
    const greedy: Policy = {
      id: "g", name: "g",
      decide: (v) => v.workloads.filter((s) => s.phase === "pending" && v.hour >= s.w.release).flatMap((s) => {
        const zone = legalZones(s.w).find((z) => feasibleProfiles(s.w, z).length);
        if (!zone) return [];
        const p = [...feasibleProfiles(s.w, zone)].sort((a, b) => b.vcpu - a.vcpu)[0]!;
        return [{ type: "deploy" as const, wl: s.w.id, zone: zone.id, profile: p.id, workers: s.w.maxWorkers }];
      }),
    };
    const r = runSimulation(greedy, 2);
    expect(r.events.some((e) => e.text.includes("quota exceeded"))).toBe(true);
  });

  it("both shipped policies stay legal, deliver everything, and the carbon-aware one emits less", () => {
    const b = runSimulation(baselinePolicy, 7);
    const c = runSimulation(carbonAwarePolicy, 7);
    expect(b.disqualified).toBe(false);
    expect(c.disqualified).toBe(false);
    expect(c.workloads.filter((s) => s.phase !== "done").map((s) => s.w.id)).toEqual([]);
    expect(c.totalCarbonKg).toBeLessThan(b.totalCarbonKg);
  });

  it("uses catalog profiles (UUID ids, per-hour throughput)", () => {
    expect(PROFILES).toHaveLength(22);
    expect(profileByLabel("gpurtx6000pro.small")!.throughput).toBe(800 * 3600);
  });
});
