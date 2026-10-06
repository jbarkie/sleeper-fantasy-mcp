import type { CompactPlayer, Game, PlayerMap, ProjectionMap } from "./types";

const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

// Shrinks Sleeper's ~15 MB /players/nfl payload to the fields the server needs.
export function compactPlayers(raw: Record<string, any>): PlayerMap {
  const out: PlayerMap = {};
  for (const [id, p] of Object.entries(raw)) {
    const positions: string[] = (p.fantasy_positions ?? [p.position]).filter((x: string) => FANTASY_POSITIONS.has(x));
    if (positions.length === 0) continue;
    const name = p.position === "DEF"
      ? `${p.first_name ?? id} ${p.last_name ?? ""}`.trim()
      : (p.full_name ?? `${p.first_name ?? ""} ${p.last_name ?? ""}`.trim());
    const rec: CompactPlayer = [name, p.position, p.team ?? null, p.injury_status ?? null, positions];
    out[id] = rec;
  }
  return out;
}

// Keeps rows with real projected stats; rows that only carry ADP are not projections.
export function compactProjections(raw: Record<string, any>): ProjectionMap {
  const out: ProjectionMap = {};
  for (const [id, stats] of Object.entries(raw)) {
    if (!stats || typeof stats !== "object") continue;
    const kept: Record<string, number> = {};
    for (const [k, v] of Object.entries(stats)) {
      if (typeof v === "number" && !k.includes("adp")) kept[k] = v;
    }
    if (Object.keys(kept).some((k) => k !== "gp")) out[id] = kept;
  }
  return out;
}

const ESPN_TO_SLEEPER: Record<string, string> = { WSH: "WAS" };
export const espnTeam = (abbr: string) => ESPN_TO_SLEEPER[abbr] ?? abbr;

// Adds ESPN kickoff times to Sleeper's schedule, matched on week + home + away.
export function mergeSchedule(
  sleeper: Array<{ week: number; home: string; away: string; date: string; status: string }>,
  espnByWeek: Record<number, any>,
): { games: Game[]; unmatched: string[]; dropped: string[] } {
  const kickoffs = new Map<string, string>();
  for (const [week, board] of Object.entries(espnByWeek)) {
    for (const ev of board?.events ?? []) {
      const teams = ev.competitions?.[0]?.competitors ?? [];
      const home = teams.find((t: any) => t.homeAway === "home")?.team?.abbreviation;
      const away = teams.find((t: any) => t.homeAway === "away")?.team?.abbreviation;
      if (home && away && ev.date) kickoffs.set(`${week}:${espnTeam(home)}:${espnTeam(away)}`, new Date(ev.date).toISOString());
    }
  }
  const unmatched: string[] = [];
  const dropped: string[] = [];
  const confirmed = new Set<string>();
  for (const g of sleeper) {
    if (kickoffs.has(`${g.week}:${g.home}:${g.away}`)) {
      confirmed.add(`${g.week}:${g.home}`);
      confirmed.add(`${g.week}:${g.away}`);
    }
  }
  const games: Game[] = [];
  for (const g of sleeper) {
    const label = `week ${g.week} ${g.away}@${g.home}`;
    const kickoff = kickoffs.get(`${g.week}:${g.home}:${g.away}`) ?? null;
    if (!kickoff && espnByWeek[g.week]) {
      // ESPN has this week but not this game. If both teams already have an ESPN-confirmed
      // game that week, the Sleeper row is a phantom and is dropped.
      if (confirmed.has(`${g.week}:${g.home}`) && confirmed.has(`${g.week}:${g.away}`)) {
        dropped.push(label);
        continue;
      }
      unmatched.push(label);
    }
    games.push({ week: g.week, home: g.home, away: g.away, date: g.date, status: g.status, kickoff });
  }
  return { games, unmatched, dropped };
}
