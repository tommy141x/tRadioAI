/**
 * The local engine: inference on the operator's own machine, by default.
 *
 * The trick that keeps this small is that the local backends are HTTP servers
 * too, so a local capability is not a second client — it is the same HTTP client
 * pointed at `127.0.0.1`. Local and hosted therefore share one code path, one set
 * of timeouts and one set of failure modes, which is the only reason "default to
 * local" does not double the surface area of this feature. They do not share a
 * route, though: llama-server serves `/v1/chat/completions` like a hosted API,
 * but whisper-server serves `/inference` and has no `/v1/audio/transcriptions`,
 * which is why a launch names its own path and this file hands back a full URL.
 *
 * Speech is the exception, because no equivalent local server exists: Piper is a
 * one-shot binary that reads a line and writes raw samples. It is run per
 * utterance instead of supervised, which suits a dispatcher — transmissions are
 * seconds apart, not streamed, and a voice that is never loaded costs nothing.
 * Fidelity is not the constraint either: the next stage is an 8 kHz vocoder and
 * an RF chain, so Piper is already better than the channel can carry.
 *
 * Nothing is downloaded, ever. Weights and binaries ship in the release and are
 * resolved from disk; a missing one is reported by name and leaves the
 * dispatcher off, the same way a missing vocoder does. An operator who wants to
 * point at an install they already have sets `localRoot`.
 *
 * Covered channel occupancy warms the local servers before the first turn.
 * Empty channels, disabled dispatch and hosted capabilities do not spawn them.
 * Endpoint lookup remains a fallback for a turn arriving during warm-up.
 *
 * Starting one is also the last resort rather than the first move: `shared-engine`
 * asks tLib whether another resource already has these exact weights up. On a box
 * running tAI as well that saves a second copy of the model; on a box running
 * tRadio alone the lookup finds nothing and this file behaves as if it were not
 * there at all.
 */

import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, freemem, totalmem } from "node:os";
import path from "node:path";
import { aiLog } from "./logger";
import { UNCHECKED as UNCHECKED_MODEL, verifyPinnedModel } from "./model-integrity";
import { trimTrailingSilence } from "./audio";
import type { Capability } from "./providers";
import { advertiseEngine, sharedEngine } from "./shared-engine";
import { launchServer, type Postmortem, type Program, type Running, runOnce } from "./spawn";

/**
 * Loopback only, and deliberately not configurable.
 *
 * These ports carry unauthenticated inference. Binding them anywhere else would
 * put an open model endpoint on the box, which is not a thing an operator
 * should be able to do by typing a number into a config file.
 */
const LOOPBACK = "127.0.0.1";

/** Capabilities a local server holds open. Speech is per-utterance and has no port. */
type ServedCapability = Exclude<Capability, "speech">;

/** Chosen well clear of tAI's 18191/18205 so both resources can run at once. */
const PORTS: Record<ServedCapability, number> = {
  text: 18291,
  transcription: 18292,
};

/** Piper's own default; overridden by whatever the voice's config declares. */
const PIPER_RATE = 22050;

export interface LocalPaths {
  /** Root the binaries and models are resolved under. Defaults to the resource. */
  root: string;
  textModel: string;
  transcribeModel: string;
  /** Directory of `<voice>.onnx` files. Defaults to `server/models/voices`. */
  voicesDir: string;
}

export interface LocalEndpoint {
  /** The full URL this capability is served at, route included. */
  url: string;
  /** Model name to send. Local servers serve one model and ignore it, but the route requires it. */
  model: string;
}

interface Engine {
  running: Running;
  url: string;
  startedAt: number;
}

const engines = new Map<ServedCapability, Engine>();
const starting = new Map<ServedCapability, Promise<LocalEndpoint | null>>();

/**
 * Children that have been spawned but are not serving yet.
 *
 * `engines` only gains an entry once the engine answers its probe, and a 2.5 GB
 * GGUF takes long enough that {@link READY_TIMEOUT_MS} is two minutes. For all
 * of that window the process exists, holds its port and is invisible to
 * {@link stopLocalEngines}, which walks `engines` alone — so a resource stop
 * during a model load leaves llama-server running and the next start finds the
 * port taken by something it did not spawn.
 *
 * Pre-warming made this the common case rather than the rare one: engines now
 * start the moment somebody appears on a covered channel, so a player who joins
 * and leaves inside two minutes is enough.
 */
const launching = new Map<ServedCapability, Running>();

/**
 * Bumped by every stop, so a start that is already in flight can tell that the
 * world it was started for is gone.
 *
 * Killing the child in `stopLocalEngines` is not sufficient on its own: the
 * start is still awaiting its probe and would go on to register a dead engine,
 * or — worse, if the kill lands between the probe succeeding and the `set` —
 * register a live one nothing will ever stop.
 */
let generation = 0;
const failed = new Map<Capability, string>();
const voices = new Map<string, Voice | null>();
let artifacts: Record<string, string> | null = null;
let paths: LocalPaths | null = null;

/**
 * Where one engine's binary and its own libraries live.
 *
 * A directory per engine rather than one shared `server/bin/win`, because llama.cpp and
 * whisper.cpp both ship `ggml.dll` and `ggml-cpu-*.dll` built from different
 * revisions. Unpacked side by side one silently overwrites the other and
 * whichever loses gets a library it was not linked against.
 */
function binDir(root: string, engine: string): string {
  return path.join(root, "server", "bin", process.platform === "win32" ? "win" : "linux", engine);
}

function exe(name: string): string {
  return process.platform === "win32" ? `${name}.exe` : name;
}

/**
 * What an engine needs adding to the launcher's environment.
 *
 * On Linux each engine's shared objects sit beside its own binary rather than in
 * a system path, and not every upstream release build carries an `$ORIGIN`
 * rpath. Naming the directory costs nothing on a build that does not need it.
 */
function engineEnv(dir: string): Record<string, string> {
  if (process.platform === "win32") return {};
  const existing = process.env.LD_LIBRARY_PATH;
  return { LD_LIBRARY_PATH: existing ? `${dir}${path.delimiter}${existing}` : dir };
}

export function configureLocal(next: Partial<LocalPaths>): void {
  const root = next.root?.trim() ? next.root.trim() : resourceRoot();
  const changed = !paths || paths.root !== root;
  paths = {
    root,
    textModel: next.textModel?.trim() || "",
    transcribeModel: next.transcribeModel?.trim() || "",
    voicesDir: next.voicesDir?.trim() || "",
  };
  // A root change invalidates anything already running against the old one.
  if (changed) stopLocalEngines();
  failed.clear();
  voices.clear();
  artifacts = null;
}

/**
 * What this resource's installed weights are, by name.
 *
 * Supplied by the release in `server/models/artifacts.json` rather than computed:
 * hashing a multi-gigabyte GGUF at every boot to discover something the build
 * already knows would cost a minute of startup to learn nothing new. It is the
 * identity another resource matches against when deciding whether it can share
 * this engine, so an operator who swaps the weights should edit it to say so.
 */
function workloadFor(capability: ServedCapability): string {
  if (!artifacts) {
    artifacts = {};
    const manifest = path.join(paths?.root ?? resourceRoot(), "server", "models", "artifacts.json");
    try {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (parsed && typeof parsed === "object") {
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof value === "string" && value.trim()) artifacts[key] = value.trim();
        }
      }
    } catch {
      // No manifest is not an error — it only means this install does not share.
    }
  }
  return artifacts[capability] ?? "";
}

/** Exported so `weights.ts` resolves the same root this module reads models from. */
export function resourceRoot(): string {
  try {
    return GetResourcePath(GetCurrentResourceName());
  } catch {
    return process.cwd();
  }
}

function resolveModel(configured: string, fallback: string): string | null {
  const root = paths?.root ?? resourceRoot();
  const candidate = configured
    ? path.isAbsolute(configured)
      ? configured
      : path.join(root, configured)
    : path.join(root, fallback);
  return existsSync(candidate) ? candidate : null;
}

interface Launch {
  /**
   * The name tLib's catalog knows this engine by, which is what actually starts it.
   *
   * `binary` is still resolved here, but only for the two things that have to
   * happen on this side of the export boundary: reporting a missing runtime by
   * path, and putting the mode bit back on Linux. The launcher is never told a
   * path — it resolves the program itself and refuses anything outside tRadio.
   */
  program: Program;
  binary: string;
  model: string | null;
  args: (model: string, port: number) => string[];
  /** Model name the route sends. Local servers serve one model, but the field is required. */
  routeModel: string;
  /**
   * Path this server actually serves the capability on.
   *
   * Not a constant, because not every local server is OpenAI-shaped: llama-server
   * serves `/v1/chat/completions`, but whisper-server serves `/inference` and has
   * no `/v1/audio/transcriptions` at all.
   */
  route: string;
  /**
   * A URL that answers 200 only once the model is loaded and `route` will work.
   *
   * Binding the port happens long before that — llama-server accepts connections
   * while it is still reading a gigabyte off disk — so "the process started" is
   * not a usable readiness signal and a turn fired at one is a connection error
   * or a 503.
   */
  probe: (port: number) => string;
}

/** Longest a cold model load is allowed to take before the capability is written off. */
const READY_TIMEOUT_MS = 120000;
const READY_POLL_MS = 250;

/**
 * Cores an engine may use, which is deliberately not all of them.
 *
 * llama.cpp's worker threads spin rather than sleep while a turn is in flight,
 * so letting it take every core does not slow the game server down, it stalls
 * it: FXServer's tick competes with threads that never yield. Half the box,
 * minimum one, leaves the server the half it needs. A dispatch turn is forty
 * tokens and nobody is waiting on it the way they wait on a frame.
 */
function engineThreads(): string {
  return String(Math.max(1, Math.floor(cpus().length / 2)));
}

/**
 * How each engine is started. Exported for the argument tests: the flags are a
 * compatibility contract with two upstream binaries, and one of them (ffmpeg,
 * via whisper's `--convert`) has already shipped as an outage.
 */
export function launchFor(capability: ServedCapability): Launch {
  const root = paths?.root ?? resourceRoot();
  switch (capability) {
    case "text":
      return {
        program: "llama-server",
        binary: path.join(binDir(root, "llama"), exe("llama-server")),
        /**
         * Qwen3-4B-Instruct-2507, and the smaller model it replaced is worth
         * recording because the swap looks like an extravagance.
         *
         * Measured 2026-09-19 with `scripts/probe-reply-first.ts`, twelve turns
         * over six transmissions — three that call for a tool, three that must
         * produce none:
         *
         *   qwen3-1.7b-q4_k_m            6 of 12 tool choices right
         *   qwen3-4b-instruct-2507       12 of 12
         *
         * The 1.7B did not fail at the margins. It ran `set_unit_status` on
         * "thanks for that", and it answered three different transmissions with
         * the identical line "King 41, copy, out at the station" — a place and a
         * status lifted from *another unit's* entry in the channel history, which
         * is the one thing the system prompt forbids absolutely. The 4B answered
         * a bare call-up with "Go King 41", which is the procedure this prompt
         * asks for and which the 1.7B never once produced.
         *
         * Not a tuning problem: the 1.7B is a hybrid reasoning model run with
         * thinking suppressed, and off-script it collapses onto whatever it last
         * saw. tAI reached the same conclusion about the same weights
         * independently, after a repetition penalty failed to fix it.
         *
         * It costs 2.5 GB against 1.2 GB and it decodes more slowly. The decode
         * cost is mostly paid back rather than absorbed: the reply is generated
         * before the actions now (see `provider.ts`), and speech starts on it
         * while the actions are still arriving, so what grew is the tail nobody
         * is waiting on. The download is a real cost and is not paid back — but
         * a dispatcher that marks the wrong unit out of service is worse than a
         * slow one, and this one did that half the time.
         */
        model: resolveModel(
          paths?.textModel ?? "",
          "server/models/qwen3-4b-instruct-2507-q4_k_m.gguf",
        ),
        args: (model, port) => [
          "--model",
          model,
          "--host",
          LOOPBACK,
          "--port",
          String(port),
          // A dispatch turn is a short prompt and a short answer. A large
          // context here costs memory every server pays for and no turn uses.
          "--ctx-size",
          "4096",
          "--threads",
          engineThreads(),
          "--no-webui",
          // Qwen3 is a reasoning model and will spend the whole token budget
          // thinking, returning an empty `content` with the thoughts in
          // `reasoning_content`. A dispatcher answering a radio call has nothing
          // to think about that is worth the latency.
          "--reasoning",
          "off",
        ],
        routeModel: "local",
        route: "/v1/chat/completions",
        // 503 until the weights are in memory, which is exactly the distinction
        // being waited on.
        probe: (port) => `http://${LOOPBACK}:${port}/health`,
      };
    case "transcription":
      return {
        program: "whisper-server",
        binary: path.join(binDir(root, "whisper"), exe("whisper-server")),
        model: resolveModel(paths?.transcribeModel ?? "", "server/models/ggml-base.en-q5_1.bin"),
        args: (model, port) => [
          "--model",
          model,
          "--host",
          LOOPBACK,
          "--port",
          String(port),
          "--threads",
          engineThreads(),
          // NO `--convert`. It makes whisper-server shell out to ffmpeg, and
          // ffmpeg is not present in the slim Debian images most game panels
          // run — where the engine then exits 0 during startup having printed
          // only `sh: 1: ffmpeg: not found`, which reached the operator as
          // "transcription is unavailable: local transcription engine stopped
          // while loading" and cost two customers their AI dispatcher.
          //
          // It was never doing anything for us. `clip.ts` resamples to
          // STT_SAMPLE_RATE (16 kHz) and `buildWav` emits mono 16-bit PCM, so
          // every request already arrives in the one format whisper reads
          // natively. `--convert` exists for callers posting mp3 or a foreign
          // sample rate; we post neither.
        ],
        routeModel: "whisper",
        route: "/inference",
        // No health route, but whisper-server loads the model before it listens,
        // so serving its index at all means it is ready.
        probe: (port) => `http://${LOOPBACK}:${port}/`,
      };
  }
}

/**
 * The endpoint for a locally served capability, starting it if necessary.
 *
 * Null means this machine cannot serve it — no binary, no weights, or a process
 * that would not stay up. The caller's job is then to leave the dispatcher
 * quiet, not to reach for a hosted provider the operator did not configure.
 *
 * `signal` is the turn's deadline, and aborting it abandons the wait without
 * abandoning the load: a first transmission that arrives before the model is in
 * memory goes unanswered rather than holding a talker slot for two minutes, and
 * the engine it started is ready for the transmission after it.
 */
export function localEndpoint(
  capability: Capability,
  signal?: AbortSignal,
): Promise<LocalEndpoint | null> {
  // Local speech is a process per utterance, not a server; `localSpeech` owns it.
  if (capability === "speech") return Promise.resolve(null);

  // Our own engine wins once it is up: adopting someone else's mid-shift would
  // abandon a model that is already loaded and paid for.
  const running = engines.get(capability);
  if (running?.running.alive())
    return Promise.resolve({ url: running.url, model: launchFor(capability).routeModel });
  // Checked rather than trusted, because an engine started through tLib is not
  // a child of this runtime and there is no exit event to clear the entry.
  if (running) engines.delete(capability);

  // A model load is slow enough that a second turn arrives during the first
  // one's. Both wait on the same start rather than racing for the port.
  const pending = starting.get(capability);
  if (pending) return untilAborted(pending, signal);

  const attempt = startEngine(capability).finally(() => starting.delete(capability));
  starting.set(capability, attempt);
  return untilAborted(attempt, signal);
}

/** Stop waiting on a start when the turn gives up, and leave the start running. */
function untilAborted(
  pending: Promise<LocalEndpoint | null>,
  signal?: AbortSignal,
): Promise<LocalEndpoint | null> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const giveUp = () => resolve(null);
    signal.addEventListener("abort", giveUp, { once: true });
    pending.then(
      (endpoint) => {
        signal.removeEventListener("abort", giveUp);
        resolve(endpoint);
      },
      () => {
        signal.removeEventListener("abort", giveUp);
        resolve(null);
      },
    );
  });
}

async function startEngine(capability: ServedCapability): Promise<LocalEndpoint | null> {
  const era = generation;
  // Checked before the record of an earlier failure, not after: a box with no
  // runtime of its own can still be served by a resource that started later.
  const adopted = await adoptShared(capability);
  if (adopted) return adopted;

  if (failed.get(capability)) return null;

  const launch = launchFor(capability);

  if (!existsSync(launch.binary)) {
    return markFailed(capability, `no local runtime at ${launch.binary}`);
  }
  if (!launch.model) {
    return markFailed(capability, `no local ${capability} model installed`);
  }

  ensureExecutable(launch.binary);

  const port = PORTS[capability];
  const url = `http://${LOOPBACK}:${port}${launch.route}`;

  const blocked = await reclaimPort(capability, port, launch.probe(port));
  if (blocked) return markFailed(capability, blocked);

  const started = launchServer({
    key: capability,
    program: launch.program,
    args: launch.args(launch.model, port),
    env: engineEnv(path.dirname(launch.binary)),
  });
  if ("error" in started) {
    return markFailed(capability, `local ${capability} would not start — ${started.error}`);
  }

  rememberPid(capability, started.pid);
  // Visible to `stopLocalEngines` from here on, which is the point: everything
  // below this line can take two minutes.
  launching.set(capability, started);
  aiLog.info(`local: starting ${capability} engine, loading ${path.basename(launch.model)}`);
  const ready = await waitUntilServing(launch.probe(port), () => !started.alive());
  if (launching.get(capability) === started) launching.delete(capability);

  // Stopped while it loaded. The child is already dead — `stopLocalEngines`
  // killed it, which is also why the probe gave up — and registering it now
  // would put an unreachable engine in the map for the next turn to find.
  if (era !== generation) {
    started.kill();
    return null;
  }

  if (!ready) {
    const died = !started.alive();
    // Read the engine's own account BEFORE killing it: `kill()` routes through
    // the broker's unserve, which deletes the retained output for this key.
    const why = started.postmortem();
    started.kill();
    engines.delete(capability);

    // Only when the child DIED, and only here. The panel's "Ready" is a size
    // check, so a model that is the right length and the wrong bytes reads as
    // installed forever and shows up exactly like this. Hashing it costs
    // seconds and is indefensible at boot; on a failure already in hand it is
    // the difference between "delete this file" and "stop looking at the
    // model". An engine that merely never answered is still alive and is not a
    // corruption story, so it is not worth the I/O.
    const integrity = died
      ? await verifyPinnedModel(resourceRoot(), launch.model)
      : UNCHECKED_MODEL;

    return markFailed(
      capability,
      died
        ? `local ${capability} engine stopped while loading${exitNote(why)}` +
            `${engineSaid(why)}${integrity.note}${memoryNote(launch.model)}`
        : `local ${capability} engine did not answer within ${READY_TIMEOUT_MS / 1000}s` +
            engineSaid(why),
    );
  }

  engines.set(capability, { running: started, url, startedAt: Date.now() });
  aiLog.info(`local: ${capability} engine ready on ${url}`);
  advertiseEngine(capability, workloadFor(capability), url, launch.routeModel);
  return { url, model: launch.routeModel };
}

/**
 * Another resource's engine for this workload, if one is up and answering.
 *
 * The registry is a note somebody left, not a promise: the resource that filed it
 * withdraws on a clean stop, but a killed one never gets to. Adopting an address
 * without checking would spend a whole turn discovering it, so liveness is
 * confirmed first — at the origin rather than the route, because a capability
 * route is a POST and every engine answers a bare GET differently. Any reply at
 * all means something is listening, and that is the question being asked.
 */
async function adoptShared(capability: ServedCapability): Promise<LocalEndpoint | null> {
  const shared = sharedEngine(capability, workloadFor(capability));
  if (!shared) return null;

  let origin: string;
  try {
    origin = new URL(shared.url).origin;
  } catch {
    return null;
  }

  if (!(await answers(origin))) {
    aiLog.warn(`local: ${shared.resource}'s ${capability} engine is advertised but not answering`);
    return null;
  }
  return { url: shared.url, model: shared.model };
}

/**
 * Make a shipped binary executable, on the platform where that is a concept.
 *
 * Not defensiveness — it is the most likely way a correct release fails on
 * Linux. Every ordinary route this resource takes to a server drops the mode
 * bit: a zip has no concept of one, NTFS cannot store one, and SFTP clients
 * transfer contents rather than permissions. What reaches the operator is
 * `EACCES` from spawn, which reads like a problem with their server rather than
 * a missing `+x` on one file.
 *
 * tLib's spawn host does the same thing to whatever it is about to exec, and
 * that is not a duplicate to be deleted — the two cover different files. This
 * one can only name the binary it resolved; when the release carries the
 * bundled glibc loader (`server/bin/linux/<engine>/lib/ld-linux-x86-64.so.2`),
 * the file handed to execve is the *loader*, which this side never names
 * because the broker takes a program name and resolves every path itself. Keep
 * this one as well so the engine binary gets its bit back even when the broker
 * never sees that file.
 */
function ensureExecutable(binary: string): void {
  if (process.platform === "win32") return;
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    try {
      chmodSync(binary, 0o755);
    } catch {
      // Left to the spawn, which names the file and the syscall.
    }
  }
}

/** Where an engine's pid is recorded, so a later run can recognise its own orphan. */
function pidFile(capability: ServedCapability): string {
  return path.join(paths?.root ?? resourceRoot(), "server", "models", `.${capability}.pid`);
}

function rememberPid(capability: ServedCapability, pid: number | undefined): void {
  if (!pid) return;
  try {
    writeFileSync(pidFile(capability), String(pid), "utf8");
  } catch {
    // Only costs the ability to reclaim this engine after a hard crash.
  }
}

function forgetPid(capability: ServedCapability): void {
  try {
    rmSync(pidFile(capability), { force: true });
  } catch {
    // Stale at worst, and a stale pid is checked for liveness before it is used.
  }
}

/**
 * A probe request whose body is always consumed.
 *
 * The draining is the whole point. A response left unread keeps a live body
 * stream, and when the timeout that came with the request fires a moment later
 * it aborts that stream after its reader has been released — which surfaces as
 * `Invalid state: Reader released`, thrown from a timer, as an unhandled
 * rejection nobody can catch. The bodies here are a few bytes; reading them is
 * cheaper than the failure is to diagnose.
 */
async function probe(url: string): Promise<Response | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    await response.arrayBuffer();
    return response;
  } catch {
    return null;
  }
}

/** Whether anything at all is listening, regardless of what it thinks of the request. */
async function answers(url: string): Promise<boolean> {
  return (await probe(url)) !== null;
}

/**
 * Clear an engine this resource left behind, so a restart is not locked out.
 *
 * FXServer being killed rather than stopped leaves the engine running and
 * holding the port. Without this the next start spawns a process that cannot
 * bind, exits immediately, and takes the dispatcher down until someone finds the
 * orphan by hand — the failure is a server that worked yesterday and is silent
 * today for no visible reason.
 *
 * Two conditions before anything is killed: the pid came from our own file, and
 * the port is actually being served. A pid on its own is not enough, because
 * pids are reused and the one recorded last week may belong to something else
 * entirely now. Something serving the port with no pid of ours behind it is
 * reported rather than killed — it is not ours to stop.
 */
async function reclaimPort(
  capability: ServedCapability,
  port: number,
  probe: string,
): Promise<string> {
  if (!(await answers(probe))) return "";

  const pid = recordedPid(capability);
  if (!pid || !alive(pid)) {
    return `port ${port} is already in use by something this resource did not start`;
  }

  aiLog.warn(`local: reclaiming the ${capability} engine a previous run left behind (pid ${pid})`);
  try {
    process.kill(pid);
  } catch {
    // Exited between the liveness check and the signal, which is the goal.
  }

  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await answers(probe))) {
      forgetPid(capability);
      return "";
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return `the previous ${capability} engine (pid ${pid}) would not release port ${port}`;
}

function recordedPid(capability: ServedCapability): number {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(capability), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

function alive(pid: number): boolean {
  try {
    // Signal 0 tests for the process without touching it.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until the engine serves its probe, it dies, or the deadline passes.
 *
 * Connection errors are the normal case for most of this loop — the port is not
 * open yet — so they are not distinguishable from a failure here. What makes the
 * wait terminate on a genuinely broken engine is `dead`, which watches the child
 * rather than the socket.
 */
async function waitUntilServing(url: string, dead: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (dead()) return false;
    // Not listening yet, or listening but not finished loading, are both the
    // normal case here and both read as "no".
    const response = await probe(url);
    if (response?.ok) return true;
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return false;
}

interface Voice {
  model: string;
  sampleRate: number;
}

function piperDir(): string {
  return binDir(paths?.root ?? resourceRoot(), "piper");
}

function piperBinary(): string {
  return path.join(piperDir(), exe("piper"));
}

function voicesDir(): string {
  const root = paths?.root ?? resourceRoot();
  const configured = paths?.voicesDir ?? "";
  if (!configured) return path.join(root, "server", "models", "voices");
  return path.isAbsolute(configured) ? configured : path.join(root, configured);
}

/**
 * Locate a voice and read the rate it was trained at.
 *
 * The rate has to come from the voice's own config rather than a constant:
 * Piper ships voices at 16000 and 22050, and guessing wrong does not fail, it
 * just plays the dispatcher back at the wrong pitch and speed.
 */
function voiceFor(name: string): Voice | null {
  const cached = voices.get(name);
  if (cached !== undefined) return cached;

  const model = path.join(voicesDir(), `${name}.onnx`);
  let resolved: Voice | null = null;
  if (existsSync(model)) {
    let sampleRate = PIPER_RATE;
    try {
      const config = JSON.parse(readFileSync(`${model}.json`, "utf8")) as {
        audio?: { sample_rate?: unknown };
      };
      const declared = Number(config.audio?.sample_rate);
      if (Number.isFinite(declared) && declared > 0) sampleRate = declared;
    } catch {
      aiLog.debug(`local: ${name} has no readable config; assuming ${PIPER_RATE} Hz`);
    }
    resolved = { model, sampleRate };
  }

  voices.set(name, resolved);
  return resolved;
}

/** Why local speech cannot run, or an empty string when it can. */
export function localSpeechFailure(voice: string): string {
  const binary = piperBinary();
  if (!existsSync(binary)) return `no local speech runtime at ${binary}`;
  if (!voice) return "no voice configured";
  if (!voiceFor(voice)) return `no local voice "${voice}" in ${voicesDir()}`;
  return "";
}

let utterance = 0;

/**
 * Where Piper is told to put the WAV it produces.
 *
 * Inside the resource, not `os.tmpdir()`. FXServer's filesystem permissions are
 * per-device, and a resource is its own device: anything under the resource
 * directory is readable and writable, while an absolute path into `%TEMP%` has
 * no device at all and fails with "Access to this API has been restricted. Use
 * --allow-fs-read to manage permissions" — measured, after the first version of
 * this wrote there.
 *
 * `models/` rather than a subdirectory created on the fly, because it is
 * shipped with the resource and is therefore known to exist; the file is
 * deleted as soon as its samples have been read.
 */
function speechScratch(): string {
  const root = paths?.root ?? resourceRoot();
  return path.join(root, "server", "models", `.speech-${process.pid}-${utterance++}.wav`);
}

/**
 * Speak one line locally.
 *
 * Piper takes the line on stdin and writes a WAV where it is told to. A file
 * rather than its raw-stdout mode because the launcher is tLib rather than this
 * runtime, and a pipe does not cross an export boundary — the parsing that costs
 * is a 44-byte header read once per transmission.
 */
export async function localSpeech(
  text: string,
  voice: string,
  signal: AbortSignal,
): Promise<{ pcm: Int16Array; sampleRate: number }> {
  const reason = localSpeechFailure(voice);
  if (reason) throw new Error(reason);
  const resolved = voiceFor(voice) as Voice;

  const dir = piperDir();
  ensureExecutable(piperBinary());
  const out = speechScratch();

  try {
    const code = await runOnce({
      program: "piper",
      args: [
        "--model",
        resolved.model,
        // Explicit rather than relative to the binary: Piper resolves this
        // against the working directory on some builds, and ours is not its.
        "--espeak_data",
        path.join(dir, "espeak-ng-data"),
        "-f",
        out,
      ],
      env: engineEnv(dir),
      // One line, because Piper treats a newline as an utterance boundary and
      // `sayable` has already flattened the reply into one.
      stdin: `${text}\n`,
      signal,
    });
    if (code !== 0) throw new Error(`local speech exited with code ${code}`);

    const spoken = readWav(readFileSync(out));
    if (!spoken || spoken.pcm.length === 0) throw new Error("local speech produced no audio");
    // Piper pads the end of every utterance — `--sentence_silence` defaults to 0.2 s
    // and the model adds its own tail. Measured 0.28-0.42 s across six readbacks,
    // against 0.00-0.08 s at the start, so only the end is worth cutting. Airtime is
    // capacity on a channel with one mouth: a third of a second on every
    // transmission is small, free and certain.
    return {
      pcm: trimTrailingSilence(spoken.pcm, spoken.sampleRate),
      sampleRate: spoken.sampleRate,
    };
  } finally {
    try {
      rmSync(out, { force: true });
    } catch {
      // A temp file the OS will clear; not worth failing a transmission over.
    }
  }
}

/**
 * The samples out of a RIFF/WAVE file, and the rate they were written at.
 *
 * Chunks are walked rather than assumed at fixed offsets: a 44-byte header is
 * the common case, not a guarantee, and a `LIST` chunk ahead of `data` would
 * otherwise be decoded as audio and play as a burst of noise.
 */
function readWav(bytes: Buffer): { pcm: Int16Array; sampleRate: number } | null {
  if (bytes.length < 12 || bytes.toString("ascii", 0, 4) !== "RIFF") return null;
  if (bytes.toString("ascii", 8, 12) !== "WAVE") return null;

  let sampleRate = 0;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = bytes.toString("ascii", at, at + 4);
    const size = bytes.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt " && body + 16 <= bytes.length) {
      sampleRate = bytes.readUInt32LE(body + 4);
    } else if (id === "data") {
      const end = Math.min(bytes.length, body + size);
      const pcm = new Int16Array((end - body) >> 1);
      for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(body + i * 2);
      return { pcm, sampleRate: sampleRate || PIPER_RATE };
    }
    // Chunks are word-aligned, and an odd size carries a pad byte.
    at = body + size + (size & 1);
  }
  return null;
}

/**
 * What the machine had free when an engine died loading its model.
 *
 * "stopped while loading" names the symptom and nothing else, and the cause is
 * almost always the same one: the box does not have room for the model. Three
 * operators reported this message on one day; the one who sent a screenshot had
 * 0.8 GB free against a 1.3 GB text model, and the panel was correctly telling
 * him every file was installed. Nothing in the line he could read said memory.
 *
 * llama.cpp maps the whole model resident, so the file's own size is a fair
 * floor for what it needs. Reporting both numbers lets an operator settle it at
 * a glance instead of opening a ticket.
 *
 * This REPORTS, it does not refuse. A pre-flight check that blocked the launch
 * would be wrong on Linux, where `freemem()` excludes reclaimable page cache and
 * routinely reads far below what is actually available — it would turn a working
 * server away. A number printed after a failure that already happened cannot do
 * that: at worst it is a hint that does not apply, and the rest of the line is
 * what it always was.
 *
 * Returns "" rather than guessing when the model cannot be stat'd, so a missing
 * file degrades to the old message instead of an invented one.
 */
/**
 * The exit code, and what it means where the meaning is unambiguous.
 *
 * A bare number is still worth printing — it is the one fact that separates
 * "this engine cannot run on this machine" from "this model file is bad" — but
 * the four codes below account for most of what a support ticket turns out to
 * be, and nobody reading a console should have to look up `0xC0000135`.
 *
 * Only codes with a single cause are named. A generic `1` is left as `1`
 * deliberately: every engine exits 1 for its own reasons, so glossing it would
 * be inventing a diagnosis, which is the thing this whole change is against.
 */
const EXIT_MEANINGS: Record<number, string> = {
  // 0xC0000135. The engine's DLLs sit beside its binary and are loaded by cwd;
  // this is what a half-extracted or ASCII-mode-transferred runtime looks like.
  3221225781: "a DLL it needs is missing next to the binary",
  // 0xC000001D, and POSIX SIGILL. The engine used an instruction this CPU does
  // not have — AVX2 on an older or restricted vCPU.
  3221225501: "this CPU does not support an instruction set the engine needs",
  132: "this CPU does not support an instruction set the engine needs",
  // 0xC000007B — a 32/64-bit or architecture mismatch in the binary itself.
  3221225595: "the binary or one of its DLLs is the wrong architecture",
  // Linux OOM killer. Distinct from "short of RAM" at launch: the kernel took
  // it mid-load, which the free-memory figures below will not show.
  137: "the system killed it, which is almost always the kernel running out of memory",
};

export function exitNote(why: Postmortem): string {
  if (why.code === null) return "";
  const meaning = EXIT_MEANINGS[why.code];
  return meaning ? ` (exit ${why.code} — ${meaning})` : ` (exit ${why.code})`;
}

/**
 * The engine's own last words.
 *
 * Capped at the final few lines because the useful one is always last and a
 * model loader is chatty — llama-server prints a tensor table. Printed verbatim,
 * not parsed: the whole point is to stop substituting our summary for the
 * engine's message, which is how a customer ended up with "stopped while
 * loading" and no way to find out why.
 */
const SAID_LINES = 3;

export function engineSaid(why: Postmortem): string {
  const said = why.stderr.map((line) => line.trim()).filter((line) => line.length > 0);
  if (said.length === 0) return "";
  return `. It said: ${said.slice(-SAID_LINES).join(" / ")}`;
}

export function memoryNote(modelPath: string): string {
  try {
    const needBytes = statSync(modelPath).size;
    const gb = (n: number) => (n / 1024 ** 3).toFixed(1);
    return (
      ` — ${gb(freemem())} GB RAM free of ${gb(totalmem())} GB, and this model is ` +
      `${gb(needBytes)} GB. The engine holds the whole model in memory, so it needs at ` +
      "least that much free; if it is short, point this capability at a hosted provider instead"
    );
  } catch {
    return "";
  }
}

function markFailed(capability: Capability, reason: string): null {
  if (failed.get(capability) !== reason) {
    failed.set(capability, reason);
    aiLog.warn(`local: ${reason}`);
  }
  return null;
}

/** Why a local capability is unavailable, for the operator-facing diagnostic. */
export function localFailure(capability: Capability): string {
  return failed.get(capability) ?? "";
}

/** Resource stop: every child dies with the resource that started it. */
export function stopLocalEngines(): void {
  // Before anything is killed, so a start racing this one cannot read the old
  // value and register the child we are about to stop.
  generation++;

  const children: [ServedCapability, Running][] = [
    ...[...engines].map(([capability, engine]): [ServedCapability, Running] => [
      capability,
      engine.running,
    ]),
    ...launching,
  ];
  for (const [capability, child] of children) {
    try {
      child.kill();
    } catch (err) {
      aiLog.debug(`local: ${capability} would not stop — ${(err as Error).message}`);
    }
    forgetPid(capability);
  }
  engines.clear();
  launching.clear();
}
