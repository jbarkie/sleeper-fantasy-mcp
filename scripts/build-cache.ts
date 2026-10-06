// Builds compact cache entries outside the Worker (the full player list is too
// large to parse within the Workers Free CPU limit) and writes a wrangler
// `kv bulk put` file.
//   npx tsx scripts/build-cache.ts --out .cache/bulk.json [--players | --players-file players.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compactPlayers, compactProjections, mergeSchedule } from "../src/compact";
import { KEYS } from "../src/cache";
import { scoreAll, scoringHash } from "../src/scoring";
import { SLEEPER } from "../src/sleeper";
import type { CacheMeta, Cached, LeaguePoints, PlayerMap } from "../src/types";

// League scope comes from the Worker's own config so the two never disagree.
const toml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.toml"), "utf8");
const tomlVar = (name: string) => toml.match(new RegExp(`^${name}\\s*=\\s*"([^"]*)"`, "m"))?.[1] ?? "";
const USERNAME = tomlVar("SLEEPER_USERNAME");
const EXCLUDED = new Set(tomlVar("EXCLUDED_LEAGUES").split(",").map((x) => x.trim()).filter(Boolean));
if (!USERNAME) throw new Error("SLEEPER_USERNAME missing from wrangler.toml");

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
  players_fetched_at: null, projections_fetched_at: null, schedule_fetched_at: null, leagues_scored: [],
};

const user = await getJson(`${SLEEPER}/user/${USERNAME}`);
const leagues: any[] = (await getJson(`${SLEEPER}/user/${user.user_id}/leagues/nfl/${season}`)).filter((x: any) => !EXCLUDED.has(x.league_id));

let players: PlayerMap | null = null;
if (withPlayers) {
  // Sleeper asks that this endpoint be called at most once per day.
  const raw = playersFile ? JSON.parse(readFileSync(playersFile, "utf8")) : await getJson(`${SLEEPER}/players/nfl`);
  // Keep players on an NFL team plus anyone rostered in these leagues (e.g. a released
  // player still on someone's bench); retired players only slow down the Worker.
  const rostered = new Set<string>();
  for (const l of leagues) {
    for (const r of await getJson(`${SLEEPER}/league/${l.league_id}/rosters`)) {
      for (const id of [...(r.players ?? []), ...(r.reserve ?? []), ...(r.taxi ?? [])]) rostered.add(id);
    }
  }
  players = Object.fromEntries(Object.entries(compactPlayers(raw)).filter(([id, p]) => p[2] !== null || rostered.has(id)));
  meta.players_fetched_at = now();
  put(KEYS.players, { data: players, fetched_at: meta.players_fetched_at, source: "sleeper:/players/nfl", season } satisfies Cached<PlayerMap>);
}

const proj = compactProjections(await getJson(`${SLEEPER}/projections/nfl/regular/${season}/${week}`));
meta.projections_fetched_at = now();
// Score projections once per league here, so the Worker only reads a small points table.
for (const l of leagues) {
  const scoring = l.scoring_settings ?? {};
  const data: LeaguePoints = { league_id: l.league_id, scoring_hash: scoringHash(scoring), points: scoreAll(proj, scoring) };
  put(KEYS.points(l.league_id, season, week), {
    data, fetched_at: meta.projections_fetched_at, source: "sleeper-unofficial:/projections scored with league settings", season, week,
  } satisfies Cached<LeaguePoints>);
  meta.leagues_scored.push(l.league_id);
}

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
