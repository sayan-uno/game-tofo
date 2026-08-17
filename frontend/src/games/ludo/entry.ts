// Ludo — client entry. The platform imports this lazily (its own chunk) and
// calls createRuntime once per match. Everything about the game lives under
// this folder; nothing outside it knows a token from a triangle, and nothing
// in here reaches the lobby, the runner, or any game added after it.
import "./ludo.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { LudoRuntime } from "./runtime";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new LudoRuntime(ctx);
