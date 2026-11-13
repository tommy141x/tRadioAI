/** Who is on a channel, as far as an audience count is concerned. */
export interface AudienceView {
  serverId: number;
  speakerChannel: number | null;
  listeningChannels: Set<number>;
}

/** Covered channels only; the synthetic console is not an audience. */
export function hasAudience(
  frequencies: readonly number[],
  users: Iterable<AudienceView>,
  isOwn: (serverId: number) => boolean,
): boolean {
  for (const user of users) {
    if (isOwn(user.serverId)) continue;
    if (
      frequencies.some(
        (frequency) => user.speakerChannel === frequency || user.listeningChannels.has(frequency),
      )
    )
      return true;
  }
  return false;
}

/**
 * How long a failed warm is left alone before it is tried again.
 *
 * `update` is called from the tap sweep, which runs twice a second. A warm that
 * fails for a reason that is not going to change in the next half second — tLib's
 * spawn broker absent, weights not installed, a model path typed wrong — was
 * therefore retried twice a second for as long as anybody stood on a covered
 * channel: a spawn attempt and a log line each time, for an answer already known.
 *
 * Thirty seconds is long enough that the log reads as a fault rather than as a
 * flood, and short enough that an operator who fixes the path does not have to
 * restart the resource to find out.
 */
const RETRY_AFTER_MS = 30_000;

/** Keep loaded engines across empty-channel gaps; re-evaluate after configuration changes. */
export function createReadiness(warm: () => Promise<void>, now: () => number = Date.now) {
  let requested = false;
  let failedAt = 0;
  return {
    update(occupied: boolean): void {
      if (!occupied || requested) return;
      if (failedAt > 0 && now() - failedAt < RETRY_AFTER_MS) return;
      requested = true;
      void warm().catch(() => {
        requested = false;
        failedAt = now();
      });
    },
    reset(): void {
      requested = false;
      // A configuration change is the operator having acted, so it clears the
      // backoff as well: the thing that failed may be exactly what they changed.
      failedAt = 0;
    },
  };
}
