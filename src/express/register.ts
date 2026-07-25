import { createRequire } from "node:module";
import { resolvePeerEntryPath } from "../logCapture.js";
import { logDebug } from "../logger.js";
import { installRouteCaptureFromExpress } from "./routes.js";

// Import before application modules so shared Express router prototypes capture
// routes registered at module scope.
let expressModule: unknown;
try {
  const entryPath = resolvePeerEntryPath("express");
  expressModule = createRequire(entryPath)(entryPath);
} catch {
  expressModule = undefined;
}
if (expressModule !== undefined) {
  try {
    installRouteCaptureFromExpress(expressModule);
  } catch (error) {
    logDebug(`Error installing the express route capture: ${String(error)}`);
  }
}
