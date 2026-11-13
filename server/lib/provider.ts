/**
 * The OpenAI-compatible provider.
 *
 * One HTTP client covers the local engine shipped with the resource, a hosted
 * API, and the various self-hosted servers and proxies in between — one set of
 * timeouts and one set of failure modes rather than two.
 *
 * What it does not assume is a shared route. `llama-server` serves
 * `/v1/chat/completions` like the hosted APIs do, but `whisper-server` serves
 * `/inference` and has no `/v1/audio/transcriptions` at all, so `endpointFor`
 * hands back the full URL to post to rather than a base to append a guess to.
 *
 * Local speech is the one capability that leaves HTTP entirely: Piper is a
 * binary that reads a line and writes samples, not a server.
 *
 * Speech comes back as raw PCM rather than MP3 because the next step is a
 * vocoder, and decoding MP3 inside FXServer to feed a vocoder would mean
 * vendoring a decoder to undo work nobody needed done. Endpoints that ignore the
 * request and send a WAV are handled — a RIFF header is stripped rather than
 * played as samples, which is what the buzz would otherwise be.
 */

import { aiLog } from "./logger";
import {
  type CapabilityEndpoint,
  endpointFailure,
  endpointFor,
  providerPlan,
  voiceFor,
} from "./config";
import { draftReply } from "./draft";
import { type HttpReply, post, postStream } from "./http";
import { localSpeech } from "./local-engine";
import type { Capability, ProviderId } from "./providers";
import { createSseParser } from "./sse";
import { speechRequest } from "./speech-dialect";
import type { AiAction, AiDecision, AiProvider, AiTool, AudioClip, VoiceGender } from "./types";


/** OpenAI's documented PCM rate. Overridden when the response is a WAV. */
const SPEECH_PCM_RATE = 24000;

/** A reply longer than this is a model ignoring its instructions; airing it would key the channel for half a minute. */
const MAX_REPLY_CHARS = 240;

class ProviderError extends Error {}

/**
 * The endpoint serving one capability, or a refusal naming what is missing.
 *
 * Local and hosted resolve to the same shape here — a URL, a key and a model
 * name — which is what lets one HTTP client serve both without knowing which
 * kind of engine is on the other end.
 */
async function endpoint(capability: Capability, signal: AbortSignal): Promise<CapabilityEndpoint> {
  const resolved = await endpointFor(capability, signal);
  if (resolved) return resolved;
  // A local engine starting for the first time can outlast a turn. That is not a
  // misconfiguration and should not read as one — the next turn finds it up.
  if (signal.aborted) throw new ProviderError(`${capability} is still starting up`);
  throw new ProviderError(`${capability} is unavailable: ${endpointFailure(capability)}`);
}

function authHeaders(apiKey: string): Record<string, string> {
  // A local llama.cpp server takes no key and rejects nothing; sending an empty
  // bearer to one that does check would fail less clearly than sending none.
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function readError(reply: HttpReply): string {
  const body = reply.text().slice(0, 300);
  return `HTTP ${reply.status}${body ? ` — ${body}` : ""}`;
}

/** A JSON reply, or `{}` when the engine sent something that is not JSON. */
function asJson(reply: HttpReply): unknown {
  try {
    return JSON.parse(reply.text());
  } catch {
    return {};
  }
}

/** Strip a RIFF header if one is present, and report the rate it declared. */
export function pcmFromResponse(bytes: Uint8Array): { pcm: Int16Array; sampleRate: number } {
  const isRiff =
    bytes.length > 44 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46;

  let offset = 0;
  let sampleRate = SPEECH_PCM_RATE;
  if (isRiff) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    sampleRate = view.getUint32(24, true) || SPEECH_PCM_RATE;
    // Walk the chunk list rather than assuming 44: some encoders emit a LIST or
    // fact chunk first, and treating those bytes as samples is an audible click.
    let cursor = 12;
    while (cursor + 8 <= bytes.length) {
      const id = String.fromCharCode(
        bytes[cursor]!,
        bytes[cursor + 1]!,
        bytes[cursor + 2]!,
        bytes[cursor + 3]!
      );
      const size = view.getUint32(cursor + 4, true);
      if (id === "data") {
        offset = cursor + 8;
        break;
      }
      cursor += 8 + size + (size % 2);
    }
    if (offset === 0) offset = 44;
  }

  const usable = bytes.length - offset;
  const samples = Math.floor(usable / 2) * 2;
  const pcm = new Int16Array(samples / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, samples);
  for (let i = 0; i < pcm.length; i++) pcm[i] = view.getInt16(i * 2, true);
  return { pcm, sampleRate };
}

/**
 * How many things the dispatcher may do off one transmission.
 *
 * More than one because real traffic needs it — a pursuit crossing a boundary is
 * an alert and a patch and a word to the other channel — and capped because a
 * model that has decided to do six things has stopped working the radio.
 */
const MAX_ACTIONS = 3;

/**
 * Runs a streamed decision, announcing the reply the moment it is complete.
 *
 * Returns the assembled content for {@link parseDecision}, or `null` when the
 * endpoint could not stream — in which case the caller retries buffered. `null`
 * rather than a throw because "this provider does not do SSE" is a
 * configuration, not a fault, and a turn that still answers a second later is a
 * far better outcome than one that errors.
 *
 * A stream that fails *after* producing content is a different matter and does
 * throw: at that point the reply may already be synthesising, and silently
 * falling back would generate the turn twice and could air the second one.
 */
async function streamDecision(
  options: { url: string; headers: Record<string, string>; signal: AbortSignal; body: string },
  onDraftReply: (reply: string) => void
): Promise<string | null> {
  const parser = createSseParser();
  let content = "";
  let announced = false;

  const consume = (event: { data: string }): void => {
    // llama-server sends the OpenAI sentinel on this route; an empty event is a
    // keepalive that survived the parser.
    if (!event.data || event.data === "[DONE]") return;
    let delta: string | undefined;
    try {
      delta = (JSON.parse(event.data) as { choices?: { delta?: { content?: string } }[] })
        .choices?.[0]?.delta?.content;
    } catch {
      // One unreadable event is not worth abandoning a turn over; the assembled
      // content is validated by `parseDecision` regardless.
      return;
    }
    if (!delta) return;
    content += delta;
    if (announced) return;
    const draft = draftReply(content);
    if (!draft) return;
    announced = true;
    onDraftReply(draft);
  };

  try {
    for await (const chunk of postStream(options)) {
      for (const event of parser.push(chunk)) consume(event);
    }
    for (const event of parser.end()) consume(event);
  } catch (error) {
    if (content !== "") throw new ProviderError(`decision stream failed: ${String(error)}`);
    aiLog.debug(`decide: falling back to a buffered request — ${(error as Error).message}`);
    return null;
  }

  // A clean stream that produced nothing is the same situation as a refusal:
  // some proxies answer a `stream: true` request with an empty 200.
  return content === "" ? null : content;
}

/**
 * Pull `{actions, reply}` out of whatever the model actually sent.
 *
 * `response_format: json_object` is a request, not a guarantee — models still
 * wrap JSON in prose or a code fence — so the first brace-to-brace span is taken
 * before parsing. A response that yields no usable object becomes "do nothing"
 * rather than an exception, because the alternative to an unparseable decision is
 * silence, which is the safe answer on a radio channel.
 *
 * A bare `{"tool": …, "input": …}` is accepted as a one-action list: models
 * collapse to it regardless of the format asked for, and rejecting the shape
 * would cost the action rather than correct it.
 *
 * An undeclared tool name is dropped, not matched to the nearest one: the reply
 * still airs, but a model that invented a capability does not get to act.
 */
export function parseDecision(raw: string, tools: readonly AiTool[]): AiDecision {
  const nothing: AiDecision = { actions: [], reply: "" };

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return nothing;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return nothing;
  }
  if (!parsed || typeof parsed !== "object") return nothing;

  const record = parsed as Record<string, unknown>;
  const reply =
    typeof record.reply === "string" ? record.reply.trim().slice(0, MAX_REPLY_CHARS) : "";

  const raws = Array.isArray(record.actions) ? record.actions : [record];
  const actions: AiAction[] = [];
  for (const entry of raws) {
    if (actions.length >= MAX_ACTIONS) break;
    if (!entry || typeof entry !== "object") continue;
    const action = entry as Record<string, unknown>;

    const named = typeof action.tool === "string" ? action.tool.trim().toLowerCase() : "";
    if (!named) continue;
    const tool = tools.find((candidate) => candidate.id.toLowerCase() === named);
    if (!tool) {
      aiLog.debug(`decide: model named an unknown tool "${named}"`);
      continue;
    }

    // A number or a bare code is a perfectly good argument and models send both.
    const input =
      typeof action.input === "string"
        ? action.input.trim()
        : typeof action.input === "number"
          ? String(action.input)
          : "";
    actions.push({ tool: tool.id, input });
  }

  // `"kind": "done"` *is* the hang-up.
  //
  // Measured 2026-09-21 on the first 911 harness run: the model classified the
  // turn as `done`, wrote a closing reply, and left `actions` empty — so the
  // call ran on until the caller hung up, and the radio announcement went out
  // carrying the caller's typed sentence instead of a summary. Asking for the
  // same decision twice, once as a label and once as a tool call, is the shape
  // of bookkeeping a 4B model drops half of; the label is the half it gets
  // right, because it decodes first and conditions everything after it.
  //
  // Guarded on the tool being offered, which it only is on a call — a radio
  // turn has no `hang_up` and its kinds are a different three words, so this
  // cannot fire there. `about` is the summary the tool wanted anyway: four
  // words or fewer, describing the call.
  const kind = typeof record.kind === "string" ? record.kind.trim().toLowerCase() : "";
  const hangUp = tools.find((candidate) => candidate.id === "hang_up");
  if (kind === "done" && hangUp && !actions.some((action) => action.tool === "hang_up")) {
    const about = typeof record.about === "string" ? record.about.trim() : "";
    actions.push({ tool: "hang_up", input: about || reply });
  }

  // `kind` and `about` are carried out rather than dropped — see `AiDecision`. The
  // parse of `kind` above already exists for `hang_up`; this only stops the answer
  // being discarded one line later.
  const about = typeof record.about === "string" ? record.about.trim() : "";
  return { actions, reply, kind, about };
}

function chatContent(payload: unknown): string {
  const choice = (payload as { choices?: { message?: { content?: unknown } }[] })?.choices?.[0];
  const content = choice?.message?.content;
  return typeof content === "string" ? content : "";
}

/**
 * A multipart upload built as one buffer, rather than as `FormData`.
 *
 * `FormData` with a `Blob` in it makes the request body a stream, and inside
 * FXServer reading that stream fails — the blob's reader is released underneath
 * the request and node throws `Invalid state: Reader released` from a timer,
 * which lands as an unhandled rejection rather than as an error the awaiting
 * `fetch` could report. A transcription would simply never come back and the
 * console would blame the web streams implementation.
 *
 * Assembling the body here avoids the stream entirely, and costs nothing worth
 * counting: a transmission is seconds of 8 kHz audio, so the clip is a couple of
 * hundred kilobytes that already exists in memory.
 */
export function buildMultipart(
  clip: AudioClip,
  fields: Record<string, string>
): { body: Uint8Array; contentType: string } {
  const boundary = `----tRadio${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`;
  const encoder = new TextEncoder();
  const pieces: Uint8Array[] = [];

  for (const [name, value] of Object.entries(fields)) {
    pieces.push(
      encoder.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
      )
    );
  }
  pieces.push(
    encoder.encode(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${clip.filename}"\r\n` +
        `Content-Type: ${clip.mime}\r\n\r\n`
    )
  );
  pieces.push(clip.bytes);
  pieces.push(encoder.encode(`\r\n--${boundary}--\r\n`));

  const body = new Uint8Array(pieces.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of pieces) {
    body.set(part, at);
    at += part.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

/**
 * The JSON the model is asked to answer with, on a radio channel.
 *
 * Here rather than in `prompt.ts` because it describes the document
 * `parseDecision` reads, not the dispatcher's character — the two have to change
 * together, and they are twenty lines apart in this file for that reason.
 */
const RADIO_FRAMING =
  // `kind` first, then `reply`, then `actions`. All three positions
  // were measured on the offline harness against the same six
  // transmissions, and the first two both failed:
  //
  //   reply, actions   3.4 s to first word, 1 distinct line in 6,
  //                    zero tools ever — a dispatcher that answered
  //                    "show me 10-8" and "patch us to OPS2" with the
  //                    same go-ahead. Raw JSON well-formed every time,
  //                    so this was judgement, not parsing: having
  //                    written the sentence, it closed with the empty
  //                    array it had been shown.
  //   actions, reply   tools correct, replies varied — and 7.7 s to
  //                    first word, because the reply now decodes last
  //                    and synthesis cannot start until it does. Also
  //                    over-eager: it set a unit's status to "It's
  //                    going to be on a black two door, eastbound on
  //                    Route 68".
  //
  // So the ordering was never really about actions versus reply. The
  // model needs somewhere to decide *what kind of transmission this
  // is* before it writes, and choosing an action was standing in for
  // that badly in one direction and not at all in the other. `kind`
  // costs about three tokens, does the conditioning, and leaves
  // `reply` early enough to keep the synthesis head start.
  //
  // An older note here claimed this ordering cost nothing, on the
  // strength of `scripts/probe-reply-first.ts` scoring tool choice 12
  // of 12. That probe hardcodes a channel history containing a worked
  // example of acknowledging traffic, so it was accidentally
  // few-shot; live, with an empty history, the same ordering scored
  // zero. Treat its numbers as measuring its fixture.
  // `about` is the fix for the last shape of this failure. Measured
  // with `kind` alone: the model labelled a transmission "report",
  // chose `set_unit_status` with the unit's own words as the input —
  // and wrote "King 41, go ahead" as the reply anyway, on a turn
  // whose history held one dispatcher line and no repetition at all.
  // The classification was right and the reply still was not, because
  // `reply` decodes before `actions` and at that point nothing in the
  // document yet says what this transmission was about. `about` is
  // that, in three or four tokens, and it sits where the model has to
  // write it before the line rather than after.
  //
  // Capped at four words on purpose. The first version asked for
  // "a few words" and said the reply had to contain it, and the
  // model obliged by putting the entire transmission in `about` and
  // then reading it back: 7.3 seconds of airtime answering a 3.8
  // second transmission. `about` is a label for the traffic, not a
  // copy of it, and the cap is what makes it one.
  'Answer with JSON: {"kind": "<call-up, request or report>", "about": "<the traffic in four words or fewer, empty for a call-up>", "reply": "<what you say>", "actions": []}\n' +
  "Fill the fields in that order. Each one decides the next:\n" +
  // The disqualifier list is the fix for the worst thing this dispatcher does, and
  // it is worth being precise about what was measured, because the symptom pointed
  // somewhere else entirely.
  //
  // `scripts/probe-self-report.ts` was built to chase a missing `unit_status`. It
  // printed the model's own `kind` and `about` and the answer was not a tool problem:
  // with the one tool tRadio ships, FOUR of five pieces of ordinary traffic came back
  // kind="call-up", about="", reply="Go ahead, King 41" — including "King 41, traffic
  // stop at Grove and Jefferson." A unit who has just told you where they are and what
  // they are doing is being told to go ahead. The CAD write is the smaller half of
  // that; the dispatcher is audibly not listening.
  //
  // It is also why tool use appeared to scale with the length of the tool list. A long
  // list gives the model more reason to think something is actionable, so it lands on
  // "report" and the status gets recorded; with one tool it falls through to the
  // cheapest, safest label. The list length was never the cause — the call-up branch
  // was, and the list was just how hard it was to escape.
  //
  // "nothing but their callsign and yours" was already strict, and strictness was not
  // the problem: `kind` is the FIRST field written, so the model commits to a label
  // before it has considered the content. A definition it can only satisfy by looking
  // for things that are present is one it can apply in that position. Same move as the
  // 911 location decision and the "you have already said" list — a concrete test lands
  // where a general rule does not.
  '- "call-up" — the entire transmission is callsigns and nothing else. If it contains a place, a code, a vehicle, a person, a plate, a request, or anything at all they are doing, it is not a call-up no matter how it opens. Reply with the go-ahead. Actions stay empty.\n' +
  '- "request" — they asked you to do something. Use the tool that does it, with the value they gave you, and say what you did.\n' +
  // "In their own words" without the length limit produced a full
  // readback: "Report received, King 41. Priority traffic. Shots
  // fired. Eastbound on Route 68." is 8.7 seconds of airtime for a
  // five-second transmission, and a dispatcher who repeats your
  // sentence back to you is not how a radio sounds.
  // The second sentence used to read "Use a tool only if one of yours exists to
  // record that exact thing. Most reports need none." — and it was the whole
  // defect, measured on `scripts/probe-self-report.ts` 2026-10-05.
  //
  // `unit_status` was chosen 0 of 10 times with the tool set tRadio actually
  // SHIPS (one tool), 2 of 10 with the harness's three and 6 of 10 with eight,
  // on identical traffic and an identical system prompt. Tool use scaled with
  // the length of the list, which is backwards: the shipped configuration —
  // what a server gets having written no `sv_functions.lua` — was the one that
  // never recorded anything, and every harness number to that date had been
  // taken with three tools and so flattered it.
  //
  // Two phrases did it. "that EXACT thing" is a test the model applies against
  // the list it can see, so a long list produces a confident match and a short
  // one does not; and "Most reports need none" is a PRIOR, applied before
  // looking at the tool at all. Together they made a self-report — the single
  // most common thing a dispatcher writes down — the traffic least likely to be
  // recorded.
  //
  // What is NOT relaxed here is the guard those phrases were doing double duty
  // for. "A tool takes the kind of value it names and nothing else" is in the
  // system prompt, where it belongs: it refuses a plate or a question written
  // into a status field without also refusing a status. The framing now decides
  // by matching the KIND of value, which is the same test stated positively.
  '- "report" — they told you something. Acknowledge it with their callsign and the one detail that matters, in their words — never the whole transmission back. Writing down what a unit tells you is most of the job: if one of your tools takes the kind of value they just gave you, call it. They do not have to ask you to.\n' +
  // Stated as a prohibition because saying what the other two kinds
  // should write was not enough on its own. Measured: with the three
  // kinds described but this line absent, the model classified every
  // transmission correctly and chose the right tool, and still wrote
  // the go-ahead as its reply — on turns it had itself labelled
  // "report" and "request". The go-ahead was the only concrete
  // utterance offered anywhere in the framing, which is the same
  // mistake the system prompt made one level up.
  // `kind` was doing two jobs, and this line is what separates them.
  //
  // Measured on `scripts/probe-self-report.ts` with the one tool tRadio ships: after
  // the call-up branch was tightened to an explicit disqualifier list, narrative
  // traffic STILL came back kind="call-up" on 8 of 8 — "King 41, traffic stop at Grove
  // and Jefferson." answered "Go ahead, King 41". Tightening the definition could not
  // fix it because the model was not reading the definition. It was reasoning
  // backwards: this framing makes `kind` decide the actions, call-up is the one kind
  // whose actions are empty by rule, and with a single tool that cannot take the
  // traffic there is no action — so it picked the label that justified having none.
  //
  // That also explains the whole tool-list-length effect this probe found. More tools
  // meant more chances that something looked actionable, which let the model reach
  // "report"; the list was never the cause, this reverse inference was.
  //
  // So the no-action case is named explicitly as normal for the other two kinds. The
  // sentence is about the direction of the inference, not about any tool or scenario,
  // which is why it belongs here rather than in a server's own instructions.
  // The sentence that stood here was MEASURED WORSE and taken out. It read: "A kind
  // with no action in it is completely normal: most reports and many requests need no
  // tool at all. Never choose call-up because you could not find a tool to use — the
  // kind describes what the unit SAID, and has nothing to do with what you are able to
  // do about it."
  //
  // The reasoning above it was sound and the fix was not: naming call-up and "no
  // action" in the same sentence strengthened exactly the association it was trying to
  // break. One tool went from 2 of 10 to 0 of 10, losing even "King 41, show me 10-8."
  // — the easiest status there is. A prohibition that has to name the wrong answer to
  // forbid it is a hazard in a prompt this small, which is the same lesson as the
  // quoted go-ahead three comments up.
  "The go-ahead belongs to a call-up and nowhere else. A unit who gave you a request or a report has already said their piece; telling them to go ahead ignores what they just said.\n" +
  'The reply answers what is in "about" and stops there. Never longer than what the unit said, and never their own sentence read back to them.\n' +
  // "that exact thing" here for the same reason as above, and relaxed the same
  // way. One tool asked to match exactly matches nothing.
  '"about" decides the actions too: if one of your tools takes the kind of value that is in it, call it with what the unit said. If none of them does, the list stays empty.\n' +
  'An action looks like {"tool": "<tool name>", "input": "<the value the unit gave>"}. ' +
  "List more than one only when the traffic genuinely needs it. Never copy an example from a tool's description — the input is what this unit said, or the tool does not apply.";

/**
 * The same document, asked for by someone taking a 911 call.
 *
 * Deliberately the same four fields in the same order, so `parseDecision`,
 * `draftReply` and the streaming head start all work unchanged — what differs is
 * only what the model is deciding between. Its radio vocabulary does not survive
 * the move: a member of the public in trouble has not made a "call-up", a
 * "request" or a "report", and offering those three as the classification would
 * make the first thing the model decides a thing that is not true.
 *
 * The three kinds here are the call-taker's actual decision, in the order a call
 * is worked: where, then what, then whether there is anything left to ask. It is
 * also what drives `hang_up` — "done" is the model saying so in three tokens
 * before it has to justify it in a tool call.
 *
 * No example sentences anywhere in it, for the reason the radio framing
 * discovered the hard way: a model shown a line says that line. On a channel
 * that cost a stock go-ahead on every turn. On a 911 call it would cost a
 * sentence invented about somebody's emergency, said to them as though it were
 * true, which is not a class of mistake worth risking for a sample.
 */
const CALL_FRAMING =
  'Answer with JSON: {"kind": "<location, detail or done>", "about": "<the call in four words or fewer>", "reply": "<what you say>", "actions": []}\n' +
  "Fill the fields in that order. Each one decides the next:\n" +
  '- "location" — you do not yet have an address, an intersection or a landmark you could send a unit to. Nothing matters more; ask for it and ask for nothing else.\n' +
  '- "detail" — you know where. Ask the one thing you most need next: what is happening, whether anyone is hurt, whether the person involved is still there, what they look like, whether the caller is safe. Never ask them to confirm something they already said.\n' +
  '- "done" — you have the location and you know what is happening. Tell them help is being sent, tell them what to do until it gets there if anything, and call hang_up.\n' +
  // A caller volunteers three things at once and the natural reply is to
  // acknowledge all three, which is a paragraph. The cap is what keeps the
  // line answerable while someone is frightened and talking over it.
  "Twenty words at the most, and one question in it. Two questions in one breath gets you the answer to neither.\n" +
  "Never say how long anyone will be, never say who is coming, and never promise that anything will be all right. You do not know, and on this line being wrong about it is worse than being brief.\n" +
  'The caller is not a unit and has no callsign. Do not use radio codes, do not say "go ahead", and do not read their own words back to them.\n' +
  'An action looks like {"tool": "<tool name>", "input": "<the value>"}. Use one only when a tool of yours does that exact thing; otherwise the list stays empty.';

/**
 * Whether to ask this provider for `json_object`, and why Groq is not asked.
 *
 * `response_format: { type: "json_object" }` is a REQUEST on OpenAI: the model is
 * steered toward JSON, and whatever it actually sends comes back with a 200.
 * `parseDecision` below is built for exactly that — it takes the first
 * brace-to-brace span, because models wrap JSON in prose or a code fence.
 *
 * Groq treats the same field as a GUARANTEE it enforces. If the generation does
 * not validate as JSON it answers `400 json_validate_failed` — "Failed to
 * validate JSON. Please adjust your prompt." — and there is no body to parse.
 * So the lenient parser never gets the chance, and a reply the model had already
 * written is thrown away by the transport instead of being read.
 *
 * Reported 2026-10-19 by an operator on Groq whose transcription worked and whose
 * Decisions failed on every turn, so the dispatcher never reached speech at all.
 * Reproduces most readily on the GPT-OSS models, which emit a reasoning preamble
 * ahead of the object — the exact shape `parseDecision` exists to survive.
 *
 * Dropping the field for Groq costs nothing: both framings already open with
 * `Answer with JSON: {…}`, so the instruction is in the prompt where it always
 * was, and the response then flows through the same parser every other provider's
 * does. A map rather than `=== "groq"` because this is a property of each
 * provider's API, matching `SPEECH_RESPONSE_FORMAT` in speech-dialect.ts.
 */
const TEXT_WANTS_JSON_FORMAT: Partial<Record<ProviderId, boolean>> = {
  groq: false,
};

export function jsonFormatFor(provider: ProviderId): { response_format?: { type: "json_object" } } {
  return TEXT_WANTS_JSON_FORMAT[provider] === false
    ? {}
    : { response_format: { type: "json_object" } };
}

export function createHttpProvider(): AiProvider {
  return {
    name: "openai-compatible",

    async transcribe(clip: AudioClip, signal: AbortSignal, bias = ""): Promise<string> {
      const route = await endpoint("transcription", signal);
      const upload = buildMultipart(clip, {
        model: route.model,
        response_format: "json",
        // Whisper's initial prompt, and OpenAI's `prompt` field: both take text
        // the recogniser should expect. Sent only when there is something to
        // say, because an empty prompt field is not the same as no prompt field
        // on every server that accepts one.
        ...(bias ? { prompt: bias } : {}),
      });

      const reply = await post({
        url: route.url,
        headers: { "Content-Type": upload.contentType, ...authHeaders(route.apiKey) },
        body: upload.body,
        signal,
      });
      if (!reply.ok) throw new ProviderError(`transcription failed: ${readError(reply)}`);

      const payload = asJson(reply) as { text?: unknown };
      return typeof payload.text === "string" ? payload.text.trim() : "";
    },

    async decide(
      system: string,
      prompt: string,
      tools: readonly AiTool[],
      signal: AbortSignal,
      onDraftReply?: (reply: string) => void,
      onRaw?: (raw: string) => void,
      framing: "radio" | "call" = "radio"
    ): Promise<AiDecision> {
      const route = await endpoint("text", signal);
      const body = {
        model: route.model,
        temperature: 0.2,
        max_tokens: 160,
        ...jsonFormatFor(route.provider),
        messages: [
          {
            role: "system",
            content: `${system}\n\n${framing === "call" ? CALL_FRAMING : RADIO_FRAMING}`,
          },
          { role: "user", content: prompt },
        ],
      };
      const headers = { "Content-Type": "application/json", ...authHeaders(route.apiKey) };

      // Streamed so the reply can be handed over mid-generation. A provider that
      // will not stream is not a failure: `streamDecision` says so and the
      // buffered path runs, one turn slower and otherwise identical.
      if (onDraftReply) {
        const streamed = await streamDecision(
          { url: route.url, headers, signal, body: JSON.stringify({ ...body, stream: true }) },
          onDraftReply
        );
        if (streamed !== null) {
          onRaw?.(streamed);
          return parseDecision(streamed, tools);
        }
      }

      const reply = await post({ url: route.url, headers, signal, body: JSON.stringify(body) });
      if (!reply.ok) throw new ProviderError(`decision failed: ${readError(reply)}`);

      const content = chatContent(asJson(reply));
      onRaw?.(content);
      return parseDecision(content, tools);
    },

    async compose(system: string, prompt: string, signal: AbortSignal): Promise<string> {
      const route = await endpoint("text", signal);
      const reply = await post({
        url: route.url,
        headers: { "Content-Type": "application/json", ...authHeaders(route.apiKey) },
        signal,
        body: JSON.stringify({
          model: route.model,
          temperature: 0.3,
          max_tokens: 90,
          messages: [
            { role: "system", content: system },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!reply.ok) throw new ProviderError(`reply failed: ${readError(reply)}`);

      return chatContent(asJson(reply)).trim().slice(0, MAX_REPLY_CHARS);
    },

    async speak(
      text: string,
      gender: VoiceGender,
      signal: AbortSignal
    ): Promise<{ pcm: Int16Array; sampleRate: number }> {
      const voice = voiceFor(gender);

      // The one capability where local and hosted genuinely differ: locally there
      // is no server to call, just Piper reading a line and writing samples.
      if (!providerPlan().speech.hosted) {
        try {
          return await localSpeech(text, voice, signal);
        } catch (err) {
          throw new ProviderError(`speech failed: ${(err as Error).message}`);
        }
      }

      const route = await endpoint("speech", signal);
      /*
       * The request is built by the provider's dialect, not inline.
       *
       * Every hosted provider but one takes the OpenAI shape. ElevenLabs puts the
       * voice id in the URL path, authenticates with `xi-api-key` instead of a
       * bearer, names the model `model_id`, and selects the output format with a
       * query parameter — four differences that would otherwise be four
       * conditionals spread across this call. `speech-dialect.ts` holds them.
       *
       * The RESPONSE stays single-path: both dialects are asked for raw PCM at
       * SPEECH_PCM_RATE, so `pcmFromResponse` below needs no provider knowledge.
       */
      const request = speechRequest({
        provider: route.provider,
        url: route.url,
        apiKey: route.apiKey,
        model: route.model,
        voice,
        text,
        sampleRate: SPEECH_PCM_RATE,
      });
      const reply = await post({
        url: request.url,
        headers: request.headers,
        signal,
        body: request.body,
      });
      if (!reply.ok) throw new ProviderError(`speech failed: ${readError(reply)}`);

      const bytes = new Uint8Array(reply.bytes);
      if (bytes.length < 2) throw new ProviderError("speech returned no audio");
      return pcmFromResponse(bytes);
    },
  };
}

let activeProvider: AiProvider | null = null;

export function provider(): AiProvider {
  if (!activeProvider) activeProvider = createHttpProvider();
  return activeProvider;
}

/** Test seam — also how a future tAI-exports provider would be installed. */
export function setProvider(next: AiProvider | null): void {
  if (next && next !== activeProvider) aiLog.debug(`provider: using ${next.name}`);
  activeProvider = next;
}
