import { HORIZON_H } from "@/lib/sim/data";
import type { RunResult, Segment } from "@/lib/sim/engine";
import { cn } from "@/lib/utils";

const phaseClass: Record<Segment["phase"], string> = {
  pending: "bg-muted",
  boot: "bg-phase-boot",
  setup: "bg-phase-setup",
  compute: "bg-phase-compute",
  output: "bg-phase-output",
  done: "bg-muted",
  missed: "bg-destructive",
  idle: "bg-phase-idle",
};

const pct = (h: number) => `${(h / HORIZON_H) * 100}%`;

export function Timeline({ run }: { run: RunResult }) {
  return (
    <div className="space-y-1.5">
      <div className="relative ml-44 h-5 font-mono-data text-[10px] text-muted-foreground">
        {[0, 24, 48, 72, 96, 120].map((h) => (
          <span key={h} className="absolute -translate-x-1/2" style={{ left: pct(h) }}>
            {h}h
          </span>
        ))}
      </div>
      {run.workloads.map((s) => {
        const segs = run.segments.filter((g) => g.wl === s.w.id);
        return (
          <div key={s.w.id} className="flex items-center gap-2">
            <div className="w-42 shrink-0 truncate text-xs">
              <span className="font-mono-data text-muted-foreground">{s.w.id}</span>{" "}
              {s.w.name}
            </div>
            <div className="relative h-6 flex-1 rounded-sm bg-secondary/60">
              <div
                className="absolute inset-y-0 border-l border-dashed border-muted-foreground/50 bg-background/40"
                style={{ left: 0, width: pct(s.w.release) }}
                title="not yet released"
              />
              <div
                className="absolute inset-y-0 border-l-2 border-destructive"
                style={{ left: pct(s.w.deadline) }}
                title={`deadline ${s.w.deadline}h`}
              />
              {segs.map((g, i) => (
                <div
                  key={i}
                  className={cn("absolute inset-y-1 rounded-[2px]", phaseClass[g.phase])}
                  style={{ left: pct(g.start), width: pct(Math.max(0.25, g.end - g.start)) }}
                  title={`${g.phase} · ${g.zone} · ${g.workers}× ${g.profile} · ${g.start}–${g.end}h`}
                />
              ))}
              {segs
                .filter((g) => g.phase === "compute")
                .slice(0, 1)
                .map((g) => (
                  <span
                    key="z"
                    className="pointer-events-none absolute top-1/2 -translate-y-1/2 pl-1 font-mono-data text-[10px] text-primary-foreground"
                    style={{ left: pct(g.start) }}
                  >
                    {g.zone}
                  </span>
                ))}
            </div>
          </div>
        );
      })}
      <div className="ml-44 flex flex-wrap gap-4 pt-2 text-xs text-muted-foreground">
        {(["boot", "setup", "compute", "output", "idle"] as const).map((p) => (
          <span key={p} className="flex items-center gap-1.5">
            <span className={cn("size-2.5 rounded-sm", phaseClass[p])} /> {p === "idle" ? "idle (not deleted)" : p}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-3 border-l-2 border-destructive" /> deadline
        </span>
      </div>
    </div>
  );
}
