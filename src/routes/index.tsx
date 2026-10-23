import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { Area, AreaChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Shuffle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Timeline } from "@/components/sim/Timeline";
import { DT, QUOTA, WORKLOADS, ZONES } from "@/lib/sim/data";
import { runSimulation, type RunResult } from "@/lib/sim/engine";
import { baselinePolicy, makeCarbonAwarePolicy } from "@/lib/sim/policies";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "GreenOps Simulator — carbon-aware scheduling" },
      { name: "description", content: "Simulate 15 workloads over 120 hours in 11 European zones and compare a baseline against a carbon-aware scheduler." },
      { property: "og:title", content: "GreenOps Simulator — carbon-aware scheduling" },
      { property: "og:description", content: "Compare baseline vs carbon-aware cloud orchestration on simulated European grid carbon." },
    ],
  }),
  component: Simulator,
});

function intensityVar(base: number) {
  return base < 120 ? "var(--carbon-low)" : base < 350 ? "var(--carbon-mid)" : "var(--carbon-high)";
}

function Simulator() {
  const [seed, setSeed] = useState(7);
  const [err, setErr] = useState(0.25);
  const [safety, setSafety] = useState(0.2);
  const [view, setView] = useState<"carbon-aware" | "baseline">("carbon-aware");

  const runs = useMemo(() => {
    const b = runSimulation(baselinePolicy, seed, err);
    const c = runSimulation(makeCarbonAwarePolicy({ safety }), seed, err);
    return { baseline: b, "carbon-aware": c } as { baseline: RunResult; "carbon-aware": RunResult };
  }, [seed, err, safety]);
  const run = runs[view];

  const intensityData = useMemo(() => {
    const rows = [];
    for (let h = 0; h < 120; h++) {
      const row: Record<string, number> = { h };
      for (const z of ZONES) row[z.id] = Math.round(run.actual[z.id]![h / DT]!);
      rows.push(row);
    }
    return rows;
  }, [run]);

  const fleetData = useMemo(
    () =>
      runs.baseline.carbonSeries
        .filter((_, i) => i % 2 === 0)
        .map((p, i) => ({ h: p.hour, baseline: p.gPerH / 1000, aware: runs["carbon-aware"].carbonSeries[i * 2]!.gPerH / 1000 })),
    [runs],
  );

  return (
    <main className="mx-auto max-w-7xl space-y-8 px-6 py-10">
      <section className="grid gap-8 lg:grid-cols-[1.4fr_1fr] lg:items-end">
        <div>
          <p className="label-eyebrow">Exoscale GreenOps Challenge · Vienna · 23–25 Oct 2026</p>
          <h1 className="mt-3 text-4xl font-bold tracking-tight md:text-5xl">
            Same work. <span className="text-primary">Less carbon.</span>
          </h1>
          <p className="mt-3 max-w-xl text-muted-foreground">
            15 workloads, 120 simulated hours, 11 zones across 8 countries and a shared budget of {QUOTA.vms} VMs /{" "}
            {QUOTA.vcpu} vCPU. The scheduler only sees the forecast published at each hour.
          </p>
        </div>
        <div className="panel space-y-5 p-5">
          <div className="flex items-center justify-between">
            <div>
              <p className="label-eyebrow">Scenario seed</p>
              <p className="font-mono-data text-2xl">{seed}</p>
            </div>
            <Button variant="secondary" onClick={() => setSeed(Math.floor(Math.random() * 9999))}>
              <Shuffle /> New scenario
            </Button>
          </div>
          <Control label="Forecast error" value={`${Math.round(err * 100)}%`}>
            <Slider min={0} max={0.8} step={0.05} value={[err]} onValueChange={([v]) => setErr(v ?? 0)} />
          </Control>
          <Control label="Deadline safety margin" value={`${Math.round(safety * 100)}%`}>
            <Slider min={0} max={0.6} step={0.05} value={[safety]} onValueChange={([v]) => setSafety(v ?? 0)} />
          </Control>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <Kpis title="Baseline" sub="start on release · fixed home zone" r={runs.baseline} />
        <Kpis title="Carbon-aware" sub="forecast window · zone · profile · workers" r={runs["carbon-aware"]} against={runs.baseline} highlight />
      </section>

      <section className="panel p-5">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="label-eyebrow">Allocation timeline</p>
            <h2 className="text-lg font-semibold">What the controller did, hour by hour</h2>
          </div>
          <Tabs value={view} onValueChange={(v) => setView(v as typeof view)}>
            <TabsList>
              <TabsTrigger value="carbon-aware">Carbon-aware</TabsTrigger>
              <TabsTrigger value="baseline">Baseline</TabsTrigger>
            </TabsList>
          </Tabs>
        </div>
        <Timeline run={run} />
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="panel p-5">
          <p className="label-eyebrow">Grid carbon intensity (observed)</p>
          <h2 className="mb-3 text-lg font-semibold">gCO₂/kWh by zone</h2>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={intensityData}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="h" stroke="var(--muted-foreground)" fontSize={11} ticks={[0, 24, 48, 72, 96]} />
              <YAxis stroke="var(--muted-foreground)" fontSize={11} width={36} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", fontSize: 12 }} />
              {ZONES.map((z) => (
                <Line key={z.id} dataKey={z.id} dot={false} strokeWidth={1.3} stroke={intensityVar(z.baseIntensity)} isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="panel p-5">
          <p className="label-eyebrow">Fleet emissions rate</p>
          <h2 className="mb-3 text-lg font-semibold">kgCO₂ per hour</h2>
          <ResponsiveContainer width="100%" height={260}>
            <AreaChart data={fleetData}>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" />
              <XAxis dataKey="h" stroke="var(--muted-foreground)" fontSize={11} ticks={[0, 24, 48, 72, 96]} />
              <YAxis stroke="var(--muted-foreground)" fontSize={11} width={36} />
              <Tooltip contentStyle={{ background: "var(--popover)", border: "1px solid var(--border)", fontSize: 12 }} formatter={(v: number) => v.toFixed(2)} />
              <Area dataKey="baseline" stroke="var(--carbon-high)" fill="var(--carbon-high)" fillOpacity={0.2} isAnimationActive={false} />
              <Area dataKey="aware" name="carbon-aware" stroke="var(--primary)" fill="var(--primary)" fillOpacity={0.3} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="panel overflow-x-auto p-5">
        <p className="label-eyebrow">Workload pack</p>
        <h2 className="mb-3 text-lg font-semibold">Constraints and outcome ({view})</h2>
        <table className="w-full text-sm">
          <thead className="label-eyebrow text-left">
            <tr className="border-b border-border">
              {["ID", "Workload", "Window", "Allowed", "Needs", "Placed", "Restarts", "kgCO₂", "Points", "Status"].map((h) => (
                <th key={h} className="py-2 pr-3 font-normal">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {run.workloads.map((s) => (
              <tr key={s.w.id} className="border-b border-border/50">
                <td className="py-2 pr-3 font-mono-data text-muted-foreground">{s.w.id}</td>
                <td className="pr-3">{s.w.name}{s.w.note && <div className="text-xs text-muted-foreground">{s.w.note}</div>}</td>
                <td className="pr-3 font-mono-data">{s.w.release}–{s.w.deadline}h</td>
                <td className="pr-3 font-mono-data text-xs">{s.w.countries.join(" ")}</td>
                <td className="pr-3 text-xs">{s.w.kind.toUpperCase()}{s.w.minGpuMemGB ? ` ≥${s.w.minGpuMemGB}GB` : ""} · setup {s.w.setupH}h · {s.w.checkpointH ? `ckpt ${s.w.checkpointH}h` : "no ckpt"}</td>
                <td className="pr-3 font-mono-data text-xs">{s.zone ? `${s.zone} · ${s.workers}× ${s.profile}` : "—"}</td>
                <td className="pr-3 font-mono-data">{s.restarts}</td>
                <td className="pr-3 font-mono-data">{(s.carbonG / 1000).toFixed(2)}</td>
                <td className="pr-3 font-mono-data">{Math.round(run.score.perWorkload[s.w.id] ?? 0)}</td>
                <td className={s.phase === "done" ? "text-primary" : "text-destructive"}>{s.phase === "done" ? `done @${s.doneAt}h` : s.phase}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="panel p-5">
        <p className="label-eyebrow">Decision log ({view})</p>
        <ol className="mt-3 max-h-72 space-y-1 overflow-y-auto font-mono-data text-xs">
          {run.events.map((e, i) => (
            <li key={i} className={e.kind === "violation" || e.kind === "missed" ? "text-destructive" : e.kind === "done" ? "text-primary" : "text-muted-foreground"}>
              <span className="inline-block w-16 text-foreground">{e.hour.toFixed(2)}h</span>
              {e.text}
            </li>
          ))}
        </ol>
      </section>

      <p className="text-xs text-muted-foreground">
        Sample data shaped after the brief ({WORKLOADS.length} workloads, {ZONES.length} zones). Score uses an approximate model of the frozen policy: up to
        20,000 base points weighted by reference energy plus a 5,000 bonus when everything completes on time. Results are game results, not real emissions.
      </p>
    </main>
  );
}

function Control({ label, value, children }: { label: string; value: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="flex justify-between">
        <span className="label-eyebrow">{label}</span>
        <span className="font-mono-data text-sm">{value}</span>
      </div>
      {children}
    </div>
  );
}

function Kpis({ title, sub, r, against, highlight }: { title: string; sub: string; r: RunResult; against?: RunResult; highlight?: boolean | undefined }) {
  const done = r.workloads.filter((s) => s.phase === "done").length;
  const saved = against ? 1 - r.totalCarbonKg / against.totalCarbonKg : null;
  return (
    <div className={highlight ? "panel border-primary/60 p-5" : "panel p-5"}>
      <div className="flex items-baseline justify-between">
        <h3 className="text-lg font-semibold">{title}</h3>
        <span className="text-xs text-muted-foreground">{sub}</span>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label="Score" value={Math.round(r.score.total).toLocaleString("en")} accent={highlight} />
        <Stat label="kgCO₂" value={r.totalCarbonKg.toFixed(1)} hint={saved !== null ? `−${Math.round(saved * 100)}% vs baseline` : undefined} />
        <Stat label="Completed" value={`${done}/${r.workloads.length}`} hint={r.score.bonus ? "+5,000 bonus" : "no bonus"} />
        <Stat label="Idle kgCO₂" value={r.idleCarbonKg.toFixed(2)} hint={r.disqualified ? "DISQUALIFIED" : `${r.totalEnergyKWh.toFixed(0)} kWh`} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string | undefined; accent?: boolean | undefined }) {
  return (
    <div>
      <p className="label-eyebrow">{label}</p>
      <p className={accent ? "font-mono-data text-2xl text-primary" : "font-mono-data text-2xl"}>{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
