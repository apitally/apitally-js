import { ArgumentsHost, Catch, INestApplication } from "@nestjs/common";
import { BaseExceptionFilter } from "@nestjs/core";
import { Response } from "express";

import type { ApitallyConfig } from "../common/types.js";
import { useApitally as useApitallyExpress } from "../express/index.js";
export type { ApitallyConsumer } from "../common/types.js";

export const useApitally = (app: INestApplication, config: ApitallyConfig) => {
  const httpAdapter = app.getHttpAdapter();
  const expressInstance = httpAdapter.getInstance();
  useApitallyExpress(expressInstance, config);
  app.useGlobalFilters(new AllExceptionsFilter(httpAdapter));
};

@Catch()
class AllExceptionsFilter extends BaseExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    res.locals.serverError = exception;
    super.catch(exception, host);
  }
}
