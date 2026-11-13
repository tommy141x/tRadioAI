/**
 * "Is a real dispatcher covering this channel?"
 *
 * The AI dispatcher stands down when a human signs on, because two voices answering
 * the same unit is worse than either alone. What counts as covering a channel is
 * deliberately generous: a dispatcher who has the channel selected OR is merely
 * listening to it is present. A dispatcher listening to eight channels is exactly the
 * operator this feature exists to help, and having the AI talk over them because they
 * had a different one selected would be a bug they could not explain.
 *
 * Takes tRadio's list of human dispatchers (`getStations().humans`, which never
 * contains a station, this resource's own included) so the rule can be tested without
 * a server. Nothing here needs an "is this one mine" filter: tRadio has already
 * excluded every station, and without that the dispatcher would yield to itself and
 * never speak again.
 */

export interface HumanDispatcher {
  serverId: number;
  /** The channel they have selected, if any. */
  selected: number | null;
  listening: readonly number[];
}

export function humanDispatcherOn(frequency: number, humans: readonly HumanDispatcher[]): boolean {
  return humans.some((human) => human.selected === frequency || human.listening.includes(frequency));
}

/**
 * Is a human dispatcher signed on ANYWHERE, on any channel?
 *
 * The sibling above is per-frequency; this one deliberately is not. A 911 call is not
 * on a channel, so there is no channel to be covered — the question is whether anybody
 * is watching the dispatch panel at all, because somebody watching it can see the queue
 * and is about to click the call themselves. Taking it out from under them is worse
 * than the call waiting five seconds.
 */
export function humanDispatcherPresent(humans: readonly HumanDispatcher[]): boolean {
  return humans.length > 0;
}
