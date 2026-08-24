// Client-side game registry: game id → its lazily-imported module. The ONLY
// place a game folder is named outside itself. Metadata (name, pack URL,
// sizes) comes from the server (GET /api/games); this list just says which
// games this build can run — a server game missing here is simply not shown.
import type { GameModule } from "./types";

export interface GameClientDefinition {
  id: string;
  load(): Promise<GameModule>;
}

const CLIENT_GAMES: GameClientDefinition[] = [
  { id: "trackline", load: () => import("../games/trackline/entry") },
  { id: "ludo", load: () => import("../games/ludo/entry") },
  { id: "carrom", load: () => import("../games/carrom/entry") },
];

export const getClientGame = (id: string): GameClientDefinition | undefined => CLIENT_GAMES.find((g) => g.id === id);
