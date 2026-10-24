/** [v1, kept for comparison — superseded by policy.mjs] Pure, deterministic scheduling policy.
 *
 *  Idea in one line: put every job where its electricity is cleanest, then let it run only in
 *  the cheapest hours of the published 24h forecast — exactly as many hours as it still needs
 *  (plus a safety margin), so deadlines hold and dirty hours are skipped. Stopped VMs draw 0 W
 *  and keep all progress, but they still hold quota, so quota is planned explicitly.
 *
 *  The policy only sees `view` (current status + forecasts published now). It never sees actuals.
 */
import { candidates, cheapestMean, fitsQuota, outputH, rateK, setupH } from "./model.mjs";

export const DEFAULTS = {
  marginMinH: 4,       // never plan to finish closer than this to a deadline
  marginFrac: 0.12,    // ...or this fraction of the remaining runtime, whichever is larger
  fitTol: 0.08,        // accept a quota-fitting placement up to 8% dirtier than the unconstrained best
  reserveSlackH: 30,   // a blocked job with less slack than this reserves its quota from lower-priority jobs
  maxDuty: 0.92,       // a fresh placement must leave at least 8% of its window as slack
  pressureDuty: 1.0,   // CPU jobs run flat-out while another job is waiting for quota (0 disables)
  gpuOnlyGate: false,  // if true, CPU jobs never pause (diagnostic switch)
  pauseValueMin: 0,    // g CO2e saved per stopped core-hour below which a job just runs flat-out
  reserveAheadH: 24,   // hold quota for GPU jobs releasing within this many hours
  cpuWindowH: 72,      // CPU jobs plan to finish within this many hours (frees quota sooner)
  noGate: false,       // if true, nothing ever pauses (baseline for comparison)
};

const H = 3.6e6;

function marginH(o, needH) { return Math.max(o.marginMinH, o.marginFrac * needH); }

/** Should a job that still needs `needH` hours, with `availH` usable hours left, run in the
 *  current hour? Proportional rule: within the visible window, run in the cheapest
 *  ceil(window * needH / availH) hours. Forced on when there is no slack left. */
export function gate(fc, needH, availH) {
  if (needH <= 0) return true;
  if (!fc?.length || needH >= availH - 0.25) return true;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  const win = fc.slice(0, W);
  const n = Math.min(W, Math.ceil((W * needH) / availH + 1e-9));
  const sorted = [...win].sort((a, b) => a - b);
  return fc[0] <= sorted[n - 1] + 1e-9;
}

/** Grams saved per core-hour spent stopped, if the job follows gate() instead of running flat-out.
 *  Stopped VMs still hold quota, so pausing is only worth it where this is high (GPUs, dirty grids). */
export function pauseValue(fc, needH, availH, kw, pue, cores) {
  if (!fc?.length || needH >= availH) return 0;
  const W = Math.max(1, Math.min(fc.length, Math.floor(availH)));
  const win = fc.slice(0, W);
  const n = Math.min(W, Math.ceil((W * needH) / availH));
  if (n >= W) return 0;
  const mean = win.reduce((a, b) => a + b, 0) / W;
  return ((mean - cheapestMean(win, n)) * kw * pue * n) / ((W - n) * cores);
}

/** Expected carbon (g) of a fresh placement, plus its timing numbers. */
export function scorePlacement(cat, w, c, rem, tH, fcFor, o, calib = 1) {
  const rate = rateK(w, c.prof, c.k) * calib;
  const needH = setupH(w, c.prof) + rem / rate + outputH(w);
  const deadlineH = (w.deadline - cat.T0) / H;
  const hardH = deadlineH - tH - marginH(o, needH);
  if (!(hardH > 0) || needH > hardH * o.maxDuty) return null;
  const availH = c.prof.family === "cpu" ? Math.max(needH / o.maxDuty, Math.min(hardH, o.cpuWindowH)) : hardH;
  const fc = fcFor(c.zone.area);
  if (!fc?.length) return null;
  const W = Math.min(fc.length, Math.floor(availH));
  const expI = cheapestMean(fc.slice(0, Math.max(1, W)), (Math.max(1, W) * needH) / availH);
  const kwh = (c.k * c.prof.watts * needH) / 1000;
  return { ...c, needH, availH, slackH: availH - needH, hardSlackH: hardH - needH, expI, kwh, grams: kwh * c.zone.pue * expI };
}

/**
 * view = { t (hours since T0), state, usage:{vms,cores,cards}, fc:(area)=>number[],
 *          jobs:[{ w, done, delivered, vms:[{id,zone,prof,state}], runH, obsRate }] }
 * returns actions: {type:'create', wl, zone, prof, k, why} | {type:'start'|'stop'|'delete', wl, vm, why}
 */
export function decide(cat, view, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const acts = [];
  const tH = view.t;
  const usage = { vms: view.usage.vms, cores: view.usage.cores, cards: { ...view.usage.cards } };

  // 1) delivered → delete everything bound to it (idle VMs still burn carbon).
  for (const j of view.jobs) if (j.delivered) for (const vm of j.vms) acts.push({ type: "delete", wl: j.w.id, vm, why: "delivered" });

  const open = view.jobs.filter((j) => !j.delivered);
  const relH = (j) => (j.w.release - cat.T0) / H;
  const waiting = open.filter((j) => j.vms.length === 0 && relH(j) <= tH + 1e-9);

  // 2) undeployed released jobs: choose a placement, in least-slack-first order.
  const plans = waiting.map((j) => {
    const rem = Math.max(0, j.w.required - j.done);
    const scored = candidates(cat, j.w).map((c) => scorePlacement(cat, j.w, c, rem, tH, view.fc, o, view.calib?.[j.w.unit] ?? 1)).filter(Boolean);
    scored.sort((a, b) => a.grams - b.grams || a.prof.cores * a.k - b.prof.cores * b.k);
    return { j, rem, scored, best: scored[0] ?? null };
  });
  // Jobs with no feasible placement (everything over maxDuty) still must go: fastest option.
  for (const pl of plans) {
    if (pl.best) continue;
    const rem = pl.rem;
    const all = candidates(cat, pl.j.w).map((c) => {
      const needH = setupH(pl.j.w, c.prof) + rem / (rateK(pl.j.w, c.prof, c.k) * (view.calib?.[pl.j.w.unit] ?? 1)) + outputH(pl.j.w);
      return { ...c, needH, availH: (pl.j.w.deadline - cat.T0) / H - tH, slackH: -1e9, expI: 0, kwh: 0, grams: needH, forced: true };
    }).sort((a, b) => a.needH - b.needH);
    const ok = all.filter((c) => c.needH <= c.availH - 0.5).map((c) => ({ ...c, grams: c.k * c.prof.watts * c.needH * c.zone.pue * (cheapestMean(view.fc(c.zone.area) ?? [], 24) ?? 1e3) }));
    ok.sort((a, b) => a.grams - b.grams);
    pl.scored = ok.length ? [...ok, ...all] : all;
    pl.best = all[0] ?? null;
  }
  // GPU jobs first (they hold most of the carbon and need scarce cards), then least slack first.
  const gpuFirst = (pl) => (pl.j.w.kind === "gpu" ? 0 : 1);
  plans.sort((a, b) => gpuFirst(a) - gpuFirst(b) || (a.best?.slackH ?? -1e9) - (b.best?.slackH ?? -1e9));

  let blocked = false;
  const reserved = { vms: 0, cores: 0, cards: {} };
  const cpuRes = { vms: 0, cores: 0, cards: {} }; // extra hold applied to CPU placements only
  const addRes = (r, c) => { r.vms += c.k; r.cores += c.prof.cores * c.k; if (c.prof.family !== "cpu") r.cards[c.prof.family] = (r.cards[c.prof.family] ?? 0) + c.prof.cards * c.k; };
  const avail = (forCpu) => ({
    vms: usage.vms + reserved.vms + (forCpu ? cpuRes.vms : 0), cores: usage.cores + reserved.cores + (forCpu ? cpuRes.cores : 0),
    cards: Object.fromEntries(Object.keys(cat.quota.cards).map((f) => [f, (usage.cards[f] ?? 0) + (reserved.cards[f] ?? 0) + (forCpu ? (cpuRes.cards[f] ?? 0) : 0)])),
  });
  const starting = view.state === "READY";
  let clockStarter = null;
  // only while nothing exists or is in flight: a stale READY snapshot must not start it twice
  if (starting && plans.length === 0 && view.usage.vms === 0) {
    // Nothing released yet: the clock only starts on the first accepted create, so deploy
    // the earliest-release job now (it waits for its release at idle draw).
    const first = open.filter((j) => j.vms.length === 0).sort((a, b) => a.w.release - b.w.release)[0];
    if (first) {
      const rem = first.w.required - first.done;
      const s = candidates(cat, first.w).map((c) => scorePlacement(cat, first.w, c, rem, Math.max(tH, relH(first)), view.fc, o)).filter(Boolean)
        .sort((a, b) => a.grams - b.grams)[0];
      if (s) clockStarter = { j: first, best: s, scored: [s] };
    }
  }
  if (clockStarter) plans.push(clockStarter);

  // Hold quota for GPU jobs about to be released (they carry most of the run's carbon and need
  // their pause flexibility; CPU jobs can fill in around them).
  for (const j of open) {
    if (j.vms.length || j.w.kind !== "gpu") continue;
    const dt = relH(j) - tH;
    if (!(dt > 0 && dt <= o.reserveAheadH)) continue;
    const rem = j.w.required - j.done;
    const s = candidates(cat, j.w).map((c) => scorePlacement(cat, j.w, c, rem, relH(j), view.fc, o)).filter(Boolean).sort((a, b) => a.grams - b.grams)[0];
    if (s) addRes(cpuRes, s);
  }

  for (const pl of plans) {
    if (!pl.best) continue;
    const urgent = pl.best.forced || pl.best.slackH < 2;
    const isCpuJob = pl.j.w.kind !== "gpu";
    const u = avail(isCpuJob);
    let pick = null;
    for (const c of pl.scored) {
      if (!fitsQuota(cat, u, c.prof, c.k)) continue;
      if (c.grams <= pl.best.grams * (1 + o.fitTol) || urgent) { pick = c; break; }
    }
    if (!pick) {
      blocked = true;
      if (!isCpuJob) addRes(cpuRes, pl.best); // a waiting GPU job: no CPU job may take its room
      else if (pl.best.slackH < o.reserveSlackH) addRes(reserved, pl.best);
      continue;
    }
    // Start only in a clean hour (setup draws power too), unless urgent or starting the clock.
    const pfc = view.fc(pick.zone.area);
    const lowValue = pick.prof.family === "cpu" && pauseValue(pfc, pick.needH, pick.availH, (pick.prof.watts * pick.k) / 1000, pick.zone.pue, pick.prof.cores * pick.k) < o.pauseValueMin;
    const go = urgent || o.noGate || lowValue || pl === clockStarter || gate(pfc, pick.needH, pick.availH);
    if (!go) {
      // hold its quota so a lower-priority job can't take it while we wait for a clean hour
      addRes(reserved, pick);
      continue;
    }
    acts.push({ type: "create", wl: pl.j.w.id, zone: pick.zone.slug, prof: pick.prof.id, k: pick.k,
      why: `${pick.prof.label}x${pick.k}@${pick.zone.slug} need=${pick.needH.toFixed(1)}h avail=${pick.availH.toFixed(1)}h expI=${pick.expI.toFixed(0)} est=${pick.grams.toFixed(0)}g` });
    usage.vms += pick.k; usage.cores += pick.prof.cores * pick.k;
    if (pick.prof.family !== "cpu") usage.cards[pick.prof.family] = (usage.cards[pick.prof.family] ?? 0) + pick.prof.cards * pick.k;
  }

  // 3) deployed jobs: run in clean hours, pause in dirty ones.
  for (const j of open) {
    if (!j.vms.length) continue;
    const vm0 = j.vms[0];
    const prof = cat.profiles.get(vm0.prof);
    const zone = cat.zones.get(vm0.zone);
    if (!prof || !zone) continue; // unknown VM: leave it running
    const k = j.vms.length;
    const rem = Math.max(0, j.w.required - j.done);
    let run = true, why = "";
    if (rem <= 1e-6) { run = true; why = "output"; }
    else if (relH(j) > tH) { run = true; why = "pre-release"; }
    else {
      const model = rateK(j.w, prof, k) * (view.calib?.[j.w.unit] ?? 1);
      const rate = j.obsRate > 0 ? Math.min(j.obsRate, model * 1.05) : model;
      const setupLeft = j.done > 0 ? 0 : Math.max(0, setupH(j.w, prof) - (j.runH ?? 0));
      const needH = setupLeft + rem / rate + outputH(j.w);
      const deadlineH = (j.w.deadline - cat.T0) / H;
      const isCpu = prof.family === "cpu";
      const hardH = deadlineH - tH - marginH(o, needH);
      const sinceH = tH - (j.deployedH ?? tH);
      const availH = isCpu ? Math.min(hardH, Math.max(needH, o.cpuWindowH - sinceH)) : hardH;
      if (o.noGate) { run = true; why = "no-gate"; }
      else if (isCpu && o.gpuOnlyGate) { run = true; why = "cpu-no-gate"; }
      else if (isCpu && blocked && o.pressureDuty > 0) { run = true; why = "quota-pressure"; }
      else {
        const zfc = view.fc(zone.area);
        const val = pauseValue(zfc, needH, availH, (prof.watts * k) / 1000, zone.pue, prof.cores * k);
        run = (isCpu && val < o.pauseValueMin) || gate(zfc, needH, availH);
        why = `need=${needH.toFixed(1)} avail=${availH.toFixed(1)} value=${val.toFixed(2)}`;
      }
    }
    for (const vm of j.vms) {
      if (vm.state === "running" && !run) acts.push({ type: "stop", wl: j.w.id, vm, why });
      else if (vm.state === "stopped" && run) acts.push({ type: "start", wl: j.w.id, vm, why });
    }
  }
  return acts;
}
