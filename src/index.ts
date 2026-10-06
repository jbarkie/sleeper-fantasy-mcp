import { DataCache, type KVLike } from "./cache";
import * as espn from "./espn";
import type { Deps } from "./league";
import { handleMcp, type ToolDef } from "./mcp";
import { SleeperClient } from "./sleeper";
import * as tools from "./tools";

export interface Env {
  CACHE: KVLike;
  SLEEPER_USERNAME: string;
  EXCLUDED_LEAGUES?: string;
  // Secret path segment; the server only answers at /mcp/<MCP_PATH_TOKEN>.
  MCP_PATH_TOKEN: string;
  // Optional ESPN support: session cookies (secrets) and comma-separated league ids.
  ESPN_S2?: string;
  ESPN_SWID?: string;
  ESPN_LEAGUES?: string;
}

const LEAGUE = { type: "string", description: 'League name or ID, e.g. "PGR IT \'26" or "Fantasy Football"' };
const NAMES = (description: string, max = 20) => ({ type: "array", items: { type: "string" }, maxItems: max, description });
const ro = { readOnlyHint: true, openWorldHint: true };

export function buildTools(deps: Deps): ToolDef[] {
  return [
    {
      name: "get_my_leagues",
      description: "List my included Sleeper leagues with key rules (format, waiver type, reserve, trade deadline) and the current NFL week. Call first if unsure which league.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: ro,
      handler: () => tools.getMyLeagues(deps),
    },
    {
      name: "get_league_context",
      description: "My roster in one league (starters, bench, IR) with each player's injury tag, opponent, kickoff, lock state and league-scored projection; plus rules, waiver position, this week's matchup and standings. Call this before any advice.",
      inputSchema: { type: "object", properties: { league: LEAGUE }, required: ["league"], additionalProperties: false },
      annotations: ro,
      handler: (a) => tools.getLeagueContext(deps, a.league),
    },
    {
      name: "get_team",
      description: "Another team's roster in a league, in the same format as my roster. Use for trade ideas and opponent analysis.",
      inputSchema: {
        type: "object",
        properties: { league: LEAGUE, team: { type: "string", description: "Team name, manager name, or roster id" } },
        required: ["league", "team"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => tools.getTeam(deps, a.league, a.team),
    },
    {
      name: "get_free_agents",
      description: "Best available (unrostered) players in a league ranked by this week's league-scored projection, plus my waiver position and weakest bench players as drop candidates.",
      inputSchema: {
        type: "object",
        properties: {
          league: LEAGUE,
          position: { type: "string", enum: ["QB", "RB", "WR", "TE", "K", "DEF"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        required: ["league"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => tools.getFreeAgents(deps, a.league, a.position, a.limit ?? 15),
    },
    {
      name: "check_availability",
      description: "Check whether named players are available or who rosters them, across my in-season leagues (or one league). Ambiguous names return candidates instead of a guess.",
      inputSchema: {
        type: "object",
        properties: { players: { ...NAMES("Player names"), minItems: 1 }, league: LEAGUE },
        required: ["players"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => tools.checkAvailability(deps, a.players, a.league),
    },
    {
      name: "optimize_lineup",
      description: "Best legal lineup for my team this week by league-scored projection, with the changes from my current lineup. Locked and lock-unknown players are not moved. Use `exclude` to bench players (e.g. after injury news).",
      inputSchema: {
        type: "object",
        properties: { league: LEAGUE, exclude: NAMES("Player names to treat as unavailable") },
        required: ["league"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => tools.optimizeMyLineup(deps, a.league, a.exclude),
    },
    {
      name: "trade_impact",
      description: "Validate a proposed trade and show both teams' optimal projected lineup this week before/after, positional counts, and forced roster cuts. Weekly only; pair with rest-of-season values.",
      inputSchema: {
        type: "object",
        properties: {
          league: LEAGUE,
          partner: { type: "string", description: "Other team's name, manager, or roster id" },
          give: NAMES("Players I send", 10),
          get: NAMES("Players I receive", 10),
        },
        required: ["league", "partner", "give", "get"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => tools.tradeImpact(deps, a.league, a.partner, a.give, a.get),
    },
    {
      name: "get_activity",
      description: "Recent completed transactions in a league (this week and last) plus Sleeper-wide trending adds/drops over 24h, marked by availability in this league.",
      inputSchema: { type: "object", properties: { league: LEAGUE }, required: ["league"], additionalProperties: false },
      annotations: ro,
      handler: (a) => tools.getActivity(deps, a.league),
    },
  ];
}

const ESPN_LEAGUE = { type: "string", description: "ESPN league id (optional when only one ESPN league is configured)" };

export function buildEspnTools(deps: espn.EspnDeps): ToolDef[] {
  return [
    {
      name: "espn_get_league_context",
      description: "ESPN league: my roster (slot, injury, opponent, kickoff, lock, ESPN projection scored for this league, season projection), rules, matchup score, standings, waiver rank, and my pending waiver claims/trades. Call before any ESPN advice.",
      inputSchema: { type: "object", properties: { league: ESPN_LEAGUE }, additionalProperties: false },
      annotations: ro,
      handler: (a) => espn.espnLeagueContext(deps, a.league ?? ""),
    },
    {
      name: "espn_optimize_lineup",
      description: "ESPN league: best legal lineup this week by ESPN projection, with changes from my current lineup. Bye-week and OUT players are never started; locked players are not moved.",
      inputSchema: {
        type: "object",
        properties: { league: ESPN_LEAGUE, exclude: NAMES("Player names to treat as unavailable") },
        additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => espn.espnOptimizeLineup(deps, a.league ?? "", a.exclude),
    },
    {
      name: "espn_get_free_agents",
      description: "ESPN league: best available players (free agents and waivers) re-ranked by this week's projection, with season projections and ownership %.",
      inputSchema: {
        type: "object",
        properties: {
          league: ESPN_LEAGUE,
          position: { type: "string", enum: ["QB", "RB", "WR", "TE", "K", "DEF"] },
          limit: { type: "integer", minimum: 1, maximum: 50 },
        },
        additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => espn.espnFreeAgents(deps, a.league ?? "", a.position, a.limit ?? 15),
    },
    {
      name: "espn_check_availability",
      description: "ESPN league: whether named players are available, on waivers, or who rosters them. Ambiguous names return candidates.",
      inputSchema: {
        type: "object",
        properties: { players: { ...NAMES("Player names", 10), minItems: 1 }, league: ESPN_LEAGUE },
        required: ["players"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => espn.espnCheckAvailability(deps, a.league ?? "", a.players),
    },
    {
      name: "espn_get_team",
      description: "ESPN league: another team's roster with projections, for trade ideas and opponent analysis.",
      inputSchema: {
        type: "object",
        properties: { league: ESPN_LEAGUE, team: { type: "string", description: "Team name, abbreviation, or id" } },
        required: ["team"], additionalProperties: false,
      },
      annotations: ro,
      handler: (a) => espn.espnGetTeam(deps, a.league ?? "", a.team),
    },
  ];
}

export function depsFromEnv(env: Env): Deps {
  return {
    sleeper: new SleeperClient(),
    cache: new DataCache(env.CACHE),
    config: {
      username: env.SLEEPER_USERNAME,
      excludedLeagues: new Set((env.EXCLUDED_LEAGUES ?? "").split(",").map((s) => s.trim()).filter(Boolean)),
    },
    now: () => new Date(),
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!env.MCP_PATH_TOKEN || url.pathname !== `/mcp/${env.MCP_PATH_TOKEN}`) return new Response("Not found", { status: 404 });
    const deps = depsFromEnv(env);
    const tools = buildTools(deps);
    if (env.ESPN_S2 && env.ESPN_SWID && env.ESPN_LEAGUES) {
      const cfg = { s2: env.ESPN_S2, swid: env.ESPN_SWID, leagues: env.ESPN_LEAGUES.split(",").map((s) => s.trim()).filter(Boolean) };
      tools.push(...buildEspnTools({ espn: new espn.EspnClient(cfg), cfg, cache: deps.cache, now: deps.now }));
    }
    return handleMcp(request, tools);
  },
};
