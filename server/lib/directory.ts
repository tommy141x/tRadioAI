/**
 * The rest of the system, as the dispatcher sees it.
 *
 * A dispatcher does not work one channel in isolation. They know the county
 * channel exists, that fire is on a different one, which channels are patched
 * together and which are running an alert — and that knowledge is what turns
 * "we need fire out here" into someone actually being sent.
 *
 * None of it is hard-coded. Zones, channel names, alert names and patches all
 * come from the operator's own configuration, so a server with LSPD/BCSO/fire
 * and a server with three sheriff's substations both describe themselves
 * correctly without tRadio knowing either arrangement.
 *
 * Pure — every lookup is injected, so the shape of the directory can be tested
 * without a server.
 */

import type { RosterUnit } from "./roster";

export interface ChannelEntry {
  frequency: number;
  /** Channel name from the codeplug, e.g. "DISP". "" when unnamed. */
  name: string;
  /** Zone it belongs to, e.g. "Blaine County". "" for a channel outside any zone. */
  zone: string;
  /** True when the AI dispatcher covers this channel and can hear replies on it. */
  monitored: boolean;
  /** Units on it, nearest first, capped. */
  units: RosterUnit[];
  /** Active alert's name, e.g. "SIGNAL 100". Null when the channel is running clear. */
  alert: string | null;
  /** Names of the other channels this one is patched to right now. */
  patchedWith: string[];
}

export interface DirectorySources {
  zones: Record<string, { name?: string; Channels?: unknown }>;
  monitors: (frequency: number) => boolean;
  roster: (frequency: number) => RosterUnit[];
  alertOn: (frequency: number) => string | null;
  patchOf: (frequency: number) => number[];
}

/**
 * Ceiling on channels described to the model.
 *
 * A full codeplug can run to dozens; a dispatcher works a handful. Channels with
 * somebody on them are kept first, so what gets cut is the empty ones.
 */
const MAX_CHANNELS = 14;

/** Units listed per channel. Enough to pick someone from, not a duty roster. */
const MAX_UNITS_PER_CHANNEL = 6;

export function buildDirectory(sources: DirectorySources): ChannelEntry[] {
  const byFrequency = new Map<number, ChannelEntry>();
  const names = new Map<number, string>();

  for (const zone of Object.values(sources.zones)) {
    const zoneName = typeof zone?.name === "string" ? zone.name : "";
    for (const channel of channelList(zone?.Channels)) {
      const frequency = Number(channel.frequency);
      if (!Number.isFinite(frequency) || byFrequency.has(frequency)) continue;
      const name = typeof channel.name === "string" ? channel.name : "";
      names.set(frequency, describeChannel(zoneName, name, frequency));
      byFrequency.set(frequency, {
        frequency,
        name,
        zone: zoneName,
        monitored: sources.monitors(frequency),
        units: sources.roster(frequency).slice(0, MAX_UNITS_PER_CHANNEL),
        alert: sources.alertOn(frequency),
        patchedWith: [],
      });
    }
  }

  for (const entry of byFrequency.values()) {
    for (const partner of sources.patchOf(entry.frequency)) {
      if (partner === entry.frequency) continue;
      entry.patchedWith.push(names.get(partner) ?? partner.toFixed(4));
    }
  }

  return Array.from(byFrequency.values())
    .sort((a, b) => {
      // Channels with people on them first: an empty channel is a fact about the
      // system, a busy one is a fact about right now.
      const weight = (entry: ChannelEntry) =>
        (entry.monitored ? 2 : 0) + (entry.units.length > 0 ? 4 : 0) + (entry.alert ? 1 : 0);
      const difference = weight(b) - weight(a);
      return difference !== 0 ? difference : a.frequency - b.frequency;
    })
    .slice(0, MAX_CHANNELS);
}

/** How a channel is named on the air: zone first, the way a codeplug reads. */
export function describeChannel(zone: string, name: string, frequency: number): string {
  if (zone && name) return `${zone} ${name}`;
  return name || zone || frequency.toFixed(4);
}

/**
 * Resolve whatever the model wrote into one channel.
 *
 * It writes what a dispatcher would say — "Blaine County DISP", "the county
 * channel", "460.2500" — not an id, so this matches on the pieces: an exact
 * name, then a frequency, then the best partial overlap. Ambiguity resolves to
 * nothing rather than to a guess, because putting traffic out on the wrong
 * channel is worse than saying it could not be found.
 */
export function resolveChannel(
  text: string,
  entries: readonly ChannelEntry[]
): ChannelEntry | null {
  const wanted = normalise(text);
  if (!wanted) return null;

  const asFrequency = Number.parseFloat(wanted);
  if (Number.isFinite(asFrequency)) {
    const byFrequency = entries.find((entry) => Math.abs(entry.frequency - asFrequency) < 0.0001);
    if (byFrequency) return byFrequency;
  }

  let best: { entry: ChannelEntry; score: number } | null = null;
  let tied = false;

  for (const entry of entries) {
    const full = normalise(describeChannel(entry.zone, entry.name, entry.frequency));
    const score = overlap(wanted, full, normalise(entry.name), normalise(entry.zone));
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { entry, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }

  return best && !tied ? best.entry : null;
}

function overlap(wanted: string, full: string, name: string, zone: string): number {
  if (wanted === full) return 100;
  if (name && wanted === name) return 80;

  let nameHits = 0;
  let zoneHits = 0;
  for (const word of wanted.split(" ")) {
    if (word.length < 2) continue;
    if (name && (name === word || name.startsWith(word) || word.startsWith(name))) nameHits++;
    else if (zone?.includes(word)) zoneHits++;
  }

  // The channel's own name has to appear. Without this, "the county channel"
  // lands on whichever channel that zone happens to list first — a
  // plausible-looking wrong answer, which is the worst kind.
  if (nameHits === 0) return 0;
  return nameHits * 10 + zoneHits * 4;
}

function normalise(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function channelList(raw: unknown): { frequency?: unknown; name?: unknown }[] {
  if (!raw || typeof raw !== "object") return [];
  const list = Array.isArray(raw) ? raw : Object.values(raw as object);
  return list.filter((entry): entry is { frequency?: unknown; name?: unknown } => {
    return !!entry && typeof entry === "object";
  });
}
