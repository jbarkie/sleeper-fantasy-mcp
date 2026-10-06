import type { NflState } from "./types";

export const SLEEPER = "https://api.sleeper.app/v1";

export type Fetcher = (url: string) => Promise<Response>;

export class SleeperClient {
  constructor(private fetcher: Fetcher = (u) => fetch(u)) {}

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetcher(`${SLEEPER}${path}`);
    if (!res.ok) throw new Error(`Sleeper ${path} returned HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  // Documented endpoints (docs.sleeper.com)
  user = (username: string) => this.get<{ user_id: string; username: string } | null>(`/user/${encodeURIComponent(username)}`);
  state = () => this.get<NflState>(`/state/nfl`);
  leagues = (userId: string, season: string) => this.get<any[]>(`/user/${userId}/leagues/nfl/${season}`);
  league = (id: string) => this.get<any>(`/league/${id}`);
  rosters = (id: string) => this.get<any[]>(`/league/${id}/rosters`);
  users = (id: string) => this.get<any[]>(`/league/${id}/users`);
  matchups = (id: string, week: number) => this.get<any[]>(`/league/${id}/matchups/${week}`);
  transactions = (id: string, leg: number) => this.get<any[]>(`/league/${id}/transactions/${leg}`);
  trending = (type: "add" | "drop", hours = 24, limit = 25) =>
    this.get<Array<{ player_id: string; count: number }>>(`/players/nfl/trending/${type}?lookback_hours=${hours}&limit=${limit}`);
}
