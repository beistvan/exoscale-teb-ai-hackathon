// Test vectors for src/jsmath.rs: inputs and Node's Math results as raw IEEE bits (hex), one per line:
//   <fn> <x bits> [<y bits>] <result bits>
// Inputs follow the distributions the mock and controller use, plus wide random ranges.
const N = Number(process.argv[2] ?? 200000);
const f64 = new Float64Array(1), u64 = new BigUint64Array(f64.buffer);
const hex = (x) => { f64[0] = x; return u64[0].toString(16).padStart(16, "0"); };
let s = 12345;
const r = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
const out = [];
const put = (fn, ...xs) => {
  const v = fn === "log" ? Math.log(xs[0]) : fn === "exp" ? Math.exp(xs[0]) : fn === "cos" ? Math.cos(xs[0]) : Math.pow(xs[0], xs[1]);
  out.push(`${fn} ${xs.map(hex).join(" ")} ${hex(v)}`);
};
const gauss = () => Math.sqrt(-2 * Math.log(r() + 1e-12)) * Math.cos(2 * Math.PI * r());
for (let i = 0; i < N; i++) {
  put("log", r() + 1e-12);
  put("log", r() * 1e6 + 1e-300);
  put("log", 1 + (r() - 0.5) * 1e-5);
  put("cos", 2 * Math.PI * r());
  put("cos", (2 * Math.PI * (Math.floor(r() * 160) - (r() * 31 - 4))) / 24);
  put("cos", (r() - 0.5) * 2e5);
  put("exp", 0.6 * gauss());
  put("exp", (r() - 0.5) * 1400);
  put("pow", r(), Math.floor(r() * 60));
  put("pow", 0.3 + 0.65 * r(), Math.floor(r() * 40));
  put("pow", r() * 10, (r() - 0.5) * 20);
}
for (const sync of [0, 0.05, 0.06, 0.08, 0.5, 0.97, 1]) for (let k = 1; k <= 20; k++) put("pow", Math.max(0.05, 1 - sync), k - 1);
process.stdout.write(out.join("\n") + "\n");
