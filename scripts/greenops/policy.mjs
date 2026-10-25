/** Pure, deterministic scheduling policy shared by the live controller and the offline mock.
 *
 *  1. WHERE: each job goes to the legal (zone, profile, workers) with the lowest expected carbon:
 *     energy x datacenter PUE x the mean of the cheapest forecast hours it will need.
 *  2. WHEN: a job runs only in the cheapest hours of the published 24h forecast — as many as it
 *     still needs within its deadline window (proportional rule) — and pauses (stop = 0 W, keeps
 *     progress) in the dirtier ones. Starts are timed the same way.
 *  3. SAFETY: stopped VMs still hold quota, so every pause / delayed start is checked by fast-
 *     forwarding the whole remaining schedule (all jobs flat-out afterwards, waiting jobs take
 *     quota in deadline order, future releases included). A pause is kept only if every job still
 *     finishes before its deadline minus a margin. Pauses compete for that slack by grams saved
 *     per hour, so the biggest wins (GPU jobs on dirty grids) get it first.
 *
 *  The policy only sees `view` (current status + forecasts published now). It never sees actuals.
 */
import { candidates, cheapestMean, fitsQuota, marginalPoints, outputH, rateK, setupH } from "./model.mjs";

export const DEFAULTS = {
  marginMinH: 4,       // never plan to finish closer than this to a deadline
  marginFrac: 0.12,    // ...or this fraction of the remaining runtime, whichever is larger
  fitTol: 0.08,        // accept a quota-fitting placement up to 8% dirtier than the best one
  maxDuty: 0.92,       // a fresh placement must leave at least 8% of its window as slack
  pauseQuantumH: 1,    // a pause is checked as "this job loses the next hour (+ API latency)"
  latH: 0,             // API latency in sim hours (set by the controller)
  cpuWindowH: 72,      // CPU jobs spread their work over at most this many hours (frees quota sooner)
  noGate: false,       // never pause or delay (baseline for comparison)
  slackBufferH: "auto", // pauses only while every job projects at least this far ahead of its due
  bufferLatX: 2,       // "auto" buffer = this many API latencies (sim hours)
  minValuePerCore: 0,  // g CO2e saved per held core-hour below which a pause isn't worth its quota
  noiseBand: 0.05,     // only wait/pause if it saves at least this fraction vs the hour it moves to
  prestage: false,     // create VMs boot+input ahead of release so staging is done when the job releases
  horizonPenalty: 0,   // forecast-risk penalty for waiting on far-off cheap hours (see risk())
  hourlyGate: false,   // decide each job's run/pause once per forecast hour (no mid-hour flapping)
  cleanNoPauseI: 0,    // gate2: jobs whose zone averages below this (gCO2e/kWh x PUE) don't pause while others queue
  dynamicBar: false,   // gate2: while jobs queue, a pause must save more than the delay costs them
  dynX: 1,             // ...scale on that opportunity cost
  reserveSingle: true, // reserve waiting multi-worker jobs as one worker in the projection (mock: +10..+31 pts, 0 misses)
  preempt: false,      // gate2: free quota by DELETING (not stopping) a quick-restart job for a long dirty stretch
  preemptMaxInputS: 900, preemptMaxCkptS: 1800, // ...only jobs that re-stage in <= 15 min and checkpoint <= 30 min
  preemptMinH: 3,      // ...only when the forecast shows at least this many dirty hours ahead
  preemptMaxLossFrac: 0.2, // ...and the job has just passed a checkpoint (little work lost)
  preemptMax: 3,       // ...at most this many times per job
  dutyW: 0,            // ranking penalty per unit of duty (needH / window): values flexibility (CPU)
  gpuDutyW: 0,         // same for GPU placements (0.6 helped at low lag but missed deadlines at 10 s lag)
  gpuDutyMaxLatH: 0.5, // ...so gpuDutyW only applies while API latency is below this (sim hours)
  lowLatH: 0.15,       // API latency (sim hours) at or below which `lowLat` overrides apply
  // (prestage only at low lag: mock +6..+20 pts at 0.1-0.3 s, but -11 at 3 s and -53 at 10 s lag)
  lowLat: { cpuWindowH: 1e9, pressureValuePerCore: 0.08, marginCutH: 3, prestage: true },
  // low-lag deadline margin cut (base 4h -> 1h) for CPU jobs only: live run 7 applied it to all jobs
  // and scored 5 pts below run 6 — CPU jobs gained, GPU jobs lost — so GPUs keep the full margin
  marginCutH: 0, lowLatMarginMinH: 1,
  marginCpuOnly: true, // the cut applies to CPU jobs only; GPU jobs keep the full margin
  gpuMarginCutH: 0,    // (experiment) a smaller low-lag cut for GPU jobs too (e.g. 2: 4 h -> 2 h); the stall guard covers server stalls
  marginFracGpu: null, // GPU jobs' runtime-proportional margin (null: marginFrac)
  prestageNoDefer: false, // with prestage: stage a job before its release even if the current hour looks dirty
  windowDist: false,   // placement: model the window beyond the forecast with this run's observed hours (see scorePlacement)
  windowDistMinH: 12,  // ...once at least this many observed hours exist for the area
  windowDistMaxDuty: 0.4, // ...only for placements needing at most this share of their window (short jobs, long windows)
  stagedGate: true,    // with prestage: a staged job releasing within the action lead is gated on its release hour
  stallH: 0,           // sim hours a stopped job must keep before its deadline (set by the controller from stallBufferS)
  harmlessPauses: true,  // gate2: while jobs queue, grant below-bar pauses that move no queued job's projected start
  harmlessDefers: false, // ...and below-bar deferred starts of fresh jobs
  rateFloor: 0,        // plan with at least this fraction of the catalog speed (0: trust the learned speed fully)
  pickyFrac: 1,        // <1: a fresh job with slack > pickyMinSlackH starts only in this fraction of its gate's clean hours
  pickyMinSlackH: 24, pickyGpuOnly: true,
  pauseOutput: false,  // allow pausing during the final output phase (it otherwise always runs)
  llf: false,          // reserve queued jobs least-laxity-first (due - need) instead of earliest-due-first
  gpuTightW: 0,        // GPU placements needing more than gpuTightAt of their window are penalised by this per unit
  gpuTightAt: 0.6,
  scarcityW: 0.25,     // ranking penalty per full share of the vCPU / GPU-family quota a placement takes
  cleanZoneSmallVm: 0, // grams added per vCPU held, for CPU placements in zones cleaner than cleanZoneMaxI
  cleanZoneMaxI: 90,   // (forecast mean x PUE, gCO2e/kWh) — favours 16-vCPU VMs for jobs on very clean grids
  scarcityMode: "cores", // "cores" (share held at once) | "coreHours" (share x time held) | "gpuCoreHours" (GPU only)
  cardW: 1,            // weight of the GPU-card share in the scarcity penalty
  stickyTol: 0.15,     // keep a waiting job's reserved placement unless another ranks >15% better
  cpuPause: "auto",    // CPU jobs may pause / delay starts ("auto": only while API latency <= cpuPauseMaxLatH)
  cpuPauseMaxLatH: 1.5, // above this lag, CPU pauses cost more deadline safety than they save
  gpuOwnCheck: false,  // GPU pauses only need their own deadline (not the whole projection)
  pauseMode: "gate2",  // "gate2": clean-hour pauses ranked by POINTS saved (score formula), each checked by the projection
                       // (alternatives kept for comparison: "gate2" = per-pause value + projection check, "ffs" = slack-greedy)
  pressure: true,      // "gate" mode only: one job class runs flat-out while a released job waits for quota
  pressureTarget: "cpu", // ...which class: "cpu" | "gpu" | "none"
  pointsAware: true,   // gate2: rank pauses by points saved (score formula), not grams
  pressureValuePerCore: 0.15, // gate2: g/h saved per held vCPU a pause needs while another job waits for quota
  strictPauses: true,  // gate2: re-check every pause against the projection even when it looks safe
  queueCushionH: 4,    // gate2: while a job waits for quota, pauses must leave every job this many hours of slack
  replaceForeign: true, // replace a VM we didn't create (e.g. the starter demo's) before it does real work...
  replaceMinRel: 0.15, // ...when our placement is estimated at least 15% cleaner
  replaceMinG: 100,    // ...and saves at least this many grams
};

const H = 3.6e6;
// GPU jobs can keep the larger margin (marginCpuOnly): live run 7 showed GPUs given the thin margin
// postponing their last hours into forecast-cheap hours that turned out dirtier
const marginH = (o, needH, fam = "cpu") => {
  const gpu = fam !== "cpu";
  return Math.max(gpu && o.marginCpuOnly && o.marginMinHGpu != null ? o.marginMinHGpu : o.marginMinH, (gpu && o.marginFracGpu != null ? o.marginFracGpu : o.marginFrac) * needH);
};

// Forecast error grows with lead time, and picking the cheapest-looking hours favours hours whose
// error happens to be low. HP > 0 makes an hour i ahead look (1 + HP*sqrt(i/24)) dirtier when
// ranking, so a far-off dip must beat the near term by more before the job waits for it.
let HP = 0;
const risk = (fc) => (HP > 0 ? fc.map((v, i) => v * (1 + HP * Math.sqrt(i / 24))) : fc);

/** Proportional rule: within the visible window, run in the cheapest ceil(W*need/avail) hours
 *  (frac < 1: only the cheapest frac of those — a pickier start). */
export function gate(fc, needH, availH, frac = 1) {
  if (needH <= 0) return true;
  if (!fc?.length || needH >= availH - 0.25) return true;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  const n = Math.min(W, Math.max(1, Math.ceil((frac * W * needH) / availH + 1e-9)));
  const sorted = risk(fc).slice(0, W).sort((a, b) => a - b);
  return fc[0] <= sorted[n - 1] + 1e-9;
}
/** True when waiting would save less than `band` (relative) — i.e. within forecast noise. */
function withinNoise(fc, needH, availH, band) {
  if (!(band > 0) || !fc?.length || needH >= availH - 0.25) return false;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  const n = Math.min(W, Math.ceil((W * needH) / availH + 1e-9));
  const thr = risk(fc).slice(0, W).sort((a, b) => a - b)[n - 1];
  return fc[0] - thr < band * Math.max(1, thr);
}
/** gCO2e/kWh saved by moving the current hour of work to the hour the gate would use instead. */
function hourSaving(fc, needH, availH, frac = 1) {
  if (!fc?.length || needH >= availH - 0.25) return 0;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  const n = Math.min(W, Math.max(1, Math.ceil((frac * W * needH) / availH + 1e-9)));
  const sorted = risk(fc).slice(0, W).sort((a, b) => a - b);
  return Math.max(0, fc[0] - sorted[n - 1]);
}

/** Expected carbon (g) of a fresh placement started at tH, plus its timing numbers. */
export function scorePlacement(cat, w, c, rem, tH, fcFor, o, calib = 1) {
  const rate = rateK(w, c.prof, c.k) * calib;
  const needH = setupH(w, c.prof) + rem / rate + outputH(w);
  const deadlineH = (w.deadline - cat.T0) / H;
  const hardH = deadlineH - tH - marginH(o, needH, c.prof.family);
  if (!(hardH > 0) || needH > hardH * o.maxDuty) return null;
  const availH = c.prof.family === "cpu" ? Math.max(needH / o.maxDuty, Math.min(hardH, o.cpuWindowH)) : hardH;
  const fc = fcFor(c.zone.area);
  if (!fc?.length) return null;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  let expI = cheapestMean(fc.slice(0, W), (W * needH) / availH);
  // windowDist: hours of the window beyond the forecast are drawn from this run's observed hours plus the
  // forecast (quantiles), instead of assuming they look like the next 24 h — a zone whose recent days had
  // very clean stretches (e.g. a windy grid) gets credit for them, mostly for short jobs in long windows
  if (o.windowDist && o.distFor && availH > fc.length + 1 && needH / availH <= o.windowDistMaxDuty) {
    const hist = o.distFor(c.zone.area) ?? [];
    if (hist.length >= o.windowDistMinH) {
      const S = [...hist, ...fc].sort((a, b) => a - b), U = Math.round(availH - fc.length);
      const pseudo = Array.from({ length: U }, (_, i) => S[Math.min(S.length - 1, Math.floor(((i + 0.5) / U) * S.length))]);
      expI = cheapestMean([...fc, ...pseudo], needH);
    }
  }
  const kwh = (c.k * c.prof.watts * needH) / 1000;
  return { ...c, needH, availH, hardH, slackH: hardH - needH, expI, kwh, grams: kwh * c.zone.pue * expI };
}

// learned engine speed (per work unit), never below rateFloor x the catalog: live runs follow the catalog exactly
// (w-03 restarted ~40 times, its lifecycle hours match catalog speed within 0.05 h), but single rate samples taken
// around a stop/start read as low as 0.28 — need jumped to 111 h for a 31 h job (run 5c35cc4b, t=7.2), which
// forced starts and made the projection see phantom lateness
const calOf = (view, unit, o) => Math.max(o.rateFloor, view.calib?.[unit] ?? 1);

const footprint = (p, k) => ({ vms: k, cores: p.cores * k, fam: p.family, cards: p.family === "cpu" ? 0 : p.cards * k });

/** Fast-forward the remaining schedule with reservations (conservative backfilling).
 *  Deployed items hold their quota from now until they finish (paused ones too — stopped VMs keep
 *  quota). Waiting items, in deadline order, each reserve the earliest window of length needH at or
 *  after `avail` where quota is free for the whole window — so an early-deadline job that is not even
 *  released yet keeps its future capacity, and a later-deadline job may only start now if it fits
 *  around that reservation. Returns worst lateness (h) and each item's planned start. */
let LLF = false; // fastForward order: least laxity (due - needH) first instead of earliest due
export function fastForward(cat, t0, base, items, DT = 0.5) {
  // horizon extends well past the run end so even a hopeless job gets a finite (late) finish —
  // "infinitely late" can't get worse, which would let harmful pauses through the safety check
  const N = Math.max(16, Math.ceil((300 - t0) / DT) + 2);
  const vms = new Float64Array(N), cores = new Float64Array(N), cards = {};
  for (const f of Object.keys(cat.quota.cards)) cards[f] = new Float64Array(N);
  const hold = (fp, s0, s1) => {
    for (let i = Math.max(0, s0); i < Math.min(N, s1); i++) { vms[i] += fp.vms; cores[i] += fp.cores; if (fp.cards) cards[fp.fam][i] += fp.cards; }
  };
  const capC = cat.quota.cores, capV = cat.quota.vms;
  const violation = (fp, s, d) => {
    const capF = fp.cards ? (cat.quota.cards[fp.fam] ?? 0) : 0;
    for (let i = s; i < s + d; i++) {
      if (i >= N) return -2;
      if (vms[i] + fp.vms > capV || cores[i] + fp.cores > capC || (fp.cards && cards[fp.fam][i] + fp.cards > capF)) return i;
    }
    return -1;
  };
  // delivered-but-not-yet-deleted / unknown VMs: assume they're gone in ~2h
  hold({ vms: base.vms, cores: base.cores, cards: 0 }, 0, Math.ceil(2 / DT));
  for (const [fam, n] of Object.entries(base.cards ?? {})) if (n > 0 && cards[fam]) hold({ vms: 0, cores: 0, fam, cards: n }, 0, Math.ceil(2 / DT));
  const start = new Map(), finish = new Map();
  for (const it of items) if (it.deployed) {
    const end = it.startAt + it.needH;
    hold(it.fp, 0, Math.ceil((end - t0) / DT));
    start.set(it.id, it.startAt); finish.set(it.id, end);
  }
  const waiting = items.filter((it) => !it.deployed).sort((a, b) => (LLF ? (a.due - a.needH) - (b.due - b.needH) : 0) || a.due - b.due);
  for (const w of waiting) {
    const d = Math.max(1, Math.ceil(w.needH / DT));
    let s = Math.max(0, Math.ceil((w.avail - t0) / DT - 1e-9));
    for (let guard = 0; guard < N; guard++) {
      const v = violation(w.fp, s, d);
      if (v === -1) { hold(w.fp, s, s + d); start.set(w.id, t0 + s * DT); finish.set(w.id, t0 + (s + d) * DT); break; }
      if (v === -2) break; // doesn't fit before the end of the run
      s = v + 1;
    }
  }
  let worst = -Infinity, lateSum = 0;
  for (const it of items) {
    const late = (finish.get(it.id) ?? Infinity) - it.due;
    if (late > worst) worst = late;
    if (late > 0) lateSum += Math.min(late, 1e3);
  }
  return { worst, lateSum, start, finish };
}

/** All legal placements for a job not yet deployed, best (lowest expected grams) first. If none
 *  clears its margin, deadline-feasible ones by carbon, then the fastest — it still has to go. */
function placements(cat, view, o, j, tPlan) {
  const rem = Math.max(0, j.w.required - j.done);
  const cal = calOf(view, j.w.unit, o);
  const fcP = view.fcPlace ?? view.fc; // placement may average several forecast vintages (controller placeVintages)
  let scored = candidates(cat, j.w).map((c) => scorePlacement(cat, j.w, c, rem, tPlan, fcP, o, cal)).filter(Boolean);
  // (experiment only) forceProfile: { wl: "family.size" } pins a job's machine — oracle tests in the mock
  const forced = o.forceProfile?.[j.w.id];
  if (forced) { const f = scored.filter((c) => c.prof.label === forced && c.k === 1); if (f.length) scored = f; }
  // rank = estimated grams x a quota-scarcity factor: a placement that takes a big share of the
  // vCPU or GPU-family quota blocks other jobs (e.g. a 4-card RTX locks out the other RTX job)
  // quota footprint: "cores" = how much it holds at once; "coreHours" = how long it holds it (a 2-card
  // GPU finishing in half the time blocks other jobs no more than a 1-card one), normalised to 48h
  const span = (c) => (o.scarcityMode === "coreHours" || (o.scarcityMode === "gpuCoreHours" && c.prof.family !== "cpu") ? Math.min(3, c.needH / 48) : 1);
  for (const c of scored) c.rank = c.grams * (1 + o.scarcityW * span(c) * ((c.prof.cores * c.k) / cat.quota.cores
    + (c.prof.family !== "cpu" ? o.cardW * (c.prof.cards * c.k) / Math.max(1, cat.quota.cards[c.prof.family] ?? 1) : 0)))
    // flexibility: a placement that needs most of its window can't dodge dirty days the 24h forecast can't see yet
    * (1 + (c.prof.family === "cpu" ? o.dutyW : (o.latH <= o.gpuDutyMaxLatH ? o.gpuDutyW : 0)) * Math.min(1, c.needH / Math.max(1e-6, c.hardH)))
    // a GPU job squeezed into most of its window can't dodge dirty days beyond the 24h forecast
    * (1 + (c.prof.family === "cpu" ? 0 : o.gpuTightW) * Math.max(0, Math.min(1, c.needH / Math.max(1e-6, c.hardH)) - o.gpuTightAt));
  scored.sort((a, b) => a.rank - b.rank || a.prof.cores * a.k - b.prof.cores * b.k);
  // quota opportunity cost is not proportional to a job's own carbon: in a very clean zone (e.g. CH)
  // a small VM costs a few grams but frees quota that dirtier jobs use to dodge their dirty hours
  if (o.cleanZoneSmallVm > 0) {
    const fcMean = (z) => { const f = view.fc(z.area) ?? []; return f.length ? f.reduce((a, b) => a + b, 0) / f.length : Infinity; };
    for (const c of scored) if (c.prof.family === "cpu" && fcMean(c.zone) * c.zone.pue < o.cleanZoneMaxI) c.rank += o.cleanZoneSmallVm * c.prof.cores * c.k;
    scored.sort((a, b) => a.rank - b.rank || a.prof.cores * a.k - b.prof.cores * b.k);
  }
  // sticky: a job already holding a reservation keeps that placement unless another is clearly better
  const memo = view.memo?.get(j.w.id);
  if (memo) {
    const i = scored.findIndex((c) => c.zone.slug === memo.zone && c.prof.id === memo.prof && c.k === memo.k);
    if (i > 0 && scored[i].rank <= scored[0].rank * (1 + o.stickyTol)) scored.unshift(scored.splice(i, 1)[0]);
  }
  if (scored.length) return scored;
  const deadlineH = (j.w.deadline - cat.T0) / H;
  const all = candidates(cat, j.w).map((c) => {
    const needH = setupH(j.w, c.prof) + rem / (rateK(j.w, c.prof, c.k) * cal) + outputH(j.w);
    const fc = fcP(c.zone.area) ?? [];
    const grams = (c.k * c.prof.watts * needH * c.zone.pue * (cheapestMean(fc, 24) ?? 1e3)) / 1000;
    return { ...c, needH, availH: deadlineH - tPlan, hardH: deadlineH - tPlan, slackH: deadlineH - tPlan - needH, expI: 0, kwh: 0, grams, forced: true };
  });
  // deadline-feasible ones first (by carbon); "doomed" ones (can't finish in time) only by speed
  const minSlack = 1 + 2 * o.latH;
  const ok = all.filter((c) => c.slackH > minSlack).sort((a, b) => a.grams - b.grams);
  const fast = all.filter((c) => !(c.slackH > minSlack)).map((c) => ({ ...c, doomed: true })).sort((a, b) => a.needH - b.needH);
  return [...ok, ...fast];
}

/**
 * view = { t (hours since T0, when actions will land), state, usage:{vms,cores,cards}, fc:(area)=>number[],
 *          calib, jobs:[{ w, done, delivered, vms:[{id,zone,prof,state}], runH, obsRate }] }
 * returns actions: {type:'create', wl, zone, prof, k, why} | {type:'start'|'stop'|'delete', wl, vm, why}
 */
export function decide(cat, view, opts = {}) {
  const o0 = { ...DEFAULTS, ...opts };
  // with a fast API the controller can afford wider CPU windows and more pauses while others queue
  // (mock: +24 pts at 0.3 s lag, but -94 pts and a miss at 3 s lag) — so only below lowLatH
  const o = o0.latH <= o0.lowLatH ? { ...o0, ...o0.lowLat } : o0;
  // with a fast API the deadline margin can shrink (durations are deterministic; the controller's
  // latency term is kept): mock +10..+33 pts, 0 misses in 220 runs at a 1 h base
  if (o0.latH <= o0.lowLatH && o.marginCutH > 0) { o.marginMinHGpu = Math.max(o.lowLatMarginMinH, o0.marginMinH - (o.gpuMarginCutH ?? 0)); o.marginMinH = Math.max(o.lowLatMarginMinH, o0.marginMinH - o.marginCutH); }
  HP = Number(o.horizonPenalty) || 0;
  LLF = Boolean(o.llf);
  o.distFor = view.dist;
  const acts = [];
  const tH = view.t;
  const relH = (j) => (j.w.release - cat.T0) / H;
  const deadlineH = (j) => (j.w.deadline - cat.T0) / H;

  for (const j of view.jobs) if (j.delivered) for (const vm of j.vms) acts.push({ type: "delete", wl: j.w.id, vm, why: "delivered" });
  // past its deadline: work no longer counts but electricity does — free the VMs, stop planning it
  const missed = (j) => !j.delivered && (String(j.state ?? "").toLowerCase() === "deadline_missed" || tH > deadlineH(j) + 0.25);
  for (const j of view.jobs) if (missed(j)) for (const vm of j.vms) acts.push({ type: "delete", wl: j.w.id, vm, why: "deadline passed" });
  const open = view.jobs.filter((j) => !j.delivered && !missed(j));

  const cpuPause = o.cpuPause === "auto" ? o.latH <= o.cpuPauseMaxLatH : Boolean(o.cpuPause);
  const items = [];        // fast-forward items
  const deployed = [];     // { j, it, prof, pausable, gateRun, value, why }
  const fresh = [];        // released, not deployed: { j, it, opts, pick, gateNow, value }
  const heldOpen = { vms: 0, cores: 0, cards: {} };
  const addHeld = (f) => { heldOpen.vms += f.vms; heldOpen.cores += f.cores; if (f.cards) heldOpen.cards[f.fam] = (heldOpen.cards[f.fam] ?? 0) + f.cards; };

  for (const j of open) {
    if (!j.vms.length) continue;
    const prof = cat.profiles.get(j.vms[0].prof), zone = cat.zones.get(j.vms[0].zone);
    if (!prof || !zone) {
      // a VM we can't identify yet: left running; assume it holds a titan-sized share until the deadline
      const f = { vms: j.vms.length, cores: 40 * j.vms.length, fam: "cpu", cards: 0 };
      addHeld(f);
      items.push({ id: j.w.id, fp: f, needH: Math.max(0.5, deadlineH(j) - tH), due: deadlineH(j), deployed: true, startAt: tH });
      continue;
    }
    const k = j.vms.length;
    const rem = Math.max(0, j.w.required - j.done);
    // A VM someone else left (e.g. the starter demo) on a clearly dirtier placement, before its job
    // has done any real work (not released yet, or released < 30 min ago): replace it — nothing is lost.
    if (o.replaceForeign && j.vms.every((v) => v.adopted) && j.done <= 0 && tH - relH(j) < 0.5) {
      const tP = Math.max(tH, relH(j));
      const best = placements(cat, view, o, j, tP)[0];
      const cur = scorePlacement(cat, j.w, { zone, prof, k }, rem, tP, view.fcPlace ?? view.fc, { ...o, maxDuty: 1 }, calOf(view, j.w.unit, o));
      if (best && cur && !best.forced && best.grams < cur.grams * (1 - o.replaceMinRel) && cur.grams - best.grams > o.replaceMinG) {
        for (const vm of j.vms) acts.push({ type: "delete", wl: j.w.id, vm, why: `replace foreign ${prof.label}@${zone.slug} (est ${cur.grams.toFixed(0)}g) by ${best.prof.label}@${best.zone.slug} (est ${best.grams.toFixed(0)}g)` });
        continue; // re-placed as a fresh job once the delete lands
      }
    }
    const model = rateK(j.w, prof, k) * calOf(view, j.w.unit, o);
    const rate = j.obsRate > 0 ? Math.min(Math.max(j.obsRate, rateK(j.w, prof, k) * o.rateFloor), model * 1.05) : model;
    const wait = Math.max(0, relH(j) - tH);
    const setupLeft = j.done > 0 ? 0 : Math.max(0, setupH(j.w, prof) - (j.runH ?? 0));
    const runNeed = setupLeft + rem / rate + outputH(j.w);
    const due = deadlineH(j) - marginH(o, runNeed, prof.family);
    const f = footprint(prof, k);
    addHeld(f);
    // staging may run before release (the engine allows it), so it overlaps the wait
    const it = { id: j.w.id, fp: f, needH: (o.prestage ? Math.max(wait, setupLeft) - setupLeft : wait) + runNeed, due, deployed: true, startAt: tH };
    // staged and still waiting for release: stop it (0 W, keeps the staged input) until release
    const stagedWaiting = o.prestage && wait > o.latH + 0.15 && setupLeft <= 0 && j.done <= 0
      && j.vms.every((v) => v.state === "running" || v.state === "stopped");
    if (stagedWaiting) {
      for (const vm of j.vms) if (vm.state === "running") acts.push({ type: "stop", wl: j.w.id, vm, why: `staged, waiting ${wait.toFixed(1)}h for release` });
      items.push(it);
      continue;
    }
    // stagedGate: staged and releasing within the action lead — judge the release hour now instead of starting
    // unconditionally (a start just before a dirty release hour was then held running by the stop dwell)
    const nearRel = o.stagedGate && o.prestage && wait > 0 && setupLeft <= 0 && j.done <= 0;
    // (with pauseOutput the final output phase may pause too; its remaining time is taken as the
    // full output time, which keeps the deadline check conservative)
    const pausable = !o.noGate && (cpuPause || prof.family !== "cpu") && (rem > 1e-6 || o.pauseOutput) && (wait <= 0 || nearRel) && j.vms.every((v) => v.state === "running" || v.state === "stopped");
    const fcNow = view.fc(zone.area);
    const fc = nearRel && fcNow?.length > 1 ? fcNow.slice(Math.min(fcNow.length - 1, Math.max(0, Math.round(relH(j)) - Math.floor(tH)))) : fcNow;
    const sinceH = tH - (j.deployedH ?? tH);
    const availH = (prof.family === "cpu" ? Math.min(due - tH, Math.max(runNeed, o.cpuWindowH - sinceH)) : due - tH) - (nearRel ? wait : 0);
    let gateRun = !pausable || gate(fc, runNeed, availH) || withinNoise(fc, runNeed, availH, o.noiseBand);
    // The forecast is hourly but this runs every 250 ms: the need/window ratio drifts within the hour
    // and flipped jobs off and on minutes apart. Decide once per forecast hour and keep it (a
    // deadline-forced run always wins).
    if (o.hourlyGate && pausable && view.memo) {
      const hr = Math.floor(tH), key = `gate:${j.w.id}`, m = view.memo.get(key);
      const forced = runNeed >= availH - 0.25;
      if (m && m.h === hr && !forced) gateRun = m.run;
      else view.memo.set(key, { h: hr, run: gateRun });
    }
    const value = pausable && !gateRun ? (prof.watts * k / 1000) * zone.pue * hourSaving(fc, runNeed, availH) : 0;
    const fcMean = fc?.length ? fc.reduce((a, b) => a + b, 0) / fc.length : 0;
    const estG = ((prof.watts * k) / 1000) * (setupH(j.w, prof) + j.w.required / rateK(j.w, prof, k) + outputH(j.w)) * zone.pue * fcMean;
    // preemption facts: work kept if deleted now, and how long the forecast stays dirty
    let pre = null;
    if (o.preempt && pausable && !gateRun && !j.w.restartFromZero && j.w.inputS <= o.preemptMaxInputS
      && j.w.checkpointS > 0 && j.w.checkpointS <= o.preemptMaxCkptS && j.done > 0 && (view.memo?.get(`pre:${j.w.id}`)?.n ?? 0) < o.preemptMax) {
      const ckW = rate * (j.w.checkpointS / 3600);
      const kept = Math.floor(j.done / ckW + 1e-9) * ckW;
      const W = Math.max(1, Math.min(fc?.length ?? 0, Math.floor(availH)));
      const n = Math.min(W, Math.ceil((W * runNeed) / Math.max(1e-6, availH)));
      const thr = fc.slice(0, W).sort((a, b) => a - b)[n - 1];
      let dirty = 0; while (dirty < (fc?.length ?? 0) && fc[dirty] > thr) dirty++;
      if ((j.done - kept) <= o.preemptMaxLossFrac * ckW && dirty >= o.preemptMinH) {
        const rem2 = Math.max(0, j.w.required - kept);
        pre = { kept, dirty, needH: setupH(j.w, prof) + rem2 / rate + outputH(j.w) };
      }
    }
    deployed.push({ j, it, pausable, gateRun, value, estG, pre, why: `need=${runNeed.toFixed(1)}h avail=${(due - tH).toFixed(1)}h` });
    items.push(it);
  }
  const base = {
    vms: Math.max(0, view.usage.vms - heldOpen.vms), cores: Math.max(0, view.usage.cores - heldOpen.cores),
    cards: Object.fromEntries(Object.keys(cat.quota.cards).map((f) => [f, Math.max(0, (view.usage.cards[f] ?? 0) - (heldOpen.cards[f] ?? 0))])),
  };

  // While a multi-worker job waits, reserve its quota as ONE worker (its most efficient, slowest
  // shape). Planning it as k workers let it be pushed to the very end and squeezed in, so it
  // absorbed every other job's delays and ran compressed in dirty hours (w-14: t=20 -> t=85).
  const single = (list, bestC) => {
    if (!o.reserveSingle || !bestC || bestC.k <= 1 || bestC.forced) return bestC;
    const one = list.filter((c) => c.k === 1 && !c.doomed && !c.forced).sort((a, b) => (a.rank ?? a.grams) - (b.rank ?? b.grams))[0];
    return one ?? bestC;
  };
  // Released jobs without VMs: admit now, first-fit in deadline order (the same rule the
  // fast-forward uses), each with its cleanest placement that fits within fitTol.
  const free = { vms: view.usage.vms, cores: view.usage.cores, cards: { ...view.usage.cards } };
  // jobs released by now — plus, with pre-staging, jobs releasing within their boot + input time,
  // so staging is done by the release and compute starts at once
  // prestageExtraH: open the pre-release staging window this many hours earlier, so the clean-hour
  // rule can pick a cleaner time to load the input (the staged VM then waits stopped, at 0 W)
  const lead = (j) => (o.prestage ? (120 + j.w.inputS) / 3600 + o.latH + 0.1 + (o.prestageExtraH ?? 0) : 0);
  const releasedOrSoon = (j) => relH(j) <= tH + lead(j) + 1e-9;
  const waitingNow = open.filter((j) => !j.vms.length && releasedOrSoon(j))
    .map((j) => ({ j, list: placements(cat, view, o, j, Math.max(tH, relH(j) - lead(j))) })).filter((x) => x.list.length);
  waitingNow.sort((a, b) => (a.list[0].hardH - a.list[0].needH) - (b.list[0].hardH - b.list[0].needH) || deadlineH(a.j) - deadlineH(b.j));
  for (const x of waitingNow) {
    const best = x.list[0];
    // while any placement can still make the deadline, never settle for one that can't — wait
    // (the reservation holds the room) instead of grabbing a too-slow VM that happens to fit now
    const anyOk = x.list.some((c) => !c.doomed);
    let pick = null;
    for (const c of x.list) {
      if (anyOk && c.doomed) continue;
      if (!fitsQuota(cat, free, c.prof, c.k)) continue;
      if ((c.rank ?? c.grams) <= (best.rank ?? best.grams) * (1 + o.fitTol) || best.forced || c.forced) { pick = c; break; }
    }
    const use = pick ?? single(x.list, best);
    const f = footprint(use.prof, use.k);
    const due = deadlineH(x.j) - marginH(o, use.needH, use.prof.family);
    // every fresh job is a waiting item at `now`; the backfill decides whether it may start now.
    // A preempted job sits out its forecast dirty stretch (unless that would make it late).
    const hold = view.memo?.get(`pre:${x.j.w.id}`);
    const holdUntil = hold && hold.until > tH && use.hardH - use.needH > hold.until - tH + 2 ? hold.until : tH;
    const it = { id: x.j.w.id, fp: f, needH: use.needH, due, deployed: false, avail: holdUntil };
    if (pick) { free.vms += f.vms; free.cores += f.cores; if (f.cards) free.cards[f.fam] = (free.cards[f.fam] ?? 0) + f.cards; }
    const fc = view.fc(use.zone.area);
    const preRelease = o.prestage && o.prestageNoDefer && relH(x.j) > tH + 1e-9;
    // pickyStart: a job with much more slack than its forecast can see starts (and commits its zone) only in its
    // very cleanest hours, so later forecasts can still move it — waiting holds no quota and costs little
    const availF = Math.min(use.hardH, o.cpuWindowH);
    const fr = o.pickyFrac < 1 && pick && !use.forced && (!o.pickyGpuOnly || use.prof.family !== "cpu") && use.hardH - use.needH > o.pickyMinSlackH ? o.pickyFrac : 1;
    const gateNow = o.noGate || use.forced || !pick || preRelease || (!cpuPause && use.prof.family === "cpu") || gate(fc, use.needH, availF, fr)
      || (fr === 1 && withinNoise(fc, use.needH, availF, o.noiseBand));
    const value = pick && !gateNow ? (use.prof.watts * use.k / 1000) * use.zone.pue * hourSaving(fc, use.needH, availF, fr) : 0;
    if (view.memo) { if (!pick) view.memo.set(x.j.w.id, { zone: use.zone.slug, prof: use.prof.id, k: use.k }); else view.memo.delete(x.j.w.id); }
    fresh.push({ j: x.j, it, pick, use, gateNow, value, list: x.list });
    items.push(it);
  }
  // Future releases take part in the fast-forward with their best placement at release time.
  for (const j of open) {
    if (j.vms.length || releasedOrSoon(j)) continue;
    const list = placements(cat, view, o, j, relH(j));
    const best = single(list, list[0]);
    if (!best) continue;
    items.push({ id: j.w.id, fp: footprint(best.prof, best.k), needH: best.needH, due: deadlineH(j) - marginH(o, best.needH, best.prof.family), deployed: false, avail: relH(j) });
  }

  // Waiting for a preferred placement (e.g. a 4-card GPU that's busy) is only OK if the projection
  // says it's safe; otherwise take the cleanest placement that fits right now.
  const buffer = o.slackBufferH === "auto" ? o.bufferLatX * o.latH : Number(o.slackBufferH);
  let baseRun = fastForward(cat, tH, base, items);
  for (const x of fresh.filter((f) => !f.pick).sort((a, b) => a.it.due - b.it.due)) {
    const late = (baseRun.finish.get(x.j.w.id) ?? Infinity) - x.it.due;
    if (late <= -buffer) continue;
    const anyOk = x.list.some((c) => !c.doomed);
    const alt = x.list.find((c) => !(anyOk && c.doomed) && fitsQuota(cat, free, c.prof, c.k));
    if (!alt) continue;
    const saved = { ...x.it };
    Object.assign(x.it, { fp: footprint(alt.prof, alt.k), needH: alt.needH, due: deadlineH(x.j) - marginH(o, alt.needH, alt.prof.family) });
    const r = fastForward(cat, tH, base, items);
    const lateAlt = (r.finish.get(x.j.w.id) ?? Infinity) - x.it.due;
    if (lateAlt < late - 0.25) {
      x.pick = alt; x.use = alt; x.gateNow = true; baseRun = r;
      const f = x.it.fp; free.vms += f.vms; free.cores += f.cores; if (f.cards) free.cards[f.fam] = (free.cards[f.fam] ?? 0) + f.cards;
    } else Object.assign(x.it, saved);
  }

  if (o.debug) o.debug({ tH, fresh, baseRun, items, free, base });
  // Greedy: grant pauses / delayed starts by grams saved per hour, while nobody becomes late.
  const q = o.pauseQuantumH + o.latH;
  let plan = baseRun;
  const safe = baseRun.worst <= (o.pauseMode === "gate" ? -buffer : 0);
  const paused = new Set(), deferred = new Set(), preempted = new Set();
  if (o.pauseMode === "gate2") {
    // Pauses / delayed starts the clean-hour rule wants, ranked by grams saved per hour. Each must be
    // worth the quota it keeps idle (higher bar while another job waits for quota). With a safe
    // projection they're all granted; otherwise only those that leave nobody worse off.
    const blocked = fresh.some((x) => !((plan.start.get(x.j.w.id) ?? Infinity) <= tH + 1e-6));
    // points per gram differ by job (score formula): a CPU job's gram is worth ~1.7x a big GPU job's
    let wt = () => 1;
    if (o.pointsAware) {
      const est = {};
      for (const d of deployed) est[d.j.w.id] = d.estG ?? 0;
      for (const x of fresh) est[x.j.w.id] = x.use?.grams ?? 0;
      const m = marginalPoints(cat, est);
      const mean = Object.values(m).reduce((a, b) => a + b, 0) / Math.max(1, Object.keys(m).length);
      wt = (id) => (m[id] ?? mean) / mean;
    }
    // What a pause really costs while jobs queue for quota: each queued job starts later, with less
    // window to dodge dirty hours. Estimate that per hour of delay (its expected grams if it starts
    // `q` hours later, from the forecast shifted by q), points-weighted; a pause must save more.
    let oppCost = 0;
    if (blocked && o.dynamicBar) {
      const qh = Math.max(1, Math.round(q));
      for (const x of fresh) {
        if ((plan.start.get(x.j.w.id) ?? Infinity) <= tH + 1e-6 || !x.use || x.use.forced) continue;
        const rem = Math.max(0, x.j.w.required - x.j.done), cal = calOf(view, x.j.w.unit, o);
        const c = { zone: x.use.zone, prof: x.use.prof, k: x.use.k };
        const now = scorePlacement(cat, x.j.w, c, rem, tH, view.fc, o, cal);
        if (!now) continue;
        const later = scorePlacement(cat, x.j.w, c, rem, tH + qh, (a) => view.fc(a)?.slice(qh), o, cal);
        const perH = later ? Math.max(0, later.grams - now.grams) / qh : now.grams * 0.05; // can't start later → costly
        oppCost = Math.max(oppCost, perH * wt(x.j.w.id));
      }
    }
    const bar = (fp) => (blocked ? (o.dynamicBar ? o.dynX * oppCost : o.pressureValuePerCore * fp.cores) : o.minValuePerCore * fp.cores);
    // jobs on very clean grids save little by pausing, so while anyone queues they keep running
    const cleanJob = (d) => { const z = cat.zones.get(d.j.vms[0]?.zone); const f = z && view.fc(z.area); return !!f?.length && (f.reduce((a, b) => a + b, 0) / f.length) * z.pue < o.cleanNoPauseI; };
    const cands = [
      ...deployed.filter((d) => d.pausable && !d.gateRun && d.value > 0 && d.value * wt(d.j.w.id) >= bar(d.it.fp) && !(blocked && o.cleanNoPauseI > 0 && cleanJob(d))).map((d) => ({ kind: "pause", it: d.it, value: d.value * wt(d.j.w.id) })),
      ...fresh.filter((x) => x.pick && !x.gateNow && x.value > 0 && x.value * wt(x.j.w.id) >= bar(x.it.fp)).map((x) => ({ kind: "defer", it: x.it, value: x.value * wt(x.j.w.id) })),
    ].sort((a, b) => b.value - a.value);
    // harmlessPauses: while jobs queue, a pause below the bar is still granted when the projection shows it moves
    // no queued job's start — the bar exists to keep quota for them, and this job's quota isn't what they wait for
    // (run 5c35cc4b: queued jobs took exactly the cores freed by w-01, w-02, w-04, w-07; w-03, w-05, w-06, w-14 and
    // the 16-vCPU w-08 finished far later, yet their smaller pauses were refused for ~49 hours)
    if (o.harmlessPauses && blocked) cands.push(...deployed
      .filter((d) => d.pausable && !d.gateRun && d.value > 0 && !(d.value * wt(d.j.w.id) >= bar(d.it.fp)) && !(o.cleanNoPauseI > 0 && cleanJob(d)))
      .map((d) => ({ kind: "pause", it: d.it, value: d.value * wt(d.j.w.id), low: true })).sort((a, b) => b.value - a.value));
    // harmlessDefers: the same for a fresh job the clean-hour rule wants to start later — below the bar it was created
    // at once, in a dirty hour, though a deferral holds no quota at all
    if (o.harmlessDefers && blocked) cands.push(...fresh
      .filter((x) => x.pick && !x.gateNow && x.value > 0 && !(x.value * wt(x.j.w.id) >= bar(x.it.fp)))
      .map((x) => ({ kind: "defer", it: x.it, value: x.value * wt(x.j.w.id), low: true })).sort((a, b) => b.value - a.value));
    if (o.preempt && blocked) {
      const lateOf = (r, it) => (r.finish.get(it.id) ?? Infinity) - it.due;
      const base0 = new Map(items.map((it) => [it.id, lateOf(baseRun, it)]));
      for (const d of deployed.filter((x) => x.pre).sort((a, b) => b.value * wt(b.j.w.id) - a.value * wt(a.j.w.id))) {
        const it = d.it, saved = { ...it };
        // as a queued job again: its room goes to whoever waits, it re-enters after the dirty stretch
        Object.assign(it, { deployed: false, avail: tH + d.pre.dirty, needH: d.pre.needH });
        const r = fastForward(cat, tH, base, items);
        let ok = lateOf(r, it) <= -Math.max(buffer, o.queueCushionH);
        if (ok) for (const x of items) if (lateOf(r, x) > Math.max(base0.get(x.id), -buffer) + 1e-6) { ok = false; break; }
        if (ok) { preempted.add(it.id); plan = r; }
        else Object.assign(it, saved);
      }
    }
    if (o.trace) for (const d of deployed) if (d.pausable && !d.gateRun && d.it.fp.fam !== "cpu" && !(d.value > 0 && d.value * wt(d.j.w.id) >= bar(d.it.fp)))
      o.trace({ wl: d.j.w.id, t: +tH.toFixed(2), why: "bar", value: +(d.value * wt(d.j.w.id)).toFixed(2), bar: +bar(d.it.fp).toFixed(2), blocked });
    if (safe && !o.strictPauses) for (const c of cands) { if (!preempted.has(c.it.id)) (c.kind === "pause" ? paused : deferred).add(c.it.id); }
    else {
      const lateOf = (r, it) => (r.finish.get(it.id) ?? Infinity) - it.due;
      const base0 = new Map(items.map((it) => [it.id, lateOf(baseRun, it)]));
      // jobs still queued for quota pay for other jobs' pauses later (they start later, in a squeeze):
      // while anyone is queued, a pause must leave every job a bigger cushion
      const cushion = blocked ? Math.max(buffer, o.queueCushionH) : buffer;
      for (const c of cands) {
        if (preempted.has(c.it.id)) continue;
        const saved = { ...c.it };
        if (c.kind === "pause") c.it.startAt = tH + q; else c.it.avail = tH + q;
        const r = fastForward(cat, tH, base, items);
        let ok = lateOf(r, c.it) <= -buffer, by = ok ? null : "own";
        // stall guard: a stopped (or not yet created) job must still finish stallH before its real deadline,
        // so a start/create that the server holds for that long still lands in time. Live run f085e7d7: one
        // start took 32 s (6.5 sim h at 720x) and w-15, paused with ~1 h of margin, missed its deadline.
        if (ok && o.stallH > 0 && (r.finish.get(c.it.id) ?? Infinity) > (cat.workloads.get(c.it.id).deadline - cat.T0) / H - o.stallH) { ok = false; by = "stall"; }
        if (ok) for (const it of items) if (lateOf(r, it) > Math.max(base0.get(it.id), -cushion) + 1e-6) { ok = false; by = it.id; break; }
        if (ok && c.low) for (const it of items) if (!it.deployed && it.id !== c.it.id && (r.start.get(it.id) ?? Infinity) > (plan.start.get(it.id) ?? Infinity) + 1e-6) { ok = false; by = `delays ${it.id}`; break; }
        if (!ok && o.trace && c.it.fp.fam !== "cpu") o.trace({ wl: c.it.id, t: +tH.toFixed(2), why: "projection", by, cushion, blocked, value: +c.value.toFixed(2) });
        if (ok) { (c.kind === "pause" ? paused : deferred).add(c.it.id); plan = r; }
        else Object.assign(c.it, saved);
      }
    }
  } else if (safe && o.pauseMode === "gate") {
    const blocked = fresh.some((x) => !((plan.start.get(x.j.w.id) ?? Infinity) <= tH + 1e-6));
    // while a released job waits for quota, one class of jobs runs flat-out to free quota sooner
    const pressed = (fam) => o.pressure && blocked && (o.pressureTarget === "cpu" ? fam === "cpu" : o.pressureTarget === "gpu" ? fam !== "cpu" : false);
    for (const d of deployed) if (d.pausable && !d.gateRun && !pressed(d.it.fp.fam)) paused.add(d.j.w.id);
    for (const x of fresh) if (x.pick && !x.gateNow) deferred.add(x.j.w.id);
  } else if (safe) {
    const cands = [
      ...deployed.filter((d) => d.pausable && !d.gateRun && d.value > 0 && d.value >= o.minValuePerCore * d.it.fp.cores).map((d) => ({ kind: "pause", d, value: d.value })),
      ...fresh.filter((x) => x.pick && !x.gateNow && x.value > 0 && x.value >= o.minValuePerCore * x.it.fp.cores).map((x) => ({ kind: "defer", x, value: x.value })),
    ].sort((a, b) => b.value - a.value);
    for (const c of cands) {
      const it = c.kind === "pause" ? c.d.it : c.x.it;
      const saved = { ...it };
      if (c.kind === "pause") it.startAt = tH + q; else it.avail = tH + q;
      const r = fastForward(cat, tH, base, items);
      const isGpu = it.fp.fam !== "cpu";
      const ok = o.gpuOwnCheck && isGpu ? (r.finish.get(it.id) ?? Infinity) - it.due <= -buffer : r.worst <= -buffer;
      if (ok) { (c.kind === "pause" ? paused : deferred).add(it.id); plan = r; }
      else Object.assign(it, saved);
    }
  }

  for (const d of deployed) {
    if (preempted.has(d.j.w.id)) {
      const m = view.memo?.get(`pre:${d.j.w.id}`) ?? { n: 0, t: -1e9, until: -1e9 };
      // one count per episode (deletes repeat until acked); stay out until the dirty stretch is over
      if (tH - m.t > 1) view.memo?.set(`pre:${d.j.w.id}`, { n: m.n + 1, t: tH, until: tH + d.pre.dirty });
      for (const vm of d.j.vms) acts.push({ type: "delete", wl: d.j.w.id, vm, why: `preempt: frees ${d.it.fp.cores} vCPUs for ${d.pre.dirty}h dirty, keeps ${d.pre.kept.toFixed(0)}/${d.j.w.required} work` });
      continue;
    }
    const stop = paused.has(d.j.w.id);
    for (const vm of d.j.vms) {
      if (vm.state === "running" && stop) acts.push({ type: "stop", wl: d.j.w.id, vm, why: `${d.why} saves≈${d.value.toFixed(1)}g/h` });
      else if (vm.state === "stopped" && !stop) acts.push({ type: "start", wl: d.j.w.id, vm, why: `${d.why}${safe ? "" : " deadline-risk"}` });
    }
  }
  for (const x of fresh) {
    // create only what the reservation plan starts now (an earlier-deadline job may own the room)
    if (!x.pick || deferred.has(x.j.w.id) || !((plan.start.get(x.j.w.id) ?? Infinity) <= tH + 1e-6)) continue;
    const p = x.pick;
    // runners-up (best placement in each other zone / machine), so a run's log shows how close each choice was
    const seen = new Set([`${p.zone.slug}|${p.prof.label}`]), alts = [];
    for (const c of x.list) { const key = `${c.zone.slug}|${c.prof.label}`; if (seen.has(key) || c.doomed) continue; seen.add(key); alts.push(c); if (alts.length >= 3) break; }
    const altTxt = alts.map((c) => `${c.prof.label}x${c.k}@${c.zone.slug} expI=${c.expI.toFixed(0)} est=${c.grams.toFixed(0)}g rank=+${(100 * ((c.rank ?? c.grams) / (p.rank ?? p.grams) - 1)).toFixed(0)}%`).join("; ");
    acts.push({ type: "create", wl: x.j.w.id, zone: p.zone.slug, prof: p.prof.id, k: p.k,
      why: `${p.prof.label}x${p.k}@${p.zone.slug} need=${p.needH.toFixed(1)}h slack=${p.slackH.toFixed(1)}h expI=${p.expI.toFixed(0)} est=${p.grams.toFixed(0)}g${p.forced ? " FORCED" : ""}${safe ? "" : " deadline-risk"}${altTxt ? ` | next: ${altTxt}` : ""}` });
  }

  // The clock only starts on the first accepted create: with nothing released and nothing
  // existing (or in flight — a stale READY snapshot must not start it twice), deploy the
  // earliest-release job now; it waits for its release at idle draw.
  if (view.state === "READY" && view.usage.vms === 0 && !acts.some((a) => a.type === "create")) {
    const first = open.filter((j) => !j.vms.length).sort((a, b) => a.w.release - b.w.release)[0];
    const p = first && placements(cat, view, o, first, Math.max(tH, relH(first)))[0];
    if (p) acts.push({ type: "create", wl: first.w.id, zone: p.zone.slug, prof: p.prof.id, k: p.k, why: `clock start: ${p.prof.label}x${p.k}@${p.zone.slug} est=${p.grams.toFixed(0)}g` });
  }
  return acts;
}
