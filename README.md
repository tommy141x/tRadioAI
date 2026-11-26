# tRadioAI

An AI dispatcher for [tRadio](https://timmygstudios.com) on FiveM. A unit keys up and says "Dispatch, 1-Adam-12, show me 10-8"; tRadioAI transcribes it, decides what to do, acts (unit status, your CAD, alerts, tones, patches, your own tools), and answers on the same channel through tRadio's normal radio path. It can also put 911 calls out on the air and, if you allow it, answer them.

It is a separate resource. It reaches tRadio only through tRadio's integration exports and events ([reference](docs/content/tradio-contract.mdx)), and the outside world only through the providers you configure. MIT licensed, no escrow.

## Requirements

- **tRadio 7.3** or newer. An older tRadio is detected; tRadioAI stays idle and says what is missing.
- **tLib 1.3** or newer, started before both.
- FXServer on Windows or Linux, with OneSync.
- A hosted provider key, or the [local engine](docs/content/local-engine.mdx) (about 2.5 GB of model files, x86-64 only).

## Install

1. Download `tRadioAI-<version>.zip` from [Releases](https://github.com/tommy141x/tRadioAI/releases) (the release asset, not "Source code") and unpack it to `resources/tRadioAI`.
2. `server.cfg`:

   ```cfg
   ensure tLib
   ensure tRadio
   ensure tRadioAI

   # one line per hosted provider you use
   set tradioai_groq_key "gsk_..."

   # only for the local engine
   add_unsafe_child_process_permission tLib
   ```

3. **tRadio's** `config/config.lua`. tRadio refuses every call from a resource that is not listed here:

   ```lua
   Config.integrations = { 'tRadioAI' }
   ```

4. This resource's `config/config.lua`:

   ```lua
   Config.enabled  = true
   Config.channels = { 154.755 }   -- frequencies it listens to and answers on
   Config.providers = {
       text   = { provider = 'groq', model = 'llama-3.3-70b-versatile' },
       speech = { provider = 'elevenlabs' },
   }
   ```

5. Restart tRadio, start tRadioAI, and run `tradioai_status` in the server console.

Full walkthrough: [Setup](docs/content/setup.mdx).

## API keys

Keys are `server.cfg` convars, never `config.lua` entries:

| Provider | Convar |
| --- | --- |
| OpenAI | `tradioai_openai_key` |
| Groq | `tradioai_groq_key` |
| OpenRouter | `tradioai_openrouter_key` |
| Vercel AI Gateway | `tradioai_vercel_key` |
| ElevenLabs | `tradioai_elevenlabs_key` |

A key typed into `config.lua` is ignored and the console says so without printing it. `tradioai_status` shows each key only as `set` or `not set`.

## Providers

| Capability | Providers |
| --- | --- |
| `text` (decides and writes the reply) | `local`, `openai`, `openrouter`, `groq`, `vercel` |
| `speech` | `local`, `openai`, `groq`, `elevenlabs` |
| `transcription` | `local`, `openai`, `groq` |

Every hosted provider except ElevenLabs needs a `model`; `tradioai_models <provider>` lists them. A capability left unset runs on the local engine. Hosted providers receive audio or transcripts of the channels you list and nothing else. Details: [Providers](docs/content/providers.mdx).

## Configuration

Settings are in `config/config.lua`, your tools and hooks in `config/sv_functions.lua`. Both are replaced when you update, so keep your own copy and merge forward.

After editing either file, run `tradioai_reload` in the server console. It applies the change without a restart; if a file has an error, the running config is left as it was.

Console commands (server console only):

| Command | What it does |
| --- | --- |
| `tradioai_status` | tRadio hooks found, engine per capability, keys set, hosted call rate, local engine state |
| `tradioai_reload` | re-read both config files and apply them |
| `tradioai_models <provider>` | list a provider's model ids |
| `tradioai_download` | fetch the local engine's model files |

## Limits

- English only.
- A channel carries one exchange at a time; a unit that keys up mid-reply is answered next.
- Local engine: Windows or Linux x86-64, glibc 2.34+ on Linux, no GPU, about 2 GB of free RAM. No arm64 and no Alpine/musl; use hosted providers there.
- No admin panel. Settings live in `config.lua`, status in `tradioai_status`.
- CAD writes need tRadio's own `Config.cad.tools`. Status writing works on LACORE and SonoranCAD only; see [Tools, hooks and CAD](docs/content/tools-and-cad.mdx).
- The local engine's third-party files (Piper's GPL-3.0 `espeak-ng-data`, each Piper voice, the Qwen3 weights) carry their own licences. Read them before relying on them: [Licences](docs/content/local-engine.mdx#licences).

## Troubleshooting

| Console says | Do this |
| --- | --- |
| `tRadio refused <hook>. Add this line ...` | add `Config.integrations = { 'tRadioAI' }` to **tRadio's** `config/config.lua` and restart tRadio |
| `this tRadio is too old for tRadioAI` | update tRadio to 7.3 or newer |
| `tRadio is not running` | start tRadio; tRadioAI picks it up on its own |
| `... needs a model for text` | set `model` for that provider |
| `... none is set in tradioai_<provider>_key` | add the convar to `server.cfg` and restart the server |
| `waiting on model files` | run `tradioai_download`, or use a hosted `text` provider |
| `the API is restricted` | add `add_unsafe_child_process_permission tLib` and restart the server |
| nothing at all | check `Config.enabled`, `Config.channels`, and that the unit says the wake phrase |

Every turn is logged to the console and to `logs/ai-dispatch.jsonl`. More: [Troubleshooting](docs/content/troubleshooting.mdx).

## Coming from the dispatcher built into tRadio

Nothing is carried over automatically. Copy your keys into the convars above, your settings into `config/config.lua` (same names without `aiDispatch`), and your hooks into `config/sv_functions.lua`: `Config.aiDispatchTools` is now `Config.tools`, and likewise `incidents`, `unitNote`, `location` and `instructions`. The events are `tradioai:call` and `tradioai:unitStatusChanged`. Details: [Setup](docs/content/setup.mdx#if-you-used-the-dispatcher-inside-tradio-before-october-26).

## Documentation

- [Setup](docs/content/setup.mdx)
- [Providers](docs/content/providers.mdx)
- [The local engine](docs/content/local-engine.mdx)
- [Tools, hooks and CAD](docs/content/tools-and-cad.mdx)
- [Troubleshooting](docs/content/troubleshooting.mdx)
- [Security](docs/content/security.mdx)
- [tRadio integration reference](docs/content/tradio-contract.mdx)

## Developing

`bun` only. `bun install`, then:

```
bun run verify   lint, typecheck, tests, Lua suites and every gate's negative control
bun run build    server/main.ts -> server/dist/bundle.js
bun run prod     release zip, refused if it would contain weights, binaries or keys
```

Tests run against `server/lib/stub-tradio.ts`, an implementation of the tRadio contract. Lua suites run on Fengari. `bun run harness` and the probes start tLib's spawn broker and need a tLib checkout at `../tLib`.

## License

MIT. See [LICENSE](LICENSE).

`server/dist/bundle.js` has two npm dependencies compiled into it, both MIT. Their licence texts are reproduced in [THIRD-PARTY-NOTICES.txt](THIRD-PARTY-NOTICES.txt), which ships in the zip beside the bundle; `bun run notices:gen` regenerates it from the bundler's own module graph.
