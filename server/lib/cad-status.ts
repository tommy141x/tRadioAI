/**
 * Turning what a unit SAID into what a CAD will ACCEPT.
 *
 * Provider-agnostic, and it has to be: two of the five CADs can write a status and
 * their vocabularies have nothing in common. SonoranCAD takes an operator-configured
 * set that ships as `UNAVAILABLE/BUSY/AVAILABLE/ENROUTE/ON_SCENE`; LACORE takes
 * labels including `CODE SIX` and `OUT TO STATION`. A unit says "10-8", "clear",
 * "show me code six" or "out with two" and means one of a handful of things.
 *
 * So speech collapses to a CONCEPT, and the concept expands to whatever this CAD
 * actually offers. Keeping those two steps apart is what lets a renamed status, or an
 * entirely different CAD, need no change here.
 *
 * Lived in the Sonoran provider until LACORE needed it, which is the moment it stopped
 * being provider-specific.
 */

/**
 * What a radio status means, reduced to the handful of things a CAD models.
 *
 * An intermediate vocabulary on purpose. A unit says "10-8", "clear", "back in
 * service" or "show me available" and means one thing; Sonoran's operator may have
 * named that state anything. Collapsing speech to a concept and then expanding the
 * concept to whatever the operator configured keeps those two problems apart, and
 * means a renamed status needs no change here.
 */
type StatusConcept = "available" | "busy" | "unavailable" | "enroute" | "onscene";

/**
 * Radio phrasings, from `assets/reference/real-radio-traffix.txt`.
 *
 * Deliberately small and deliberately not clever. Every entry is a phrase a unit
 * actually says in the corpus, and anything not listed resolves to nothing rather
 * than to a guess — see `mapSpokenStatus` for why that asymmetry is the whole
 * design. Ten-codes are NOT here: a code sheet is local to an agency and the
 * operator's own `tenCodes` table is consulted first for exactly that reason.
 */
const PHRASE_CONCEPT: readonly (readonly [string, StatusConcept])[] = [
  ["en route", "enroute"],
  // The corpus spells it both ways, 19 and 18 occurrences, and whisper picks
  // whichever it feels like.
  ["in route", "enroute"],
  ["enroute", "enroute"],
  ["responding", "enroute"],
  ["on scene", "onscene"],
  ["onscene", "onscene"],
  ["arrived", "onscene"],
  ["out with", "onscene"],
  ["out at", "onscene"],
  ["available", "available"],
  ["in service", "available"],
  ["back in service", "available"],
  ["clear", "available"],
  ["busy", "busy"],
  ["out of service", "unavailable"],
  ["unavailable", "unavailable"],
];

/**
 * How a concept might be spelled in a CAD's own status names.
 *
 * Covers SonoranCAD's shipped set and LACORE's labels, which overlap barely at all:
 * LACORE adds `CODE SIX` (its LEO name for the on-scene slot — Fire/EMS sees `ON
 * SCENE` for the same thing) and `OUT TO STATION`.
 */
const CONCEPT_ALIASES: Record<StatusConcept, readonly string[]> = {
  available: ["available", "avail", "in service", "clear", "10 8"],
  busy: ["busy", "unavail for calls", "10 6"],
  unavailable: ["unavailable", "unavail", "out of service", "offline", "out to station"],
  enroute: ["enroute", "en route", "responding", "10 97"],
  onscene: ["on scene", "onscene", "arrived", "10 23", "on site", "code six", "code 6"],
};

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * What the unit said, as a concept — or null.
 *
 * **Null is a first-class answer and the most important behaviour in this file.** A
 * status the dispatcher cannot confidently map must not be written: a CAD showing a
 * unit ON_SCENE who is not there is worse than a CAD showing nothing, because a
 * human dispatcher will send the next call somewhere on the strength of it. So
 * every path here either matches something real or gives up.
 *
 * Order matters. The operator's own code sheet is consulted before the built-in
 * phrase table, because a server that declared 10-50 means a pursuit has told us
 * something we would otherwise guess wrong.
 */
export function mapSpokenStatus(
  spoken: string,
  vocabulary: readonly string[],
  tenCodes: Record<string, string> = {},
): string | null {
  const said = normalize(spoken);
  if (!said || vocabulary.length === 0) return null;

  /**
   * "The freeway is busy" is not this unit's status.
   *
   * Substring matching alone marked a road condition as BUSY — it is *the freeway*
   * that is busy, not the unit — and a CAD showing a unit unavailable who just told
   * you they were fine is precisely the wrong write this function exists to prevent.
   *
   * The discriminator is grammatical and cheap: **a copula immediately before the
   * status phrase means something other than the speaker is being described.** "The
   * bridge is busy" and "he is en route" are reports about the world; "busy", "I'm
   * en route", "show me on scene" and "out with two" are self-reports. A first-person
   * opening overrides it, so "I am en route" survives.
   *
   * A word cap was tried here first and REMOVED as measured wrong in both
   * directions: it let "the freeway is busy northbound past the junction" through at
   * seven words, and rejected "I'll be out with two at the Pink Cage" because an
   * apostrophe splits into two tokens. Length was never the signal; grammar is.
   */
  const FIRST_PERSON = new Set(["i", "im", "ive", "ill", "we", "were", "weve", "me", "my"]);
  const words = said.split(" ");
  const opensFirstPerson = FIRST_PERSON.has(words[0] ?? "") || FIRST_PERSON.has(words[1] ?? "");

  /** Is this phrase being used to describe something other than the speaker? */
  const aboutSomethingElse = (phrase: string): boolean => {
    if (opensFirstPerson) return false;
    const at = words.indexOf(phrase.split(" ")[0] as string);
    if (at <= 0) return false;
    const before = words[at - 1];
    return before === "is" || before === "are" || before === "was" || before === "were";
  };

  /** Expand a concept to whichever configured name fits it. */
  const nameFor = (concept: StatusConcept): string | null => {
    const aliases = CONCEPT_ALIASES[concept];
    for (const name of vocabulary) {
      const plain = normalize(name);
      if (aliases.some((alias) => plain === alias)) return name;
    }
    // Looser second pass, so an operator's "ENROUTE_TO_SCENE" still resolves. Done
    // only after every exact match has failed, so a longer name cannot shadow a
    // precise one.
    for (const name of vocabulary) {
      const plain = normalize(name);
      if (aliases.some((alias) => plain.includes(alias) || alias.includes(plain))) return name;
    }
    return null;
  };

  /**
   * 1. The unit said the CAD's own status name. Matched by INCLUSION, not equality.
   *
   * Equality alone missed "show me code six", and that case matters more than it
   * looks: LACORE offers `CODE SIX` and `ON SCENE` as the same semantic slot under two
   * names, role-gated — LEO sees one, Fire/EMS the other. Going through the concept
   * aliases would resolve both to whichever appeared first in the vocabulary, so a
   * unit who said "on scene" could be written as CODE SIX. Honouring the words they
   * used settles it exactly.
   *
   * The copula guard applies here too, so "the freeway is busy" does not match a CAD
   * that happens to have a status called BUSY.
   */
  for (const name of vocabulary) {
    const plain = normalize(name);
    if (!plain) continue;
    if (said === plain) return name;
    if (said.includes(plain) && !aboutSomethingElse(plain)) return name;
  }

  // 2. The operator's ten-code sheet. Their codes, their meanings, their authority.
  for (const [code, meaning] of Object.entries(tenCodes)) {
    const plainCode = normalize(code);
    if (!plainCode || !said.includes(plainCode)) continue;
    const plainMeaning = normalize(meaning);
    for (const [phrase, concept] of PHRASE_CONCEPT) {
      // No `aboutSomethingElse` check here: the phrase was matched against the
      // OPERATOR'S meaning text, not against what the unit said, so there is no
      // sentence around it to misread.
      if (plainMeaning.includes(phrase)) {
        const name = nameFor(concept);
        if (name) return name;
      }
    }
  }

  // 3. Plain radio phrasing. Longest phrase first, so "back in service" is not
  //    decided by "in service" and "out of service" is not decided by "service".
  const phrases = [...PHRASE_CONCEPT].sort((a, b) => b[0].length - a[0].length);
  for (const [phrase, concept] of phrases) {
    if (said.includes(phrase) && !aboutSomethingElse(phrase)) {
      const name = nameFor(concept);
      if (name) return name;
    }
  }

  return null;
}
