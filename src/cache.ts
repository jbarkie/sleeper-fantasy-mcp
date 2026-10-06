import type { CacheMeta, Cached, Game, PlayerMap, ProjectionMap } from "./types";

export const KEYS = {
  players: "players",
  projections: (season: string, week: number) => `projections:${season}:${week}`,
  schedule: (season: string) => `schedule:${season}`,
  meta: "meta",
};

export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
}

// Parsed values are kept in isolate memory so warm requests skip JSON parsing.
const memo = new Map<string, { at: number; value: unknown }>();
const MEMO_MS = 5 * 60 * 1000;

async function read<T>(kv: KVLike, key: string): Promise<T | null> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < MEMO_MS) return hit.value as T;
  const text = await kv.get(key, "text");
  const value = text === null ? null : (JSON.parse(text) as T);
  memo.set(key, { at: Date.now(), value });
  return value;
}

export const clearMemo = () => memo.clear();

export class DataCache {
  constructor(private kv: KVLike) {}
  players = () => read<Cached<PlayerMap>>(this.kv, KEYS.players);
  projections = (season: string, week: number) => read<Cached<ProjectionMap>>(this.kv, KEYS.projections(season, week));
  schedule = (season: string) => read<Cached<Game[]>>(this.kv, KEYS.schedule(season));
  meta = () => read<CacheMeta>(this.kv, KEYS.meta);
}
