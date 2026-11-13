-- tRadioAI: the startup banner and update check, through tLib's versioncheck.
--
-- Wrapped: a banner is not worth a resource that fails to start, and `tlib.versioncheck`
-- is tLib's to change.

local resource = GetCurrentResourceName()

local ok, err = pcall(function()
    tlib.versioncheck({
        name = 'tRadioAI',
        current = GetResourceMetadata(resource, 'version', 0),
        author = 'tommy141x',
        fetch = tlib.versioncheck.github('tommy141x/tRadioAI'),
        info = {
            -- Absent on a source checkout; only the release build writes it. It is what
            -- tells two zips of one version apart. An empty value is skipped by the box.
            { key = 'Build', value = GetResourceMetadata(resource, 'tlib_build', 0) },
            -- Filled by the bundle once it has asked tRadio what it offers.
            { key = 'tRadio', event = 'tradioai:vcInfo:tradio' },
            { key = 'Engines', event = 'tradioai:vcInfo:engines' },
        },
    })
end)

if not ok then
    print(('^3[tRadioAI] version check unavailable: %s^0'):format(tostring(err)))
end
