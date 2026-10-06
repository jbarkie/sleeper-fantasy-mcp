// Compact player record: [name, position, team, injury_status, fantasy_positions, normalized_name]
export type CompactPlayer = [string, string, string | null, string | null, string[], string];
export type PlayerMap = Record<string, CompactPlayer>;

// Projected stat lines for one week, keyed by player id. ADP-only rows are removed.
export type ProjectionMap = Record<string, Record<string, number>>;

// One league's projected fantasy points for one week, keyed by player id. Prebuilt by
// the cache job so the Worker never scores raw stat lines.
export interface LeaguePoints {
  league_id: string;
  scoring_hash: string;
  points: Record<string, number>;
}

export interface Game {
  week: number;
  home: string;
  away: string;
  date: string; // Sleeper's local game date (YYYY-MM-DD)
  status: string;
  kickoff: string | null; // ISO UTC from ESPN; null when no ESPN match
}

export interface Cached<T> {
  data: T;
  fetched_at: string;
  source: string;
  season: string;
  week?: number;
}

export interface CacheMeta {
  last_run: string;
  players_fetched_at: string | null;
  projections_fetched_at: string | null;
  leagues_scored: string[];
  schedule_fetched_at: string | null;
  season: string;
  week: number;
  warnings: string[];
}

export interface NflState {
  week: number;
  leg: number;
  season: string;
  season_type: string;
  display_week: number;
}
