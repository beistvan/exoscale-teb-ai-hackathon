#!/usr/bin/env node
/** Paired A/B comparison on the Rust mock: the baseline and each variant run the same seeds under
 *  the same configs, so each seed's point difference isolates the variant's effect (the synthetic
 *  grid and latency draws are shared). Reports mean difference ± paired standard error, how many seeds
 *  improved, and failures (missed deadlines / disqualification).
 *
 *  Usage: node controller-rs/tools/ab.mjs [--seeds 1000] [--from 1] [--configs lat20,anom20]
 *                                         [--base "<args>"] [--out FILE.jsonl] -- "<variant args>" ...
 *  Variant args are mock options, e.g. "--opt noise_band=0.03" or "--ctl min_dwell_h=0.3".
 *  Configs: lat20, lat100, lat300, lat3000, anom20 (persistent forecast misses), stall20 (32 s stall). */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(HERE, "../target/release/greenops-controller");
const CONFIGS = {
  lat20: { lat: 20, env: {} },
  lat100: { lat: 100, env: {} },
  lat300: { lat: 300, env: {} },
  lat3000: { lat: 3000, env: {} },
  anom20: { lat: 20, env: { MOCK_FC_ANOM: "0.08,0.8" } },
  stall20: { lat: 20, env: { MOCK_STALL: "r,32000,5" } },
};

const argv = process.argv.slice(2);
const dd = argv.indexOf("--");
const own = dd >= 0 ? argv.slice(0, dd) : argv, variants = dd >= 0 ? argv.slice(dd + 1) : [];
const opt = (k, d) => { const i = own.indexOf(k); return i >= 0 ? own[i + 1] : d; };
const SEEDS = Number(opt("--seeds", 1000)), FROM = Number(opt("--from", 1));
const CFG = String(opt("--configs", "lat20,anom20")).split(",");
const BASE = String(opt("--base", "")).split(" ").filter(Boolean);
const OUT = opt("--out", null);

function run(cfg, extra) {
  const c = CONFIGS[cfg];
  if (!c) throw new Error(`unknown config ${cfg}`);
  const args = ["mock", String(SEEDS), "--from", String(FROM), "--lat", String(c.lat), "--json", ...BASE, ...extra];
  const r = spawnSync(BIN, args, { env: { ...process.env, ...c.env }, encoding: "utf8", maxBuffer: 1 << 30 });
  if (r.status !== 0 && r.status !== 1) throw new Error(`${BIN} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim().split("\n").map((l) => JSON.parse(l));
}
const stats = (b, v) => {
  const failed = (x) => x.late.length || x.dq;
  const all = v.map((x, i) => x.points - b[i].points);
  // clean: seeds where neither side failed (one missed deadline costs >5000 pts and swamps the mean)
  const d = v.map((x, i) => [x, b[i]]).filter(([x, y]) => !failed(x) && !failed(y)).map(([x, y]) => x.points - y.points), n = d.length;
  const mAll = all.reduce((s, x) => s + x, 0) / all.length;
  const m = d.reduce((s, x) => s + x, 0) / n;
  const se = Math.sqrt(d.reduce((s, x) => s + (x - m) ** 2, 0) / (n - 1) / n);
  const fails = (r) => r.filter((x) => x.late.length || x.dq).length;
  const kg = (r) => r.reduce((s, x) => s + x.grams, 0) / r.length / 1000;
  return { m, se, t: m / se, mAll, failSeedsB: b.filter(failed).map((x) => `${x.seed}:${x.late.join("+") || "DQ"}`), failSeedsV: v.filter(failed).map((x) => `${x.seed}:${x.late.join("+") || "DQ"}`), up: d.filter((x) => x > 1e-9).length, down: d.filter((x) => x < -1e-9).length, n,
    baseMean: b.reduce((s, x) => s + x.points, 0) / n, kgDiff: kg(v) - kg(b), failB: fails(b), failV: fails(v) };
};

const t0 = Date.now();
const base = Object.fromEntries(CFG.map((c) => [c, run(c, [])]));
console.log(`baseline${BASE.length ? " [" + BASE.join(" ") + "]" : ""}, seeds ${FROM}-${FROM + SEEDS - 1}: ` +
  CFG.map((c) => { const r = base[c], f = r.filter((x) => x.late.length || x.dq); return `${c} ${(r.reduce((s, x) => s + x.points, 0) / r.length).toFixed(1)} pts (fail ${f.length}${f.length ? " " + f.map((x) => `${x.seed}:${x.late.join("+") || "DQ"}`).join(",") : ""})`; }).join(" | ") +
  ` [${((Date.now() - t0) / 1000).toFixed(0)} s]`);
for (const v of variants) {
  const t1 = Date.now();
  const extra = v.split(" ").filter(Boolean);
  const res = CFG.map((c) => [c, stats(base[c], run(c, extra))]);
  const line = res.map(([c, s]) => `${c} ${s.m >= 0 ? "+" : ""}${s.m.toFixed(2)} ±${s.se.toFixed(2)} (t ${s.t.toFixed(1)}, ${s.up}↑/${s.down}↓, fail ${s.failB}→${s.failV}${s.failV ? " " + s.failSeedsV.join(",") : ""}; all-seed ${s.mAll >= 0 ? "+" : ""}${s.mAll.toFixed(1)})`).join(" | ");
  console.log(`${v.padEnd(44)} ${line} [${((Date.now() - t1) / 1000).toFixed(0)} s]`);
  if (OUT) fs.appendFileSync(OUT, JSON.stringify({ variant: v, base: BASE.join(" "), seeds: SEEDS, from: FROM, res: Object.fromEntries(res) }) + "\n");
}
