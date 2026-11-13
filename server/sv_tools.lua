-- tRadioAI: the tool registry and the built-in unit status.
--
-- The voice half of this resource (transcription, the model, speech, and putting the
-- reply on the channel) lives in server/lib inside the Node bundle. This file owns the
-- only part that has to see the game: what the dispatcher is allowed to DO, and what
-- happens when it does it.
--
-- A tool is a name, a line saying when it applies, and a line saying what its argument
-- is. The bundle asks this file which tools apply to the turn, the model names one and
-- writes the argument, and the tool's own run() decides whether that argument is
-- acceptable. WHAT it may pass a tool is the tool's business, not a list the operator
-- has to maintain twice.
--
-- Why the registry is here and not in config/sv_functions.lua: that file is the
-- operator's, and they merge their own copy forward release to release, so a registry
-- shipped inside it would be a block they have to re-apply by hand every time it grows.
-- Only the hooks live there. The mechanism lives here, which keeps their merge surface
-- to the hooks.

local function warn(message)
    print(('^3[tRadioAI] %s^0'):format(message))
end

local function wrap(name, fn)
    tlib.platform.wrapExport(GetCurrentResourceName(), name, fn)
end

-- ==================================================================
--  UNIT STATUS
-- ==================================================================
--  tRadio keeps no unit-status model, and neither does this resource beyond the
--  smallest store that makes the first tool real. It is deliberately memory-only: a
--  status is a fact about the current shift, and a player who reconnects is back in
--  service by definition.
--
--  A status is whatever a unit said it was. There is no allow-list, because every
--  server runs its own ten-codes and a server that had to enumerate them would be
--  maintaining the same list here and in its CAD. A tool that does need to constrain its
--  input rejects it in run(), and the dispatcher tells the unit so on the air.
--
--  Other resources read it through the getUnitStatus export and react to the
--  tradioai:unitStatusChanged event.

local unitStatus = {}

local MAX_STATUS_LENGTH = 48

-- Trim, collapse whitespace, and drop the punctuation transcription leaves on a spoken
-- code ("10-8." and "10-8" are the same status).
local function cleanStatus(value)
    if type(value) ~= 'string' then return nil end
    local cleaned = value:gsub('%s+', ' '):gsub('^%s+', ''):gsub('%s+$', ''):gsub('[%.,;!%?]+$', '')
    if cleaned == '' or #cleaned > MAX_STATUS_LENGTH then return nil end
    return cleaned
end

local function setUnitStatus(serverId, value)
    local id = tonumber(serverId)
    if not id or id <= 0 then return false end

    unitStatus[id] = { value = value, at = os.time() }
    TriggerEvent('tradioai:unitStatusChanged', id, value)
    return true
end

wrap('getUnitStatus', function(serverId)
    local id = tonumber(serverId)
    return id and unitStatus[id] or nil
end)

wrap('setUnitStatus', function(serverId, value)
    local cleaned = cleanStatus(value)
    if not cleaned then return false end
    return setUnitStatus(serverId, cleaned)
end)

AddEventHandler('playerDropped', function()
    unitStatus[source] = nil
end)

-- ==================================================================
--  TOOL REGISTRY
-- ==================================================================
--  A tool is:
--    id          unique string, [a-z0-9_]
--    description one line telling the model when the tool applies
--    input       one line saying what the argument is. Omit for a tool that takes no
--                argument. Say what the value IS, never what it might be: a small model
--                reads a trailing example as the answer. Measured -- "such as 10-8,
--                10-97 or out at lunch" produced a dispatcher that put every unit out at
--                lunch, whatever they had actually said.
--    available   optional function(ctx) -> boolean, to hide the tool this turn
--    run         function(ctx, input) -> ok, message
--
--  ctx is what the dispatcher knows about the turn; config/sv_functions.lua lists the
--  fields. run's message is read back to the model, which then says it on the air -- so
--  write it as a reason, not an error code.

local BUILTIN_TOOLS = {
    {
        id = 'unit_status',
        description = 'the unit is telling you their status, availability or location code',
        input = 'the status the unit just gave, in the words they used for it',
        run = function(ctx, input)
            local status = cleanStatus(input)
            if not status then return false, 'you did not give a status' end
            if not setUnitStatus(ctx.serverId, status) then
                return false, 'their unit could not be identified'
            end

            local who = (ctx.callsign ~= nil and ctx.callsign ~= '') and ctx.callsign
                or ('unit ' .. tostring(ctx.serverId))
            return true, who .. ' is now showing ' .. status
        end,
    },
}

-- ==================================================================
--  INCIDENT TOOLS
-- ==================================================================
--  No incident store here either. A server that has calls already has them in its CAD,
--  and a second set of call records would be a copy that drifts the first time anyone
--  touches the real one.
--
--  So these tools exist only when the operator supplies the function behind them via
--  Config.incidents. Whichever keys they return become tools; the rest are not
--  capabilities the dispatcher has, and the model is never told about an action nobody
--  implemented.

local INCIDENT_TOOLS = {
    {
        key = 'create',
        id = 'create_call',
        description = 'the unit is reporting something that should become a call -- a stop, a crash, a disturbance',
        input = 'what the call is and where, in the unit\'s own words',
    },
    {
        key = 'attach',
        id = 'attach_unit',
        description = 'a unit is being sent to, or is arriving at, a call that already exists',
        input = 'which unit, and which of the calls above they are going to',
    },
    {
        key = 'clear',
        id = 'clear_unit',
        description = 'a unit is done with a call and is available for another one',
        input = 'which unit, and the call they are clearing from',
    },
    {
        key = 'close',
        id = 'close_call',
        description = 'the call is finished and needs nobody else on it',
        input = 'which call to close',
    },
}

local function incidentHooks()
    if type(Config.incidents) ~= 'function' then return nil end
    local ok, hooks = pcall(Config.incidents)
    if not ok then
        warn('Config.incidents threw -- ' .. tostring(hooks))
        return nil
    end
    return type(hooks) == 'table' and hooks or nil
end

local tools = {}
local toolsById = {}

local function validTool(tool)
    if type(tool) ~= 'table' then return false, 'not a table' end
    if type(tool.id) ~= 'string' or not tool.id:match('^[a-z0-9_]+$') then
        return false, 'id must be a lowercase string of letters, digits and underscores'
    end
    if type(tool.description) ~= 'string' or tool.description == '' then
        return false, 'description is required'
    end
    if type(tool.run) ~= 'function' then return false, 'run must be a function' end
    if tool.input ~= nil and type(tool.input) ~= 'string' then
        return false, 'input must be a string describing the argument, or omitted'
    end
    if tool.available ~= nil and type(tool.available) ~= 'function' then
        return false, 'available must be a function, or omitted'
    end
    return true
end

local function registerTool(tool, origin)
    local ok, why = validTool(tool)
    if not ok then
        warn('ignoring a tool from ' .. origin .. ' -- ' .. why)
        return
    end
    if toolsById[tool.id] then
        warn("duplicate tool id '" .. tool.id .. "' from " .. origin .. ' ignored')
        return
    end
    toolsById[tool.id] = tool
    tools[#tools + 1] = tool
end

local function buildRegistry()
    tools, toolsById = {}, {}

    -- Built-ins first so an operator registering a long list of their own cannot push
    -- them past the tool ceiling in the bundle.
    for _, tool in ipairs(BUILTIN_TOOLS) do
        registerTool(tool, 'tRadioAI')
    end

    local hooks = incidentHooks()
    if hooks then
        for _, spec in ipairs(INCIDENT_TOOLS) do
            local handler = hooks[spec.key]
            if type(handler) == 'function' then
                registerTool({
                    id = spec.id,
                    description = spec.description,
                    input = spec.input,
                    run = handler,
                }, 'Config.incidents')
            end
        end
    end

    if type(Config.tools) ~= 'function' then return end
    local ok, custom = pcall(Config.tools)
    if not ok then
        warn('Config.tools threw -- ' .. tostring(custom))
        return
    end
    if type(custom) ~= 'table' then return end

    for _, tool in ipairs(custom) do
        registerTool(tool, 'Config.tools')
    end
end

-- Rebuild the registry. Call this from another resource after changing what Config.tools
-- returns; it is otherwise built once at startup.
wrap('refreshTools', function()
    buildRegistry()
    return #tools
end)

AddEventHandler('tradioai:nodeReady', buildRegistry)

-- ==================================================================
--  EXPORTS CONSUMED BY THE NODE BUNDLE
-- ==================================================================
--  Same-process export calls from server/lib/tools.ts. Never net-facing.

-- A tool that errors while deciding whether it applies is hidden for the turn rather
-- than offered: a tool too broken to answer that is too broken to run.
local function toolApplies(tool, ctx)
    if tool.available == nil then return true end

    local ok, result = pcall(tool.available, ctx)
    if not ok then
        warn("available() for '" .. tool.id .. "' threw -- " .. tostring(result))
        return false
    end
    return result ~= false
end

wrap('getTools', function(ctx)
    local context = type(ctx) == 'table' and ctx or {}
    local out = {}
    for _, tool in ipairs(tools) do
        if toolApplies(tool, context) then
            out[#out + 1] = {
                id = tool.id,
                description = tool.description,
                input = tool.input,
            }
        end
    end
    return out
end)

-- What the dispatcher knows about one unit, asked once per unit per turn while the
-- roster is built. Status comes from the store above; the note is free text from the
-- operator -- "on a traffic stop", "transporting one" -- and is the hook a CAD plugs into
-- so the dispatcher can see what a unit is already doing.
wrap('getUnitInfo', function(serverId)
    local id = tonumber(serverId)
    if not id then return nil end

    local note
    if type(Config.unitNote) == 'function' then
        local ok, result = pcall(Config.unitNote, id)
        if ok and type(result) == 'string' then
            note = result
        elseif not ok then
            warn('Config.unitNote threw -- ' .. tostring(result))
        end
    end

    local entry = unitStatus[id]
    return { status = entry and entry.value or nil, note = note }
end)

-- FiveM has no server-side street lookup, so where a 911 call came from is only knowable
-- to a server running postals or a CAD. Without the hook the dispatcher describes the call
-- without an address rather than reading out coordinates.
wrap('getLocation', function(coords)
    if type(Config.location) ~= 'function' or type(coords) ~= 'table' then return nil end

    local ok, result = pcall(Config.location, coords)
    if not ok then
        warn('Config.location threw -- ' .. tostring(result))
        return nil
    end
    return type(result) == 'string' and result or nil
end)

-- The server's own standing orders, layered under tRadioAI's rules rather than over them.
-- Asked per turn and given the whole context, so an operator can write different guidance
-- for a fire channel than for a police one, or add nothing at all -- which is the default.
local MAX_INSTRUCTION_LENGTH = 4000

wrap('getInstructions', function(ctx)
    if type(Config.instructions) ~= 'function' then return nil end

    local ok, result = pcall(Config.instructions, type(ctx) == 'table' and ctx or {})
    if not ok then
        warn('Config.instructions threw -- ' .. tostring(result))
        return nil
    end
    if type(result) ~= 'string' then return nil end
    return result:sub(1, MAX_INSTRUCTION_LENGTH)
end)

wrap('runTool', function(toolId, value, ctx)
    local tool = toolsById[toolId]
    if not tool then return { ok = false, message = 'that action is not available' } end

    local context = type(ctx) == 'table' and ctx or {}
    local ok, result, message = pcall(tool.run, context, value)
    if not ok then
        warn("tool '" .. tostring(toolId) .. "' threw -- " .. tostring(result))
        return { ok = false, message = 'that action failed' }
    end

    return {
        ok = result ~= false,
        message = type(message) == 'string' and message or (result ~= false and 'done' or 'that could not be done'),
    }
end)
