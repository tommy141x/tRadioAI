# Reactive model fetch — design

**Date:** 2026-09-22
**Status:** approved design, not yet implemented
**Spans:** tLib (new code), tRadio (consumer), tAI (consumer + constraint change)
**Related:** `../../../../tAI/SHARED-INFERENCE-PROPOSAL.md` — that document is about sharing a
*running engine*. This one is about acquiring the *weights* it runs. They meet at the
workload identity string and nowhere else.

---

## 1. Why

tRadio's release is about to stop being buildable, and every customer pays for models they
may never load.

Measured on disk, 2026-09-22 (`du -sm`):

| tree | size |
| --- | --- |
| `server/models/` — on disk, incl. the superseded qwen3-1.7b the staging policy already prunes | 3,783 MB |
| `server/models/` — the subset `local-engine.lock.json` actually pins | 2,559 MB |
| `server/bin/` | 219 MB |
| everything else tRadio ships | ~50 MB |

adm-zip assembles the archive as a single Node `Buffer`, whose hard ceiling is
`2,147,483,647` bytes. The pinned weights alone are 2,559 MB, so a staged tree carrying
them exceeds that ceiling before anything else is added. **This has not yet been observed
as a thrown error** — the existing releases predate the qwen3-4b pin — but the arithmetic
leaves no room, and the failure mode when it arrives is a `RangeError` deep inside the zip
writer rather than anything naming the real cause.

Independently of the cap: bundling every weight means a server that sends `text` to Groq
still ships and stores a 2.38 GB GGUF it never opens.

## 2. Decision

Fetch weights on first start, **only for the capabilities that actually resolve to the
local engine**, using a generic fetcher that lives in tLib and is compiled into each
product's server bundle.

Three separate decisions, deliberately:

- **What to fetch** — reactive, per capability, per product (§3).
- **Who blocks on it** — per product; tAI blocks, tRadio does not (§5).
- **Where the code lives** — tLib, as build-time source (§4).

## 3. Reactive selection

`server/lib/ai/providers.ts` already models exactly the granularity needed.
`resolveProviders(raw)` returns a `ProviderPlan` — `Record<Capability, ResolvedCapability>`
over `text | speech | transcription`, each with a `hosted` boolean.

**Key on the RESOLVED plan, never on the raw config.** `providers.ts:15-18`: resolution
never throws, and every broken configuration — unknown provider name, a provider that does
not serve that capability, **a missing API key** — falls back to local with a named
warning. A server that writes `text = { provider = "groq" }` and never sets
`tradio_groq_key` resolves to *local*. Keying on the raw config would skip the download and
then fall back onto weights that are not there, which is the exact failure this work exists
to remove.

The lockfile splits along the same lines, so selection is a filter:

| capability | lockfile weight ids | size |
| --- | --- | --- |
| `text` | `text` | 2.38 GB |
| `transcription` | `transcription` | 57 MB |
| `speech` | `voice-female`, `voice-female-config`, `voice-male`, `voice-male-config` | 121 MB |

`voice-female` → `speech` is not inferable from the id, so **each `weights[]` entry gains a
`capability` field**. Entries also gain `bytes`: there is no size anywhere in the lockfile
today, and without a denominator there is no percentage and no size cap to enforce
mid-stream.

Consequences, all intended:

- All three hosted → nothing is fetched and nothing is said.
- Only `text` hosted → 178 MB fetched instead of 2.56 GB.
- Nothing configured (the shipped default) → all 2.56 GB fetched.

## 4. The fetcher — `tLib/shared/ts/assets/`

Generic and model-agnostic, the way `tLib/server/lib/inference/registry.ts:8-11` already
is. tLib does not learn what a GGUF is; it fetches pinned bytes and verifies them. The
product owns its lockfile.

### Not a runtime export

It ships as **build-time source**, compiled into each product's `server/dist/bundle.js`.
tLib's release allowlist covers `shared/lib` and `shared/imports` but not `shared/ts`, and
tRadio already consumes that tree through its `@tlib/shared` alias.

This is deliberate. Byte-level progress across the FiveM export boundary is precisely what
`SHARED-INFERENCE-PROPOSAL.md` §7 warns against — *"Do not assume AsyncIterable or binary
buffers cross boundaries unchanged."* In-process there is no boundary, and tLib's runtime
export surface does not grow.

### Shape

```ts
interface PinnedAsset {
  id: string;
  dest: string;      // relative to the consuming resource root
  url: string;
  sha256: string;
  bytes: number;
}

interface FetchProgress {
  id: string;
  index: number; total: number;      // asset N of M
  received: number; size: number;    // bytes
  phase: "checking" | "downloading" | "verifying" | "done";
}

ensureAssets(root: string, assets: PinnedAsset[], opts: {
  onProgress?: (p: FetchProgress) => void;
  allowHosts?: string[];             // default: github.com, huggingface.co
  signal?: AbortSignal;
}): Promise<Report>;
```

### Three things `shared/ts/marketplace/download.ts` cannot do

That module already does streamed HTTP with a sha256 check and a mid-stream size cap, and
it is the right prior art — but it cannot be reused as-is:

1. **It buffers the whole body.** `Buffer.concat(chunks)` at `download.ts:83`. A 2.38 GB
   GGUF through it is an out-of-memory crash. The new fetcher writes to `<dest>.part` and
   hashes incrementally, renaming only once the digest matches.
2. **It has no progress callback.** `received` is counted at `:56-61` and never reported.
3. **It cannot resume.** A 2.5 GB download that restarts from zero on a dropped connection
   never completes on a domestic uplink. The new fetcher sends `Range` when a `.part`
   survives, and falls back to a clean restart if the server ignores it.

### Do not re-hash on every boot

Hashing 2.38 GB at each server start costs real startup time to learn nothing new — the
same reasoning already written at `tRadio/server/lib/ai/local-engine.ts:176-185` about
`artifacts.json`: *"hashing a multi-gigabyte GGUF at every boot to discover something the
build already knows would cost a minute of startup to learn nothing new."* The build no
longer knows, so the marker takes over that role. A sidecar marker records
`(sha256, size, mtime)`; a file matching its
marker is accepted without reading it. A mismatch re-verifies, and a failed verify
re-fetches.

### Origin allowlist

Carried over from `scripts/vendor-local-engine.ts:51` — `ORIGINS` is exactly
`https://github.com` and `https://huggingface.co`, enforced at `:68`.

That script checks the **starting** origin only, and its own comment at `:60-65` says so
deliberately: *"Redirects are followed but the starting origin is checked, so a lockfile
edited to point somewhere else fails here rather than three steps later."*

> **Corrected during implementation.** An earlier draft of this section called for checking
> **every redirect hop** against the allowlist. That would have broken every download the
> product makes. All six pinned weights are `huggingface.co/.../resolve/main/…` URLs, and
> HuggingFace answers those with a 302 to `cdn-lfs*.hf.co`; GitHub releases redirect to
> `objects.githubusercontent.com`. Neither is in the allowlist and neither can be, since
> those hostnames are not ours to pin. Start-origin-only is not a weakness in
> `vendor-local-engine.ts` — it is the only thing that works.

So the allowlist catches a lockfile edited to point somewhere else, early and by name, and
that is all it does. **The sha256 pin is the integrity guarantee** — a redirect to anything
serving different bytes fails verification and the `.part` is discarded. The allowlist must
not be mistaken for the security boundary. `assets-fetch.test.ts` asserts the non-recheck
explicitly, with that reasoning, so a later reader does not "fix" it back.

Note also that `fetchPinned` at `:66` does `await response.arrayBuffer()` — the build-time
fetcher has the same whole-body buffering problem as `download.ts`, and gets away with it
only because a developer box has the RAM. That is not an assumption to carry to a customer's
game server, and is a second reason the runtime fetcher streams rather than reusing either.

## 5. Blocking, per product

> **Corrected during implementation.** "Blocks resource startup" is not implementable as
> written. FiveM has no mechanism to defer a resource's `started` state: a server script
> can `await`, but the resource is already started and its exports are already registered
> by the time any of its code runs. Stalling the script thread would stall the server, not
> gate the resource.
>
> What is achievable, and what "block" means everywhere below: tAI **never reports ready**
> and **its exports refuse with a descriptive error** until its locally-resolved weights are
> verified. It does not degrade silently and it does not answer with a half-loaded engine —
> which is what the instruction was protecting against — but it also cannot hang the game
> server while a 2.4 GB file arrives.

| | tAI | tRadio |
| --- | --- | --- |
| resource start | **refuses to serve** until locally-resolved weights are verified; exports throw a descriptive error | serves everything non-AI immediately |
| on failure | does not finish starting; reports the exact reason | starts; AI Dispatching alone is unavailable |
| non-AI features | n/a — tAI is inference | radio, channels, trunking, 3D audio, panel all unaffected |

tRadio's failure message must name **AI Dispatching specifically** — not "tRadio failed" —
and carry the reason plus the retry path. It routes through the existing
`radio:setStartupError` handler (`server/sv_version.lua:428`), which already prints an
ordered diagnosis block.

`server/bin/` (219 MB) stays bundled in both products. `SpawnHost`'s containment check
(`tLib/server/lib/inference/host.ts:100-111`, `realpathSync`) requires an executed binary to
live inside the calling resource's own directory, and at 219 MB it does not threaten the
zip cap. Making binaries reactive too would save a further ~180 MB and is explicitly **out
of scope here** — one change at a time.

## 6. Telling the operator

Two channels, both already built.

**Console**, through the `onStatus`/`aiLog` pattern both products use
(`tAI/server/local-engine.ts:78`, `tRadio/server/lib/ai/local-engine.ts:457`):

```
[tRadio] ai: text -> local, transcription -> local, speech -> openai (tts-1)
[tRadio] ai: fetching 2 artifact(s), 2.44 GB
[tRadio] ai: qwen3-4b-instruct   412 MB / 2.38 GB  (17%)  8.2 MB/s  ~4m left
[tRadio] ai: qwen3-4b-instruct   verified
```

The first line is `describePlan()` (`providers.ts:171`), which is already documented as
safe to log — no key passes through it.

**Startup banner.** Register a `required` `infoEntry` with tLib's versioncheck. The box
does not print until every required row has reported (`versioncheck/server.lua:542`, settle
logic `:325-373`), so it cannot claim "ready" while a download is in flight. This is the
mechanism that distinguishes *loading* from *broken*, which is the whole point.

There is **no player-facing surface**. This is a server-console concern; nothing here
touches NUI.

## 7. Consequences for existing documents and guards

tAI's no-runtime-download rule is being **overridden by explicit decision**, not
reinterpreted. These say the opposite of this design and must be rewritten, not left to
contradict it:

- `tAI/AGENTS.md:169` — *"### 4.4 Everything ships in the resource — no runtime fetch,
  ever"*, and its **Hard constraint** paragraph.
- `tAI/README.md:5` — *"no remote host, no runtime downloads, no install step beyond the
  `server.cfg` lines"*.
- `tAI/CLAUDE.md:21-34` — *"that constraint outranks everything else here"*.
> **Corrected during implementation — the tAI rule is narrowed, not removed.**
>
> `vendored-assets.test.ts` is not the no-runtime-download guard this section assumed. It is
> an **offline containment gate for NUI/browser assets**, and it encodes a measured FiveM
> behaviour: the NUI file server indexes a resource's files at resource *start*, so a file
> written afterwards 404s at `nui://`. The libraries involved — wllama, onnxruntime-web,
> transformers.js — all fall back to a CDN silently instead of failing. **It was left
> completely untouched and still passes 52/52.**
>
> So tAI splits in two, along a line that already existed in its manifest:
>
> | tree | served to NUI? | fetchable? |
> | --- | --- | --- |
> | `models/server/**` | no — `models/*.gguf` is deliberately non-recursive | **yes** |
> | `models/*.gguf` (smollm2, 270 MB) | yes | no — NUI indexes at start |
> | `models/stt/**` | yes | no — same reason |
> | `client/ui/**` (wasm, vendor) | yes | no — same reason |
>
> Only the server-side half moves. The original rule stays true, and stays enforced, for
> everything the client loads.


- `tRadio/config/config.lua:215` — *"Nothing is sent anywhere, nothing is downloaded"*.
- `tRadio/docs/content/ai-dispatcher.mdx:10` — same sentence, customer-facing.
- `tRadio/docs/content/ai-dispatcher.mdx:66` — *"Runtime and weights ship inside the
  resource and are resolved from disk. **Nothing is ever downloaded at runtime.**"*
- `tRadio/docs/content/index.mdx:350` — *"The runtime and weights ship inside the
  resource … nothing is downloaded or sent anywhere unless you opt a capability into a
  hosted provider."* This line also quotes **"about 2 GB of RAM and 1.8 GB of disk"**; the
  disk figure is now conditional on which capabilities resolve local and must be restated
  as a range, not silently left.

These are five separate sites in three files, and `ai-dispatcher.mdx` states it twice. A
sweep that fixes the one an agent happens to grep for leaves the product documentation
contradicting the product. Grep for `download` across `docs/content/` and `config/`, not
for these line numbers, which will have moved.

What stays true and must not be weakened while editing them: with weights present, **no
transmission leaves the machine** for a locally-resolved capability. The change is about
*acquiring* the model once, not about where inference happens.

`tAI/AGENTS.md` also records a measured FiveM constraint — NUI indexes a resource's files
at start, so files written afterwards 404 via `nui://`. It does **not** apply here: weights
are read from disk by the out-of-process engine, never served over `nui://`. Verify before
relying on this.

## 8. Release changes

- `server/models/**` leaves `OPAQUE_TREES` in `tRadio/scripts/runtime-staging.ts`.
- `scripts/local-engine.lock.json` starts shipping (98 lines) — the server reads its pins.
- `server/models/artifacts.json` and `validation.json` keep shipping.
- Expected tRadio zip: **2.77 GB → ~270 MB**, back under the adm-zip cap.
- `scripts/runtime-staging.test.ts` fixtures move with the policy.

## 9. Acceptance

| Scenario | Expected |
| --- | --- |
| Fresh tRadio, nothing configured | 2.56 GB fetched; radio usable throughout; AI live when done |
| Fresh tRadio, all three hosted with keys | nothing fetched, nothing warned |
| `text = groq` with a valid key | 178 MB fetched; the 2.38 GB GGUF never requested |
| `text = groq`, key **absent** | resolves local; 2.56 GB fetched; warning names the missing convar |
| Fetch fails mid-download | radio unaffected; AI Dispatching reported unavailable with reason |
| Restart after a partial download | resumes from `.part`, does not restart from zero |
| Restart with everything present | no re-hash of 2.38 GB; startup time unchanged |
| Corrupt file on disk | marker mismatch → re-verify → re-fetch |
| Redirect to a non-allowlisted host | refused |
| Fresh tAI, nothing configured | resource does not finish starting until weights verified |
| tAI, all capabilities hosted | starts immediately, fetches nothing |
| Both installed, same `text` workload | one fetch each (per-resource storage, by decision); one shared *engine* via the existing registry |

Note the last row: per-resource storage was chosen deliberately, so tAI and tRadio each keep
their own copy of the identical 2.38 GB GGUF (~5 GB total). Engine *sharing* still works —
that is `InferenceAdvertise`/`InferenceLookup` matching on workload identity, and it is
unaffected by where the bytes live. Disk deduplication is a separate future decision.

## 10. Implementation status, 2026-09-22

**Done and verified.**

| | |
| --- | --- |
| `tLib/shared/ts/assets/{pinned,fetch,index}.ts` | streaming fetch, resume, marker skip, capability selection |
| `tLib/tests/unit/assets-{pinned,fetch}.test.ts` | 39 tests; suite 489 → **545 pass, 0 fail** |
| `tRadio/scripts/local-engine.lock.json` | `capability` + `bytes` on all six weights; every digest re-verified against the local copy |
| `tRadio/server/lib/ai/weights.ts` | reactive selection off the resolved plan, throttled progress, degraded-not-failed reporting |
| `tRadio/server/lib/ai/weights.test.ts` | 12 tests, including against the real lockfile |
| `tRadio/scripts/runtime-staging.ts` | `server/models/` out of `OPAQUE_TREES`; lockfile + `artifacts.json` + `validation.json` named explicitly |
| `tAI/scripts/local-engine.lock.json` | **partial** — see below |
| `tAI/{AGENTS,README,CLAUDE}.md` | §4.4 narrowed to NUI-served assets; `vendored-assets.test.ts` untouched, 52/52 |

**Not done, and deliberately not guessed at.**

- **tAI's lockfile has one entry.** Only `qwen3-4b` has a verified upstream URL, reusable
  because it is byte-identical to tRadio's pin — confirmed by hashing both local copies, not
  assumed. `qwen3-1.7b` (1.22 GB) and `tts/kokoro` + `tts/neutts` (1.03 GB) are still
  bundled: their provenance was never recorded, and back-filling a URL from memory would pin
  a file nobody has checked. Each needs a real fetch-and-compare before it can be added.
- **tAI has no runtime wiring.** `ensureAssets` is not called anywhere in tAI. Its startup
  shape differs from tRadio's and it is early WIP; wiring it blind would be a guess. The
  refuse-until-ready behaviour described in §5 is specified, not built.
- **tRadio's release has not been cut** against the new policy. The staging tests prove the
  policy; the ~270 MB zip figure remains projected, not measured.

## 11. Out of scope

Reactive binary fetching; shared on-disk model storage; any change to the inference
registry, engine sharing or the workload identity strings; NUI or player-facing progress;
anything in `SHARED-INFERENCE-PROPOSAL.md` phases B–E.
