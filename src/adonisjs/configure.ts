import { fileURLToPath } from "node:url";

import type Configure from "@adonisjs/core/commands/configure";

import { DEFAULT_ENV, isValidWriteToken } from "../config.js";

const STUBS_ROOT = fileURLToPath(new URL("./stubs/", import.meta.url));
const ENV_FORMAT = /^[a-z0-9-]{1,32}$/;

export async function configure(command: Configure): Promise<void> {
  const writeToken = await command.prompt.ask("Apitally write token", {
    result: (value) => value.trim(),
    validate: (value) => isValidWriteToken(value.trim()),
  });
  const env = await command.prompt.ask("Environment", {
    default: DEFAULT_ENV,
    result: normalizeEnv,
    validate: (value) => ENV_FORMAT.test(normalizeEnv(value)),
  });
  const captureRequestHeaders = await command.prompt.confirm("Capture request headers?", {
    default: false,
  });
  const captureRequestBody = await command.prompt.confirm("Capture request bodies?", {
    default: false,
  });
  const captureResponseBody = await command.prompt.confirm("Capture response bodies?", {
    default: false,
  });

  const codemods = await command.createCodemods();
  await codemods.makeUsingStub(STUBS_ROOT, "config/apitally.stub", {
    captureRequestHeaders,
    captureRequestBody,
    captureResponseBody,
  });
  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider("apitally/adonisjs/provider");
  });
  await codemods.registerMiddleware("server", [{ path: "apitally/adonisjs/middleware" }]);
  await codemods.defineEnvVariables({
    APITALLY_WRITE_TOKEN: writeToken,
    APITALLY_ENV: env,
  });
  await codemods.defineEnvValidations({
    variables: {
      APITALLY_WRITE_TOKEN: "Env.schema.string()",
      APITALLY_ENV: "Env.schema.string()",
    },
  });
  await updateExceptionHandler(codemods, command);
}

function normalizeEnv(value: string): string {
  return value.trim().toLowerCase().replace(/[ _]/g, "-");
}

async function updateExceptionHandler(
  codemods: Awaited<ReturnType<Configure["createCodemods"]>>,
  command: Configure,
): Promise<void> {
  const project = await codemods.getTsMorphProject();
  const handlerPath = command.app.makePath("app/exceptions/handler.ts");
  const sourceFile =
    project?.getSourceFile(handlerPath) ?? project?.addSourceFileAtPathIfExists(handlerPath);
  const handlerClass = sourceFile
    ?.getClasses()
    .find((candidate: { isDefaultExport: () => boolean }) => candidate.isDefaultExport());
  const method = handlerClass?.getMethod("handle");
  if (method) {
    const alreadyConfigured = method
      .getDescendants()
      .some((node: { getKindName: () => string }) => {
        if (node.getKindName() !== "CallExpression") {
          return false;
        }
        return (
          (node as typeof node & { getExpression: () => { getText: () => string } })
            .getExpression()
            .getText() === "captureException"
        );
      });
    if (alreadyConfigured) {
      return;
    }

    const parameters = method.getParameters();
    const statements = method.getStatements();
    const statement = statements[0];
    if (
      method.isAsync() &&
      parameters.length >= 2 &&
      statements.length === 1 &&
      statement?.getKindName() === "ReturnStatement"
    ) {
      const returnExpression = (
        statement as typeof statement & {
          getExpression: () =>
            | {
                getArguments: () => Array<{ getText: () => string }>;
                getExpression: () => { getText: () => string };
                getKindName: () => string;
              }
            | undefined;
        }
      ).getExpression();
      const errorName = parameters[0].getName();
      const contextName = parameters[1].getName();
      if (
        returnExpression?.getKindName() === "CallExpression" &&
        returnExpression.getExpression().getText() === "super.handle" &&
        returnExpression
          .getArguments()
          .map((argument: { getText: () => string }) => argument.getText())
          .join(",") === `${errorName},${contextName}`
      ) {
        const importDeclaration = sourceFile?.getImportDeclaration(
          (candidate: { getModuleSpecifierValue: () => string }) =>
            candidate.getModuleSpecifierValue() === "apitally",
        );
        if (importDeclaration) {
          if (
            !importDeclaration
              .getNamedImports()
              .some(
                (namedImport: { getName: () => string }) =>
                  namedImport.getName() === "captureException",
              )
          ) {
            importDeclaration.addNamedImport("captureException");
          }
        } else {
          sourceFile?.addImportDeclaration({
            moduleSpecifier: "apitally",
            namedImports: ["captureException"],
          });
        }
        method.setBodyText(
          `const result = await super.handle(${errorName}, ${contextName})\n` +
            `if (${contextName}.response.getStatus() >= 500) {\n` +
            `  captureException(${errorName})\n` +
            `}\n` +
            `return result`,
        );
        await sourceFile?.save();
        return;
      }
    }
  }

  command.logger.warning(
    'Could not update "app/exceptions/handler.ts" automatically. Add the following import and method:',
  );
  command.logger.info(
    'import { captureException } from "apitally"\n\n' +
      "async handle(error: unknown, ctx: HttpContext) {\n" +
      "  const result = await super.handle(error, ctx)\n" +
      "  if (ctx.response.getStatus() >= 500) {\n" +
      "    captureException(error)\n" +
      "  }\n" +
      "  return result\n" +
      "}",
  );
}
