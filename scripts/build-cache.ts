// Builds compact cache entries outside the Worker (the full player list is too
// large to parse within the Workers Free CPU limit) and writes a wrangler
// `kv bulk put` file.
//   npx tsx scripts/build-cache.ts --out .cache/bulk.json [--players | --players-file players.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { compactPlayers, compactProjections, mergeSchedule } from "../src/compact";
import { KEYS } from "../src/cache";
import { SLEEPER } from "../src/sleeper";
import type { CacheMeta, Cached, PlayerMap } from "../src/types";

const args = process.argv.slice(2);
const out = args[args.indexOf("--out") + 1] ?? ".cache/bulk.json";
const playersFile = args.includes("--players-file") ? args[args.indexOf("--players-file") + 1] : null;
const withPlayers = args.includes("--players") || playersFile !== null;

async function getJson(url: string) {
  const res = await fetch(url, { headers: { "user-agent": "sleeper-fantasy-mcp cache builder" } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.json() as Promise<any>;
}

const now = () => new Date().toISOString();
const entries: Array<{ key: string; value: string }> = [];
const put = (key: string, value: unknown) => entries.push({ key, value: JSON.stringify(value) });
const warnings: string[] = [];

const state = await getJson(`${SLEEPER}/state/nfl`);
const season: string = state.league_season ?? state.season;
const week: number = state.week;
const meta: CacheMeta = {
  last_run: now(), season, week, warnings,
  players_fetched_at: null, projections_fetched_at: null, schedule_fetched_at: null,
};

let players: PlayerMap | null = null;
if (withPlayers) {
  // Sleeper asks that this endpoint be called at most once per day.
  const raw = playersFile ? JSON.parse(readFileSync(playersFile, "utf8")) : await getJson(`${SLEEPER}/players/nfl`);
  players = compactPlayers(raw);
  meta.players_fetched_at = now();
  put(KEYS.players, { data: players, fetched_at: meta.players_fetched_at, source: "sleeper:/players/nfl", season } satisfies Cached<PlayerMap>);
}

const proj = compactProjections(await getJson(`${SLEEPER}/projections/nfl/regular/${season}/${week}`));
meta.projections_fetched_at = now();
put(KEYS.projections(season, week), { data: proj, fetched_at: meta.projections_fetched_at, source: "sleeper-unofficial:/projections", season, week });

const sched = await getJson(`https://api.sleeper.com/schedule/nfl/regular/${season}`);
const espn: Record<number, any> = {};
const weeks = [...new Set<number>(sched.map((g: any) => g.week))];
for (const w of weeks) {
  try {
    espn[w] = await getJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?week=${w}&seasontype=2&dates=${season}`);
  } catch (e) {
    warnings.push(`ESPN week ${w}: ${(e as Error).message}`);
  }
}
const { games, unmatched, dropped } = mergeSchedule(sched, espn);
if (unmatched.length) warnings.push(`No ESPN kickoff for: ${unmatched.join(", ")}`);
if (dropped.length) warnings.push(`Dropped Sleeper games that conflict with ESPN: ${dropped.join(", ")}`);
meta.schedule_fetched_at = now();
put(KEYS.schedule(season), { data: games, fetched_at: meta.schedule_fetched_at, source: "sleeper-unofficial:/schedule + espn-unofficial:scoreboard", season });
put(KEYS.meta, meta);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(entries));
for (const e of entries) console.log(`${e.key}: ${(e.value.length / 1024).toFixed(0)} KB`);
console.log(`season ${season} week ${week}; warnings: ${warnings.length ? warnings.join(" | ") : "none"}`);
