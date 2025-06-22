/**
 * Allows users to add Apitally to their AdonisJS application using the built-in Ace command.
 */

import type Configure from "@adonisjs/core/commands/configure";
import { stubsRoot } from "./stubs/main.js";

export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.makeUsingStub(stubsRoot, "config/apitally.stub", {});

  await codemods.registerMiddleware("router", [
    {
      path: "apitally/adonisjs/middleware",
    },
  ]);

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider("apitally/adonisjs/provider");
  });

  await codemods.defineEnvVariables({
    APITALLY_CLIENT_ID: "",
    APITALLY_ENV: "dev",
  });

  await codemods.defineEnvValidations({
    leadingComment: "Variables for configuring the apitally package",
    variables: {
      APITALLY_CLIENT_ID: "Env.schema.string()",
      APITALLY_ENV: "Env.schema.string.optional()",
    },
  });
}
