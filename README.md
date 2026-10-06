# sleeper-fantasy-mcp

A read-only remote MCP server that gives Claude live context from Joseph's Sleeper leagues, plus optional ESPN leagues: rosters, lineup optimization, free agents, trade impact and league activity. It runs statelessly on Cloudflare Workers Free.

**Keeping requests under the free plan's 10 ms CPU limit:**
- A GitHub Action prebuilds everything heavy into Workers KV: a trimmed player list with pre-normalized names, per-league pre-scored projections, and the schedule with kickoff times.
- The server uses a small hand-written MCP handler (`src/mcp.ts`), so it has no runtime dependencies. The MCP SDK is only used in tests and `scripts/smoke.ts`.
- Measured on 2026-10-06: most requests use 0–9 ms of CPU. A fresh isolate's first data request can reach about 16 ms, which falls within Cloudflare's tolerance for occasional overruns. If Claude ever shows "Worker exceeded resource limits" (error 1102), switch to Workers Paid ($5/month).

| Tool | What it returns |
|---|---|
| `get_my_leagues` | Included leagues, rules, current NFL week |
| `get_league_context` | My roster with projections, opponents, kickoffs, locks; matchup; standings |
| `get_team` | Another team's roster |
| `get_free_agents` | Best available players by league-scored projection + drop candidates |
| `check_availability` | Who rosters a player in each league; ambiguous names return candidates |
| `optimize_lineup` | Best legal lineup; locked players are never moved |
| `trade_impact` | Validated trade: both teams' lineup before/after, roster cuts |
| `get_activity` | Recent transactions and Sleeper-wide trending adds/drops |
| `espn_get_league_context` | ESPN: my roster with ESPN projections (league-scored, weekly + season), matchup, standings, my pending waiver claims |
| `espn_optimize_lineup` | ESPN: best legal lineup; bye/OUT players never started |
| `espn_get_free_agents` | ESPN: available players by weekly projection, with season projection and ownership % |
| `espn_check_availability` | ESPN: free agent / waivers / rostered by; names resolved via cached public ESPN player list |
| `espn_get_team` | ESPN: another team's roster |

**ESPN support** reads private leagues with the owner's `espn_s2` and `SWID` browser cookies, stored as Worker secrets. They are a full ESPN session, not read-only, and the server only ever issues GETs. Logging out of ESPN invalidates them, and they expire at an undocumented time. When ESPN rejects them, the tools say so. To refresh, copy each value from Chrome DevTools (Application → Cookies → fantasy.espn.com), then run `pbpaste | npx wrangler secret put ESPN_S2` (and the same for `ESPN_SWID`). The ESPN tools only register when `ESPN_S2`, `ESPN_SWID` and `ESPN_LEAGUES` are all set. On 2026-10-06, a few ESPN league-context requests used up to 20 ms of CPU; ESPN can't trim its roster payloads.

**Data sources.** Every response includes `as_of`, `sources` and `data_gaps`.
- Documented Sleeper API: leagues, rosters, matchups, transactions, players.
- Unofficial: Sleeper projections and schedule, and ESPN scoreboard kickoff times.
- Projections are scored with each league's own `scoring_settings` by the cache job. If a league's scoring changes before the next refresh, the server flags it in `data_gaps`. On 2026-10-06 the results were within 0.06 points of Sleeper's `pts_ppr` for QB/RB/WR/TE/DEF. Kickers differ by up to 0.38 points because the leagues penalize missed FGs and Sleeper's total does not.

## Development

```sh
npm install
npm test                       # unit + integration tests on saved live data
npm run typecheck
npm run build-cache -- --out .cache/bulk.json --players
npx wrangler kv bulk put .cache/bulk.json --binding CACHE --local
npm run dev                    # serves /mcp/<MCP_PATH_TOKEN from .dev.vars>
npx tsx scripts/smoke.ts http://localhost:8787/mcp/<token>
```

## Deploy (one time)

1. Create a free Cloudflare account, then run `npx wrangler login`.
2. Run `npx wrangler kv namespace create CACHE` and put the returned id in `wrangler.toml`.
3. Run `openssl rand -hex 16 | npx wrangler secret put MCP_PATH_TOKEN`, then `npm run deploy`.
4. In the GitHub repo, set:
   - Secrets: `CLOUDFLARE_API_TOKEN` (needs the "Workers KV Storage: Edit" permission) and `CLOUDFLARE_ACCOUNT_ID`.
   - Variable: `KV_NAMESPACE_ID`.
   Then run the "Refresh cache" workflow manually.
5. On claude.ai, go to Settings → Connectors → Add custom connector. Enter `https://sleeper-fantasy-mcp.<subdomain>.workers.dev/mcp/<token>` with no sign-in.
6. Create the Claude Project using `docs/claude-project-instructions.md`.

The URL token is the only access control. The data is public Sleeper data, but keep the URL private so nobody else uses up the free quota.

## Notes

- Sleeper's API is free only for non-commercial use. Ask Sleeper before sharing this commercially.
- GitHub disables scheduled workflows in public repos after 60 days without repo activity. Re-enable it from the Actions tab if that happens.
- On 2026-10-06, Sleeper's schedule listed a phantom week-6 SEA@DAL game. The cache builder drops Sleeper games that ESPN contradicts and records a warning.
