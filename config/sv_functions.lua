-- tRadioAI: your hooks. Overwritten on update, like config.lua: merge your own forward.
--
-- Nothing here is required. Each hook is optional and off by default.

-- Extra tools, offered to the model alongside the built-in ones. Return a list of
--   { id = 'tow_request', description = 'a unit needs a tow',
--     input = 'where the vehicle is',                 -- omit for a tool with no argument
--     available = function(ctx) return true end,      -- optional: hide it this turn
--     run = function(ctx, input) return true, 'tow requested' end }
-- `run` returns ok, message -- and the message is read back to the unit on the air, so
-- write it as a reason ("the CAD is offline"), not an error code.
--
-- `ctx` is what the dispatcher knows about the turn:
--   trigger    'transmission' | 'call' | 'call_intake'
--   serverId, callsign, unitId       the unit that keyed up (0 / '' on a call turn)
--   frequency, channelName           where it is happening
--   transcript                       what the unit said
--   roster     units on the channel, nearest first:
--              { serverId, callsign, unitId, status, note, distance, talking }
--   history    recent traffic: { who, text, own }
--   waiting    callsigns that called while the dispatcher was mid-turn
--   channels   every channel: { frequency, name, zone, monitored, units, alert, patchedWith }
--   call       on a call turn: { id, source, caller, message, location, priority, service }
Config.tools = function()
    return {}
end

-- Incident tools, offered only for the functions you supply. tRadioAI keeps no incident
-- store of its own: a server that has calls already has them in its CAD.
-- Return a table with any of create / attach / clear / close, each function(ctx, input).
Config.incidents = nil

-- What a CAD says a unit is doing, as free text: 'on a traffic stop'. Shown to the model
-- beside the unit's last status.
Config.unitNote = nil -- function(serverId) return 'on a traffic stop' end

-- A street or postal for a 911 caller's coordinates. FiveM has no server-side street
-- lookup, so without this the dispatcher describes the call without an address rather
-- than reading out coordinates.
Config.location = nil -- function(coords) return 'Elgin Avenue and Vespucci Boulevard' end

-- Standing orders for your dispatcher, layered under tRadioAI's own rules. Asked every
-- turn with the same `ctx`, so a fire channel can get different guidance from a police
-- one. Up to 4000 characters; return nil to add nothing.
Config.instructions = nil -- function(ctx) return 'Units on OPS-2 are fire, not police.' end
