import {
  CallHandler,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError } from "rxjs";

import type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
export type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";

let setConsumerFn:
  | ((
      request: any,
      consumer: ApitallyConsumer | string | null | undefined,
    ) => void)
  | null = null;

export async function useApitally(
  app: INestApplication,
  config: ApitallyConfig,
) {
  const httpAdapter = app.getHttpAdapter();
  const instance = httpAdapter.getInstance();

  const platform =
    instance.use === undefined && typeof instance.register === "function"
      ? "fastify"
      : "express";

  if (platform === "express") {
    const { useApitally, setConsumer } = await import("../express/index.js");
    setConsumerFn = setConsumer;
    useApitally(instance, config);
  } else if (platform === "fastify") {
    const { apitallyPlugin, setConsumer } = await import("../fastify/index.js");
    setConsumerFn = setConsumer;
    await instance.register(apitallyPlugin, config);
  }

  app.useGlobalInterceptors(new ApitallyInterceptor(platform));
}

export function setConsumer(
  request: any,
  consumer: ApitallyConsumer | string | null | undefined,
) {
  if (setConsumerFn) {
    setConsumerFn(request, consumer);
  }
}

@Injectable()
class ApitallyInterceptor implements NestInterceptor {
  constructor(private readonly platform: "express" | "fastify") {}

  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((exception) => {
        if (context.getType() === "http") {
          const ctx = context.switchToHttp();
          const res = ctx.getResponse();

          if (this.platform === "express" && res.locals) {
            res.locals.serverError = exception;
          } else if (
            this.platform === "fastify" &&
            (!exception.statusCode || exception.statusCode === 500)
          ) {
            res.serverError = exception;
          }
        }
        return throwError(() => exception);
      }),
    );
  }
}
