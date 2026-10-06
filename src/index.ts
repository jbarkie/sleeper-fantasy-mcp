import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { DataCache, type KVLike } from "./cache";
import type { Deps } from "./league";
import { SleeperClient } from "./sleeper";
import * as tools from "./tools";

export interface Env {
  CACHE: KVLike;
  SLEEPER_USERNAME: string;
  EXCLUDED_LEAGUES?: string;
  // Secret path segment; the server only answers at /mcp/<MCP_PATH_TOKEN>.
  MCP_PATH_TOKEN: string;
}

const LEAGUE = z.string().describe('League name or ID, e.g. "PGR IT \'26" or "Fantasy Football"');

export function buildServer(deps: Deps): McpServer {
  const server = new McpServer({ name: "sleeper-fantasy", version: "1.0.0" });
  const run = (fn: () => Promise<unknown>) => async () => {
    try {
      return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
    }
  };
  const ro = { readOnlyHint: true, openWorldHint: true };

  server.registerTool("get_my_leagues", {
    description: "List my included Sleeper leagues with key rules (format, waiver type, reserve, trade deadline) and the current NFL week. Call first if unsure which league.",
    inputSchema: {}, annotations: ro,
  }, run(() => tools.getMyLeagues(deps)));

  server.registerTool("get_league_context", {
    description: "My roster in one league (starters, bench, IR) with each player's injury tag, opponent, kickoff, lock state and league-scored projection; plus rules, waiver position, this week's matchup and standings. Call this before any advice.",
    inputSchema: { league: LEAGUE }, annotations: ro,
  }, ({ league }) => run(() => tools.getLeagueContext(deps, league))());

  server.registerTool("get_team", {
    description: "Another team's roster in a league, in the same format as my roster. Use for trade ideas and opponent analysis.",
    inputSchema: { league: LEAGUE, team: z.string().describe("Team name, manager name, or roster id") }, annotations: ro,
  }, ({ league, team }) => run(() => tools.getTeam(deps, league, team))());

  server.registerTool("get_free_agents", {
    description: "Best available (unrostered) players in a league ranked by this week's league-scored projection, plus my waiver position and weakest bench players as drop candidates.",
    inputSchema: {
      league: LEAGUE,
      position: z.enum(["QB", "RB", "WR", "TE", "K", "DEF"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
    }, annotations: ro,
  }, ({ league, position, limit }) => run(() => tools.getFreeAgents(deps, league, position, limit ?? 15))());

  server.registerTool("check_availability", {
    description: "Check whether named players are available or who rosters them, across my in-season leagues (or one league). Ambiguous names return candidates instead of a guess.",
    inputSchema: { players: z.array(z.string()).min(1).max(20), league: LEAGUE.optional() }, annotations: ro,
  }, ({ players, league }) => run(() => tools.checkAvailability(deps, players, league))());

  server.registerTool("optimize_lineup", {
    description: "Best legal lineup for my team this week by league-scored projection, with the changes from my current lineup. Locked and lock-unknown players are not moved. Use `exclude` to bench players (e.g. after injury news).",
    inputSchema: { league: LEAGUE, exclude: z.array(z.string()).optional().describe("Player names to treat as unavailable") }, annotations: ro,
  }, ({ league, exclude }) => run(() => tools.optimizeMyLineup(deps, league, exclude))());

  server.registerTool("trade_impact", {
    description: "Validate a proposed trade and show both teams' optimal projected lineup this week before/after, positional counts, and forced roster cuts. Weekly only; pair with rest-of-season values.",
    inputSchema: {
      league: LEAGUE,
      partner: z.string().describe("Other team's name, manager, or roster id"),
      give: z.array(z.string()).describe("Players I send"),
      get: z.array(z.string()).describe("Players I receive"),
    }, annotations: ro,
  }, ({ league, partner, give, get }) => run(() => tools.tradeImpact(deps, league, partner, give, get))());

  server.registerTool("get_activity", {
    description: "Recent completed transactions in a league (this week and last) plus Sleeper-wide trending adds/drops over 24h, marked by availability in this league.",
    inputSchema: { league: LEAGUE }, annotations: ro,
  }, ({ league }) => run(() => tools.getActivity(deps, league))());

  return server;
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
    // Stateless: a fresh server and transport per request, no session ids.
    const server = buildServer(depsFromEnv(env));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
