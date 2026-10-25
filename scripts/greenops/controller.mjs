/** Latency-tolerant control loop, shared by the live entrypoint and the offline mock.
 *
 *  The challenge API can take many seconds per call while the run advances 0.2 simulated hours
 *  per wall second (720x), so nothing here ever blocks the loop on a network call:
 *   - status polls run in the background (a few in flight, staggered) and the freshest reply wins;
 *   - simulated "now" is extrapolated from the freshest reply and the run speed;
 *   - decisions are made for the moment an action will land (now + measured API latency), and
 *     deadline margins grow with that latency;
 *   - every create/stop/start/delete is fired asynchronously with in-flight guards, and its
 *     acknowledged effect is overlaid on stale status until a newer snapshot reflects it.
 *
 *  Deps are injected: api (status, forecast, create, findByName, vmAction, remove, listInstances),
 *  clock ({ now(), sleep(ms) }), log(fn), state ({ vms, seq, deleted }) + save().
 */
import { zoneLegal, profileLegal } from "./model.mjs";
import { decide } from "./policy.mjs";
import { Tracker, buildView } from "./glue.mjs";

const H = 3.6e6;
const ewma = (a, b, k = 0.3) => (a == null ? b : (1 - k) * a + k * b);

export const CONTROL = {
  loopMs: 250,           // decision cadence (wall)
  statusConcurrency: 4,  // status requests in flight at once (staggered) → fresher snapshots
  statusGapMs: 700,      // min wall gap between status request starts
  baseMarginH: 4,        // deadline margin before latency is added
  latencyMarginX: 2.5,   // + this many "action latencies" (in sim hours) of extra margin
  minDwellH: 0.1,        // don't stop the same VM again sooner than this (sim hours). Was 0.6: with fresh vintages a start
                         // decided from vintage h-1 that vintage h overturns was held running for most of a dirty hour
  maxLatH: 4,            // cap on the latency used for planning
  latRobust: true,       // planning latency = median of the last 15 calls (not an EWMA a single stall can blow up)
  rawTracker: false,     // measure compute rates from the engine's reported VM states only (see Tracker.observe)
  learnBias: true,       // learn each area's forecast error by lead time from this run's own published
                         // observations, and correct forecasts before the policy sees them
  biasShrinkN: 24,       // ...shrink a lead's mean error toward 0 with this many pseudo-samples
  biasCap: 0.3,          // ...never correct by more than +/-30 %
  nowcast: true,         // (with learnBias) carry the latest observed forecast miss forward, decaying by
                         // the hour-to-hour persistence this run's own misses show (off if they don't persist)
  nowcastMinN: 12,       // ...needs this many consecutive-hour pairs of observed lead-0 misses
  nowcastMinRho: 0.3,    // ...and at least this lag-1 autocorrelation
  nowcastLead0: false,   // when the current hour's observation is already published, use it for that hour
  obsShiftH: 0,          // which hour an observation stamped h describes: h (0) or h-1 (1); "auto" = whichever
                         // fits this run's own forecasts better (leads 0-3). Live runs 6e5310e5/51b1f33d: 0 fits
                         // 4-19 % better from hour 9 on, so 0 is the default
  obsShiftMinN: 24,      // ...once this many comparable forecast/observation pairs exist (until then: 0)
  freshFc: true,         // fetch each area's forecast until the held vintage is the server's current hour (a fetch
                         // fired as the action hour begins lands before the server's hour does, so it gets the old one)
  fcRetryMs: 100,        // ...wall gap between such re-fetches per area (live API answers in ~15 ms)
                         // (with freshFc, observations are re-fetched the same way until this hour's newest point arrives)
  placeVintages: 3,      // placement estimates average the newest N forecast vintages (each bias-corrected for its own
                         // lead): one vintage's level error otherwise decides a 35-46 h job's zone (mock: GPU zone flips)
  alignBoundary: true,   // sleep only until the next hour boundary (action time or server time), not a whole loop: at 720x
                         // a 250 ms loop is 0.05 sim h, and live run e5a54267's switches fired 0.047 h after the hour on average
  wakeOnData: true,      // decide as soon as a newer forecast vintage or observation arrives
  wakeDebounceMs: 30,    // ...after this short wait, so one hour's burst of replies triggers one decision
  infoDwell: true,       // inside the stop dwell, still allow a stop when new data arrived since the last toggle
  stallBufferS: 35,      // wall seconds a paused / not-yet-created job must keep before its deadline while the server shows
                         // stress (run f085e7d7: 3-5 s calls, then a 32 s start = 6.5 sim h at 720x, and a paused job missed)
  stallBaseS: 10,        // ...and always (mock: 10 s costs ~1 pt, 25 s ~11 pts, 35 s ~29 pts)
  stallTriggerMs: 2000,  // stress = a call slower than this, finished or still in flight,
  stallMemoryS: 60,      // ...within this many wall seconds
};

export class Controller {
  constructor({ cat, api, clock, log, state, save, run, opts = {}, policyOpts = {}, decideFn = decide, event = () => {} }) {
    Object.assign(this, { cat, api, clock, log, st: state, save, run, decideFn });
    // structured trace (one JSON object per line): when we decided, when the call returned, and how
    // much simulated time passed in between — for reviewing a 720x run afterwards
    this.event = (o) => { try { event({ wall: new Date(this.clock.now()).toISOString(), ...o }); } catch {} };
    this.o = { ...CONTROL, ...opts };
    // GPU pauses the clean-hour rule wanted but the safety checks refused (why, and who blocked) → trace
    this.policyOpts = { trace: (x) => this.event({ k: "why", ...x }), ...policyOpts };
    this.st.vms ??= {}; this.st.seq ??= 0; this.st.deleted ??= [];
    this.deleted = new Set(this.st.deleted);
    this.snap = null; this.statusInflight = 0; this.lastStatusStart = -1e15;
    this.fc = new Map(); this.fcInflight = new Set(); this.fcAsk = new Map(); this.fcTry = new Map();
    this.fcLog = new Map(); this.obs = new Map(); this.histHour = new Map(); this.histInflight = new Set(); this.biasCache = { hour: -1, b: new Map() };
    this.histTry = new Map(); this.histNewest = new Map(); this.histLag = null;
    this.dataVer = 0; this.align = { ver: -1, sh: 0, mse: null };
    this.inCreate = new Map(); // wl -> { zone, prof, k, left }
    this.inVm = new Map();     // vmId -> verb in flight
    this.override = new Map(); // vmId -> { state, wallAck, tAck }
    this.lastToggle = new Map(); // vmId -> sim hour of last acknowledged toggle
    this.toggleVer = new Map();  // vmId -> dataVer the last toggle was decided with
    this.wake = null;            // resolves the loop's current sleep early (wakeOnData)
    this.lat = { status: null, cloud: null }; this.latRecent = {}; this.statusOpen = new Set(); this.lastSlow = null;
    this.tracker = new Tracker();
    this.memo = new Map(); // policy's sticky reservations for waiting jobs
    this.adopting = new Set();
    this.done = false; this.finalizing = false; this.lastHourLogged = -1;
    this.stats = { creates: 0, stops: 0, starts: 0, deletes: 0, errors: 0 };
  }

  // ---------- background I/O ----------
  pollStatus() {
    const now = this.clock.now();
    if (this.statusInflight >= this.o.statusConcurrency || now - this.lastStatusStart < this.o.statusGapMs) return;
    this.statusInflight++; this.lastStatusStart = now;
    const t0 = now;
    this.statusOpen.add(t0);
    this.api.status().then((s) => {
      const t1 = this.clock.now();
      this.lat.status = ewma(this.lat.status, t1 - t0); this.latSample("status", t1 - t0);
      if (!s?.virtual_time) return;
      const vt = Date.parse(s.virtual_time);
      const snap = { s, vt, t: (vt - this.cat.T0) / H, wallAt: (t0 + t1) / 2, speed: Number(s.speed_multiplier) || 720, state: String(s.state ?? "").toUpperCase() };
      // freshest wins; READY/PAUSED replies don't advance vt, so prefer the later reply then
      if (!this.snap || snap.vt > this.snap.vt || (snap.vt === this.snap.vt && snap.wallAt >= this.snap.wallAt)) this.snap = snap;
      this.event({ k: "status", latMs: Math.round(t1 - t0), snapH: +snap.t.toFixed(3), state: snap.state, delivered: (s.workloads ?? []).filter((w) => w.final_output_delivered).length });
    }).catch(() => {}).finally(() => { this.statusInflight--; this.statusOpen.delete(t0); });
  }

  refreshForecasts(hour) {
    // freshFc: the server issues one vintage per hour, and `hour` (the action time) runs ahead of the server
    // clock by the API latency — a fetch fired as `hour` begins mostly returns the previous hour's vintage
    // (mock: 68 % of planning steps at 0.3 s lag). Re-fetch while the held vintage is older than the
    // server's hour, so hour h is planned from vintage h-1 by h-1 and corrected by vintage h as soon as it exists.
    const srvHour = Math.floor(this.tNow() ?? hour), wall = this.clock.now();
    for (const a of new Set([...this.cat.zones.values()].map((z) => z.area))) {
      if (this.fcInflight.has(a)) continue;
      const held = this.fc.get(a), tr = this.fcTry.get(a);
      // (at most 4 asks per area per server hour, so a server that issues vintages less often can't be flooded)
      if (this.o.freshFc ? held && !(held.vh < srvHour && wall - (this.fcAsk.get(a) ?? -1e15) >= this.o.fcRetryMs && !(tr?.hour === srvHour && tr.n >= 4)) : held?.hour === hour) continue;
      this.fcAsk.set(a, wall);
      this.fcTry.set(a, { hour: srvHour, n: tr?.hour === srvHour ? tr.n + 1 : 1 });
      this.fcInflight.add(a);
      this.api.forecast(a).then((pts) => {
        if (!pts?.length) return;
        // vh: the hour the returned vintage starts at (can be hour-1 when asked just past a boundary)
        const vh = Math.round((pts[0].t - this.cat.T0) / H);
        const newer = !(this.fc.get(a)?.vh >= vh);
        this.fc.set(a, { hour, vh, pts });
        if (newer) this.wakeUp();
        if (this.o.learnBias) { // keep what was forecast at each issue hour, to score it later
          // (the trace keeps vintage timing only, no grid values: every run shares one scenario grid,
          // so a kept series would be a view of the next run's future)
          this.event({ k: "fc", area: a, hour, vh, n: pts.length });
          const log = this.fcLog.get(a) ?? new Map(); log.set(vh, pts); this.fcLog.set(a, log);
          for (const h of log.keys()) if (h < hour - 72) log.delete(h);
          this.biasCache = { hour: -1, b: new Map() }; this.dataVer++; // new evidence → recompute corrections
        }
      }).catch(() => {}).finally(() => this.fcInflight.delete(a));
    }
  }

  /** Published observations (this run only), fetched once per simulated hour per area. */
  refreshHistory(hour) {
    if (!this.o.learnBias || !this.api.history) return;
    const wall = this.clock.now();
    for (const a of new Set([...this.cat.zones.values()].map((z) => z.area))) {
      if (this.histInflight.has(a)) continue;
      if (this.histHour.get(a) === hour) {
        // freshFc: a fetch that reached the server just before its hour turned misses this hour's newest point;
        // re-ask (spaced, at most 3 times an hour) while it is older than this run's own publication lag implies
        const m = this.histTry.get(a);
        if (!this.o.freshFc || this.histLag == null || !((this.histNewest.get(a) ?? -Infinity) < hour - this.histLag)
          || (m?.hour === hour && (m.n >= 3 || wall - m.ask < this.o.fcRetryMs))) continue;
      }
      const m = this.histTry.get(a);
      this.histTry.set(a, { hour, n: m?.hour === hour ? m.n + 1 : 1, ask: wall });
      this.histInflight.add(a);
      this.api.history(a).then((pts) => {
        if (!pts?.length) return;
        const m = this.obs.get(a) ?? new Map(); for (const p of pts) m.set(p.t, p.v); this.obs.set(a, m);
        this.histHour.set(a, hour);
        this.biasCache = { hour: -1, b: new Map() }; this.dataVer++;
        // publication lag as seen by this run (hours between now and the newest published hour)
        const newest = Math.max(...pts.map((p) => p.t));
        const newestH = Math.round((newest - this.cat.T0) / H);
        if (!(this.histNewest.get(a) >= newestH)) this.wakeUp();
        this.histNewest.set(a, Math.max(this.histNewest.get(a) ?? -Infinity, newestH));
        if (this.snap?.state === "RUNNING") this.histLag = Math.min(this.histLag ?? Infinity, Math.max(0, Math.floor(this.tNow()) - newestH));
        const bb = this.biasFor(a, hour);
        this.event({ k: "hist", area: a, hour, sh: this.shiftH(), mse: this.align.mse?.map((x) => +x.toFixed(5)), lagH: +(hour - (newest - this.cat.T0) / H).toFixed(2), n: m.size, b0: +bb[0].toFixed(3), b12: +bb[12].toFixed(3), anom: bb.anom ? { rho: +bb.anom.rho.toFixed(2), a0: +bb.anom.a0.toFixed(3), t0: bb.anom.t0 } : null });
      }).catch(() => {}).finally(() => this.histInflight.delete(a));
    }
  }

  /** Hours to add to a target hour to find its observation's stamp (0: stamped with its own hour, 1: one
   *  hour late). "auto": compare this run's forecasts (leads 0-3) with both readings, keep the closer one. */
  shiftH() {
    const fixed = this.o.obsShiftH;
    if (fixed !== "auto") return Number(fixed) || 0;
    if (this.align.ver === this.dataVer) return this.align.sh;
    const se = [0, 0], n = [0, 0];
    for (const [area, log] of this.fcLog) {
      const obs = this.obs.get(area); if (!obs) continue;
      for (const pts of log.values()) for (let i = 0; i < Math.min(4, pts.length); i++) {
        const p = pts[i], o0 = obs.get(p.t), o1 = obs.get(p.t + H);
        if (!(o0 > 0 && o1 > 0 && p.v > 0)) continue; // same pairs for both readings
        se[0] += Math.log(p.v / o0) ** 2; se[1] += Math.log(p.v / o1) ** 2; n[0]++; n[1]++;
      }
    }
    // sticky: start on 0 (the published stamp), switch only on clear evidence (>= 15 % lower error), so
    // near-ties early in a run don't flip the corrections hour by hour (seen live: 0/1 alternating, h1-h8)
    const prev = this.align.sh ?? 0, m0 = se[0] / Math.max(1, n[0]), m1 = se[1] / Math.max(1, n[1]);
    let sh = prev;
    if (n[0] >= this.o.obsShiftMinN) { if (prev === 0 && m1 < 0.85 * m0) sh = 1; else if (prev === 1 && m0 < 0.85 * m1) sh = 0; }
    this.align = { ver: this.dataVer, sh, mse: n[0] ? [m0, m1] : null, n: n[0] };
    return sh;
  }

  /** Mean relative forecast error per lead hour for an area (forecast / observed - 1), shrunk and capped. */
  biasFor(area, hour) {
    if (this.biasCache.hour !== hour) this.biasCache = { hour, b: new Map() };
    if (this.biasCache.b.has(area)) return this.biasCache.b.get(area);
    const sum = new Float64Array(25), cnt = new Float64Array(25);
    const obs = this.obs.get(area), log = this.fcLog.get(area), sh = this.shiftH() * H;
    if (obs && log) for (const [h0, pts] of log) for (const p of pts) {
      const o = obs.get(p.t + sh); if (!(o > 0)) continue;
      const lead = Math.round((p.t - (this.cat.T0 + h0 * H)) / H); if (lead < 0 || lead > 24) continue;
      sum[lead] += p.v / o - 1; cnt[lead]++;
    }
    const b = Array.from({ length: 25 }, (_, i) => Math.max(-this.o.biasCap, Math.min(this.o.biasCap, sum[i] / (cnt[i] + this.o.biasShrinkN))));
    b.anom = this.o.nowcast ? this.anomalyFor(area, b) : null;
    this.biasCache.b.set(area, b);
    return b;
  }

  /** The latest observed lead-0 miss beyond the learned bias, and how strongly misses persist from one
   *  hour to the next in this run (lag-1 autocorrelation). null while they don't measurably persist. */
  anomalyFor(area, b) {
    const log = this.fcLog.get(area), obs = this.obs.get(area), sh = this.shiftH() * H;
    if (!log || !obs) return null;
    const a = new Map();
    for (const [h0, pts] of log) {
      const p = pts[0]; const o = p && p.t === this.cat.T0 + h0 * H ? obs.get(p.t + sh) : undefined;
      if (o > 0) a.set(h0, p.v / o - 1 - b[0]);
    }
    let sxy = 0, sxx = 0, n = 0, last = -Infinity;
    for (const [h0, x] of a) { if (h0 > last) last = h0; const y = a.get(h0 + 1); if (y !== undefined) { sxy += x * y; sxx += x * x; n++; } }
    if (n < this.o.nowcastMinN || !(sxx > 0)) return null;
    const rho = Math.min(0.95, sxy / sxx);
    return rho >= this.o.nowcastMinRho ? { rho, a0: a.get(last), t0: last, n } : null;
  }

  /** Simulated hours "now", extrapolated from the freshest snapshot. */
  tNow() {
    const s = this.snap;
    if (!s) return null;
    if (s.state !== "RUNNING") return s.t;
    return s.t + ((this.clock.now() - s.wallAt) * s.speed) / H;
  }
  latSample(kind, ms) {
    const a = (this.latRecent[kind] ??= []); a.push(ms); if (a.length > 15) a.shift();
    if (ms > this.o.stallTriggerMs) this.lastSlow = this.clock.now();
  }
  /** Wall seconds of deadline cushion a paused job needs now: more while the server shows stress. */
  stallS() {
    const now = this.clock.now();
    const open = [...this.statusOpen].some((t0) => now - t0 > this.o.stallTriggerMs);
    return open || now - (this.lastSlow ?? -1e15) < this.o.stallMemoryS * 1000 ? this.o.stallBufferS : this.o.stallBaseS;
  }
  latH() {
    const s = this.snap;
    // latRobust: plan with the median of the last 15 calls — one stalled reply (run f085e7d7: 32 s) otherwise
    // lifted the EWMA to hours of "latency", switched off every low-lag setting and inflated all margins
    const med = (a) => (a?.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
    const ms = this.o.latRobust ? (med(this.latRecent.cloud) ?? med(this.latRecent.status) ?? 1000) : (this.lat.cloud ?? this.lat.status ?? 1000);
    return Math.min(this.o.maxLatH, ((ms * (s?.speed ?? 720)) / H));
  }

  // ---------- view with in-flight overlay ----------
  view(tAct) {
    const s = this.snap.s;
    const status = { ...s, workloads: (s.workloads ?? []).map((w) => ({
      ...w,
      assignments: (w.assignments ?? []).filter((a) => !this.deleted.has(a.vm_id)).map((a) => {
        const ov = this.override.get(a.vm_id);
        // an acknowledged stop/start wins until a snapshot taken after the ack shows the VM
        if (ov && this.snap.wallAt < ov.wallAck + (this.lat.status ?? 0) / 2) return { ...a, state: ov.state };
        if (ov) this.override.delete(a.vm_id);
        return a;
      }),
    })) };
    const receipt = new Map(Object.entries(this.st.vms));
    // in-flight creates count as VMs (quota, and so the policy doesn't create them twice)
    for (const [wl, c] of this.inCreate) for (let i = 0; i < c.left; i++) receipt.set(`pending-${wl}-${i}`, { wl, zone: c.zone, prof: c.prof });
    // rawTracker: rate samples use the engine's own VM states, not the acknowledged-action overlay
    const raw = this.o.rawTracker ? new Map((s.workloads ?? []).flatMap((w) => (w.assignments ?? []).map((x) => [x.vm_id, x.state]))) : null;
    const v = buildView(this.cat, status, receipt, this.tracker, raw);
    v.t = tAct;
    v.memo = this.memo;
    const hourStart = this.cat.T0 + Math.floor(tAct) * H;
    const nowHour = Math.floor(tAct);
    // this run's observed hourly values for an area (most recent 72), for the placement's window model
    const distCache = new Map();
    v.dist = (area) => {
      if (distCache.has(area)) return distCache.get(area);
      const m = this.obs.get(area), sh = this.shiftH() * H;
      const d = m ? [...m.entries()].filter(([t]) => t - sh < hourStart).sort((a, b) => a[0] - b[0]).slice(-72).map(([, x]) => x) : [];
      distCache.set(area, d); return d;
    };
    // corrected value of a point from the vintage issued at hour vh (its lead decides the bias applied)
    const valFor = (area, vh) => {
      const b = this.o.learnBias ? this.biasFor(area, nowHour) : null;
      const cap = 2 * this.o.biasCap;
      const obsNow = this.o.nowcastLead0 ? this.obs.get(area)?.get(hourStart + this.shiftH() * H) : undefined;
      return (p) => {
        if (obsNow > 0 && p.t === hourStart) return obsNow;
        if (!b) return p.v;
        const tau = (p.t - this.cat.T0) / H;
        let e = b[Math.max(0, Math.min(24, Math.round(tau - vh)))];
        if (b.anom) e += b.anom.a0 * b.anom.rho ** Math.max(0, tau - b.anom.t0);
        return p.v / (1 + Math.max(-cap, Math.min(cap, e)));
      };
    };
    v.fc = (area) => {
      const c = this.fc.get(area);
      if (!c) return null;
      const val = valFor(area, c.vh ?? c.hour);
      const arr = c.pts.filter((p) => p.t >= hourStart).map(val);
      return arr.length ? arr : [val(c.pts[c.pts.length - 1])];
    };
    // placement: each hour is the mean of the newest `placeVintages` vintages that cover it
    const placeCache = new Map();
    v.fcPlace = this.o.placeVintages > 1 && this.o.learnBias ? (area) => {
      if (placeCache.has(area)) return placeCache.get(area);
      const c = this.fc.get(area), log = this.fcLog.get(area);
      let out = v.fc(area);
      const pts = c?.pts.filter((p) => p.t >= hourStart) ?? [];
      if (log && pts.length) {
        const newest = c.vh ?? c.hour;
        const vin = [...log.keys()].filter((h) => h <= newest).sort((a, b) => b - a).slice(0, this.o.placeVintages)
          .map((h) => ({ m: new Map(log.get(h).map((p) => [p.t, p])), f: valFor(area, h) }));
        out = pts.map((p) => { let s = 0, n = 0; for (const x of vin) { const q = x.m.get(p.t); if (q) { s += x.f(q); n++; } } return n ? s / n : valFor(area, newest)(p); });
      }
      placeCache.set(area, out);
      return out;
    } : null;
    return v;
  }

  // ---------- actions ----------
  fireCreate(a, tAct) {
    const { cat } = this;
    const w = cat.workloads.get(a.wl), z = cat.zones.get(a.zone), p = cat.profiles.get(a.prof);
    // Residency double-check right before the API call: one illegal attempt disqualifies the run.
    if (!zoneLegal(w, z) || !profileLegal(w, p) || !p.zones.has(a.zone)) { this.log(`[BLOCKED] illegal create ${a.wl}@${a.zone} ${a.prof}`); return; }
    if (this.inCreate.has(a.wl)) return;
    const c = { zone: a.zone, prof: a.prof, k: a.k, left: a.k };
    this.inCreate.set(a.wl, c);
    for (let i = 0; i < a.k; i++) {
      const name = `go2-${this.run.slice(0, 8)}-${a.wl}-${++this.st.seq}`;
      this.save();
      const tNow0 = this.tNow();
      this.event({ k: "act", type: "create", wl: a.wl, zone: a.zone, prof: p.label, nowH: +tNow0.toFixed(3), landH: +tAct.toFixed(3), why: a.why });
      (async () => {
        const t0 = this.clock.now();
        let id = null, err = "";
        try {
          const r = await this.api.create(a.zone, p.id, name, a.wl);
          this.lat.cloud = ewma(this.lat.cloud, this.clock.now() - t0); this.latSample("cloud", this.clock.now() - t0);
          id = r?.id ?? null; err = r?.error ?? "";
          if (!id && r?.ambiguous) id = await this.api.findByName(a.zone, name).catch(() => null);
        } catch (e) { err = String(e); id = await this.api.findByName(a.zone, name).catch(() => null); }
        this.event({ k: "ack", type: "create", wl: a.wl, ok: Boolean(id), latMs: Math.round(this.clock.now() - t0), simH: +((this.tNow() ?? tNow0) - tNow0).toFixed(3), id, err: id ? undefined : String(err).slice(0, 160) });
        if (id) {
          this.st.vms[id] = { wl: a.wl, zone: a.zone, prof: p.id, name, tH: tAct };
          this.stats.creates++;
          this.log(`[create] ${a.wl} → ${a.zone} ${p.label} t≈${tAct.toFixed(1)} (${a.why}) id=${id}`);
        } else { this.stats.errors++; this.log(`[create] ${a.wl} FAILED ${String(err).slice(0, 200)}`); }
        this.save();
      })().finally(() => { if (--c.left <= 0) this.inCreate.delete(a.wl); });
    }
  }

  fireVm(a, tAct) {
    const id = a.vm.id;
    if (this.inVm.has(id) || String(id).startsWith("pending-")) return;
    if (a.type === "stop") { // starting is the deadline-safe direction, so only stops are rate-limited
      const last = this.lastToggle.get(id);
      // (infoDwell: a start decided before the newest data arrived may be undone at once)
      if (last != null && tAct - last < this.o.minDwellH && !(this.o.infoDwell && this.dataVer > (this.toggleVer.get(id) ?? Infinity))) return;
    }
    const zone = a.vm.zone ?? this.st.vms[id]?.zone;
    this.inVm.set(id, a.type);
    const tNow0 = this.tNow() ?? tAct, ver0 = this.dataVer;
    this.event({ k: "act", type: a.type, wl: a.wl, vm: id, nowH: +tNow0.toFixed(3), landH: +tAct.toFixed(3), why: a.why });
    const ack = (r, t0) => this.event({ k: "ack", type: a.type, wl: a.wl, vm: id, ok: Boolean(r?.ok || (a.type === "delete" && r?.status === 404)), status: r?.status, latMs: Math.round(this.clock.now() - t0), simH: +((this.tNow() ?? tNow0) - tNow0).toFixed(3) });
    (async () => {
      const t0 = this.clock.now();
      if (a.type === "delete") {
        const r = await this.api.remove(zone, id);
        this.lat.cloud = ewma(this.lat.cloud, this.clock.now() - t0); this.latSample("cloud", this.clock.now() - t0);
        ack(r, t0);
        if (r.ok || r.status === 404) {
          delete this.st.vms[id]; this.deleted.add(id); this.st.deleted = [...this.deleted]; this.save();
          this.stats.deletes++;
          this.log(`[delete] ${a.wl} ${id} (${a.why}) → ok`);
        } else { this.stats.errors++; this.log(`[delete] ${a.wl} ${id} → ${r.status} ${String(r.text ?? "").slice(0, 120)}`); }
      } else {
        const r = await this.api.vmAction(zone, id, a.type);
        this.lat.cloud = ewma(this.lat.cloud, this.clock.now() - t0); this.latSample("cloud", this.clock.now() - t0);
        ack(r, t0);
        if (r.ok) {
          this.override.set(id, { state: a.type === "stop" ? "stopped" : "running", wallAck: this.clock.now() });
          this.lastToggle.set(id, this.tNow() ?? tAct); this.toggleVer.set(id, ver0);
          this.stats[a.type === "stop" ? "stops" : "starts"]++;
          this.log(`[${a.type}] ${a.wl} ${id.slice(0, 8)} t≈${tAct.toFixed(1)} (${a.why}) → ok`);
        } else { this.stats.errors++; this.log(`[${a.type}] ${a.wl} ${id.slice(0, 8)} → ${r.status} ${String(r.text ?? "").slice(0, 120)}`); }
      }
    })().catch((e) => { this.stats.errors++; this.log(`[${a.type}] ${a.wl} error ${e}`); })
      .finally(() => this.inVm.delete(id));
  }

  async finalize(reason) {
    if (this.finalizing) return;
    this.finalizing = true;
    this.event({ k: "final", reason, vms: Object.keys(this.st.vms).length });
    this.log(`[final] ${reason}: deleting ${Object.keys(this.st.vms).length} VM(s)`);
    await Promise.all(Object.entries(this.st.vms).map(async ([id, r]) => {
      const d = await this.api.remove(r.zone, id).catch(() => ({ ok: false }));
      if (d.ok || d.status === 404) { delete this.st.vms[id]; this.deleted.add(id); }
    }));
    this.st.deleted = [...this.deleted];
    this.save();
    // orphan sweep: only VMs carrying this controller's name prefix
    const prefix = `go2-${this.run.slice(0, 8)}-`;
    await Promise.all([...this.cat.zones.keys()].map(async (slug) => {
      const list = await this.api.listInstances(slug).catch(() => []);
      await Promise.all(list.filter((i) => String(i.name ?? "").startsWith(prefix) && !this.deleted.has(i.id))
        .map((i) => this.api.remove(slug, i.id).then(() => this.log(`[final] orphan ${i.name} deleted`)).catch(() => {})));
    }));
    this.done = true;
  }

  /** VMs bound to workloads that this controller didn't create (e.g. left by the starter demo):
   *  look up their real instance type so quota, timing and gating are planned exactly. */
  adoptForeign() {
    if (!this.api.getInstance) return;
    for (const w of this.snap.s.workloads ?? []) {
      for (const a of w.assignments ?? []) {
        const id = a.vm_id;
        // a create of ours may have landed before its reply arrived: never treat that VM as foreign
        if (this.st.vms[id] || this.deleted.has(id) || this.adopting.has(id) || this.inCreate.has(w.id)) continue;
        this.adopting.add(id);
        this.api.getInstance(a.zone, id).then((r) => {
          if (this.st.vms[id] || this.deleted.has(id)) return; // our create reply got there first
          if (r?.prof && this.cat.profiles.has(r.prof)) {
            const ours = String(r.name ?? "").startsWith(`go2-${this.run.slice(0, 8)}-`); // e.g. a lost create reply
            this.st.vms[id] = { wl: w.id, zone: a.zone, prof: r.prof, name: r.name, ...(ours ? {} : { adopted: true }) };
            this.save();
            this.log(`[${ours ? "recover" : "adopt"}] ${w.id} ${id.slice(0, 8)} ${this.cat.profiles.get(r.prof).label}@${a.zone}`);
          } else setTimeout(() => this.adopting.delete(id), 5000); // retry later
        }).catch(() => setTimeout(() => this.adopting.delete(id), 5000));
      }
    }
  }

  // ---------- one decision step ----------
  step() {
    const snap = this.snap;
    const s = snap.s;
    if (s.qualification === "DISQUALIFIED") { this.log("[fatal] run DISQUALIFIED"); return this.finalize("disqualified"); }
    if (["COMPLETED", "INVALIDATED", "UNAVAILABLE"].includes(snap.state)) return this.finalize(`run ${snap.state}`);
    if (snap.state === "PAUSED") return;
    const wls = s.workloads ?? [];
    if (wls.length && wls.every((w) => w.final_output_delivered)) return this.finalize("all delivered");

    this.adoptForeign();
    const tNow = this.tNow();
    const latH = snap.state === "RUNNING" ? this.latH() : 0;
    const tAct = tNow + latH;
    this.refreshForecasts(Math.floor(tAct));
    this.refreshHistory(Math.floor(tNow));
    const areas = new Set([...this.cat.zones.values()].map((z) => z.area));
    if ([...areas].some((a) => !this.fc.has(a))) return; // wait for the first forecast fill

    const v = this.view(tAct);
    const hour = Math.floor(tNow);
    if (hour !== this.lastHourLogged) {
      this.lastHourLogged = hour;
      const all = v.jobs.flatMap((j) => j.vms);
      this.log(`[t≈${tNow.toFixed(1)}h snap=${snap.t.toFixed(1)}h lat≈${latH.toFixed(2)}h] ${snap.state} delivered ${v.jobs.filter((j) => j.delivered).length}/${v.jobs.length} vms=${v.usage.vms} run=${all.filter((x) => x.state === "running").length} stop=${all.filter((x) => x.state === "stopped").length} cores=${v.usage.cores}`);
    }
    const stallH = (this.stallS() * (snap.speed || 720)) / 3600;
    const acts = this.decideFn(this.cat, v, { ...this.policyOpts, marginMinH: this.o.baseMarginH + this.o.latencyMarginX * latH, latH, stallH });
    for (const a of acts) {
      if (a.type === "create") this.fireCreate(a, tAct);
      else this.fireVm(a, tAct);
    }
  }

  /** New data arrived: run the next decision soon (debounced, so the hour's burst of replies triggers one step). */
  wakeUp() {
    if (!this.o.wakeOnData || this.wakePending) return;
    this.wakePending = true;
    this.clock.sleep(this.o.wakeDebounceMs).then(() => { this.wakePending = false; const w = this.wake; this.wake = null; w?.(); });
  }

  /** Wall ms until the action time or the server clock reaches its next hour (Infinity unless running). */
  msToBoundary() {
    const s = this.snap;
    if (!s || s.state !== "RUNNING") return Infinity;
    const tNow = this.tNow(), tAct = tNow + this.latH();
    const dH = Math.min(Math.ceil(tAct + 1e-9) - tAct, Math.ceil(tNow + 1e-9) - tNow);
    return (dH * H) / s.speed;
  }

  async runLoop() {
    while (!this.done) {
      this.pollStatus();
      if (this.snap && !this.finalizing) {
        try { await this.step(); } catch (e) { this.log(`[step] error ${e?.stack ?? e}`); }
      }
      if (this.done) break;
      const ms = this.o.alignBoundary ? Math.max(2, Math.min(this.o.loopMs, this.msToBoundary() + 2)) : this.o.loopMs;
      if (this.o.wakeOnData) await Promise.race([this.clock.sleep(ms), new Promise((r) => { this.wake = r; })]);
      else await this.clock.sleep(ms);
      this.wake = null;
    }
    return this.stats;
  }
}
