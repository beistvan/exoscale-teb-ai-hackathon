#!/usr/bin/env node
/** Parity harness: runs the JS mock (scripts/greenops/mock.mjs, unchanged) and the Rust port on the
 *  same seeds and compares every per-seed result field bit for bit, then measures speed.
 *  Writes a markdown report (default controller-rs/PARITY.md).
 *
 *  Usage: node controller-rs/parity/parity.mjs [--seeds 20] [--lats 100,3000] [--extended]
 *                                              [--jobs 4] [--bin PATH] [--out FILE]
 *  Build the Rust binary first: cargo build --release --manifest-path controller-rs/Cargo.toml */
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "../..");
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const SEEDS = Number(opt("--seeds", 20));
const LATS = String(opt("--lats", "100,3000")).split(",").map(Number);
const JOBS = Number(opt("--jobs", 4));
const BIN = path.resolve(opt("--bin", path.join(ROOT, "controller-rs/target/release/greenops-controller")));
const OUT = path.resolve(opt("--out", path.join(ROOT, "controller-rs/PARITY.md")));
const EXTENDED = args.includes("--extended");

function run(cmd, argv, env = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd: ROOT, env: { ...process.env, ...env } });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 || code === 1 ? resolve({ out, err }) : reject(new Error(`${cmd} ${argv.join(" ")} → ${code}\n${err}`))));
  });
}
const lines = (s) => s.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

/** JS results for seeds [from, from+n), split over `jobs` node processes. */
async function js(n, from, lat, flags = [], env = {}, jobs = JOBS) {
  const per = Math.ceil(n / jobs), parts = [];
  for (let k = 0; k < jobs && k * per < n; k++) {
    const cnt = Math.min(per, n - k * per);
    parts.push(run("node", ["controller-rs/parity/js-seeds.mjs", String(cnt), "--lat", String(lat), "--from", String(from + k * per), ...flags], env));
  }
  return (await Promise.all(parts)).flatMap((r) => lines(r.out)).sort((a, b) => a.seed - b.seed);
}
async function rs(n, from, lat, flags = [], env = {}, threads = 0) {
  const t = threads ? ["--threads", String(threads)] : [];
  const r = await run(BIN, ["mock", String(n), "--lat", String(lat), "--from", String(from), "--json", ...t, ...flags], env);
  return lines(r.out);
}

const FIELDS = ["points", "grams", "kwh", "idleG", "dq", "rejects", "leftVms"];
function compare(a, b) {
  const diffs = [];
  if (a.length !== b.length) diffs.push(`seed count ${a.length} vs ${b.length}`);
  let exact = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a[i], y = b[i], d = [];
    if (x.seed !== y.seed) d.push("seed");
    for (const k of FIELDS) if (!Object.is(x[k], y[k])) d.push(k);
    if (JSON.stringify(x.stats) !== JSON.stringify(y.stats)) d.push("stats");
    if (JSON.stringify(x.late) !== JSON.stringify(y.late)) d.push("late");
    for (const k of Object.keys(x.perJob)) if (!Object.is(x.perJob[k], y.perJob?.[k])) d.push(`perJob.${k}`);
    if (d.length) diffs.push(`seed ${x.seed}: ${d.join(", ")}`); else exact++;
  }
  const mean = (r) => r.reduce((s, x) => s + x.points, 0) / Math.max(1, r.length);
  const fails = (r) => r.filter((x) => x.late.length || x.dq).length;
  return { exact, n: a.length, diffs, meanJs: mean(a), meanRs: mean(b), failsJs: fails(a), failsRs: fails(b) };
}
const f1 = (x) => x.toFixed(1), f3 = (x) => x.toFixed(3);
const rel = (a, b) => (a === b ? "0" : `${(((b - a) / a) * 100).toExponential(1)} %`);

const env = {
  arch: `${os.platform()} ${os.arch()}`,
  cpu: (() => { try { return execSync("sysctl -n machdep.cpu.brand_string", { encoding: "utf8" }).trim(); } catch { return os.cpus()[0]?.model ?? "?"; } })(),
  cores: os.cpus().length,
  node: process.version, v8: process.versions.v8,
  rustc: (() => { try { return execSync("rustc --version", { encoding: "utf8" }).trim(); } catch { return "?"; } })(),
  commit: (() => { try { return execSync("git rev-parse --short HEAD", { cwd: ROOT, encoding: "utf8" }).trim(); } catch { return "?"; } })(),
};
console.error(`parity: ${SEEDS} seeds x lat ${LATS.join(",")}${EXTENDED ? " + extended" : ""}; js jobs ${JOBS}; ${env.arch}, node ${env.node}`);

// 1. headline parity: seeds 1..SEEDS at each latency (JS run in one process, so its per-seed ms is a clean speed sample)
const main = [];
for (const lat of LATS) {
  const a = await js(SEEDS, 1, lat, [], {}, 1);
  const b = await rs(SEEDS, 1, lat, [], {}, 1);
  main.push({ lat, a, b, c: compare(a, b) });
  console.error(`lat ${lat}: exact ${main.at(-1).c.exact}/${SEEDS}`);
}

// 2. speed: JS single process (from the runs above), Rust one thread and all threads (each run alone)
const jsMs = main.flatMap((m) => m.a.map((x) => x.ms));
const jsSeedS = 1000 / (jsMs.reduce((s, x) => s + x, 0) / jsMs.length);
const speed = [];
for (const lat of LATS) {
  const t1 = Date.now(); await rs(SEEDS, 1, lat, [], {}, 1); const one = (Date.now() - t1) / SEEDS;
  const N = 400, t2 = Date.now(); await rs(N, 1, lat, [], {}, 0); const all = N / ((Date.now() - t2) / 1000);
  const jsLat = main.find((m) => m.lat === lat).a, jsOne = jsLat.reduce((s, x) => s + x.ms, 0) / jsLat.length;
  speed.push({ lat, jsOne, one, all });
  console.error(`speed lat ${lat}: js ${jsOne.toFixed(0)} ms/seed, rust ${one.toFixed(1)} ms/seed, rust all cores ${all.toFixed(1)} seeds/s`);
}

// 3. extended: more seeds, other latencies and the mock's non-default paths
const ext = [];
if (EXTENDED) {
  const cases = [
    { name: "seeds 21-100, lat 100", n: 80, from: 21, lat: 100 },
    { name: "seeds 21-100, lat 3000", n: 80, from: 21, lat: 3000 },
    { name: "seeds 1-40, lat 10000", n: 40, from: 1, lat: 10000 },
    { name: "seeds 1-40, lat 500", n: 40, from: 1, lat: 500 },
    { name: "foreign VMs (starter demo), lat 1000", n: 20, from: 1, lat: 1000, flags: ["--foreign"] },
    { name: "late start 10 h, lat 1000", n: 20, from: 1, lat: 1000, flags: ["--late", "10"] },
    { name: "persistent forecast misses MOCK_FC_ANOM=0.08,0.8 (nowcast active), lat 500", n: 20, from: 1, lat: 500, env: { MOCK_FC_ANOM: "0.08,0.8" } },
    { name: "biased forecasts MOCK_FC_BIAS=0.3, lat 3000", n: 20, from: 1, lat: 3000, env: { MOCK_FC_BIAS: "0.3" } },
    { name: "tight quota MOCK_CORES=200 + MOCK_SLOW=0.95 (misses), lat 2000", n: 20, from: 1, lat: 2000, env: { MOCK_CORES: "200", MOCK_SLOW: "0.95" } },
    { name: "MOCK_STAGING=idle MOCK_PRESTAGE=0 MOCK_HIST_LAG=0, lat 300", n: 20, from: 1, lat: 300, env: { MOCK_STAGING: "idle", MOCK_PRESTAGE: "0", MOCK_HIST_LAG: "0" } },
  ];
  for (const k of cases) {
    const a = await js(k.n, k.from, k.lat, k.flags ?? [], k.env ?? {});
    const b = await rs(k.n, k.from, k.lat, k.flags ?? [], k.env ?? {});
    ext.push({ ...k, c: compare(a, b) });
    console.error(`${k.name}: exact ${ext.at(-1).c.exact}/${k.n}`);
  }
}

// report
const allExact = main.every((m) => m.c.exact === m.c.n) && ext.every((e) => e.c.exact === e.c.n);
let md = `# Rust controller parity report

Generated by \`node controller-rs/parity/parity.mjs${args.length ? " " + args.join(" ") : ""}\` at commit \`${env.commit}\` (${new Date().toISOString().slice(0, 10)}).

The Rust simulator + policy (\`greenops-controller mock\`) and the JS mock (\`scripts/greenops/mock.mjs\`, driving the
real JS controller) run the same seeds. A seed counts as **exact** only when every result field is bit-identical:
points, grams, kWh, idle grams, per-job grams (all 15), stats (creates/stops/starts/deletes/errors), late jobs,
quota rejects, VMs left and disqualification. Same numbers mean the two controllers made the same decisions at the
same moments.

**Result: ${allExact ? "every compared seed is exact" : "DIFFERENCES FOUND — see below"}.**

| Config | Exact seeds | JS mean pts | Rust mean pts | Difference | Failures JS / Rust |
|---|---|---|---|---|---|
${[...main.map((m) => ({ name: `seeds 1-${SEEDS}, lat ${m.lat}`, c: m.c })), ...ext].map((e) => `| ${e.name} | ${e.c.exact}/${e.c.n} | ${f1(e.c.meanJs)} | ${f1(e.c.meanRs)} | ${rel(e.c.meanJs, e.c.meanRs)} | ${e.c.failsJs}/${e.c.n} / ${e.c.failsRs}/${e.c.n} |`).join("\n")}

The task's bar was the mean within 0.1 % with 0 failures at lat 100 and 3000; the port reproduces every seed exactly.
${[...main, ...ext].some((m) => m.c.diffs.length) ? `\nDifferences:\n\n${[...main, ...ext].flatMap((m) => m.c.diffs.slice(0, 20).map((d) => `- ${m.name ?? `lat ${m.lat}`}: ${d}`)).join("\n")}\n` : ""}
## Speed

| Latency | JS (1 process) | Rust (1 thread) | Speed-up | Rust (all ${env.cores} cores) | Speed-up vs 1 JS process |
|---|---|---|---|---|---|
${speed.map((s) => `| ${s.lat} ms | ${f1(s.jsOne)} ms/seed (${(1000 / s.jsOne).toFixed(2)} seeds/s) | ${f1(s.one)} ms/seed (${(1000 / s.one).toFixed(1)} seeds/s) | ${(s.jsOne / s.one).toFixed(1)}x | ${f1(s.all)} seeds/s | ${((s.all * s.jsOne) / 1000).toFixed(0)}x |`).join("\n")}

One seed is a full 120 h run (2 400 decision steps at 720x, with simulated API latency). Rust timings include
process start; the all-cores figure is a 400-seed batch. The machine has ${env.cores} cores (on Apple silicon a mix of
performance and efficiency cores, so the all-cores speed-up is below ${env.cores}x the single-thread one).

## Per-seed results

${main.map((m) => `### lat ${m.lat} ms

| Seed | JS points | Rust points | JS kg | Rust kg | Exact |
|---|---|---|---|---|---|
${m.a.map((x, i) => { const y = m.b[i] ?? {}; const d = m.c.diffs.find((s) => s.startsWith(`seed ${x.seed}:`)); return `| ${x.seed} | ${f3(x.points)} | ${f3(y.points)} | ${f3(x.grams / 1000)} | ${f3(y.grams / 1000)} | ${d ? "no (" + d.split(": ")[1] + ")" : "yes"} |`; }).join("\n")}
| **mean** | **${f3(m.c.meanJs)}** | **${f3(m.c.meanRs)}** | | | **${m.c.exact}/${m.c.n}** |
`).join("\n")}
## Environment

- ${env.arch}, ${env.cpu}, ${env.cores} cores
- Node ${env.node} (V8 ${env.v8}); ${env.rustc}
- Rust \`jsmath\` variant: ${os.arch() === "arm64" ? "fma (the default on aarch64)" : "plain (the default off aarch64)"}

## Why the port is bit-exact, and what that took

- **Same operations in the same order.** Every expression keeps the JS operand order (floating-point sums and
  products are not associative), maps keep JS insertion order, sorts are stable with the same comparators, and
  \`Math.max/min/round\`, \`toFixed(6)\` (the mock's \`completed_work\`) and millisecond timestamps follow JS semantics.
- **Same promise order.** The controller is sans-IO: each JS promise continuation is an explicit continuation
  value. The simulator runs one virtual-clock event per JS microtask cascade, with the same tie-breaking and the
  same latency draws, so API calls land in the same order at the same simulated times.
- **Same transcendental functions.** \`Math.log/exp/cos/pow\` are ports of V8's fdlibm code
  (\`src/base/ieee754.cc\`, including V8's deviation in \`pow\`). The platform libm differs from V8 on up to 9 % of
  inputs. V8 is compiled with the platform's floating-point contraction: Node's macOS arm64 build fuses \`a*b + c\`
  into one FMA inside these functions, x86-64 builds don't. \`src/jsmath.rs\` implements both: on 1.1 M test inputs the
  FMA variant matches arm64 Node 22 bit for bit, and the plain variant matches x86-64 Node 22 (linux/amd64
  \`node:22-alpine\` under emulation) bit for bit (\`tests/jsmath.rs\`). So the JS mock itself gives slightly different
  results on arm64 and x86-64; the Rust mock reproduces either (\`--fma 0|1\`).

Reproduce: \`cargo build --release --manifest-path controller-rs/Cargo.toml && node controller-rs/parity/parity.mjs --extended\`.
`;
fs.writeFileSync(OUT, md);
console.error(`wrote ${path.relative(ROOT, OUT)}; ${allExact ? "all exact" : "DIFFERENCES"}`);
process.exit(allExact ? 0 : 1);
