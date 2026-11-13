/**
 * Starting tRadio's own engine binaries, through tLib's spawn broker.
 *
 * FXServer refuses `spawn` unless the resource is named in an
 * `add_unsafe_child_process_permission` line in server.cfg, and the check is
 * attributed to whichever resource's runtime made the call. tLib makes the call
 * on our behalf, so an operator running several t* resources writes one line
 * instead of one per resource.
 *
 * Nothing is widened by asking. tLib does not take a path: it takes the *name*
 * of a program from a catalog it owns, resolves the binary itself, and refuses
 * any argument that does not match the shape declared for that program. So the
 * broker's permission cannot be used to launch something tRadio did not ship —
 * not even by a bug in this file, because this file never names a path.
 *
 * There is no local-spawn fallback and there must not be one. tRadio declares
 * `dependency 'tLib'`; if the broker is missing, the resource is misinstalled,
 * and spawning here instead would quietly re-create the per-resource permission
 * the broker exists to remove. A missing broker fails loudly and says `ensure
 * tLib`.
 */

/** The programs tLib's catalog declares for tRadio. Names, deliberately not paths. */
export type Program = "llama-server" | "whisper-server" | "piper";

interface BrokerExports {
  SpawnServe(payload: string): string;
  SpawnOutput(key: string, since: number): string;
  SpawnUnserve(key: string): boolean;
  SpawnRun(payload: string): string;
  SpawnJob(id: string): string;
  SpawnCancel(id: string): boolean;
}

const MISSING_BROKER =
  "tLib's spawn broker is unavailable — add `ensure tLib` ahead of tRadio in server.cfg";

/** Resolved through globalThis: the bundler shadows a bare `exports` with the CJS one. */
function broker(): BrokerExports | null {
  try {
    const registry = (globalThis as { exports?: Record<string, Partial<BrokerExports>> }).exports;
    const tlib = registry?.tLib;
    return typeof tlib?.SpawnServe === "function" ? (tlib as BrokerExports) : null;
  } catch {
    return null;
  }
}

export interface Launch {
  /** Names the process for the broker; one long-lived process per key. */
  key: string;
  program: Program;
  args: string[];
  /** Added to the launcher's environment rather than replacing it. */
  env: Record<string, string>;
}

/**
 * A running engine.
 *
 * No working directory is ever passed. tLib defaults a program's cwd to the
 * directory its own binary lives in, which is what these engines want: every
 * path in their arguments is already absolute, so the only thing cwd decides is
 * where Windows looks for the DLLs shipped beside the binary.
 */
/** What a dead engine said on the way down, and the code it died with. */
export interface Postmortem {
  /** stderr only, oldest first. Engines print diagnostics here, not to stdout. */
  stderr: string[];
  /** The child's exit code; `null` while it is still alive. */
  code: number | null;
}

export interface Running {
  pid: number;
  alive(): boolean;
  /**
   * Why the engine died, read from the broker's retained buffer.
   *
   * MUST be called before `kill()`. `SpawnUnserve` deletes the broker's record
   * for the key, so killing first destroys the only account of the failure —
   * which is what this code used to do, one line before it needed it.
   */
  postmortem(): Postmortem;
  kill(): void;
}

/** Starts a long-lived engine. Returns the failure text rather than throwing. */
export function launchServer(launch: Launch): Running | { error: string } {
  const tlib = broker();
  if (!tlib) return { error: MISSING_BROKER };

  let answer: { pid?: number; error?: string };
  try {
    answer = JSON.parse(
      tlib.SpawnServe(
        JSON.stringify({
          key: launch.key,
          program: launch.program,
          args: launch.args,
          env: launch.env,
        }),
      ),
    ) as { pid?: number; error?: string };
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (!answer.pid) return { error: answer.error || `the launcher refused ${launch.program}` };

  const pid = answer.pid;
  /**
   * Liveness is the broker's answer, not a `process.kill(pid, 0)` probe.
   *
   * The pid is real and the probe does work, but it answers "is *a* process
   * numbered N alive", and pids are recycled — an engine that died during a two
   * minute model load can have its number handed to something else before the
   * next poll, which reads as an engine that is up and will never answer. The
   * broker tracks the child it started, so its `alive` is about this process
   * specifically.
   *
   * The cursor is advanced rather than left at zero so each poll only carries
   * output that arrived since the last one; the lines themselves are not read
   * here, but asking for all of them every 250 ms would not be free. They are
   * not lost by being skipped: the broker retains its buffer past the child's
   * exit precisely so `postmortem()` can read the whole thing once, at the
   * moment something has gone wrong.
   */
  let cursor = 0;
  return {
    pid,
    alive: () => {
      try {
        const status = JSON.parse(tlib.SpawnOutput(launch.key, cursor)) as {
          next?: number;
          alive?: boolean;
        };
        if (typeof status.next === "number") cursor = status.next;
        return status.alive === true;
      } catch {
        // The broker is the only thing that can answer this; if it cannot, the
        // engine is not usable, which is the same thing to every caller here.
        return false;
      }
    },
    postmortem: () => {
      try {
        // `0`, not the poll cursor: the cursor has already consumed the lines
        // that explain the failure. A stale `since` is clamped by the broker,
        // so asking from the start always returns everything still retained.
        const reply = JSON.parse(tlib.SpawnOutput(launch.key, 0) || "{}") as {
          lines?: Array<{ stream?: string; text?: string }>;
          /** `bytes` mode drains stderr into its own array instead. */
          stderr?: string[];
          code?: number | null;
        };
        const tagged = (reply.lines ?? [])
          .filter((line) => line.stream === "stderr" && typeof line.text === "string")
          .map((line) => line.text as string);
        const separate = (reply.stderr ?? []).filter((text) => typeof text === "string");
        return {
          stderr: [...tagged, ...separate],
          code: typeof reply.code === "number" ? reply.code : null,
        };
      } catch {
        return { stderr: [], code: null };
      }
    },
    kill: () => {
      tlib.SpawnUnserve(launch.key);
    },
  };
}

export interface OneShot {
  program: Program;
  args: string[];
  /** Added to the launcher's environment rather than replacing it. */
  env: Record<string, string>;
  /** Written to the process's stdin, which is then closed. */
  stdin: string;
  signal: AbortSignal;
}

/**
 * Runs a binary to completion. Resolves with its exit code.
 *
 * Nothing is read from stdout: the broker cannot forward a pipe across the
 * export boundary, so the one caller that needs output has the binary write a
 * file instead.
 */
export async function runOnce(job: OneShot): Promise<number> {
  const tlib = broker();
  if (!tlib) throw new Error(MISSING_BROKER);

  const started = JSON.parse(
    tlib.SpawnRun(
      JSON.stringify({
        program: job.program,
        args: job.args,
        env: job.env,
        stdin: job.stdin,
      }),
    ),
  ) as { job?: string; error?: string };
  if (!started.job) throw new Error(started.error || `the launcher refused ${job.program}`);
  return await pollJob(tlib, started.job, job.signal);
}

/** Polling, because the broker has no way to call back into this runtime. */
async function pollJob(tlib: BrokerExports, id: string, signal: AbortSignal): Promise<number> {
  for (;;) {
    if (signal.aborted) {
      // The process is the broker's child, not ours, so abandoning the wait is
      // not enough to stop it — Piper would go on writing its WAV to a scratch
      // file the caller has already deleted.
      tlib.SpawnCancel(id);
      throw new Error("aborted");
    }
    const status = JSON.parse(tlib.SpawnJob(id)) as {
      state: string;
      code?: number | null;
      error?: string;
    };
    if (status.state === "exited") {
      if (status.error) throw new Error(status.error);
      return status.code ?? 0;
    }
    if (status.state === "unknown") throw new Error("the launcher lost track of the process");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
