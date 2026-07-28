# v1 Performance Review

## Scope and method

This review covers the runtime paths in `src/`, with emphasis on request handling, span and log buffering, body capture, OpenTelemetry processing, serialization, spooling, and export. The review traced both Express and Hono flows and checked the implementation against the v1 design contracts.

The existing quality gates pass: `npm run check` and `npm test` complete successfully with 299 passing tests and 1 skipped test. The review also used two focused local benchmarks against the current build to validate the logging and export findings below. These are synthetic measurements, not substitutes for production load tests.

## Findings ordered by impact

| Rank | Impact | Finding |
| --- | --- | --- |
| 1 | High | In-flight request telemetry has no process-wide memory bound |
| 2 | High | Log capture performs expensive work before deciding that a record must be dropped |
| 3 | High when body capture is enabled | Export preparation can block the Node.js event loop for large batches |
| 4 | Medium | The SDK records background spans that its processor is guaranteed to drop |
| 5 | Medium | Request-stage dropped requests still perform body capture work |

## 1. In-flight request telemetry has no process-wide memory bound

**Evidence:** `src/spanProcessor.ts:34-36`, `src/spanProcessor.ts:159-170`, `src/spanProcessor.ts:186-189`, `src/spanProcessor.ts:236-237`, `src/spanProcessor.ts:274-278`, `src/spanProcessor.ts:319-327`, `src/logPipeline.ts:16`, `src/logPipeline.ts:28`, `src/logPipeline.ts:55-63`, `src/capture.ts:18-69`, `src/express/middleware.ts:108-114`, `src/express/middleware.ts:169-183`, `src/hono/middleware.ts:161-166`

The span and log limits are per request. Every accepted request can retain up to 1,000 ended child spans and 1,000 log records until both the SERVER span and transport complete. The number of concurrent request entries has no global cap. In addition, every child span ID is inserted into both the global `requests` map and the request's `spanIds` set, and that ID tracking is not limited by the 1,000-span buffer cap.

Each adapter also maintains request and response `BodyCapture` state for active requests, with no shared byte budget. The later payload stash has a global request-count cap of 2,048, but no byte cap. With both body directions enabled, 2,048 stash entries can retain roughly 205 MB of body buffers alone at the 50,000-byte per-body limit, before headers, spans, log records, and map overhead.

This is most dangerous for long-lived streaming responses such as SSE and long polling. A process with many concurrent streams can retain telemetry for minutes or hours. A single span-heavy stream can also grow `requests` and `spanIds` without bound even after its exportable span buffer reaches 1,000 entries. This creates a realistic process out-of-memory risk.

### Recommended improvement

1. Add process-wide budgets for:
   - active request entries;
   - tracked span IDs;
   - buffered child spans;
   - buffered log records;
   - captured payload and header bytes.
2. Prioritize retaining the SERVER span and request metrics. When a budget is exhausted, discard captured bodies first, then new logs and child spans. Stop adding child span IDs once their telemetry can no longer be retained.
3. Make the payload limit byte-based rather than request-count-based.
4. Add a fast path when `sampleOnResponse` is absent, which is the default. The request-stage decision is then final, so ended child spans and request logs can move directly to the downstream batch processors instead of remaining in memory until a stream finishes. Only the SERVER span and late transport attributes need to remain held.
5. Add a stress benchmark with thousands of concurrent long-lived requests and sustained child-span and log creation. Assert a stable upper bound for heap use.

## 2. Log capture performs expensive work before deciding that a record must be dropped

**Evidence:** `src/config.ts:157`, `src/logCapture.ts:68-86`, `src/logCapture.ts:130-141`, `src/logCapture.ts:218-235`, `src/logCapture.ts:306-316`, `src/logPipeline.ts:38-50`

Log capture is enabled by default. The capture integrations do their expensive work before `LogPipeline.onEmit()` determines whether the record belongs to an Apitally request:

- console arguments are formatted into a second string after the original console call;
- Winston creates and emits an OpenTelemetry log record;
- Pino parses the entire serialized JSON line, extracts the message and timestamp, and emits an OpenTelemetry log record.

Only afterward does `LogPipeline` resolve the emitting span ID and drop records outside a kept request. Background logs and logs from request-stage sampled-out or excluded requests therefore pay capture costs despite being guaranteed not to export.

A local Pino benchmark using a no-op destination and no-op logger emitter measured about 2.8 million logs/second without capture and 1.2 to 1.3 million logs/second with the capture patch. This is about a 2.2x increase in logging-path time before including real OpenTelemetry log-record allocation and processing. The absolute rates are synthetic, but the relative cost confirms that this is not a micro-optimization for logging-heavy applications.

### Recommended improvement

1. Pass a cheap capture predicate from `SpanPipeline` into each log integration.
2. Before `format()`, `JSON.parse()`, or `logger.emit()`, resolve the active OTel span from the current context and check whether its span ID belongs to an in-flight or already-kept Apitally request.
3. For Pino, continue to run the user's `streamWrite` hook first, then skip Apitally parsing when the current context cannot produce an exportable request log.
4. Keep the startup event on its existing direct private-provider path so it bypasses this predicate.
5. Add logging throughput benchmarks for outside-request logs and request-scoped logs. Guard both the fast-drop path and the required capture path.

## 3. Export preparation can block the Node.js event loop for large batches

**Evidence:** `src/activation.ts:38`, `src/activation.ts:219`, `src/exporter.ts:50-66`, `src/exporter.ts:80-135`, `src/exporter.ts:171-205`, `src/exporter.ts:247-252`, `src/redaction.ts:68-85`

The batch span processor can deliver 512 spans at once. `ApitallySpanExporter.export()` processes the entire batch synchronously on the application event loop before any asynchronous spool work can complete. For captured bodies this includes:

- export-copy and attribute construction;
- body mask callbacks;
- UTF-8 decoding;
- `JSON.parse()`;
- recursive field redaction;
- `JSON.stringify()`;
- protobuf serialization for every 32-item chunk.

The 32-item serialization chunks bound spool file growth, but the loop does not yield between chunks. Moving this work out of the request callback does not move it off the Node.js event loop, so a large export delays unrelated request and response I/O.

A local synthetic export of 512 spans, each carrying a 48 KB request body and a 48 KB response body, spent about 160 ms synchronously in `export()` before asynchronous compression. The same benchmark measured about 40 ms for 128 spans. These bodies are within the configured capture limit, so the workload is possible when body capture is enabled on a high-throughput API.

### Recommended improvement

1. Process export work through a serialized asynchronous queue and yield with `setImmediate()` between bounded chunks.
2. Bound chunks by estimated or serialized bytes as well as item count. A 32-record chunk can still contain several megabytes of captured data.
3. Apply masking, redaction, copy construction, and serialization one chunk at a time instead of preparing all 512 export copies first.
4. Consider a worker thread for pure body redaction and protobuf serialization if yielding cannot keep event-loop delay within the target. User mask callbacks must remain on the main thread unless their API contract changes.
5. As an immediate guard, reduce `maxExportBatchSize` for traces with capture enabled. This is less effective than byte-bounded yielding but limits the worst uninterrupted pause.
6. Add an event-loop-delay benchmark at maximum body size and verify p95 and maximum delay, not only total throughput.

## 4. The SDK records background spans that its processor is guaranteed to drop

**Evidence:** `src/providers.ts:21`, `src/providers.ts:78-96`, `src/spanProcessor.ts:199-214`, `src/activation.ts:265`, `src/activation.ts:284-294`

When Apitally owns the tracer provider, it installs `AlwaysOnSampler`. Every instrumentation using the global provider therefore creates recording spans. `SpanPipeline.onStart()` accepts local-root SERVER spans but returns for local roots of every other kind, so those spans have already paid OTel creation, attribute, context, event, and end-processing costs before Apitally drops them.

The SDK-owned Undici instrumentation illustrates the issue. Its ignore hook excludes only Apitally's own endpoint. A fetch made by a queue worker, scheduler, cache refresher, or other background task in the same serving process creates a CLIENT trace that can never be exported under Apitally's request-rooted model. User-registered database and messaging instrumentations can create the same avoidable work when they use Apitally's global provider.

### Recommended improvement

1. Set Undici's `requireParentforSpans` option so root background fetches do not create spans.
2. Prefer a request-aware Undici ignore hook that only permits a span when the active span ID resolves to an Apitally request. This also excludes fetches below unrelated background roots.
3. Replace `AlwaysOnSampler` with an Apitally sampler that:
   - always records SERVER spans, including SERVER spans with unsampled remote parents;
   - records descendants of locally sampled request spans;
   - drops other local roots and their descendants.
   This requires revising the current design rule that the sampler is never an Apitally drop mechanism.
4. Keep processor-level exclusion and response sampling for decisions that require request attributes or completion data.
5. Measure mixed web and background workloads with SDK-owned Undici plus representative database instrumentation.

This optimization applies only when Apitally owns the tracer provider. With an existing user provider, the user owns instrumentation and sampling costs.

## 5. Request-stage dropped requests still perform body capture work

**Evidence:** `src/capture.ts:18-69`, `src/express/middleware.ts:108-114`, `src/express/middleware.ts:169-183`, `src/express/middleware.ts:261-262`, `src/hono/middleware.ts:161-166`, `src/hono/middleware.ts:249-250`, `src/spanProcessor.ts:399-408`, `src/requestObservation.ts:138-155`

The request-stage sampling and exclusion decision sets `record.dropReason` during SERVER span start. However, the Express and Hono adapters keep their `BodyCapture` instances in capture mode. Express continues storing request and response chunks. At finalization, both `.body` getters are evaluated and can call `Buffer.concat()` before `finalizeRecordAndReleaseRequest()` checks `record.dropReason` and skips the stash.

Consequently, an application with body capture enabled and `sampleRate: 0` can buffer and copy up to 100 KB per request even though no captured body can be exported. The same waste applies to path and user-agent exclusions. At 1,000 requests per second with near-limit request and response bodies, this can approach 100 MB per second of avoidable body copying and substantial temporary retention.

Response-stage sampling is different: its decision is unavailable until completion, so body observation cannot generally be skipped for those requests.

### Recommended improvement

1. Give `BodyCapture` a count-only mode that discards buffered chunks while continuing to track body size for request metrics.
2. Immediately switch both body captures to count-only mode when the request-start decision sets `record.dropReason`.
3. Do not evaluate `.body` during finalization for a request-stage dropped request.
4. In Hono, avoid converting a cached text body to a new `Buffer` when only its byte length is needed.
5. Add a low-sample-rate benchmark with both body directions enabled and assert that captured-body allocation scales with kept requests rather than total traffic.

## Recommended implementation order

1. Add global in-flight memory budgets and the no-response-sampler streaming fast path.
2. Add the early log-capture predicate.
3. Make export processing byte-bounded and cooperative with the event loop.
4. Stop recording non-request root spans under the SDK-owned provider.
5. Disable body buffering immediately for request-stage dropped requests.

The first three changes address the largest risks: process memory exhaustion, default logging CPU overhead, and event-loop stalls. The last two remove substantial wasted work in mixed-workload and sampled deployments.
