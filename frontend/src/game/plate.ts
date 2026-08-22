// What a name plate says.
//
// Pulled out of lobbyScene.ts on its own so the rule can be checked without
// standing up a WebGL context: the scene imports Babylon at module scope, and
// a test that has to build a renderer to find out whether a tick appears is a
// test nobody runs.

/** The line on a member's plate.
 *
 *  Three decorations, in a fixed order and never combined by accident:
 *
 *    ✓  said they are ready to play what is picked
 *    ★  leads this party
 *
 *  The LEADER is never ticked. They are not asked — pressing START is how
 *  they say it — so a tick on their plate would be showing agreement nobody
 *  ever sought, and would make "who are we waiting for" unreadable, which is
 *  the only question the tick exists to answer.
 */
export function plateText(name: string, isLeader: boolean, ready: boolean): string {
  return `${ready && !isLeader ? "✓ " : ""}${name}${isLeader ? " ★" : ""}`;
}
