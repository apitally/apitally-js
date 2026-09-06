# v1 code review, round 3

Reviewed commit `0fda1c6` on the `v1` branch. Rounds 1 and 2 and their verdicts are in `v1/review.md` and `v1/review-2.md`; nothing accepted, fixed, or rejected there is re-raised, and the round-2 fixes that this review touched (Express sub-500 suppression, `OTEL_SEMCONV_STABILITY_OPT_IN` gating, spool warning re-arm, non-recording own span in context, Hono/Elysia install refusal) hold.

## Scope and validation

Five independent reviews covered the core lifecycle, configuration, and export path (activation, config, export worker, spool, exporters), the telemetry pipeline (request observation, span and log processors, body capture, redaction, log capture), the Node framework integrations (Express, Fastify, Koa, Hapi, NestJS, AdonisJS), the Fetch-style integrations (Hono, H3, Elysia), and packaging, tests, and documentation. Every candidate was then verified against the implementation before inclusion, and each High finding plus the majority of the Medium findings was reproduced with a scratch script or scratch vitest file outside the repository. Candidates that did not survive verification, or that describe documented decisions, are listed at the end.

Baseline at the reviewed commit:

- `npm test`: 452 passed, 2 skipped
- `npm run check`: passed

Reproduced in this review (all outside the repo, nothing written to the working tree except this file):

- In-flight map retention for SERVER spans no middleware finalizes (finding 2): 1000 ended SERVER spans, 1000 retained entries
- Express exception loss with an app error handler (finding 3): exported span has no exception event, `drainServerErrors()` is empty
- Express router instantiation freezing routing settings (finding 11): `GET /ITEMS` returns 200 with the SDK and 404 without
- Process exit during an unref'd inter-send pause (finding 5): `final drain completed: false; pending spool files: 2`
- OpenTelemetry diag warning on shutdown (finding 14)
- Missing `deployment.environment.name` on adopted-span export copies with the default env (finding 4), redaction bypass with `?` inside a query value (finding 1), winston misattribution under transport backpressure (finding 7), slow-first-byte web response finalization (finding 8), H3 client address on Node (finding 9), Hono sub-app `onError` (finding 10), pino `unixTime` (finding 18), NestJS 12 install failure (finding 6): reproduced by the reviewing agents with scratch scripts, then confirmed against the code and dependency sources

## High

### 1. `url.query` redaction is bypassed when a query value contains a literal `?`

**Evidence:** `src/redaction.ts:34-48`; caller `src/spanExporter.ts:144` (`redactQueryParams(value, key === "url.query")`); producer `src/requestObservationNode.ts:61`.

`redactQueryParams` always splits at the first `?` and treats everything before it as the path, even when `assumeQuery` is true and the whole value is already a bare query string. `?` is legal and commonly unencoded inside query values (RFC 3986 allows it in `query`; `new URL()` leaves it in place, only `encodeURIComponent` escapes it). When a value contains one, every parameter before it lands in the untouched prefix and is exported raw. For `url.query = token=SECRET&redirect=https://app.example/cb?state=1`, the prefix is `token=SECRET&redirect=https://app.example/cb` and the token leaves the process in clear text, while `http.target` for the same request is redacted correctly because there the first `?` really is the path separator.

**Scenario:** OAuth and SSO callbacks, and any `redirect=`, `next=`, or `returnTo=` parameter carrying an unencoded URL that has its own query, with a `token`, `auth`, or `secret` parameter earlier in the string. Hand-built client URLs and several HTTP clients do not percent-encode `?` in values. `url.query` is the attribute the server concatenates into the displayed URL (spec §6.1).

**Likelihood:** Medium. Kept at High because the impact is a credential leak.

**Fix:** When `assumeQuery` is true, skip the separator search and treat the entire value as the query. Add a redaction test with a `?` inside a value for the `url.query` path; `tests/redaction.test.ts` currently only uses values without one.

### 2. SERVER spans that no Apitally middleware finalizes stay in the in-flight map forever

**Evidence:** `src/spanProcessor.ts:161-166, 375-407` (`startRequest` inserts every sampled-in local-root SERVER span into `requests`), `:458-496` (removal happens only in `releaseRequest` or `dropRequestOnResponse`, both of which require `handleTransportCompletion`), `src/logRecordProcessor.ts:57-71` (log records for an in-flight request buffer until release).

The design bounds the in-flight map per request (1,000 spans, 1,000 log records) and deliberately declines a global budget for long-lived streams (`v1/design-js.md:70`). That reasoning assumes every entry eventually completes. An entry whose request is never observed by an Apitally middleware has no completion at all: `transportCompleted` stays false, `releaseIfComplete` never fires, and the `RequestEntry`, the `Span` object with its attributes, the `spanIds` set, the ended SERVER span, every buffered child span, and every buffered log record stay referenced for the life of the process. There is no cap, no age-out, and no shutdown-independent path that clears them.

Reproduced: a `SpanPipeline` attached to a `NodeTracerProvider`, 1000 local-root SERVER spans started and ended without a transport completion, `requests.size` is 1000.

**Scenario:** The documented existing-OpenTelemetry setup, or the own-provider setup with user-registered contrib instrumentations, where `@opentelemetry/instrumentation-http` produces a SERVER span for every incoming request on every `http.Server` in the process. Any server that is not the instrumented app leaks one entry per request: a Prometheus `/metrics` server on a second port scraped every 15 seconds, a separate liveness port for Kubernetes probes, a Socket.IO or admin server, a second Express app without `useApitally`. At one probe every 10 seconds that is roughly 8,600 retained spans per day; with request logging on that server, up to 1,000 buffered log records per entry on top. Note that the health-check exclusion does not help here: exclusion drops the request before insertion only when the path matches, and a `/metrics` scrape does not.

**Likelihood:** Medium (requires user HTTP instrumentation plus traffic to a server Apitally does not observe, a common combination in Kubernetes deployments). Impact is unbounded memory growth in production, so High.

**Fix:** Entries need a completion path that does not depend on the middleware. The smallest correct rule: when the SERVER span itself ends and the entry has not yet seen transport completion, start a short grace timer (a few seconds is enough, since the middleware finalizes in the same tick as `finish`/`close`) and on expiry treat the entry as released without a record, or drop it, per the design's lookup-miss posture. Alternatively cap `requests` by distinct request count with oldest-first eviction, mirroring the stash cap, and log at debug when the cap evicts. Add a test that ends an unobserved SERVER span and asserts the entry is gone after the grace period.

### 3. Express and Koa lose exception and server-error capture whenever the app has its own error handler that responds

**Evidence:** `src/express/middleware.ts:39-53` appends the SDK error middleware through `app.use(...)` on the first request so it sits after every handler the app registered; `:46-52` is the only capture point. Koa: `src/koa/middleware.ts:50-57` captures only errors that propagate out of `next()`. `v1/design-js.md:78,106` describe the capture as automatic with no caveat, and the README does not mention `captureException` anywhere.

Express dispatches an error to error-handling layers in stack order and stops at the first one that responds without calling `next(err)`. Because the SDK layer is appended last, it only sees errors the app's handler forwards. The documented Express pattern is exactly `app.use((err, req, res, next) => res.status(500).json({...}))` with no `next(err)`. Koa's idiom is the mirror image: a try/catch middleware registered right after `useApitally`, therefore inside the SDK middleware, that sets `ctx.status = 500`, sets a body, and emits `ctx.app.emit("error", err, ctx)` without rethrowing.

Reproduced on Express 5.2.1: a route throws, a custom error handler responds 500. The exported span carries `http.response.status_code = 500` and `events: []`; `drainServerErrors()` returns `[]`. The suite passes only because the fixture app has no error handler, so Express's `finalhandler` responds and the SDK layer is reached.

**Scenario:** Any production Express or Koa app with a custom error handler, which is most of them. The request is still recorded as a 500 with span status ERROR, but the exception event, stack trace, and the server error aggregate that the dashboard's "Server errors" view is built on are silently absent, with nothing telling the user to call `captureException` themselves.

**Likelihood:** High.

**Fix:** Capture where an error enters the router rather than at the end of the stack. The registration patch in `src/express/routes.ts` already owns the router prototype; wrapping the `next` callback handed to each layer (or patching `Layer.prototype.handle_error`, which is what `instrumentation-express` does) observes every `next(err)` regardless of what handlers do afterwards. For Koa, additionally listen on `app.on("error", (err, ctx) => ...)`, which both Koa's default `ctx.onerror` and the idiomatic error middleware emit, and map `ctx` to the request record through a WeakMap since the listener runs outside the request context. Keep the sub-500 suppression rule. If this is deferred, the design and README must say that custom error handlers have to call `captureException(err)`.

### 4. Adopted spans are exported without `deployment.environment.name` when the user's resource has no env and Apitally's env is the default, so the server files them under `prod`

**Evidence:** `src/spanExporter.ts:207` (`const envMissing = resourceEnv === undefined && this.env !== DEFAULT_ENV;`), `:225-227`; spec §5 (`deployment.environment.name` "defaults to `prod` when absent" and "MUST match the `Apitally-Env` header value"); `v1/design-js.md:203` (D8).

For a user-owned tracer provider, `resolveExportResource` adds `deployment.environment.name` to the export copy only when the resolved env is not `dev`. With the default env the attribute stays absent, and the server's absent default is `prod`. The `Apitally-Env` header (`src/exportWorker.ts:59`) and the private metrics and logs resource (`src/providers.ts:72`) both carry `dev`. Traces land in one environment, metrics, logs, and the startup event in another, and the header/attribute MUST is violated. Reproduced against `dist/`: with env `dev` the rewritten resource has no env key; with env `staging` it does.

**Scenario:** The documented existing-OpenTelemetry setup (`NodeSDK` with a `service.name`-only resource plus `ApitallySpanProcessor`) with no `env` option and no `APITALLY_ENV`, which is the zero-config local-development case. The developer's traces pollute the shared app's `prod` environment while their metrics show up under `dev`. `tests/spanExporter.test.ts:273` covers only `env: "staging"`, so the default is untested.

**Likelihood:** High for that setup.

**Fix:** `const envMissing = resourceEnv === undefined;` and add the default-env variant to the exporter test.

### 5. The unref'd inter-send pause lets the process exit in the middle of an export cycle, dropping the tail of the run

**Evidence:** `src/exportWorker.ts:185` (`setTimeout(resolve, pauseMillis).unref()`), `src/activation.ts:465-474` (`beforeExit` starts `shutdown()`), `:350-356` (`drainAndStop` awaits `worker.finalDrain()`), `src/exportWorker.ts:127-144` (`chainCycle` queues behind `currentCycle`), `src/requestObservationNode.ts:184-189` (server `close` starts a regular cycle; Fastify `onClose` and Hapi `onPostStop` do the same).

Node exits when no referenced handles remain, regardless of pending promises. A regular cycle with two or more closed files sits in a 100 to 500 ms unref'd pause between sends. If the event loop is otherwise empty at that moment, `beforeExit` fires, `shutdown()` flushes the processors into the spool and chains `finalDrain()` behind the paused cycle, the loop empties again, `beforeExit` fires a second time with the SDK's listener already removed, and the process exits. The paused cycle's remaining files, everything the shutdown flushed, and the final drain are lost. Reproduced with the real `ExportWorker` and `Spool` and three closed files: one file posted, `final drain completed: false`, two files still pending at exit.

**Scenario:** `server.close()` at the end of a run with no explicit `shutdown()`, relying on the documented `beforeExit` drain: the close event starts a regular cycle that rotates the traces, logs, and metrics files, so there are at least two files and a pause. Also the documented `process.on("SIGTERM", async () => { await server.close(); await shutdown(); })` pattern whenever `server.close()` outlasts the five-second signal drain, because the later close event starts a regular cycle that `shutdown()` then waits on through `waitForIdle()`. Windows and worker threads, which get no signal hooks, hit it on every shutdown with pending files.

**Likelihood:** Medium. The data lost is the last requests' spans and logs and the final metrics, exactly what a graceful shutdown is meant to preserve.

**Fix:** Do not `unref()` the pause timer. A cycle in progress already holds the loop through its fetch sockets, and the interval timer at `:320` stays unref'd so an idle SDK never keeps a process alive. Add one child-process liveness test: two closed files, let the loop drain, assert both were posted. `v1/design-js.md` §16 lists child-process exit as a test seam but nothing uses it.

## Medium

### 6. `npm install apitally` fails in every NestJS 12 project

**Evidence:** `package.json` peers `"@nestjs/common": ">=10 <12"` and `"@nestjs/core": ">=10 <12"`; `npm view @nestjs/core dist-tags.latest` is `12.0.1` (published 2026-08-27). The README table lists `10.x`, `11.x` and the CI matrix has `nestjs-10` and `nestjs-11` lanes.

npm 7+ treats an unsatisfied optional peer that is present in the tree as an ERESOLVE conflict, so the upper bound is an install failure, not a warning. Reproduced in a scratch project with `@nestjs/core@12`: `Could not resolve dependency: peerOptional @nestjs/common@">=10 <12" from apitally@1.0.0-alpha.0`.

**Scenario:** `nest new` installs the latest major, so every Nest project created since 2026-08-27 cannot install the package without `--legacy-peer-deps`.

**Likelihood:** High.

**Fix:** Add a `nestjs-12` CI lane; if green, widen both peers to `<13` and update the README row. Decide as policy whether tight upper bounds on optional peers are worth this failure mode, since the same thing happens the day Hono 5, Fastify 6, or Express 6 ship.

### 7. winston records are attributed to the wrong request under transport backpressure

**Evidence:** `src/logCapture.ts:226-241` (`ApitallyTransport.log` calls `emitCapturedLogRecord` without a `context`, so sdk-logs resolves `context.active()` at delivery time), `:249-263` (the `write` shadow only attaches the transport); `src/logRecordProcessor.ts:45-56` keys the record by the span in that context.

winston delivers `info` objects to transports through the `Logger` Transform stream's pipe. While flowing, delivery happens synchronously inside `write()` and the context is the writer's. Once any transport's Writable buffer fills (object-mode high-water mark 16; the `File` transport defers its callback until the underlying `fs` stream drains, HTTP transports until the response), `pipe()` pauses, later records queue in the Transform, and they are delivered when `drain` fires, in the async context of whatever I/O completion triggered the drain, which is another request or no request at all. Reproduced with the real `installWinstonCapture` and a transport whose callback fires from I/O completion: request A logs 40 lines, request B logs 5 lines, all five B records were buffered under request A.

**Scenario:** Production winston with a `File` or HTTP transport under a logging burst: a handful of concurrent requests logging several lines each pushes the `fs` write stream past 16 KB and the transport past 16 queued objects. Logs then show up on the wrong request's page, or are silently dropped when the drain originates outside any request. pino is unaffected (its `streamWrite` hook runs synchronously inside `write`); console and Nest capture are synchronous.

**Likelihood:** Medium under load.

**Fix:** The `write` shadow is a synchronous seam the SDK already owns. Stamp `context.active()` onto `info` under a `Symbol.for` key there (a symbol property is invisible to `JSON.stringify` and winston formats) and pass it as `context` in `logger.emit` from the transport, falling back to `context.active()` when a format returned a fresh object. Add a test with a slow transport and two request contexts.

### 8. Web response capture finalizes a streaming response after five seconds when the first chunk has not arrived, reporting a wrong duration and no size

**Evidence:** `src/requestObservationWeb.ts:182-206, 212-214`. `readStarted` is set only inside `TransformStream.transform`, which runs when the first body chunk passes through, not when the consumer attaches. The timer resolves `completion` with only `completedAtMillis` whenever no chunk has arrived, and `Promise.race` discards the later `pipePromise` result. All three integrations feed `completion` straight into `finalizeRequestObservation` (`src/hono/middleware.ts:170-171`, `src/h3/middleware.ts:174-186`, `src/elysia/middleware.ts:211-223`).

Reproduced with the timeout scaled down: consumer attached immediately, first chunk after the timeout, `completion` resolved at the timeout with `size: undefined`, while the wire finished later with all bytes delivered.

**Scenario:** Any handler returning a `Response` whose stream produces its first byte more than five seconds in: long-poll endpoints, SSE endpoints that send nothing until the first event, proxied upstreams (`return new Response(upstream.body)`) that send headers then compute, LLM streaming with slow time-to-first-token. The SERVER span is ended and the duration histogram observed at roughly five seconds regardless of the real 30, with no `http.response.body.size`, no captured body, and `sampleOnResponse` running against an incomplete record.

**Likelihood:** Medium for streaming-heavy Hono, H3, and Elysia apps, which are the frameworks people pick for exactly this.

**Fix:** Make the timeout mean "no consumer ever pulled". Replace the `TransformStream` tee with a `ReadableStream({ pull, cancel })` that reads from `response.body.getReader()`, mark `readStarted` and clear the timer on the first `pull`, and count and forward the chunk there. This is also one fewer stream object per response. The existing never-read test keeps passing; add one for a slow first chunk with an active reader.

### 9. `client.address` is never exported for H3 on Node, Elysia, or Hono on Bun

**Evidence:** `src/h3/middleware.ts:57-68` reads only `requestContext?.clientAddress` and `request.context?.clientAddress`. Neither exists in production: srvx's Node `Request` exposes the trust-proxy-aware peer address as `request.ip` (`node_modules/srvx/dist/adapters/node.mjs:307-311`), and H3's own `getRequestIP` falls back to exactly that. No srvx adapter sets `context.clientAddress`; it is only what `app.request(url, init, { clientAddress })` passes, which is what `tests/h3/h3.test.ts:34-36` uses. `src/elysia/middleware.ts:101-104` never passes a client address at all, and `src/hono/middleware.ts:306-313` only recognizes `@hono/node-server`'s `env.incoming`, so Hono on Bun gets nothing either.

Reproduced through `toNodeListener` on a real `http.Server`: `request.ip` is `127.0.0.1`, both context fields are `undefined`.

**Scenario:** Every H3 deployment on Node, every Elysia deployment, every Hono-on-Bun deployment: no client address in request logs, no GeoIP, and for H3 the SDK also ignores the framework's configured trust-proxy policy, which round-1 finding #8 established as the rule. The README claims Bun support for all three.

**Likelihood:** High (unconditional for those setups).

**Fix:** H3: fall back to `request.ip` when it is a string, mirroring `getRequestIP`. Bun: duck-type `env?.requestIP?.(request)?.address` in Hono and `app.server?.requestIP(request)?.address` in Elysia (the plugin receives `app` in `onStart`). Extend the H3 Node-adapter test to assert `client.address`.

### 10. Hono exceptions handled by a mounted sub-app's own `onError` are never captured

**Evidence:** `src/hono/middleware.ts:265-304` wraps only the root `app.errorHandler`. Hono's `route()` (`node_modules/hono/dist/hono-base.js:115-118`) composes a sub-app that has a custom `errorHandler` as `compose([], app.errorHandler)(c, ...)`, so the throw is caught inside the sub-app's compose and the root handler, with the SDK wrapper, is never invoked.

Reproduced: root app with the wrapped handler, `sub.onError(() => 500 JSON)`, `root.route("/api", sub)`, `GET /api/boom` returns 500 with zero root handler calls, no `exception` event, and no server-error aggregate.

**Scenario:** Modular Hono apps where feature modules are sub-apps with their own `onError` mapping domain errors to responses, mounted onto an instrumented root. `v1/design-js.md` §8 says to instrument the root app, which this setup does.

**Likelihood:** Medium-low, standard in larger codebases.

**Fix, which is also a simplification:** Hono's `compose` sets the public `c.error` before calling any error handler, root or sub-app. The SDK already holds the context on the observation (`honoContext`, `src/hono/middleware.ts:128`) and knows the final status at finalization. In `finalizeRequestFromResponse`, when the status is 500 or above and `honoContext.error` is set, write `requestRecord.exception` and record the exception on the span. That covers both handler locations uniformly and lets `wrapErrorHandler`, `captureExceptionIfServerErrorResponse`, `wrapErrorHandlerOnce`, and `ERROR_HANDLER_WRAP_MARKER` (about 50 lines) go, along with the documented "handler replaced after the first request" edge. Since the SDK's `/*` middleware is always present, every request goes through `compose`, so `c.error` is always populated.

### 11. `useApitally(app)` on Express instantiates the app router at setup, freezing routing settings applied afterwards

**Evidence:** `src/express/install.ts:20` calls `installRouteCaptureFromApp`, whose `resolveAppRouter` (`src/express/routes.ts:331-353`) calls `app.lazyrouter()` on Express 4 or reads `app.router` on Express 5. Both create the router on first access with the current `case sensitive routing` and `strict routing` settings baked in; Express 4 additionally bakes in `query parser`.

Reproduced on Express 5.2.1: `useApitally(app)` followed by `app.set("case sensitive routing", true)` and `app.get("/items")`; `GET /ITEMS` returns 200 with the SDK and 404 without.

**Scenario:** The README says to call `useApitally` "anywhere after creating the app" and shows it directly after `express()`; an app that then calls `app.set("strict routing" | "case sensitive routing" | "query parser", ...)` before its routes silently loses the setting.

**Likelihood:** Medium. These settings are minority usage, but the failure is a silent framework behavior change caused by the SDK, and on Express 4 `query parser` is fairly common.

**Fix:** In `installExpressIntegration`, peer-resolve `express` with `createRequire` and call the existing `installRouteCaptureFromExpress(expressModule)` (identical to `src/express/register.ts:8-21`), which patches the shared Router prototype through a throwaway `Router()` without touching the app. Fall back to `installRouteCaptureFromApp` only when resolution fails (the bundled-copy case) and note the ordering constraint for that fallback in the README.

### 12. The default `api-?key` pattern does not redact `api_key` in query parameters and body fields

**Evidence:** `src/config.ts:42-53`; header matching normalizes `_` to `-` (`src/redaction.ts:87-93`) but `shouldRedactQueryParam` and `shouldRedactBodyField` do not. Verified: `?api_key=SECRET` exports unredacted in `http.target` and `url.query`, while the header `x_api_key` is redacted.

**Scenario:** `api_key` is one of the most common query and body spellings for API keys. The SDK follows spec §6.7 verbatim, so this is a spec pattern gap rather than an implementation bug, but the default exists precisely to keep these values out of the export.

**Likelihood:** Medium.

**Fix:** Change the default to `api[-_]?key` in the spec and the SDKs, or apply the header path's underscore normalization to query parameter and body field names as well.

### 13. Two headline behaviors have no test

**Evidence:** `grep -rn "captureLogs: false" tests` returns nothing; `grep -rln server_span_id tests/*/` matches only `tests/hapi/hapi.test.ts` (Hapi's `request.log()`).

`captureLogs: false` is specified (`v1/design.md` §9, `v1/design-js.md` §8) as disabling only the application-log patches while the startup event and the validation and server error events keep flowing. A plausible edit that gates `emitErrorEvents` or the startup event on `captureLogs` would break that silently. Request-scoped log linkage through a real framework is asserted nowhere except Hapi: no Express, Fastify, Koa, Hono, H3, or Elysia test checks that a `console.log` (or winston or pino write) inside a handler exports with the request's `apitally.request.server_span_id`. The unit tier covers the processor and the patches in isolation, but the wiring that makes the README's correlation claim true (context binding of `req` and `res`, async-local storage through the framework's chain) is integration behavior and exactly what a middleware-order or context change would break. AGENTS.md assigns wiring to the framework suites.

**Likelihood:** Medium for both.

**Fix:** One shared-tier test for `captureLogs: false` (console patch absent, startup and error events still emitted), and one canonical cross-framework `it` ("exports a console log written in a handler with the request's SERVER span id") in each framework file.

### 14. `drainAndStop` emits error events into an already shut-down `LoggerProvider`, producing an OpenTelemetry diag warning on every shutdown

**Evidence:** `src/activation.ts:352-355` calls `emitErrorEvents` then `loggerProvider.shutdown()`, then `worker.finalDrain()` runs the flush callbacks at `:303-308`, which call `emitErrorEvents(loggerProvider)` again. `node_modules/@opentelemetry/sdk-logs/build/src/LoggerProvider.js:38-41`: `getLogger` after shutdown emits `diag.warn("A shutdown LoggerProvider cannot provide a Logger")` and returns a noop logger.

Reproduced: `configure()`, `activate()`, `shutdown()` with a diag logger at WARN level records that message.

**Scenario:** Any user with a diag logger configured (`diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN)`, common in the existing-OpenTelemetry population, and what `OTEL_LOG_LEVEL` enables through the NodeSDK) sees an unexplained OpenTelemetry warning at every graceful shutdown. Error groups added between the two calls are dropped.

**Likelihood:** High occurrence for that population, noise-level impact.

**Fix:** Drop the explicit `emitErrorEvents` call and reorder to `spanPipeline.shutdown()`, `worker.finalDrain()`, `loggerProvider.shutdown()`, `worker.stop()`. The final cycle's flush callback already drains the groups immediately before `batchLogProcessor.forceFlush()`, so the records still reach the spool before the send.

## Low

### 15. `APITALLY_WRITE_TOKEN` is not trimmed, so a trailing newline disables the SDK with a misleading error

**Evidence:** `src/config.ts:131, 226-228` (no trim), `:78` (anchored regex), `:169-175`. Contrast `:223` (`APITALLY_DISABLED` is trimmed) and `src/adonisjs/configure.ts:13` (`isValidWriteToken(value.trim())`).

**Scenario:** A Kubernetes secret created with `echo "apt_..." | base64` (no `-n`) or a CRLF `.env` file yields `apt_...\n`. The SDK logs `write token has an invalid format: apt_3kPm...` and disables itself; the visible prefix looks correct, so the operator has nothing to act on.

**Likelihood:** Medium (a well-known secrets footgun), impact bounded by the error log. **Fix:** Trim in `nonEmptyEnvVar`.

### 16. `isSameConfig` compares callback options by reference, so legitimate re-calls with inline callbacks warn

**Evidence:** `src/config.ts:211-220` (`left === right` for `maskRequestBody`, `maskResponseBody`, `sampleOnRequest`, `sampleOnResponse`); `v1/design.md` §3 says repeated app-factory calls must stay quiet.

**Scenario:** `createApp()` calls `useApitally(app, { writeToken, sampleOnResponse: (span) => ... })` and a test suite builds the app per test in one process: `setConfig` prints "useApitally() was called again with different options" once per process.

**Likelihood:** Medium in test suites, one spurious line. **Fix:** Exclude function-valued keys from the comparison; identity cannot establish sameness and the first configuration stays in effect either way.

### 17. A second SDK observation of the same request adopts the SDK's own SERVER span and double-counts metrics

**Evidence:** `src/requestObservation.ts:97-105` adopts any recording SERVER span in the active context, including the SDK's own (placed there at `:139`); `src/spanProcessor.ts:277` calls `metricsRecorder(record)` unconditionally, so a second record for the same server span id records the histograms again. H3 guards against this (`src/h3/middleware.ts:46-48`, early return when `getRequestRecord()` exists); Express, Koa, Fastify, Hapi, Hono, and Elysia do not.

**Scenario:** An Express app factory that calls `useApitally` (supported per design §3), with one factory-made app mounted into another through `app.use("/api", api)`: the inner `app.handle` wrap adopts the outer span, patches `res.write` and `res.end` again, runs route tracking twice, and finalizes twice, so every `/api` request counts twice in metrics and the error accounting.

**Likelihood:** Low, both apps must be instrumented. **Fix:** Return early in `startRequestObservation` when `getRequestRecord(activeContext)` already exists, mirroring H3.

### 18. pino `stdTimeFunctions.unixTime` timestamps are interpreted as monotonic-clock offsets

**Evidence:** `src/logCapture.ts:336` passes `parsed.time` as `timestamp`; sdk-logs runs it through `timeInputToHrTime`, which treats numbers below `performance.timeOrigin` as `performance.now()` offsets. Seconds since the epoch (about 1.79e9) is far below the origin (about 1.79e12 ms). Reproduced: a `unixTime` value from now is recorded about 20 days in the future.

**Scenario:** `pino({ timestamp: pino.stdTimeFunctions.unixTime })`, a documented pino option.

**Likelihood:** Low. **Fix:** Pass `time` only when it is plausibly epoch milliseconds (greater than 1e12), otherwise omit it.

### 19. Regex routes are exported inconsistently: Koa emits the regex source as `http.route`, Express emits no route

**Evidence:** `src/koa/routes.ts:60-65` returns `value.toString()` for a `RegExp` (pinned by `tests/koa/routes.test.ts:41-42,62`); `src/express/routes.ts:415-429` returns `undefined` for a `RegExp` `req.route.path`, so the request exports with an empty route and is skipped by the histograms.

**Scenario:** `@koa/router` and Express both accept regex paths; the same route gets metrics in Koa and none in Express.

**Likelihood:** Medium occurrence, low impact. **Fix:** Pick one behavior. The regex source is a stable, readable template identifier, so aligning Express with Koa loses nothing.

### 20. The AdonisJS `configure` command makes `APITALLY_WRITE_TOKEN` and `APITALLY_ENV` required env vars

**Evidence:** `src/adonisjs/configure.ts:44-49` registers `Env.schema.string()` for both.

**Scenario:** A new environment, or `APITALLY_DISABLED=true` with the token removed, fails Adonis env validation at boot instead of running without telemetry, contrary to the "missing token logs an error and force-disables" posture (`v1/design.md:82`). `APITALLY_ENV` also has an SDK default (`dev`) that the required schema defeats.

**Likelihood:** Low, but a boot failure is a hard outcome. **Fix:** `Env.schema.string.optional()` for both.

### 21. Elysia `aot: false` silently disables the integration

**Evidence:** `src/elysia/middleware.ts:92` relies on `plugin.wrap()`. Elysia applies `extender.higherOrderFunctions` only in `composeGeneralHandler` (`node_modules/elysia/dist/compose.mjs:1093`); the dynamic handler used when `config.aot === false` never references them. Result: no spans, no metrics, no startup event, no warning. `@elysiajs/opentelemetry` has the same limitation.

**Scenario:** Users who set `aot: false` for faster startup or because their environment restricts `new Function`.

**Likelihood:** Low. **Fix:** In `onStart`, where the app is available, warn once when `app.config.aot === false`, naming the cause.

### 22. The dispatch, observe, and finalize control flow is duplicated across the three web integrations

**Evidence:** `src/h3/middleware.ts:84-103, 156-234`, `src/elysia/middleware.ts:119-137, 179-293`, `src/hono/middleware.ts:81-97, 205-221`. `finalizeFailedRequestObservation` in H3 and Elysia is byte-identical apart from the WeakMap type; Hono's `finalizeRequestObservationAfterFetchRejection` differs only in not deleting from a map. The sync-or-promise dispatch block and the `observeResponse` catch fallback are copy-pasted with different log prefixes.

**Fix:** One helper in `requestObservationWeb.ts`, for example `dispatchAndObserveWebResponse(observation, dispatch, onResponse)`, owning the sync/async branching, failure finalization, and the response tee, leaving each integration with route recording, client address, and its framework-specific error hook. Roughly 100 lines less and one place for the round-2 asymmetry (Hono's catch path not finalizing) to disappear.

### 23. Every web response is teed even when nothing is captured and the size is declared

**Evidence:** `captureWebResponse` (`src/requestObservationWeb.ts:160-216`) always builds a `TransformStream` and a new `Response` unless the body is null. On `@hono/node-server`, touching `response.headers` and `response.body` materializes the adapter's lightweight `Response` and its string and `ArrayBuffer` fast path is replaced by pumping a `ReadableStream` for every JSON response; on Bun, `new Response(Bun.file())` static responses lose the native file fast path. The design accepts the tee for completion timing (`v1/design-js.md` §7), so this is a cost trade, not a defect; the fast-path claim is code-derived and was not benchmarked.

**Fix, if wanted:** Skip the tee when `shouldCaptureBody` is false, a numeric `Content-Length` is declared, and the status is not 400 or 422; finalize at handler return with the size from the header. Streamed, chunked, and captured responses keep the tee. Finding 8's `pull`-based stream also reduces the per-response cost.

### 24. `readResponseAndSettleTransport` relies on scheduling rather than a deterministic seam

**Evidence:** `tests/utils.ts:197-203` reads the body then awaits one `setImmediate` "so the response tee settles"; used 74 times across the Hono, H3, Elysia, and Node suites. A deterministic seam exists (`waitForNextRequestFinish`, `tests/utils.ts:207`) and is used only where completion is not client-observable.

**Explanation:** AGENTS.md forbids timing dependence. "One macrotask is enough" is a property of current WHATWG streams and undici scheduling, not of the SDK. If the Fetch-style completion path gains an extra async hop (the fix for finding 8 is a candidate), these tests turn flaky rather than failing clearly.

**Fix:** Compose `waitForNextRequestFinish` into the helper instead of the macrotask.

### 25. The Adonis configure test writes its fixture into the repo root

**Evidence:** `tests/adonisjs/configure.test.ts:47` uses `mkdtemp(join(process.cwd(), ".tmp-adonis-configure-"))`; `.gitignore` has no matching entry. This is the "temporary Adonis fixture files" race recorded in round 1.

**Explanation:** The location is needed so the fixture resolves `@adonisjs/core` from the repo's `node_modules`. But a crash before the `finally` leaves an untracked directory in the worktree, and Biome (`vcs.useIgnoreFile: true`) and knip scan it whenever `npm run check` overlaps a test run.

**Fix:** Add `/.tmp-adonis-configure-*` to `.gitignore`, or place the fixture under `node_modules/.cache/`, which is already ignored and still resolves the package.

### 26. CI matrix gaps: the `h3` lane no longer installs h3 v2, and Hapi has no floor or Node lane

**Evidence:** `.github/workflows/tests.yaml` scenario `h3` installs unpinned `h3`; `npm view h3 dist-tags` today is `{ beta: "2.0.0-beta.5", "1x": "1.15.11", latest: "2.0.0" }` where `2.0.0` is a deprecated placeholder, so `npm install h3` resolves to 1.15.11, which has no `H3` class. The newest version inside the peer range (`>=2.0.1-rc.26 <3`) is reachable only by explicit version. Hapi is absent from the scenario list entirely; it runs only in `test-coverage` on Node 24 at the devDependency version, so the `21.0.0` floor is never installed and the integration never runs on Node 20 or 22, contrary to `v1/design.md:208`.

**Fix:** Pin the h3 lane to the newest satisfying release candidate (or resolve the range in the workflow) and add one README sentence on installing an h3 v2 release candidate; add `hapi` and `hapi-21.0` lanes.

### 27. `v1/design-js.md` drift

- §13 (`:162`) documents `setConsumer(identifier, { name?, group? })`; the implementation is `setConsumer(consumer: ApitallyConsumer | string)` (`src/consumer.ts:23`). Round 1 rejected changing the code (#15) but the doc was not corrected.
- §13 (`:166`) says subpaths export exactly `useApitally` plus option types; `apitally/elysia`, `apitally/h3`, and `apitally/hapi` export `apitallyPlugin`, `apitally/adonisjs` exports `defineConfig` and `captureException(error, ctx)`, and the root exports `configure`. All are correct and README-documented; the sentence is stale.
- §16 (`:190`) still says `tests/shared/<module>.test.ts`; round 2 fixed AGENTS.md but not this line.

README examples, import paths, export names, and option names were all checked against the code and match.

## Rejected candidates

- **Hapi Joi validation failures are not captured although Hapi exposes `output.payload.validation` and Joi `details`.** A feature gap the design records explicitly (`v1/design-js.md:116`), not a defect. Worth a follow-up since the contract exists in the hook the SDK already owns.
- **Hono `useApitally` registers startup-event info before deciding to refuse installation** (`src/hono/index.ts:12-18`). Requires a processor-triggered activation after a refused install; too unlikely to act on.
- **Spool size eviction racing the send loop can log one misleading "Error reading buffered X" warning.** Reachable only at the 50 MB cap during outage recovery; one debug-level line of noise.
- **The `beforeExit` and `shutdown()` final drain is uncapped, so an unreachable endpoint delays process exit by up to 20 seconds.** Documented decision (`v1/design-js.md:142`).
- **Cross-framework `it` string drift (mostly Elysia).** Convention only, no behavior at stake.
- **`ExportWorker` retries a connection error once immediately, so a dead endpoint gets two probe POSTs per cycle.** Documented (`v1/design-js.md:142`), harmless.
