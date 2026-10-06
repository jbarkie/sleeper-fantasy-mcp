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
  // Only kicker lines need derivations; skip the copy for everyone else.
  if (stats.fgm === undefined && stats.fga === undefined) return stats;
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
  for (const k in s) {
    const weight = scoring[k];
    if (typeof weight === "number") pts += s[k] * weight;
  }
  return Math.round(pts * 100) / 100;
}

// Scored maps are reused across requests in the same isolate, keyed by projection
// fetch time and league, since the same inputs always give the same result.
const scoredMemo = new Map<string, Map<string, number>>();

export function scoreAll(proj: ProjectionMap, scoring: Record<string, number>, memoKey?: string): Map<string, number> {
  if (memoKey && scoredMemo.has(memoKey)) return scoredMemo.get(memoKey)!;
  const out = new Map<string, number>();
  for (const id in proj) {
    const pts = scoreStats(proj[id], scoring);
    if (pts !== null) out.set(id, pts);
  }
  if (memoKey) {
    if (scoredMemo.size > 20) scoredMemo.clear();
    scoredMemo.set(memoKey, out);
  }
  return out;
}
