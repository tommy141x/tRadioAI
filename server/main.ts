/**
 * Bundle entry. Everything that has to see the running server is wired here once.
 *
 * `tradioai:nodeReady` goes last: server/sv_config.lua answers it with the config
 * payload, and pushing earlier would be a lost event.
 */

import { emitBannerRows, registerDiagCommands } from "./lib/diag";
import { installDispatcher } from "./lib/index";

registerDiagCommands();
installDispatcher();
emit("tradioai:nodeReady");
emitBannerRows();
