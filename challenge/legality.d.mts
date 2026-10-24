export interface LegalityWorkload {
  kind: string;
  unit: string;
  residency: string;
  allowed: readonly string[] | null;
  forbidden: readonly string[];
  profileIds: readonly string[] | null;
  families: readonly string[] | null;
  minVram: number;
}
export interface LegalityZone { country: string; eu: boolean }
export interface LegalityProfile { id: string; family: string; unit: string; vram: number }

export function zoneLegal(w: Pick<LegalityWorkload, "residency" | "allowed" | "forbidden"> | null | undefined, z: LegalityZone | null | undefined): boolean;
export function profileLegal(w: Omit<LegalityWorkload, "residency" | "allowed" | "forbidden"> | null | undefined, p: LegalityProfile | null | undefined): boolean;
