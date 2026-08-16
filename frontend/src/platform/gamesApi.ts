import { api } from "../api/http";
import type { GameInfo } from "../types";
import { getClientGame } from "./games";

let cached: GameInfo[] | null = null;
let inflight: Promise<GameInfo[]> | null = null;

/** The playable game list — server metadata filtered to games this build can
 *  actually run. Cached for the session; `force` refetches (a pack version may
 *  have moved while the tab was open). */
export function fetchGames(force = false): Promise<GameInfo[]> {
  if (cached && !force) return Promise.resolve(cached);
  return (inflight ??= api
    .get<{ games: GameInfo[] }>("/api/games")
    .then(({ games }) => {
      cached = games.filter((g) => getClientGame(g.id));
      return cached;
    })
    .finally(() => {
      inflight = null;
    }));
}

export const getGameInfo = (id: string): GameInfo | undefined => cached?.find((g) => g.id === id);
