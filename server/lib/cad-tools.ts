/**
 * The dispatcher's CAD tools. One set, whichever CAD is installed.
 *
 * Every tool here is gated on a declared capability, so a CAD that cannot do a
 * thing never causes the tool to be offered. That is the whole design, and it is
 * driven by a measurement rather than by taste: `scripts/probe-self-report.ts`
 * showed that **the length of the tool list changes this model's behaviour** —
 * `unit_status` was chosen 0 of 10 times with one tool and 6 of 10 with eight, on
 * identical traffic. Four per-CAD tool sets would mean four different list lengths
 * and four separate measurements; one capability-gated set means the single
 * measured number (70% capture, controls clean) holds for all of them.
 *
 * The tool DESCRIPTIONS are also deliberately CAD-agnostic. The model is never told
 * which CAD it is talking to, because that is not a thing a dispatcher knows or
 * says — and because a description that named one would have to change per provider,
 * which is exactly the per-CAD divergence this layer exists to prevent.
 *
 * Capability differences therefore surface as tools that are simply absent:
 *
 * | tool | Sonoran | ImperialCAD | wasabi_mdt |
 * |---|---|---|---|
 * | `run_plate`    | ✓ | ✓ | ✓ |
 * | `run_name`     | — | — | — |
 * | `create_call`  | ✓ | ✓ | ✓ |
 * | `attach_unit`  | ✓ | ✓ | — |
 * | `clear_unit`   | ✓ | — | — |
 * | `close_call`   | ✓ | ✓ | — |
 * | `add_note`     | ✓ | ✓ | — |
 * | `cad_status`   | ✓ | — | — |
 *
 * Three of the six, because those three make the point. `run_name` is a dash in all
 * three columns and is not dead: only LACORE can look a person up, and tk_mdt can
 * answer warrants and nothing else. `docs/content/ai-dispatcher.mdx` carries the full
 * matrix for all six, and it is the operator-facing copy of this table.
 */

import { aiLog } from "./logger";
import type { AiTurnContext, ToolResult } from "./types";
import { activeCad } from "./cad";
import { callFor, forgetCall, openCallCount } from "./cad-calls";
import { type CadCapability, type CadPerson, type CadPlate, cadRefusal } from "./cad-types";

/** The tool shape `builtins.ts` consumes. Structural, to avoid a circular import. */
export interface CadTool {
  id: string;
  description: string;
  input: string;
  available: (context: AiTurnContext) => boolean;
  run: (context: AiTurnContext, input: string) => Promise<ToolResult>;
  onCall?: boolean;
  yieldsToLua?: true;
}

/** Offer a tool only when a CAD is connected and can actually do this. */
function gate(capability: CadCapability, extra?: (context: AiTurnContext) => boolean) {
  return (context: AiTurnContext): boolean => {
    /**
     * Never on a turn with no unit behind it, and this is not a tidiness guard.
     *
     * Two turns have no unit. A `call_intake` turn is already excluded centrally in
     * `builtins.ts` (`onCall`), but an ANNOUNCEMENT — the dispatcher putting a fresh
     * 911 call out on the air — is not: `describeTools` adds the built-ins before its
     * `serverId <= 0` early return, so without this every CAD tool was offered with
     * `serverId` 0.
     *
     * The radio built-ins are deliberately kept on an announcement, and should be:
     * patching, alerts and tones act on a CHANNEL, and a channel is exactly what an
     * announcement has. Every tool here acts on a UNIT, and there is no unit.
     *
     * ⚠ The consequence was worse than a wasted turn. `server/sv_integrations.lua`
     * already mirrors every queued 911 call into the CAD, so the announcement turn
     * for that same call could open a SECOND record for one incident — and while
     * Imperial and Sonoran fail safe (both resolve an identity from `serverId` and
     * answer `absent` for 0), wasabi_mdt and tk_mdt need no identity to create a
     * call, so on those two it would genuinely have duplicated it.
     */
    if (context.serverId <= 0) return false;

    /*
     * The operator's "a language model may not write to my CAD" consent is tRadio's
     * `Config.cad.tools`, and `activeCad()` is null while it is off, so it covers every
     * tool and every provider at once without a second switch to keep in step.
     */
    const provider = activeCad();
    if (provider === null || !provider.supports.has(capability)) return false;
    return extra ? extra(context) : true;
  };
}

/**
 * The call this unit is on: ours first, then the CAD's own view.
 *
 * Ours first because a call we opened carries the `closeRef` some CADs need (ImperialCAD
 * attaches by number and closes by id) and the `about` text a readback can use. The
 * CAD's view second because on LACORE it is authoritative and covers calls a human
 * dispatcher opened — which no other provider can answer at all.
 */
function currentCall(context: AiTurnContext) {
  const mine = callFor(context.serverId);
  if (mine) return mine;
  const live = activeCad()?.liveCall?.(context.serverId) ?? null;
  return live ? { ...live, about: "", openedAt: Date.now() } : null;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Which unit the model meant, or null when that cannot be answered.
 *
 * Mirrors `resolveChannel`'s discipline rather than inventing its own: a value
 * matching two units resolves to NEITHER and the refusal goes out on the air. A
 * dispatcher asking "which unit?" is normal radio; a dispatcher attaching the wrong
 * car to a call is a unit driving to the wrong place.
 *
 * The speaker is excluded. Every transmission that reaches this is one unit asking
 * for a DIFFERENT one — "send me another unit" — and the model routinely opens with
 * its own callsign, so leaving the speaker in means the commonest phrasing resolves
 * to the asker and the tool attaches them to their own call.
 */
function resolveUnit(context: AiTurnContext, input: string): number | null {
  const said = normalize(input);
  if (!said) return null;

  const hits = context.roster
    .filter((unit) => unit.serverId !== context.serverId)
    .filter((unit) => {
      const callsign = normalize(unit.callsign ?? "");
      if (callsign && said.includes(callsign)) return true;
      const unitId = normalize(unit.unitId ?? "");
      return unitId.length > 1 && said.includes(unitId);
    });

  return hits.length === 1 ? ((hits[0] as { serverId: number }).serverId ?? null) : null;
}

function nameOf(context: AiTurnContext, serverId: number): string {
  const unit = context.roster.find((entry) => entry.serverId === serverId);
  const callsign = unit?.callsign;
  return callsign && callsign !== "" ? callsign : `unit ${serverId}`;
}

/**
 * Say a plate return the way a dispatcher does: exceptions first, briefly.
 *
 * A unit on a traffic stop cares about two things before anything else — is it
 * stolen, and is the registration good. Reading all seven fields a CAD can return
 * is a paragraph, and the dispatcher has a ten-word budget.
 */
function describePlate(info: CadPlate): string {
  const flags: string[] = [];
  if (info.stolen === true) flags.push("reported stolen");
  if (info.insured === false) flags.push("no insurance");
  const registration = info.registration?.toLowerCase();
  if (registration && registration !== "valid") flags.push(`registration ${registration}`);
  for (const flag of info.flags ?? []) flags.push(flag);

  if (flags.length > 0) {
    return info.owner ? `${info.owner}, ${flags.join(", ")}` : flags.join(", ");
  }
  return info.owner ? `${info.owner}, comes back clear` : "comes back clear";
}

const runPlate: CadTool = {
  yieldsToLua: true,
  id: "run_plate",
  description: "the unit is asking you to run a plate, or has read one to you",
  input: "the plate only, in the letters and numbers the unit gave",
  // Either capability offers the tool; the two answer different questions and the
  // wording below keeps them apart.
  available: (context) => gate("plate")(context) || gate("bolo")(context),
  run: async (_context, input) => {
    // Spacing stripped: a plate dictated phonetically reaches here as the letters
    // and digits the unit said, spaced the way they said them, which no CAD matches.
    const plate = input.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    if (plate.length < 2) return { ok: false, message: "you did not give me a plate" };

    const provider = activeCad();
    /**
     * A full lookup when the CAD has one, a flag check when it does not — and the
     * reply says which.
     *
     * tk_mdt can answer "is this vehicle flagged" and cannot read a registration.
     * Reporting that as "comes back clear" would tell a unit the car is clean when
     * all that was established is that nobody has circulated it, and a unit acts on
     * the difference. So a `bolo`-only CAD gets wording that claims only what it
     * checked.
     */
    const full = provider?.plate;
    if (full) {
      const result = await full(plate);
      if (!result.ok || !result.body) return { ok: false, message: cadRefusal(result) };
      return { ok: true, message: `${plate}, ${describePlate(result.body)}` };
    }

    const flagged = provider?.bolo;
    if (!flagged) return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await flagged(plate);
    if (!result.ok || !result.body) return { ok: false, message: cadRefusal(result) };
    const flags = result.body.flags ?? [];
    return {
      ok: true,
      message:
        flags.length > 0
          ? `${plate}, ${flags.join(", ")}`
          : // Never "clear". The registration was not read.
            `${plate}, nothing circulated on it`,
    };
  },
};

/**
 * Say a person return the way a dispatcher does.
 *
 * Flags first and briefly, same budget as a plate. The record COUNT is reported
 * rather than a name read back, because the name is what the unit just said — and
 * because two records for one name is the thing a dispatcher actually relays ("I have
 * two on that name").
 */
function describePerson(info: CadPerson): string {
  const flags = info.flags ?? [];
  const found = info.matches > 1 ? `${info.matches} records` : "one record";
  if (flags.length > 0) return `${found}, ${flags.join(", ")}`;
  return `${found}, nothing flagged`;
}

/**
 * Run a name — the person half of `run_plate`, and it exists for the same reason.
 *
 * `person` and `warrants` were implemented in three providers and in the Lua bridge
 * and no tool ever called either, so a unit asking the dispatcher to run a name got
 * nothing on every CAD that can answer one.
 *
 * The `person`/`warrants` split is honoured in the WORDING, exactly as `plate`/`bolo`
 * is: tk_mdt can establish "no warrants on file" and cannot establish "nobody of that
 * name is known", and a unit about to walk up to somebody acts on the difference.
 */
const runName: CadTool = {
  yieldsToLua: true,
  id: "run_name",
  description: "the unit is asking you to run a name, or to check somebody for warrants",
  input: "the name only, as the unit gave it",
  available: (context) => gate("person")(context) || gate("warrants")(context),
  run: async (_context, input) => {
    // Punctuation only. Unlike a plate, the spaces in a name are the name.
    const name = input.replace(/[^\p{L}\p{N}'\- ]/gu, "").trim();
    if (name.length < 2) return { ok: false, message: "you did not give me a name" };

    const provider = activeCad();

    const full = provider?.person;
    if (full) {
      const result = await full(name);
      if (!result.ok || !result.body) return { ok: false, message: cadRefusal(result) };
      return { ok: true, message: `${name}, ${describePerson(result.body)}` };
    }

    const onlyWarrants = provider?.warrants;
    if (!onlyWarrants) return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await onlyWarrants(name);
    if (!result.ok || !result.body) return { ok: false, message: cadRefusal(result) };
    return {
      ok: true,
      message: result.body.warrants
        ? `${name}, warrants on file`
        : // Never "comes back clear" and never "nothing on file". Only the warrant
          // list was read; whether the CAD knows this person at all was not asked.
          `${name}, no warrants showing`,
    };
  },
};

const createCall: CadTool = {
  yieldsToLua: true,
  id: "create_call",
  description:
    "the unit is reporting something that should become a call — a stop, a crash, a disturbance",
  input: "what the call is and where, in the unit's own words",
  available: gate("createCall"),
  run: async (context, input) => {
    const about = input.trim();
    if (!about) return { ok: false, message: "you did not say what the call is" };

    const provider = activeCad();
    if (!provider?.createCall)
      return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await provider.createCall(context.serverId, about);
    if (!result.ok) return { ok: false, message: cadRefusal(result) };

    const ref = result.body?.ref;
    if (!ref) {
      // It exists and cannot be referenced again. Saying it failed would be a lie;
      // promising to close it later would be a different one.
      aiLog.warn("cad: the call was created but came back with no reference");
      return { ok: true, message: "call created" };
    }
    return { ok: true, message: `call ${ref} created` };
  },
};

const attachUnit: CadTool = {
  yieldsToLua: true,
  id: "attach_unit",
  description: "a unit is being sent to, or is arriving at, a call that already exists",
  input: "which unit is going",
  // Only when there is a call to attach them TO. Offering it with none invites the
  // model to attach a unit to a reference it invented, and call numbers are
  // sequential — a wrong guess is very likely to be somebody else's real call.
  available: gate("attachUnit", (context) => openCallCount() > 0 || currentCall(context) !== null),
  run: async (context, input) => {
    const target = resolveUnit(context, input);
    if (target === null) return { ok: false, message: "which unit?" };

    // The speaker's own call, not one named in the text. This is the flow the whole
    // thing exists for: 41 reports a stop, 41 asks for another unit, 42 goes to 41's
    // call. The model is never asked to repeat a call number it would have to have
    // memorised, because a number it guesses wrong is a real call belonging to
    // somebody else.
    const call = currentCall(context) ?? callFor(target);
    if (!call) return { ok: false, message: "there is no call open for that" };

    const provider = activeCad();
    if (!provider?.attachUnit)
      return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await provider.attachUnit(target, call);
    if (!result.ok) return { ok: false, message: cadRefusal(result) };
    return { ok: true, message: `${nameOf(context, target)} attached to call ${call.ref}` };
  },
};

const clearUnit: CadTool = {
  yieldsToLua: true,
  id: "clear_unit",
  description: "a unit is done with a call and is available for another one",
  input: "which unit is clearing, or nothing for the unit who just spoke",
  available: gate("detachUnit"),
  run: async (context, input) => {
    // Falls back to the speaker, because "10-8" and "show me clear" name nobody and
    // are overwhelmingly the way this arrives.
    const target = resolveUnit(context, input) ?? context.serverId;
    const provider = activeCad();
    if (!provider?.detachUnit)
      return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await provider.detachUnit(target);
    if (!result.ok) return { ok: false, message: cadRefusal(result) };
    if (target === context.serverId) forgetCall(target);
    return { ok: true, message: `${nameOf(context, target)} cleared` };
  },
};

const closeCall: CadTool = {
  yieldsToLua: true,
  id: "close_call",
  description: "the call is finished and needs nobody else on it",
  input: "nothing — it closes the call this unit is on",
  available: gate("closeCall", (context) => currentCall(context) !== null),
  run: async (context) => {
    const call = currentCall(context);
    if (!call) return { ok: false, message: "you have no call open" };
    const provider = activeCad();
    if (!provider?.closeCall) return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await provider.closeCall(context.serverId, call);
    if (!result.ok) return { ok: false, message: cadRefusal(result) };
    return { ok: true, message: `call ${call.ref} closed` };
  },
};

const addNote: CadTool = {
  yieldsToLua: true,
  id: "add_note",
  description: "something the unit said that should be written onto the call they are on",
  input: "what to add to the call, in their words",
  // ImperialCAD's note endpoint carries no call id and appends to whatever call the
  // CAD has that unit on, so it needs no reference. Every other provider does. Gated on
  // either being true, so a CAD that can answer "which call" keeps the tool.
  available: gate("addNote", (context) => {
    const provider = activeCad();
    return provider?.id === "imperial" || currentCall(context) !== null;
  }),
  run: async (context, input) => {
    const note = input.trim();
    if (!note) return { ok: false, message: "you did not say what to add" };
    const provider = activeCad();
    if (!provider?.addNote) return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    const result = await provider.addNote(context.serverId, note);
    if (!result.ok) return { ok: false, message: cadRefusal(result) };
    return { ok: true, message: "noted on the call" };
  },
};

/**
 * Write the unit's status into the CAD as well as into tRadio.
 *
 * A **separate tool from `unit_status`**, not a replacement, and the separation is
 * deliberate. `unit_status` (sv_tools.lua) always exists and is the authority on what
 * a unit is doing; this one mirrors it into a CAD, and only one of the four systems
 * surveyed can do it at all. Folding them together would mean a radio status that
 * silently failed to record whenever the CAD was the wrong one, and a tool whose
 * behaviour changed with the operator's choice of CAD.
 *
 * It yields to Lua like the rest, so an operator who already wired their own CAD
 * status hook keeps it.
 */
const cadStatus: CadTool = {
  yieldsToLua: true,
  id: "cad_status",
  description: "the unit gave a status that should also be recorded in the computer system",
  input: "the status the unit just gave, in the words they used for it",
  available: gate("writeStatus"),
  run: async (context, input) => {
    const spoken = input.trim();
    if (!spoken) return { ok: false, message: "you did not give a status" };
    const provider = activeCad();
    if (!provider?.writeStatus) {
      return { ok: false, message: cadRefusal({ kind: "off", ok: false }) };
    }
    const result = await provider.writeStatus(context.serverId, spoken);
    if (!result.ok) {
      // `absent` here most often means the status could not be mapped onto anything
      // the CAD accepts — which is a refusal to guess, not a fault. The dispatcher
      // says so plainly and the unit's status here is unaffected.
      return { ok: false, message: cadRefusal(result) };
    }
    return { ok: true, message: `${nameOf(context, context.serverId)} updated on the system` };
  },
};

/** Every CAD tool. Order is the order the registry sees them. */
export const CAD_TOOLS: CadTool[] = [
  runPlate,
  runName,
  createCall,
  attachUnit,
  clearUnit,
  closeCall,
  addNote,
  cadStatus,
];
