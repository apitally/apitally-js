import { createRequire } from "node:module";
import type {
  CallHandler,
  ExecutionContext,
  INestApplication,
  NestInterceptor,
} from "@nestjs/common";
import type { Express } from "express";
import type { FastifyInstance } from "fastify";
import type * as rxjs from "rxjs";
import type { ApitallyOptions } from "../config.js";
import { captureException } from "../exceptions.js";
import { installExpressAdapter } from "../express/adapter.js";
import { installFastifyAdapter } from "../fastify/adapter.js";
import { resolvePackageEntryPath, resolvePackageVersion } from "../packageVersion.js";

export type { ApitallyOptions };

const INTERCEPTOR_MARKER = Symbol.for("apitally.nestInterceptor");

export function useApitally(app: INestApplication, options?: ApitallyOptions): void {
  const httpAdapter = app.getHttpAdapter();
  const adapterType = httpAdapter.getType();
  const nativeInstance = httpAdapter.getInstance() as object;
  const startupIdentity = {
    framework: "nestjs",
    frameworkVersion: resolvePackageVersion("@nestjs/core"),
  };

  if (adapterType === "express") {
    installExpressAdapter(nativeInstance as Express, options, startupIdentity);
  } else if (adapterType === "fastify") {
    installFastifyAdapter(nativeInstance as FastifyInstance, options, startupIdentity);
  } else {
    throw new TypeError(
      `Unsupported NestJS HTTP adapter ${JSON.stringify(adapterType)}. Supported adapters: express and fastify.`,
    );
  }

  const markedInstance = nativeInstance as Record<symbol, boolean | undefined>;
  if (markedInstance[INTERCEPTOR_MARKER] !== true) {
    app.useGlobalInterceptors(createExceptionInterceptor());
    markedInstance[INTERCEPTOR_MARKER] = true;
  }
}

function createExceptionInterceptor(): NestInterceptor {
  const commonEntryPath = resolvePackageEntryPath("@nestjs/common");
  const { catchError, throwError } = createRequire(commonEntryPath)("rxjs") as Pick<
    typeof rxjs,
    "catchError" | "throwError"
  >;

  return {
    intercept(executionContext: ExecutionContext, next: CallHandler) {
      if (executionContext.getType() !== "http") {
        return next.handle();
      }
      return next.handle().pipe(
        catchError((exception: unknown) => {
          const status = getExceptionStatus(exception);
          if (status === undefined || status >= 500) {
            captureException(exception);
          }
          return throwError(() => exception);
        }),
      );
    },
  };
}

function getExceptionStatus(exception: unknown): number | undefined {
  if ((typeof exception !== "object" && typeof exception !== "function") || exception === null) {
    return undefined;
  }
  try {
    const candidate = exception as {
      getStatus?: () => unknown;
      status?: unknown;
      statusCode?: unknown;
    };
    if (typeof candidate.getStatus === "function") {
      const status = candidate.getStatus();
      return typeof status === "number" ? status : undefined;
    }
    if (typeof candidate.status === "number") {
      return candidate.status;
    }
    return typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
  } catch {
    return undefined;
  }
}
