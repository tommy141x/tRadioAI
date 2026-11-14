# tRadioAI

A free, MIT-licensed AI dispatcher for [tRadio](https://timmygstudios.com) on FiveM. A unit keys up on a channel and calls "Dispatch"; tRadioAI hears it, decides, acts in your CAD, and answers on the air through the same radio chain every other transmission uses.

It is a **separate resource**. tRadio does not contain it and does not need it. tRadioAI reaches tRadio only through a small, documented set of exports and events ([the contract](docs/content/tradio-contract.mdx)), and it reaches the outside world only through the providers you configure.

> **Experimental.** It is off until you switch it on, hears only the channels you list, and a dispatcher that cannot run stays quiet rather than erroring on the air. Try it on a test server before a live shift.

## Requirements

- **tRadio** with the integration hooks (its changelog says so). An older tRadio is detected and tRadioAI idles, naming what is missing.
- **tLib** 1.2.0 or newer, started before both.
- FXServer on Windows or Linux with OneSync.
- Either a hosted provider key, or the [local engine](docs/content/local-engine.mdx) (about 2.6 GB downloaded on request, x86-64 only).

## Install

Download `tRadioAI-<version>.zip` from the [releases page](https://github.com/tommy141x/tRadioAI/releases) (the release asset, not "Source code"), unpack it into `resources/tRadioAI`, then in `server.cfg`:

```cfg
ensure tLib
ensure tRadio
ensure tRadioAI
add_unsafe_child_process_permission tLib   # only if you use the local engine

set tradioai_groq_key "gsk_..."            # a key per hosted provider you use
```

And in **tRadio's** `config/config.lua`, so tRadio accepts calls from it:

```lua
Config.integrations = { 'tRadioAI' }
```

Then in this resource's `config/config.lua`: `Config.enabled = true`, `Config.channels = { ... }`, and the providers you want. The full walkthrough is [Setup](docs/content/setup.mdx).

The release zip is plaintext source and a readable bundled server script. **No escrow, no engine binaries, no model weights.**

## Providers

| Capability                            | Providers                                         |
| ------------------------------------- | ------------------------------------------------- |
| `text` (decides and writes the reply) | `local`, `openai`, `openrouter`, `groq`, `vercel` |
| `speech`                              | `local`, `openai`, `groq`, `elevenlabs`           |
| `transcription`                       | `local`, `openai`, `groq`                         |

Keys are `server.cfg` convars (`tradioai_<provider>_key`), never fields in `config.lua`. Every hosted provider except ElevenLabs needs a `model`. See [Providers](docs/content/providers.mdx) for what leaves your server with each choice.

## The local engine

llama.cpp, whisper.cpp and Piper, fetched from their own upstreams on first start and checked against pinned sha256 values. Nothing is mirrored or redistributed here.

- **Windows x86-64 and Linux x86-64 only.** There are no arm64 pins, so an arm64 container (Raspberry Pi, Ampere, Graviton) is hosted-providers-only.
- Linux needs **glibc 2.34 or newer**. Alpine and other musl hosts cannot run the upstream builds as they are.
- No GPU; about 2 GB of free RAM with both models loaded.
- **Licences:** llama.cpp and whisper.cpp are MIT. Piper bundles `espeak-ng-data`, which is GPL-3.0, and each Piper voice and the Qwen3 quantisation carries its own terms. I could not verify those offline: read them before you rely on them. Details in [the local engine](docs/content/local-engine.mdx#licences).

## If you used the dispatcher inside tRadio before October 26

Your keys and downloaded model files are not read automatically. Move your provider keys into `server.cfg` as `set tradioai_<provider>_key "..."`, move your settings into `config/config.lua` here, and move the `Config.aiDispatch*` hooks from tRadio's `sv_functions.lua` into this resource's `config/sv_functions.lua` under the shorter names listed in [Setup](docs/content/setup.mdx#if-you-used-the-dispatcher-inside-tradio-before-october-26).

## Documentation

|                                                                  |                                                             |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| [Setup](docs/content/setup.mdx)                                  | install, keys, configuration, migrating                     |
| [Providers](docs/content/providers.mdx)                          | who serves what, what leaves your server, spend controls    |
| [The local engine](docs/content/local-engine.mdx)                | requirements, platforms, licences, where the files live     |
| [Tools, hooks and CAD](docs/content/tools-and-cad.mdx)           | what it can do, your own tools, connecting a CAD            |
| [Troubleshooting](docs/content/troubleshooting.mdx)              | console lines and what to change                            |
| [Security model](docs/content/security.mdx)                      | trust boundary, keys, child processes                       |
| [How tRadioAI talks to tRadio](docs/content/tradio-contract.mdx) | every export and event, the reference for tRadio's side     |
| [Design](docs/design)                                            | measurements and history from when this lived inside tRadio |

## Developing

`bun` only. `bun install`, then:

```
bun run verify        lint, typecheck, tests, the Lua suites and every gate's negative control
bun run build         server/main.ts -> server/dist/bundle.js
bun run prod          the release zip, with the release gate (no weights, binaries or keys)
bun run harness       the offline scenario harness (needs a local engine or a hosted key)
```

The harness and probes start the real tLib spawn broker, so they need a tLib checkout beside this repository (`../tLib`); nothing else here does.

Lua has no native interpreter here; the suites in `scripts/tests` run on Fengari, and `scripts/lua-syntax.test.ts` parses every shipped Lua file. Lua that touches the game or tLib at runtime (`sv_version.lua`, the real export surface) is checked statically only. The tRadio side is exercised against `server/lib/stub-tradio.ts`, which implements the contract.

## License

MIT. See [LICENSE](LICENSE).
