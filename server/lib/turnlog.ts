/**
 * A readable record of every turn the dispatcher takes.
 *
 * The console already said when a turn failed, but not what it heard, what it
 * decided, or what it actually put on the air — which is the only view that
 * answers "is this working well?" rather than "did it crash". So one journal per
 * turn, filled in as the turn runs and written once at the end, whether it aired
 * a reply, said nothing deliberately, or fell over.
 *
 * Two destinations, because they answer different questions:
 *
 *  - **The console**, two lines per turn, so an operator watching the server sees
 *    the exchange as it happens.
 *  - **`server/logs/ai-dispatch.jsonl`**, one object per turn, because reading back a
 *    session of traffic — transcripts, tool calls, replies, latency — is a
 *    different job from watching one go past, and the console interleaves with
 *    everything else the server is doing.
 *
 * Inside the resource directory, like every other file this resource writes:
 * FXServer's filesystem permissions are per-device and `%TEMP%` has no device.
 * A write that is refused anyway disables the file and leaves the console lines
 * alone — a dispatcher that stops dispatching because it could not log would be
 * a worse bug than the one this exists to find.
 */

import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import { aiLog } from "./logger";
import type { AiOutcome, AiTurnContext } from "./types";

/** Past this the file is rolled over once. Roughly a week of a busy channel. */
const MAX_BYTES = 4 * 1024 * 1024;

/** Transcripts and replies are short by design; this only catches a runaway model. */
const MAX_TEXT = 500;

export interface TurnAction {
  tool: string;
  input: string;
  ok: boolean;
  message: string;
}

export interface TurnJournal {
  at: number;
  trigger: AiTurnContext["trigger"];
  frequency: number;
  channel: string;
  /** Callsign if the unit has one, else the unit id, else the server id. */
  unit: string;
  serverId: number;
  /** The transcript, or the call text for an unprompted announcement. */
  heard: string;
  /**
   * The audio the recogniser was given, described.
   *
   * Here because a transcript on its own cannot tell you whether the recogniser
   * mangled two seconds of speech or faithfully transcribed a quarter-second of
   * nothing, and those two have the same fix in none of their details. A turn
   * that keeps answering "Go <callsign>" is the model being told the unit said
   * only its own name, and the first question is always whether that is what the
   * unit actually said.
   */
  clip: { ms: number; bytes: number; encoding: string } | null;
  /** Whether a wake phrase or a live expectation made this ours to answer. */
  addressed: boolean;
  /**
   * What made it ours: "wake phrase", "expected reply", or "" when neither.
   *
   * These two routes fail in opposite directions and are impossible to tell
   * apart from the outside. An expectation answers everything the unit says next
   * whether or not it was for us — which is correct for the second half of an
   * exchange, and is also exactly how a dispatcher ends up in a loop with itself.
   */
  addressedBy: string;
  /** What the model was shown of the channel's recent traffic. */
  historyTail: string[];
  /** The second transmission, when the outcome said something new. */
  followUp: string;
  /**
   * The hold aired while the decision ran, when one was — "King 41, stand by".
   *
   * Present in the log because it is a transmission the unit heard and the
   * dispatcher did not decide to make, and a turn that reads as three seconds
   * slower than it sounds is a turn whose first word went out on this line.
   */
  held: string;
  /** Duration of the audio actually put on the air. */
  airedMs: number;
  /** Why the turn ended early, when it did: "not addressed", "no speech", … */
  skipped: string;
  actions: TurnAction[];
  /** Actions refused before they ran, and why — see `isLiftedExample`. */
  dropped: string[];
  /**
   * The decision exactly as the model wrote it, before parsing.
   *
   * Logged only when the turn went wrong, because on a healthy turn it is the
   * same information as `drafted` and `actions` with braces round it. On a turn
   * that went wrong it is usually the whole answer: a tool the model never named,
   * a field the token cap cut in half, a reply that came back identical for the
   * fourth time running.
   */
  decided: string;
  /** What the model wrote first, kept when a tool outcome rewrote it. */
  drafted: string;
  reply: string;
  aired: boolean;
  error: string;
  ms: number;
  /** Time until first outgoing voice packet, excluding the reply's playback duration. */
  responseStartMs: number | null;
  stages: Record<string, number>;
}

export function startTurn(
  trigger: AiTurnContext["trigger"],
  frequency: number,
  serverId: number,
): TurnJournal {
  return {
    at: Date.now(),
    trigger,
    frequency,
    channel: "",
    unit: "",
    serverId,
    heard: "",
    clip: null,
    addressed: false,
    addressedBy: "",
    historyTail: [],
    followUp: "",
    held: "",
    airedMs: 0,
    skipped: "",
    actions: [],
    dropped: [],
    decided: "",
    drafted: "",
    reply: "",
    aired: false,
    error: "",
    ms: 0,
    responseStartMs: null,
    stages: {},
  };
}

/** Fill in who was talking and on what, once the turn has a context. */
export function describeTurn(journal: TurnJournal, context: AiTurnContext): void {
  journal.channel = context.channelName;
  journal.unit = context.callsign || context.unitId || String(context.serverId || "");
}

export function recordOutcomes(journal: TurnJournal, outcomes: readonly AiOutcome[]): void {
  for (const outcome of outcomes) {
    journal.actions.push({
      tool: outcome.tool,
      input: String(outcome.input ?? "").slice(0, MAX_TEXT),
      ok: outcome.ok,
      message: String(outcome.message ?? "").slice(0, MAX_TEXT),
    });
  }
}

/** Seconds, one decimal, for a duration a person is meant to read. */
function secs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Emit the turn.
 *
 * Deliberately `info`: a turn is the thing being looked for when someone turns
 * on the dispatcher and watches, and burying it at `debug` would mean the answer
 * to "what did it do?" is off by default.
 *
 * An answered turn prints as an indented block rather than a line, in the shape
 * tAI's `tai_talk` uses, because the two resources get read by the same person
 * and a turn has more parts than fit on a line worth reading. Traffic that was
 * never ours stays one line: on a monitored channel most of it is units talking
 * to each other, and a block each would bury the turns that matter.
 */
export function finishTurn(journal: TurnJournal): void {
  journal.ms = Date.now() - journal.at;
  journal.heard = journal.heard.slice(0, MAX_TEXT);
  journal.drafted = journal.drafted.slice(0, MAX_TEXT);
  journal.decided = journal.decided.slice(0, MAX_TEXT);
  journal.reply = journal.reply.slice(0, MAX_TEXT);
  journal.followUp = journal.followUp.slice(0, MAX_TEXT);
  journal.held = journal.held.slice(0, MAX_TEXT);

  const who = journal.unit || "unknown";
  const where = journal.channel
    ? `${journal.channel} (${journal.frequency})`
    : `${journal.frequency}`;

  if (!journal.addressed && journal.trigger !== "call") {
    aiLog.info(
      `turn: ${who} on ${where} said "${journal.heard}" — ${journal.skipped || "not answered"}`,
    );
    append(journal);
    return;
  }

  const lines: string[] = [];
  const clip = journal.clip;
  lines.push(
    journal.trigger === "call"
      ? `  call:    "${journal.heard}"`
      : `  heard:   "${journal.heard}"` +
          (clip ? `   (${secs(clip.ms)} of ${clip.encoding}, ${clip.bytes}B)` : ""),
  );
  // Why this turn was answered at all. The single most useful line when the
  // dispatcher is answering things it should not be.
  if (journal.trigger === "transmission") {
    lines.push(`  address: ${journal.addressedBy || "unknown"}`);
  }
  if (journal.held) lines.push(`  held:    "${journal.held}"`);
  if (journal.drafted) lines.push(`  drafted: "${journal.drafted}"`);
  if (journal.reply && journal.reply !== journal.drafted) {
    lines.push(`  reply:   "${journal.reply}"`);
  }
  if (journal.followUp) lines.push(`  then:    "${journal.followUp}"`);

  lines.push(
    `  actions: ${
      journal.actions.length === 0
        ? "none"
        : journal.actions
            .map(
              (action) =>
                `${action.tool}(${action.input})${action.ok ? "" : " FAILED"}` +
                (action.message ? ` — ${action.message}` : ""),
            )
            .join(", ")
    }`,
  );
  for (const refused of journal.dropped) lines.push(`  refused: ${refused}`);

  const stages = Object.entries(journal.stages)
    .map(([name, ms]) => `${name} ${ms}ms`)
    .join("  ");
  const start =
    journal.responseStartMs === null ? "never aired" : `first word ${journal.responseStartMs}ms`;
  lines.push(
    `  ${stages}${stages ? "  " : ""}| ${start}, ${
      journal.airedMs ? `${secs(journal.airedMs)} aired, ` : ""
    }total ${journal.ms}ms`,
  );

  if (journal.error) lines.push(`  error:   ${journal.error}`);
  else if (journal.skipped) lines.push(`  skipped: ${journal.skipped}`);
  else if (!journal.aired && journal.reply) lines.push(`  skipped: could not air the reply`);

  // Last, because it is the longest and it is context rather than event — but
  // present, because a dispatcher repeating itself is usually reading its own
  // previous transmission back out of here.
  if (journal.historyTail.length > 0) {
    lines.push(`  history: ${journal.historyTail.join(" | ")}`);
  }

  aiLog.info(`turn — ${who} on ${where}\n${lines.join("\n")}`);
  append(journal);
}

let logFile: string | null = null;
let fileBroken = false;

/** Test seam, and how a turn is logged before any path has been resolved. */
export function setTurnLogFile(file: string | null): void {
  logFile = file;
  fileBroken = false;
}

function target(): string {
  if (logFile) return logFile;
  let root: string;
  try {
    root = GetResourcePath(GetCurrentResourceName());
  } catch {
    root = process.cwd();
  }
  logFile = path.join(root, "logs", "ai-dispatch.jsonl");
  return logFile;
}

function append(journal: TurnJournal): void {
  if (fileBroken) return;
  try {
    const file = target();
    const dir = path.dirname(file);
    // Only when genuinely absent: Enhanced runs its write-permission check
    // against the directory handed to mkdir, and calling it on one that already
    // exists gets the whole write denied. Same reason as `fsbridge`.
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    rollover(file);
    appendFileSync(file, `${JSON.stringify(journal)}\n`);
  } catch (err) {
    fileBroken = true;
    aiLog.warn(`turn log: writing the journal failed, console only — ${(err as Error).message}`);
  }
}

function rollover(file: string): void {
  try {
    if (statSync(file).size < MAX_BYTES) return;
  } catch {
    return; // No file yet, which is the normal first write.
  }
  renameSync(file, `${file}.1`);
}
