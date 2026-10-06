// Slot eligibility. Slots are filled from most to least restrictive; for nested
// eligibility sets like these (RB ⊂ FLEX ⊂ SUPER_FLEX) greedy filling is optimal.
export const SLOT_ELIGIBLE: Record<string, string[]> = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"],
  WRRB_FLEX: ["RB", "WR"],
  REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

export interface LineupPlayer {
  id: string;
  positions: string[];
  points: number | null; // null = no projection
  locked: boolean | "unknown";
  unavailable?: string; // e.g. "Out", "bye"
}

export interface LineupResult {
  slots: Array<{ slot: string; id: string | null; points: number; fixed: boolean }>;
  total: number;
  unsupported_slots: string[];
}

// currentStarters is aligned with starterSlots (Sleeper's `starters` array, "0" = empty).
export function optimizeLineup(starterSlots: string[], players: LineupPlayer[], currentStarters: string[]): LineupResult {
  const byId = new Map(players.map((p) => [p.id, p]));
  const used = new Set<string>();
  const result: LineupResult["slots"] = starterSlots.map((slot) => ({ slot, id: null, points: 0, fixed: false }));
  const unsupported = starterSlots.filter((s) => !SLOT_ELIGIBLE[s]);

  // A player whose game has started (or might have) cannot be moved: keep locked starters
  // in place, and never move a locked bench player in.
  const isLocked = (p: LineupPlayer | undefined) => p !== undefined && p.locked !== false;
  starterSlots.forEach((slot, i) => {
    const p = byId.get(currentStarters[i]);
    if (isLocked(p) || !SLOT_ELIGIBLE[slot]) {
      result[i] = { slot, id: currentStarters[i] && currentStarters[i] !== "0" ? currentStarters[i] : null, points: p?.points ?? 0, fixed: true };
      if (p) used.add(p.id);
    }
  });
  for (const p of players) if (isLocked(p)) used.add(p.id);

  const order = starterSlots
    .map((slot, i) => ({ slot, i }))
    .filter(({ i }) => !result[i].fixed)
    .sort((a, b) => SLOT_ELIGIBLE[a.slot].length - SLOT_ELIGIBLE[b.slot].length);

  for (const { slot, i } of order) {
    const best = players
      .filter((p) => !used.has(p.id) && !p.unavailable && p.positions.some((x) => SLOT_ELIGIBLE[slot].includes(x)))
      .sort((a, b) => (b.points ?? -1) - (a.points ?? -1))[0];
    if (best) {
      used.add(best.id);
      result[i] = { slot, id: best.id, points: best.points ?? 0, fixed: false };
    }
  }
  const total = Math.round(result.reduce((a, s) => a + s.points, 0) * 100) / 100;
  return { slots: result, total, unsupported_slots: [...new Set(unsupported)] };
}
