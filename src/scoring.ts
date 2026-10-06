import type { ProjectionMap } from "./types";

// Projection feeds bucket some stats differently than league scoring keys. Each
// derivation fills a scoring key only when the projection lacks it.
const DERIVED: Array<[string, (s: Record<string, number>) => number | undefined]> = [
  // Projections give one 50+ bucket; scoring splits 50-59 and 60+. 60+ makes are rare,
  // so all 50+ makes are scored as 50-59.
  ["fgm_50_59", (s) => (s.fgm_60p === undefined ? s.fgm_50p : undefined)],
  ["fgmiss", (s) => {
    const parts = Object.entries(s).filter(([k]) => k.startsWith("fgmiss_"));
    return parts.length ? parts.reduce((a, [, v]) => a + v, 0) : undefined;
  }],
];

export function withDerived(stats: Record<string, number>): Record<string, number> {
  const out = { ...stats };
  for (const [key, fn] of DERIVED) {
    if (out[key] === undefined) {
      const v = fn(stats);
      if (v !== undefined) out[key] = v;
    }
  }
  return out;
}

// Applies a league's scoring_settings to a projected stat line.
export function scoreStats(stats: Record<string, number> | undefined, scoring: Record<string, number>): number | null {
  if (!stats) return null;
  const s = withDerived(stats);
  let pts = 0;
  for (const [k, weight] of Object.entries(scoring)) {
    const v = s[k];
    if (typeof v === "number" && typeof weight === "number") pts += v * weight;
  }
  return Math.round(pts * 100) / 100;
}

export function scoreAll(proj: ProjectionMap, scoring: Record<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, stats] of Object.entries(proj)) {
    const pts = scoreStats(stats, scoring);
    if (pts !== null) out.set(id, pts);
  }
  return out;
}
