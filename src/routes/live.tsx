import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Pause, Play, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKLOADS, ZONES, isLegal } from "@/lib/sim/data";
import { exoGet } from "@/lib/live.functions";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live run — GreenOps Orchestrator" },
      { name: "description", content: "Watch a GreenOps practice run: VMs, zones, workload status and residency checks, polled from the run's Exoscale-compatible API." },
      { property: "og:title", content: "Live run — GreenOps Orchestrator" },
      { property: "og:description", content: "Live view of VMs and workload status for a GreenOps practice run." },
    ],
  }),
  component: Live,
});

type Instance = { id: string; name?: string; state?: string; zone?: string; "instance-type"?: { id?: string; family?: string; size?: string }; "user-data"?: string; "created-at"?: string };

function decodeUserData(u?: string) {
  if (!u) return "";
  try { return atob(u); } catch { return u; }
}
function workloadFrom(u: string) {
  return WORKLOADS.find((w) => u.includes(w.id))?.id ?? null;
}

function Live() {
  const call = useServerFn(exoGet);
  const [endpoint, setEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [statusPath, setStatusPath] = useState("/work-status");
  const [zone, setZone] = useState("de-fra-1");
  const [polling, setPolling] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [status, setStatus] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      setError(null);
      const zoneEndpoint = endpoint.replace("{zone}", zone);
      const inst = await call({ data: { endpoint: zoneEndpoint, key, secret, path: "/instance" } });
      if (!inst.ok) throw new Error(`Instances: HTTP ${inst.status}`);
      setInstances(((inst.body as { instances?: Instance[] })?.instances ?? []).map((i) => ({ ...i, zone: i.zone ?? zone })));
      if (statusPath) {
        const st = await call({ data: { endpoint: zoneEndpoint, key, secret, path: statusPath } });
        setStatus(st.ok ? st.body : `HTTP ${st.status}`);
      }
      setLast(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPolling(false);
    }
  }

  useEffect(() => {
    if (!polling) { if (timer.current) clearInterval(timer.current); return; }
    poll();
    timer.current = setInterval(poll, 10000);
    return () => { if (timer.current) clearInterval(timer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  const ready = endpoint && key && secret;

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-6 py-10">
      <div>
        <p className="label-eyebrow">Practice run monitor</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Live run</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Paste the endpoint and API credentials of one practice run. The page polls it every 10 seconds, read-only, and flags any VM
          whose workload sits in a country that workload is not allowed in.
        </p>
      </div>

      <section className="panel grid gap-4 p-5 md:grid-cols-2">
        <Field label="API endpoint (use {zone} if zone-specific)" value={endpoint} onChange={setEndpoint} placeholder="https://api-{zone}.your-run.example/v2" />
        <div className="space-y-1.5">
          <Label className="label-eyebrow">Zone</Label>
          <select value={zone} onChange={(e) => setZone(e.target.value)} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
            {ZONES.map((z) => <option key={z.id} value={z.id}>{z.id} ({z.country})</option>)}
          </select>
        </div>
        <Field label="API key" value={key} onChange={setKey} placeholder="EXO…" />
        <Field label="API secret" value={secret} onChange={setSecret} type="password" />
        <Field label="Work-status path (from the run docs)" value={statusPath} onChange={setStatusPath} placeholder="/work-status" />
        <div className="flex items-end gap-3">
          <Button disabled={!ready} onClick={() => setPolling((p) => !p)}>
            {polling ? <><Pause /> Stop polling</> : <><Play /> Start polling</>}
          </Button>
          {last && <span className="font-mono-data text-xs text-muted-foreground">updated {last.toLocaleTimeString()}</span>}
        </div>
        <p className="text-xs text-muted-foreground md:col-span-2">Credentials stay in this tab only and are sent just to make each signed request. Use run credentials, never production keys.</p>
        {error && <p className="text-sm text-destructive md:col-span-2">{error}</p>}
      </section>

      <section className="panel overflow-x-auto p-5">
        <p className="label-eyebrow">VMs in {zone}</p>
        <table className="mt-3 w-full text-sm">
          <thead className="label-eyebrow text-left">
            <tr className="border-b border-border">{["Name", "Type", "State", "Workload", "Residency", "Created"].map((h) => <th key={h} className="py-2 pr-3 font-normal">{h}</th>)}</tr>
          </thead>
          <tbody>
            {instances.length === 0 && <tr><td colSpan={6} className="py-6 text-center text-muted-foreground">No VMs yet.</td></tr>}
            {instances.map((i) => {
              const wl = workloadFrom(decodeUserData(i["user-data"]));
              const w = WORKLOADS.find((x) => x.id === wl);
              const legal = w && i.zone ? isLegal(w, i.zone) : null;
              return (
                <tr key={i.id} className="border-b border-border/50">
                  <td className="py-2 pr-3">{i.name ?? i.id}</td>
                  <td className="pr-3 font-mono-data text-xs">{i["instance-type"]?.family ?? ""}.{i["instance-type"]?.size ?? i["instance-type"]?.id ?? ""}</td>
                  <td className="pr-3">{i.state}</td>
                  <td className="pr-3 font-mono-data">{wl ?? "—"}</td>
                  <td className="pr-3">
                    {legal === null ? <span className="text-muted-foreground">unknown</span> : legal ? <span className="text-primary">allowed</span> : <span className="flex items-center gap-1 text-destructive"><ShieldAlert className="size-4" /> forbidden</span>}
                  </td>
                  <td className="pr-3 font-mono-data text-xs">{i["created-at"] ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className="panel p-5">
        <p className="label-eyebrow">Work status</p>
        <pre className="mt-3 max-h-96 overflow-auto font-mono-data text-xs text-muted-foreground">{status ? JSON.stringify(status, null, 2) : "Nothing polled yet."}</pre>
      </section>
    </main>
  );
}

function Field({ label, value, onChange, placeholder, type = "text" }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }) {
  return (
    <div className="space-y-1.5">
      <Label className="label-eyebrow">{label}</Label>
      <Input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} autoComplete="off" />
    </div>
  );
}
