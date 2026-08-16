import { getSocketId } from "../redis.js";
import { countAcceptedFriends } from "./friends.js";
import { getPlayerStats } from "./matchResults.js";
import { toPublicUser, type UserRow } from "./users.js";

/** ---------------------------------------------------------------------------
 *  Player profile: the career card behind the top-left chip.
 *
 *  TOFO has no playable game yet, so there are no matches to aggregate. Rather
 *  than ship an empty table nothing writes to, the whole "what has this player
 *  done" question is answered by ONE seam — `careerStats()` — which today
 *  returns a zeroed block. When the first game ships, point that function at
 *  the real per-player aggregate and everything downstream (level + XP, the
 *  rank card, win rate, K/D, the match-based achievements and their progress
 *  bars) starts working without another line changing here or on the client.
 *
 *  Cost: this endpoint is cold path — opened by a deliberate tap, never during
 *  play — and costs one PK lookup plus one index-covered count.
 * ------------------------------------------------------------------------- */

export interface CareerStats {
  matches: number;
  wins: number;
  losses: number;
  /** Percent, 0–100. null (not 0) until there's a match — the UI shows "—". */
  winRate: number | null;
  kills: number;
  deaths: number;
  kd: number | null;
  playtimeMinutes: number;
  /** Best finishing position ever reached, null before the first match. */
  bestPlacement: number | null;
}

const NO_MATCHES_YET: CareerStats = {
  matches: 0,
  wins: 0,
  losses: 0,
  winRate: null,
  kills: 0,
  deaths: 0,
  kd: null,
  playtimeMinutes: 0,
  bestPlacement: null,
};

/** THE seam — now pointing at the real aggregate.
 *
 *  ONE primary-key read of the pre-aggregated player_stats row (maintained at
 *  match-write time), returning both the career block and the XP total,
 *  because reading the same row twice to answer two questions about it is the
 *  easy way to double the cost of this page for nothing.
 *
 *  Kills and deaths stay zero: a runner has neither. They keep their place in
 *  the shape because the profile UI renders them and a future game may fill
 *  them. */
async function career(userId: string): Promise<{ stats: CareerStats; xp: number }> {
  const row = await getPlayerStats(userId);
  if (!row) return { stats: NO_MATCHES_YET, xp: 0 };
  const xp = Number(row.xp);
  if (row.matches === 0) return { stats: NO_MATCHES_YET, xp };
  return {
    stats: {
      matches: row.matches,
      wins: row.wins,
      losses: row.losses,
      winRate: Math.round((row.wins / row.matches) * 100),
      kills: 0,
      deaths: 0,
      kd: null,
      playtimeMinutes: Math.round(row.playtimeSeconds / 60),
      bestPlacement: row.bestPlacement,
    },
    xp,
  };
}

/** ---------------------------------------------------------------------------
 *  Progression
 * ------------------------------------------------------------------------- */

const MAX_LEVEL = 100;

/** XP needed to leave `level`: 1000 at L1, +500 per level after that. */
const xpForLevel = (level: number) => 1000 + (level - 1) * 500;

export interface Progression {
  level: number;
  /** XP earned inside the current level. */
  xpInLevel: number;
  /** XP the current level costs in total. */
  xpForLevel: number;
  totalXp: number;
}

/** Walks the curve — bounded by MAX_LEVEL, so no input can spin it. */
export function progression(totalXp: number): Progression {
  const total = Math.max(0, Math.floor(totalXp));
  let level = 1;
  let remaining = total;
  let need = xpForLevel(level);
  while (remaining >= need && level < MAX_LEVEL) {
    remaining -= need;
    level += 1;
    need = xpForLevel(level);
  }
  return { level, xpInLevel: remaining, xpForLevel: need, totalXp: total };
}

/** ---------------------------------------------------------------------------
 *  Rank
 * ------------------------------------------------------------------------- */

/** Placement matches a player owes before the ladder gives them a tier. */
const PLACEMENT_MATCHES = 5;

export interface RankInfo {
  /** Ladder key — drives the emblem's colour on the client. */
  tier: "unranked" | "bronze" | "silver" | "gold" | "platinum" | "diamond" | "master" | "legend";
  label: string;
  note: string;
  placementsDone: number;
  placementsNeeded: number;
}

function rankFor(stats: CareerStats): RankInfo {
  const done = Math.min(stats.matches, PLACEMENT_MATCHES);
  // Everyone is unranked until the ladder exists; the placement counter is
  // already wired so the card fills in on its own once matches are recorded.
  return {
    tier: "unranked",
    label: "Unranked",
    note:
      done === 0
        ? `Play ${PLACEMENT_MATCHES} placement matches to earn your first rank`
        : `${done} of ${PLACEMENT_MATCHES} placement matches played`,
    placementsDone: done,
    placementsNeeded: PLACEMENT_MATCHES,
  };
}

/** ---------------------------------------------------------------------------
 *  Achievements
 * ------------------------------------------------------------------------- */

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  /** Icon key the client maps to an inline SVG. */
  icon: string;
  unlocked: boolean;
  /** Countable goals show a progress bar while locked. */
  progress?: { have: number; need: number };
}

function achievementsFor(user: UserRow, friends: number, stats: CareerStats): Achievement[] {
  const goal = (have: number, need: number) => ({
    unlocked: have >= need,
    progress: { have: Math.min(have, need), need },
  });
  return [
    {
      id: "pioneer",
      name: "Pioneer",
      desc: "Joined TOFO Games during early access",
      icon: "flag",
      unlocked: true,
    },
    {
      id: "identity",
      name: "Identity",
      desc: "Claimed a one-of-a-kind gamer tag",
      icon: "userCheck",
      unlocked: user.username !== null,
    },
    { id: "wingman", name: "Wingman", desc: "Add your first friend", icon: "userPlus", ...goal(friends, 1) },
    { id: "squad", name: "Squad Goals", desc: "Grow your friend list to 5", icon: "users", ...goal(friends, 5) },
    { id: "firstBlood", name: "First Blood", desc: "Win your first match", icon: "target", ...goal(stats.wins, 1) },
    {
      id: "sharpshooter",
      name: "Sharpshooter",
      desc: "Land 100 eliminations",
      icon: "crosshair",
      ...goal(stats.kills, 100),
    },
    { id: "veteran", name: "Veteran", desc: "Play 100 matches", icon: "shield", ...goal(stats.matches, 100) },
    {
      id: "legend",
      name: "Legend",
      desc: "Climb to the top rank of a season",
      icon: "crown",
      unlocked: false,
    },
  ];
}

/** ---------------------------------------------------------------------------
 *  Assembly
 * ------------------------------------------------------------------------- */

/** `viewerId` is whoever is looking: the same card serves a player's own page
 *  and a squadmate's, with the owner-only fields blanked for everyone else. */
export async function buildProfile(user: UserRow, viewerId: string) {
  const isSelf = user.id === viewerId;
  const [friends, careerRow, socketId] = await Promise.all([
    countAcceptedFriends(user.id),
    career(user.id),
    getSocketId(user.id),
  ]);
  const stats = careerRow.stats;
  const xp = progression(careerRow.xp);
  return {
    user: toPublicUser(user),
    isSelf,
    online: socketId !== null,
    level: xp.level,
    xpInLevel: xp.xpInLevel,
    xpForLevel: xp.xpForLevel,
    totalXp: xp.totalXp,
    rank: rankFor(stats),
    stats,
    achievements: achievementsFor(user, friends, stats),
    friends,
    memberSince: user.createdAt.toISOString(),
    // Account detail, not a public stat — nobody else gets to see it.
    lastLoginAt: isSelf ? user.lastLoginAt.toISOString() : null,
  };
}
