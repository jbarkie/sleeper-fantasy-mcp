import type { DataCache } from "./cache";
import { gameFor, type GameInfo } from "./schedule";
import { normalizeName as normalize } from "./names";
import { scoringHash } from "./scoring";
import type { SleeperClient } from "./sleeper";
import type { Game, NflState, PlayerMap } from "./types";

export interface Config {
  username: string;
  excludedLeagues: Set<string>;
}

export interface Deps {
  sleeper: SleeperClient;
  cache: DataCache;
  config: Config;
  now: () => Date;
}

// Enum values as used by Sleeper league settings. Sleeper does not document these;
// mappings match community clients and were confirmed by the league owner.
export const WAIVER_TYPES: Record<number, string> = { 0: "rolling", 1: "reverse_standings", 2: "faab" };
export const LEAGUE_TYPES: Record<number, string> = { 0: "redraft", 1: "keeper", 2: "dynasty" };

export interface PlayerView {
  id: string;
  name: string;
  pos: string;
  team: string | null;
  injury: string | null;
  proj: number | null;
  opp: string | null;
  kickoff: string | null;
  locked: boolean | "unknown";
  bye: boolean | "unknown";
}

export interface TeamView {
  roster_id: number;
  team_name: string;
  manager: string;
  record: string;
  points_for: number;
  waiver_position: number | null;
  players: string[];
  starters: string[];
  reserve: string[];
  taxi: string[];
}

export interface LeagueData {
  state: NflState;
  week: number;
  league: any;
  teams: Map<number, TeamView>;
  myRosterId: number;
  matchups: any[];
  players: PlayerMap;
  projections: Map<string, number>;
  games: Game[] | null;
  rosteredBy: Map<string, number>;
  as_of: Record<string, string | null>;
  gaps: string[];
  view: (id: string) => PlayerView;
}


export async function myLeagues(deps: Deps) {
  const [state, user] = await Promise.all([deps.sleeper.state(), deps.sleeper.user(deps.config.username)]);
  if (!user) throw new Error(`Sleeper user "${deps.config.username}" not found`);
  const season = (state as any).league_season ?? state.season;
  const all = await deps.sleeper.leagues(user.user_id, season);
  const included = all.filter((l) => !deps.config.excludedLeagues.has(l.league_id));
  return { state, user, season, leagues: included, excluded_count: all.length - included.length };
}

type LeaguesCtx = Awaited<ReturnType<typeof myLeagues>>;

export async function findLeague(deps: Deps, query: string, preloaded?: LeaguesCtx) {
  const ctx = preloaded ?? (await myLeagues(deps));
  const q = normalize(query);
  const exact = ctx.leagues.filter((l) => l.league_id === query || normalize(l.name) === q);
  const matches = exact.length ? exact : ctx.leagues.filter((l) => normalize(l.name).includes(q));
  if (matches.length !== 1) {
    const names = ctx.leagues.map((l) => `${l.name} (${l.league_id})`).join("; ");
    throw new Error(`League "${query}" matched ${matches.length} leagues. Use one of: ${names}`);
  }
  return { ...ctx, leagueSummary: matches[0] };
}

export async function loadLeague(deps: Deps, query: string, preloaded?: LeaguesCtx): Promise<LeagueData> {
  const { state, user, season, leagueSummary } = await findLeague(deps, query, preloaded);
  const id = leagueSummary.league_id;
  const week = state.week;
  const gaps: string[] = [];
  if (state.season_type !== "regular") gaps.push(`NFL season_type is "${state.season_type}"; week ${week} advice may not apply.`);

  // The user's league list already carries full league objects (settings, scoring, slots).
  const league = leagueSummary;
  const [rosters, users, matchups, playersC, pointsC, schedC, meta] = await Promise.all([
    deps.sleeper.rosters(id),
    deps.sleeper.users(id),
    deps.sleeper.matchups(id, week),
    deps.cache.players(),
    deps.cache.points(id, season, week),
    deps.cache.schedule(season),
    deps.cache.meta(),
  ]);

  // Warnings name the weeks they affect; only surface ones for this week (or none named).
  for (const w of meta?.warnings ?? []) {
    const weeks = [...w.matchAll(/week (\d+)/g)].map((m) => Number(m[1]));
    if (weeks.length === 0 || weeks.includes(week)) gaps.push(`Cache warning: ${w}`);
  }
  const STALE_MS = 36 * 3600 * 1000;
  for (const [label, c] of [["players", playersC], ["projections", pointsC], ["schedule", schedC]] as const) {
    if (c && deps.now().getTime() - new Date(c.fetched_at).getTime() > STALE_MS) gaps.push(`${label} cache is stale (fetched ${c.fetched_at}).`);
  }
  if (!playersC) gaps.push("Player lookup cache is empty; names and positions are unavailable.");
  if (!pointsC) gaps.push(`No week ${week} projections cached; projected points are unavailable.`);
  else if (pointsC.data.scoring_hash !== scoringHash(league.scoring_settings ?? {})) {
    gaps.push("League scoring settings changed since projections were scored; projected points may be off until the next cache refresh.");
  }
  if (!schedC) gaps.push("No schedule cached; opponents, kickoffs, locks and byes are unknown.");

  const players = playersC?.data ?? {};
  const projections = new Map<string, number>(pointsC ? Object.entries(pointsC.data.points) : []);
  const games = schedC?.data ?? null;
  if (games && games.some((g) => g.week === week && !g.kickoff)) {
    gaps.push(`Some week ${week} games have no kickoff time; players in those games show locked: "unknown".`);
  }

  const userById = new Map(users.map((u: any) => [u.user_id, u]));
  const teams = new Map<number, TeamView>();
  const rosteredBy = new Map<string, number>();
  let myRosterId = -1;
  for (const r of rosters) {
    const u: any = userById.get(r.owner_id);
    const s = r.settings ?? {};
    teams.set(r.roster_id, {
      roster_id: r.roster_id,
      team_name: u?.metadata?.team_name || u?.display_name || `Team ${r.roster_id}`,
      manager: u?.display_name ?? "unowned",
      record: `${s.wins ?? 0}-${s.losses ?? 0}${s.ties ? `-${s.ties}` : ""}`,
      points_for: (s.fpts ?? 0) + (s.fpts_decimal ?? 0) / 100,
      waiver_position: s.waiver_position ?? null,
      players: r.players ?? [],
      starters: r.starters ?? [],
      reserve: r.reserve ?? [],
      taxi: r.taxi ?? [],
    });
    for (const p of [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]) rosteredBy.set(p, r.roster_id);
    if (r.owner_id === user.user_id || (r.co_owners ?? []).includes(user.user_id)) myRosterId = r.roster_id;
  }
  if (myRosterId < 0) throw new Error(`${deps.config.username} does not own a roster in ${league.name}`);

  const now = deps.now();
  const view = (pid: string): PlayerView => {
    const p = players[pid];
    const g: GameInfo = gameFor(p?.[2] ?? null, week, games, now);
    return {
      id: pid,
      name: p?.[0] ?? `unknown player ${pid}`,
      pos: p?.[1] ?? "?",
      team: p?.[2] ?? null,
      injury: p?.[3] ?? null,
      proj: projections.get(pid) ?? null,
      opp: g.opponent,
      kickoff: g.kickoff,
      locked: g.locked,
      bye: g.bye,
    };
  };

  return {
    state, week, league, teams, myRosterId, matchups, players, projections, games, rosteredBy, gaps, view,
    as_of: {
      sleeper_live: now.toISOString(),
      players: playersC?.fetched_at ?? null,
      projections: pointsC?.fetched_at ?? null,
      schedule: schedC?.fetched_at ?? null,
      cache_last_run: meta?.last_run ?? null,
    },
  };
}

// Normalized names are built once per player map and reused across requests.
const nameIndex = new WeakMap<PlayerMap, Array<{ id: string; name: string; words: string[] }>>();
function namesFor(players: PlayerMap) {
  let idx = nameIndex.get(players);
  if (!idx) {
    idx = Object.entries(players).map(([id, p]) => {
      const name = p[5] ?? normalize(p[0]);
      return { id, name, words: name.split(" ") };
    });
    nameIndex.set(players, idx);
  }
  return idx;
}

// Name lookup that never guesses: returns every candidate when a name is ambiguous.
export function resolvePlayer(players: PlayerMap, query: string, prefer?: Set<string>) {
  const q = normalize(query);
  if (players[query]) return { status: "ok" as const, id: query };
  const idx = namesFor(players);
  let hits: Array<[string, PlayerMap[string]]> = idx.filter((x) => x.name === q).map((x) => [x.id, players[x.id]]);
  if (hits.length === 0) {
    const tokens = q.split(" ").filter(Boolean);
    hits = idx
      .filter((x) => tokens.every((t) => x.words.some((w) => w.startsWith(t))))
      .map((x) => [x.id, players[x.id]]);
  }
  // Ties between same-named players: prefer anyone already rostered in the league, then anyone on an NFL team.
  if (hits.length > 1 && prefer) {
    const preferred = hits.filter(([id]) => prefer.has(id));
    if (preferred.length === 1) hits = preferred;
  }
  if (hits.length > 1) {
    const onTeam = hits.filter(([, p]) => p[2]);
    if (onTeam.length === 1) hits = onTeam;
  }
  if (hits.length === 1) return { status: "ok" as const, id: hits[0][0] };
  if (hits.length === 0) return { status: "not_found" as const, query };
  return {
    status: "ambiguous" as const,
    query,
    candidates: hits
      .sort(([a, pa], [b, pb]) => Number(prefer?.has(b) ?? 0) - Number(prefer?.has(a) ?? 0) || Number(!!pb[2]) - Number(!!pa[2]))
      .slice(0, 10)
      .map(([id, p]) => ({ id, name: p[0], pos: p[1], team: p[2] })),
  };
}

export function leagueRules(league: any) {
  const s = league.settings ?? {};
  return {
    format: LEAGUE_TYPES[s.type] ?? `unknown (${s.type})`,
    waivers: WAIVER_TYPES[s.waiver_type] ?? `unknown (${s.waiver_type})`,
    waiver_day_of_week: s.waiver_day_of_week,
    roster_positions: league.roster_positions,
    reserve_slots: s.reserve_slots ?? 0,
    reserve_allows: Object.entries(s).filter(([k, v]) => k.startsWith("reserve_allow_") && v === 1).map(([k]) => k.replace("reserve_allow_", "")),
    trade_deadline_week: s.trade_deadline,
    draft_pick_trading: s.pick_trading === 1,
    playoffs: { start_week: s.playoff_week_start, teams: s.playoff_teams },
    reception_points: league.scoring_settings?.rec,
  };
}
