-- Oracle for server/sv_tools.lua: the tool registry, the built-in unit status, and the
-- exports the Node bundle reads.
--
-- Most of what this file holds down is a REFUSAL — a malformed tool never reaches the
-- model, a throwing hook never reaches the radio — and a refusal is exactly what a dead
-- code path also looks like. Each negative assertion is registered with `neg`, and
-- `TOOLS_CONTROL=1` runs the suite again feeding every one of them the input that must be
-- ACCEPTED; they must all stop holding (see scripts/lua/harness.lua).

local root = (function()
    local source = debug.getinfo(1, 'S').source:sub(2):gsub('\\', '/')
    local found = source:match('^(.*)/scripts/tests/tools%.lua$')
    if found == nil or found == '' then found = '.' end
    return function(p) return found .. '/' .. p end
end)()

local H = dofile(root('scripts/lua/harness.lua'))
local check, neg = H.check, H.neg
local CONTROL = os.getenv('TOOLS_CONTROL') == '1'

local host = H.host()
local logged = H.silence()
_G.source = nil

-- ── What the operator wrote ─────────────────────────────────────────────────
local hookCalls = { tools = 0 }
local throwingHook = false

_G.Config = {
    tools = function()
        hookCalls.tools = hookCalls.tools + 1
        if throwingHook then error('boom') end
        return {
            { id = 'tow_request', description = 'a unit needs a tow', input = 'where',
              run = function(_, input) return true, 'tow sent to ' .. tostring(input) end },
            -- Each of these is malformed. Under CONTROL they are made valid instead.
            { id = CONTROL and 'bad_one' or 'Bad Id', description = 'x', run = function() return true end },
            { id = 'no_description', description = CONTROL and 'now it has one' or '',
              run = function() return true end },
            { id = 'no_run', description = 'x', run = CONTROL and function() return true end or nil },
            { id = 'bad_input', description = 'x', input = CONTROL and 'a string' or 42,
              run = function() return true end },
            { id = 'bad_available', description = 'x',
              available = CONTROL and function() return true end or 'yes',
              run = function() return true end },
            -- A duplicate of a built-in id, which must lose.
            { id = 'unit_status', description = 'an impostor', run = function() return false, 'nope' end },
            { id = 'sometimes', description = 'offered only for the fire channel', input = '',
              available = function(ctx) return ctx.channelName == 'FIRE' end,
              run = function() return true end },
            { id = 'broken_available', description = 'x',
              available = function()
                  if CONTROL then return true end
                  error('available blew up')
              end,
              run = function() return true end },
            { id = 'throws', description = 'x',
              run = function() error('run blew up') end },
            { id = 'refuses', description = 'x',
              run = function() return false, 'the CAD is offline' end },
            { id = 'silent_true', description = 'x', run = function() return true end },
            { id = 'silent_false', description = 'x', run = function() return false end },
        }
    end,
    incidents = function()
        local hooks = { create = function() return true, 'call opened' end }
        if CONTROL then
            hooks.attach = hooks.create
            hooks.clear = hooks.create
            hooks.close = hooks.create
        end
        return hooks
    end,
    unitNote = function(serverId)
        if serverId == 9 then error('note blew up') end
        return 'on a traffic stop'
    end,
    location = function(coords)
        if coords.x == 0 then error('location blew up') end
        return 'Elgin Avenue'
    end,
    instructions = function(ctx)
        if ctx.channelName == 'LONG' then return string.rep('x', 5000) end
        if ctx.channelName == 'BAD' then return 42 end
        return 'Units on OPS-2 are fire.'
    end,
}

dofile(root('server/sv_tools.lua'))
for _, fn in ipairs(host.handlers['tradioai:nodeReady'] or {}) do fn() end

local function toolIds(ctx)
    local ids = {}
    for _, tool in ipairs(host.exports.getTools(ctx or { channelName = 'DISP' })) do
        ids[#ids + 1] = tool.id
    end
    return ids
end

local function has(ids, id)
    for _, candidate in ipairs(ids) do if candidate == id then return true end end
    return false
end

local ids = toolIds()

-- ── Registry ────────────────────────────────────────────────────────────────
check(ids[1] == 'unit_status', 'the built-in comes first, so a long operator list cannot push it past the ceiling')
check(has(ids, 'tow_request'), 'a valid operator tool is offered')
check(has(ids, 'create_call'), 'an incident hook the operator supplied becomes a tool')
neg(not has(ids, 'close_call') and not has(ids, 'attach_unit') and not has(ids, 'clear_unit'),
    'an incident hook the operator did not supply is not offered')
neg(not has(ids, 'Bad Id') and not has(ids, 'bad_one'), 'a tool whose id has a space or capital is ignored')
neg(not has(ids, 'no_description'), 'a tool with no description is ignored')
neg(not has(ids, 'no_run'), 'a tool with no run function is ignored')
neg(not has(ids, 'bad_input'), 'a tool whose input is not a string is ignored')
neg(not has(ids, 'bad_available'), 'a tool whose available is not a function is ignored')

local impostors = 0
for _, tool in ipairs(host.exports.getTools({})) do
    if tool.id == 'unit_status' then impostors = impostors + 1 end
end
check(impostors == 1, 'a duplicate of a built-in id loses: exactly one unit_status')
check(host.exports.getTools({})[1].description:find('status', 1, true) ~= nil, 'the surviving unit_status is the built-in')

local said = table.concat(logged, '\n')
neg(said:find('ignoring a tool from Config.tools', 1, true) ~= nil,
    'a rejected tool is named in the console, with its reason')
check(said:find("duplicate tool id 'unit_status'", 1, true) ~= nil, 'a duplicate id is reported')

-- ── availability ────────────────────────────────────────────────────────────
check(not has(toolIds({ channelName = 'DISP' }), 'sometimes'), 'available() hides a tool this turn')
check(has(toolIds({ channelName = 'FIRE' }), 'sometimes'), 'and offers it when it applies')
neg(not has(toolIds(), 'broken_available'), 'a tool whose available() throws is hidden, not offered')

-- ── running ─────────────────────────────────────────────────────────────────
local function run(id, input, ctx) return host.exports.runTool(id, input, ctx or {}) end

local towed = run('tow_request', 'Elgin and Vespucci')
check(towed.ok == true and towed.message == 'tow sent to Elgin and Vespucci', 'run reads back ok and its message')

local refused = run('refuses', '')
check(refused.ok == false and refused.message == 'the CAD is offline', 'a refusal carries its reason to be said on the air')

local threw = run(CONTROL and 'silent_true' or 'throws', '')
neg(threw.ok == false and threw.message == 'that action failed', 'a tool that throws is a failed action, never an error to the caller')

neg(run(CONTROL and 'tow_request' or 'not_a_tool', '').ok == false, 'an undeclared tool id is refused')
check(run('silent_true', '').message == 'done', 'ok with no message says done')
check(run('silent_false', '').message == 'that could not be done', 'not ok with no message says so')

-- ── unit status ─────────────────────────────────────────────────────────────
local ctx = { serverId = 7, callsign = 'King 41' }
local set = run('unit_status', '  10-8. ', ctx)
check(set.ok == true and set.message == 'King 41 is now showing 10-8', 'unit_status trims and drops transcription punctuation')
check(host.exports.getUnitStatus(7).value == '10-8', 'the status is readable through the export')
local events = host.firedEvents('tradioai:unitStatusChanged')
check(#events == 1 and events[1].args[1] == 7 and events[1].args[2] == '10-8', 'a status change fires tradioai:unitStatusChanged(serverId, status)')

neg(run('unit_status', CONTROL and '10-8' or '', ctx).ok == false, 'an empty status is refused')
neg(run('unit_status', string.rep('x', CONTROL and 10 or 49), ctx).ok == false, 'a status longer than 48 characters is refused')
neg(run('unit_status', '10-6', { serverId = CONTROL and 7 or 0 }).ok == false, 'a status for no unit is refused')
neg(host.exports.getUnitStatus(CONTROL and 7 or 0) == nil, 'there is no status for server id 0')

check(host.exports.setUnitStatus(7, '10-97') == true and host.exports.getUnitStatus(7).value == '10-97', 'another resource can set a status')
neg(host.exports.setUnitStatus(CONTROL and 7 or -3, '10-97') == false, 'a status cannot be set for a negative id (a dispatcher console)')

_G.source = CONTROL and 8 or 7
for _, fn in ipairs(host.handlers['playerDropped']) do fn() end
neg(host.exports.getUnitStatus(7) == nil, 'a player who disconnects is back in service')
_G.source = nil

-- ── hooks the bundle reads ──────────────────────────────────────────────────
local info = host.exports.getUnitInfo(7)
check(info.note == 'on a traffic stop' and info.status == nil, 'getUnitInfo carries the operator note')
check(host.exports.getUnitInfo(9).note == nil, 'a unitNote that throws is no note, not an error')
check(host.exports.getUnitInfo('x') == nil, 'getUnitInfo of a non-number is nothing')

check(host.exports.getLocation({ x = 1, y = 2 }) == 'Elgin Avenue', 'getLocation returns the operator street')
neg(host.exports.getLocation({ x = CONTROL and 1 or 0, y = 0 }) == nil, 'a location hook that throws is no address, so no coordinates are read out')
neg(host.exports.getLocation(CONTROL and { x = 1 } or 'not coords') == nil, 'getLocation of a non-table is nothing')

check(host.exports.getInstructions({ channelName = 'DISP' }) == 'Units on OPS-2 are fire.', 'getInstructions returns standing orders')
check(#host.exports.getInstructions({ channelName = 'LONG' }) == 4000, 'instructions are capped at 4000 characters')
neg(host.exports.getInstructions({ channelName = CONTROL and 'DISP' or 'BAD' }) == nil, 'instructions that are not a string are nothing')

-- ── refresh ─────────────────────────────────────────────────────────────────
local before = hookCalls.tools
local count = host.exports.refreshTools()
check(hookCalls.tools == before + 1 and count >= #host.exports.getTools({}), 'refreshTools rebuilds and returns how many tools are registered')

throwingHook = true
host.exports.refreshTools()
check(#toolIds() >= 1 and ids[1] == 'unit_status', 'a Config.tools that throws leaves the built-ins in place')
throwingHook = false

H.finish('tools.lua', 'TOOLS_CONTROL')
