/** Placement legality — the single implementation shared by the web simulator
 *  (src/lib/sim) and the live controller (scripts/greenops). Pure, no I/O.
 *  Inputs are the normalised shapes below, not raw catalog rows.
 */

/** Residency: the one rule that disqualifies a run. Every create goes through this.
 *  w: { residency: "EU"|"CH"|"ANYWHERE", allowed: string[]|null, forbidden: string[] }
 *  z: { country: string, eu: boolean } */
export function zoneLegal(w, z) {
  if (!w || !z) return false;
  if (w.residency === "EU" && !z.eu) return false;
  if (w.residency === "CH" && z.country !== "CH") return false;
  if (w.residency !== "EU" && w.residency !== "CH" && w.residency !== "ANYWHERE") return false; // unknown rule → refuse
  if (w.allowed && w.allowed.length && !w.allowed.includes(z.country)) return false;
  if (w.forbidden && w.forbidden.includes(z.country)) return false;
  return true;
}

/** Profile fit (not disqualifying — the API rejects it).
 *  w: { kind, unit, profileIds: string[]|null, families: string[]|null, minVram: number }
 *  p: { id, family, unit, vram } */
export function profileLegal(w, p) {
  if (!w || !p || p.unit !== w.unit) return false;
  if (w.profileIds && w.profileIds.length) return w.profileIds.includes(p.id);
  if (w.kind === "cpu") return p.family === "cpu";
  if (p.family === "cpu") return false;
  if (w.families && w.families.length && !w.families.includes(p.family)) return false;
  if (w.minVram && p.vram < w.minVram) return false;
  return true;
}
