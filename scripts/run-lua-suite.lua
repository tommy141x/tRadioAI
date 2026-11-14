-- Entry point for every Lua suite under scripts/tests, run from the resource root:
--   bunx --bun fengari scripts/run-lua-suite.lua scripts/tests/<suite>.lua
--
-- ⛔ IT EXISTS FOR ONE MEASURED REASON: fengari's CLI can print an unhandled Lua
-- error and still exit ZERO, so a suite that blew up on its first line would be
-- reported as a pass. Every suite exception becomes a non-zero exit here instead.
-- Proven rather than asserted — `bun run test:lua:control` drives
-- scripts/controls/lua-throws.lua, a suite whose first statement raises, and
-- requires a non-zero exit.
--
-- ⚠️ COPIED FROM tCAD, NOT FROM tLib, AND THAT CHOICE IS LOAD-BEARING.
-- `realPrint` is bound HERE, at load, before any suite can run — not resolved
-- at the moment of failure. tLib's, tDetector's and tRadar's runners end with a
-- bare `print(err)`, which resolves the global AS IT IS THEN. Every suite in
-- this directory replaces `print` to read back what the code under test logged
-- (the whole of scripts/tests/diag.lua is about printed output), so with those
-- runners a suite that fails WHILE its capture is installed has its own failure
-- message captured instead of printed: exit 1 with ZERO output, which is the
-- right exit code and no way at all to tell what went wrong. tLib's runner
-- still has that flaw and tests/lua/diag-command.lua works around it per-suite;
-- nothing here has to, because the runner is correct.
--
-- Deliberately thin. A suite loads the files it is an oracle for itself, with
-- its own host stubs, because WHICH files a suite needs — and what has to exist
-- before they load, like `Config` and the `log()` global from shared/sh_utils.lua —
-- is part of what the suite is asserting. fxmanifest.lua's load order is
-- load-bearing in this resource (server/sv_config_check.lua's header says so:
-- it must run after config/config.lua and before everything that reads Config),
-- and a runner that pre-loaded the tree would be deciding that for the suite.
local realPrint = print

local ok, err = xpcall(function()
    dofile(assert(arg[1], 'Suite path required'))
end, debug.traceback)
if not ok then realPrint(err); os.exit(1) end
