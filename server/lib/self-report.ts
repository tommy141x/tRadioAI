/**
 * Writing down a self-report without asking the model to choose a tool for it.
 *
 * ## The defect this exists for (BUG-72482)
 *
 * "King 41, traffic stop at Grove and Jefferson." is the single most ordinary thing a
 * unit says, and with more than one tool registered its status was never recorded.
 * Measured 2026-10-08, `scripts/probe-self-report.ts`, qwen3-4b-instruct-2507:
 *
 *   1 tool    unit_status("traffic stop")                     3 of 3 runs
 *   3 tools   kind="report" about="traffic stop at Grove       8 of 8 runs
 *   8 tools   and Jefferson" reply="copy King 41"  ACTIONS []
 *
 * The classification is right every single time. `about` is right every single time,
 * and it is a quote. What fails is only the step after it — matching that value to a
 * tool — and that step flips on the LENGTH OF THE TOOL LIST with identical text, which
 * is not something a prompt can be trusted to hold. Three attempts to make it hold were
 * measured and all three are recorded where they were tried:
 *
 *  - restating the whole tool line after the transmission instead of the ids
 *    (`prompt.ts`) — moved nothing, cost a status case;
 *  - widening the shipped tool's own declaration to name what the unit is DOING
 *    (`server/sv_ai_dispatch.lua`, tried in the probe's copy) — took "show me out at
 *    Grove and Jefferson" from a status to a go-ahead at three tools;
 *  - naming only `unit_status` in the restated line, as a diagnostic — still 0 of 4 on
 *    the failing case, and it took the over-reach control to 0 of 2. So the cause is the
 *    other tools being PRESENT, not pressure from the restated list. A fourth prompt
 *    revision is not the answer and AGENTS.md §6.1 says so in as many words: "move it
 *    off generation onto a fixed line, a grounded tool or a server-side decision".
 *
 * ## So the model keeps the half it is reliable at
 *
 * It classifies and it labels; tRadio decides whether that is a status write. The model
 * is never asked to pick the tool, so list length cannot reach this path at all — which
 * is the whole point, since list length is the measured variable.
 *
 * ## Every condition here is load-bearing
 *
 * `about` is NOT trusted. It goes through {@link argumentRefusal} — the same gate
 * `runTool` applies — so an invented label cannot become authoritative roster data that
 * feeds back into every later turn. That is the protection AGENTS.md calls the strongest
 * one in the subsystem, and this leans on it rather than working around it.
 *
 * The control that nearly made this unsafe is "King 41, be advised there's a lot of
 * traffic on the bridge." — a report about the WORLD, not about the unit, and a road
 * condition written into a status field is exactly the over-recording this area is prone
 * to. Measured 3 of 3: the model answers it kind="call-up", about="", so the `kind` gate
 * and the empty-`about` gate both exclude it. It is a measurement, not a deduction, and
 * it is the first thing to re-measure if the framing's `kind` vocabulary ever changes.
 *
 * ## Why `unit_status` by id, knowing that keying by id has already been a trap
 *
 * AGENTS.md records `groundedIn` and `outcomeReadback` being keyed on the exact id
 * `unit_status` and every offline run silently missing both because the stubs were
 * called `set_unit_status`. The id is used here anyway, deliberately: it is the one tool
 * tRadio ships, and the generalisation — any tool whose input declares it is a quote —
 * would pick up `create_call` on an ImperialCAD server and open a CAD incident on every
 * report the model happened to label. A status write is cheap, visible on the panel and
 * reversible; opening somebody's call is not. If you add a stub, use the shipped id.
 */

import { argumentRefusal } from "./tools";
import type { AiAction, AiDecision, AiTool, AiTurnContext } from "./types";

/** A word for matching purposes: lowercase, punctuation gone, a hyphenated code left whole. */
function words(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter(Boolean);
}

/**
 * `about` without the speaker's own callsign on the front of it.
 *
 * The model writes `about` as a label, and for a self-report it habitually labels it with
 * the unit's name: measured, "King 41, I'll be out with two at the Pink Cage." comes back
 * about="King 41 out with two at Pink Cage" and about="King 41 is out with two at the Pink
 * Cage". Both are correct labels and neither is grounded — the callsign is followed in the
 * transmission by "I'll be", so the quote is not contiguous and {@link argumentRefusal}
 * rightly refuses it.
 *
 * Stripping it is a server-side normalisation against a fact tRadio already holds, not a
 * loosening of the quote test: everything after the callsign still has to appear in the
 * transmission contiguously and in order. And the callsign does not belong in a status
 * field anyway — the roster entry it is written to is already that unit's.
 *
 * Only the speaker's OWN name, only at the front, and only as whole words — so "King 22
 * still on that call" keeps its callsign, which is the right answer for a label that is
 * about somebody else. (That turn is excluded by `kind` as well; this is the second lock.)
 */
export function withoutOwnCallsign(about: string, callsign: string, unitId: string): string {
  for (const name of [callsign, unitId]) {
    const wanted = words(name ?? "");
    if (wanted.length === 0) continue;

    // Walked over the ORIGINAL string so the remainder keeps its real spelling and
    // punctuation — the value becomes the status a dispatcher reads on the panel.
    let at = 0;
    let matched = 0;
    while (matched < wanted.length) {
      while (at < about.length && !/[a-z0-9-]/i.test(about[at] as string)) at++;
      let end = at;
      while (end < about.length && /[a-z0-9-]/i.test(about[end] as string)) end++;
      if (end === at) break;
      if (about.slice(at, end).toLowerCase() !== wanted[matched]) break;
      matched++;
      at = end;
    }
    if (matched === wanted.length) {
      const rest = about
        .slice(at)
        .replace(/^[^a-z0-9-]+/i, "")
        .trim();
      // Never strip the whole thing away: `about` that is nothing but the callsign is a
      // label with no traffic in it, and the empty-`about` gate should see it as empty.
      if (rest) return rest;
    }
  }
  return about;
}

/**
 * The action the model should have chosen, or `null`.
 *
 * Pure, so the whole decision is testable without a model, a provider or a channel —
 * which is the other reason it lives here rather than inline in the turn loop.
 */
export function recordedSelfReport(
  decision: Pick<AiDecision, "actions" | "kind" | "about">,
  context: AiTurnContext,
  tools: readonly AiTool[],
): AiAction | null {
  // Only ever an addition. A turn the model acted on is a turn it understood, and
  // second-guessing its choice is a different and much riskier feature.
  if (decision.actions.length > 0) return null;

  // Grounding has nothing to match against on a 911 call or an announcement, and there
  // is no unit on the other end of either to have a status at all.
  if (context.trigger !== "transmission") return null;

  // The model's own classification. "request" is a unit asking for something and
  // "call-up" is a unit saying nothing — neither is a status, and the over-reach
  // controls both land in those two.
  if ((decision.kind ?? "").trim().toLowerCase() !== "report") return null;

  const about = withoutOwnCallsign((decision.about ?? "").trim(), context.callsign, context.unitId);
  if (!about) return null;

  const tool = tools.find((candidate) => candidate.id === "unit_status");
  if (!tool) return null;

  // The same gate the tool itself would apply, so this cannot put anything through that
  // a model's own call could not. A refusal here is silence, not a transmission: the
  // model already wrote an acknowledgement for this turn and airing a negative about an
  // action nobody asked for would be worse than not recording it.
  if (argumentRefusal(tool, about, context) !== null) return null;

  return { tool: tool.id, input: about };
}
