# tLib spawn catalogue entry for tRadioAI

tLib's spawn broker takes the *name* of a program from a hard-coded catalogue of first-party callers (`server/lib/spawn/catalog.ts`, `FAMILY`). That list is "the grant" and must not become operator configuration, so the local engine only works once a tLib release names `tRadioAI`. This repository cannot edit tLib; this is the exact change to apply there.

## 1. Replace the `tRadio` entry

In `tLib/server/lib/spawn/catalog.ts`, replace the whole `resource: "tRadio"` object in `FAMILY` (the one with `dormant: true`, currently lines 273-345) with:

```ts
  {
    resource: "tRadioAI",
    // Three engines, each execed through its bundled loader when the release carries
    // one. tRadioAI's own releases do not (they carry no binaries at all; the engines
    // are fetched from their upstreams on first start into server/bin), so on a glibc
    // host the loader directory is simply absent and the binary is execed directly.
    // Loader directory is per engine, not one shared `server/bin/linux/lib`: llama.cpp
    // and whisper.cpp each ship a `libggml` built from a different revision, and a
    // shared directory hands one of them a library it wasn't linked against.
    author: "Tommy Johnston",
    programs: [
      llamaServer({
        win32: "server/bin/win/llama/llama-server.exe",
        linux: "server/bin/linux/llama/llama-server",
        loaderDir: "server/bin/linux/llama/lib",
      }),
      {
        id: "whisper-server",
        paths: {
          win32: ["server/bin/win/whisper/whisper-server.exe"],
          linux: ["server/bin/linux/whisper/whisper-server"],
        },
        loaderDir: "server/bin/linux/whisper/lib",
        cwd: ["", "server/bin/win/whisper", "server/bin/linux/whisper"],
        env: ["LD_LIBRARY_PATH"],
        invocations: [
          {
            label: "whisper-server",
            head: [],
            // Exactly the four flags tRadioAI passes (server/lib/local-engine.ts).
            // `--convert` is deliberately absent: it shells out to ffmpeg, which most
            // game panels do not have, and tRadioAI never sends anything but 16 kHz
            // mono WAV.
            flags: [
              { name: "--model", form: "value", value: "path" },
              { name: "--host", form: "value", value: "loopback" },
              { name: "--port", form: "value", value: "port" },
              { name: "--threads", form: "value", value: "int" },
            ],
          },
        ],
      },
      {
        id: "piper",
        paths: {
          win32: ["server/bin/win/piper/piper.exe"],
          linux: ["server/bin/linux/piper/piper"],
        },
        loaderDir: "server/bin/linux/piper/lib",
        cwd: ["", "server/bin/win/piper", "server/bin/linux/piper"],
        env: ["LD_LIBRARY_PATH"],
        invocations: [
          {
            label: "piper",
            head: [],
            flags: [
              { name: "--model", form: "value", value: "path" },
              { name: "--espeak_data", form: "value", value: "path" },
              { name: "-f", form: "value", value: "path" },
            ],
          },
        ],
      },
    ],
  },
```

The `llamaServer(...)` helper and its shared flag list (`LLAMA_SERVER_FLAGS`) are unchanged; the flags tRadioAI passes (`--model --host --port --ctx-size --threads --no-webui --reasoning`) must be in that list, which they were for tRadio. Check before release.

## 2. Remove what was only there for the dormant entry

`dormant` existed for exactly one caller. Once the entry above is in, nothing is dormant:

- delete the `dormant?: boolean` field and its comment from `interface Caller` (`catalog.ts:89-101`),
- in the banner function, drop the `!c.dormant &&` filter (`catalog.ts:374`) and the paragraph above it (`catalog.ts:358`),
- `tests/unit/spawn-banner.test.ts` has a case, "still omits dormant callers even when they are installed", written against the tRadio entry. Delete it, or re-point it at a fixture caller if the banner test wants a dormancy case.

Whether the banner should now **name tRadioAI** when it is installed is the intended behaviour: it is a first-party caller with a real grant.

## 3. Operator lines

```cfg
# server.cfg: only for the local engine. Hosted providers start no process.
add_unsafe_child_process_permission tLib
```

No new convar and no tLib convar change. The permission line names **tLib**, which makes the call on tRadioAI's behalf; naming `tRadioAI` there does nothing.

## 4. Versioning

tRadioAI's manifest says `tlib_min_version '1.2.0'`, on the assumption that the next tLib release after the current 1.1.0 is the first to carry this entry. If that release is numbered differently, change the manifest line to match **before** tagging tRadioAI. tLib must ship first: a consumer that names a version tLib has not released fails at start with "needs tLib X or newer".

## 5. Optional, from the extraction plan

`internal/shared-ts/assets/{index,fetch,pinned}.ts` (the pinned-download primitive) is vendored into tRadioAI as `server/lib/assets/` because a public repository cannot import tLib's private nested repo. If it is promoted to tLib's public `shared/ts/assets/`, tRadioAI should import it from there and delete its copy; until then the copy is the owner of that code for this repository.
