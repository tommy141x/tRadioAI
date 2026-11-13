import { describe, expect, test } from "bun:test";
import { createReadiness, hasAudience } from "./readiness";

const own = (id: number) => id === -900000;
const user = (
  serverId: number,
  speakerChannel: number | null,
  listeningChannels: number[] = [],
) => ({ serverId, speakerChannel, listeningChannels: new Set(listeningChannels) });

describe("dispatcher readiness", () => {
  test("warms for another speaker or listener, never its own console alone", () => {
    expect(hasAudience([154], [user(-900000, 154)], own)).toBe(false);
    expect(hasAudience([154], [user(-900000, 154), user(1, 154)], own)).toBe(true);
    expect(hasAudience([154], [user(1, 155, [154])], own)).toBe(true);
    expect(hasAudience([], [user(1, 154)], own)).toBe(false);
    expect(hasAudience([154], [user(1, 155)], own)).toBe(false);
  });

  test("starts before any transmission and coalesces occupancy sweeps", async () => {
    let starts = 0;
    let release!: () => void;
    const ready = createReadiness(() => {
      starts++;
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    ready.update(false);
    expect(starts).toBe(0);
    ready.update(true);
    ready.update(true);
    expect(starts).toBe(1);
    release();
    await Promise.resolve();
    ready.update(false);
    ready.update(true);
    expect(starts).toBe(1);
    ready.reset();
    ready.update(true);
    expect(starts).toBe(2);
    release();
  });

  /**
   * `update` is driven by the tap sweep, twice a second. A warm that fails because
   * tLib's spawn broker is absent or a model path is wrong fails the same way every
   * time, and retrying it on every sweep spends a spawn attempt and a log line for
   * an answer already known.
   */
  test("a failed warm is not retried on every sweep, and an operator's save clears it", async () => {
    let starts = 0;
    let clock = 1_000_000;
    const ready = createReadiness(
      () => {
        starts++;
        return Promise.reject(new Error("no broker"));
      },
      () => clock,
    );

    ready.update(true);
    expect(starts).toBe(1);
    await Promise.resolve();
    await Promise.resolve();

    // The next twenty sweeps are free.
    for (let i = 0; i < 20; i++) {
      clock += 500;
      ready.update(true);
    }
    expect(starts).toBe(1);

    // Past the backoff it tries again, because the fault may have been fixed.
    clock += 30_000;
    ready.update(true);
    expect(starts).toBe(2);
    await Promise.resolve();
    await Promise.resolve();

    // And a configuration change does not wait: what failed may be what changed.
    ready.reset();
    ready.update(true);
    expect(starts).toBe(3);
  });
});
