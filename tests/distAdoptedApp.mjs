// Adopted-setup child fixture: the documented existing-OpenTelemetry path.
// A NodeSDK with instrumentation-http and ApitallySpanProcessor (plus an
// in-child collecting processor) starts before useApitally; two sequential
// requests then show the first request's pre-activation span reaching only
// the metrics while the second request's adopted span exports exactly once.
import { once } from "node:events";
import { createRequire } from "node:module";
import { SpanKind } from "@opentelemetry/api";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ApitallySpanProcessor, shutdown, useApitally } from "apitally";
import { startOtlpSink } from "./distOtlpSink.mjs";

const require = createRequire(import.meta.url);

const sink = await startOtlpSink(process.env.DIST_SINK_DIR);
process.env.APITALLY_OTLP_ENDPOINT = sink.url;

const userSpans = [];
const userCollector = {
  onStart() {},
  onEnd(span) {
    userSpans.push({
      kind: span.kind,
      path: span.attributes["http.target"] ?? span.attributes["url.path"],
      spanId: span.spanContext().spanId,
    });
  },
  forceFlush: () => Promise.resolve(),
  shutdown: () => Promise.resolve(),
};

const sdk = new NodeSDK({
  spanProcessors: [new ApitallySpanProcessor(), userCollector],
  instrumentations: [
    new HttpInstrumentation({
      ignoreIncomingRequestHook: (request) =>
        (request.url ?? "").startsWith("/v1/"),
    }),
  ],
});
sdk.start();

const express = require("express");
const app = express();
useApitally(app);
app.get("/adopted/:id", (_req, res) => {
  res.json({ ok: true });
});

const server = app.listen(0, "127.0.0.1");
await once(server, "listening");
const baseUrl = `http://127.0.0.1:${server.address().port}`;
for (const id of [1, 2]) {
  const response = await fetch(`${baseUrl}/adopted/${id}`);
  await response.arrayBuffer();
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

await new Promise((resolve) => {
  server.close(resolve);
});
await shutdown();
await sink.close();
const serverSpans = userSpans.filter((span) => span.kind === SpanKind.SERVER);
process.stdout.write(`${JSON.stringify({ serverSpans })}\n`);
