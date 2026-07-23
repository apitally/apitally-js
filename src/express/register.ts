import { createRequire } from "node:module";
import { peerResolver } from "../logCapture.js";
import { logDebug } from "../logger.js";
import { installRouteCaptureFromExpress } from "./routes.js";

// Side-effect entry, imported on the first line of the application's entry
// module: it installs the route registration capture on the shared router
// prototype before any user module registers a route, so routers assembled at
// module scope export full route templates.

let expressModule: unknown;
try {
  const entryPath = peerResolver.resolveEntryPath("express");
  expressModule = createRequire(entryPath)(entryPath);
} catch {
  // express is not installed; the register entry is a silent no-op
  expressModule = undefined;
}
if (expressModule !== undefined) {
  try {
    installRouteCaptureFromExpress(expressModule);
  } catch (error) {
    logDebug(`Error installing the express route capture: ${String(error)}`);
  }
}
