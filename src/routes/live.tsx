import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useRef, useState } from "react";
import { Pause, Play, ShieldAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { WORKLOADS, isLegal } from "@/lib/sim/data";
import { exoGet, gridGet, hasEnvConfig } from "@/lib/live.functions";

export const Route = createFileRoute("/live")({
  head: () => ({
    meta: [
      { title: "Live run — GreenOps Orchestrator" },
      {
        name: "description",
        content:
          "Watch a GreenOps practice run: VMs, zones, workload status and residency checks, polled from the run's Exoscale-compatible API.",
      },
      { property: "og:title", content: "Live run — GreenOps Orchestrator" },
      {
        property: "og:description",
        content: "Live view of VMs and workload status for a GreenOps practice run.",
      },
    ],
  }),
  component: Live,
});

type ZoneInfo = { name: string; "api-endpoint": string };
type Instance = {
  id: string;
  name?: string;
  state?: string;
  zone?: string;
  "instance-type"?: { id?: string; family?: string; size?: string };
  "user-data"?: string;
  "created-at"?: string;
};
type WorkStatus = {
  virtual_time?: string;
  speed_multiplier?: number;
  state?: string;
  qualification?: string;
  workloads?: {
    id: string;
    state: string;
    completed_work: string;
    required_work: string;
    final_output_delivered: boolean;
  }[];
};

function decodeUserData(u?: string) {
  if (!u) return "";
  try {
    return atob(u);
  } catch {
    return u;
  }
}
function workloadFrom(u: string) {
  // Real run IDs look like "w-01-dach-research"; the sim catalog uses "wl-01"…"wl-15" in the same order.
  const m = u.match(/w-(\d{2})/);
  if (!m) return null;
  const simId = `wl-${m[1]}`;
  return WORKLOADS.some((w) => w.id === simId) ? simId : null;
}
function countryOf(zoneName: string) {
  return zoneName.split("-")[0]?.toUpperCase() ?? "";
}

function Live() {
  const call = useServerFn(exoGet);
  const grid = useServerFn(gridGet);
  const envCheck = useServerFn(hasEnvConfig);
  const [cloudEndpoint, setCloudEndpoint] = useState("");
  const [workEndpoint, setWorkEndpoint] = useState("");
  const [gridEndpoint, setGridEndpoint] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");
  const [gridSecret, setGridSecret] = useState("");
  const [polling, setPolling] = useState(false);
  const [useEnv, setUseEnv] = useState(false);
  const [zones, setZones] = useState<ZoneInfo[]>([]);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [status, setStatus] = useState<WorkStatus | null>(null);
  const [carbon, setCarbon] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [last, setLast] = useState<Date | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function poll() {
    try {
      setError(null);
      // 1. Zone discovery (public)
      const z = await call({
        data: useEnv ? { path: "/zone" } : { endpoint: cloudEndpoint, key, secret, path: "/zone" },
      });
      if (!z.ok) throw new Error(`Zones: HTTP ${z.status}`);
      const zoneList = (z.body as { zones?: ZoneInfo[] })?.zones ?? [];
      setZones(zoneList);

      // 2. Instances per zone (signed)
      const all: Instance[] = [];
      for (const zn of zoneList) {
        const inst = await call({
          data: useEnv
            ? { endpoint: zn["api-endpoint"], path: "/instance" }
            : { endpoint: zn["api-endpoint"], key, secret, path: "/instance" },
        });
        if (inst.ok) {
          for (const i of (inst.body as { instances?: Instance[] })?.instances ?? [])
            all.push({ ...i, zone: zn.name });
        }
      }
      setInstances(all);

      // 3. Work status (signed, full prefixed path)
      if (workEndpoint) {
        const st = await call({
          data: useEnv
            ? { workFallback: true, path: "/status" }
            : { endpoint: workEndpoint, key, secret, path: "/status" },
        });
        if (st.ok) setStatus(st.body as WorkStatus);
      }

      // 4. Latest carbon per electricity area (grid secret)
      if (gridEndpoint && gridSecret) {
        const areas = [...new Set(zoneList.map((zn) => countryOf(zn.name)))];
        const out: Record<string, number> = {};
        for (const a of areas) {
          const c = await grid({
            data: useEnv
              ? { path: "/carbon-intensity/latest", query: { zone: a } }
              : {
                  endpoint: gridEndpoint,
                  secret: gridSecret,
                  path: "/carbon-intensity/latest",
                  query: { zone: a },
                },
          });
          const v = (c.body as { carbonIntensity?: number })?.carbonIntensity;
          if (c.ok && typeof v === "number") out[a] = v;
        }
        setCarbon(out);
      }
      setLast(new Date());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPolling(false);
    }
  }

  useEffect(() => {
    let alive = true;
    envCheck()
      .then((r: { cloud: boolean; work: boolean; grid: boolean }) => {
        if (!alive) return;
        if (r.cloud && r.work && r.grid) {
          setUseEnv(true);
          setPolling(true);
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!polling) {
      if (timer.current) clearInterval(timer.current);
      return;
    }
    poll();
    timer.current = setInterval(poll, 10000);
    return () => {
      if (timer.current) clearInterval(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polling]);

  const ready = useEnv || (cloudEndpoint && key && secret);
  const done = status?.workloads?.filter((w) => w.final_output_delivered).length ?? 0;
  const total = status?.workloads?.length ?? 0;

  return (
    <main className="mx-auto max-w-7xl space-y-6 px-6 py-10">
      <div>
        <p className="label-eyebrow">Practice run monitor</p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight">Live run</h1>
        <p className="mt-2 max-w-2xl text-muted-foreground">
          Paste the endpoints and credentials of one practice run (runner page → API credentials →
          Copy environment). The page polls every 10 seconds, read-only, and flags any VM whose
          workload sits in a country that workload is not allowed in.
        </p>
      </div>

      <section className="panel grid gap-4 p-5 md:grid-cols-2">
        {useEnv && (
          <p className="text-xs text-muted-foreground md:col-span-2">
            Credentials loaded from <code>.env</code> on the server — nothing below is sent to the
            browser. Fields are read-only; stop polling and clear <code>.env</code> to switch to
            manual entry.
          </p>
        )}
        <Field
          label="Cloud endpoint (.../cloud/v2)"
          value={useEnv ? "from server .env" : cloudEndpoint}
          onChange={setCloudEndpoint}
          placeholder="https://.../runs/<id>/cloud/v2"
          disabled={useEnv}
        />
        <Field
          label="Work endpoint (.../work/v1)"
          value={useEnv ? "from server .env" : workEndpoint}
          onChange={setWorkEndpoint}
          placeholder="https://.../runs/<id>/work/v1"
          disabled={useEnv}
        />
        <Field
          label="Grid endpoint (.../grid/v4)"
          value={useEnv ? "from server .env" : gridEndpoint}
          onChange={setGridEndpoint}
          placeholder="https://.../runs/<id>/grid/v4"
          disabled={useEnv}
        />
        <Field
          label="Grid secret"
          value={useEnv ? "•••••••• from server .env" : gridSecret}
          onChange={setGridSecret}
          type="password"
          disabled={useEnv}
        />
        <Field
          label="Cloud API key"
          value={useEnv ? "EXO•••••• from server .env" : key}
          onChange={setKey}
          placeholder="EXO..."
          disabled={useEnv}
        />
        <Field
          label="Cloud API secret"
          value={useEnv ? "•••••••• from server .env" : secret}
          onChange={setSecret}
          type="password"
          disabled={useEnv}
        />
        <div className="flex items-end gap-3">
          <Button disabled={!ready} onClick={() => setPolling((p) => !p)}>
            {polling ? (
              <>
                <Pause /> Stop polling
              </>
            ) : (
              <>
                <Play /> Start polling
              </>
            )}
          </Button>
          {last && (
            <span className="font-mono-data text-xs text-muted-foreground">
              updated {last.toLocaleTimeString()}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground md:col-span-2">
          Credentials either stay in this tab's memory only — never saved, never logged — or are
          read from <code>.env</code> on the server when present. Secrets never leave the server in
          env mode; the client only receives boolean flags. Use run credentials, never production
          keys.
        </p>
        {error && <p className="text-sm text-destructive md:col-span-2">{error}</p>}
      </section>

      {status && (
        <section className="panel grid gap-4 p-5 sm:grid-cols-4">
          <Stat label="Run state" value={status.state ?? "—"} />
          <Stat label="Qualification" value={status.qualification ?? "—"} />
          <Stat label="Virtual time" value={status.virtual_time ?? "—"} mono />
          <Stat label="Outputs delivered" value={`${done}/${total}`} />
        </section>
      )}

      <section className="panel overflow-x-auto p-5">
        <p className="label-eyebrow">VMs across {zones.length} zones</p>
        <table className="mt-3 w-full text-sm">
          <thead className="label-eyebrow text-left">
            <tr className="border-b border-border">
              {["Name", "Zone", "Type", "State", "Workload", "Residency", "Created"].map((h) => (
                <th key={h} className="py-2 pr-3 font-normal">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {instances.length === 0 && (
              <tr>
                <td colSpan={7} className="py-6 text-center text-muted-foreground">
                  No VMs yet.
                </td>
              </tr>
            )}
            {instances.map((i) => {
              const wl = workloadFrom(decodeUserData(i["user-data"]));
              const w = WORKLOADS.find((x) => x.id === wl);
              const legal = w && i.zone ? isLegal(w, i.zone) : null;
              return (
                <tr key={i.id} className="border-b border-border/50">
                  <td className="py-2 pr-3">{i.name ?? i.id}</td>
                  <td className="pr-3 font-mono-data text-xs">{i.zone}</td>
                  <td className="pr-3 font-mono-data text-xs">
                    {i["instance-type"]?.family ?? ""}.
                    {i["instance-type"]?.size ?? i["instance-type"]?.id ?? ""}
                  </td>
                  <td className="pr-3">{i.state}</td>
                  <td className="pr-3 font-mono-data">{wl ?? "—"}</td>
                  <td className="pr-3">
                    {legal === null ? (
                      <span className="text-muted-foreground">unknown</span>
                    ) : legal ? (
                      <span className="text-primary">allowed</span>
                    ) : (
                      <span className="flex items-center gap-1 text-destructive">
                        <ShieldAlert className="size-4" /> forbidden
                      </span>
                    )}
                  </td>
                  <td className="pr-3 font-mono-data text-xs">{i["created-at"] ?? ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {Object.keys(carbon).length > 0 && (
        <section className="panel p-5">
          <p className="label-eyebrow">Latest grid carbon intensity (gCO₂e/kWh)</p>
          <div className="mt-3 flex flex-wrap gap-3">
            {Object.entries(carbon)
              .sort((a, b) => a[1] - b[1])
              .map(([a, v]) => (
                <div key={a} className="rounded-md border border-border px-3 py-2">
                  <span className="label-eyebrow">{a}</span>
                  <p className="font-mono-data text-lg">{v.toFixed(0)}</p>
                </div>
              ))}
          </div>
        </section>
      )}

      <section className="panel p-5">
        <p className="label-eyebrow">Work status (raw)</p>
        <pre className="mt-3 max-h-96 overflow-auto font-mono-data text-xs text-muted-foreground">
          {status ? JSON.stringify(status, null, 2) : "Nothing polled yet."}
        </pre>
      </section>
    </main>
  );
}

function Stat({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <p className="label-eyebrow">{label}</p>
      <p className={`mt-1 text-lg font-semibold ${mono ? "font-mono-data text-sm" : ""}`}>
        {value}
      </p>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="label-eyebrow">{label}</Label>
      <Input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoComplete="off"
        disabled={disabled}
      />
    </div>
  );
}
