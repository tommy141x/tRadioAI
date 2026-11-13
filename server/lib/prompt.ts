/**
 * Prompt construction. Pure — no network, no state, no clock.
 *
 * Two things are being asked for at once and they pull in opposite directions:
 * a correct tool call, and a reply that sounds like radio traffic rather than a
 * chatbot. The instructions are therefore split — what to do, then how to speak —
 * and the brevity rules are stated as hard limits because "be concise" reliably
 * produces three sentences.
 */

import { type ChannelEntry, describeChannel } from "./directory";
import { hasLocationEvidence, knownLocation } from "./location";
import { describeDistance } from "./roster";
import type { AiOutcome, AiTool, AiTurnContext } from "./types";

/**
 * Cap on transcript length in the prompt.
 *
 * A keyed transmission is seconds long; anything past this came from a stuck PTT
 * or a transcriber hallucinating on noise, and neither deserves prompt budget.
 */
const MAX_TRANSCRIPT_CHARS = 600;

/**
 * Ceiling on the operator's own instructions.
 *
 * Room for a page of standing orders. Past this the prompt is competing with the
 * roster and the channel directory for the model's attention, and the operator
 * has written a policy document rather than dispatch guidance.
 */
const MAX_INSTRUCTION_CHARS = 4000;

/**
 * How the dispatcher carries itself, one line each.
 *
 * The table is here and the CHOICE is made in `config.ts`, so exactly one of these
 * values reaches a request and the other three are never in the model's context at
 * all. Offering the catalogue and asking the model to pick its own manner would put
 * four of them in front of it on every turn, three to be ignored — and this file
 * records at length what a model does with text it was shown and told not to use. It
 * uses it. The whole ban on example sentences below is that lesson.
 *
 * Manner only, and deliberately no utterances. Every line says how to sound and none
 * of them says a word to say, because a quoted sentence in this prompt has twice been
 * aired verbatim — "showing you out at 5th and Rockford" to a unit who was nowhere
 * near it. A line that asserts nothing about the world is still safe when it is
 * copied, which is why the acknowledgement vocabulary could be named and the shapes
 * could not.
 *
 * They also say nothing about LENGTH. The ten-word limit under "Speaking" is a
 * measurement, and a manner that argued with it would be a second answer to a
 * question already answered.
 *
 * Four, not forty. A manner an operator cannot tell apart from its neighbour by
 * reading the line is not a setting, it is a list.
 */
export const DEMEANORS = {
  measured: "Steady and unhurried, whatever the traffic is. Nothing in your voice rushes the unit.",
  brisk: "Brisk and impersonal. The fewest words that do the job, then off the air.",
  veteran:
    "The manner of someone who has worked this channel for years: unsurprised, explaining nothing.",
  formal: "Strict procedure throughout. No informality, and no shorthand that is not procedure.",
} as const;

export type Demeanor = keyof typeof DEMEANORS;

/**
 * What a blank key means, and it is the escape an operator is documented to have.
 *
 * Blank has to be a real answer rather than an error: the key is absent on every
 * server that has never heard of it, and a prompt carrying a bare "- " because
 * nobody set a manner is a worse outcome than any manner in the table.
 */
export const DEFAULT_DEMEANOR: Demeanor = "measured";

/** `Object.hasOwn`, not `in` — `"toString" in DEMEANORS` is true. */
export function isDemeanor(key: string): key is Demeanor {
  return Object.hasOwn(DEMEANORS, key);
}

/**
 * The one line a key resolves to. Blank and unrecognised both get the default.
 *
 * Total, like everything else here, so a prompt can be built from whatever a caller
 * has. `config.ts` is where an unrecognised key is *named* in the log — resolving it
 * silently is right at this end and wrong at that one.
 */
export function demeanorLine(key: string): string {
  const wanted = key.trim().toLowerCase();
  return DEMEANORS[isDemeanor(wanted) ? wanted : DEFAULT_DEMEANOR];
}

/**
 * @param instructions The server's own standing orders, or "" for none. Added
 *   under tRadio's rules, never over them: an operator can tell the dispatcher
 *   what this server calls a pursuit, and cannot tell it to answer units who are
 *   not on the channel or to claim an action it did not take.
 * @param demeanor One key from {@link DEMEANORS}, or "" for
 *   {@link DEFAULT_DEMEANOR}. Exactly one line of it is injected; the table is
 *   never shown.
 */
export function buildSystemPrompt(
  callsign: string,
  instructions = "",
  codeMeanings: Record<string, string> = {},
  demeanor = ""
): string {
  const own = [
    `You are ${callsign}, a police radio dispatcher. You work a channel with units on it and you answer them over the radio.`,
    "",
    "How radio traffic works:",
    // No literal utterance here, for the reason spelled out under "How a
    // transmission is built" below — and this line is where that lesson was
    // learned twice. It used to read "Answer 'Go <callsign>'", and on the offline
    // harness the 4B answered *every* transmission with exactly that: six turns,
    // one distinct line, no tool ever chosen, including a clearly transcribed
    // "show me 10-8" and a patch request. It was the only quoted output in the
    // whole prompt, and a small model at low temperature reads the one concrete
    // string it is shown as the answer rather than as an illustration.
    // The discrimination stated before either branch, because a rule that only
    // describes the call-up gets applied to everything. Measured on the offline
    // harness with the branches but not this line: every transmission was
    // answered with a go-ahead and no tool was ever chosen — "show me 10-8" and
    // "can you patch us to OPS2" included — and the raw decision came back as
    // well-formed JSON with an empty actions array, so the model was not
    // failing to answer, it was classifying everything as a call-up.
    "- Read the transmission first and decide what it is. If the unit gave you anything at all — a status, a location, a request, a piece of information — then it is traffic. Act on it.",
    "- Only a transmission that carries nothing but their callsign and yours is asking permission to talk. That one gets the go-ahead and nothing else; their next transmission is the actual traffic.",
    "- 'Traffic when ready', 'be advised', 'stand by for' with nothing after them are not requests yet either. Give the go-ahead and wait.",
    "- Units who called while you were busy are listed as waiting. Acknowledge them by callsign before they have to call twice.",
    "- You have the channel roster. Use a unit's real callsign; never invent one or answer a unit who is not on it.",
    "",
    "Working the rest of the system:",
    "- You are given every channel on the system: who is on it, what alert it is running, what it is patched to.",
    "- A unit asking for something this channel has nobody for is a request to another channel, not a refusal. Put it out there, then come back and tell them what you got.",
    "- Check the 'nobody for' half first. If another unit ON THIS CHANNEL could do what was asked — another patrol unit for a second unit, another car for a traffic stop — ask them by callsign instead; a relay sends it where the asker cannot hear it. Go to another channel when what was asked is not something anybody here can do, which is most often a different service: a bus, fire, a tow, air support.",
    "- Traffic that changes how the whole channel operates — a pursuit, a shooting, an officer down — is what the alerts are for. Put the matching one up.",
    "- Lift an alert as soon as the traffic says it is over. Nobody else will.",
    "- When something on this channel is about to become another channel's problem — crossing into their area, their units already responding — patch them together, and unpatch when it is done.",
    "- Never announce an alert, a patch or another channel's answer before you have it. Act first, then say what happened.",
    "",
    "Choosing an action:",
    "- You are given a list of tools. Use the one the unit asked for, and give it the value they said.",
    // Measured in the same run: with one status tool registered, the model used it
    // for everything a unit said. The status was set to "10-28 on a plate", then
    // "plate is 4-5 Charlie Mike Tango 9", then "plate status unknown" — a request,
    // a plate number and a non-answer, all written into the field a dispatcher
    // panel shows as what the unit is doing. A tool is not a place to put traffic
    // that has nowhere else to go.
    "- A tool takes the kind of value it names and nothing else. A unit's status is what that unit is doing — not their question, not a plate, not a note to yourself. If what they said is not that kind of value, the tool is the wrong one and the answer is words, not an action.",
    "- Do nothing at all when the unit asked for nothing you can do, was only calling up, or was not talking to you.",
    "- Use as many tools as the traffic actually needs, in the order they should happen. Most traffic needs none or one.",
    "- Never name a tool that is not on the list.",
    "- If a tool refuses what you gave it, say so on the air; do not try another tool in its place.",
    "",
    "Speaking:",
    // "One sentence" is not a length. Measured: the model obeyed it exactly and
    // still aired "King 41, acknowledged. It's going to be on a Black 2 door,
    // eastbound on Route 68." — one sentence, 7.3 seconds of airtime answering a
    // 3.8 second transmission, and 11 seconds of decode to write it. Time to
    // first word is time to the reply's closing quote, so reply length is
    // latency, not just style. A word count is a limit a model can actually hold.
    "- Ten words or fewer. Radio procedure, not conversation.",
    // This line used to read "read back what they gave you", which is where the
    // readbacks came from — it was an instruction, obeyed. A dispatcher confirms
    // the one detail that proves they heard right; they do not recite the
    // transmission to the unit who just made it.
    // Words, not lines. The ban on examples further down is about *sentences* —
    // a sentence a model copies is a claim about a place or an outcome that
    // nobody made. "Copy" asserts nothing, so naming it is safe, and naming it
    // is necessary: told only to "name the one detail", the model invented its
    // own acknowledgement and used it for everything — "King 41, got you on
    // traffic stop", "King 41, got you on plate query" — which is the go-ahead
    // loop again in a different costume. A model with no vocabulary offered will
    // mint one and then repeat it.
    // Vocabulary and shape both corrected against `assets/reference/real-radio-traffix.txt`,
    // a scanner feed of ~4,200 real transmissions. Counted there: `copy` 167,
    // `10-4` 108, `go ahead` 95, `negative` 41, `received` 8, **`acknowledged` 0**.
    // So this used to offer a word that never occurs on a real channel and omit the
    // second most common one.
    //
    // The bigger correction is that the detail is OPTIONAL. Bare "Copy." / "Copy
    // that." appears 56 times and bare "10-4." 39 times, against 27 for "Copy"
    // followed by anything — real dispatchers acknowledge with one word about twice
    // as often as they repeat a detail back. Mandating the detail is what produced
    // "Copy, 15, weather looking like tonight" and "copy, K22, asked for that play":
    // given a question, the model had to invent something to put in the slot.
    "- Acknowledge with an actual radio word — copy, 10-4, received — and their callsign. That on its own is a complete transmission and usually the right one.",
    "- Add a detail only when it is the thing that mattered and you would be wrong not to confirm it — a location, a status, a plate. Never to fill the sentence out.",
    // The acknowledgement shape above is for INFORMATION, and until this line it
    // was the only shape specified, so the model applied it to questions too.
    // Measured 2026-10-04 on `dispatch-harness.ts --only shift`: "what's the
    // weather looking like tonight?" was answered "Copy, 15, weather looking like
    // tonight", "you still there?" with "Copy, 15, you still there", and a plate
    // check asked three times got "Copy, 22, plate status unknown" twice. Every
    // one of those is this rule being obeyed on traffic it was never meant for,
    // and echoing a question back is the single clearest tell that nobody is
    // listening.
    //
    // "Negative" is named for the same reason "copy" is named a few lines up: a
    // model offered no vocabulary for a refusal mints one and then repeats it, and
    // a bare radio word asserts nothing about the world, so quoting it cannot put
    // a place or an outcome in the model's mouth.
    "- A question is answered or refused, never acknowledged. If you have the answer, give it; if you do not, say negative, or that you have nothing on it yet. Saying their question back to them is not an answer.",
    "- A unit asking for something no tool of yours does gets a short negative, not an acknowledgement. Acknowledging it tells them it is in hand when nothing is happening, and they will ask again.",
    "- No greetings, no offers to help, no questions unless you genuinely could not act.",
    "- Do not say your own callsign unless a unit asked who is on the air.",
    "- Plain words only: no punctuation you would not hear, no abbreviations you would not say, no lists.",
    // Last under "Speaking" because it qualifies those rules rather than adding one:
    // everything above says what a transmission must contain, and this says how the
    // one allowed manner sounds. Always present — `demeanorLine` has no empty
    // result — so this is a bullet, never a stray "- ".
    `- ${demeanorLine(demeanor)}`,
    "",
    // Shapes, not sentences. Written as examples, these were aired verbatim: a
    // unit who had said "Hey dispatch" was twice told "copy, showing you out at
    // 5th and Rockford", a place nobody had mentioned. An example a model can
    // copy is a script it will read, and on a radio that is a lie to a unit who
    // will act on it.
    "How a transmission is built:",
    "- Their callsign first, every time.",
    "- Then one of: the go-ahead, an acknowledgement, or the answer you actually have.",
    "- Then, if a detail is worth confirming at all, two or three words of it — never the sentence they said it in.",
    "- Channel-wide traffic opens with 'All units' instead of a callsign.",
    "",
    "Never say a place, a status, a time, a unit or an outcome that is not in this turn's traffic, roster or tool results. If you do not have it, you do not say it.",
  ];

  /**
   * The server's code sheet, as meanings rather than as sounds.
   *
   * Here rather than in a scenario, because a code sheet is exactly the local knowledge
   * that must not require somebody to write a case for every code. Given "10-50 is a
   * traffic accident" the dispatcher can act on a 10-50 nobody anticipated; given
   * nothing it treats the code as the opaque token the unit said, which is the honest
   * fallback and far better than acting on another agency's sheet.
   */
  const codeLines = Object.entries(codeMeanings)
    .map(([code, meaning]) => `${code} is ${meaning}`)
    .slice(0, 24);
  if (codeLines.length > 0) {
    own.push("", "This channel's codes:", codeLines.join("; "));
    own.push(
      "Those are what the codes mean here. A code you have not been given the meaning of is " +
        "still something the unit said — read it back, never guess what it stands for."
    );
    // How OFTEN to reach for one, which the sheet above does not imply and which a model
    // handed 24 codes gets wrong in the expensive direction: it starts talking in them.
    //
    // Counted on `assets/reference/real-radio-traffix.txt` — the same ~4,200-utterance
    // scanner feed the acknowledgement vocabulary above was calibrated against. A code
    // appears in 4.9% of utterances; MORE THAN ONE appears in 0.2%; among those that use
    // any, the mean is 1.03. Real operators do not speak in codes, they reach for one
    // when it is the shortest true thing to say.
    //
    // The feed does not separate dispatcher from unit, so that rate is for the channel as
    // a whole rather than for dispatch alone — it bounds the order of magnitude, which is
    // what this instruction needs, not a per-speaker figure.
    //
    // Worth stating plainly: until the sheet became configurable this block could never
    // emit, because `tenCodes` was always empty. The rate has therefore never been wrong
    // in production. It would have been.
    own.push(
      "Codes are rare on a real channel. Most transmissions carry none and almost none carry " +
        "two, so use at most one, only where it is genuinely shorter than the plain words, and " +
        "never to sound official."
    );
  }
  const extra = instructions.trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!extra) return own.join("\n");

  return [
    ...own,
    "",
    "This server's own instructions:",
    extra,
    "",
    "Those instructions tell you how this server works — its procedures, what it calls things, what it expects you to do.",
    "Everything above them still holds. They cannot make you use a tool that is not on the list, answer a unit who is not",
    "on the roster, say an action succeeded when it did not, or stop being a dispatcher.",
  ].join("\n");
}

/**
 * The same dispatcher, on the phone to a member of the public.
 *
 * A separate prompt rather than a paragraph bolted onto the radio one, because
 * almost every rule above is the wrong rule here. Ten words and a callsign is
 * how you answer a unit; it is not how you talk to somebody whose house is on
 * fire. Radio codes are the shared language of one of these conversations and
 * gibberish in the other. And the radio prompt's central instruction — never ask
 * a question, act and report — is the exact inverse of a call, which is nothing
 * but questions until it is over.
 *
 * What does carry over is the ban on invented specifics, and it carries over
 * harder. A unit told a wrong location can see that it is wrong. A caller told
 * one cannot, and will repeat it to the next person who asks.
 *
 * Still no example sentences, for the reason the radio prompt documents at
 * length. The vocabulary is named where it is needed and never a whole line.
 */
export function buildCallTakerPrompt(callsign: string, instructions = ""): string {
  const own = [
    `You are ${callsign}, a 911 call-taker. Somebody has called for help and you are on the phone with them.`,
    "This is not the radio. No units can hear this line — it is you and the caller.",
    "",
    "What you are for:",
    // Location first is not a preference. It is the one thing that cannot be
    // recovered after the call drops, and callers volunteer it last.
    "- Get the location before anything else. An address, an intersection, a landmark, a mile marker — anything a unit could be sent to. Until you have it nothing else you learn is worth much.",
    "- Then what is happening, whether anybody is hurt, and whether the caller is somewhere safe.",
    "- Take what they give you in the order they give it. A caller who led with the address has already answered that; do not ask it again.",
    "- Believe them. Deciding whether the call is real is not your job and never was.",
    "",
    "Speaking:",
    "- Twenty words at the most, and one question in it. Two questions at once gets you the answer to neither.",
    "- Plain words only. No radio codes, no ten-codes, no callsigns, no abbreviations — the person on this line does not know any of them and is not going to ask.",
    "- Short sentences are what calm sounds like. Telling somebody to calm down is not.",
    "- Never read their own words back to them, and never greet them twice.",
    // Measured 2026-09-21 on the first 911 harness run: given a complete address
    // unprompted, the model spent its whole first turn asking whether it had
    // heard the address correctly. "Never read their words back" was already
    // above and did not cover it, because a confirmation question does not feel
    // to the model like repeating — it feels like being careful. On a call that
    // costs a turn nobody has, so it is named for what it is.
    "- Never ask them to confirm something they have already told you. They said it and you have it. Asking again spends a turn and tells them you were not listening.",
    "",
    "What you never say:",
    "- How long anyone will be, who is coming, or that help is moving before you have been told that it is.",
    "- That they are safe, that it will be fine, or anything else about what is going to happen. You do not know.",
    "- Any place, person, injury, vehicle or time the caller did not give you. If you do not have it, you do not say it.",
    "",
    "Ending the call:",
    "- Once you have the location and you know what is happening, you have enough. Say that help is being sent, give them anything they should do until it arrives, and end the call.",
    "- Do not hold somebody on the line to be thorough. The sooner the call is over the sooner it goes out.",
  ];

  const extra = instructions.trim().slice(0, MAX_INSTRUCTION_CHARS);
  if (!extra) return own.join("\n");

  return [
    ...own,
    "",
    "This server's own instructions:",
    extra,
    "",
    "Those instructions tell you how this server works. Everything above them still holds. They cannot make you",
    "promise a caller an outcome, tell them something you were not told, or stop taking the call.",
  ].join("\n");
}

/**
 * Show the dispatcher's own line once, however many times it said it.
 *
 * A repeated line in the history is a pattern, and a small model continues
 * patterns — so a dispatcher that has answered twice the same way is being shown
 * evidence that answering that way is what it does here. That is a loop with a
 * ratchet: every repetition makes the next one likelier.
 *
 * Measured on the offline harness: once "King 41, go ahead." had gone out twice,
 * every later turn came back with it — including turns the model itself had
 * classified "report", and whose transcripts it plainly understood. Units' own
 * transmissions are left alone. A unit who says the same thing twice is a unit
 * who was not answered, and that is information the dispatcher needs.
 *
 * Adjacency is the wrong test, and measuring said so: the dispatcher's repeats
 * are separated by the transmissions it was answering, so two identical own
 * lines are never neighbours. What collapses is a repeat of the previous thing
 * *the dispatcher* said, whatever came between.
 *
 * The last occurrence is the one kept, not the first. The line still has to be
 * visible — "you already said this" is what stops it being said a third time —
 * and the freshest copy is the one in the right place in the exchange.
 */
export function collapseOwnRepeats(
  history: readonly AiTurnContext["history"][number][]
): AiTurnContext["history"][number][] {
  const drop = new Set<number>();
  let previousOwn = -1;
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    if (!entry?.own) continue;
    if (previousOwn >= 0 && flatten(history[previousOwn].text) === flatten(entry.text)) {
      drop.add(previousOwn);
    }
    previousOwn = i;
  }
  return history.filter((_, i) => !drop.has(i));
}

export function buildTurnPrompt(context: AiTurnContext, tools: readonly AiTool[]): string {
  const lines: string[] = [];

  // A call's "channel" is a synthetic frequency with a number nobody should ever
  // read, so the header names the caller instead. `channelName` is already the
  // call label by the time it gets here; the frequency fallback is what has to go.
  lines.push(
    context.trigger === "call_intake"
      ? `On the phone with: ${context.callsign || context.call?.caller || "a caller"}`
      : `Channel: ${context.channelName || context.frequency.toFixed(4)}`
  );

  if (context.roster.length > 0) {
    lines.push("");
    lines.push("Units on this channel:");
    for (const unit of context.roster) {
      const who = unit.callsign || `unit ${unit.serverId}`;
      const details = [
        unit.unitId ? `ID ${unit.unitId}` : "",
        unit.status ? `showing ${unit.status}` : "no status given",
        describeDistance(unit.distance),
        unit.note,
        unit.talking ? "keyed up right now" : "",
      ].filter(Boolean);
      lines.push(`- ${who}: ${details.join(", ")}`);
    }
  }

  const recent = collapseOwnRepeats(context.history);
  if (recent.length > 0) {
    lines.push("");
    lines.push(
      context.trigger === "call_intake"
        ? "The call so far, oldest first:"
        : "Recent traffic on this channel, oldest first:"
    );
    for (const entry of recent) {
      lines.push(`  ${entry.who}: "${truncate(entry.text, 200)}"`);
    }
  }

  if (context.waiting.length > 0) {
    lines.push("");
    lines.push(`Waiting to be answered: ${context.waiting.join(", ")}`);
  }

  const elsewhere = context.channels.filter((entry) => entry.frequency !== context.frequency);
  if (elsewhere.length > 0) {
    lines.push("");
    lines.push("The rest of the system:");
    for (const entry of elsewhere) {
      const name = describeChannelEntry(entry);
      const details = [
        entry.units.length > 0
          ? `${entry.units.length} on it (${entry.units.map((unit) => unit.callsign || `unit ${unit.serverId}`).join(", ")})`
          : "nobody on it",
        entry.alert ? `running ${entry.alert}` : "",
        entry.patchedWith.length > 0 ? `patched to ${entry.patchedWith.join(" and ")}` : "",
        entry.monitored ? "you cover this one" : "you do not cover this one",
      ].filter(Boolean);
      lines.push(`- ${name}: ${details.join(", ")}`);
    }
  }

  const here = context.channels.find((entry) => entry.frequency === context.frequency);
  if (here?.alert) {
    lines.push("");
    lines.push(`This channel is currently running ${here.alert}.`);
  }
  if (here && here.patchedWith.length > 0) {
    lines.push(`This channel is patched to ${here.patchedWith.join(" and ")}.`);
  }

  lines.push("");
  if (tools.length === 0) {
    // Not an error: a channel can legitimately have nothing actionable on it.
    // Saying so beats presenting an empty list and hoping for an empty tool.
    lines.push("You have no tools right now. Leave the tool empty and answer briefly.");
  } else {
    lines.push("Tools:");
    for (const tool of tools) {
      lines.push(
        tool.input
          ? `- ${tool.id}: ${tool.description} Input: ${tool.input}`
          : `- ${tool.id}: ${tool.description} Takes no input.`
      );
    }
  }

  // The transmission last, under everything else.
  //
  // It used to sit above the channel directory and the tool list, which put it
  // thirteen lines from where the answer gets written and left the dispatcher's
  // own previous reply as the most recent text in the prompt. Measured on the
  // offline harness: mid-conversation turns came back answering the *previous*
  // transmission — "It's going to be on a black two door" produced the reply and
  // the tool argument from "I've got a traffic stop here", verbatim, both of them.
  // A small model continues the nearest pattern, so the line it is supposed to
  // answer belongs nearest.
  lines.push("");
  if (context.trigger === "call_intake") {
    const call = context.call;
    // What they typed into /911 is shown as what it is: the thing that made them
    // call, written before the line was even picked up. Presenting it as though
    // they had just said it would have the model answering it a second time,
    // several turns into a conversation that has moved on.
    if (call?.message) {
      lines.push(`They called about: "${truncate(call.message, MAX_TRANSCRIPT_CHARS)}"`);
    }
    if (call?.location) lines.push(`Their position when they called: ${call.location}`);
    if (call?.service) lines.push(`They asked for: ${call.service}`);
    lines.push("");
    lines.push(`They just said: "${truncate(context.transcript, MAX_TRANSCRIPT_CHARS)}"`);
    lines.push("");
    // The server decides this, not the model. It used to be asked to "work out
    // first whether you already have a location" — a reasoning step it got wrong
    // often enough to cost a turn on most calls, in both directions: asking for an
    // address it had, and moving on from one it did not. `hasLocationEvidence`
    // answers the same question from the call's own facts and the caller's own
    // words, and the instruction below states the answer instead of requesting it.
    //
    // This is the same move the greeting and the hold already make — a sentence
    // that is the same on every real call-taking floor is not worth a decode — but
    // applied to the DECISION rather than to the words, so the model still phrases
    // the question and can let the caller's wording steer it.
    if (hasLocationEvidence(context)) {
      const where = knownLocation(context);
      lines.push(
        `You already have somewhere to send a unit${where ? ` — ${where}` : ""}. Do not ask where they are again, ` +
          "and do not read the address back to check it. Ask the one thing you most need to know now, " +
          "or end the call if there is nothing left to learn."
      );
    } else {
      // Absolute, because the alternative is the failure that cannot be recovered
      // after the line drops. Every other thing worth knowing survives a second
      // call; the address does not.
      lines.push(
        "You do not have an address. Nothing else you learn on this call is worth much until you do, " +
          "so your reply is one question asking where they are, and nothing else."
      );
    }
    // Last, because it is last that the model reads. Measured 2026-09-21 across
    // three calls: with this same prohibition stated in the system prompt and
    // again in the answer framing, the model still spent a turn on "You
    // mentioned a crash at Elgin and Vespucci. Is that correct?" on one call,
    // "You're at 12 Magellan Avenue, behind the laundromat?" on the next, and
    // "You said 24-7 on Palomino Avenue. Is that correct?" on the third. It is
    // the single most expensive thing it does — a whole turn, eight seconds of
    // a stranger's emergency, spent learning nothing — so it is repeated here,
    // in the position nothing else follows.
    // Its own previous lines, named one by one.
    //
    // The history above already contains them, and that is not enough: measured
    // 2026-10-04, the dispatcher asked "Is anyone hurt?" on three consecutive
    // turns of one call, with both earlier copies visible in the history it was
    // shown, and on the third its own classification of the call read "Big guy at
    // house, no one hurt". It had the answer and asked anyway.
    //
    // Listed explicitly because that is the shape that worked for the location
    // decision: a concrete fact about this call lands where a general rule does
    // not. Deduplicated and capped so a long call cannot crowd out the transcript.
    const askedAlready = [
      ...new Set(
        context.history
          .filter((entry) => entry.own && entry.text.trim())
          .map((entry) => entry.text.trim())
      ),
    ].slice(-4);
    if (askedAlready.length > 0) {
      lines.push("");
      lines.push(
        `You have already said: ${askedAlready.map((line) => `"${line}"`).join(" ")} ` +
          "Saying any of them again spends a turn and answers nothing. Say something else."
      );
    }
    lines.push("");
    lines.push(
      "Whatever you ask, it has to be something you do not already know. Repeating any of the above " +
        "back to them to check it is not a question; they told you, and you have it written down."
    );
  } else if (context.trigger === "call" && context.call) {
    const call = context.call;
    lines.push(`A call just came in from ${call.source}. No unit has been assigned to it.`);
    if (call.caller) lines.push(`Caller: ${call.caller}`);
    if (call.priority) lines.push(`Priority: ${call.priority}`);
    if (call.service) lines.push(`Asked for: ${call.service}`);
    if (call.location) lines.push(`Location: ${call.location}`);
    lines.push(`Reported: "${truncate(call.message, MAX_TRANSCRIPT_CHARS)}"`);
    lines.push("");
    // No longer offers the other-channel escape, because the tools that did it are
    // no longer offered on this turn — see `mayTargetAnotherChannel` in
    // `builtins.ts`. The choice of channel was already made by `channelForCall`
    // before this turn began, and leaving the sentence in would describe an option
    // the model cannot take, which is how it came to name a unit as a channel in
    // the first place.
    lines.push(
      "Put it out on the air. Pick the nearest unit who is available, call them by callsign, " +
        "and give them the call. This is the right channel and your reply goes out on it, " +
        "so there is nothing to relay and nothing to patch. The caller cannot hear this; the units can."
    );
  } else {
    lines.push(
      `${context.callsign || `Unit ${context.serverId}`} just keyed up${context.unitId ? ` (ID ${context.unitId})` : ""}.`
    );
    lines.push(`They said: "${truncate(context.transcript, MAX_TRANSCRIPT_CHARS)}"`);
    lines.push("");
    lines.push("Answer that transmission. Not an earlier one, and not what you said last time.");
    /**
     * The tools, named again, after the transmission.
     *
     * Not redundancy. Measured on `scripts/probe-self-report.ts`: the same traffic and
     * the same system prompt chose `unit_status` 6 of 10 times with eight tools on the
     * list, 2 of 10 with three, and **0 of 10 with the one tool tRadio actually ships**
     * — where it instead came back kind="call-up", reply="Go ahead, King 41" to "King
     * 41, traffic stop at Grove and Jefferson."
     *
     * I spent four rounds on the decision framing before dumping the two prompts side
     * by side (`--dump`), which took seconds and showed they are identical apart from
     * the tool lines. There is no degeneracy to fix: a single-item list is simply one
     * line in a thirteen-line prompt, while an eight-item list is half of it. The model
     * was not refusing the tool, it was not weighing it.
     *
     * So the list is restated in the position this file has twice found decisive — last,
     * because last is what the model reads nearest to writing. It is generated from
     * whatever the server registered, so a one-tool server gets the same salience as a
     * twenty-tool one and nothing here knows what any tool does.
     *
     * Ids only: the descriptions are above and repeating them would double the prompt.
     *
     * ## Restating the WHOLE tool line here was tried and MEASURED WORSE
     *
     * 2026-10-08, chasing BUG-72482 and BUG-26294. The argument for it was good and
     * the number was not, which is the pattern every prose change in this subsystem has
     * followed. It read:
     *
     *   "Check what they said against your tools. Each one takes one kind of value:"
     *   "- <id> — <description> It takes: <input>"   (per tool)
     *   "Use the one that takes the kind of value they just gave you, and give it that
     *    value. If none of them takes it, use none and answer in words."
     *
     * The reasoning: the closing clause asks for a match on "the kind of value", and
     * ids-only supplies no kinds, so the instruction's own premise was missing from the
     * position the decision is made in. Prompt length is not a reason against it —
     * `probe-decide-tokens.ts` establishes the turn is decode-bound, not prefill-bound.
     *
     * Measured, `scripts/probe-self-report.ts --runs 1`, ids only -> whole line:
     *
     *   shipped (1 tool)   status 5/5 -> 5/5    controls 3/3 -> 3/3
     *   harness (3 tools)  status 4/5 -> 3/5    controls 5/5 -> 5/5
     *   rich (8 tools)     status 2/5 -> 2/5    controls 4/5 -> 4/5
     *
     * So it cost a status case at three tools ("Dispatch, King 41, show me out at Grove
     * and Jefferson" stopped reaching the tool) and moved NEITHER target defect:
     * `page_supervisor("King 22 still on that call")` and the missing status on "traffic
     * stop at Grove and Jefferson" both survived it unchanged. The one thing it did
     * improve was an ARGUMENT — `request_cover("cover")` became `assign_unit("King 41")`
     * at eight tools — and that is the shape of BUG-69515, so if it is ever retried,
     * retry it against the `argument kept` column and not the choice columns.
     *
     * It is recorded rather than deleted because the reasoning is still the best
     * available account of why the restatement works at all, and because the next person
     * to notice the instruction/data mismatch should not have to pay for the run.
     *
     * The closing clause matters as much as the list. Told to check the tools and not
     * told what to do when none fits, a model with one tool has one way to comply.
     */
    if (tools.length > 0) {
      lines.push(
        `Check what they said against your tools — ${tools.map((tool) => tool.id).join(", ")} — ` +
          "and use the one that takes the kind of value they just gave you. " +
          // A strictness clause stood here and was MEASURED WORSE, so it is recorded
          // rather than kept. It read: "A tool that is only nearly right is wrong: if
          // what they said is not the kind of value the tool names, use none and answer
          // in words."
          //
          // It was aimed at a real over-reach the list above introduced at eight tools —
          // `page_supervisor("King 22 still on that call")`, a sergeant paged because a
          // unit asked a question. It did reduce that, 60% to 80% on the controls. It
          // also took the shipped column from 100% to 60%, the harness column from 60%
          // to 30% and the rich column from 40% to 20%: a clause that makes the model
          // hesitate hesitates everywhere, and the thing being fixed here is a model
          // that was already not reaching for its tools.
          //
          // Trading the primary fix for one control case out of twenty-six is the wrong
          // way round. The over-reach is real and is filed as its own work; it does not
          // get to cost the fix for the configuration every server starts in.
          "If none of them takes it, use none and answer in words."
      );
    }
  }

  return lines.join("\n");
}

/**
 * Give the model the outcome before it writes its reply.
 *
 * Without this it acknowledges an action that may have failed — a unit told
 * "showing you 10-8" when the CAD write was refused is worse than no dispatcher,
 * because they will believe it.
 */
export function buildOutcomePrompt(context: AiTurnContext, outcomes: readonly AiOutcome[]): string {
  const onCall = context.trigger === "call_intake";
  const who =
    context.trigger === "call"
      ? `the call from ${context.call?.caller || context.call?.source || "a caller"}`
      : onCall
        ? `a 911 call from ${context.callsign || context.call?.caller || "a caller"}`
        : `unit ${context.callsign || context.serverId}`;

  const lines = [`You were handling ${who}.`, "What you did:"];
  for (const outcome of outcomes) {
    lines.push(
      `- ${outcome.tool}${outcome.input ? ` with "${outcome.input}"` : ""}: ` +
        `${outcome.ok ? "succeeded" : "failed"} — ${outcome.message}`
    );
  }
  if (context.waiting.length > 0) {
    lines.push(`Still waiting to be answered: ${context.waiting.join(", ")}`);
  }
  lines.push("");

  const allFailed = outcomes.every((outcome) => !outcome.ok);
  // A caller is owed the outcome in the same words everything else on the call
  // is said in. "On the air" and "radio sentence" are instructions the model
  // follows, and following them on a phone line is how a frightened member of
  // the public gets answered in ten-codes.
  if (onCall) {
    lines.push(
      allFailed
        ? "Tell the caller in plain words that it did not go through. Do not tell them why in technical terms, and do not promise to try again."
        : "Tell the caller what actually happened, in plain words and nothing they did not need. Say nothing that did not happen."
    );
  } else {
    // An announcement names the caller so the model knows what the traffic is
    // about, and measured 2026-09-21 it then answered them: "Copy, Maria Ortiz
    // — request relayed to Los Santos OPS2", said on a channel the caller is
    // not on and never was. Naming who can hear this is the correction, since
    // the line above it is the thing that caused it.
    if (context.trigger === "call") {
      lines.push(
        "The caller is not on this channel and cannot hear you. This goes to the units, not to them."
      );
    }
    lines.push(
      allFailed
        ? "Say on the air in one short radio sentence that it did not go through, and why."
        : "Put it on the air in one short radio sentence. Cover what actually happened and nothing that did not."
    );
  }
  return lines.join("\n");
}

/**
 * Is this reply a line the model copied out of its own instructions?
 *
 * The last line of defence for the same failure the examples above caused, and
 * it stays after them because an operator's standing orders go into the same
 * prompt and can carry a sample transmission of their own. A copied line is not
 * aired: silence costs a turn, while "showing you out at 5th and Rockford" to a
 * unit who is nowhere near it is acted on.
 *
 * Four words, because shorter overlaps are genuine — "go ahead" and a callsign
 * are supposed to appear in both.
 */
export function echoesInstructions(reply: string, system: string): boolean {
  const said = flatten(reply);
  if (said.split(" ").length < 4) return false;
  return flatten(system).includes(said);
}

function flatten(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function describeChannelEntry(entry: ChannelEntry): string {
  return describeChannel(entry.zone, entry.name, entry.frequency);
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Vocabulary the transcriber should expect on this channel.
 *
 * Voice reaches the recogniser having been through a vocoder and 8 kHz of radio,
 * and a decoder with no expectations resolves the result to whatever is commonest
 * in English. Measured on this channel: "dispatch" came back as "this batch",
 * "did that", "this fashion" and "bitbats" — eight transmissions in a row, none
 * of which reached the dispatcher. The same audio with the wake phrase and the
 * channel's callsigns in the prompt is a different problem for the decoder.
 *
 * Phrased as radio traffic rather than a word list, because that is what an
 * initial prompt is: the text the recogniser believes came immediately before.
 */
/**
 * The fixed opening of a 911 call's bias.
 *
 * Exported so {@link callTranscriptionBias} and its test share one copy of the
 * sentence rather than two that can drift apart.
 */
export const CALL_BIAS_OPENING =
  "A 911 emergency call. The caller is describing where they are and what has happened.";

/**
 * Place names to tell the recogniser to expect, as its own sentence.
 *
 * Street names are the one kind of word on this path that nothing else supplies
 * and that the dispatcher cannot work without: an address heard wrong is a unit
 * sent nowhere, and it is also the failure the whole call-taker prompt is built
 * around getting right.
 *
 * Measured with `scripts/probe-vocoder-stt.ts --vocab`: "Vespucci Boulevard"
 * came back as "Bespucci"/"Spoochie" on every arm with no places named, and as
 * "Vespucci Boulevard" with WER 0 on every arm INCLUDING the fully vocoded one
 * once it was. So this is not a workaround for the vocoder — the vocoder was
 * never the obstacle for these words, and an unbiased 16 kHz clean arm gets them
 * wrong too.
 *
 * Eight, like the channel list, because whisper's initial prompt is a bounded
 * window shared with the callsigns and channels already in it, and a bias long
 * enough to crowd those out trades one mis-hearing for another.
 */
/**
 * The ten-codes a recogniser needs told, and why these ones.
 *
 * Measured failure: "Dispatch, we're code 4, suspect in custody" came back as
 * "Recode 4" on one run and "Workcode 4" on another — a two-word code with no
 * ordinary English reading, which is exactly the shape the channel-name fix already
 * proved the bias repairs ("OPS2" as "OBS2", WER 0 once named).
 *
 * The list is the top of `assets/reference/real-radio-traffix.txt` by real usage —
 * 10-4 appears 108 times there, 10-42 24, 10-8 20, 10-0 16, 10-6 10, 10-9 7, and
 * `code 4` 14 — rather than a published code sheet, most of which no channel says.
 *
 * Short on purpose. Whisper's initial prompt is a bounded window already shared
 * with the callsigns, channels and places, and crowding those out to spell codes
 * would trade one mis-hearing for another.
 */
const TEN_CODES = "Codes: 10-4, 10-8, 10-6, 10-9, 10-42, code 4.";

/**
 * The code sentence for the recogniser, from the server's own sheet when it has one.
 *
 * A server that declares codes gets exactly those: they are the tokens its units actually
 * say, and a sheet that differs from the default is precisely the case where the default
 * would bias the recogniser toward the wrong strings. A server with no sheet keeps the
 * corpus-derived list, which still helps for the codes everybody shares.
 *
 * Only the CODES, never the meanings — this string is an initial prompt telling whisper
 * what sounds to expect, and "traffic accident" is not a sound a unit makes.
 */
function codeBias(codes: Record<string, string>): string {
  const named = Object.keys(codes)
    .map((code) => code.trim())
    .filter(Boolean)
    .slice(0, 16);
  return named.length > 0 ? `Codes: ${named.join(", ")}.` : TEN_CODES;
}

/**
 * The phonetic alphabet, which I was wrong to leave out.
 *
 * This said "deliberately NOT here: 'Charlie Mike Tango 9' already transcribes
 * correctly, so there is no measured problem to spend budget on." That held while the
 * only thing a plate could do was sit in a status field. It stopped holding the moment
 * a plate reached a lookup: with a `run_plate` tool registered, "plate is 4 5 Charlie
 * Mike Tango 9" came back as "4-5 Charlie Mike **Cango** 9" and the dispatcher read out
 * a confident vehicle return for a plate nobody owns.
 *
 * One letter is the whole difference between the right car and a stranger's, so a plate
 * is the one place in this product where a single mis-heard token has a consequence a
 * unit will act on. That is worth about thirty tokens of prompt window.
 *
 * All 26 rather than the ones seen failing, because which letter gets mangled depends
 * on the speaker and the vocoder, and a partial list would read as a claim that the
 * rest are safe.
 */
const PHONETIC =
  "Letters: Alpha, Bravo, Charlie, Delta, Echo, Foxtrot, Golf, Hotel, India, Juliet, " +
  "Kilo, Lima, Mike, November, Oscar, Papa, Quebec, Romeo, Sierra, Tango, Uniform, " +
  "Victor, Whiskey, X-ray, Yankee, Zulu.";

function placesSentence(places: readonly string[]): string {
  const named = places
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 8);
  return named.length > 0 ? `Places: ${named.join(", ")}.` : "";
}

/**
 * The bias for a 911 call: the fixed sentence, plus any place names in hand.
 *
 * Separate from {@link transcriptionBias} rather than a flag on it, because the
 * two have opposite content by design. A caller has no callsign and is on no
 * channel, so naming units to the recogniser is how "I can't find him" comes
 * back as a unit number — the reasoning recorded at the call site in `index.ts`.
 * Places are the exception: they are the one vocabulary a caller genuinely is
 * about to say, which is why they belong here and the callsigns still do not.
 */
export function callTranscriptionBias(places: readonly string[] = []): string {
  const sentence = placesSentence(places);
  return sentence ? `${CALL_BIAS_OPENING} ${sentence}` : CALL_BIAS_OPENING;
}

export function transcriptionBias(
  wakePhrases: readonly string[],
  callsigns: readonly string[],
  channels: readonly string[] = [],
  places: readonly string[] = [],
  codes: Record<string, string> = {}
): string {
  const clean = (entries: readonly string[], limit: number) =>
    entries
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, limit);

  const vocabulary = clean([...wakePhrases, ...callsigns], 24);
  // Channel names are the other half of the problem and were missing. Measured
  // on the offline harness: "patch us to OPS2" came back as "OBS2" and "OBS too"
  // on every attempt, so the patch ran against a channel that does not exist and
  // failed. They are short, arbitrary and unlike English, which is exactly the
  // shape a decoder with no expectations resolves to something else.
  const named = clean(channels, 8);
  const where = placesSentence(places);
  if (vocabulary.length === 0 && named.length === 0 && !where) return "";

  const parts = ["Police radio traffic.", codeBias(codes), PHONETIC];
  if (vocabulary.length > 0) parts.push(`Units on the air: ${vocabulary.join(", ")}.`);
  if (named.length > 0) parts.push(`Channels: ${named.join(", ")}.`);
  if (where) parts.push(where);
  return parts.join(" ");
}

/**
 * Was this transmission addressed to the dispatcher?
 *
 * Radio channels carry unit-to-unit traffic the dispatcher must stay out of, and
 * a transcriber's output is lowercase, unpunctuated and approximate — so this
 * matches a phrase anywhere in the first few words rather than requiring it to
 * lead. Callers can disable the gate entirely by configuring no wake phrases,
 * which makes the dispatcher answer everything on its channels.
 *
 * The match is deliberately tolerant, because an exact one was measured missing
 * most of the real calls: see {@link nearlyMatches}.
 */
export function addressesDispatcher(transcript: string, wakePhrases: readonly string[]): boolean {
  if (wakePhrases.length === 0) return true;
  const words = radioWords(transcript).slice(0, 8);
  const opening = words.join(" ");
  return wakePhrases.some((raw) => {
    const phrase = raw.toLowerCase().trim();
    if (!phrase) return false;
    if (opening.includes(phrase)) return true;
    return nearlyMatches(words, phrase);
  });
}

/**
 * Was this transmission addressed to some *other* unit on the channel?
 *
 * The expectation that answers a unit's next transmission without a wake phrase
 * is right for "Go King 41" / "Traffic when ready" and wrong the moment that
 * same unit turns and calls somebody else. Measured on the offline harness: the
 * dispatcher answered "King 41 to King 22, you on this channel?" with "Go K41",
 * purely because it had spoken to King 41 a moment earlier. A human dispatcher
 * hears the second callsign and stays off the air.
 *
 * Only the two shapes that really are an address count:
 *
 *   - the transcript **opens** with another unit's name — "King 22, King 41"
 *   - another unit's name follows the word **to** — "King 41 to King 22"
 *
 * A name merely mentioned is not an address, which is the distinction that keeps
 * "show me out with King 22" answerable. Deliberately strict rather than
 * tolerant: {@link addressesDispatcher} can afford to guess, because guessing
 * wrong there costs an unanswered call that the unit will simply repeat. Guessing
 * wrong here makes the dispatcher talk over unit-to-unit traffic, and the cost of
 * a miss is only that it answers something it could have stayed out of.
 */
/**
 * Does this transmission open with the speaker's OWN callsign?
 *
 * The addressing route that was missing, and the measurement that justifies it:
 * across the 4,183 transmissions in `assets/reference/real-radio-traffix.txt`, the
 * word "dispatch" appears in **19 of them — 0.45%**, while **12.6%** open with a
 * callsign-shaped token instead. Real units do not hail dispatch, because on their
 * channel dispatch is simply who is listening; they lead with their own number and
 * say the thing. "42, I'm en route to the family problem." "448, can you send in
 * the description?"
 *
 * With `wakePhrases: ["dispatch"]` as the shipped default and no other route, the
 * dispatcher therefore ignored almost all realistic traffic — which is the root of
 * a unit transmitting twice and concluding nobody is there.
 *
 * ## It must be combined with `addressesAnotherUnit`, not used alone
 *
 * "King 41 to King 22, you on this channel?" opens with King 41's own callsign and
 * this returns **true** for it. That is deliberate: deciding whether a named third
 * party outranks the opener is `addressesAnotherUnit`'s job, it already handles both
 * the leading and the "to <unit>" forms, and duplicating it here would mean two
 * places to keep in step. The caller gates on it exactly as it already gates the
 * expectation route.
 */
/** A question word. Reliable at the head of a transmission, a relative clause anywhere else. */
const INTERROGATIVE = new Set(["what", "where", "when", "why", "who", "which", "how"]);

/** Auxiliaries that invert for a question: "can you", "did he", "any units". */
const INVERTS = new Set(["can", "could", "would", "will", "do", "does", "did", "any"]);

/** The copula, which inverts in "is there a unit?" and does not in "50 is around". */
const COPULA = new Set(["is", "are"]);

/** What a copula has to be followed by to have inverted. */
const SUBJECTS = new Set([
  "there",
  "that",
  "this",
  "it",
  "he",
  "she",
  "they",
  "we",
  "you",
  "i",
  "anybody",
  "anyone",
  "somebody",
  "everybody",
]);

/**
 * Words that can sit in front of the question without being part of it.
 *
 * A vocative, a filler, or a callsign. Anything else is a SUBJECT, and an auxiliary
 * with a subject in front of it is a statement — see {@link unitAskedAQuestion}.
 */
const PREAMBLE = new Set([
  "dispatch",
  "control",
  "radio",
  "hey",
  "and",
  "but",
  "also",
  "so",
  "ok",
  "okay",
  "alright",
  "yeah",
  "um",
  "uh",
  "er",
  "to",
  "copy",
  "go",
  "ahead",
  "now",
  "a",
  "the",
]);

const isNumber = (word: string | undefined) => /^[0-9]/.test(word ?? "");

/** An interrogative is never preamble, however it is spelled. */
const isInterrogative = (word: string) =>
  INTERROGATIVE.has(word) || INVERTS.has(word) || COPULA.has(word);

/**
 * How many of the opening words are in front of the question rather than part of it.
 *
 * A vocative, a filler, or a callsign — including a WORDED one. "King 41, any units
 * free?" is the shape this product's own callsigns take, and a reference corpus of
 * numeric callsigns could not see that the digit test alone missed it: the question
 * word ends up at index 2, behind a token that is not in any list. A word whose next
 * token is a number is a callsign on a radio channel.
 */
function preambleLength(words: readonly string[]): number {
  let at = 0;
  while (at < words.length) {
    const word = words[at] as string;
    if (PREAMBLE.has(word) || isNumber(word)) {
      at += 1;
      continue;
    }
    if (isNumber(words[at + 1]) && !isInterrogative(word)) {
      at += 2;
      continue;
    }
    break;
  }
  return at;
}

/**
 * Was the unit asking something, rather than telling us something?
 *
 * Decided from the transcript alone, which is the point: it is known before the
 * model has written a word, so the caller can act on it at draft time.
 *
 * ## It used to match an auxiliary anywhere in the opening, and that is 56% wrong
 *
 * Measured over `assets/reference/real-radio-traffix.txt` — 4,409 utterances, 351 of
 * them ending in a question mark — taking the mark as ground truth:
 *
 * | | precision | recall |
 * |---|---|---|
 * | any interrogative in the first six words | **0.444** | 1.000 |
 * | the head word only, copula only where a subject follows | **0.936** | 1.000 |
 *
 * The old rule called "Insurance is affirmative", "You can take 16 off the CAD",
 * "I can read you it" and "it is in Linden at 145, South Trinity" questions, because
 * it only asked whether an auxiliary was PRESENT. English inverts for a question, so
 * what matters is whether the auxiliary comes before the subject or after it.
 *
 * That mattered because of the one caller: {@link echoesTheQuestion} replaces a reply
 * that mostly repeats "the question" with a bare acknowledgement, and a correct
 * read-back — "copy, 41, out at Vespucci station" — mostly repeats the transmission
 * too. On a statement misread as a question, the substitution threw away the one
 * detail the dispatcher is supposed to confirm.
 *
 * Recall is unchanged at 1.000, which is the half that had to not regress: a question
 * missed is a question handed back to the unit, and that is the defect the guard
 * exists for. Of the 24 remaining false positives, most are questions the transcriber
 * left a full stop on ("Can you be in route", "Who is the on-duty supervisor for").
 *
 * ⚠ The corpus's callsigns are numeric, so it cannot see a worded one. 0.941 precision
 * was measured without {@link preambleLength}'s second clause, and "King 41, any units
 * free for a second car" — this product's own callsign shape — read as a statement at
 * that setting. The clause costs two false positives and is kept for that.
 */
export function unitAskedAQuestion(transcript: string): boolean {
  const text = transcript.trim();
  if (!text) return false;
  // A transcriber punctuates, and when it does the mark is the answer.
  if (text.endsWith("?")) return true;

  const opening = radioWords(text);
  // Past the vocative and the callsign: "1-6-5, can you copy…" asks something,
  // and the first four words of it are not the question.
  const at = preambleLength(opening);
  const head = opening[at];
  if (!head) return false;

  if (INTERROGATIVE.has(head) || INVERTS.has(head)) return true;
  // A copula inverts only when a subject follows it. "Is there another unit" and
  // "is that a 10-15" ask something; "50 is around" and "8J35 is on scene at that
  // one" are two of the commonest statements on the whole channel and leave `is` in
  // exactly the same place once the callsign is consumed.
  return COPULA.has(head) && SUBJECTS.has(opening[at + 1] ?? "");
}

/**
 * Is this reply an acknowledgement that just hands the question back?
 *
 * The measured tell, and the last style gap against the reference corpus. Real
 * dispatchers answer with a bare acknowledgement 42% of the time; ours did so 0% of
 * the time, because the prompt used to MANDATE a read-back detail and a question
 * gives it nothing true to put there. The results were "Copy, 15, weather looking
 * like tonight", "copy, K15, you still there" and "copy, K22, asked for that play".
 *
 * Making the mandate optional in prose moved the acknowledgement VOCABULARY onto the
 * reference almost exactly (copy 82% -> 35% against a reference 35%) and left the
 * bare share at 0%, which is the pattern every prose change in this subsystem has
 * followed. So this is the structural half.
 *
 * ## Why it is safe to substitute here and nowhere else
 *
 * A correct read-back is also mostly the unit's own words — "copy, 41, out at
 * Vespucci station" is a near-total echo and is exactly right. What makes the bad
 * ones distinguishable is not the echo, it is that the unit ASKED. There is nothing
 * to confirm in a question, so an acknowledgement carrying its words back is wrong
 * whatever it contains, and the bare form is both shorter and honest.
 *
 * Deliberately narrow: statements are untouched, so every status, location and
 * description read-back behaves exactly as before.
 */
export function echoesTheQuestion(transcript: string, reply: string): boolean {
  if (!unitAskedAQuestion(transcript)) return false;
  const said = radioWords(reply).filter((word) => word.length > 1);
  if (said.length === 0) return false;
  const asked = new Set(radioWords(transcript));
  const shared = said.filter((word) => asked.has(word)).length;
  // Half or more of the reply came out of the question it is answering.
  return shared / said.length >= 0.5;
}

export function opensWithOwnCallsign(
  transcript: string,
  callsign: string,
  unitId: string
): boolean {
  const words = radioWords(transcript).slice(0, 8);
  if (words.length === 0) return false;

  // A ten-code is not a callsign, however the speaker's own number reads.
  // `radioWords` drops the hyphen, so "10-4" arrives as ["10", "4"] — and a unit
  // numbered 10 would otherwise be addressed by every ten-code on the channel.
  if (words[0] === "10" && /^\d{1,2}$/.test(words[1] ?? "")) return false;

  const names = [callsign, unitId].filter((value) => value.trim());

  // The whole callsign, however it is spelled — "King 41, …" or "K41, …".
  for (const name of names) {
    const tokens = radioWords(name);
    if (tokens.length > 0 && tokens.every((token, index) => words[index] === token)) return true;
  }

  // The number alone, which is how units habitually identify themselves. Two
  // digits minimum: a single digit collides with far too much ordinary traffic,
  // and no real callsign in the corpus is one digit.
  for (const name of names) {
    const digits = (name.match(/\d{2,}/g) ?? []).pop();
    if (digits && words[0] === digits) return true;
  }
  return false;
}

/**
 * Which unit, if any, the dispatcher just spoke TO in a transmission of its own.
 *
 * Needed because an expectation only ever followed the unit who had just keyed, and a
 * dispatcher does not only answer — it calls out. Measured: asked "King 41 to control,
 * send me another unit", the dispatcher aired "King 41 copy, King 15 route, assisting
 * King 41", and King 15's "10-4, I'm en route" was then **dropped as not addressed to
 * dispatch**, because the expectation was sitting on King 41 and the reply carried
 * neither a wake phrase nor its own callsign. The second half of the exchange the
 * dispatcher itself started could not reach it.
 *
 * Searches the whole transmission rather than its opening, which is the opposite of
 * {@link addressesAnotherUnit}: that one asks "was this traffic for somebody else",
 * where the name leads, and this asks "did I name somebody", where it can be anywhere.
 *
 * Excludes `speakerId` so acknowledging a unit by name does not count as calling out to
 * them — they already have the expectation by having spoken, and the interesting case is
 * a THIRD party. Returns the first unit named, since one transmission asking two
 * different units to answer is not a thing a dispatcher does.
 */
export function unitNamedIn(
  reply: string,
  roster: readonly { serverId: number; callsign: string; unitId: string }[],
  speakerId: number
): number | null {
  const words = radioWords(reply);
  if (words.length === 0) return null;
  for (const unit of roster) {
    if (unit.serverId === speakerId) continue;
    for (const spelling of [unit.callsign, unit.unitId]) {
      const name = radioWords(spelling ?? "");
      if (name.length === 0) continue;
      for (let at = 0; at + name.length <= words.length; at++) {
        if (name.every((word, index) => words[at + index] === word)) return unit.serverId;
      }
    }
  }
  return null;
}

export function addressesAnotherUnit(transcript: string, otherUnits: readonly string[]): boolean {
  const words = radioWords(transcript).slice(0, 8);
  if (words.length === 0) return false;

  for (const raw of otherUnits) {
    const name = radioWords(raw);
    if (name.length === 0) continue;
    const at = (start: number) => name.every((word, index) => words[start + index] === word);
    if (at(0)) return true;
    for (let i = 0; i + 1 + name.length <= words.length; i++) {
      if (words[i] === "to" && at(i + 1)) return true;
    }
  }
  return false;
}

/**
 * Words that carry no traffic — the joins a unit puts between two callsigns.
 *
 * Everything else in a transmission is something the unit said, and something
 * said is something the dispatcher has to answer rather than wave through.
 */
const CALL_UP_FILLER = new Set([
  "to",
  // `radioWords` drops the apostrophe, so "you're" arrives as "you" then a bare "re".
  // Without it, every contraction in an otherwise empty transmission reads as traffic.
  "re",
  "for",
  "this",
  "is",
  "hey",
  "yeah",
  "uh",
  "um",
  "er",
  "go",
  "ahead",
  "come",
  "in",
  "you",
  "on",
  "there",
  "copy",
  "over",
  "radio",
  "check",
]);

/**
 * Is this transmission nothing but "it's me, are you listening?"
 *
 * The answer to one of these is fixed — the go-ahead, with their callsign — and
 * a fixed answer does not need a language model to write it. Measured on the
 * offline harness: the 4B took 8.1 seconds to produce "Go ahead, King 41", and
 * 9.3 seconds passed before the first word of it reached the channel. The same
 * line said straight from here costs one synthesis and nothing else.
 *
 * Deliberately conservative in the direction that matters. A call-up mistaken
 * for traffic just goes the slow way and is answered correctly; traffic mistaken
 * for a call-up gets the go-ahead and the unit has to say it all again, which is
 * the exact failure this whole area has been fighting. So every word has to be
 * accounted for: a wake phrase, the unit's own name, or a join. One word that is
 * none of those and it is traffic.
 *
 * `nearlyMatches` is not used here, for the same reason. The fuzzy match exists
 * so a mangled wake phrase still reaches the model, and reaching the model is
 * precisely what this path skips.
 */
/**
 * Words that say "I have traffic for you" and nothing else.
 *
 * A unit does not open with its business. The protocol is hail, go-ahead, "traffic",
 * go-ahead, and only then the substance — so there are two transmissions in every
 * exchange whose entire content is "are you ready for me", and both have exactly one
 * correct answer.
 */
const TRAFFIC_SIGNAL = new Set([
  "traffic",
  "when",
  "ready",
  "got",
  "have",
  "has",
  "some",
  "standby",
  "stand",
  "by",
  "advised",
  "be",
  "question",
  "request",
]);

/**
 * Is this only a unit saying they have something, without saying what?
 *
 * The same shape as {@link isBareCallUp} and for the same reason: the answer is a fixed
 * go-ahead, so it needs no model, costs no decode, and cannot invent anything.
 *
 * It matters more than it looks. The realistic protocol is five transmissions for one
 * piece of traffic, three of which are this handshake, and before this they each paid a
 * full 5-8 s decode to arrive at "go ahead" — on a channel where a turn is the scarce
 * resource. The system prompt has told the model "'Traffic when ready' with nothing
 * after it is not a request yet" since early on; this is that rule moved off generation,
 * which is the only place it is reliable.
 *
 * **A name is NOT required**, which is the one real difference from `isBareCallUp`. By
 * the time a unit says "traffic" they have already hailed and been answered, so the
 * transmission is a bare word and the expectation is what addresses it. Anything
 * substantive in the transmission disqualifies it, so "traffic stop at Grove" is not a
 * signal and still reaches the model.
 */
export function isTrafficSignal(
  transcript: string,
  wakePhrases: readonly string[],
  names: readonly string[]
): boolean {
  const words = radioWords(transcript);
  // Eight, matching `isBareCallUp`. "Dispatch, King 41 has traffic for you" is seven and
  // entirely ordinary; the cap is a sanity bound, and the substantive-word check below is
  // what actually keeps real traffic out.
  if (words.length === 0 || words.length > 8) return false;

  const known: string[][] = [];
  for (const raw of [...wakePhrases, ...names]) {
    const name = radioWords(raw);
    if (name.length > 0) known.push(name);
  }

  let signalled = false;
  let at = 0;
  while (at < words.length) {
    const match = known.find((name) => name.every((word, index) => words[at + index] === word));
    if (match) {
      at += match.length;
      continue;
    }
    const word = words[at] as string;
    if (TRAFFIC_SIGNAL.has(word)) {
      // "traffic" is the word that makes it a signal; the rest only qualify it, so
      // "when ready" on its own is not one.
      if (word === "traffic" || word === "question" || word === "request") signalled = true;
      at++;
      continue;
    }
    if (CALL_UP_FILLER.has(word)) {
      at++;
      continue;
    }
    return false;
  }
  return signalled;
}

export function isBareCallUp(
  transcript: string,
  wakePhrases: readonly string[],
  names: readonly string[]
): boolean {
  const words = radioWords(transcript);
  if (words.length === 0 || words.length > 8) return false;

  const known: string[][] = [];
  for (const raw of [...wakePhrases, ...names]) {
    const name = radioWords(raw);
    if (name.length > 0) known.push(name);
  }
  if (known.length === 0) return false;

  let named = false;
  let at = 0;
  while (at < words.length) {
    const match = known.find((name) => name.every((word, index) => words[at + index] === word));
    if (match) {
      named = true;
      at += match.length;
      continue;
    }
    if (!CALL_UP_FILLER.has(words[at] as string)) return false;
    at++;
  }
  // "Hey, you there" accounts for every word and names nobody. That is not a
  // call-up, it is a transmission the model should look at.
  return named;
}

/** Lowercase alphanumeric words, which is the shape a transcript arrives in. */
function radioWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Does any run of the opening words nearly spell the wake phrase?
 *
 * Windows are joined without their spaces before comparing, because the error
 * that matters splits one word into two: "dispatch" heard as "this batch" is
 * three edits away joined, and a hopeless distance apart word by word.
 *
 * The budget is a third of the phrase's length, which is generous — and was
 * chosen against the real misses rather than picked. On the measured set it
 * admits "this patch" (2) and "this batch" (3) and still rejects "did that" (5),
 * "bitbats" (5) and "dash" (5). Short phrases are matched exactly: a third of
 * four letters admits most of the language.
 */
export function nearlyMatches(words: readonly string[], phrase: string): boolean {
  const target = phrase.replace(/\s+/g, "");
  if (target.length < 6) return false;
  const budget = Math.ceil(target.length / 3);
  const span = phrase.split(/\s+/).filter(Boolean).length;

  // One word either side of the phrase's own word count: the transcriber splits
  // and joins words, so the right window is not the one arithmetic predicts.
  for (let size = Math.max(1, span - 1); size <= span + 1; size++) {
    for (let start = 0; start + size <= words.length; start++) {
      const candidate = words.slice(start, start + size).join("");
      if (Math.abs(candidate.length - target.length) > budget) continue;
      if (editDistance(candidate, target) <= budget) return true;
    }
  }
  return false;
}

/** Levenshtein, iterative and two-rowed. Inputs here are one radio word long. */
function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}
