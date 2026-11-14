-- Oracle for server/sv_config.lua: what the Node bundle is told, and what it must never be
-- told.
--
-- The assertions worth having here are the ones about SECRETS and DEFAULTS. A provider key
-- typed into config.lua must not travel in the event payload and must be named (without its
-- value) in the console; `answer911` must stay opt-in; an unknown key must be reported.
-- All of those are refusals, so `CONFIG_CONTROL=1` feeds each the input that must be
-- accepted and they must stop holding (see scripts/lua/harness.lua).

local root = (function()
    local source = debug.getinfo(1, 'S').source:sub(2):gsub('\\', '/')
    local found = source:match('^(.*)/scripts/tests/config%.lua$')
    if found == nil or found == '' then found = '.' end
    return function(p) return found .. '/' .. p end
end)()

local H = dofile(root('scripts/lua/harness.lua'))
local check, neg = H.check, H.neg
local CONTROL = os.getenv('CONFIG_CONTROL') == '1'

local host = H.host()
local logged = H.silence()

local SECRET = 'sk-this-must-never-leave-the-file-0123456789'

-- Whatever a test needs to know it can read back from this one place.
local function load(config)
    _G.Config = config
    host.handlers = {}
    host.fired = {}
    for i = #logged, 1, -1 do logged[i] = nil end
    dofile(root('server/sv_config.lua'))
    for _, fn in ipairs(host.handlers['tradioai:nodeReady'] or {}) do fn() end
    local pushed = host.firedEvents('tradioai:config')
    return pushed[1] and pushed[1].args[1] or nil, table.concat(logged, '\n')
end

-- ── Defaults ────────────────────────────────────────────────────────────────
local payload, said = load({ answer911 = CONTROL and true or nil })
check(payload ~= nil, 'an empty Config still pushes a payload')
check(payload.enabled == false, 'disabled by default')
check(payload.callsign == 'Dispatch', 'the callsign defaults to Dispatch')
check(payload.voiceGender == 'female', 'the voice defaults to female')
check(payload.yieldToDispatcher == true and payload.auto911 == true, 'yielding and announcing default on')
neg(payload.answer911 == false, 'answering 911 is off unless the operator says true')
check(type(payload.channels) == 'table' and #payload.channels == 0, 'no channels by default')
check(said == '', 'a default config says nothing in the console')

-- answer911 is opt-in, and only the boolean true opts in.
local function answers(value) return (load({ answer911 = value })).answer911 end
check(answers(true) == true, 'answer911 = true answers 911')
neg(answers(CONTROL and true or 'true') == false, 'a string "true" is not consent to answer 911')
neg(answers(CONTROL and true or 1) == false, 'the number 1 is not consent to answer 911')
neg(answers(CONTROL and true or nil) == false, 'an absent answer911 is not consent')

-- ── The payload carries what the bundle reads ───────────────────────────────
local full = load({
    enabled = true,
    channels = { 154.755, 460.25 },
    callsign = 'Control',
    voiceGender = 'male',
    demeanor = 'brisk',
    wakePhrases = { 'control' },
    yieldToDispatcher = false,
    auto911 = false,
    answer911 = true,
    tenCodes = { ['10-4'] = 'acknowledged' },
    cad = 'sonoran',
    turnTimeoutMs = 20000,
    turnCooldownMs = 0,
    hostedCallsPerMinute = 30,
    providers = { text = { provider = 'groq', model = 'llama-3.3-70b-versatile', baseUrl = 'http://x/v1' } },
    voices = { male = { 'alloy' }, female = { 'nova' } },
    localEngine = { root = '/data/ai', textModel = 'm.gguf' },
})
check(full.enabled == true and #full.channels == 2 and full.channels[2] == 460.25, 'enabled and channels pass through')
check(full.callsign == 'Control' and full.voiceGender == 'male' and full.demeanor == 'brisk', 'callsign, voice and demeanor pass through')
check(full.yieldToDispatcher == false and full.auto911 == false and full.answer911 == true, 'the three booleans pass through, false included')
check(full.tenCodes['10-4'] == 'acknowledged' and full.cad == 'sonoran', 'the code sheet and the CAD pin pass through')
check(full.turnTimeoutMs == 20000 and full.turnCooldownMs == 0 and full.hostedCallsPerMinute == 30, 'the numeric limits pass through')
check(full.providers.text.provider == 'groq' and full.providers.text.model == 'llama-3.3-70b-versatile'
    and full.providers.text.baseUrl == 'http://x/v1', 'a provider passes provider, model and baseUrl')
check(full.provider.voices.male[1] == 'alloy' and full.provider.voices.female[1] == 'nova', 'voices pass through as provider.voices')
check(full.localEngine.root == '/data/ai' and full.localEngine.textModel == 'm.gguf', 'the local engine paths pass through')
check(load({ voiceGender = 'robot' }).voiceGender == 'female', 'an unknown voice gender falls back to female')
check(load({ callsign = 42 }).callsign == 'Dispatch', 'a callsign that is not a string falls back')

-- ── Secrets ─────────────────────────────────────────────────────────────────
local leaky, leakySaid = load({
    providers = { text = { provider = 'openai', model = 'gpt-4o-mini', key = SECRET } },
})
if CONTROL then
    -- The bug this section exists to prevent, put back: the table forwarded as typed,
    -- and nothing said. Every assertion below must notice.
    leaky.providers.text.key = SECRET
    leakySaid = 'key ' .. SECRET
end
local function mentions(value, needle)
    if type(value) == 'string' then return value:find(needle, 1, true) ~= nil end
    if type(value) == 'table' then
        for k, v in pairs(value) do
            if mentions(k, needle) or mentions(v, needle) then return true end
        end
    end
    return false
end
neg(leaky.providers.text.key == nil, 'a key typed into config.lua is not in the payload')
neg(not mentions(leaky, SECRET), 'the key value appears nowhere in the payload')
neg(not leakySaid:find(SECRET, 1, true), 'the key value is never printed')
neg(leakySaid:find('providers.text.key in config.lua is ignored', 1, true) ~= nil,
    'the operator is told the key was ignored')
neg(leakySaid:find('tradioai_openai_key', 1, true) ~= nil, 'and told which convar to use instead')

local tidy, tidySaid = load({ providers = { text = { provider = 'openai', model = 'gpt-4o-mini' } } })
check(tidy.providers.text.model == 'gpt-4o-mini' and not tidySaid:find('ignored', 1, true), 'a provider with no key in the file says nothing')

-- ── Unknown keys ────────────────────────────────────────────────────────────
local _, typoSaid = load({ enabled = true, channles = { 154.755 }, aiDispatch = {} })
check(typoSaid:find('channles', 1, true) ~= nil and typoSaid:find('aiDispatch', 1, true) ~= nil,
    'keys this version does not read are named, so a typo is not silent')
check(typoSaid:find('aiDispatch, channles', 1, true) ~= nil, 'and listed in a stable order')
local _, knownSaid = load({
    enabled = true,
    tools = function() end,
    voices = {},
    cad = '',
    typo = CONTROL and 1 or nil,
})
neg(not knownSaid:find('does not read', 1, true), 'a config made only of known keys, hooks included, says nothing')

H.finish('config.lua', 'CONFIG_CONTROL')
