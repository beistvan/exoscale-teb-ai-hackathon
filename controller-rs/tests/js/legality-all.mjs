// Ground truth for tests/legality.rs, computed by the JS controller's own code:
//  - every (workload, zone, profile) of challenge/catalog.json, as loadCatalog() normalises them:
//    zoneLegal, profileLegal, and whether the profile is offered in the zone;
//  - candidates() for every workload (the placements the policy may choose from);
//  - zoneLegal / profileLegal on random synthetic cases read from stdin (one JSON array).
import { loadCatalog, candidates } from "../../../scripts/greenops/model.mjs";
import { zoneLegal, profileLegal } from "../../../challenge/legality.mjs";

const cat = loadCatalog();
const combos = [];
for (const w of cat.workloads.values()) for (const z of cat.zones.values()) for (const p of cat.profiles.values())
  combos.push([w.id, z.slug, p.id, zoneLegal(w, z), profileLegal(w, p), p.zones.has(z.slug)]);
const cands = {};
for (const w of cat.workloads.values()) cands[w.id] = candidates(cat, w).map((c) => `${c.zone.slug}|${c.prof.id}|${c.k}`);
let input = "";
for await (const chunk of process.stdin) input += chunk;
const random = (input.trim() ? JSON.parse(input) : []).map(({ w, z, p }) => [zoneLegal(w, z), profileLegal(w, p)]);
process.stdout.write(JSON.stringify({ combos, cands, random }));
