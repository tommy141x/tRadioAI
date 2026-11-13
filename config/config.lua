-- tRadioAI: configuration.
--
-- This file ships with the release and is OVERWRITTEN when you update. Keep a copy of
-- your own values and merge forward; the release notes list any key that was added.
--
-- API keys are NOT in this file. They are `server.cfg` convars, because this file is
-- the one that gets pasted into support threads:
--
--     set tradioai_openai_key     "sk-..."
--     set tradioai_groq_key       "gsk_..."
--     set tradioai_openrouter_key "sk-or-..."
--     set tradioai_vercel_key     "..."
--     set tradioai_elevenlabs_key "..."
--
-- Install lines (server.cfg):
--
--     ensure tLib
--     ensure tRadio
--     ensure tRadioAI
--     add_unsafe_child_process_permission tLib     # only for the local engine
--
-- And in tRadio's own config/config.lua, one line naming this resource, or tRadio
-- refuses every call it makes:
--
--     Config.integrations = { 'tRadioAI' }

Config = {
    -- Off until you switch it on. Nothing below does anything while this is false.
    enabled = false,

    -- The frequencies the dispatcher listens to and answers on, as written in tRadio's
    -- channel list, e.g. { 154.755, 460.250 }. Empty means none.
    channels = {},

    -- What the dispatcher is called on the air and in tRadio's unit list.
    callsign = 'Dispatch',

    -- 'female' or 'male'. Picks the first voice from `voices` below.
    voiceGender = 'female',

    -- How it speaks: '' (the default), 'measured', 'brisk', 'veteran' or 'formal'.
    demeanor = '',

    -- A transmission that begins with one of these is addressed to the dispatcher.
    -- A unit that opens with its own callsign, or answers the dispatcher, is too.
    wakePhrases = { 'dispatch' },

    -- Stand off a channel a human dispatcher has signed on to.
    yieldToDispatcher = true,

    -- Put new 911 calls out on the air and assign a unit. Needs tRadio's 911 hooks.
    auto911 = true,

    -- Pick up 911 calls and talk to the caller when no human dispatcher is signed on.
    -- Off by default and separate from `auto911`: this puts the dispatcher on the line
    -- with a member of the public.
    answer911 = false,

    -- Your own code sheet, `code = meaning`. A shipped sheet would be one agency's, and
    -- a dispatcher acting on 10-50 under the wrong meaning is worse than one that treats
    -- it as an opaque token. Empty means the dispatcher is told no meanings.
    --     ['10-4'] = 'acknowledged', ['10-50'] = 'traffic accident'
    tenCodes = {},

    -- Which CAD to use when more than one is running: 'lacore', 'sonoran', 'imperial',
    -- 'wasabi', 'tkmdt' or 'psmdt'. Empty picks the richest one. Whether the dispatcher
    -- may WRITE to the CAD at all is tRadio's own `Config.cad.tools`, not a setting here.
    cad = '',

    -- Whole-turn budget in ms (2000 - 60000). A dispatcher that answers late is worse
    -- than a quiet one.
    turnTimeoutMs = 30000,

    -- Smallest gap between two turns for the SAME unit, in ms. 0 turns it off.
    turnCooldownMs = 3000,

    -- Ceiling on hosted provider calls per rolling minute, across all three capabilities.
    -- 0 means no ceiling. Over it, a turn is served by the local engine instead.
    hostedCallsPerMinute = 0,

    -- Which engine serves each capability. Omit one for the local engine. A hosted
    -- provider without its convar key falls back to local and says so in the console.
    --     provider  'openai' | 'openrouter' | 'groq' | 'vercel' | 'elevenlabs' | 'local'
    --     model     the provider's model id
    --     baseUrl   optional: a compatible proxy or gateway under that provider's name
    --
    -- text serves: local, openai, openrouter, groq, vercel
    -- speech serves: local, openai, groq, elevenlabs
    -- transcription serves: local, openai, groq
    providers = {
        -- text          = { provider = 'groq',       model = 'llama-3.3-70b-versatile' },
        -- speech        = { provider = 'elevenlabs', model = 'eleven_turbo_v2_5' },
        -- transcription = { provider = 'openai',     model = 'whisper-1' },
    },

    -- Voice ids, by gender. Piper voice names for the local engine; the provider's own
    -- ids ('alloy', 'nova', an ElevenLabs voice id) for a hosted one.
    voices = {
        male = { 'en_US-ryan-medium' },
        female = { 'en_US-amy-medium' },
    },

    -- The local engine (llama.cpp, whisper.cpp, Piper): fetched from upstream on first
    -- start, sha256-checked, never redistributed here. About 2.6 GB of weights.
    localEngine = {
        -- Where engines and weights live. '' means inside this resource's folder; set an
        -- absolute path on a persistent volume if the resource folder is rebuilt on
        -- deploy, and to adopt files an earlier install already downloaded.
        root = '',
        textModel = '',
        transcribeModel = '',
        voicesDir = '',
    },
}
