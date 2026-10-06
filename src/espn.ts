// ESPN Fantasy Football (unofficial, undocumented API). Private leagues are read with
// the owner's espn_s2 + SWID session cookies; this module only ever issues GETs.
import type { DataCache } from "./cache";
import { optimizeLineup, type LineupPlayer } from "./lineup";
import { resolvePlayer } from "./league";
import { gameFor } from "./schedule";
import type { Game } from "./types";

const BASE = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons";

// ESPN proTeamId -> Sleeper team abbreviation (ESPN's own abbrevs, with WSH -> WAS).
export const PRO_TEAMS: Record<number, string> = {
  1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU",
};
const POSITIONS: Record<number, string> = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };
// ESPN lineup slot ids -> the lineup solver's slot names. 20 = bench, 21 = IR.
const SLOTS: Record<number, string> = {
  0: "QB", 2: "RB", 4: "WR", 6: "TE", 16: "DEF", 17: "K", 23: "FLEX", 3: "WRRB_FLEX", 5: "REC_FLEX", 7: "SUPER_FLEX",
  20: "BN", 21: "IR",
};
const UNAVAILABLE = new Set(["OUT", "INJURY_RESERVE", "SUSPENSION"]);
const SOURCE = "ESPN Fantasy API (UNOFFICIAL, undocumented), read with the owner's session; projections are ESPN's, scored with this league's settings";

export interface EspnConfig {
  s2: string;
  swid: string;
  leagues: string[]; // league ids
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

export class EspnClient {
  // Season is set per request from the cache job's metadata (falls back to the calendar year).
  season = String(new Date().getUTCFullYear());

  constructor(private cfg: EspnConfig, private fetcher: Fetcher = (u, i) => fetch(u, i)) {}

  async league(leagueId: string, views: string[], extra: Record<string, string | number> = {}, filter?: unknown): Promise<any> {
    const qs = new URLSearchParams();
    for (const v of views) qs.append("view", v);
    for (const [k, v] of Object.entries(extra)) qs.set(k, String(v));
    const headers: Record<string, string> = { Cookie: `espn_s2=${this.cfg.s2}; SWID=${this.cfg.swid}`, Accept: "application/json" };
    if (filter) headers["x-fantasy-filter"] = JSON.stringify(filter);
    const res = await this.fetcher(`${BASE}/${this.season}/segments/0/leagues/${leagueId}?${qs}`, { headers });
    if (res.status === 401) throw new Error("ESPN rejected the session cookies (expired or logged out). Refresh ESPN_S2 and ESPN_SWID.");
    if (!res.ok) throw new Error(`ESPN league ${leagueId} returned HTTP ${res.status}`);
    return res.json();
  }
}

export interface EspnDeps {
  espn: EspnClient;
  cfg: EspnConfig;
  cache: DataCache;
  now: () => Date;
}

// Shared trimming filters; ESPN otherwise returns full ranking/stat history per player.
const trimFilter = (season: string, period: number) => ({
  filterRanksForScoringPeriodIds: { value: [period] },
  filterRanksForRankTypes: { value: ["PPR"] },
  filterStatsForSourceIds: { value: [1] },
  // "10<season>" = season projection, "11<season><period>" = this week's projection.
  filterStatsForTopScoringPeriodIds: { value: 2, additionalValue: [`10${season}`, `11${season}${period}`] },
});

function viewPlayer(p: any, period: number, games: Game[] | null, now: Date) {
  const team = PRO_TEAMS[p.proTeamId] ?? null;
  const proj = (p.stats ?? []).find((s: any) => s.statSourceId === 1 && s.statSplitTypeId === 1 && s.scoringPeriodId === period);
  const season = (p.stats ?? []).find((s: any) => s.statSourceId === 1 && s.statSplitTypeId === 0);
  const g = gameFor(team, period, games, now);
  return {
    id: String(p.id),
    name: p.fullName,
    pos: POSITIONS[p.defaultPositionId] ?? "?",
    team,
    injury: p.injuryStatus && p.injuryStatus !== "ACTIVE" ? p.injuryStatus : null,
    proj: proj ? Math.round(proj.appliedTotal * 100) / 100 : null,
    season_proj: season ? Math.round(season.appliedTotal * 10) / 10 : null,
    pct_owned: p.ownership?.percentOwned !== undefined ? Math.round(p.ownership.percentOwned * 10) / 10 : undefined,
    opp: g.opponent,
    kickoff: g.kickoff,
    locked: g.locked,
    bye: g.bye,
    eligible: (p.eligibleSlots ?? []).map((s: number) => SLOTS[s]).filter((s: string | undefined) => s && s !== "BN" && s !== "IR"),
  };
}
type EspnPlayerView = ReturnType<typeof viewPlayer>;

async function context(deps: EspnDeps, league: string) {
  const leagueId = resolveLeague(deps.cfg, league);
  const meta = await deps.cache.meta();
  if (meta?.season) deps.espn.season = meta.season;
  const base = await deps.espn.league(leagueId, ["mSettings", "mTeam", "mStatus"]);
  const period: number = base.status.latestScoringPeriod;
  const myTeam = base.teams.find((t: any) => (t.owners ?? []).includes(deps.cfg.swid));
  if (!myTeam) throw new Error(`The ESPN session's user does not own a team in league ${leagueId}`);
  const schedC = await deps.cache.schedule(deps.espn.season);
  const games = schedC?.data ?? null;
  const gaps: string[] = [];
  if (!games) gaps.push("No NFL schedule cached; kickoffs, locks and byes are unknown.");
  return { leagueId, base, period, myTeam, games, gaps, as_of: { espn_live: deps.now().toISOString(), schedule: schedC?.fetched_at ?? null, cache_last_run: meta?.last_run ?? null } };
}

function resolveLeague(cfg: EspnConfig, query: string) {
  if (cfg.leagues.includes(query)) return query;
  if (cfg.leagues.length === 1) return cfg.leagues[0];
  throw new Error(`Use an ESPN league id: ${cfg.leagues.join(", ")}`);
}

function teamName(t: any) {
  return (t.name ?? `${t.location ?? ""} ${t.nickname ?? ""}`).trim();
}

async function rosterFor(deps: EspnDeps, leagueId: string, teamId: number, period: number) {
  const data = await deps.espn.league(leagueId, ["mRoster"], { forTeamId: teamId, scoringPeriodId: period });
  return data.teams.find((t: any) => t.id === teamId)?.roster?.entries ?? [];
}

function rosterView(entries: any[], period: number, games: Game[] | null, now: Date) {
  return entries.map((e) => ({ slot: SLOTS[e.lineupSlotId] ?? `slot ${e.lineupSlotId}`, ...viewPlayer(e.playerPoolEntry.player, period, games, now) }));
}

export async function espnLeagueContext(deps: EspnDeps, league: string) {
  const c = await context(deps, league);
  const now = deps.now();
  const [entries, scores, pending, index] = await Promise.all([
    rosterFor(deps, c.leagueId, c.myTeam.id, c.period),
    deps.espn.league(c.leagueId, ["mMatchupScore"], { scoringPeriodId: c.period }),
    deps.espn.league(c.leagueId, ["mPendingTransactions"]),
    deps.cache.espnPlayers(),
  ]);
  const roster = rosterView(entries, c.period, c.games, now);
  const byTeam = new Map(c.base.teams.map((t: any) => [t.id, t]));
  const matchupPeriod: number = c.base.status.currentMatchupPeriod;
  const m = scores.schedule.find((g: any) => g.matchupPeriodId === matchupPeriod && (g.home?.teamId === c.myTeam.id || g.away?.teamId === c.myTeam.id));
  const meSide = m && (m.home.teamId === c.myTeam.id ? m.home : m.away);
  const oppSide = m && (m.home.teamId === c.myTeam.id ? m.away : m.home);
  const names = new Map(roster.map((p) => [p.id, p.name]));
  const nameOf = (id: number) => names.get(String(id)) ?? index?.data[String(id)]?.[0] ?? `ESPN player ${id}`;
  const s = c.base.settings;
  return {
    platform: "espn",
    league: s.name,
    league_id: c.leagueId,
    week: c.period,
    rules: {
      teams: s.size,
      roster_slots: Object.entries(s.rosterSettings.lineupSlotCounts).filter(([, n]) => (n as number) > 0).map(([id, n]) => `${SLOTS[Number(id)] ?? id}×${n}`),
      waivers: s.acquisitionSettings.isUsingAcquisitionBudget ? "faab" : "rolling_or_traditional",
      acquisition_type: s.acquisitionSettings.acquisitionType,
      reception_points: s.scoringSettings.scoringItems.find((i: any) => i.statId === 53)?.points ?? 0,
      trade_deadline: s.tradeSettings.deadlineDate ? new Date(s.tradeSettings.deadlineDate).toISOString() : null,
      playoff_teams: s.scheduleSettings.playoffTeamCount,
    },
    my_team: {
      team_id: c.myTeam.id,
      team_name: teamName(c.myTeam),
      record: `${c.myTeam.record?.overall?.wins ?? 0}-${c.myTeam.record?.overall?.losses ?? 0}`,
      waiver_rank: c.myTeam.waiverRank,
      roster,
    },
    matchup: m ? {
      opponent: teamName(byTeam.get(oppSide?.teamId)),
      opponent_team_id: oppSide?.teamId,
      my_points: meSide?.totalPointsLive ?? meSide?.totalPoints,
      opponent_points: oppSide?.totalPointsLive ?? oppSide?.totalPoints,
    } : null,
    standings: [...c.base.teams]
      .sort((a: any, b: any) => (a.playoffSeed ?? 99) - (b.playoffSeed ?? 99))
      .map((t: any) => ({ seed: t.playoffSeed, team: teamName(t), record: `${t.record?.overall?.wins ?? 0}-${t.record?.overall?.losses ?? 0}`, points_for: Math.round((t.record?.overall?.pointsFor ?? 0) * 100) / 100 })),
    my_pending_transactions: (pending.pendingTransactions ?? [])
      .filter((t: any) => t.teamId === c.myTeam.id || (t.items ?? []).some((i: any) => i.toTeamId === c.myTeam.id || i.fromTeamId === c.myTeam.id))
      .map((t: any) => ({
        type: t.type,
        status: t.status,
        items: (t.items ?? []).map((i: any) => ({ type: i.type, player: nameOf(i.playerId), from_team: i.fromTeamId, to_team: i.toTeamId })),
      })),
    as_of: c.as_of,
    sources: { espn: SOURCE },
    data_gaps: c.gaps,
  };
}

export async function espnOptimizeLineup(deps: EspnDeps, league: string, exclude: string[] = []) {
  const c = await context(deps, league);
  const now = deps.now();
  const entries = await rosterFor(deps, c.leagueId, c.myTeam.id, c.period);
  const roster: EspnPlayerView[] = entries.map((e: any) => viewPlayer(e.playerPoolEntry.player, c.period, c.games, now));
  const excluded = new Set(exclude.map((x) => x.toLowerCase()));
  // Slots in roster order; ESPN gives counts, so expand them.
  const slotCounts: Record<string, number> = c.base.settings.rosterSettings.lineupSlotCounts;
  const starterSlots = Object.entries(slotCounts).flatMap(([id, n]) => {
    const name = SLOTS[Number(id)];
    return name && name !== "BN" && name !== "IR" ? Array(n).fill(name) : [];
  });
  const current = entries.filter((e: any) => SLOTS[e.lineupSlotId] && !["BN", "IR"].includes(SLOTS[e.lineupSlotId]));
  // Align current starters to starterSlots order for the solver.
  const pool = [...current];
  const currentIds = starterSlots.map((slot) => {
    const i = pool.findIndex((e: any) => SLOTS[e.lineupSlotId] === slot);
    return i >= 0 ? String(pool.splice(i, 1)[0].playerId) : "0";
  });
  const irIds = new Set(entries.filter((e: any) => e.lineupSlotId === 21).map((e: any) => String(e.playerId)));
  const players: LineupPlayer[] = roster
    .filter((p) => !irIds.has(p.id) && !excluded.has(p.name.toLowerCase()))
    .map((p) => ({
      id: p.id,
      positions: [p.pos],
      points: p.proj,
      locked: p.locked,
      unavailable: p.bye === true ? "bye" : p.injury && UNAVAILABLE.has(p.injury) ? p.injury : undefined,
    }));
  const res = optimizeLineup(starterSlots, players, currentIds);
  const byId = new Map(roster.map((p) => [p.id, p]));
  const before = new Set(currentIds.filter((id) => id !== "0"));
  const after = new Set(res.slots.map((s) => s.id).filter((id): id is string => !!id));
  const current_projected = Math.round([...before].reduce((a, id) => a + (byId.get(id)?.proj ?? 0), 0) * 100) / 100;
  return {
    platform: "espn",
    league_id: c.leagueId,
    week: c.period,
    current_projected,
    optimal_projected: res.total,
    gain: Math.round((res.total - current_projected) * 100) / 100,
    changes: {
      start: [...after].filter((id) => !before.has(id)).map((id) => byId.get(id)),
      bench: [...before].filter((id) => !after.has(id)).map((id) => byId.get(id)),
    },
    optimal: res.slots.map((s) => ({ slot: s.slot, fixed: s.fixed, ...(s.id ? byId.get(s.id) : { empty: true }) })),
    flagged_players: roster.filter((p) => p.injury || p.bye === true || p.locked === "unknown"),
    as_of: c.as_of,
    sources: { espn: SOURCE },
    data_gaps: c.gaps,
    note: "Locked or lock-unknown players stay where they are. OUT/IR/suspended and bye-week players are never started. Questionable players are flagged; check same-day news. Make the moves in the ESPN app.",
  };
}

export async function espnFreeAgents(deps: EspnDeps, league: string, position?: string, limit = 15) {
  const c = await context(deps, league);
  const now = deps.now();
  const slotIds = position ? Object.entries(SLOTS).filter(([, v]) => v === position).map(([k]) => Number(k)) : [0, 2, 4, 6, 16, 17, 23];
  const data = await deps.espn.league(c.leagueId, ["kona_player_info"], { scoringPeriodId: c.period }, {
    players: {
      filterStatus: { value: ["FREEAGENT", "WAIVERS"] },
      filterSlotIds: { value: slotIds },
      sortPercOwned: { sortPriority: 1, sortAsc: false },
      limit: Math.min(limit * 3, 100),
      ...trimFilter(deps.espn.season, c.period),
    },
  });
  // ESPN sorts by ownership; re-rank this week's options by league-scored projection.
  const players = (data.players ?? [])
    .map((e: any) => ({ ...viewPlayer(e.player, c.period, c.games, now), status: e.status }))
    .sort((a: any, b: any) => (b.proj ?? -1) - (a.proj ?? -1))
    .slice(0, Math.min(limit, 50));
  return {
    platform: "espn",
    league_id: c.leagueId,
    week: c.period,
    waiver_rank: c.myTeam.waiverRank,
    available: players,
    as_of: c.as_of,
    sources: { espn: SOURCE },
    data_gaps: c.gaps,
    note: "Pool is the most-owned available players, re-ranked by this week's projection. `season_proj` is ESPN's full-season projection. status WAIVERS = claim needed.",
  };
}

export async function espnCheckAvailability(deps: EspnDeps, league: string, names: string[]) {
  const c = await context(deps, league);
  const now = deps.now();
  const index = await deps.cache.espnPlayers();
  if (!index) throw new Error("ESPN player index is not cached yet; run the cache refresh.");
  const byTeam = new Map(c.base.teams.map((t: any) => [t.id, teamName(t)]));
  // ESPN's name filter rejects requests, so names resolve against the cached public
  // player list and status comes from an id-filtered league query.
  const resolved = names.map((n) => ({ query: n, r: resolvePlayer(index.data, n) }));
  const ids = resolved.flatMap((x) => (x.r.status === "ok" ? [Number(x.r.id)] : []));
  const data = ids.length
    ? await deps.espn.league(c.leagueId, ["kona_player_info"], { scoringPeriodId: c.period }, {
        players: { filterIds: { value: ids }, ...trimFilter(deps.espn.season, c.period) },
      })
    : { players: [] };
  const byId = new Map((data.players ?? []).map((h: any) => [String(h.id), h]));
  const results = resolved.map(({ query, r }) => {
    if (r.status !== "ok") return r; // not_found or ambiguous, both carry the query
    const h: any = byId.get(r.id);
    if (!h) return { query, status: "not_in_league_pool", id: r.id };
    return {
      query,
      status: "ok",
      player: viewPlayer(h.player, c.period, c.games, now),
      available: h.onTeamId === 0,
      on_waivers: h.status === "WAIVERS",
      rostered_by: h.onTeamId === 0 ? null : h.onTeamId === c.myTeam.id ? "me" : byTeam.get(h.onTeamId),
    };
  });
  return {
    platform: "espn", league_id: c.leagueId, results,
    as_of: { ...c.as_of, espn_player_index: index.fetched_at }, sources: { espn: SOURCE }, data_gaps: c.gaps,
  };
}

export async function espnGetTeam(deps: EspnDeps, league: string, team: string) {
  const c = await context(deps, league);
  const q = team.toLowerCase();
  const hit = c.base.teams.filter((t: any) => String(t.id) === q || teamName(t).toLowerCase().includes(q) || (t.abbrev ?? "").toLowerCase() === q);
  if (hit.length !== 1) throw new Error(`Team "${team}" not found or ambiguous. Teams: ${c.base.teams.map((t: any) => `${teamName(t)} (${t.id})`).join("; ")}`);
  const entries = await rosterFor(deps, c.leagueId, hit[0].id, c.period);
  return {
    platform: "espn",
    league_id: c.leagueId,
    week: c.period,
    team: { team_id: hit[0].id, team_name: teamName(hit[0]), record: `${hit[0].record?.overall?.wins ?? 0}-${hit[0].record?.overall?.losses ?? 0}`, roster: rosterView(entries, c.period, c.games, deps.now()) },
    as_of: c.as_of,
    sources: { espn: SOURCE },
    data_gaps: c.gaps,
  };
}
