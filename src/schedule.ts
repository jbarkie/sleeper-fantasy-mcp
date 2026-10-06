import type { Game } from "./types";

export interface GameInfo {
  opponent: string | null;
  home: boolean | null;
  kickoff: string | null;
  // locked: game has kicked off. "unknown" when no kickoff time is available.
  locked: boolean | "unknown";
  bye: boolean | "unknown";
}

export function gameFor(team: string | null, week: number, games: Game[] | null, now: Date): GameInfo {
  const unknown: GameInfo = { opponent: null, home: null, kickoff: null, locked: "unknown", bye: "unknown" };
  if (!team || !games) return unknown;
  const weekGames = games.filter((g) => g.week === week);
  // Prefer a game with a confirmed kickoff if a team somehow appears twice.
  const mine = weekGames.filter((x) => x.home === team || x.away === team);
  const g = mine.find((x) => x.kickoff) ?? mine[0];
  if (!g) {
    // Only call it a bye when the week's slate looks complete (a full week has 13-16 games).
    return { ...unknown, bye: weekGames.length >= 13 ? true : "unknown", locked: false };
  }
  const home = g.home === team;
  const done = g.status === "complete" || g.status === "in_progress";
  const locked = g.kickoff ? new Date(g.kickoff) <= now : done ? true : "unknown";
  return { opponent: home ? g.away : g.home, home, kickoff: g.kickoff, locked, bye: false };
}
