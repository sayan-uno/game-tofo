// Trackline — client entry. The platform imports this lazily (its own chunk)
// and calls createRuntime once per match. Everything about the game lives
// under this folder; nothing outside it knows a lane from a train.
import "./trackline.css";
import type { GameModule, GameRuntimeContext } from "../../platform/types";
import { TracklineRuntime } from "./runtime";

export const createRuntime: GameModule["createRuntime"] = (ctx: GameRuntimeContext) => new TracklineRuntime(ctx);
