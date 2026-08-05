import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { Codemods } from "@adonisjs/core/ace/codemods";
import { AppFactory } from "@adonisjs/core/factories/app";
import type { ApplicationService } from "@adonisjs/core/types";
import { cliui } from "@poppinss/cliui";
import { describe, expect, it, vi } from "vitest";

import { configure } from "../../src/index.js";
import { WRITE_TOKEN } from "../utils.js";

const RC_CONTENTS = `import { defineConfig } from "@adonisjs/core/app"

export default defineConfig({
  providers: [() => import("@adonisjs/core/providers/app_provider")],
  preloads: [() => import("#start/kernel")],
})
`;

const KERNEL_CONTENTS = `import server from "@adonisjs/core/services/server"

server.use([])
`;

const ENV_CONTENTS = `import { Env } from "@adonisjs/core/env"

export default await Env.create(new URL("../", import.meta.url), {
  NODE_ENV: Env.schema.enum(["development", "production", "test"] as const),
})
`;

const HANDLER_CONTENTS = `import { ExceptionHandler, type HttpContext } from "@adonisjs/core/http"

export default class HttpExceptionHandler extends ExceptionHandler {
  async handle(error: unknown, ctx: HttpContext) {
    return super.handle(error, ctx)
  }
}
`;

describe("adonisjs configure", () => {
  it("configures a conventional application once with the selected capture options", async () => {
    const projectRoot = await mkdtemp(join(process.cwd(), ".tmp-adonis-configure-"));
    try {
      await writeProject(projectRoot);
      const app = new AppFactory().create(pathToFileURL(`${projectRoot}/`)) as ApplicationService;
      await app.init();

      await configure(createCommand(app));
      await configure(createCommand(app));

      const [config, rcFile, kernel, envFile, envExample, envSchema, handler] = await Promise.all([
        readFile(join(projectRoot, "config/apitally.ts"), "utf8"),
        readFile(join(projectRoot, "adonisrc.ts"), "utf8"),
        readFile(join(projectRoot, "start/kernel.ts"), "utf8"),
        readFile(join(projectRoot, ".env"), "utf8"),
        readFile(join(projectRoot, ".env.example"), "utf8"),
        readFile(join(projectRoot, "start/env.ts"), "utf8"),
        readFile(join(projectRoot, "app/exceptions/handler.ts"), "utf8"),
      ]);

      expect(config).toContain("writeToken: env.get('APITALLY_WRITE_TOKEN')");
      expect(config).toContain("env: env.get('APITALLY_ENV')");
      expect(config).toContain("captureRequestHeaders: true");
      expect(config).not.toContain("captureRequestBody:");
      expect(config).toContain("captureResponseBody: true");
      expect(config).not.toContain("captureResponseHeaders:");
      expect(count(rcFile, "apitally/adonisjs/provider")).toBe(1);
      expect(count(kernel, "apitally/adonisjs/middleware")).toBe(1);
      expect(envFile).toContain(`APITALLY_WRITE_TOKEN=${WRITE_TOKEN}`);
      expect(envFile).toContain("APITALLY_ENV=prod-us");
      expect(envExample).toContain(`APITALLY_WRITE_TOKEN=${WRITE_TOKEN}`);
      expect(envExample).toContain("APITALLY_ENV=prod-us");
      expect(count(envSchema, "APITALLY_WRITE_TOKEN: Env.schema.string()")).toBe(1);
      expect(count(envSchema, "APITALLY_ENV: Env.schema.string()")).toBe(1);
      expect(handler).toMatch(/import \{ captureException \} from ["']apitally["']/);
      expect(count(handler, "captureException(error)")).toBe(1);
      expect(handler.indexOf("await super.handle(error, ctx)")).toBeLessThan(
        handler.indexOf("captureException(error)"),
      );
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

function createCommand(app: ApplicationService): unknown {
  const ui = cliui();
  ui.switchMode("silent");
  const askAnswers = [` ${WRITE_TOKEN} `, "Prod US"];
  const confirmAnswers = [true, false, true];
  return {
    app,
    prompt: {
      ask: vi.fn(async (_title: string, options?: PromptOptions<string>) => {
        const answer = askAnswers.shift() ?? "";
        expect(await options?.validate?.(answer)).not.toBe(false);
        return options?.result ? options.result(answer) : answer;
      }),
      confirm: vi.fn(async () => confirmAnswers.shift() ?? false),
    },
    createCodemods: async () => new Codemods(app, ui.logger),
    logger: ui.logger,
  };
}

interface PromptOptions<T> {
  result?: (value: string) => T | Promise<T>;
  validate?: (value: T) => boolean | string | Promise<boolean | string>;
}

async function writeProject(projectRoot: string): Promise<void> {
  await Promise.all([
    mkdir(join(projectRoot, "app/exceptions"), { recursive: true }),
    mkdir(join(projectRoot, "start"), { recursive: true }),
    mkdir(join(projectRoot, "config"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      join(projectRoot, "package.json"),
      JSON.stringify({
        name: "configure-fixture",
        private: true,
        type: "module",
        imports: { "#start/*": "./start/*.js" },
      }),
    ),
    writeFile(
      join(projectRoot, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
        },
        include: ["**/*.ts"],
      }),
    ),
    writeFile(join(projectRoot, "adonisrc.ts"), RC_CONTENTS),
    writeFile(join(projectRoot, "start/kernel.ts"), KERNEL_CONTENTS),
    writeFile(join(projectRoot, "start/env.ts"), ENV_CONTENTS),
    writeFile(join(projectRoot, "app/exceptions/handler.ts"), HANDLER_CONTENTS),
    writeFile(join(projectRoot, ".env"), ""),
    writeFile(join(projectRoot, ".env.example"), ""),
  ]);
}

function count(value: string, search: string): number {
  return value.split(search).length - 1;
}
