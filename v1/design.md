# Apitally OTel SDK Design

Language-agnostic design contract for Apitally v1 SDKs. Companion to `spec.md`, which owns the contract between SDKs and the OTLP ingestion path; this document owns the SDK-side architecture: the decisions every SDK implements, the rationale behind them, and the places where languages legitimately differ. The Python SDK (`apitally-py`) is the reference implementation; the shared `sdk-tests` suite verifies behavioral consistency across SDKs.

Normative keywords MUST/SHOULD/MAY per RFC 2119 mark cross-SDK invariants. "Latitude" callouts mark decisions each SDK makes for itself. Where this document states behavior without qualification, the reference implementation exhibits that behavior with a pinning test.

**Building a new SDK against this document**: (1) read `spec.md` and this document end to end; (2) write a language-specific design doc that maps each section here onto the target ecosystem, recording every deviation as a conscious choice with rationale; (3) review that doc before implementation starts — the review is where platform gaps (e.g. serverless disk, missing OTel APIs) get decided deliberately; (4) port from the reference implementation where shapes match; (5) verify against `sdk-tests`.

## 1. Product shape

v1 SDKs are OpenTelemetry distributions: they configure the official OTel SDK of their language and export OTLP directly to `otlp.apitally.io`. One-line setup is the #1 priority — the user needs no OTel knowledge. The SDK leans on stock community OTel instrumentations and adds Apitally-specific functionality (body capture, consumer attributes, startup event, redaction, sampling) as thin layers in SDK-owned code paths.

- Clean break shipped as a new major version under the same package name. Legacy versions keep working against the Hub indefinitely; v1 SDKs have no Hub support.
- Public alphas for early adopters, GA when feedback settles.

### Defaults out of the box

With only a write token configured:

| Signal | Default |
|---|---|
| Traces (SERVER spans + descendants) | on |
| Metrics (three request histograms + process gauges + uptime) | on |
| Logs (request-scoped, trace-correlated) | on |
| Exception capture (OTel exception events on SERVER spans) | on |
| Default redaction patterns | on |
| Default excluded path/user-agent patterns | on |
| Full capture (`sample_rate` 1.0; sampling is opt-in) | on |
| Request body content | off — opt-in |
| Response body content | off — opt-in |
| Request headers | off — opt-in |
| Response headers | on — opt-out |

One deliberate departure from 0.x that every SDK carries and every migration guide MUST call out: log capture defaults on (0.x was double opt-in; request-scoped logs are core to a strong default experience without payload data). There is no log-content redaction in v1: the redaction patterns apply to query params, headers, and body fields only; log messages export verbatim (settled decision — users who log sensitive data sanitize at source or disable log capture).

## 2. Integration with existing OpenTelemetry setups

The SDK detects whether the host application already has OpenTelemetry tracing configured and behaves accordingly. Only the tracer provider participates in this; the meter and logger providers are always Apitally's own.

- **Detection happens at activation (§4), not at setup**, through the OTel API's public accessor for the configured tracer provider. User OTel setup commonly runs inside startup/lifespan handlers; deferring detection to activation makes the outcome independent of where Apitally's setup call sits in the startup sequence. OTel setup that runs only after startup completes is a documented ordering limitation, not handled.
- **No existing tracer provider**: the SDK sets up its own tracer provider with an explicit request-rooted sampler. It records every SERVER span, including one under an unsampled upstream `traceparent`, and records a non-SERVER span only when it has a sampled local parent; every other span is non-recording. Request exclusion and sampling that require request data remain in the §5 processor. Passing the sampler explicitly also means the SDK never honors sampler-selection env vars. Accepted trade-off: SERVER spans propagate sampled=1 downstream.
- **Existing tracer provider** (user has Datadog, Honeycomb, their own collector): never replace it; attach Apitally's span processor additively. The user's sampler governs request-log coverage (their sampling rate applies); the request histograms (§11) are recorded in the transport middleware and stay complete regardless. At activation, warn once only when the user's sampler recognizably drops spans — checked by sampler type: always-off, ratio-based regardless of the configured ratio, or parent-based with such a root — naming the coverage consequence and the remedy; unrecognized custom samplers stay silent (§12 reserves warnings for known, actionable loss).
- **Meter and logger providers are always private instances**, never registered into the OTel globals — global registration would overwrite or race the existing pipelines of exactly the users who already have an OTel setup. They are passed explicitly only where Apitally consumes the output. Framework instrumentors never receive Apitally's meter provider: their built-in HTTP metrics fall through to the global provider (a no-op when no user metrics pipeline exists, the user's own pipeline when one does), so each party gets exactly the metrics they expect.

Latitude: the detection mechanism is per-ecosystem (a set-once global in Python/JS, DI composition in .NET, explicit wiring in Go). The invariants are: detect at serve time, attach additively, never replace or globally register.

### Attribute length limit

When the SDK sets up its own tracer provider, pin the span attribute value length limit to 65,536 on every setting that could constrain it (OTel SDKs often have both a general and a span-specific setting, with env vars overriding constructor defaults — pin all of them). 65 KiB comfortably fits a 50,000-byte captured body; a smaller limit would silently clip bodies mid-document, violating spec §6.3's never-truncated MUST. When attached to an existing tracer provider, the SERVER span belongs to that provider and the user's limits apply: when any capture toggle is enabled, inspect the provider's effective limit at activation and warn once if below 65,536. Documented limitation.

### Environment resolution

The `Apitally-Env` transport header (spec §4) MUST match `deployment.environment.name` on the resource. Resolve once at activation: with its own tracer provider, the SDK uses the configured env (option / env var / default `dev`) for both; with an existing tracer provider, it uses that provider's `deployment.environment.name` resource attribute when present, else the configured env, and never modifies the user's live resource. On conflict (the existing resource has an env and the configured env - option or env var - is a non-default value that differs from it) warn once and use the resource value; a configured value equal to the default does not trigger the conflict warning.

### Resource construction

The Apitally resource is built once at activation in both modes: through the standard OTel resource environment mechanism (`OTEL_SERVICE_NAME`, `OTEL_RESOURCE_ATTRIBUTES` are honored), then the Apitally-owned keys merged on top and winning: `service.instance.id`, `deployment.environment.name`, `telemetry.distro.name`, `telemetry.distro.version`. The env key must not be overridable via generic resource attributes because the transport header is derived from the same resolved value and the two may never disagree.

This resource always backs the private meter and logger providers. It backs spans too when the SDK sets up its own tracer provider. When attached to an existing tracer provider, the Apitally export copy preserves that provider's resource attributes except that `service.instance.id` is overwritten with the Apitally process identity. The user's live resource and other exporters remain unchanged. This gives traces, metrics, and logs one process identity and satisfies spec §5.

## 3. Configuration

### Precedence (highest to lowest)

1. Explicit options passed to the setup call.
2. `APITALLY_*` env vars.
3. `OTEL_*` env vars where semantically equivalent.
4. Apitally defaults.

The options layer needs an absent-vs-default distinction so an omitted option keeps env-var fallbacks in effect (mechanism per language).

### Env vars

| Env var | Maps to | Notes |
|---|---|---|
| `APITALLY_WRITE_TOKEN` | `write_token` | Format `apt_` + 24 alphanumerics per spec §3. |
| `APITALLY_ENV` | `env` | Default `dev`. |
| `APITALLY_DISABLED` | `disabled` | Truthy → never activate. Accepted truthy values: `1`, `true`, `yes` (case-insensitive, whitespace-trimmed). |
| `APITALLY_OTLP_ENDPOINT` | endpoint override | Testing only. No code-level option. |

A missing or format-invalid write token logs an error (with the token masked to a short prefix — it is a bearer credential and must never appear verbatim in logs) and force-disables the SDK; the app runs untelemetered.

`OTEL_SDK_DISABLED` is respected (user explicitly disabled OTel) and follows normal option-over-env precedence; it parses the same truthy values as `APITALLY_DISABLED`. `APITALLY_DISABLED` is additionally re-checked at the activation boundary, where it wins even over an explicit `disabled=false` — it is the emergency kill switch. All `OTEL_EXPORTER_OTLP_*` endpoint/protocol/header vars and sampler-selection vars have no effect on Apitally's export — structurally guaranteed because the SDK owns its export POSTs (§10) and passes its sampler explicitly (§2). This matters: users running another OTel backend set these vars for that backend, and Apitally traffic must not be redirected by them.

### Immutability and re-call semantics

The first setup call wins; configuration is immutable from then on. Components bind config and derived state (compiled patterns, redaction tables) once at construction — there is no refresh path. A re-call resolving to the same configuration is a silent no-op (settings modules import twice, app factories run repeatedly — legitimate re-calls must stay quiet); a re-call with different configuration warns and is ignored. Re-call semantics apply to the configuration only: every setup call still wires the app object it is passed (guarded per app), so an app factory produces instrumented apps on every call while the first call's configuration stays in effect.

Invalid `sample_rate` values silently resolve to capture-everything (no data is lost, so per the §12 posture there is nothing to warn about). Invalid regex patterns in the user-supplied pattern options are individually dropped at configure time with an error log — a silently kept-but-broken redaction pattern would mean unredacted data — and the remaining patterns stay in effect.

### Semantic conventions

The SDK MUST emit stable HTTP semconv (spec §6.1) without changing what a coexisting user backend receives. Where the language's instrumentations default to old-convention names behind a process-global opt-in, set the opt-in to dual emission only when unset and always respect a user-set value — stable names for Apitally, old names preserved for existing user backends whose dashboards depend on them. Old-name fallbacks are retained at every SDK read site (exclusion matching, query redaction) for spans produced by user-owned instrumentation that initialized with old names only.

## 4. Lifecycle: configure, activate, shut down

Setup is split into two phases so that importing an app never starts telemetry.

**Configure (eager, at the setup call)**: record and validate configuration, wire middleware/instrumentation, register hooks. No threads, no network, no fork-unsafe state.

**Activate (gated on evidence the process is serving)**: detect whether a user tracer provider exists and set up or attach accordingly (§2), run the deferred inspections (sampler, span limits, env resolution), build the pipelines, start the export worker, emit the startup event. Triggers per platform class: server-lifecycle startup completion where the platform has one (trigger on startup *completion*, not receipt, so the app's own startup handlers — a common home for user OTel setup — run first), with first-request as the universal fallback; frameworks with a pre-request signal use that. Processes that never serve therefore never appear as online instances: test collection, queue workers, migration scripts, and REPLs import the app (configure runs) but never activate. Pre-fork server masters configure but never activate; each worker activates itself.

- **First-request guarantee**: the activation trigger MUST fire before the triggering request's SERVER span starts, so the first request is recorded normally. Concurrent first requests block until activation fully completes — no request proceeds past the gate against a half-activated pipeline.
- **Test-environment detection** runs once at the activation boundary: ecosystem test-runner markers (e.g. the language's test framework env var), `APITALLY_DISABLED`, and the `disabled` option all skip activation permanently.
- **Activation is attempted at most once per process**: a failure during activation logs at error level and the process serves untelemetered permanently — triggers never re-attempt.
- **Per-request context isolation**: a request's SERVER span must start as a local root. Runtimes with implicit context inheritance can leak the previous request's telemetry context into the next one (e.g. async servers starting a pipelined request's task from inside the previous request's context), which demotes the new SERVER span to a child of an ended span and silently drops the request. SDKs on such runtimes MUST run each request under a fresh telemetry context at the outermost SDK-owned layer (skipped when a user's own instrumentation wraps outside the SDK, since the SDK then runs inside the user's SERVER span).
- **Graceful shutdown MUST flush**: hook the framework/server's graceful-shutdown signal (server lifecycle shutdown event, host lifetime hooks) where the platform exposes one, and drain buffered telemetry through a final export cycle (§10). Process-exit hooks alone are insufficient — servers commonly re-raise termination signals with default handlers after graceful shutdown, skipping exit handlers entirely. Register both where possible; the exit hook is the floor on platforms without a shutdown signal. Termination-signal handlers, where installed, MUST be bounded, preserve application lifecycle ownership when another handler exists, and restore the signal's original termination behavior when the SDK is the sole handler.
- **Fork safety** (only for runtimes where processes fork after activation — largely a Python/Ruby concern): stop all SDK threads before a fork, rebuild with fresh instances in the parent after (same instance identity, exports resume), reset the child to configured with no auto-activation — the child of a serving process is a worker, not a server.

## 5. Request model: span filtering and exclusion

Apitally ingests only request-rooted traces. One mechanism enforces this whether the SDK set up the tracer provider or attached to an existing one: a span processor wrapper in front of Apitally's export path. It is the single keep/drop decision point; on an existing provider the user's other exporters still receive every span, background work included — only Apitally's path filters.

**Classification at span start**: a span whose parent is absent or remote is a local root. A local root of kind SERVER enters the in-flight request map as kept, carrying its own span id as the request key; any other local root enters as dropped; a child inherits its local parent's entry and stays resolvable by its own span id until the request completes, and a lookup miss defaults to dropped. Apps behind an instrumented gateway or mesh receive `traceparent`, so their SERVER spans have a remote parent — they are still the request boundary (spec §6).

**Exclusion, decided at the same point** — a SERVER span that would enter as kept instead enters as dropped when:

- its method is `OPTIONS` (CORS preflight);
- its URL scheme is a websocket scheme (`ws`/`wss`) — long-lived connection spans are not HTTP requests in Apitally's model;
- its path (query stripped) or user agent matches an exclusion pattern — defaults per spec §6.8, user path patterns added on top;
- old-convention attribute fallbacks are honored in all these reads, and when the instrumentation omits the path attributes entirely, the SDK derives path and query from the full-URL attribute at span start and writes them onto the span — the exported span's display URL and the query redaction pass depend on them, and exclusion matching must never silently no-op because an attribute is missing.

Transport integrations bypass requests with `Upgrade: websocket` before observation, but only after activation so WebSocket-only applications still emit startup and liveness telemetry. The framework's response object passes through unchanged because it can carry runtime-specific upgrade metadata.

Exclusion runs strictly before sampling: exclusion answers "never wanted", sampling answers "how much of the wanted", and an excluded request never invokes a user sampling callback. Metrics recording (§11) is independent of all of this: pattern-excluded and sampled-out requests are still counted; OPTIONS, websocket, and unmatched-route requests are not (spec §7.1).

**Per-message spans** (spec §6.6): suppress the instrumentation's per-message receive/send INTERNAL spans at the source wherever the integration point allows it, and additionally drop them in the span processor by kind + name suffix + instrumentation scope for instrumentations that emit them anyway (including user-owned ones). Websocket send/receive variants included.

The map entry carries the request's SERVER span id so the log pipeline (§9) can set the request-linkage attribute on log records emitted inside arbitrarily nested child spans, with no dependency on execution context or middleware order.

## 6. Sampling and per-request buffering

### Two-stage sampling

Sampling refines what §5 kept, via a static rate and two optional callbacks that receive the SERVER span and return a keep probability:

- **Request stage, at SERVER span start**: `sample_on_request` resolves an effective rate — boolean maps to 1.0/0.0, a float in [0,1] is used as-is, absent/abstain falls back to `sample_rate`. A sampled-out request transmits nothing, ever, and skips capture work (body buffering, header collection); framework-specific buffers that necessarily fill before the span exists are discarded once the decision is known.
- **Response stage, when the SERVER span is released for export** — at span end normally, at the transport's completion signal when export is deferred (below), at shutdown for spans still held there: `sample_on_response` only; abstention leaves the request-stage decision standing (it never re-tests `sample_rate`). Lets users sample on outcome: status code, consumer, custom attributes set via `set_request_attribute` — including attributes attached after span end on deferred spans (final route, response size).
- **Deterministic by trace ID**: both stages test the span's trace ID against the resolved rate using the standard ratio-sampler convention — keep iff the low 64 bits fall under `round(rate * 2^64)`. Services sampling at the same rate capture the same traces, and because both stages test the same value, the overall capture probability is the minimum of the two rates, not their product — emergent from the shared test, not computed.
- A raising or invalid-returning callback warns and resolves to keep (fail open — never lose data to a user bug silently).

### Per-request buffering (uniform export model)

A request's telemetry is exported when the request completes — one behavior for every request. Ended descendants buffer in the span processor and the request's log records buffer in the log pipeline, keyed by the SERVER span id, until the response-stage decision. Buffers and in-flight map entries stay alive until that decision runs, so telemetry emitted during response streaming still buffers and flushes or discards with its request. Keep flushes descendants, then the SERVER span, then the request's logs — and from that point the request's late-ending spans and late log records export immediately without buffering. Drop discards everything, removes the request's span ids from the in-flight map so late telemetry falls to the lookup-miss rule and drops locally, and releases any stashed payloads unprocessed — a response-stage drop exports nothing and consumes no quota. Buffers are bounded per request: 1,000 spans and 1,000 log records (Sentry parity); once a cap is reached, new arrivals are dropped and the earliest 1,000 are kept.

Nothing about a request is reachable server-side without its SERVER span (spec §6.5), which is what makes abandoning already-buffered telemetry safe.

### Deferred SERVER-span export

Transports can commit, at response start, to releasing the SERVER span themselves: the processor holds the ended span until the transport finishes, attaching attributes learned after span end — final response size, streamed response body — to the exported snapshot. Without this, streaming responses cannot be captured correctly, because the instrumentation commonly ends the SERVER span before the response iterable/stream completes. Deferral covers every streaming response, sized or not, sync or async: a declared Content-Length settles the reported size but not the timing — the request's duration and its metrics observation are recorded when iteration of the content completes, not when the handler returns (finalizing at handler return reports near-zero durations for streams). The completion signal can arrive in either order relative to span end: when the transport finishes first (the common non-streaming case), the deferral is cancelled, the late attributes are written onto the still-recording span, and export happens normally at span end. SDKs whose transport layer can observe the complete response strictly inside the span's lifetime don't need the mechanism; the portable invariant is that late-learned response attributes MUST still reach the exported span.

**Shutdown semantics**: processor shutdown exports held (ended-but-deferred) SERVER spans, running their response-stage decision; buffers of still-open requests are discarded — an in-flight request's SERVER span can never export after shutdown, so its held telemetry is unreachable by construction.

## 7. Capture pipeline: bodies, headers, sizes, redaction

### Capture decisions are header-only

Both capture decisions cost zero body I/O for requests that won't be captured:

1. **Content-type allowlist first** (spec §6.3), from headers, before any body is read or buffered. Outside the list the body is never touched.
2. **Size cap**: 50,000 bytes. A header-declared over-cap body short-circuits to the `[BODY_TOO_LARGE]` sentinel without reading a byte; a body that crosses the cap while accumulating discards the buffer and sets the sentinel. Never export a truncated body.
3. **Complete bodies only**: a partial buffer from a request or response that aborts mid-stream MUST NOT be exported — suppressed entirely, never sentinel'd. The completeness requirement applies to buffered payload bytes only: once the `[BODY_TOO_LARGE]` sentinel is triggered (by header or by crossing the cap), it is exported even if the stream never completes, and response headers are still exported for aborted responses. Whether an aborted response's size is exportable depends on transport mechanics — per-SDK latitude.

On synchronous CGI-style transports, capture request bodies only when a parseable Content-Length is present and never read past it: EOF simulation is optional in such server specs, and raw-socket servers block on over-reads. Chunked/absent-length request bodies are not captured there. On async message-based transports, accumulate chunks with a running length check, always forwarding every chunk.

### Captured payloads are invisible outside Apitally

Captured header and body payloads MUST never be visible to user-owned exporters and MUST be redacted before leaving the process. The reference implementation achieves both structurally: transports never write payload content onto the live span (the size attributes are the only capture-related attributes visible to user exporters); raw bytes and the `[BODY_TOO_LARGE]` sentinel travel in an SDK-private stash attached to the exported span copy, and masking, redaction, and attribute injection run on the export thread at the last SDK-owned point before bytes leave the process. This also keeps regex/JSON work out of request handling, and dropped requests never pay for processing. A span that fails redaction is dropped, never exported raw (fail closed). Latitude: the stash-and-export-thread mechanism is one implementation; an SDK whose threading model differs may redact at flush, but the three invariants (invisible to user exporters, redacted before export, processed outside request handling) hold everywhere.

### Body processing order

Mask callback → parse → redact → serialize, on the captured bytes: `mask_request_body`/`mask_response_body` receive the SERVER span and the raw body and their return value replaces it; returning nothing, raising, or returning the wrong type yields the literal `[REDACTED]` (fail closed — never export a body the user tried to mask); an over-cap masked result becomes `[BODY_TOO_LARGE]`. A stashed `[BODY_TOO_LARGE]` sentinel bypasses this pipeline entirely — the exporter recognizes it and writes it through unchanged, so mask callbacks never see it. Whether a body is JSON is decided by a parse attempt on the captured bytes, never by Content-Type; parsed bodies are field-redacted (spec §6.7 patterns; user patterns extend defaults, never replace) and re-serialized compactly, parse failure falls through to the text/bytes path. Non-JSON text exports as text; non-UTF-8 bodies are preserved losslessly as bytes-valued attributes (the server accepts bytes-valued, optionally gzip-compressed body attributes). Mask callbacks MUST NOT assume a live/mutable span or same-thread execution — document the callback contract as "may run later, on another thread, against an ended span snapshot". The snapshot is the span as it will be exported — query/header redaction applied, captured header attributes attached — without the body attributes.

### Headers

When a per-direction toggle is on, all headers are captured and redacted before export — a redacted header keeps its name and exports exactly one `[REDACTED]` element (list-valued per semconv) regardless of how many values the header had. Captured `Location` and `Content-Location` headers contain URLs: their query strings pass through the same query-param redaction as request targets. Keys use the stable-semconv normalization (lowercase, dashes preserved); redaction matching also covers the legacy underscore normalization emitted by older instrumentations, and the query/header redaction pass at the export boundary additionally covers header and query attributes set by user-enabled instrumentation capture, in either normalization, on a rewritten copy (the original span is never mutated — user exporters see it untouched).

Query-param redaction is SDK-owned: stock instrumentations set query attributes raw, and their built-in URL redaction does not satisfy spec §6.7. Apply the patterns to every query-bearing attribute (stable and legacy names, full-URL attributes included) on all spans passing through Apitally's export path.

### Body size attributes

`http.request.body.size` / `http.response.body.size` are set by the SDK independent of the capture toggles (no stock instrumentation sets them as span attributes). Request size from Content-Length, backfilled from a running byte count whenever the capture path observed the stream to completion — independent of whether the capture buffer survived, so over-cap and capture-disabled requests still get the true size; response size from Content-Length when present (not trusted when combined with chunked transfer encoding), else a running byte counter finalized when the response completes (streamed responses included). Unknown size skips both the attribute and the corresponding histogram observation — the same value feeds both, so request logs and metrics agree by construction.

## 8. Transport observation, routes, frameworks

### Transport position and coverage

The SDK's transport layer (the middleware/handler wrapping that observes requests and responses) MUST observe every response — including responses synthesized by the framework's outermost error handler for unhandled exceptions, and unmatched-route responses. If the only way to achieve that is sitting outside the span-creating instrumentation layer, that is fine: the transport reaches the SERVER span through a request-scoped span handle set at span start (§13), and commits to deferred export (§6) so attributes learned after span end still attach. SDK-created spans use the recorded transport completion time as their end timestamp even when body capture or other enrichment finishes later. The original v1 rule ("transport must run inside the SERVER span") was abandoned when it proved to miss error-handler responses and streamed-response finalization.

Frameworks that convert unhandled exceptions into responses before the instrumentation sees a raise need an SDK-owned capture point so the exception event is still recorded on the SERVER span. Framework error hooks record exceptions with an unknown status or a 5xx outcome and suppress expected HTTP control flow below 500; when an error handler returns a response, its final status is authoritative. Languages with aggregate error types SHOULD record the single leaf when an aggregate wraps exactly one error - hiding the real type behind the wrapper defeats error grouping.

`client.address` uses the framework's resolved client IP when the framework exposes one, so its configured trusted-proxy policy remains authoritative. Shared transport code never parses forwarding headers because it cannot know which network peers the application trusts; without a framework resolver it uses the socket peer address.

### Route templates

`http.route` — on the span and as the metrics label — MUST always be the parameterized route template, never the raw path. The span name SHOULD follow the `{method} {route}` convention; where the instrumentation names spans with the framework's native route syntax, matching `http.route` exactly is not required. And:

- **mount prefixes included**: route resolution inside mounted sub-apps/routers loses the mount prefix in every framework that supports mounting; the SDK restores it (the reference implementation compares the path prefix between request entry and completion, framework-agnostically);
- **no route means no route**: unmatched requests carry no route — and where stock instrumentation writes a *wrong* route on unmatched requests (e.g. the raw path), the SDK actively clears it, so 404s never aggregate by raw path. The SERVER span is still exported with an empty route (spec §6.1); the histograms skip it (spec §7.1).

### Framework composition principles

- **Stock instrumentation produces the SERVER span and standard attributes; the SDK adds only what's missing** (capture, sizes, consumer attribution, histograms, startup event, Sentry linkage) — all of it in SDK-owned code paths (transport layer, activation, span-handle context), never in instrumentor hooks. Hooks are a fragile dependency: they are silently discarded when the user already instrumented the framework, and the histograms' sampling-independence rules out recording them in the span pipeline anyway.
- "Stock instrumentation" may mean composing the underlying generic HTTP-server instrumentation directly when the framework-specific wrapper is too rigid (e.g. lacks span-suppression options) — the SERVER-span semantics matter, not the package name.
- **Already-instrumented apps: detect and adapt silently.** When the user instrumented the framework themselves (directly or via auto-instrumentation), skip the SDK's instrumentation call, reuse their SERVER spans (the SDK attaches its span processor to their provider, §2), and rely on the §5 span-processor check to drop their per-message spans. Nothing degrades because none of the SDK's functionality depends on instrumentor hooks, so nothing warrants a warning. Documented limitation: user instrumentation bound to an explicit non-global provider routes SERVER spans past Apitally entirely.
- **Never assume the instrumentation set every attribute the SDK reads** — normalize missing attributes at span start (§5's path derivation is the canonical case).
- **Version floors are validated against behavioral correctness, not API surface** — the reference implementation raised framework floors because older versions leaked request context across keep-alive requests, silently dropping telemetry. Check context-propagation correctness explicitly when setting floors.
- Setup-time helpers (route/schema enumeration) load lazily so the setup call is safe from config files that run before the framework initializes.

## 9. Logs

- **Capture surface**: each SDK captures application logs from its ecosystem's dominant logging interface(s) — the standard library logger where the language has one (Python `logging`, Go `slog`), the standard logging abstraction (.NET `ILogger`), or a chosen set of major logging libraries where no standard exists (JS: e.g. the contrib instrumentations for `winston`/`pino`, plus `console`). The chosen surface is recorded in the language design doc, favoring interfaces that can be captured without changes to the user's logging setup. Capture hooks in at the most permissive level (user-configured per-logger thresholds still apply) and routes records into Apitally's private logger provider — installed directly, never via an instrumentation entry point that wires the global provider. User-owned logger providers are never touched: logs emitted through the user's own OTel setup stay in the user's pipeline, like their spans stay in their exporters. Captured records carry code-location attributes (`code.file.path`, `code.line.number`, `code.function.name`) where the logging framework provides them — they feed the file/line display on application logs (spec §8). Default on; `capture_logs=false` disables only the capture surface — the private logger provider and the startup event are unaffected.
- **Request linkage**: every exported record MUST carry `apitally.request.server_span_id` (lowercase 16-hex, spec §8), resolved by looking the record's emitting-span id up in the §5 in-flight map — the emitting span is typically a nested child, and the map inherits the SERVER span id downward, so linkage works at any nesting depth with no execution-context dependency.
- **Drop rule**: records that resolve no SERVER span id are dropped, except records under the `apitally` instrumentation scope (preserves the startup event, which has no request context).
- **SDK log exclusion**: records from the SDK's own loggers and the OTel SDK's loggers are never bridged — the SDK's own logging never appears in customer request logs, and export failures cannot feed back into the export. They still reach the user's own log handlers.
- **Buffering**: request logs buffer and flush/discard with the §6 response-stage decision. Dropping records from non-kept requests before translation into the OTel representation is an optional per-SDK optimization.
- String log bodies and string attribute values are truncated to 2,048 characters at export (hard cut, no marker); non-string values pass through unmodified. `apitally`-scoped records are exempt (the startup event legitimately exceeds it).

### Startup event

Emitted once per process at activation, per spec §9: a log record under scope `apitally` with event name `apitally.app.startup` and a JSON-string body carrying `framework`, `versions` (language runtime always included), `paths`, and `openapi` (omitted above 4,000,000 bytes; `paths` remain). Route/schema data is resolved lazily at emit time — routes commonly finalize after setup. Emitted directly on the private logger provider, bypassing the log capture surface. The `framework` value is informational — stored and displayed as the app's client (route normalization is keyed on the framework selected for the app in the dashboard, not on this value).

## 10. Export pipeline

The SDK owns its OTLP export end to end: stock batch processors as intake, a disk-backed write-through spool for durability, and a single export worker that sends spool files over HTTP/protobuf. There is no stock OTLP exporter in the path and no custom retry beyond what this section defines (spec §10: rely on defined retry semantics, nothing bespoke).

**Why HTTP/protobuf only**: traverses every CDN, proxy, WAF, and corporate egress path; gRPC needs HTTP/2 end-to-end and ships heavyweight dependencies; Apitally's throughput is below where gRPC's efficiency wins.

- **Intake**: the language's stock batch processors with a ~1s schedule delay and all parameters passed explicitly, so user-facing OTel batch env vars never tune Apitally's private pipeline. Ended telemetry leaves RAM within ~1s; the in-memory queue is a short pass-through, disk is the retry buffer.
- **Spool format**: each drained batch is encoded to OTLP protobuf and gzip-appended to a per-signal temp file as one continuous gzip stream. Concatenated same-type protobuf messages parse as one valid merged request, so a closed file is sent verbatim as a single OTLP POST body — serialize once, compress once, replay byte-identically (server-side dedup is content-hash based, so retries must be byte-identical).
- **Rotation**: 4 MB uncompressed per file, checked before append so no closed file exceeds it (bounds compressed size safely under the server's payload caps). This only holds when batches are encoded and appended in bounded sub-chunks (the reference: 32 records per append) — a full batch appended as one payload could overshoot the threshold with large captured bodies. At export time a signal's current file is rotated only when no closed files are waiting — during an outage the current file grows instead of producing one file per cycle.
- **Send loop**: one worker sends closed files oldest-first every interval — default 15s, first export ~2s after start, ±10% jitter, a per-cycle cap of 10 files, and a random 0.1–0.5s pause between sends within a cycle, all to prevent fleet-synchronized recovery bursts. Every export POST uses a 10s timeout. Export POSTs honor the standard proxy environment variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`), resolved once at configure time and bound to the worker — never re-read per request. Each cycle runs under OTel's instrumentation-suppression context so the worker's flushes and its own POSTs never generate spans or logs — without it, a user's HTTP-client instrumentation would trace every export request. The server can adjust the interval via the `Apitally-Export-Interval` response header (integer seconds, clamped to [5, 60] — the ceiling keeps at least one export per minute so the liveness contract's staleness stays bounded).
- **Failure handling**: retryable (connection errors, timeouts, 408, 429, 5xx) leaves the file queued — one probe POST per cycle during an outage, and the outage path is the same code path as normal operation, exercised every cycle, so it cannot silently break. Other 4xx is permanent: drop the file, warn once per status per process. One immediate inline re-POST on connection error covers stale keep-alives. Retry pacing comes exclusively from the export cycle: `Retry-After` headers and gRPC `RetryInfo` payloads are not parsed — the server adjusts client send behavior through the `Apitally-Export-Interval` header instead.
- **Retention**: a file expires 59 minutes after its *first* send attempt (an attempted file may have been ingested with the response lost; re-sending outside the server's 1h dedup window would double-ingest). Never-attempted files never age out — they have provably never been published. Size caps (50 MB on disk, 10 MB in memory, measured on the compressed stored bytes) evict oldest closed files first, preferring non-metrics files (metrics carry the liveness signal and must survive an outage); the bound is absolute — once only metrics files remain, the oldest metrics file is evicted.
- **Filesystem probe and memory fallback**: probe the temp dir for writability at construction; on failure, fall back to in-memory buffers with a single warning. This is the uniform mechanism for read-only/serverless filesystems, not a separate code path. A write failure after a successful probe discards the current file for that signal with a warning (deduplicated until writes recover); there is no mid-flight switch to memory. Orphaned spool files from dead processes are cleaned up by age — untouched for 2 hours, checked once at spool construction, identified by the spool's recognizable filename pattern; live processes keep theirs current by updating the file modification times each cycle. Spool files are never deleted from finalizers, so abandoning an inherited spool after a process fork is safe.
- **Metrics collection is driven by the export worker**: the metric reader is non-periodic; the export worker collects each cycle, so traces, logs, and metrics export in the same cycle and the liveness signal (spec §7.3) follows the export interval. Delta temporality makes collect-at-any-cadence correct. Latitude: the reader mechanism is per-SDK; the invariant is all three signals in the same cycle.
- **Final drain**: graceful shutdown (§4) runs one final cycle — flush the batch processors, collect metrics, close all current files, and send. The drain skips the inter-send pauses and ignores the per-cycle file cap: every pending file is sent, so a backlog built up during an outage is fully delivered instead of being stranded beyond the first ten files.

Total background thread count in the reference implementation: three (two batch workers, one export worker). Keep the thread count of the same order.

## 11. Metrics

Per spec §7: three request histograms (duration anchor + two sizes) under instrumentation scope `apitally`, exponential buckets starting at scale 3, delta temporality — configured explicitly because OTel defaults (explicit buckets, cumulative) are dropped by the server. The aggregation overrides apply to histogram instruments only, so gauges keep last-value semantics.

- Recorded in the transport middleware at request end (for streaming responses, when iteration of the content completes, §6), independent of the span pipeline — sampling-independent by construction. Excluded and sampled-out requests are counted; OPTIONS, websocket, and unmatched-route requests are not.
- Data point attributes: `http.request.method`, `http.route`, `http.response.status_code`, `apitally.consumer.identifier` (the server's aggregation key — omit consumer when none); `url.scheme` SHOULD be set, and `error.type` is the status code as a string, set for 5xx responses only.
- Process gauges: `process.cpu.utilization` and `process.memory.usage` via the language's community process-metrics package where one exists, configured to emit only those two instruments, observed in the same collection cycle (the spec's timestamp pairing falls out of that); `process.uptime` implemented by the SDK in every language (no ecosystem package provides it) — its value is unused; it exists to keep every metrics export non-empty so the server receives a liveness signal every interval.

## 12. Error handling and logging posture

**The SDK never breaks the app.** Errors never propagate to user code; every entry point wraps in the language's catch-all (excluding process-fatal signals). A setup error logs at error level and the app still starts, untelemetered if need be.

**Quiet by default.** Warnings are reserved for conditions where Apitally data is being lost, degraded, or misattributed AND the user can act on it — each names the consequence and the remedy. Everything else (provider setup choices, adaptation to existing instrumentation, lifecycle transitions) is debug-level on SDK-namespaced loggers. When the SDK adapts automatically with nothing lost, it adapts silently. Best-effort enrichment failures (`set_consumer`, `set_request_attribute`, exception capture, Sentry linkage) log at debug — a lost attribute is not actionable data loss. Writes to an already-ended span are silent no-ops. Repeated-condition warnings are deduplicated where a condition can recur indefinitely (e.g. export rejections dedupe per status code).

**Credential invariant**: error paths never interpolate the raw write token into log messages; log a masked short prefix only.

Users must still be able to tell when something is broken: real failures produce visible errors in logs; the SDK never quietly does nothing.

## 13. Public API

### Setup

The primary setup surface is one unified `init` function at the package root: `apitally.init(app, ...)` takes the app object plus the full set of explicit typed options, detects the framework from the app instance, and delegates to the matching framework integration. Detection inspects the app's type ancestry for a known framework and unwraps middleware wrappers (which hold the wrapped app in a conventional attribute) before giving up. Global-configuration frameworks (e.g. Django) are set up by calling `init()` without an app from the framework's configuration site (end of `settings.py`); the SDK detects them by the framework being loaded. When detection fails, `init` raises a clear error that names the framework-specific entry point as the fallback. The function name follows each language's idiom for a plain setup verb; the shared identifier is `apitally`.

The framework integrations keep their own `init` functions and remain individually importable as the explicit path when detection cannot work. The full explicit option signature lives once, on the unified entry point — integrations declare only the options they consume themselves (framework-specific ones plus `app_version`) and pass the rest through to configuration. Framework-specific options also appear on the unified entry point and are forwarded only when explicitly set, so their defaults stay in the integration. IDE autocomplete and type checking must work on the unified entry point.

Frameworks that only accept instrumentation at construction time (e.g. Litestar) keep the framework's native plugin/extension pattern with the same options and the same configure/activate path; the unified `init` rejects such apps with an error pointing at the plugin. Where the language makes a single detecting entry point impractical — e.g. Go, where one package importing every supported framework would pull all of them into every user's build — the SDK keeps per-framework entry points instead; the choice is recorded in the language design doc.

### Shared options

`write_token` (required, env-var fallback), `env`, `app_version` (feeds `versions["app"]` in the startup event), `disabled`, `capture_logs`, `sample_rate`, `sample_on_request`, `sample_on_response`, `mask_request_body`, `mask_response_body`, the four per-direction capture toggles `capture_request_headers` / `capture_request_body` / `capture_response_headers` / `capture_response_body` (only `capture_response_headers` defaults on), the three per-target redaction pattern lists `mask_query_params` / `mask_headers` / `mask_body_fields` (each extends the spec §6.7 defaults for its target), excluded path patterns (extend defaults). Names follow each language's casing; semantics per §§3, 6, 7. Framework-specific extras are fine.

### Runtime surface

| Function | Purpose |
|---|---|
| `set_consumer(identifier, name?, group?)` | Sets `apitally.consumer.*` on the active SERVER span (caps per spec §6.2, whitespace-stripped). |
| `set_request_attribute(key, value)` | Arbitrary attribute on the active SERVER span; pairs with `sample_on_response`. |
| `capture_exception(error)` | Records an exception event on the active SERVER span. |

All active-SERVER-span write sites resolve the span through one request-scoped handle set by the span processor at SERVER-span start — for every local-root SERVER span, independent of the keep decision (keep/drop is enforced solely at span end, so writes to a span that will be dropped stay local; and the handle always reflects the *current* request, never a stale one from a reused execution context). Getting the "current span" from OTel directly is wrong under any child span, and OTel has no public upward walk.

Consumer identity additionally lives in a request-scoped holder installed by the transport at entry: the transport adopts a consumer already set by middleware running *outside* the SDK's layers (before the SERVER span exists) into the request's holder, and the span processor writes any held identity onto the SERVER span at span start — attribution works regardless of where in the middleware chain the user sets it. The consumer dimension survives sampling: a sampled-out request's consumer still reaches metrics.

### Manual tracing

Every SDK SHOULD offer a minimal manual-tracing surface in idiomatic form: a function wrapper and a block form (Python: the `instrument` decorator and the `span` context manager) creating INTERNAL child spans under tracer scope `apitally.otel`, with code-location attributes (`code.file.path`, `code.line.number`, `code.function.name`) on wrapped functions. These exist for the §1 goal — users add child spans without learning OTel APIs. SDKs SHOULD also offer one-call setup wrappers for the ecosystem's popular contrib DB/HTTP-client instrumentations (Python: `instrument_httpx`, `instrument_sqlalchemy`, ...) where those instrumentations need configuring; ecosystems where registering an instrumentation is already a one-liner skip the wrappers. The exact set is per-SDK, recorded in the language design doc.

### Shared 0.x removals

`client_id` → write token. Bespoke transport/payload code → OTel pipelines. `exclude_callback` → the sampling callbacks (note the reversed meaning: they return keep, not exclude). `consumer_callback` → calling `set_consumer` from auth middleware (the request-scoped mechanism makes it framework-independent). Validation/server error capture → derived server-side from traces; SDKs emit nothing.

## 14. Sentry integration

Auto-detect at setup: if the Sentry SDK is present, hook its event pipeline and copy the event id of exception events onto the active SERVER span as `apitally.exception.sentry_event_id`. No opt-in flag — installing Sentry is the consent. Only the event id crosses the boundary. Hook point per SDK; prefer the event-processor pipeline over "last event id" style accessors.

## 15. Cross-language posture

Shared across all SDKs (uniform, spec- or server-constrained): env var names, option semantics and defaults, attribute names, instrumentation scope `apitally`, `telemetry.distro.name` = `apitally-<lang>`, the exclusion/redaction default patterns, the sampling convention, buffer caps, the spool thresholds and retention rules, the export-interval header contract, and the never-break-the-app posture.

Idiomatic per language: entry-point verbs and option casing, callback/handler shapes, concurrency machinery, framework-integration mechanics, dependency layout. Where this document says "thread", read "the language's background execution primitive".

## 16. Code style and testing

Binding for every SDK. Each repo's AGENTS.md carries the language-specific version of these rules; this section is the cross-SDK source they derive from.

### Code style and naming

- Write the least amount of code that gets the job done, in modern idiomatic style for the language, within the SDK's supported version range: use the syntax the floor version allows, nothing that requires a newer runtime.
- Plain, precise English names. No invented shorthand, metaphors, or informal jargon. A term qualifies only by referring to an actual thing in the codebase or its dependencies: "deferred export" (the `defer_export`/`finish_export` methods), "SERVER span" (OTel `SpanKind.SERVER`), "transport middleware", "spool", "stash". Prefer a longer clear name over a compact clever one; vague verbs need an object or a from/to.
- Boolean predicates read as questions (`is_`/`should_`/`has_` per language convention), never as imperative commands.
- A function's name states what it actually does, including its outcome: a function that only logs a warning is `warn_if_sampler_drops_spans`, not `check_sampler`.
- One concept, one name across modules.
- Comments are sparse and concise (one or two lines). A comment states something the code cannot: a constraint, an external system's behavior, or the reason for a choice — the WHY, never a narration of the WHAT. Name the real component, never a metaphor. No historical references: nothing about the 0.x SDK, "previously", or "ported from".
- Module layout is deliberate: public entry points first, helpers after, so the module reads top-down. No single-use helpers unless extraction meaningfully improves call-site readability.

### Testing

Assertions run against OTel-side data: in-memory exporters and metric readers for shared modules, the framework's test client driving a small real app for integrations. Never replace Apitally's own classes or functions with test doubles. Substitute only process boundaries: test HTTP policy and orchestration at the language's network-call seam, use a local HTTP server for focused physical transport coverage, and substitute fork where real forking is impractical.

- One focused test module per shared source module, one integration module per framework. Test files are named after the module they test, never after scenarios. Shared fixtures and assertion helpers live in one place.
- Every test needs an important reason to exist: it pins a spec MUST, a settled design decision, or a behavior a plausible change would silently break. Tests that restate the implementation, or assert theoretical edge cases no real deployment hits, do not get written. Do not multiply a scenario into parameter variants.
- Test only the SDK's own code. Never write tests that assert third-party or upstream behavior — no pinning what the OTel SDK or a framework does on its own, and no tests that exist just in case a dependency changes. Dependencies appear in tests only as the environment the SDK's behavior is observed in.
- Prefer one integration test proving a flow end-to-end over several micro-tests asserting its intermediate steps.
- A test name states the observable behavior it pins, in plain English, readable without the test body: `test_no_response_size_when_client_stops_reading_mid_stream`, `test_request_body_not_read_for_disallowed_content_type`. Name the behavior, not the mechanism or an internal codename.
- Test order within a module is deliberate, not accidental: the primary flow first, tests of the same behavior grouped together, common cases before edge cases, so the module reads top-down like the feature's documentation.
- Tests pinning the same scenario share the same name across framework integrations within a repo. Across SDK repos, the Python suite is a useful reference for which scenarios to cover and what to call them; reuse its names where the scenario genuinely applies so coverage can be compared, but skip scenarios that are irrelevant to the platform and rename freely where the Python name would be inaccurate for this SDK's implementation.
- Assert the complete set of exported data, not membership: exact counts of spans, log records, and metric data points, so an unexpected extra export fails the test.
- Integration tests read responses to completion before asserting on exports. Telemetry for a request completes when its response body does, and test clients often leave streaming bodies unread by default.
- One shared, automatically applied fixture isolates process-global OTel state between tests (config singleton, global tracer provider, root-logger bridge, instrumentor state, relevant env vars). Individual tests rely on it instead of resetting globals themselves.
- Integration test apps are small and uniform across frameworks: a handful of routes covering a path parameter, a POST body, an error handler, and a mounted/prefixed route.
- Framework test modules skip collection when their framework or instrumentor is not installed, so the CI matrix can run one framework at a time.
