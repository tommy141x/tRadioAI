# AI Dispatcher × 911 calls — investigation

**Status:** investigation only. No code was written, edited or committed.
**Date:** 2026-09-21. **Branch:** `feat/test-infrastructure-and-bug-sweep`.
**Scope:** can the existing AI Dispatcher subsystem be extended to *answer, handle and hang up*
911 calls, and if so how — or what blocks it.

Everything below is from reading the code in this working tree. Where something could not be
proven statically it is marked **UNPROVEN** rather than guessed. There is no Lua interpreter on
this machine, so all Lua claims are static reads.

---

## 0. Two corrections to the brief

Both verified, both matter downstream.

1. **The negative-frequency minting is not in `shared/ui`.** The brief pointed at
   `shared/ui/src/engine/state/state.ts` ~366-369. That file does not exist (`sed` returns
   *No such file or directory*). The real code is **`server/lib/state.ts:365-370`**:

   ```ts
   let _nextCall911FreqSeq = 0;
   export function allocateCall911Frequency(): number {
     _nextCall911FreqSeq++;
     return -900000 - _nextCall911FreqSeq;
   }
   ```

2. **The first call frequency is `-900001`, not `-900000`.** The sequence pre-increments.
   `client/app/src/stores/engine-instance.ts:1724-1727` states this explicitly in a comment
   ("guarantees every 911 pseudo-frequency is <= -900001"). The `isCall911Freq` style tests are
   nevertheless written as `<= -900000` / `< 0` in different places — see §4.5, this
   inconsistency is load-bearing for one of the seams.

   Related near-miss worth flagging before anyone writes code here:
   `server/lib/ai/console.ts` opens with `export const AI_SERVER_ID_BASE = -900000;` and a span
   of 1000. AI console **serverIds** therefore occupy -900000..-900999, which is *numerically the
   same range* as 911 **frequencies**. They are different axes and nothing currently confuses
   them, but any code that starts passing both a call frequency and an AI serverId around will
   read as if it were one namespace. Rename or re-base before building.

---

## 1. What exists today

### 1.1 It is real, wired and live — but untracked

`server/lib/ai/` is ~50 files and **none of them are in git** (`git ls-files server/lib/ai`
returns nothing), nor is `server/sv_ai_dispatch.lua`. Their callers *are* tracked:

- `server/main.ts:71` — `import { installAiDispatch } from "./lib/ai";`
- `server/main.ts:126` — `installAiDispatch(io);`
- `fxmanifest.lua:91` — `'server/sv_ai_dispatch.lua'` in `server_scripts`

So the tracked tree references files it does not contain: **a clean clone would not build.**
This is the first thing to fix regardless of the 911 question, and it means none of the analysis
below is visible to CI.

`AGENTS.md` is also stale on this subsystem: `server/sv_ai_dispatch.lua` is missing from the §4
`server_scripts` load-order list, and `server/lib/ai/` is missing from the §6 module table. Anyone
using AGENTS.md as the map will not find this feature at all.

Evidence it is *live*, not scaffolding: this dev server's `data.json` carries
`"aiDispatchEnabled":true,"aiDispatchChannels":"154.755"`.

### 1.2 The turn loop

`server/lib/ai/index.ts` (1053 lines) is the orchestrator. `installAiDispatch(io)` installs:

- the **voice tap** (via `setVoiceTap`), dropping `serverId < 0` so the AI never hears dispatch
  consoles, including itself;
- the **911 tap** (`setCall911Tap`);
- a **500 ms sweep** (`SWEEP_MS = 500`) that closes transmissions on silence;
- event handlers `radio:ai:config`, `radio:ai:call`, and `onResourceStop`.

Other constants that bound behaviour: `STALL_MS = 1200` (when the "stand by" hold airs),
`MAX_QUEUED = 2`, `MAX_QUEUE_AGE_MS = 30_000`, `POSITION_TTL_MS = 2000`, `WARM_UNITS = 6`, and
`busy = new Set<number>()` **keyed by frequency**. Frequency is already the unit of concurrency
everywhere in this subsystem — which is exactly why a synthetic 911 frequency slots in so
naturally.

The pipeline is: `packets → transmission → clip → transcript → decision → tool → reply → air`.

### 1.3 Capabilities and providers

`server/lib/ai/providers.ts`: three capabilities resolved **independently** —
`Capability = "text" | "speech" | "transcription"` — across
`ProviderId = "local" | "openai" | "openrouter" | "groq" | "vercel"`, defaulting to local.
`keyConvar(p)` is `` `tradio_${p}_key` ``; keys are read at point of use in
`server/lib/ai/config.ts:165-172` and reduced to a `hasKey: boolean` before leaving
`parseCapability`, so a key never lands in a loggable object. `openrouter` serves text only.

Local inference is llama-server + whisper-server over loopback HTTP, plus Piper as a one-shot
binary, spawned through tLib's `InferenceServe` broker (`server/lib/ai/local-engine.ts`).

**So: yes, there is a full voice path in both directions already. STT and TTS both exist.**
This is the single most important finding for the 911 question.

### 1.4 Voice out — `server/lib/ai/speak.ts` (438 lines)

This file is already generic over frequency, and its header explains why the whole approach works:

> the radio FX chain is applied on the LISTENER, not the talker … So the dispatcher does not get
> a playback path of its own. **It becomes a talker.**

`airReply(frequency, text, gender, signal, onAudioStart)`:

1. `sayable(text)` → `synthesise()` (with a small stock-phrase cache: `SPEECH_CACHE_MAX = 24`,
   `SPEECH_CACHE_MAX_CHARS = 48`);
2. `claimChannel(frequency, signal)` — a per-frequency FIFO, `MAX_QUEUED = 3`;
3. `openConsole(frequency)` — see below;
4. `user.isTalking = true` + `announceTalking` (`broadcastTalkingState`);
5. a **paced** loop of
   `handleVoice(socketId, { emit: () => {} }, { data, encoding: "imbe", frequency, signal: 5, seq: i })`
   with `await sleep(PACKET_MS)`;
6. `finally`: clear talking, `state.voiceRateLimit.delete(socketId)`, `closeConsole` if transient,
   release the channel.

`MAX_REPLY_MS = 20_000`.

**The decisive detail is step 5.** `handleVoice` is called with a *synthetic socket id* and a
*stub socket* — `{ emit: () => {} }`. There is no real socket, no real client, no Socket.IO
connection. The transport does **not** require a human client for a talker.

### 1.5 Synthetic presence — `server/lib/ai/console.ts` (225 lines)

`openConsole(frequency)` fabricates a `RadioUser`:

- serverId from `AI_SERVER_ID_BASE = -900000` + span 1000 (negative ⇒ `isDispatcher`);
- `socketId` = `__ai_dispatch_<n>`;
- registered into `state.users` **and** `state.dispatchUsers` as `{callsign, nacId: "DISPATCH"}`;
- `emitNet("radio:receivePlayerName", -1, serverId, callsign)` so clients can name it;
- joins `getOrCreateChannel(frequency).speakers`, emits `speakerJoined`, then
  `broadcastChannelState`;
- `transient = !monitorsFrequency(frequency)` — a console opened just to carry one transmission
  closes again afterwards.

`syncConsoles(covered)` reconciles sign-on against config.

**It works for any number, negative included.** Nothing in here inspects the sign of the
frequency.

### 1.6 Voice in — `server/lib/voice.ts` (759 lines) and `transmission.ts`

`voice.ts:415-417`:

```ts
if (voiceTap && effectiveFreq && typeof data?.data === "string") {
  voiceTap.packet(user.serverId, effectiveFreq, String(data.encoding ?? ""), data.data);
}
```

This fires for **every accepted packet on any frequency** — 911 call frequencies included. The
AI is already *receiving* 911 call audio at the tap; it simply discards it.

The discard happens in `server/lib/ai/transmission.ts` (136 lines):
`createTransmissionTap({ monitors, onTransmission, maxPackets = 200, silenceMs = 1500 })` filters
on `options.monitors(frequency)`, and `monitors` is
`server/lib/ai/config.ts:175-178`:

```ts
export function monitorsFrequency(frequency: number): boolean {
  if (!current.enabled) return false;
  return current.channels.includes(frequency);
}
```

A 911 frequency is never in `current.channels` (those come from the admin panel as real
frequencies). **Broadening this one predicate is the cleanest seam in the entire system.**

Transmission boundaries: the primary one is the unkey (`end`, from `voiceTapEnd` at
`server/lib/socket.ts:1615`, inside setTalking-false); the silence sweep is a backstop.

### 1.7 Clip and transcript — `server/lib/ai/clip.ts` (114 lines)

`STT_SAMPLE_RATE = 16000`. `imbe` → vocoder decode → `normalisePeak(resamplePcm(...))` → WAV.
`opus` → `joinWebmChunks`, passed through still encoded. **Both wire encodings are already
handled**, which matters because it is UNPROVEN which one a 911 caller emits (§4.5).

### 1.8 Conversation state — `conversation.ts`, `presence.ts`, `readiness.ts`

`conversation.ts` keys history **by frequency** (`MAX_HISTORY = 12`, `HISTORY_TTL_MS = 5 min`,
`expecting` with `EXPECT_MS = 25_000`, plus `waiting`). A 911 call frequency therefore gets its
own isolated conversation thread for free — no new data structure needed.

`presence.ts`: `humanDispatcherOn(frequency, users, isOwnParticipant)` returns true for any
negative serverId that is not ours with `speakerChannel === frequency` **or**
`listeningChannels.has(frequency)`. `readiness.ts`'s `hasAudience` drives local-engine warm-up.

### 1.9 Tools — `server/lib/ai/builtins.ts` (331 lines)

`patch_channels`, `unpatch_channels`, `call_another_channel`, `channel_alert`, `channel_tone`,
with `const AI_PATCH_AUTHOR = -900000;`. The design is **tool-decides-not-model**: a tool declares
an id, a description and a free-text input line; the model names a declared tool and passes a
sentence.

`call_another_channel` is the proof of concept for everything in §3: it already does
`await airReply(entry.frequency, rest, config.voiceGender, AbortSignal.timeout(20_000))` onto a
channel the AI does **not** monitor, then `recordSaid(entry.frequency, ...)`. Transient console,
one transmission, gone. That is structurally identical to answering a call.

Server-side custom hooks live in `config/sv_functions.lua`: `aiDispatchTools` (611),
`aiDispatchIncidents` (650), `aiDispatchUnitNote` (674), `aiDispatchLocation` (687),
`aiDispatchInstructions` (712). `server/lib/ai/lua.ts` calls them via
`callLuaSafely<T>(name, args, fallback)` through `globalThis.exports[GetCurrentResourceName()]`,
and never throws.

### 1.10 Where it hooks 911 today

`server/lib/ai/index.ts`:

```ts
setCall911Tap((call) =>
  announceCall({ id: call.id, source: "911", caller: call.callerName,
    message: call.message, location: locationOf(call.coords),
    priority: "", service: "" }, call.coords)
);
```

`announceCall` is gated on `config.enabled && config.auto911`, picks a **radio channel** via
`channelForCall(service, origin)` (scored by unit count, +100 if the channel name contains the
service word), and runs `respond()` with `trigger: "call"`.

**This is announce-on-a-radio-channel. The AI never joins the call, never hears the caller, never
speaks to the caller.** Today's `auto911` reads the text of the 911 request and broadcasts a
dispatch to units. The caller is on hold the entire time.

### 1.11 Admin plumbing (all tracked, all already there)

`server/web/src/admin/pages/PageSettings.tsx:681-733` exposes `aiDispatchEnabled`,
`aiDispatchChannels`, `aiDispatchYieldToDispatcher`, `aiDispatchAuto911`, `aiDispatchCallsign`,
`aiDispatchVoiceGender`. `server/sv_admin.lua:1521-1557` `syncSettingsToConfig` maps them onto
`Config.aiDispatch.*`; `ALLOWED_SETTING_KEYS` at :1877-1882 and the type map at :1925-1928.
Config defaults (`server/lib/ai/config.ts:63-79`): `enabled:false, channels:[],
yieldToDispatcher:true, auto911:true, callsign:"Dispatch", voiceGender:"female",
wakePhrases:["dispatch"], turnTimeoutMs:30000`. `applyAiConfig(raw)` is the single entry point
from `radio:ai:config`.

**Adding one boolean here is a well-trodden path** — six settings already ride it end to end.

---

## 2. The call lifecycle, end to end

Every event and file in the path. This is the path an AI has to enter.

### 2.1 Placed

1. Player dials in the NUI. `client/cl_platform.js` / the phone integration emits to Lua.
2. **`radio:server:request911`** — `server/sv_911.lua`, `RegisterNetEvent("radio:server:request911",
   function(message, coords, locationInfo)`. Gates on `Config.call911Enabled` and
   `call911CooldownMs()` (default 30000). **Every reject path fires
   `radio:client:911DialFailed`** back to the caller.
3. On accept it fires **`TriggerEvent("radio:911:request", {...})`** — the Lua→TS hop, same-process
   event bus.

### 2.2 Queued

4. `server/lib/calls911.ts` (383 lines) picks it up in **`requestCall911`**. This module owns *only*
   queue bookkeeping — its own header: "it never touches voice routing directly."
   It calls `allocateCall911Frequency()` (`server/lib/state.ts:365-370`) to mint the call's
   frequency, and fires the registered `setCall911Tap` callback (which is how the AI hears about
   it today, §1.10).
5. Socket emits to dispatch clients: **`call911:new`**, **`call911:queued`**, with
   **`call911:snapshot`** for late joiners and **`call911:denied`** for rejects.
6. Lua-side acknowledgements come back on **`radio:911:ack`**, **`radio:911:queueTimeout`**,
   **`radio:911:noDispatcherOnline`**. `playerDropped` →
   `TriggerEvent("radio:911:cancelQueued", source)`.

   Timings in `calls911.ts`: `QUEUE_TIMEOUT_MS = 5 min`, `ANSWER_TIMEOUT_MS = 20_000`,
   `SWEEP_INTERVAL_MS = 10_000`, `EMPTY_GRACE_MS = 8_000`, `EMPTY_SUSTAINED_MS = 15_000`,
   `REQUEST_COOLDOWN_MS = 5_000`, `MAX_MESSAGE_LENGTH = 200`. `startSweep`/`stopSweep` drive them.

### 2.3 Answered

7. Panel side: `server/web/src/stores/dispatch.ts` handles **`call911:new`** at **:4722** (and
   starts the ring — `CALL911_RING_START_MS = 4_000`, `CALL911_RING_GROWTH = 1.4`,
   `CALL911_RING_MAX_MS = 22_000`). `acceptCall911`/`endCall911`/`focusCall911`/`unfocusCall911`
   are at **:3312-3344**.
8. Dispatcher clicks accept → socket **`call911:accept`** →
   **`acceptCall911(dispatcherServerId, callId)`** in `calls911.ts`.

   **Critical property:** `acceptCall911` only reads `state.dispatchUsers.get(dispatcherServerId)`
   — and only to get a callsign. **It needs no socket.** An AI console serverId satisfies it
   directly, because `openConsole` already registers into `state.dispatchUsers` (§1.5).
9. Server emits **`call911:accepted`** / **`call911:connected`**; caller side gets the Lua
   notification.
10. `dispatch.ts:4748` handles `call911:accepted` and, **only for the accepting dispatcher**, calls
    `addScanChannel(normalizeFreq(data.frequency), true)`. `addScanChannel` (**:2490**) emits
    `socket.emit("addListeningChannel", frequency)`.

    **Listening is client-driven.** The server's `acceptCall911` never makes anyone a listener.
    An AI answerer must arrange its own listening — which for the AI is not "listening" at all,
    it is the voice tap, which is already receiving (§1.6). This is a simplification, not a
    problem.

### 2.4 Audio flows

11. Caller's PTT is **VAD, not a key.** `client/cl_polling.lua`:
    `CALL911_TALK_NATIVES = { "MumbleIsPlayerTalking", "NetworkIsPlayerTalking" }`, NUI callback
    `call911WatchTalking`, sending `{ action = "call911:talkingChanged", talking = talking }`.
    The file **prints a warning when no talk-state native exists on the build**.
12. Packets go through the normal path: `handleVoice` in `server/lib/voice.ts`. Dispatcher
    frequency override at :363-369 (`isDispatcher(user.serverId) && data?.frequency` →
    `normalizeFrequency`). Recorded-talking gate at :400-409
    (`recordedTalkFreq = user.crossChannelFreq ?? user.speakerChannel`). Tap fires at :415-417.
13. **911 is full duplex, deliberately.** `server/lib/socket.ts:1668` and :1698:

    ```ts
    const isCall911Freq = effectiveFreq < 0;
    ...
    if (isCall911Freq) { // Skip enforcement entirely — simultaneous talkers are expected and allowed on a call. }
    ```

    Note this test is `< 0`, not `<= -900000` — see §4.5.
14. Client side: `client/app/src/stores/engine-instance.ts` has the `call911:*` bridge cases at
    **:1250-1311**, and `voice:setCallChannel` at **:2188** with a mic pre-warm keyed on
    `output.frequency <= -900000`.
15. Audio character: `applyChannelFx` at **:1714** installs `CALL911_FX_CONFIG` (**:1696-1706**:
    `fxEnabled:true, distortionMode:"classic", highpass 150, lowpass 7000, distortion 4,
    compression 30, midBoost 0, inputGain 0.5, **p25Enabled: false**`) with
    **`{ overridable: false }`** at :1731. `shared/ui/src/audio/manager.ts:526` holds the flag
    (`private fxOverridable = true; /** False while a non-radio profile (the 911 phone band) is
    installed. */`) and :2834-2838 explains it: a player's own radio EQ must not reach a phone
    call.

    **So the 911 call is explicitly *not* a radio. It is a phone band, with P25 off.**

### 2.5 Hung up

16. Dispatcher: panel `endCall911` → socket **`call911:end`**. Caller: ESC in
    `client/cl_bridge.lua` → **`call911:hangup`**, registered at `server/lib/socket.ts:637` via
    `registerCall911SocketHandlers(socket, serverId)` at :631.
17. Both land in `calls911.ts` — **`endCall911(callId, reason)`** / **`callerEndCall911`** /
    **`cancelCall911ByCaller`**.
18. Server emits **`call911:ended`** (panel handler at `dispatch.ts:4773`) and Lua-side
    **`radio:911:ended`**. Voice bookkeeping unwinds through `voiceTapEnd`
    (`socket.ts:1615`) and `voiceTapForget` (`socket.ts:1954`).
19. Backstops if nobody hangs up: the `startSweep` watchdogs — `EMPTY_GRACE_MS`,
    `EMPTY_SUSTAINED_MS`, `QUEUE_TIMEOUT_MS`, `ANSWER_TIMEOUT_MS`.

**Summary chain:**
`client/cl_platform.js` → `radio:server:request911` → `server/sv_911.lua` → `radio:911:request` →
`calls911.ts requestCall911` → `call911:new` / `call911:queued` → `call911:accept` →
`acceptCall911` → `call911:connected` + client-driven `addListeningChannel` → voice via
`handleVoice` → `call911:end` / `call911:hangup` → `endCall911` → `call911:ended` +
`radio:911:ended`.

---

## 3. Seams, ranked

For each: what it must fake or own, and what exists vs. must be built.

### Seam 1 — Broaden the tap's `monitors` predicate (voice IN) ★ best

**Where:** `server/lib/ai/config.ts:175-178` `monitorsFrequency`, consumed as `monitors` by
`createTransmissionTap` in `server/lib/ai/transmission.ts`.

**What it buys:** the AI starts *hearing* 911 callers. Nothing else changes.

**Exists:** the packets already arrive at the tap (`voice.ts:415-417` fires on any frequency);
`clip.ts` already decodes both `imbe` and `opus`; `conversation.ts` already keys by frequency so
each call gets its own thread; utterance boundaries already arrive, because the caller's VAD
(`cl_polling.lua`) drives `setTalking(false)` → `voiceTapEnd` (`socket.ts:1615`).

**Must be built:** a registry of "call frequencies this AI has accepted", so the predicate is
`current.channels.includes(f) || acceptedCalls.has(f)` rather than a blanket `f <= -900001`. A
blanket test would make the AI eavesdrop on every human-handled call, which is both wrong and
expensive. Must also be cleared on `call911:ended`.

**Must fake/own:** nothing. It owns a set of numbers.

**Risk:** low. It is one predicate and its lifetime.

### Seam 2 — Call `acceptCall911` with an AI console serverId (call STATE) ★

**Where:** `server/lib/calls911.ts` `acceptCall911(dispatcherServerId, callId)` — already
exported. `server/lib/ai/console.ts` `openConsole(frequency)`.

**What it buys:** the AI can genuinely answer a call — the caller stops ringing, the panel sees
the call as taken, and the existing state machine handles everything downstream.

**Exists:** `acceptCall911` needs no socket (§2.3 step 8); `openConsole` already registers into
`state.dispatchUsers` with `nacId: "DISPATCH"`, which is exactly what `acceptCall911` looks up.

**Must be built:** an ordering — `openConsole(callFrequency)` **before**
`acceptCall911(consoleServerId, callId)`, or the callsign lookup misses. Plus a **delay** so the
AI does not race human dispatchers (§4.2).

**Must fake/own:** a dispatch console identity. Already faked today, on radio channels.

**Risk:** medium, entirely because of the accept race.

### Seam 3 — A new trigger kind for in-call turns (the TURN LOOP)

**Where:** `server/lib/ai/index.ts` `respond({ trigger })` — today `"transmission"` and `"call"`.

**What it buys:** the model can be prompted as a *call-taker* (ask location, ask what's happening,
ask if anyone's hurt) rather than as a *radio dispatcher* (terse, ten-codes, callsigns). These are
different jobs with different phrasing, and reusing `"call"` would produce radio voice on a phone
line.

**Exists:** the whole `respond` machinery, the tool loop, `conversation.ts` history, the hold
("stand by") at `STALL_MS = 1200`.

**Must be built:** a third trigger, a prompt for it, and a call-taker phrasing pass. The hold line
in particular is wrong on a phone ("stand by" is radio; a 911 call-taker says "stay on the line").

**Must fake/own:** the conversational stance. Pure prompt work, no plumbing.

**Risk:** low technically, high on quality/immersion.

### Seam 4 — `airReply` onto the call frequency (voice OUT)

**Where:** `server/lib/ai/speak.ts:349` `airReply(frequency, ...)`.

**What it buys:** the AI's voice reaches the caller.

**Exists:** *all of it.* `airReply` takes an arbitrary frequency; `openConsole` accepts negatives;
`handleVoice` is driven with a synthetic socketId and a `{ emit: () => {} }` stub;
`normalizeFrequency` accepts negatives. `call_another_channel` in `builtins.ts` already exercises
exactly this shape against a non-monitored frequency with a transient console.

**Must be built:** nothing structural.

**Must fake/own:** nothing new.

**Risk:** low mechanically — but see §4.3, the AI's voice will be **IMBE-vocoded on a line that
is deliberately not a radio**.

### Seam 5 — `endCall911` for hangup

**Where:** `server/lib/calls911.ts` `endCall911(callId, reason)`, already exported.

**What it buys:** the AI can hang up, and it unwinds through the same path a human hangup does.

**Exists:** the function, the `call911:ended` fan-out, and — importantly — the `EMPTY_GRACE_MS` /
`EMPTY_SUSTAINED_MS` / `QUEUE_TIMEOUT_MS` watchdogs as backstops if the AI never decides.

**Must be built:** *the decision*. See §4.1 — this is the hard part.

**Must fake/own:** judgement about when a conversation is finished.

**Risk:** high, and it is judgement risk, not code risk.

### Seam 6 (rejected) — a real Socket.IO client for the AI

Worth naming only to dismiss it. The AI could connect as a genuine socket client and behave
exactly like the dispatch panel. It would get `addListeningChannel` and the whole client path for
free. But it means running `server/web`'s client logic headless, it doubles the transport load,
and §1.4 already proves **the transport does not require a human client**. Do not do this.

---

## 4. The hard parts

Blunt, as requested.

### 4.1 "When is the call over?" — the hardest blocker

There is **no existing signal** for this and no code to lean on. On a radio channel the AI never
has to decide; a transmission ends at the unkey and that is that. A phone call has a distinct end
that somebody must declare.

The options and why each is uncomfortable:

- **Model judgement** — the model emits a `hang_up` tool. Structurally trivial (§1.9's tool model
  handles it), behaviourally risky: a model that hangs up on a panicking caller mid-sentence is a
  far worse failure than one that stays on too long. There is no test harness for this in the repo.
- **Silence timeout** — the existing `EMPTY_SUSTAINED_MS = 15_000` in `calls911.ts` is the
  nearest thing. But silence on a 911 call is *information* (the caller is hiding, injured,
  the line dropped), not an end-of-conversation marker.
- **Never hang up; hand off** — the AI takes details and transfers to a human or to the radio
  channel. This is the safe answer and it is what §5 recommends.

**This is the single hardest blocker, and it is a product decision before it is an engineering
one.**

### 4.2 The accept race against human dispatchers

`acceptCall911` is first-come-first-served, and `call911:new` fans out to every dispatch panel at
the same instant the AI's tap sees the call. With no delay the AI wins every time, because it has
no human reaction time — which would make the AI silently take over the whole 911 system the day
`auto911` gets extended.

Mitigation: an explicit grace window before the AI may accept (the panel's own ring cadence
starts at `CALL911_RING_START_MS = 4_000`, which is a natural reference point), plus
`humanDispatcherOn` from `presence.ts` and the already-present `yieldToDispatcher` config flag.
But note `yieldToDispatcher`'s current semantics are about a human *on a radio channel*; applying
it to a call frequency is a reinterpretation, not a reuse, and a human who later scans the call
frequency will trip `humanDispatcherOn` mid-call with no defined behaviour.

### 4.3 IMBE on a line that is explicitly not a radio

`speak.ts`'s header is candid: "Its voice is IMBE on every channel, analog included. That is a
real trade." On a radio channel the trade is fine — everyone is vocoded.

On a 911 call it is **actively wrong**: `CALL911_FX_CONFIG` sets `p25Enabled: false` and is
installed `{ overridable: false }` precisely so a call sounds like a phone and not like a radio
(`engine-instance.ts:1728-1732`, `manager.ts:2834-2838`). Injecting IMBE means the AI call-taker
arrives P25-vocoded on a deliberately non-P25 band.

This is a **quality trade-off, not a blocker** — it will sound wrong, not broken. Fixing it
properly means giving `airReply` a second wire encoding (opus/WebM), which `clip.ts` shows the
system already understands on the receive side, but which would be new code on the send side and
would break `speak.ts`'s "no client changes at all" guarantee.

### 4.4 Latency and barge-in

- `STALL_MS = 1200` before the hold airs, and `turnTimeoutMs` defaults to 30 s. A radio unit
  tolerates that. A 911 caller does not — on a phone, 1.2 s of dead air already reads as "nobody
  picked up."
- The measured local-engine numbers in `speak.ts`'s comments (0.8-1.3 s of a 2.4-2.9 s
  time-to-first-word spent on synthesis alone, before the cache) suggest a cold turn is seconds,
  not sub-second.
- **Full duplex means the caller can talk over the AI mid-sentence** (`socket.ts:1668-1698`
  skips enforcement entirely). Nothing in `speak.ts` can be interrupted once `claimChannel` is
  held — `airReply` only checks `signal.aborted` between packets, so there *is* an abort seam,
  but nothing currently drives it from inbound audio. Barge-in would have to be built.
- `channelQueue`'s `MAX_QUEUED = 3` bound was designed for a radio channel and would silently
  drop a reply on a call, which on a phone line is a dropped answer, not a lost transmission.

### 4.5 The `< 0` vs `<= -900000` inconsistency

`socket.ts:1668` tests `effectiveFreq < 0` for "is this a 911 call". `engine-instance.ts:1728`
tests `frequency <= -900000`. `state.ts:365-370` actually produces `<= -900001`. These agree
today only because nothing else mints a negative frequency. AI console *serverIds* already live
at -900000..-900999 (§0). Anyone adding a second kind of synthetic frequency here will find the
`< 0` test claims it as a 911 call. **Pin this down before building, not after.**

### 4.6 Does the transport assume a human client?

**No — proven.** §1.4: `handleVoice` is driven with `socketId = "__ai_dispatch_<n>"` and a stub
`{ emit: () => {} }`, and `openConsole` fabricates the `RadioUser` and channel membership
outright. This was the question the brief flagged as "the likely hard part," and it is the one
thing that is unambiguously already solved.

### 4.7 The untracked-files problem

Repeating it here because it gates everything: none of `server/lib/ai/` or
`server/sv_ai_dispatch.lua` is in git, while `main.ts:71,126` and `fxmanifest.lua:91` reference
them. Any Phase 1 built on this subsystem inherits that. **This must be resolved first**, and
AGENTS.md §4/§6 updated with it. It is also a shipping risk for an escrowed resource — an
escrow build from the tracked tree would be missing the feature entirely.

### 4.8 UNPROVEN — could not be determined from the code

1. **Which wire encoding a 911 caller actually emits on a synthetic frequency.** There is no
   channel config for a negative frequency, so the analog/P25 mode lookup
   (`findChannelByFrequency`) cannot resolve one, and `CALL911_FX_CONFIG` sets `p25Enabled:
   false` on the *listener* side only. Whether the caller's mic path therefore sends `opus` or
   `imbe` needs a runtime check. `clip.ts` handles both, so this is a question of which branch
   runs, not whether it works.
2. **Whether `MumbleIsPlayerTalking` resolves on the target build.** `cl_polling.lua` tries it,
   falls back to `NetworkIsPlayerTalking`, and prints a runtime warning if neither exists. If
   neither resolves, the AI gets *no utterance boundaries at all* on a call and would be reduced
   to the 1500 ms silence backstop in `transmission.ts`. Cannot be proven without running the
   game (and there is no Lua interpreter here).
3. **Real end-to-end turn latency on a call.** The numbers in `speak.ts`'s comments are for radio
   turns on a loaded box; nothing measures the call path because the call path does not exist yet.
4. **Whether `dispatch.ts`'s panel UI renders an AI-held call sensibly.** The file cannot be
   imported in a bun test (it pulls Vite-only `~icons` virtual modules), so this could not be
   exercised — only read.

---

## 5. Recommended smallest first slice

**Phase 1: "AI 911 call-taker — intake only, no hangup."**

The AI answers *only* calls that no human has accepted within a grace window, listens to the
caller, speaks back, gathers the incident details, puts the resulting call out on the radio
channel it already picks today — and then **hands off rather than hanging up.**

Concretely, and in this order:

1. **Track the feature into git** and fix AGENTS.md §4/§6 (§4.7). Nothing else is shippable
   until this is done.
2. **One new admin setting**, `aiDispatchAnswer911` (default **off**), riding the six-setting
   path already proven at `PageSettings.tsx:681-733` → `sv_admin.lua:1521-1557` →
   `applyAiConfig`. Off by default means this cannot surprise an existing server.
3. **An accepted-call registry** in the AI subsystem, and `monitorsFrequency` widened to
   `channels.includes(f) || acceptedCalls.has(f)` (Seam 1). Cleared on `call911:ended`.
4. **Grace-window accept** (Seam 2): on the `setCall911Tap` callback, wait N seconds (start at
   the panel's own 4 s ring), re-check the call is still unaccepted, then
   `openConsole(callFrequency)` followed by `acceptCall911(consoleServerId, callId)`.
5. **A `"call-intake"` trigger** (Seam 3) with call-taker phrasing, replacing the radio hold line.
6. **Reply via the untouched `airReply`** (Seam 4). Accept the IMBE artefact for Phase 1 and
   document it as known.
7. **Hand off, don't hang up** (deliberately *not* Seam 5): when the model decides it has the
   details, it uses the existing `announceCall` path to put the job out on a radio channel and
   leaves the line open. The existing `EMPTY_SUSTAINED_MS` / `QUEUE_TIMEOUT_MS` watchdogs in
   `calls911.ts` close the call. A human dispatcher who joins the call frequency takes over.

**Why this slice:** it is genuinely useful on its own — a server with no dispatcher online right
now gets 911 calls answered instead of ringing out for 5 minutes — and it is independently
shippable, because every piece it needs except the grace window and the prompt already exists and
is already exercised by `call_another_channel`. Crucially it **sidesteps §4.1 entirely** by
declining to make the hang-up decision, which is the one part of this that is a product judgement
rather than an engineering task.

**Phase 2** is then the honest list of what Phase 1 deferred: model-driven hangup, barge-in via
`airReply`'s existing `signal.aborted` seam, an opus send path so the AI sounds like a phone, and
defined behaviour when a human joins a call the AI is holding.

---

## Appendix — file index

| File | Why it matters |
| --- | --- |
| `server/lib/state.ts:365-370` | mints the call frequency; first is `-900001` |
| `server/lib/calls911.ts` | the queue state machine; `acceptCall911`/`endCall911` need no socket |
| `server/sv_911.lua` | `radio:server:request911` → `radio:911:request` |
| `server/lib/socket.ts:631,637,1615,1668,1698,1954` | 911 socket handlers, full-duplex exemption, tap end |
| `server/lib/voice.ts:363-369,400-417` | dispatcher freq override, talking gate, **the tap fires on every frequency** |
| `server/lib/ai/index.ts` | turn loop, taps, `announceCall`, `respond` |
| `server/lib/ai/config.ts:63-79,175-178` | defaults; **`monitorsFrequency` is Seam 1** |
| `server/lib/ai/speak.ts:349-430` | `airReply`; synthetic socket proves no human client is needed |
| `server/lib/ai/console.ts` | synthetic dispatch presence; `AI_SERVER_ID_BASE = -900000` |
| `server/lib/ai/transmission.ts` | `monitors` filter, unkey + silence boundaries |
| `server/lib/ai/clip.ts` | imbe **and** opus already decoded for STT |
| `server/lib/ai/conversation.ts` | history keyed by frequency — free per-call threads |
| `server/lib/ai/builtins.ts` | `call_another_channel` = the working precedent |
| `server/lib/ai/providers.ts` | text / speech / transcription, 5 providers |
| `server/web/src/stores/dispatch.ts:2490,3312-3344,4722-4822` | panel side of every `call911:*` event |
| `client/cl_polling.lua` | caller PTT is Mumble VAD |
| `client/app/src/stores/engine-instance.ts:1250-1311,1696-1733,2188` | bridge, `CALL911_FX_CONFIG`, mic pre-warm |
| `shared/ui/src/audio/manager.ts:526,2825-2845` | `fxOverridable` — the phone band is not the radio |
| `server/main.ts:71,126`, `fxmanifest.lua:91` | tracked callers of untracked files |
| `config/sv_functions.lua:611,650,674,687,712` | server-side AI hooks |
