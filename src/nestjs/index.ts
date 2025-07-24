import {
  CallHandler,
  ExecutionContext,
  INestApplication,
  Injectable,
  NestInterceptor,
} from "@nestjs/common";
import { catchError, throwError } from "rxjs";

import type { ApitallyConfig } from "../common/types.js";
import { useApitally as useApitallyExpress } from "../express/index.js";
export type { ApitallyConfig, ApitallyConsumer } from "../common/types.js";
export { setConsumer } from "../express/index.js";

export function useApitally(app: INestApplication, config: ApitallyConfig) {
  const httpAdapter = app.getHttpAdapter();
  const expressInstance = httpAdapter.getInstance();
  useApitallyExpress(expressInstance, config);
  app.useGlobalInterceptors(new ApitallyInterceptor());
}

@Injectable()
class ApitallyInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(
      catchError((exception) => {
        if (context.getType() === "http") {
          const ctx = context.switchToHttp();
          const res = ctx.getResponse();
          if (res.locals) {
            res.locals.serverError = exception;
          }
        }
        return throwError(() => exception);
      }),
    );
  }
}
