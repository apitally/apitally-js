/**
 * Allows users to add Apitally to their AdonisJS application using the built-in Ace command.
 */

import type Configure from "@adonisjs/core/commands/configure";
import { fileURLToPath } from "url";

import { isValidClientId, isValidEnv } from "../common/paramValidation.js";

const STUBS_ROOT = fileURLToPath(new URL("./stubs/", import.meta.url));

export async function configure(command: Configure) {
  const clientId = await command.prompt.ask("Apitally client ID", {
    result(value) {
      return value.trim().toLowerCase();
    },
    validate(value) {
      return isValidClientId(value);
    },
  });
  const env = await command.prompt.ask("Environment name", {
    default: "dev",
    result(value) {
      return value
        .trim()
        .toLowerCase()
        .replaceAll("_", "-")
        .replaceAll(" ", "-");
    },
    validate(value) {
      return isValidEnv(value);
    },
  });

  const codemods = await command.createCodemods();

  await codemods.makeUsingStub(STUBS_ROOT, "config/apitally.stub", {});

  await codemods.registerMiddleware("router", [
    {
      path: "apitally/adonisjs/middleware",
    },
  ]);

  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider("apitally/adonisjs/provider");
  });

  await codemods.defineEnvVariables({
    APITALLY_CLIENT_ID: clientId,
    APITALLY_ENV: env,
  });

  await codemods.defineEnvValidations({
    leadingComment: "Variables for configuring the apitally package",
    variables: {
      APITALLY_CLIENT_ID: "Env.schema.string()",
      APITALLY_ENV: "Env.schema.string.optional()",
    },
  });
}
