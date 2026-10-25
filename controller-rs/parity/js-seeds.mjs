#!/usr/bin/env node
/** Per-seed results of the JS mock (scripts/greenops/mock.mjs, unchanged), one JSON line per seed.
 *  The mock's own CLI prints only kg per seed; the parity harness needs points and per-job grams.
 *  Usage: node controller-rs/parity/js-seeds.mjs <seeds> --lat <ms> [--from N] [--foreign] [--late H]
 *                                               [--opt key=value]... [--ctl key=value]...
 *  (MOCK_* env knobs apply as in mock.mjs; --opt/--ctl parse like mock.mjs, JS camelCase names) */
import { simulate } from "../../scripts/greenops/mock.mjs";

const args = process.argv.slice(2);
const SEEDS = Number(args.find((a) => /^\d+$/.test(a)) ?? 20);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? Number(args[i + 1]) : d; };
const LAT = opt("--lat", 3000), FROM = opt("--from", 1), LATE = opt("--late", 0);
const FOREIGN = args.includes("--foreign");
const P = {}, C = {};
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--opt" || args[i] === "--ctl") {
    const [k, v] = args[i + 1].split("=");
    (args[i] === "--opt" ? P : C)[k] = v === "true" ? true : v === "false" ? false : v.startsWith("{") ? JSON.parse(args[i + 1].slice(k.length + 1)) : isNaN(Number(v)) ? v : Number(v);
    i++;
  }
}
const t0 = process.hrtime.bigint();
for (let s = FROM; s < FROM + SEEDS; s++) {
  const s0 = process.hrtime.bigint();
  const r = await simulate(s, { latMs: LAT, lateStartH: LATE, foreign: FOREIGN, policyOpts: P, ctlOpts: C });
  const ms = Number(process.hrtime.bigint() - s0) / 1e6;
  console.log(JSON.stringify({ seed: s, lat: LAT, points: r.points, grams: r.grams, kwh: r.kwh, idleG: r.idleG, late: r.late, dq: r.dq, rejects: r.rejects, leftVms: r.leftVms, stats: r.stats, perJob: r.perJob, ms }));
}
console.error(`total ${(Number(process.hrtime.bigint() - t0) / 1e9).toFixed(2)} s for ${SEEDS} seeds`);
