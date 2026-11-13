-- The script order below is load-bearing: server/sv_config.lua and server/sv_tools.lua
-- read `Config`, so config/ has to load first.

fx_version 'cerulean'
game 'gta5'

name 'tRadioAI'
description 'An AI dispatcher for tRadio'
author 'Tommy Johnston'
version '0.1.0'
license 'MIT'
repository 'https://github.com/tommy141x/tRadioAI'

lua54 'yes'
node_version '22'

-- Needs a tLib new enough for the spawn catalogue entry that names this resource
-- (the local engine) and for `tlib.platform.wrapExport`.
tlib_min_version '1.2.0'

dependencies {
    'tLib',
    'tRadio',
}

shared_scripts {
    '@tLib/imports.lua',
}

server_scripts {
    'config/config.lua',
    'config/sv_functions.lua',
    'server/sv_config.lua',
    'server/sv_tools.lua',
    'server/sv_version.lua',
    'server/dist/bundle.js',
}

-- Not `files`: nothing here is streamed to a client. The pinned download list and the
-- engine binaries are read by the server only.
