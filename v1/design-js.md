# Apitally JS SDK Design

Language-specific design doc for the JavaScript/TypeScript v1 SDK, per the process in `design.md`. It maps each section of `design.md` onto the Node.js/Bun ecosystem and records every deviation as a conscious choice with rationale. The Python SDK (`apitally-py`) is the reference implementation; where this document is silent, the reference behavior and `design.md`/`spec.md` apply unchanged.

Deviations are numbered `D1`-`D7` for traceability and summarized at the end.

## 1. Product shape

Same package name (`apitally`), shipped as 1.0 with a clean break from 0.x. Alphas publish as `1.0.0-alpha.N` under the npm `next` dist-tag; `latest` stays on 0.x until GA.

Platform scope: Node.js >= 20.6 (declared in `engines`), Bun first-class (CI-covered). Edge and serverless runtimes (Cloudflare Workers, Lambda streaming) remain the domain of the separate `apitally-js-serverless` package.

The defaults table in `design.md` §1 applies verbatim, including the two 0.x behavior flips the migration guide must call out: `captureLogs` defaults on, `env` defaults to `prod`.

## 2. Integration with existing OpenTelemetry setups

Detection at activation uses the OTel API global: `trace.getTracerProvider()` returns a `ProxyTracerProvider`; a delegate that is absent or a `NoopTracerProvider` means no user setup exists. Never detect via `instanceof` — the user's provider may come from a different copy of the OTel packages (see §16).

**No existing tracer provider**: the SDK constructs its own `NodeTracerProvider` with an explicit always-on sampler and the resource from below, and registers it as the OTel global. `design.md` §2's "tracer provider only" scopes to signal providers (meter and logger providers stay private, below); the API globals that default to no-ops are also registered, each only when not already set: `AsyncLocalStorageContextManager` as the global context manager (without it `context.with()` is inert — per-request contexts, the span handle, and `suppressTracing` all silently stop working) and the W3C trace-context propagator (user-registered outbound instrumentations inject through it). Span attribute value length limits are pinned to 65,536 on every constructor setting that could constrain them (`generalLimits` and `spanLimits`), so `OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT`-style env vars never clip captured bodies.

**Existing tracer provider**: attach `ApitallySpanProcessor` additively. User-owned providers are supported from OTel JS SDK 2.0; 1.x is not supported (its span shapes predate the 2.0 renames and are rejected by the export pipeline — no detection or compat path). **D1 — attach mechanism**: OTel JS SDK 2.x removed `addSpanProcessor()`; processors are constructor-only. The SDK attaches through the provider's internal processor list with defensive shape checks across the supported OTel 2.x range. When the shape is unrecognized, warn once with the actionable fix: add `ApitallySpanProcessor` (public export from the package root) to the provider's `spanProcessors` array (requires OTel SDK >= 2.0). The sampler warning and the attribute-length-limit warning from `design.md` §2 apply; the existing provider's resource is read through its public `resource` property for env resolution.

Meter and logger providers are always private instances, never registered into OTel globals.

Environment resolution and resource construction follow `design.md` §2 exactly: resource built once at activation via the standard resource environment mechanism, with `service.instance.id` (UUIDv4 per process), `deployment.environment.name`, `telemetry.distro.name` = `apitally-js`, and `telemetry.distro.version` merged on top.

## 3. Configuration

Options are camelCase, mapped 1:1 from the shared option set: `writeToken`, `env`, `appVersion`, `disabled`, `captureLogs`, `captureRequestHeaders`, `captureRequestBody`, `captureResponseHeaders`, `captureResponseBody`, `maskQueryParams`, `maskHeaders`, `maskBodyFields`, `maskRequestBody`, `maskResponseBody`, `excludePaths`, `sampleRate`, `sampleOnRequest`, `sampleOnResponse`. The absent-vs-default distinction is TypeScript optionals: an omitted option is `undefined` and keeps env-var fallbacks in effect.

Env vars, precedence, re-call semantics, invalid-value handling, and the `APITALLY_DISABLED` activation-boundary recheck follow `design.md` §3 verbatim.

Semconv: the SDK's own SERVER spans emit stable HTTP semconv natively, so no opt-in mechanism is involved on the primary path. For user-owned instrumentations constructed after configure, `OTEL_SEMCONV_STABILITY_OPT_IN` is set to `http/dup` only when unset. Old-convention fallbacks are retained at every SDK read site (exclusion matching, query redaction, path derivation) for spans produced by user instrumentation that initialized with old names.

## 4. Lifecycle

**Configure** runs synchronously inside `useApitally()`: validate options, wrap the app (per-framework), compile patterns. No timers, no I/O.

**Activate** is gated in the SDK's outermost per-request wrapper, before the SERVER span starts, with first request as the universal trigger (Express and Hono have no startup-completion event). Activation is fully synchronous — provider construction, pattern binding, a synchronous filesystem probe of the spool directory, starting unref'd timers, emitting the startup event — so the single-threaded event loop provides the concurrent-first-request guarantee without locks. Frameworks with real lifecycle hooks (Fastify `onReady`, Hapi `onPostStart`, NestJS/Adonis lifecycle) use those as the trigger in their adapters.

Test-environment detection at the activation boundary: `JEST_WORKER_ID`, `VITEST`, `NODE_ENV=test`, `APITALLY_DISABLED`, and the `disabled` option all skip activation permanently. Activation is attempted at most once per process; a failure logs at error level and the app serves untelemetered.

**Per-request context isolation**: each request runs under a fresh context (`ROOT_CONTEXT` base) established by the outermost wrapper, except when adopting a user instrumentation's SERVER span, in which case the SDK runs inside the user's context by design.

**Graceful shutdown** is layered, without ever installing termination-signal handlers:

- Express: on the first request, the middleware attaches a `close` listener to the live server (`req.socket.server`), covering `app.listen` and `http(s).createServer(app)` startups alike; server close triggers the final drain. Once-per-process semantics: an app dual-bound to multiple servers drains when the first one closes (graceful shutdowns close them together; `shutdown()` covers the rest).
- Frameworks with shutdown hooks (Fastify `onClose`, Hapi `onPreStop`, NestJS/Adonis lifecycle) wire those in their adapters.
- `process.on("beforeExit")` is the floor for clean exits; all SDK timers are unref'd so the SDK never keeps the event loop alive.
- A public async `shutdown()` at the package root is the documented path for Hono and custom lifecycles that never close the server.

**Fork safety** is not a JS concern: `cluster` workers are separate processes that each configure and activate independently; there is no post-activation fork.

## 5. Request model: span filtering and exclusion

As `design.md` §5: the in-flight request map keyed by SERVER span id is the single keep/drop point, classification happens at span start, children inherit their local parent's entry, lookup miss defaults to dropped. OPTIONS, websocket schemes, and path/user-agent exclusions apply at the same point; path and query are derived from the full-URL attribute and written onto the span when the producing instrumentation omitted them. The per-message span drop (kind + name suffix + scope) is retained for user-owned socket instrumentations even though the SDK's own middleware never emits such spans.

## 6. Sampling and per-request buffering

Two-stage sampling, deterministic by trace ID, per `design.md` §6: the low 64 bits of the trace id (BigInt from hex) tested against `round(rate * 2^64)`; both stages test the same value so the overall probability is the minimum of the two rates. Callbacks receive the SERVER span and return `number | boolean | undefined` (`undefined` = abstain); a throwing or invalid-returning callback warns and resolves to keep. Per-request buffers cap at 1,000 spans and 1,000 log records.

**D2 — uniform release model replaces deferred export.** The reference implementation's `defer_export`/`finish_export` mechanism is not ported. Instead:

- The transport middleware accumulates everything it learns into one **per-request record**: status, sizes, final route, captured header/body payloads, timing.
- **One release condition for every request: transport completion AND SERVER-span end — whichever completes second triggers the release.** Transport completion (response fully sent, streamed body fully consumed) finalizes the per-request record: the response-stage sampling decision runs and metrics are recorded at that moment, independent of span-end timing. Once both conditions hold, on keep the request's buffered descendants, SERVER span, and logs flush.
- Attribute writes during the request go through one write-through helper: write to the live span if recording, always mirror into the request record; the export path applies the record onto the span copy it already builds for redaction, idempotently.
- Spans the SDK created are ended at transport completion, so both release conditions coincide — the only owned-vs-adopted difference is that single `span.end()` call. Adopted spans end on their producing instrumentation's schedule (`instrumentation-http` ends on response `close`, which fires after `finish`), sit in the per-request buffer, and receive late attributes on the export copy.

Rationale: the SDK owns span end timing on the primary path, so the condition the deferral mechanism exists for (span ends before the response completes) does not arise there; for adopted spans, the existing buffer plus export-copy pipeline delivers the same portable invariant (late-learned response attributes MUST reach the exported span) without a second mechanism. Trade-off, accepted: attributes that only reach the export copy are invisible to user-owned exporters on adopted spans; the write-through helper makes this rare and `design.md` only requires invisibility in the other direction (payloads).

Shutdown semantics: processor shutdown releases buffered requests whose transport already completed; buffers of still-in-flight requests are discarded, per `design.md` §6.

## 7. Capture pipeline

Follows `design.md` §7 with these JS mechanics:

- Capture decisions are header-only: content-type allowlist first, then the 50,000-byte cap with the `[BODY_TOO_LARGE]` sentinel; complete bodies only; a partial buffer from an aborted stream is suppressed.
- Express request bodies are captured with a passive `req.emit` wrap on the `IncomingMessage`, observing `data`/`end`/`aborted` events as they pass through — the stream's flow state is only ever changed by the app's own consumer (body-parser included), never by the SDK, with a running length check per observed chunk (the async message-based transport rule). A body no consumer ever reads is not captured.
- Response bodies: Express via `res.write`/`res.end` patches; Hono via the ported v0 `captureResponse` stream-teeing helper (including its Bun workaround).
- **Payload isolation**: the write-through helper (§6) has exactly two data classes — regular attributes (live write + record mirror) and capture payloads (header maps, body bytes), which are stash-only, never touch the live span, and are masked/redacted/attached only to Apitally's export copy, off the request path. A span that fails redaction is dropped, never exported raw.
- Mask callbacks: `maskRequestBody(body: Buffer, span)` returning `Buffer | null`; returning nothing, throwing, or returning the wrong type yields `[REDACTED]`. Documented contract: may run later, off the request path, against an ended span snapshot.
- Body processing order (mask → parse → redact → serialize), JSON detection by parse attempt, bytes-valued attributes for non-UTF-8 bodies, gzip pass-through for pre-compressed response bodies, header redaction (list-valued single `[REDACTED]`, `Location`/`Content-Location` query redaction), and the export-boundary query/header redaction pass over both semconv normalizations all follow `design.md` §7.
- Body size attributes are set independently of capture toggles: Content-Length when trustworthy, else a running byte count finalized at transport completion; unknown size skips both the attribute and the histogram observation.

## 8. Transport observation, routes, frameworks

**D3 — SDK-owned middleware produces the SERVER span.** In JS, "stock instrumentation" for the SERVER span means module-loading interception (`instrumentation-http` patches `node:http` at require time; `instrumentation-express` only decorates). That path's documented setup requires init-before-imports or `--import` loader flags, and Bun lacks the ESM loader hooks entirely (`module.register` unimplemented) — both incompatible with one-line setup on this SDK's platform scope. (A late-enablement trick exists — the patch mutates `http.Server.prototype.emit` in place, and require-in-the-middle also patches `process.getBuiltinModule`, so a forced builtin re-require after enable activates SERVER spans even on Bun — and is rejected: it rides undocumented require-in-the-middle internals, degrades silently to zero spans without the forced trigger, and still produces route-less generic-named spans, because `instrumentation-express`, the `http.route` source, emits INTERNAL-only spans and stays inert under init-after-imports on ESM and Bun — the SDK's middleware would have to exist anyway.) The JS ecosystem's own framework instrumentations (`@hono/otel`, `@fastify/otel`) are middleware/plugin based; this SDK follows that pattern for every framework: the transport middleware is also the span producer, emitting stable semconv, extracting W3C `traceparent`, and starting the span as a local root under a fresh context. The middleware sets HTTP RPC metadata on that context (`setRPCMetadata`, exactly as `instrumentation-http` does) — the ecosystem's "a transport span exists" beacon: `@fastify/otel` >= 0.19 demotes its request span to INTERNAL on this signal (earlier versions never emitted SERVER spans), so middleware-based producers that honor it coexist without duplicates.

**Adoption**: when the outermost wrapper finds an active, recording SERVER span (the user runs `instrumentation-http` or equivalent through their own setup), the SDK adopts it — no second SERVER span — and layers the per-request record, capture, and metrics on top. With instrumentations registered but no user provider, the OTel proxy delegates to Apitally's provider from activation onward, so user-registered contrib instrumentations (DB clients, HTTP clients) feed descendants into Apitally with zero per-library SDK code. Instrumentations bound to an explicit non-global provider route past the SDK: documented limitation, as in the reference. Middleware-based producers that ignore RPC metadata (`@hono/otel` today) start their SERVER span inside the framework chain, after adoption has decided; the span processor detects the nested SERVER span under an in-flight request, binds it to the same request entry, demotes it to INTERNAL on Apitally's export copy (Apitally never double-counts — including when a previously dormant middleware wakes up because the SDK registered the global provider), and warns once naming the producing scope. The duplicate in the user's own exporters is theirs to resolve by removing the producing middleware; the warning says so.

Outermost observation per phase-1 framework:

- **Express**: `useApitally` wraps `app.handle` — the single entry point for every request, position-independent of when `useApitally` is called, covering 404/`finalhandler` and error-handler responses. Response observation via `res.write`/`res.end` patches plus `finish`/`close` listeners. A lazily-appended error middleware (first request) captures the error object for the exception event. Route templates come from the ported v0 reconstruction logic (nested routers, mount prefixes, Express 4/5 differences, inline regex params).
- **Hono**: `useApitally` wraps `app.fetch` (span, fresh context, response observation — `onError`-synthesized responses return through it) and registers a thin inner middleware for context-bound data (`c.req.routePath`, consumer). The existing `onError` handler is wrapped through the runtime-accessible `errorHandler` property (duck-typed, defensively) to record the exception event; 404-ness is derived from route-match state plus the response status, since Hono holds its `notFound` handler in an ES private field that cannot be read or composed. Works identically on Node (`@hono/node-server`) and Bun. Documented edge: an `app.fetch` reference grabbed before `useApitally` bypasses the wrapper.

Route authority per `design.md` §8: the SDK sets `http.route` to the parameterized template including mount prefixes, clears wrong routes on unmatched requests (exported with empty route; histograms skip them), and names spans `{method} {route}`. Version floors (Express >= 4, Hono >= 4, refined during implementation) are validated against context-propagation correctness, not API surface.

## 9. Logs

**D4 — capture surface via SDK-owned patches, not contrib instrumentations.** The chosen surface is `console` + winston + pino (plus the NestJS logger with its adapter). Mechanism: global console method wraps and the winston `Logger` prototype patch are ported from v0 (both cover pre-existing logger instances); the pino patch is new code — the shared logger prototype's write method, resolved via `pino.symbols.writeSym` on a probe instance from the peer-resolved pino copy, covering pre-existing and future loggers — all emitting into the private `LoggerProvider` through `api-logs` (severity mapping per spec §8, instrumentation scope name = logger name, `console` for console). Rationale: the contrib logging instrumentations are require-hook based (a logger created at module scope before `useApitally` is never captured) and the winston bridge hard-codes the global logger provider, conflicting with the private-provider invariant. Users who run the contrib logging instrumentations anyway coexist without duplication: their instrumentation emits into the global logger provider, the SDK's patches into the private one — disjoint destinations, each log delivered once to each backend (captured bodies may carry the contrib-injected `trace_id`/`span_id` correlation fields). winston and pino are optional `peerDependencies` so the SDK patches the user's copy under strict package layouts (pnpm). Known limitation, documented: exotic pino setups (custom transports in worker threads) may evade the prototype patch.

Request linkage, the drop rule, SDK/OTel self-log exclusion, per-request buffering, and the 2,048-character truncation follow `design.md` §9. **D7 — platform gap, recorded**: `code.file.path`/`code.line.number`/`code.function.name` are omitted — JS logging libraries do not carry caller location without expensive stack capture.

Startup event per spec §9: scope `apitally`, event name `apitally.app.startup` in the native `eventName` field (with the `event.name` attribute fallback if the pinned `sdk-logs` version lacks it — verification spike), JSON body with `framework` (`express`, `hono`), `versions` (`node`, framework, `app` when `appVersion` set), lazily-enumerated `paths`. `openapi` is omitted for the phase-1 frameworks; framework-native spec sources (e.g. Hono zod-openapi) are a later refinement.

## 10. Export pipeline

As `design.md` §10, with these JS bindings:

- **Intake**: stock `BatchSpanProcessor` and `BatchLogRecordProcessor` with every parameter passed explicitly (~1s schedule delay); a verification spike confirms constructor config beats `OTEL_BSP_*`/`OTEL_BLRP_*` env vars for every parameter.
- **Encoding**: `@opentelemetry/otlp-transformer` protobuf serializers (`ProtobufTraceSerializer`, `ProtobufMetricsSerializer`, `ProtobufLogsSerializer`) — no stock OTLP exporter in the path. A spike confirms byte-stable serialization for the content-hash dedup contract.
- **Spool**: v0 `TempGzipFile` mechanics (node:zlib gzip streams into `os.tmpdir()`, recognizable `apitally-*.gz` naming) carrying the full `design.md` semantics: per-signal files, 4 MB uncompressed rotation checked before append, appends in bounded sub-chunks, 50 MB disk / 10 MB memory caps with metrics-last eviction, 59-minute retention after first send attempt, 2-hour orphan cleanup, per-cycle mtime touch, synchronous writability probe with in-memory fallback.
- **Worker**: one unref'd-timer worker; 15s interval ±10% jitter, first export ~2s, 10 files per cycle oldest-first, 0.1-0.5s inter-send pauses, 10s POST timeout (`AbortSignal.timeout`), `Apitally-Export-Interval` response header clamped to [5, 60], retryable = connection errors/timeouts/408/429/5xx with one immediate inline re-POST on connection error, permanent 4xx dropped with once-per-status warning. Cycles run under `suppressTracing` so export traffic is invisible to instrumentations. Final drain on shutdown: uncapped, unpaced.
- **HTTP client**: global `fetch`. Proxy support per the standard env vars, resolved once at configure time: on Node, undici's `EnvHttpProxyAgent` passed as the per-request `dispatcher` (constructed only when proxy vars are present — the user's global fetch is never touched); on Bun, the native `proxy` fetch option. undici is a regular dependency.
- Headers per spec: `Authorization: Bearer`, `Apitally-Env`, `Content-Type: application/x-protobuf`, `Content-Encoding: gzip`, `User-Agent: apitally-js/<version>`.
- **Metrics collection is worker-driven**: a non-periodic `MetricReader` subclass; the worker calls `collect()` each cycle so all three signals export together.

## 11. Metrics

Three request histograms under scope `apitally`, exponential buckets, delta temporality — aggregation type and temporality configured through the reader's selectors so the overrides apply to histogram instruments only. JS `sdk-metrics` exposes no scale configuration (the aggregator starts high and only rescales down as the data range demands) while the ingest endpoint accepts scales in [-2, 6] and drops data points outside, so the export path downscales exponential histogram data points to scale <= 3 (bucket-merge by powers of two) before serialization — matching the reference implementation's `max_scale=3`. Recorded at the §6 release point from the per-request record, sampling-independent; excluded and sampled-out requests counted; OPTIONS, websocket, and unmatched-route requests skipped. Data point attributes per spec §7.1 plus `url.scheme` and `error.type` (status as string, 5xx only).

**D5 — process gauges implemented in-SDK.** `process.cpu.utilization` (cpuUsage delta normalized across CPUs), `process.memory.usage` (RSS), and `process.uptime` are three observable gauges on the private MeterProvider, ported from v0 `resources.ts`, observed in the worker's collection cycle (which yields the spec's timestamp pairing). Rationale for deviating from the community-package guidance: `@opentelemetry/host-metrics` is deprecated in favor of `@opentelemetry/instrumentation-host-metrics`; both accept a private MeterProvider and scope down to process-only instruments via `metricGroups`, but neither emits `process.uptime`, and the successor is a fresh 0.x version line — a new deliberately-pinned dependency that covers two of the three gauges is a worse trade than the ~40 ported lines.

## 12. Error handling and logging posture

Per `design.md` §12: every entry point wraps in try/catch, the SDK never breaks the app, warnings are reserved for actionable data loss, enrichment failures log at debug, repeated warnings deduplicate, the write token never appears unmasked in logs. Internal SDK diagnostics go through a minimal internal logger (console-backed, ~20 lines) gated on `APITALLY_DEBUG`.

## 13. Public API

Root entry (`apitally`):

- `useApitally(app, options)` — synchronous; duck-type framework detection (the v0 name kept: JS named imports strip the package namespace, so a bare `init` would say nothing at the call site — `design.md` §13's "each language's idiom" clause) (Express: function with `use`/`handle`; Hono: object with `routes`/`fetch`/`route`; extended per adapter phase); delegates to the matching adapter; a detection failure throws an error naming the framework subpath entry point. Adapters carry zero runtime framework imports (type-only), so the root entry stays small and side-effect-free.
- `setConsumer(identifier, { name?, group? })`, `setRequestAttribute(key, value)`, `captureException(error)` — resolved through the request-scoped span handle; no request/context argument. The handle is a holder installed into the OTel context by the transport middleware and filled by the span processor at SERVER-span start (filled directly by the middleware on the adoption path). The consumer holder additionally lets middleware outside the SDK's layers set a consumer that the processor writes onto the span at start; the consumer dimension survives sampling into metrics.
- `shutdown()` — async final drain (§4).
- `instrument(fn)` / `instrument(name, fn)` and `span(name, fn)` — manual tracing: INTERNAL child spans under tracer scope `apitally.otel`; `instrument` sets `code.function.name` from `fn.name` and file/line captured once at wrap time.

Per-framework subpaths (`apitally/express`, `apitally/hono`, ...) export the same `useApitally` with framework-specific typing plus framework-typed helpers. The root entry also exports `ApitallySpanProcessor` for explicit attachment to hand-built OTel setups (the D1 fallback).

**D6 — instrumentation helper wrappers are omitted.** `registerInstrumentations([...])` is already the JS one-liner (`design.md` §13 explicitly skips wrappers in that case); cooperation with user-registered instrumentations comes from the provider mechanisms in §8. `instrumentation-undici` is the one instrumentation the SDK enables itself at activation, and only when the SDK constructed its own tracer provider — on adopted setups the user's instrumentation set owns client-span production (`getNodeAutoInstrumentations` already includes undici; a second instance would emit duplicate CLIENT spans into the user's exporters). (diagnostics_channel based — no module hooks, respects `suppressTracing`; Bun's native fetch does not emit its events — documented gap.) A `--import` auto-instrumentation entry point is out of scope for 1.0 (demand-driven roadmap item).

0.x removals per `design.md` §13, plus JS-specific ones: `clientId` → `writeToken`; the hub client, request/error counters, and NDJSON request logger → OTel pipelines; `excludeCallback` → sampling callbacks; per-framework `setConsumer(req, ...)` and the `req.apitallyConsumer` / context-variable patterns → the root `setConsumer`.

## 14. Sentry integration

Auto-detect at activation via the `globalThis.__SENTRY__` carrier (no import of `@sentry/node`; the package is a types-only optional peer). With a client present, subscribe `client.on("beforeSendEvent", ...)`; for exception events, write `event.event_id` onto the active SERVER span as `apitally.exception.sentry_event_id` through the span handle. Failures log at debug. The carrier is version-keyed Sentry-internal state that differs across majors; spike 7 verifies client access per supported `@sentry/node` major — weighing the carrier walk against the public-API alternative (peer-resolved dynamic import + `getClient()`) — and the chosen path and supported major range are recorded here.

## 15. Cross-language posture

Shared invariants per `design.md` §15 with `telemetry.distro.name` = `apitally-js`. JS idiom: camelCase options, `Buffer` for body bytes, promises/async for callbacks, `AsyncLocalStorage` as the execution-context primitive, unref'd timers as the background primitive (the JS reading of "thread" — total background machinery: two batch processors plus one export worker timer).

## 16. Code style and testing

Carried in this repo's AGENTS.md (authored in phase 0 from `design.md` §16, modeled on the Python AGENTS.md). JS-specific rules recorded here:

- Node >= 20.6 syntax; TypeScript strict, ES2022, NodeNext resolution.
- Biome for linting and formatting; tsc for type checking; tsup (unbundled, dual ESM+CJS) for build; attw for package-shape checks.
- Never use `instanceof` across OTel package boundaries — duck-type on properties; the user's OTel objects may come from a different package copy.
- Dependency policy: OTel stable packages `^1.9.0`/`^2.9.0` and undici as regular dependencies; experimental OTel packages (`sdk-logs`, `api-logs`, `otlp-transformer`) pinned per-minor (`^0.220.0`) and `instrumentation-undici` (contrib repo, own version line) pinned per-minor (`^0.30.0`), all bumped deliberately via Renovate with CI proof; frameworks and log libraries as optional peers; `sideEffects: false` (everything happens inside `useApitally`).
- Testing per `design.md` §16: vitest; in-memory exporters/readers for shared modules; framework test clients driving small uniform real apps; a scriptable stub OTLP server only where the export transport is under test; a global setup that isolates OTel globals, the config singleton, env vars, and patches between tests (teardown-based resets — tests never pre-clean); a Bun smoke suite (`bun test`) covering the Hono integration on Bun.
- Test conventions: two-tier layout (`tests/shared/<module>.test.ts` mirroring source modules; per-framework integration dirs with a uniform app fixture); subject-predicate naming (`describe` = module/adapter name, `it` = present-tense behavior predicate, no `should`), with shared scenarios using identical `it` strings and the same canonical order across framework files; files ordered core behavior → edge cases → failure paths → shutdown, hooks at top. Scenario selection is contract-derived — each test pins a spec MUST, a settled design decision, or a plausible regression (authority cited in the plan) — with the Python suite mined as evidence, not authority. No wall-clock sleeps or fake timers: deterministic seams only (callable worker cycle, force-flush reads, pure jitter math, mtime manipulation). Assertions are exact-by-default: exact counts, full attribute equality, protobuf-decoded payloads in export tests; no snapshots. Coverage ownership: every behavior is asserted in exactly one home — the lowest layer that can observe it; `tests/shared/` owns core semantics, framework suites own adapter behavior, wiring, and the canonical cross-framework set (the only sanctioned duplication); helpers stay consolidated — extend an existing helper over adding a sibling.

## Deviation summary

| # | Deviation | Rationale |
|---|---|---|
| D1 | Attach to existing providers via internal processor list, with warn-and-instruct fallback (root-exported `ApitallySpanProcessor`) | OTel JS 2.x removed `addSpanProcessor` |
| D2 | Uniform release condition (transport completion AND span end) + per-request record replaces deferred export | SDK owns span end timing on the primary path; one mechanism covers owned and adopted spans |
| D3 | SDK middleware produces the SERVER span; adopts user spans when present | Module-hook instrumentations break one-line setup and Bun; middleware is the JS ecosystem norm |
| D4 | Log capture via SDK-owned patches (console/winston/pino) into the private LoggerProvider | Contrib logging instrumentations are require-hook based; winston bridge hard-codes the global provider |
| D5 | Process gauges implemented in-SDK (ported v0) | Community package (deprecated, mid-replacement) lacks `process.uptime`; a new 0.x dependency for two gauges is a worse trade |
| D6 | No instrumentation wrapper helpers; undici instrumentation only | `registerInstrumentations` is already a one-liner; everything else follows from provider cooperation |
| D7 | Code-location attributes omitted on log records | JS loggers lack cheap caller location |

## Verification spikes (resolve before or during phase 1, results recorded here)

1. Exact OTel 2.x internal shape for D1 attachment, across the supported version range, including `NodeSDK`-constructed providers; public `resource` property access.
2. `BatchSpanProcessor`/`BatchLogRecordProcessor`: constructor config precedence over `OTEL_BSP_*`/`OTEL_BLRP_*` env vars, per parameter.
3. otlp-transformer serialization byte-stability for identical input (dedup contract) and gzip determinism of the spool append path.
4. `sdk-logs` support for the native `eventName` field at the pinned version; fallback to the `event.name` attribute otherwise.
5. Exponential histogram downscaling in the export path: bucket-merge correctness down to scale <= 3 on real data points; delta temporality via reader selectors with last-value gauges unaffected.
6. `instrumentation-undici` under `suppressTracing` and with the proxy dispatcher (export traffic invisible; no span leakage).
7. Sentry client access per supported `@sentry/node` major: `globalThis.__SENTRY__` carrier walk vs peer-resolved dynamic `import("@sentry/node")` + `getClient()`; `beforeSendEvent` availability; record the chosen path and supported major range in §14; pin oldest/newest supported majors in the CI matrix.
