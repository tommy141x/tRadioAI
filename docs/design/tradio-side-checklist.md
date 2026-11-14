# What tRadio has to provide

The checklist for the change that removes the dispatcher from tRadio and adds the generic hooks tRadioAI consumes. `docs/content/tradio-contract.mdx` is the reference for every payload; `server/lib/stub-tradio.ts` is an executable statement of it, and `server/lib/tradio-hooks.test.ts` plus `server/lib/dispatcher.test.ts` are the behaviours tRadio's real implementation has to satisfy. Each item below is something tRadioAI **relies on and cannot check from outside**.

## Exports to add

| Export | Must |
| --- | --- |
| `registerTransmissionTap(optsJson) -> tapId` | return an unguessable id (128-bit random); `""` when the caller is not in `Config.integrations`; one tap per resource, re-registering replaces; unregister when the resource stops; **also deliver the frequency of any 911 call answered by a station the same resource opened, whatever `frequencies` says** |
| `unregisterTransmissionTap(tapId) -> bool` | `false` for an unknown id, no side effect (it is the capability probe) |
| `openStation(optsJson) -> stationId` | `{ name, frequencies, answers911 }`; server ids from -890000..-890999; unguessable id; `""` when refused; several per resource allowed; close on resource stop; `answers911` counts as dispatcher presence for the no-dispatcher 911 fallback |
| `closeStation(stationId) -> bool` | `false` for an unknown id, no side effect (probe) |
| `stationTransmit(stationId, optsJson) -> requestId` | `{ frequency, container: "pcm16", sampleRate, audio, maxMs }`; encode with the channel's codec (analog keeps IMBE); pad the encoder delay; pace in real time; broadcast talking state; one voice per channel with a bounded queue; the existing voice rate limit and the 20 s cap; `""` when refused outright |
| `getStations() -> json` | `{ stations: [...], humans: [{ serverId, selected, listening }] }`; `humans` never contains a station |
| `getAlerts() -> json`, `getToneKeys() -> json` | names and `toneOnly`; tone keys sorted |
| `getPatches() -> json`, `createPatch(label, frequenciesJson) -> json`, `removePatch(id) -> bool` | refusal reasons `direct`, `trunked`, `already_patched` (+ `frequency`, `label`), `too_few`, `not_permitted`; persist and broadcast like the panel's patches; `removePatch("probe")` is `false` with no side effect |
| `answer911(stationId, callId) -> json` | cover the call's frequency **then** accept (accepting first loses the call to the empty-channel sweep); `{ ok: false, reason }` with `caller_offline` when the caller has no socket yet, `no_station`, `unknown_call`, `not_permitted` |
| `end911(callId) -> bool` | end with the new reason `integration_ended`; fire `tradio:911:ended` as for any end; `false` for an unknown id, no side effect (probe) |
| `cadCapabilities(provider) -> json` | `{ provider, supports, consent }`, `provider` `""` when not offered; `consent` is `Config.cad.tools`; `supports` empty when it is `false` |
| `cadOperation(provider, op, paramsJson, requestId) -> bool` | run the existing TS provider method and answer with its **reduced** result; `false` when refused, including a write while `Config.cad.tools` is `false`; exactly one event per request id; `writeStatus` takes the CAD's own status name and matches it exactly (no ten-code mapping in tRadio) |

## Events to add

| Event | Payload |
| --- | --- |
| `tradio:tap:transmission(tapId, payload)` | `{ serverId, name, frequency, startedAt, endedAt, codec, container, sampleRate, audio }`; **`wav` is 16000 Hz mono 16-bit** (tRadioAI drops any other rate); `webm` is stitched Opus; never a station's own audio |
| `tradio:station:done(stationId, requestId, result)` | `{ ok, reason, airedMs }`, `reason` in `aired queue_full too_long no_station not_covered` |
| `tradio:911:queued(call)` | `{ id, callerServerId, callerName, message, frequency, coords }` for every queued call |
| `tradio:cad:operationResult(requestId, result)` | `{ kind, ok, status, body }` as tRadio's `CadResult` |

`tradio:911:ended(callerServerId, reason)` already exists and is used unchanged.

## Behaviour to add or verify

1. `Config.integrations` (default `{}`) and the `GetInvokingResource()` check on every hook marked above, with one `[audit]` line per refusal naming the exact line to add. Audit lines for `tap:register`, `station:open`, `station:tx`, `911:answer` in the existing style.
2. Every new export wrapped so a throw returns the failure value, never an error (an export that throws returns `undefined`, and the caller then sees `"undefined" is not valid JSON`).
3. The consent gate in Lua: `cadRequest`/`cadOperation` for every op outside the mirror trio (`createCall`/`closeCall`/`mirrorPanic` called by `lib/cad/mirror.ts`) checks `Config.cad.tools`. Today the only gate is in the code that is leaving.
4. `Call911EndReason` gains `integration_ended` (replacing `ai_ended`); the dispatch panel's store mirrors it.
5. Vocoder host, transmission reassembly, WAV/WebM stitching and the station console stay in tRadio under generic names (`vocoder-host`, `transmission-tap`, `station`); the AI-specific modules and Lua go. The addon carries no IMBE or codec2 code.
6. **Open, decide before coding:** whether a tap hears channels whose transmit mode is `secure`. The old in-process tap sat before the secure check and did not look. The contract currently makes naming the resource in `Config.integrations` the consent.
7. **Open, decide before coding:** whether a function-reference callback can replace the event across resources (unproven). The event form is what tRadioAI is written against.

## How to prove it

tRadio's own tests should exercise each export through the contract (`docs/content/tradio-contract.mdx`), and the pair of repositories together is proven by running tRadioAI's `bun run harness` or an in-game session on both generations. Things worth a test in tRadio because tRadioAI cannot see them:

- a tap registered with `frequencies = [A]` still hears the frequency of a call its station answered;
- `answer911` on a call whose caller has no socket returns `caller_offline` and leaves the call queued, and a retry later succeeds;
- an ended transmission with a station-originated talker delivers nothing;
- an un-allow-listed invoker is refused with the one-line message, for each hook;
- `stationTransmit` on an uncovered frequency reports `not_covered` through the event, and two requests on one channel air one after the other.
