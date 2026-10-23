import { describe, expect, it } from "vitest";
import { WORKLOADS, ZONES, isLegal, legalZones } from "./data";
import { runSimulation, type Policy } from "./engine";
import { baselinePolicy, carbonAwarePolicy } from "./policies";

describe("GreenOps simulation rules", () => {
  it("has 15 workloads and 11 zones across 8 countries", () => {
    expect(WORKLOADS).toHaveLength(15);
    expect(ZONES).toHaveLength(11);
    expect(new Set(ZONES.map((z) => z.country)).size).toBe(8);
  });

  it("EU residency excludes Switzerland", () => {
    const w = WORKLOADS.find((x) => x.id === "wl-03")!;
    expect(isLegal(w, "ch-gva-2")).toBe(false);
    expect(legalZones(w).some((z) => z.country === "CH")).toBe(false);
  });

  it("an illegal placement attempt disqualifies the run with score 0", () => {
    const bad: Policy = { id: "bad", name: "bad", decide: (v) => (v.step === 0 ? [{ type: "deploy", wl: "wl-01", zone: "fr-par-x", profile: "cpu.mega", workers: 1 }] : []) };
    const r = runSimulation(bad, 1);
    expect(r.disqualified).toBe(true);
    expect(r.score.total).toBe(0);
  });

  it("never exceeds 20 VMs or 320 vCPU", () => {
    const greedy: Policy = { id: "g", name: "g", decide: (v) => v.workloads.filter((s) => s.phase === "pending").map((s) => ({ type: "deploy" as const, wl: s.w.id, zone: legalZones(s.w)[0]!.id, profile: s.w.kind === "cpu" ? "cpu.mega" : "gpua40.small", workers: 4 })) };
    const r = runSimulation(greedy, 2);
    expect(r.events.some((e) => e.text.includes("quota exceeded"))).toBe(true);
  });

  it("both shipped policies stay legal and the carbon-aware one emits less", () => {
    const b = runSimulation(baselinePolicy, 7);
    const c = runSimulation(carbonAwarePolicy, 7);
    expect(b.disqualified).toBe(false);
    expect(c.disqualified).toBe(false);
    expect(c.totalCarbonKg).toBeLessThan(b.totalCarbonKg);
  });
});
