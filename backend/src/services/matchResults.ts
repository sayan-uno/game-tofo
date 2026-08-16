// Writing a finished match down, and the career totals that come with it.
//
// This is the ONLY place a match reaches Postgres, and it runs exactly once
// per match, after the server's own replay has decided the standings. Nothing
// a client reported is trusted here — the numbers come from the replay.
//
// Two properties matter more than anything else in this file:
//
//  * IDEMPOTENT. `matches.match_key` is unique, so a retry, a double
//    "match ended", or a server restart mid-write can never count a win twice.
//    The insert claims the key first; losing that race means the match is
//    already recorded and there is nothing to do.
//  * ONE transaction. The match row, its players and every affected career
//    total move together, so a crash cannot leave a player with a win in the
//    history and no win in their profile.
//
// Cost: cold path — once per match, never during play. The profile page stays
// a single primary-key read because the aggregate is maintained here, at write
// time, rather than recomputed from match_players on every open.
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { matchPlayers, matches, playerStats } from "../db/schema.js";
import type { MatchEndReason, Standing } from "../shared/core/protocol.js";

export interface RecordedRunner {
  uid: string;
  /** null for a server bot — bots are stored, but they own no career. */
  userId: string | null;
  isBot: boolean;
}

export interface RecordMatchInput {
  /** The runtime match id. Unique key that makes this write idempotent. */
  matchKey: string;
  gameId: string;
  seed: number;
  reason: MatchEndReason;
  ticks: number;
  tickRate: number;
  standings: Standing[];
  runners: RecordedRunner[];
}

/** XP for one match.
 *
 *  Deliberately mostly participation: a runner who is out early still earns,
 *  because a progression bar that only moves when you win punishes the players
 *  who most need the encouragement. The win bonus is the flourish, not the
 *  substance. Scaled by how much of the field was human — a lobby of bots is
 *  practice, and M3's bot fill should not become the fastest way to level. */
export function xpFor(standing: Standing, humanShare: number): number {
  const base = 40;
  const fromScore = Math.floor(standing.score / 20);
  const placementBonus = standing.placement === 1 ? 60 : standing.placement === 2 ? 25 : 10;
  const forfeitPenalty = standing.forfeit ? 0.4 : 1;
  return Math.max(0, Math.round((base + fromScore + placementBonus) * forfeitPenalty * humanShare));
}

/** True when this standing is a win: first place. A shared first place is a
 *  draw — counted separately, and it is neither a win nor a loss. */
const isFirst = (s: Standing) => s.placement === 1;

export interface RecordedResult {
  /** false when the match was already recorded (idempotent no-op). */
  written: boolean;
  /** XP awarded per uid, for the results screen. */
  xp: Record<string, number>;
}

export async function recordMatch(input: RecordMatchInput): Promise<RecordedResult> {
  const { standings, runners } = input;
  const byUid = new Map(runners.map((r) => [r.uid, r]));
  const humans = runners.filter((r) => !r.isBot).length;
  // A solo human against three bots earns less than a full human lobby.
  const humanShare = runners.length > 0 ? Math.max(0.5, humans / runners.length) : 1;
  const firsts = standings.filter(isFirst).length;

  const xp: Record<string, number> = {};
  for (const s of standings) xp[s.uid] = xpFor(s, humanShare);

  try {
    return await db.transaction(async (tx) => {
      // Claim the key. Nothing else happens if another writer got there first.
      const inserted = await tx
        .insert(matches)
        .values({
          matchKey: input.matchKey,
          gameId: input.gameId,
          seed: input.seed,
          reason: input.reason,
          ticks: input.ticks,
          playerCount: runners.length,
        })
        .onConflictDoNothing({ target: matches.matchKey })
        .returning({ id: matches.id });
      const matchId = inserted[0]?.id;
      if (!matchId) return { written: false, xp };

      await tx.insert(matchPlayers).values(
        standings.map((s) => {
          const runner = byUid.get(s.uid);
          return {
            matchId,
            userId: runner?.userId ?? null,
            isBot: runner?.isBot ?? false,
            name: s.name,
            placement: s.placement,
            score: s.score,
            forfeit: s.forfeit,
            detail: s.detail,
          };
        })
      );

      const seconds = Math.round(input.ticks / input.tickRate);
      for (const s of standings) {
        const runner = byUid.get(s.uid);
        if (!runner?.userId) continue; // bots own no career
        const won = isFirst(s) && firsts === 1;
        const drew = isFirst(s) && firsts > 1;
        // One upsert per player: insert the first time, accumulate after.
        // best_placement keeps the LOWEST number ever seen.
        await tx
          .insert(playerStats)
          .values({
            userId: runner.userId,
            matches: 1,
            wins: won ? 1 : 0,
            losses: won || drew ? 0 : 1,
            draws: drew ? 1 : 0,
            bestPlacement: s.placement,
            totalScore: s.score,
            coins: Number(s.detail.coins ?? 0),
            distanceMetres: Number(s.detail.distance ?? 0),
            playtimeSeconds: seconds,
            xp: xp[s.uid],
          })
          .onConflictDoUpdate({
            target: playerStats.userId,
            set: {
              matches: sql`${playerStats.matches} + 1`,
              wins: sql`${playerStats.wins} + ${won ? 1 : 0}`,
              losses: sql`${playerStats.losses} + ${won || drew ? 0 : 1}`,
              draws: sql`${playerStats.draws} + ${drew ? 1 : 0}`,
              bestPlacement: sql`LEAST(COALESCE(${playerStats.bestPlacement}, ${s.placement}), ${s.placement})`,
              totalScore: sql`${playerStats.totalScore} + ${s.score}`,
              coins: sql`${playerStats.coins} + ${Number(s.detail.coins ?? 0)}`,
              distanceMetres: sql`${playerStats.distanceMetres} + ${Number(s.detail.distance ?? 0)}`,
              playtimeSeconds: sql`${playerStats.playtimeSeconds} + ${seconds}`,
              xp: sql`${playerStats.xp} + ${xp[s.uid]}`,
              updatedAt: sql`now()`,
            },
          });
      }
      return { written: true, xp };
    });
  } catch (err) {
    // A match that cannot be written must not take the match DOWN with it —
    // the players have already seen their results screen.
    console.error(`[match ${input.matchKey}] could not record result:`, err);
    return { written: false, xp };
  }
}

export type StatsRow = typeof playerStats.$inferSelect;

/** One primary-key read. Null for a player who has not finished a match. */
export async function getPlayerStats(userId: string): Promise<StatsRow | null> {
  const [row] = await db.select().from(playerStats).where(eq(playerStats.userId, userId));
  return row ?? null;
}
