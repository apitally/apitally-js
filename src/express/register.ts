import { createRequire } from "node:module";
import { logDebug } from "../logger.js";
import { resolvePackageEntryPath } from "../packageVersion.js";
import { installRouteCaptureFromExpress } from "./routes.js";

// Import before application modules so shared Express router prototypes capture
// routes registered at module scope.
let expressModule: unknown;
try {
  const entryPath = resolvePackageEntryPath("express");
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
