-- tRadioAI: pushes `Config` to the Node bundle.
--
-- One payload carries everything the bundle needs, so a partial push can never leave the
-- dispatcher half-configured. Sent when the bundle says its handlers are registered
-- (`tradioai:nodeReady`): pushing earlier would be a lost event.
--
-- Provider API keys are deliberately not in it. The bundle reads them from their
-- `server.cfg` convars at the point of use, so a key never sits in an object that is
-- logged or passed over an event.

local KNOWN_KEYS = {
    enabled = true, channels = true, callsign = true, voiceGender = true, demeanor = true,
    wakePhrases = true, yieldToDispatcher = true, auto911 = true, answer911 = true,
    tenCodes = true, cad = true, turnTimeoutMs = true, turnCooldownMs = true,
    hostedCallsPerMinute = true, providers = true, voices = true, localEngine = true,
    -- Hooks, which live in config/sv_functions.lua but are the same table.
    tools = true, incidents = true, unitNote = true, location = true, instructions = true,
}

local function warn(message)
    print(('^3[tRadioAI] %s^0'):format(message))
end

-- An unknown key is almost always a typo or a setting from another resource's config
-- pasted in, and either way it silently does nothing. Named once at start.
local function checkKeys()
    local unknown = {}
    for key in pairs(Config) do
        if not KNOWN_KEYS[key] then unknown[#unknown + 1] = tostring(key) end
    end
    table.sort(unknown)
    if #unknown > 0 then
        warn('config.lua has keys this version does not read: ' .. table.concat(unknown, ', '))
    end
end

-- A key typed into config.lua is ignored by design (see the header), and silently ignoring
-- it would leave the operator wondering why a hosted provider fell back to the local
-- engine. Named without echoing the value.
local function checkKeysNotInConfig()
    if type(Config.providers) ~= 'table' then return end
    for capability, entry in pairs(Config.providers) do
        if type(entry) == 'table' and entry.key ~= nil then
            warn(('providers.%s.key in config.lua is ignored: put the key in server.cfg as '
                .. 'set tradioai_%s_key "..." and remove it from this file'):format(
                tostring(capability), tostring(entry.provider or '<provider>')))
        end
    end
end

local function section(value)
    return type(value) == 'table' and value or {}
end

-- Only the fields the bundle reads. A `key` the operator typed here anyway is dropped,
-- so a credential never travels in an event payload (see checkKeysNotInConfig).
local function providers()
    local out = {}
    if type(Config.providers) ~= 'table' then return out end
    for capability, entry in pairs(Config.providers) do
        if type(entry) == 'table' then
            out[capability] = {
                provider = entry.provider,
                model = entry.model,
                baseUrl = entry.baseUrl,
            }
        end
    end
    return out
end

local function payload()
    return {
        enabled = Config.enabled == true,
        channels = section(Config.channels),
        callsign = type(Config.callsign) == 'string' and Config.callsign or 'Dispatch',
        voiceGender = Config.voiceGender == 'male' and 'male' or 'female',
        -- Passed through as typed. The legal keys live in DEMEANORS in the bundle, which
        -- checks them and names one it does not know; listing them here as well would be
        -- the same list in two languages.
        demeanor = type(Config.demeanor) == 'string' and Config.demeanor or '',
        wakePhrases = Config.wakePhrases,
        yieldToDispatcher = Config.yieldToDispatcher ~= false,
        auto911 = Config.auto911 ~= false,
        -- Opt-in, so `== true`: matches the default in the bundle rather than defaulting
        -- open like the two above.
        answer911 = Config.answer911 == true,
        -- Passed through whole: the bundle accepts a map, a list of pairs or one string,
        -- and parses it once.
        tenCodes = Config.tenCodes,
        cad = type(Config.cad) == 'string' and Config.cad or '',
        turnTimeoutMs = tonumber(Config.turnTimeoutMs),
        turnCooldownMs = tonumber(Config.turnCooldownMs),
        hostedCallsPerMinute = tonumber(Config.hostedCallsPerMinute),
        providers = providers(),
        provider = { voices = section(Config.voices) },
        localEngine = section(Config.localEngine),
    }
end

AddEventHandler('tradioai:nodeReady', function()
    checkKeys()
    checkKeysNotInConfig()
    TriggerEvent('tradioai:config', payload())
end)
