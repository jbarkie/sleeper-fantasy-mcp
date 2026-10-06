import { optimizeLineup, type LineupPlayer } from "./lineup";
import { leagueRules, loadLeague, myLeagues, resolvePlayer, type Deps, type LeagueData, type TeamView } from "./league";

const SOURCES = {
  sleeper_live: "Sleeper API (documented), fetched live",
  players: "Sleeper /players/nfl (documented), compacted daily; injury tags may lag same-day news",
  projections: "Sleeper projections (UNOFFICIAL, undocumented endpoint), scored with this league's settings",
  schedule: "Sleeper schedule (UNOFFICIAL) + ESPN scoreboard kickoff times (UNOFFICIAL)",
};

const UNAVAILABLE = new Set(["Out", "IR", "Sus", "PUP", "NA", "DNR", "COV"]);
const round = (n: number) => Math.round(n * 100) / 100;

function envelope(d: LeagueData, body: Record<string, unknown>) {
  return {
    league: d.league.name,
    league_id: d.league.league_id,
    week: d.week,
    ...body,
    as_of: d.as_of,
    sources: SOURCES,
    data_gaps: d.gaps,
  };
}

function lineupPlayers(d: LeagueData, ids: string[]): LineupPlayer[] {
  return ids.map((id) => {
    const v = d.view(id);
    const p = d.players[id];
    const unavailable = v.bye === true ? "bye" : v.injury && UNAVAILABLE.has(v.injury) ? v.injury : undefined;
    return { id, positions: p?.[4] ?? [v.pos], points: v.proj, locked: v.locked, unavailable };
  });
}

function activeIds(t: TeamView) {
  const benchOut = new Set([...t.reserve, ...t.taxi]);
  return t.players.filter((p) => !benchOut.has(p));
}

function teamDetail(d: LeagueData, t: TeamView) {
  const starters = new Set(t.starters);
  const reserve = new Set(t.reserve);
  const taxi = new Set(t.taxi);
  const slots = d.league.roster_positions.filter((s: string) => s !== "BN");
  return {
    roster_id: t.roster_id,
    team_name: t.team_name,
    manager: t.manager,
    record: t.record,
    points_for: t.points_for,
    waiver_position: t.waiver_position,
    starters: t.starters.map((id, i) => ({ slot: slots[i], ...(id === "0" ? { empty: true } : d.view(id)) })),
    bench: t.players.filter((id) => !starters.has(id) && !reserve.has(id) && !taxi.has(id)).map(d.view),
    reserve: t.reserve.map(d.view),
    taxi: t.taxi.map(d.view),
  };
}

function findTeam(d: LeagueData, query: string): TeamView {
  const q = query.toLowerCase().trim();
  const all = [...d.teams.values()];
  const hit =
    all.filter((t) => String(t.roster_id) === q || t.team_name.toLowerCase() === q || t.manager.toLowerCase() === q)[0] ??
    (() => {
      const partial = all.filter((t) => t.team_name.toLowerCase().includes(q) || t.manager.toLowerCase().includes(q));
      return partial.length === 1 ? partial[0] : undefined;
    })();
  if (!hit) throw new Error(`Team "${query}" not found or ambiguous. Teams: ${all.map((t) => `${t.team_name} (${t.manager})`).join("; ")}`);
  return hit;
}

function lineupWithChanges(d: LeagueData, t: TeamView, ids: string[], starters: string[]) {
  const slots = d.league.roster_positions.filter((s: string) => s !== "BN");
  const res = optimizeLineup(slots, lineupPlayers(d, ids), starters);
  const current = starters.reduce((a, id) => a + (d.projections.get(id) ?? 0), 0);
  return { res, current: round(current) };
}

export async function getMyLeagues(deps: Deps) {
  const { state, season, leagues, excluded_count } = await myLeagues(deps);
  return {
    season,
    nfl_week: state.week,
    display_week: state.display_week,
    season_type: state.season_type,
    note: "nfl_week is the week to set lineups for; display_week is what Sleeper's UI labels as current and can lag a day.",
    excluded_leagues: excluded_count,
    leagues: leagues.map((l) => ({ league_id: l.league_id, name: l.name, status: l.status, teams: l.total_rosters, rules: leagueRules(l) })),
    sources: { sleeper_live: SOURCES.sleeper_live },
  };
}

export async function getLeagueContext(deps: Deps, league: string) {
  const d = await loadLeague(deps, league);
  const me = d.teams.get(d.myRosterId)!;
  const mine = d.matchups.find((m) => m.roster_id === d.myRosterId);
  const opp = mine ? d.matchups.find((m) => m.matchup_id === mine.matchup_id && m.roster_id !== d.myRosterId) : undefined;
  const standings = [...d.teams.values()]
    .sort((a, b) => {
      const [aw] = a.record.split("-").map(Number); const [bw] = b.record.split("-").map(Number);
      return bw - aw || b.points_for - a.points_for;
    })
    .map((t, i) => ({ rank: i + 1, team: t.team_name, record: t.record, points_for: round(t.points_for), waiver_position: t.waiver_position }));
  return envelope(d, {
    rules: leagueRules(d.league),
    my_team: teamDetail(d, me),
    matchup: opp
      ? { opponent: d.teams.get(opp.roster_id)?.team_name, opponent_roster_id: opp.roster_id, my_points: mine.points, opponent_points: opp.points }
      : null,
    standings,
  });
}

export async function getTeam(deps: Deps, league: string, team: string) {
  const d = await loadLeague(deps, league);
  return envelope(d, { team: teamDetail(d, findTeam(d, team)) });
}

export async function getFreeAgents(deps: Deps, league: string, position?: string, limit = 15) {
  const d = await loadLeague(deps, league);
  const pos = position?.toUpperCase();
  const pool = [...d.projections.entries()]
    .filter(([id]) => !d.rosteredBy.has(id) && d.players[id])
    .filter(([id]) => !pos || d.players[id][4].includes(pos))
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.min(limit, 50))
    .map(([id]) => d.view(id));
  const me = d.teams.get(d.myRosterId)!;
  const myBench = activeIds(me).filter((id) => !me.starters.includes(id)).map(d.view).sort((a, b) => (a.proj ?? -1) - (b.proj ?? -1));
  return envelope(d, {
    waivers: leagueRules(d.league).waivers,
    my_waiver_position: me.waiver_position,
    available: pool,
    drop_candidates: myBench.slice(0, 5),
    note: "Ranked by this week's projection only. Weigh rest-of-season value (FantasyPros) and same-day news before claiming. Players with no projection are omitted.",
  });
}

export async function checkAvailability(deps: Deps, names: string[], league?: string) {
  const ctx = await myLeagues(deps);
  const { leagues } = ctx;
  const targets = league ? leagues.filter((l) => l.league_id === league || l.name.toLowerCase().includes(league.toLowerCase())) : leagues;
  const loaded = await Promise.all(targets.filter((l) => l.status === "in_season").map((l) => loadLeague(deps, l.league_id, ctx)));
  if (loaded.length === 0) throw new Error("No in-season leagues matched.");
  const players = loaded[0].players;
  const prefer = new Set(loaded.flatMap((d) => [...d.rosteredBy.keys()]));
  return {
    results: names.map((n) => {
      const r = resolvePlayer(players, n, prefer);
      if (r.status !== "ok") return r;
      return {
        status: "ok",
        player: loaded[0].view(r.id),
        leagues: loaded.map((d) => {
          const owner = d.rosteredBy.get(r.id);
          return {
            league: d.league.name,
            available: owner === undefined,
            rostered_by: owner === undefined ? null : owner === d.myRosterId ? "me" : d.teams.get(owner)?.team_name,
            proj_this_league: d.projections.get(r.id) ?? null,
          };
        }),
      };
    }),
    as_of: loaded[0].as_of,
    data_gaps: [...new Set(loaded.flatMap((d) => d.gaps))],
  };
}

export async function optimizeMyLineup(deps: Deps, league: string, exclude: string[] = []) {
  const d = await loadLeague(deps, league);
  const me = d.teams.get(d.myRosterId)!;
  const excluded = new Set<string>();
  const unresolved = [];
  for (const n of exclude) {
    const r = resolvePlayer(d.players, n, new Set(me.players));
    if (r.status === "ok") excluded.add(r.id); else unresolved.push(r);
  }
  const ids = activeIds(me).filter((id) => !excluded.has(id));
  const { res, current } = lineupWithChanges(d, me, ids, me.starters);
  // Report who enters and leaves the lineup; reshuffles between equivalent slots are not changes.
  const before = new Set(me.starters.filter((id) => id !== "0"));
  const after = new Set(res.slots.map((s) => s.id).filter((id): id is string => !!id));
  const changes = {
    start: [...after].filter((id) => !before.has(id)).map(d.view),
    bench: [...before].filter((id) => !after.has(id)).map(d.view),
  };
  const flagged = ids.map(d.view).filter((v) => v.injury || v.bye === true || v.locked === "unknown");
  return envelope(d, {
    current_projected: current,
    optimal_projected: res.total,
    gain: round(res.total - current),
    changes,
    optimal: res.slots.map((s) => ({ slot: s.slot, fixed: s.fixed, ...(s.id ? d.view(s.id) : { empty: true }) })),
    flagged_players: flagged,
    unresolved_exclusions: unresolved,
    note: "Locked or lock-unknown players stay where they are. Players tagged Out/IR/Sus or on bye are never started. Questionable/Doubtful players are flagged, not benched; check same-day news.",
  });
}

export async function tradeImpact(deps: Deps, league: string, partner: string, give: string[], get: string[]) {
  const d = await loadLeague(deps, league);
  const me = d.teams.get(d.myRosterId)!;
  const them = findTeam(d, partner);
  if (them.roster_id === me.roster_id) throw new Error("Partner must be another team.");
  const problems: unknown[] = [];
  const resolveOn = (names: string[], t: TeamView) =>
    names.flatMap((n) => {
      const r = resolvePlayer(d.players, n, new Set(t.players));
      if (r.status !== "ok") { problems.push(r); return []; }
      if (!t.players.includes(r.id)) { problems.push({ status: "not_on_roster", player: d.view(r.id).name, team: t.team_name }); return []; }
      return [r.id];
    });
  const giveIds = resolveOn(give, me);
  const getIds = resolveOn(get, them);
  if (problems.length) return envelope(d, { error: "Could not validate the trade.", problems });

  const rosterLimit = d.league.roster_positions.length;
  const side = (t: TeamView, out: string[], inn: string[]) => {
    const before = activeIds(t);
    const after = [...before.filter((id) => !out.includes(id)), ...inn];
    const b = lineupWithChanges(d, t, before, t.starters);
    const a = lineupWithChanges(d, t, after, t.starters.map((id) => (out.includes(id) ? "0" : id)));
    const counts = (ids: string[]) => ids.reduce<Record<string, number>>((acc, id) => {
      const pos = d.players[id]?.[1] ?? "?"; acc[pos] = (acc[pos] ?? 0) + 1; return acc;
    }, {});
    const starting = new Set(a.res.slots.map((s) => s.id));
    const overBy = after.length - rosterLimit;
    const cutCandidates = overBy > 0
      ? after.filter((id) => !starting.has(id)).map(d.view).sort((x, y) => (x.proj ?? -1) - (y.proj ?? -1)).slice(0, overBy + 2)
      : [];
    return {
      team: t.team_name,
      optimal_projected_before: b.res.total,
      optimal_projected_after: a.res.total,
      weekly_change: round(a.res.total - b.res.total),
      positions_before: counts(before),
      positions_after: counts(after),
      must_drop: Math.max(0, overBy),
      cut_candidates: cutCandidates,
    };
  };
  return envelope(d, {
    trade: { i_give: giveIds.map(d.view), i_get: getIds.map(d.view) },
    trade_deadline_week: d.league.settings?.trade_deadline,
    me: side(me, giveIds, getIds),
    partner: side(them, getIds, giveIds),
    note: "Weekly projections only: this shows this week's lineup effect and roster fit, not rest-of-season value. Use FantasyPros rest-of-season rankings for value.",
  });
}

export async function getActivity(deps: Deps, league: string) {
  const d = await loadLeague(deps, league);
  const leg = d.league.settings?.leg ?? d.week;
  const legs = [leg, leg - 1].filter((x) => x >= 1);
  const [tx, adds, drops] = await Promise.all([
    Promise.all(legs.map((l) => deps.sleeper.transactions(d.league.league_id, l))).then((x) => x.flat()),
    deps.sleeper.trending("add"),
    deps.sleeper.trending("drop"),
  ]);
  const name = (rid: number) => d.teams.get(rid)?.team_name ?? `roster ${rid}`;
  return envelope(d, {
    transactions: tx
      .filter((t) => t.status === "complete")
      .sort((a, b) => b.status_updated - a.status_updated)
      .slice(0, 40)
      .map((t) => ({
        type: t.type,
        when: new Date(t.status_updated).toISOString(),
        teams: (t.roster_ids ?? []).map(name),
        adds: Object.entries(t.adds ?? {}).map(([pid, rid]) => ({ player: d.view(pid).name, to: name(rid as number) })),
        drops: Object.entries(t.drops ?? {}).map(([pid, rid]) => ({ player: d.view(pid).name, from: name(rid as number) })),
      })),
    trending_adds_24h: adds.map((x) => ({ ...d.view(x.player_id), count: x.count, available_here: !d.rosteredBy.has(x.player_id) })),
    trending_drops_24h: drops.map((x) => ({ ...d.view(x.player_id), count: x.count })),
    note: "Trending counts are Sleeper-wide demand signals across all leagues, not projections.",
  });
}
