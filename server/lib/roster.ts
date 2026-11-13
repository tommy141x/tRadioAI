/**
 * Who is on the channel, and where they are.
 *
 * A dispatcher who only ever hears one voice at a time cannot do the job. The
 * roster is what makes "K32, go ahead" possible without K32 having identified
 * themselves, and what makes "closest available unit" a question with an answer
 * rather than a guess.
 *
 * Listening counts as being on the channel, the same way it does for yielding in
 * `presence.ts`: a unit monitoring six channels is on all six, and a dispatcher
 * who could not see them there would be calling units who are plainly listening.
 *
 * Pure — the caller injects the lookup and the origin point, so the rule can be
 * tested without a server or a game.
 */

export interface RosterView {
  serverId: number;
  speakerChannel: number | null;
  listeningChannels: Set<number>;
  isTalking: boolean;
}

export interface Point {
  x: number;
  y: number;
}

/** What the server knows about one unit, gathered per turn. */
export interface UnitInfo {
  callsign: string;
  unitId: string;
  /** Last status they gave, or "" if they have not given one this shift. */
  status: string;
  /** Free text from `Config.unitNote` — what a CAD says they are doing. */
  note: string;
  point: Point | null;
}

export interface RosterUnit extends UnitInfo {
  serverId: number;
  /** Metres from the turn's origin, or null when either position is unknown. */
  distance: number | null;
  /** Keyed up right now. A unit mid-transmission is not one to send anywhere. */
  talking: boolean;
}

/**
 * Cap on units described to the model.
 *
 * A busy channel can hold far more than a dispatcher would ever hold in their
 * head, and every line costs prompt budget on every turn. Nearest first, so the
 * ones cut are the ones least likely to be sent anywhere.
 */
const MAX_ROSTER = 20;

export function buildRoster(
  frequency: number,
  users: Iterable<RosterView>,
  describe: (serverId: number) => UnitInfo,
  origin: Point | null,
): RosterUnit[] {
  const units: RosterUnit[] = [];

  for (const user of users) {
    // Negative ids are dispatch consoles, including this dispatcher's own
    // synthetic talker. None of them are units anyone can send anywhere.
    if (user.serverId <= 0) continue;
    if (user.speakerChannel !== frequency && !user.listeningChannels.has(frequency)) continue;

    const info = describe(user.serverId);
    units.push({
      ...info,
      serverId: user.serverId,
      distance: distanceBetween(origin, info.point),
      talking: user.isTalking,
    });
  }

  units.sort((a, b) => {
    if (a.distance !== null && b.distance !== null) return a.distance - b.distance;
    // Units with no known position sort last rather than first: an unplaceable
    // unit is the one a dispatcher is least able to reason about.
    if (a.distance !== null) return -1;
    if (b.distance !== null) return 1;
    return a.callsign.localeCompare(b.callsign);
  });

  return units.slice(0, MAX_ROSTER);
}

function distanceBetween(a: Point | null, b: Point | null): number | null {
  if (!a || !b) return null;
  return Math.round(Math.hypot(a.x - b.x, a.y - b.y));
}

/** A rough distance a dispatcher would actually say on the air. */
export function describeDistance(metres: number | null): string {
  if (metres === null) return "position unknown";
  if (metres < 150) return "right there";
  if (metres < 1000) return `${Math.round(metres / 50) * 50} m away`;
  return `${(metres / 1000).toFixed(1)} km away`;
}
