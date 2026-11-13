/**
 * Reading the dispatcher's reply out of a decision that is still arriving.
 *
 * The decision is a JSON object and the whole of it takes about four seconds on
 * the local model, of which the reply is the first eight tokens or so and the
 * rest is the tool call. Waiting for the closing brace before synthesising means
 * spending that tail in silence, and the tail is the larger half.
 *
 * `JSON.parse` cannot help: an unterminated document throws, so parsing a
 * growing prefix reports nothing at all until the last character lands, which is
 * precisely the wait being removed. So this walks the text instead.
 *
 * It is deliberately strict about *completeness*. A reply is only handed back
 * once its closing quote has arrived, never as a growing fragment, because the
 * consumer starts speaking with it — and a synthesiser given "King 41, copy, out
 * at" says exactly that and stops. Half a sentence on a radio channel is worse
 * than a slow one.
 *
 * Pure: no clock, no sockets. The transport hands it text.
 */

/** Longest reply this will return, matching the cap `parseDecision` applies. */
const MAX_REPLY_CHARS = 240;

/**
 * The completed `reply` string in a partial JSON document, or `""`.
 *
 * Returns `""` while the reply is still being written, when the document has no
 * `reply` key yet, and when the value is not a string — every one of which means
 * "nothing to say yet" rather than an error, because the complete document is
 * parsed properly later regardless.
 */
export function draftReply(partial: string): string {
  // Scans for every occurrence rather than the first: a model that opened with a
  // code fence or a stray word can put something that looks like the key earlier
  // in the text, and taking the first match would lock onto it.
  let from = 0;
  while (true) {
    const key = partial.indexOf('"reply"', from);
    if (key < 0) return "";
    from = key + 7;

    const colon = partial.indexOf(":", from);
    if (colon < 0) return "";
    // Only whitespace may sit between the key and its colon; anything else means
    // this was not the key it looked like.
    if (partial.slice(from, colon).trim() !== "") continue;

    const open = partial.indexOf('"', colon + 1);
    if (open < 0) return "";
    // Likewise between the colon and the opening quote. A non-string value —
    // `"reply": null` — is not a draft and never becomes one.
    if (partial.slice(colon + 1, open).trim() !== "") continue;

    const value = closedString(partial, open);
    if (value === null) return "";
    return value.trim().slice(0, MAX_REPLY_CHARS);
  }
}

/**
 * The contents of the JSON string opening at `open`, or `null` if it has not
 * closed yet.
 *
 * Handles the escapes that actually appear in a spoken line — an escaped quote
 * is the one that matters, because a reply containing `"` would otherwise be cut
 * short mid-sentence and spoken that way.
 */
function closedString(text: string, open: number): string | null {
  let out = "";
  for (let i = open + 1; i < text.length; i++) {
    const char = text[i] as string;
    if (char === "\\") {
      const escaped = text[i + 1];
      // The escape's payload has not arrived. Not closed, and not guessable.
      if (escaped === undefined) return null;
      out += decodeEscape(escaped, text.slice(i + 2, i + 6));
      i += escaped === "u" ? 5 : 1;
      continue;
    }
    if (char === '"') return out;
    out += char;
  }
  return null;
}

function decodeEscape(marker: string, hex: string): string {
  switch (marker) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "u":
      // An incomplete escape at the end of the buffer resolves next chunk; until
      // then it contributes nothing, which keeps the result a prefix of the
      // truth rather than a wrong character.
      return hex.length === 4 ? String.fromCharCode(Number.parseInt(hex, 16)) : "";
    default:
      // Covers `\"` and `\\`, which are the two that would otherwise end the
      // scan in the wrong place.
      return marker;
  }
}
