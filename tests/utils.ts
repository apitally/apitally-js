import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import nock from "nock";

import { ApitallySpanProcessor } from "../src/common/spanCollector.js";

export const APITALLY_HUB_BASE_URL = "https://hub.apitally.io";
export const CLIENT_ID = "fa4f144d-33be-4694-95e4-f5c18b0f151d";
export const ENV = "dev";

export const mockApitallyHub = () => {
  nock(APITALLY_HUB_BASE_URL)
    .persist()
    .post(/\/(startup|sync)$/)
    .reply(202);
};

export const setupOtel = (spanProcessor?: SpanProcessor) => {
  const contextManager = new AsyncLocalStorageContextManager();
  context.setGlobalContextManager(contextManager);

  const provider = new BasicTracerProvider({
    spanProcessors: [spanProcessor ?? new ApitallySpanProcessor()],
  });
  trace.setGlobalTracerProvider(provider);
};

export const teardownOtel = () => {
  context.disable();
  trace.disable();
};
