import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearMemo, DataCache } from "../src/cache";
import { EspnClient, espnCheckAvailability, espnLeagueContext, espnOptimizeLineup, type EspnDeps } from "../src/espn";

// Anonymized, slimmed responses from a private ESPN league captured on 2026-10-06 (week 5).
// The owner's SWID is replaced with a fake one; other teams are renamed.
const fx = (name: string) => readFileSync(join(__dirname, "fixtures", name), "utf8");
const SWID = "{00000000-0000-0000-0000-000000000007}";
const bulk = new Map<string, string>(JSON.parse(fx("cache_bulk.json")).map((e: any) => [e.key, e.value]));

const POOL: Record<string, { onTeamId: number; status: string }> = {
  "4430807": { onTeamId: 3, status: "ONTEAM" }, // Bijan Robinson
  "4426348": { onTeamId: 7, status: "ONTEAM" }, // Jayden Daniels
  "4431452": { onTeamId: 0, status: "WAIVERS" }, // Drake Maye
};

function makeDeps(opts: { status?: number; now?: string } = {}) {
  const calls: Array<{ url: string; filter?: any; cookie?: string }> = [];
  const fetcher = async (url: string, init: RequestInit) => {
    const h = init.headers as Record<string, string>;
    const filter = h["x-fantasy-filter"] ? JSON.parse(h["x-fantasy-filter"]) : undefined;
    calls.push({ url, filter, cookie: h.Cookie });
    if (opts.status) return new Response("{}", { status: opts.status });
    const views = new URL(url).searchParams.getAll("view");
    if (views.includes("mSettings")) return new Response(fx("espn/base.json"));
    if (views.includes("mRoster")) return new Response(fx("espn/roster_7.json"));
    if (views.includes("mMatchupScore")) return new Response(fx("espn/matchups.json"));
    if (views.includes("mPendingTransactions")) return new Response(fx("espn/pending.json"));
    if (views.includes("kona_player_info")) {
      const ids: number[] = filter.players.filterIds.value;
      const players = JSON.parse(bulk.get("espn:players")!).data;
      return new Response(JSON.stringify({
        players: ids.map((id) => ({
          id, ...POOL[String(id)],
          player: { id, fullName: players[String(id)][0], defaultPositionId: 1, proTeamId: 0, eligibleSlots: [0], stats: [] },
        })),
      }));
    }
    return new Response("not found", { status: 404 });
  };
  const cfg = { s2: "fake-s2", swid: SWID, leagues: ["2077966273"] };
  const deps: EspnDeps = {
    espn: new EspnClient(cfg, fetcher),
    cfg,
    cache: new DataCache({ get: async (k: string) => bulk.get(k) ?? null }),
    now: () => new Date(opts.now ?? "2026-10-06T20:00:00Z"),
  };
  return { deps, calls };
}

beforeEach(() => clearMemo());

describe("ESPN prototype", () => {
  it("finds my team by SWID and names pending waiver claims", async () => {
    const { deps, calls } = makeDeps();
    const r: any = await espnLeagueContext(deps, "");
    expect(r.my_team).toMatchObject({ team_id: 7, team_name: "Let Him Cook", record: "2-2" });
    expect(r.matchup.opponent).toBe("League Mate 2");
    expect(r.rules).toMatchObject({ teams: 8, reception_points: 1, acquisition_type: "WAIVERS_TRADITIONAL" });
    const items = r.my_pending_transactions.flatMap((t: any) => t.items.map((i: any) => `${i.type} ${i.player}`));
    expect(items).toEqual(expect.arrayContaining(["ADD Cowboys D/ST", "DROP Ravens D/ST", "ADD Drake Maye", "DROP Bryce Young"]));
    expect(calls.every((c) => c.cookie === `espn_s2=fake-s2; SWID=${SWID}`)).toBe(true);
  });

  it("benches a bye-week QB for the healthy bench QB", async () => {
    const { deps } = makeDeps();
    const r: any = await espnOptimizeLineup(deps, "");
    expect(r.changes.start.map((p: any) => p.name)).toEqual(["Jayden Daniels"]);
    expect(r.changes.bench.map((p: any) => p.name)).toEqual(["Bryce Young"]);
    expect(r.gain).toBeCloseTo(20.48, 2);
    const young = r.flagged_players.find((p: any) => p.name === "Bryce Young");
    expect(young).toMatchObject({ team: "CAR", bye: true });
  });

  it("resolves names from the cached ESPN index and queries status by id", async () => {
    const { deps, calls } = makeDeps();
    const r: any = await espnCheckAvailability(deps, "", ["Bijan Robinson", "Drake Maye", "Jayden Daniels", "Robinson"]);
    const byQuery = Object.fromEntries(r.results.map((x: any) => [x.query, x]));
    expect(byQuery["Bijan Robinson"]).toMatchObject({ status: "ok", available: false, rostered_by: "League Mate 3" });
    expect(byQuery["Drake Maye"]).toMatchObject({ status: "ok", available: true, on_waivers: true });
    expect(byQuery["Jayden Daniels"].rostered_by).toBe("me");
    expect(byQuery["Robinson"].status).toBe("ambiguous");
    const kona = calls.find((c) => c.url.includes("kona_player_info"))!;
    expect(kona.filter.players.filterIds.value.sort()).toEqual([4426348, 4430807, 4431452]);
  });

  it("explains expired cookies", async () => {
    const { deps } = makeDeps({ status: 401 });
    await expect(espnLeagueContext(deps, "")).rejects.toThrow(/session cookies/);
  });
});
