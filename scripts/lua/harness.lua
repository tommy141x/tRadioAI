-- Shared plumbing for the Lua suites in scripts/tests: host stubs, an assertion
-- collector, and the negative-control protocol.
--
-- Loaded with dofile from each suite, run from the resource root. Deliberately thin:
-- a suite loads the files it is an oracle for itself, because WHICH files it needs, and
-- what has to exist before they load (`Config`, `tlib`), is part of what it asserts.
--
-- ## The control protocol
--
-- A suite whose assertions are mostly negative ("a bad tool is ignored", "a key is never
-- echoed") passes just as happily when the code path under test is dead. So every
-- negative assertion is registered with `neg`, and the suite is run a second time with
-- `<NAME>_CONTROL=1`, in which it feeds each of them the input that MUST be accepted.
-- `finish()` then requires every registered negative to have FAILED and prints
-- `CONTROL OK`, still exiting 1 — scripts/test-lua.ts reads the marker as well as the
-- status, because a control that did not flip also exits 1.

local H = {}

local realPrint = print
H.realPrint = realPrint

local failures = {}
local failed = {}
local negatives = {}
H.logged = {}

--- `root .. '/' .. p`, for the suite's own location.
function H.root()
    local source = debug.getinfo(2, 'S').source:sub(2):gsub('\\', '/')
    local root = source:match('^(.*)/scripts/tests/[^/]+$')
    if root == nil or root == '' then root = '.' end
    return function(p) return root .. '/' .. p end
end

function H.check(ok, label)
    if not ok then
        failures[#failures + 1] = label
        failed[label] = true
    end
end

--- A negative assertion: it holds only because something was refused or absent.
function H.neg(ok, label)
    negatives[#negatives + 1] = label
    H.check(ok, label)
end

--- Capture `print` for the duration of a call and hand back the lines.
function H.capture(fn)
    local lines = {}
    local previous = print
    print = function(...)
        local parts = {}
        for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
        lines[#lines + 1] = table.concat(parts, '\t')
    end
    local ok, err = pcall(fn)
    print = previous
    if not ok then error(err, 0) end
    return lines
end

--- Swallow `print` for the rest of the suite and hand back the lines. The resource files
--- warn about the broken hooks a suite plants on purpose, and that is noise in a pass.
function H.silence()
    local lines = H.logged
    print = function(...)
        local parts = {}
        for i = 1, select('#', ...) do parts[#parts + 1] = tostring((select(i, ...))) end
        lines[#lines + 1] = table.concat(parts, '	')
    end
    return lines
end

--- A host: `exports` table, event handlers, and the globals the resource files touch.
function H.host()
    local host = { exports = {}, handlers = {}, fired = {}, metadata = {} }

    _G.GetCurrentResourceName = function() return 'tRadioAI' end
    _G.GetResourceMetadata = function(_, key) return host.metadata[key] end
    _G.tlib = {
        platform = {
            wrapExport = function(_, name, fn)
                host.exports[name] = fn
                return fn
            end,
        },
        versioncheck = setmetatable({
            github = function() return function() end end,
        }, {
            __call = function(_, opts)
                host.versioncheck = opts
            end,
        }),
    }

    _G.AddEventHandler = function(name, fn)
        host.handlers[name] = host.handlers[name] or {}
        table.insert(host.handlers[name], fn)
    end

    _G.TriggerEvent = function(name, ...)
        host.fired[#host.fired + 1] = { name = name, args = { ... } }
        for _, fn in ipairs(host.handlers[name] or {}) do fn(...) end
    end

    function host.firedEvents(name)
        local out = {}
        for _, event in ipairs(host.fired) do
            if event.name == name then out[#out + 1] = event end
        end
        return out
    end

    return host
end

--- The end of a suite. Exits non-zero on failure, and under control on purpose.
function H.finish(name, controlEnv)
    local control = os.getenv(controlEnv) == '1'

    if control then
        local missing = {}
        for _, label in ipairs(negatives) do
            if not failed[label] then missing[#missing + 1] = label end
        end
        if #missing > 0 then
            realPrint('CONTROL FAILED: these negative assertions still held against accepted input:')
            for _, label in ipairs(missing) do realPrint('  ' .. label) end
            os.exit(1)
        end
        realPrint(('CONTROL OK: all %d negative assertions flipped'):format(#negatives))
        os.exit(1)
    end

    if #failures > 0 then
        for _, label in ipairs(failures) do realPrint('FAIL: ' .. label) end
        realPrint(('%s: %d assertion(s) failed'):format(name, #failures))
        os.exit(1)
    end
    realPrint(name .. ': ok')
end

return H
