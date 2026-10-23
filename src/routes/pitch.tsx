import { createFileRoute } from "@tanstack/react-router";
import { useMemo } from "react";

import { runSimulation } from "@/lib/sim/engine";
import { baselinePolicy, carbonAwarePolicy } from "@/lib/sim/policies";

export const Route = createFileRoute("/pitch")({
  head: () => ({
    meta: [
      { title: "Our approach — GreenOps Orchestrator pitch" },
      { name: "description", content: "How our controller decides when, where and on which resources to run work, with evidence, trade-offs and limitations." },
      { property: "og:title", content: "Our approach — GreenOps Orchestrator pitch" },
      { property: "og:description", content: "Approach, evidence, trade-offs and limitations of a carbon-aware cloud scheduler." },
    ],
  }),
  component: Pitch,
});

const SEEDS = [1, 7, 42, 99, 314, 2026];

function Pitch() {
  const rows = useMemo(
    () =>
      SEEDS.map((seed) => {
        const b = runSimulation(baselinePolicy, seed);
        const c = runSimulation(carbonAwarePolicy, seed);
        return { seed, b, c };
      }),
    [],
  );
  const avg = (f: (r: (typeof rows)[number]) => number) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
  const cut = avg((r) => 1 - r.c.totalCarbonKg / r.b.totalCarbonKg);

  return (
    <main className="mx-auto max-w-5xl space-y-14 px-6 py-12">
      <section>
        <p className="label-eyebrow">The Energy Bridge Hackathon · Exoscale GreenOps Challenge</p>
        <h1 className="mt-3 text-5xl font-bold tracking-tight">
          {Math.round(cut * 100)}% less carbon,<br /><span className="text-primary">every deadline met.</span>
        </h1>
        <p className="mt-4 max-w-2xl text-lg text-muted-foreground">
          An hourly re-planning controller that picks start time, zone, hardware and worker count from the forecast it is given — and
          never anything else.
        </p>
      </section>

      <Block n="01" title="Approach">
        <ul className="space-y-3">
          <Li t="Legal first">Every candidate zone is filtered by the workload's country list before anything is scored. A forbidden placement is never even attempted.</Li>
          <Li t="Score every option">For each waiting workload: every legal zone × feasible profile (GPU memory, family availability) × 1–N workers × every start time that still leaves a safety margin before the deadline. Cost = forecast gCO₂/kWh over the whole boot + setup + compute + output window × power × PUE.</Li>
          <Li t="Wait only when it pays">If a later window is more than 8% cleaner and still reachable with margin, wait. Otherwise deploy the cleanest option available right now.</Li>
          <Li t="Tightest slack first">Workloads with the least slack claim the shared 20 VM / 320 vCPU / GPU quota first.</Li>
          <Li t="Delete on delivery">VMs are deleted the moment output is delivered, so no idle power counts against the 120-hour window.</Li>
        </ul>
      </Block>

      <Block n="02" title="Evidence">
        <div className="panel overflow-x-auto p-5">
          <table className="w-full text-sm">
            <thead className="label-eyebrow text-left">
              <tr className="border-b border-border">{["Scenario", "Baseline kgCO₂", "Ours kgCO₂", "Cut", "Baseline score", "Our score", "Completed"].map((h) => <th key={h} className="py-2 pr-3 font-normal">{h}</th>)}</tr>
            </thead>
            <tbody className="font-mono-data">
              {rows.map(({ seed, b, c }) => (
                <tr key={seed} className="border-b border-border/50">
                  <td className="py-2 pr-3">#{seed}</td>
                  <td className="pr-3">{b.totalCarbonKg.toFixed(1)}</td>
                  <td className="pr-3 text-primary">{c.totalCarbonKg.toFixed(1)}</td>
                  <td className="pr-3">−{Math.round((1 - c.totalCarbonKg / b.totalCarbonKg) * 100)}%</td>
                  <td className="pr-3">{Math.round(b.score.total).toLocaleString("en")}</td>
                  <td className="pr-3 text-primary">{Math.round(c.score.total).toLocaleString("en")}</td>
                  <td className="pr-3">{c.workloads.filter((s) => s.phase === "done").length}/15</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-muted-foreground">Simulated runs with 25% forecast error. Replace with the official practice-run results before presenting.</p>
        </div>
      </Block>

      <Block n="03" title="Trade-offs">
        <ul className="space-y-3">
          <Li t="Swiss-only and DACH work">Has no clean escape hatch outside CH — we accept Swiss hours as they come and only shift the start time.</Li>
          <Li t="No mid-run migration">Moving a job loses work back to the last checkpoint and repeats setup (2 h for the analytics job). Choosing well up front beat moving later in our runs.</Li>
          <Li t="More workers ≠ always better">Parallel efficiency drops per extra worker, so extra VMs burn more energy. We add workers only when the cleaner window is otherwise unreachable.</Li>
          <Li t="Safety margin">A 20% margin costs a little carbon but protects the 5,000-point completion bonus against forecast misses.</Li>
        </ul>
      </Block>

      <Block n="04" title="Limitations & next steps">
        <ul className="space-y-3">
          <Li t="Forecast trust">We treat the forecast as truth inside the margin; a forecast-error model per lead time would size the margin better.</Li>
          <Li t="Greedy quota use">Workloads are planned one at a time; a joint optimisation (MILP) could share GPU quota better.</Li>
          <Li t="Checkpoint-aware moves">Allow migration when remaining work is large and the saving clearly exceeds the lost progress.</Li>
        </ul>
      </Block>
    </main>
  );
}

function Block({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-6 md:grid-cols-[160px_1fr]">
      <div>
        <p className="font-mono-data text-primary">{n}</p>
        <h2 className="text-2xl font-semibold">{title}</h2>
      </div>
      <div>{children}</div>
    </section>
  );
}
function Li({ t, children }: { t: string; children: React.ReactNode }) {
  return (
    <li className="border-l-2 border-primary/60 pl-4">
      <p className="font-semibold">{t}</p>
      <p className="text-muted-foreground">{children}</p>
    </li>
  );
}
