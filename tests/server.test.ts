import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMemo, DataCache, type KVLike } from "../src/cache";
import { compactProjections, mergeSchedule } from "../src/compact";
import type { Deps } from "../src/league";
import { resolvePlayer } from "../src/league";
import { optimizeLineup } from "../src/lineup";
import { scoreStats } from "../src/scoring";
import { SleeperClient } from "../src/sleeper";
import * as tools from "../src/tools";

// Fixtures are live responses captured on 2026-10-06 (NFL week 5, Tuesday).
const fx = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const PGR = "1389721278398623744";
const FF = "1389691914638344192";
const PROGRESSIVE = "1389708735164723200";

const ROUTES: Record<string, string> = {
  "/user/jbarkie": "user.json",
  "/state/nfl": "state.json",
  "/user/608758225461927936/leagues/nfl/2026": "leagues.json",
};
for (const id of [PGR, FF]) {
  ROUTES[`/league/${id}/rosters`] = `rosters_${id}.json`;
  ROUTES[`/league/${id}/users`] = `users_${id}.json`;
  ROUTES[`/league/${id}/matchups/5`] = `m5_${id}.json`;
  ROUTES[`/league/${id}/transactions/4`] = `tx4_${id}.json`;
  ROUTES[`/league/${id}/transactions/3`] = `tx4_${id}.json`;
}

function fakeFetch(url: string): Promise<Response> {
  const path = url.replace("https://api.sleeper.app/v1", "").split("?")[0];
  let body: unknown;
  const league = path.match(/^\/league\/(\d+)$/);
  if (league) body = fx("leagues.json").find((l: any) => l.league_id === league[1]);
  else if (path.startsWith("/players/nfl/trending/")) body = [{ player_id: "9509", count: 100 }];
  else if (ROUTES[path]) body = fx(ROUTES[path]);
  if (body === undefined) return Promise.resolve(new Response("not found", { status: 404 }));
  return Promise.resolve(new Response(JSON.stringify(body)));
}

class MemoryKV implements KVLike {
  constructor(public store: Map<string, string>) {}
  async get(key: string) { return this.store.get(key) ?? null; }
}

const bulk: Array<{ key: string; value: string }> = fx("cache_bulk.json");

function makeDeps(opts: { now?: string; omit?: string[] } = {}): Deps {
  const store = new Map(bulk.filter((e) => !(opts.omit ?? []).includes(e.key)).map((e) => [e.key, e.value]));
  return {
    sleeper: new SleeperClient(fakeFetch),
    cache: new DataCache(new MemoryKV(store)),
    config: { username: "jbarkie", excludedLeagues: new Set([PROGRESSIVE]) },
    now: () => new Date(opts.now ?? "2026-10-06T18:00:00Z"),
  };
}

beforeEach(() => clearMemo());

describe("scoring", () => {
  const leagues = fx("leagues.json");
  const proj = compactProjections(fx("projections_2026_5.json"));
  const players = JSON.parse(bulk.find((e) => e.key === "players")!.value).data;

  // Sleeper appears to score unrounded stats, so totals differ by a few hundredths (max 0.06 on 2026-10-06).
  it("matches Sleeper pts_ppr within 0.1 for QB/RB/WR/TE/DEF in both leagues", () => {
    for (const l of leagues.filter((x: any) => x.league_id !== PROGRESSIVE)) {
      let checked = 0;
      for (const [id, s] of Object.entries(proj)) {
        if (!["QB", "RB", "WR", "TE", "DEF"].includes(players[id]?.[1]) || s.pts_ppr === undefined) continue;
        expect(Math.abs(scoreStats(s, l.scoring_settings)! - s.pts_ppr)).toBeLessThan(0.1);
        checked++;
      }
      expect(checked).toBeGreaterThan(300);
    }
  });

  it("scores kickers within 0.5 of Sleeper (league counts missed FGs; pts_ppr does not)", () => {
    const scoring = leagues[0].scoring_settings;
    for (const [id, s] of Object.entries(proj)) {
      if (players[id]?.[1] !== "K" || s.pts_ppr === undefined) continue;
      expect(Math.abs(scoreStats(s, scoring)! - s.pts_ppr)).toBeLessThan(0.5);
    }
  });

  it("drops ADP-only projection rows", () => {
    expect(compactProjections({ a: { adp_dd_ppr: 1000 }, b: { gp: 1 }, c: { rec: 3, adp_dd_ppr: 50 } })).toEqual({ c: { rec: 3 } });
  });
});

describe("schedule merge", () => {
  it("maps ESPN WSH to WAS and attaches kickoffs", () => {
    const sleeper = [{ week: 5, home: "WAS", away: "NYG", date: "2026-10-11", status: "pre_game" }];
    const espn = { 5: { events: [{ date: "2026-10-11T17:00Z", competitions: [{ competitors: [
      { homeAway: "home", team: { abbreviation: "WSH" } }, { homeAway: "away", team: { abbreviation: "NYG" } }] }] }] } };
    expect(mergeSchedule(sleeper, espn).games[0].kickoff).toBe("2026-10-11T17:00:00.000Z");
  });

  it("dropped Sleeper's phantom week-6 SEA@DAL game", () => {
    const games = JSON.parse(bulk.find((e) => e.key === "schedule:2026")!.value).data;
    const week6 = games.filter((g: any) => g.week === 6 && [g.home, g.away].some((t: string) => t === "SEA" || t === "DAL"));
    expect(week6.map((g: any) => `${g.away}@${g.home}`).sort()).toEqual(["DAL@GB", "SEA@DEN"]);
  });
});

describe("lineup solver", () => {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "FLEX", "FLEX", "K", "DEF"];
  const p = (id: string, pos: string, points: number, extra: object = {}) => ({ id, positions: [pos], points, locked: false as const, ...extra });
  const roster = [
    p("qb", "QB", 20), p("rb1", "RB", 15), p("rb2", "RB", 14), p("rb3", "RB", 13), p("wr1", "WR", 16), p("wr2", "WR", 12),
    p("wr3", "WR", 11), p("te1", "TE", 10), p("te2", "TE", 12.5), p("k", "K", 8), p("def", "DEF", 7), p("out", "WR", 30, { unavailable: "Out" }),
  ];

  it("fills two FLEX slots with the best remaining RB/WR/TE and never starts an Out player", () => {
    const res = optimizeLineup(slots, roster, Array(10).fill("0"));
    const byslot = res.slots.map((s) => s.id);
    expect(byslot.slice(0, 6)).toEqual(["qb", "rb1", "rb2", "wr1", "wr2", "te2"]);
    expect(byslot.slice(6, 8).sort()).toEqual(["rb3", "wr3"]);
    expect(byslot).not.toContain("out");
    expect(res.total).toBe(20 + 15 + 14 + 16 + 12 + 12.5 + 13 + 11 + 8 + 7);
  });

  it("keeps locked starters in place and never starts a locked bench player", () => {
    const locked = roster.map((x) => (x.id === "rb3" ? { ...x, locked: true as const } : x.id === "wr1" ? { ...x, locked: "unknown" as const } : x));
    const current = ["qb", "rb1", "rb2", "wr1", "wr2", "te1", "wr3", "te2", "k", "def"];
    const res = optimizeLineup(slots, locked, current);
    expect(res.slots[3]).toMatchObject({ id: "wr1", fixed: true });
    expect(res.slots.map((s) => s.id)).not.toContain("rb3");
  });
});

describe("name resolution", () => {
  const players = JSON.parse(bulk.find((e) => e.key === "players")!.value).data;
  it("resolves exact and punctuation-insensitive names", () => {
    expect(resolvePlayer(players, "Bijan Robinson")).toEqual({ status: "ok", id: "9509" });
    expect(resolvePlayer(players, "wandale robinson")).toEqual({ status: "ok", id: "8126" });
  });
  it("returns candidates instead of guessing", () => {
    const r: any = resolvePlayer(players, "Robinson", new Set(["9509", "8126"]));
    expect(r.status).toBe("ambiguous");
    expect(r.candidates.slice(0, 2).map((c: any) => c.id).sort()).toEqual(["8126", "9509"]);
  });
});

describe("tools against live fixtures", () => {
  it("lists only the two active leagues with rolling waivers and redraft format", async () => {
    const r = await tools.getMyLeagues(makeDeps());
    expect(r.leagues.map((l) => l.league_id).sort()).toEqual([FF, PGR].sort());
    expect(r.excluded_leagues).toBe(1);
    for (const l of r.leagues) expect(l.rules).toMatchObject({ waivers: "rolling", format: "redraft" });
    expect(r.nfl_week).toBe(5);
  });

  it("refuses the excluded Progressive league", async () => {
    await expect(tools.getLeagueContext(makeDeps(), "Progressive")).rejects.toThrow(/matched 0 leagues/);
  });

  it("builds my PGR context with team, waiver position, opponents and kickoffs", async () => {
    const r: any = await tools.getLeagueContext(makeDeps(), "PGR");
    expect(r.my_team).toMatchObject({ roster_id: 3, team_name: "To Infinity & Bijan", waiver_position: 7 });
    const bijan = r.my_team.starters.find((s: any) => s.id === "9509");
    expect(bijan).toMatchObject({ name: "Bijan Robinson", team: "ATL", opp: "BAL", locked: false });
    expect(bijan.kickoff).toMatch(/^2026-10-1/);
    expect(bijan.proj).toBeGreaterThan(5);
    expect(r.my_team.reserve[0]).toMatchObject({ name: "Alec Pierce", injury: "IR" });
    expect(r.standings).toHaveLength(12);
    expect(r.matchup?.opponent).toBeTruthy();
  });

  it("reports missing projections as a data gap instead of inventing them", async () => {
    const r: any = await tools.getLeagueContext(makeDeps({ omit: [`points:${PGR}:2026:5`] }), "PGR");
    expect(r.data_gaps.join(" ")).toMatch(/No week 5 projections/);
    expect(r.my_team.starters.every((s: any) => s.proj === null)).toBe(true);
  });

  it("flags points built with different scoring settings", async () => {
    const deps = makeDeps();
    const key = `points:${FF}:2026:5`;
    const entry = bulk.find((e) => e.key === key)!;
    const changed = JSON.parse(entry.value);
    changed.data.scoring_hash = "different";
    (deps.cache as any).kv.store.set(key, JSON.stringify(changed));
    const r: any = await tools.getLeagueContext(deps, "Fantasy Football");
    expect(r.data_gaps.join(" ")).toMatch(/scoring settings changed/);
  });

  it("flags stale caches", async () => {
    const r: any = await tools.getLeagueContext(makeDeps({ now: "2026-10-09T18:00:00Z" }), "Fantasy Football");
    expect(r.data_gaps.join(" ")).toMatch(/stale/);
  });

  it("optimizes my lineup without starting Out/NA players", async () => {
    const r: any = await tools.optimizeMyLineup(makeDeps(), "PGR");
    expect(r.optimal_projected).toBeGreaterThanOrEqual(r.current_projected);
    const startedIds = r.optimal.map((s: any) => s.id);
    expect(startedIds).not.toContain("5022"); // Dallas Goedert, Out
    expect(startedIds).not.toContain("5850"); // Josh Jacobs, NA
    // Swapping two players between the FLEX slots is not a change.
    const started = new Set(r.changes.start.map((p: any) => p.id));
    for (const p of r.changes.bench) expect(started.has(p.id)).toBe(false);
  });

  it("does not move players whose games have kicked off", async () => {
    // Thursday night game (TB@DAL) has started; everything else is open.
    const r: any = await tools.optimizeMyLineup(makeDeps({ now: "2026-10-09T01:00:00Z" }), "PGR");
    for (const s of r.optimal) if (["TB", "DAL"].includes(s.team)) expect(s.fixed).toBe(true);
  });

  it("lists free agents that are not rostered in the league", async () => {
    const r: any = await tools.getFreeAgents(makeDeps(), "Fantasy Football", "RB", 10);
    const rostered = new Set(fx(`rosters_${FF}.json`).flatMap((x: any) => [...(x.players ?? []), ...(x.reserve ?? [])]));
    expect(r.available.length).toBe(10);
    for (const p of r.available) expect(rostered.has(p.id)).toBe(false);
    expect(r.my_waiver_position).toBe(5);
  });

  it("checks availability across both leagues", async () => {
    const r: any = await tools.checkAvailability(makeDeps(), ["Bijan Robinson"]);
    const pgr = r.results[0].leagues.find((l: any) => l.league === "PGR IT ‘26");
    expect(pgr.rostered_by).toBe("me");
    expect(r.results[0].leagues).toHaveLength(2);
  });

  it("rejects a trade for a player the partner does not own", async () => {
    const r: any = await tools.tradeImpact(makeDeps(), "PGR", "5", ["Jakobi Meyers"], ["Bijan Robinson"]);
    expect(r.error).toBeTruthy();
    expect(r.problems[0].status).toBe("not_on_roster");
  });

  it("evaluates a valid trade for both sides", async () => {
    const r: any = await tools.tradeImpact(makeDeps(), "PGR", "5", ["Jakobi Meyers"], ["Omarion Hampton"]);
    expect(r.error).toBeUndefined();
    expect(r.trade.i_get[0].name).toBe("Omarion Hampton");
    expect(typeof r.me.weekly_change).toBe("number");
    expect(r.partner.positions_after).toBeTruthy();
  });

  it("summarizes activity with team names and trending availability", async () => {
    const r: any = await tools.getActivity(makeDeps(), "PGR");
    expect(r.transactions.length).toBeGreaterThan(0);
    expect(r.trending_adds_24h[0]).toMatchObject({ name: "Bijan Robinson", available_here: false });
  });
});
