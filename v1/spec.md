# Apitally OTel SDK Specification

Canonical, language-agnostic contract between Apitally client SDKs and the Apitally OTLP ingestion path. Normative keywords MUST/SHOULD/MAY per RFC 2119. Server behavior is stated only where it constrains the SDK; verified against `apitally_cloud/otlp/` and `apitally_cloud/ingester/otlp_*.py`.

## 1. Overview

Apitally SDKs become OpenTelemetry distributions: they configure the official OTel SDK of their language and export OTLP directly to `otlp.apitally.io`. This is a clean break shipped as a new major version: the Hub, `client_id`, and all bespoke transport/payload code are removed. Auth uses a per-app write token. Legacy SDK versions continue working against the Hub; no dual-mode support.

Validation and server error capture emits SDK-aggregated standalone log events. It is independent of trace sampling and exclusion because traces cannot provide complete error counts when a request's spans are not exported.

## 2. Transport

| | OTLP/HTTP | OTLP/gRPC |
|---|---|---|
| Endpoint | `https://otlp.apitally.io/v1/{traces,metrics,logs}` | `https://otlp.apitally.io:443` (TLS, ALPN h2) |
| Encoding | `Content-Type: application/x-protobuf` only; JSON is rejected with 415 | protobuf |
| Compression | `Content-Encoding: gzip` or `identity`; anything else is rejected with 400 | standard gRPC gzip |
| Max payload | 4 MiB on the wire | 4 MiB |

Decompressed payloads over 16 MiB are dropped at ingest. SDKs SHOULD use their language's default OTLP protocol; both are fully supported.

## 3. Authentication

Every export MUST carry `Authorization: Bearer <write token>` (HTTP header / gRPC metadata). Token format: `apt_` + 24 alphanumeric chars, e.g. `apt_3kPmN9xQv2bR7tH4wZ8yL5cE`; treat as an opaque string. The write token is a write-only ingest credential (comparable to a Sentry DSN), replacing `client_id`. Missing/invalid token: HTTP 401 / gRPC `UNAUTHENTICATED`, not retryable.

## 4. Export headers / metadata

On every export request, the SDK MUST send:

| HTTP header | gRPC metadata | Value |
|---|---|---|
| `Apitally-Env` | `apitally-env` | The SDK's resolved environment, identical to `deployment.environment.name` (default `prod`). Drives real-time online status, recorded at receive time. |

## 5. Resource attributes

| Attribute | Requirement | Notes |
|---|---|---|
| `service.instance.id` | MUST | Unique per process instance, regenerated on restart (e.g. UUIDv4 at startup). Server falls back to `service.name` if absent, collapsing all instances into one. |
| `deployment.environment.name` | SHOULD | Apitally environment. Server also accepts deprecated `deployment.environment`; defaults to `prod` when absent. Normalized by slugify, max 32 chars (`Production EU` → `production-eu`). MUST match the `Apitally-Env` header value. Environments are auto-created on first sight. |
| `telemetry.distro.name` | SHOULD | `apitally-py` for Python SDK, `apitally-js` for JavaScript SDK, etc. |
| `telemetry.distro.version` | SHOULD | SDK version |

Server-side instance identity is `uuid5(namespace, "{app_id}:{env}:{service.instance.id}")`; a restart is a new instance.

## 6. Traces

One SERVER span per handled HTTP request; the SERVER span is the request boundary (identified by `kind == SERVER` only, parent may be non-empty when an upstream propagates `traceparent`). Trace/span IDs are standard W3C sizes (16/8 bytes).

### 6.1 SERVER span attributes

The SDK MUST emit stable HTTP semconv. The server also reads old-convention fallbacks (in parentheses) for stock-OTel compatibility.

| Attribute | Notes / server caps |
|---|---|
| `http.request.method` (`http.method`) | Uppercased; max 16. `OPTIONS` requests are not exported (6.5). |
| `http.route` | MUST be the parameterized route template, e.g. `/users/{user_id}`, never the raw path; max 2048. Unmatched requests (e.g. 404s) have no route: leave it unset. The SERVER span is still emitted and recorded as a request log with an empty route. |
| `http.response.status_code` (`http.status_code`) | Valid range 100–599, else stored as 0. |
| `url.scheme`, `server.address`, `url.path`, `url.query` (`http.scheme`, `http.host`, `http.target`) | Concatenated into the display URL: `{scheme}://{host}{path}?{query}`. |
| `http.request.body.size`, `http.response.body.size` | Full body size in bytes, set independently of body capture, when the size is determinable (e.g. a chunked request body without `Content-Length` has no determinable size without reading it). Aligns with the "when the size is known" condition on the section 7.1 size histograms, so request-log and metric sizes derive from the same value. |
| `client.address` (`net.peer.ip`) | Client IP; max 46 chars. Non-IP or private values are discarded; used for GeoIP. |
| `http.request.header.<name>`, `http.response.header.<name>` | Captured headers, semconv list-valued convention; the server stores one name/value pair per array element. `<name>` is the stable-semconv form: lowercase header name with dashes preserved, e.g. `http.request.header.content-type`. The server folds underscore-form keys (`content_type`, as still emitted by pre-stabilization OTel instrumentors) into the same header when parsing. Stored on the request log, stripped from span attributes. |

Request timing comes from span `start_time_unix_nano` / `end_time_unix_nano`.

### 6.2 Consumer attributes

Set on the SERVER span when a consumer is identified:

| Attribute | Cap | Fallback read server-side |
|---|---|---|
| `apitally.consumer.identifier` | 128 | `user.id` |
| `apitally.consumer.name` | 64 | `user.full_name`, then `user.name` |
| `apitally.consumer.group` | 64 | none |

Example: `apitally.consumer.identifier="acme-corp"`, `apitally.consumer.name="Acme Corp"`, `apitally.consumer.group="enterprise"`.

### 6.3 Body capture

| Attribute | Value |
|---|---|
| `apitally.request.body` | Request body as string or bytes; absent when not captured |
| `apitally.response.body` | Response body as string or bytes; absent when not captured |

- Captured only when request/response body logging is enabled and the `Content-Type` matches the allow-list (case-insensitive prefix match, ignoring any `; charset=...`): `application/json`, `application/problem+json`, `application/vnd.api+json`, `application/ld+json`, `application/x-ndjson`, `text/markdown`, `text/plain`. Otherwise the attribute is absent.
- Bodies up to 50 KB (50,000 bytes) MUST be exported intact, never truncated. Larger bodies are not captured; the attribute is set to `[BODY_TOO_LARGE]`.
- An empty (zero-byte) body is never captured; the attribute is absent.
- Values may be string or bytes `AnyValue`s. The server reads the bytes value preferentially and sniffs the gzip magic bytes, decompressing up to 64 KiB; a larger decompressed result is stored as `[BODY_TOO_LARGE]`. SDKs MAY export non-UTF-8 bodies losslessly as bytes and MAY send bodies gzip-compressed (e.g. passing through an already-gzip-encoded response body without decompressing it). Bytes values are accepted only for these two attributes; bytes-valued attribute values anywhere else are dropped at ingest.
- Redaction (section 6.7) MUST run before the attribute is set. When a body mask callback drops the body, the attribute is set to `[REDACTED]`.

### 6.4 Exceptions

Unhandled exceptions MUST be recorded as the standard OTel `exception` span event on the SERVER span (`exception.type`, `exception.message`, `exception.stacktrace`; server caps 256 / 2048 / 64 KiB). The last `exception` event wins. With a Sentry integration active, set `apitally.exception.sentry_event_id` on the SERVER span.

Server error capture uses a separate request-local path defined in section 9.2. Trace exception events never increment the dedicated server error table.

### 6.5 Span selection

- The SERVER span (the request boundary, section 6) and its descendants MUST be exported, except for `OPTIONS` requests (CORS preflight), excluded requests (section 6.8), and requests sampled out by the SDK's own sampling configuration, which MUST NOT be exported. Sampled-out and excluded requests are still counted in request metrics (section 7) and can still produce validation and server error events (section 9.2).
- A root span of any other kind (background jobs, queue consumers, schedulers) and its descendants MUST NOT be exported.
- A request MUST be exported even when its upstream parent was not sampled; upstream sampling MUST NOT suppress local requests.
- Descendant spans and request-scoped application logs whose SERVER span never arrives are never surfaced: trace detail and application logs derive from the SERVER span, so telemetry without one is unreachable by construction and ages out with normal retention. An SDK dropping a SERVER span at response time (e.g. a response-based sampling callback) MAY rely on this to abandon telemetry the request already emitted. Validation and server error events remain independent as defined in section 9.2.

### 6.6 Per-message spans

The SDK MUST NOT export framework-internal per-message INTERNAL spans — `* http send` / `* http receive` and their websocket variants `* websocket send` / `* websocket receive`. The server also drops them at ingest.

### 6.7 Redaction

Redaction MUST run before any header or body attribute (6.1, 6.3) is set, and before any query-param attribute is exported — stock instrumentors set `url.query` raw, so the SDK may redact it at export (e.g. via a rewritten span copy) instead of at set time. Patterns are matched case-insensitively against the parameter, header, or field name (substring, anywhere in the name); a matched value is replaced with `[REDACTED]` (matches OTel's `http_capture_headers_server_request` convention). User-supplied patterns are added to the defaults below, never replace them. Captured `Location` and `Content-Location` response header values are URLs; their query strings MUST pass through the same query-param redaction.

| Target | Default name patterns |
|---|---|
| Query params (in `url.query`) | `auth`, `api-?key`, `secret`, `token`, `password`, `pwd` |
| Headers | `auth`, `api-?key`, `secret`, `token`, `cookie` |
| Body fields | `password`, `pwd`, `token`, `secret`, `auth`, `card[-_ ]?number`, `ccv`, `ssn` |

Body fields are matched on object keys; only string values are replaced; nested objects and arrays are walked.

### 6.8 Excluded requests

Requests whose path or user agent matches a built-in pattern MUST NOT be recorded as request logs: no SERVER span (and therefore no request-scoped application logs) is exported. They are still counted in request metrics (section 7), and routed excluded requests can still produce validation and server error events (section 9.2).

| Target | Default patterns |
|---|---|
| Path | `/_?healthz?$`, `/_?health[-_]?checks?$`, `/_?heart[-_]?beats?$`, `/ping$`, `/ready$`, `/live$`, `/favicon(?:-[\w-]+)?\.(ico\|png\|svg)$`, `/apple-touch-icon(?:-[\w-]+)?\.png$`, `/robots\.txt$`, `/sitemap\.xml$`, `/manifest\.json$`, `/site\.webmanifest$`, `/service-worker\.js$`, `/sw\.js$`, `/\.well-known/` |
| User agent | `health[-_ ]?check`, `microsoft-azure-application-lb`, `googlehc`, `kube-probe` |

Patterns are matched by case-insensitive, unanchored regex search — against the path with the query string stripped, and against the user agent. User-supplied path patterns are added to the defaults; the user-agent list is not configurable.

## 7. Metrics

### 7.1 Request histograms

The histograms' instrumentation scope name MUST be `apitally`. They MUST be exported with delta temporality, at least once every 60 s — exports follow the SDK's export interval (default 15 s, server-adjustable within [5, 60] s).

| Instrument | Type | Unit |
|---|---|---|
| `http.server.request.duration` | ExponentialHistogram | `s` |
| `http.server.request.body.size` | ExponentialHistogram | `By` |
| `http.server.response.body.size` | ExponentialHistogram | `By` |

- **Histograms MUST be exponential with delta temporality.** The server reads only exponential + delta; explicit-bucket and cumulative histograms are dropped.
- Scale SHOULD be 3 and MUST be within [-2, +6]; the server drops data points outside the range.
- `http.server.request.duration` is the anchor: its data point `count` is the request count, its `start_time_unix_nano` determines the minute bucket, and size data points join to it by identical attribute tuple; a size data point without a matching duration tuple is dropped.
- Record one duration observation per request (seconds) and one observation per body when the size is known (bytes). `OPTIONS` requests and requests with no matched route (empty `http.route`) MUST NOT be recorded; the server also drops both at ingest. Websocket connections are never recorded. Request logs and spans still capture unmatched-route requests (see 6.1).

Data point attributes — these four form the server's aggregation key and MUST be set:

| Attribute | Notes |
|---|---|
| `http.request.method` | e.g. `GET` |
| `http.route` | route template, same value as on the SERVER span |
| `http.response.status_code` | int |
| `apitally.consumer.identifier` | omit when no consumer; server falls back to `user.id`. Same value as on the SERVER span; server strips whitespace and caps at 128. |

Semconv-required attributes (`url.scheme`; `error.type` on failed requests) SHOULD also be set. All non-key attributes are ignored: data points differing only in non-key attributes are merged server-side (counts, sums, and buckets added).

### 7.2 Process gauges

Reported under any instrumentation scope:

| Instrument | Value | Server handling |
|---|---|---|
| `process.cpu.utilization` | 0–1, normalized across available CPUs | stored as percent, clamped to [0, 100] |
| `process.memory.usage` | bytes (RSS-equivalent) | stored as-is |
| `process.uptime` | seconds | value unused; guarantees an export exists each interval |

CPU and memory are paired by timestamp with ≤1 s skew tolerance; a sample is stored only when both exist, so both SHOULD be observed in the same collection cycle. Gauge or sum data points are accepted; `as_double` or `as_int`.

### 7.3 Liveness contract

Every metrics export serves as a liveness signal: the server writes a liveness sample per resource (using the max data point time, client clock) and marks the env online while the last export is within 180 s — tolerating missed or delayed exports. Therefore metrics exports MUST run unconditionally on the export interval, independent of traffic, with never more than 60 s between them; `process.uptime` exists to keep exports non-empty when CPU/memory gauges are disabled. Uptime monitoring and alerts depend on this signal.

## 8. Logs

The logs signal carries request-scoped application logs and the SDK-owned internal events in section 9. Every exported application LogRecord MUST carry:

- a non-empty `trace_id`, and
- attribute `apitally.request.server_span_id` = lowercase hex of the request's SERVER span id (16 hex chars, e.g. `00f067aa0ba902b7`).

Application records missing either are dropped. SDK-owned internal events in section 9 are the exceptions. The native `LogRecord.span_id` (the emitting span, typically a child) is stored for waterfall linking; the explicit SERVER span attribute is required because the server computes the request linkage as `xxh3_128(trace_id_bytes + server_span_id_bytes)`, byte-identical to the trace path.

The SDK MUST set this attribute on every application log record it exports. Which logging interfaces the SDK captures records from is defined in the design doc (§9).

| LogRecord field | Stored as | Notes |
|---|---|---|
| `time_unix_nano` (fallback `observed_time_unix_nano`) | timestamp | missing both → dropped |
| `body` | message | strings verbatim; structured bodies JSON-encoded; empty → dropped |
| `severity_number` | level | 1–4 `trace`, 5–8 `debug`, 9–12 `info`, 13–16 `warn`, 17–20 `error`, 21–24 `fatal`, 0 → empty |
| scope `name` | logger | SDK SHOULD set the instrumentation scope name to the application logger name (e.g. `myapp.services.billing`) |
| attr `code.file.path` (`code.filepath`) | file | max 4096 |
| attr `code.line.number` (`code.lineno`) | line | valid 1–65535 |

## 9. SDK internal events

SDK internal events use the logs signal, the same private SDK resource as other Apitally telemetry, and instrumentation scope `apitally`. They bypass request-log linkage requirements and MUST NOT carry trace or span context.

### 9.1 Startup event

Emitted as a LogRecord with `time_unix_nano` set. The startup event is identified by the event name `apitally.app.startup` together with the scope name. The SDK MUST set this name in the LogRecord's native `event_name` field; where the OTel SDK version cannot, the server also accepts it in an `event.name` attribute as a fallback. No `trace_id` or server-span attribute. Body is a JSON string: the payload below serialized to JSON and set as the LogRecord body (a string `AnyValue`), which the server JSON-decodes. The payload:

```json
{
  "framework": "fastapi",
  "versions": {"python": "3.13.2", "fastapi": "0.115.0", "app": "2.3.1"},
  "paths": [
    {"method": "GET", "path": "/users"},
    {"method": "POST", "path": "/users"}
  ],
  "openapi": "{\"openapi\": \"3.1.0\", ...}"
}
```

| Field | Contract |
|---|---|
| `framework` | e.g. `fastapi`, `express`, `gin`, `aspnetcore`. Informational: stored and displayed as the app's client. Route normalization is keyed on the framework selected for the app in the dashboard, not on this value. |
| `versions` | component → version map; SHOULD include language runtime and framework |
| `paths` | all registered routes; `method` is 2–12 letters/hyphens (uppercased server-side), `path` is the route template, max 2000 chars; entries MAY include `summary`/`description` strings |
| `openapi` | OpenAPI spec as an uncompressed JSON string; MUST be omitted if larger than 4 MB (4,000,000 bytes). When omitted, endpoints are still registered from `paths` (degraded: no spec-derived summaries/descriptions). |

Emit once when the app is ready (routes registered). Identical startup events from many instances are deduplicated server-side.

### 9.2 Validation and server error events

Validation and server errors are aggregated in each SDK process and emitted as standalone LogRecords, one normalized aggregate group per record. The SDK MUST set `time_unix_nano` to the aggregate emission time and the native `event_name` field to one of the names below. The body MUST be a structured OTLP `AnyValue` object, not a JSON string.

Validation error event name: `apitally.request.validation_error`.

```json
{
  "consumer": "acme-corp",
  "method": "POST",
  "path": "/users/{user_id}",
  "source": "body",
  "field": "email",
  "message": "value is not a valid email address",
  "type": "value_error.email",
  "count": 4
}
```

Server error event name: `apitally.request.server_error`.

```json
{
  "consumer": "acme-corp",
  "method": "GET",
  "path": "/users/{user_id}",
  "type": "builtins.RuntimeError",
  "message": "database unavailable",
  "stacktrace": "...",
  "sentry_event_id": "0123456789abcdef0123456789abcdef",
  "count": 2
}
```

`consumer` MAY be omitted when the request has no identified consumer. `sentry_event_id` MAY be omitted from a server event when unavailable. All other fields MUST be present; unavailable string values use the empty string.

The validation aggregation identity is `consumer, method, path, source, field, message, type`. The server aggregation identity is `consumer, method, path, type, message, stacktrace`; `sentry_event_id` is enrichment, and the latest non-empty value wins. Each validation detail contributes one count to its group. Counts MUST be positive and no greater than `UInt32`.

Validation capture MUST use conservative framework-specific recognition of known validation responses, generally with status 400 or 422. `source` identifies the request component, normalized to values such as `body`, `query`, `path`, `header`, or `cookie`; framework terms such as `querystring`, `params`, and `headers` are normalized at the framework adapter boundary. `field` is an opaque human-readable field path. Validators that already provide a useful field string MUST preserve it rather than splitting and reconstructing it. An SDK MUST format a validator's structured field path once and MUST NOT split the normalized string afterward. An unavailable source or field uses the empty string.

A request contributes a server error only when it has a captured exception and its final status is 500. A response with any other status does not contribute, even when an exception was captured. A deliberate 500 response without a captured exception does not contribute. Automatic framework hooks retain the exception in request-local state independently of whether a recording SERVER span exists. The public `capture_exception` helper updates the same request-local error state and records a standard exception event when a recording SERVER span exists, so it participates in server error capture like the automatic hooks. Request cancellation exceptions MUST NOT be retained or emitted as server errors. When several exception hooks observe one request, the last captured exception is used once.

Validation and server errors MUST be captured for routed requests independently of trace recording, trace sampling including `sample_rate`, response sampling, trace exclusion, trace quota, and application log capture. They MUST be skipped for `OPTIONS`, websockets, and requests without a parameterized route. They MUST also be omitted when Apitally is disabled.

Apply these limits before aggregation: method 2-12 letters or hyphens and uppercase; path 2,000 characters; consumer 128 characters; source 32 characters; field and validation message 2,048 characters; validation type 128 characters; exception type 256 characters; exception message 2,048 characters; stacktrace 65,536 characters; Sentry event ID 32 characters.

Each SDK process MUST retain no more than 100 distinct validation groups and 100 distinct server groups between drains. It MUST continue incrementing retained groups and silently ignore later distinct groups. Aggregate events are drained immediately before the logs pipeline is flushed in regular and final export cycles. They use the ordinary logs queue and spool retention policy, with no separate priority or overflow telemetry.

## 10. Server responses and retry behavior

Success is HTTP 200 / gRPC `OK` with an empty `Export*ServiceResponse` (no `partial_success`). Error bodies are protobuf `google.rpc.Status`. The endpoint publishes payload bytes without parsing them: a 200 means accepted, not validated — malformed protobuf is dropped at ingest.

| Condition | HTTP | gRPC | Retryable |
|---|---|---|---|
| Invalid/missing token | 401 | `UNAUTHENTICATED` | no |
| Quota exhausted (traces only) | 402 | `RESOURCE_EXHAUSTED` | no — drop |
| Rate limit | 429 | `RESOURCE_EXHAUSTED` | yes |
| Wrong content type | 415 | — | no |
| Unsupported content encoding | 400 | — | no |
| Payload > 4 MiB | 413 (ingress) | `RESOURCE_EXHAUSTED` (gRPC default) | no |
| Server overloaded / upstream down | 503 | `UNAVAILABLE` | yes |

Rate limits: 1800/minute and 200/second per app per signal. Retry behavior is owned by the SDK's export pipeline as defined in the design doc (spool-based send cycle); SDKs MUST NOT layer additional retry or backoff logic on top of it.

## 11. SDK API guidance (non-normative)

Per-language idioms win; this aligns naming and setup UX across SDKs.

- Setup is one unified entry point at the package root, e.g. `apitally.init(app, write_token=..., env=...)`, which detects the framework from the app instance and delegates to per-framework adapters (design doc §13) — the distro wires exporters, sampler, processors, and instrumentation internally; no OTel knowledge required from the user.
- Config: `write_token` (snake/camel/Pascal per language), also readable from an `APITALLY_WRITE_TOKEN` env var; `env` defaulting to `prod`.
- Consumer API keeps its name: `set_consumer(identifier, name=None, group=None)` / `setConsumer(...)`, writing the section 6.2 attributes.
- Validation error capture is automatic; SDKs do not expose a public validation capture API or response-parser callbacks. `capture_exception` updates the request-local error state and records a standard exception event on a recording SERVER span, so it participates in server error capture.
- Request logging config stays close to the legacy SDK option names; renames for cross-option consistency are fine (e.g. Python drops the `_callback` suffix: `mask_request_body_callback` → `mask_request_body`, and the legacy `log_*` capture toggles become `capture_request_headers` / `capture_request_body` / `capture_response_headers` / `capture_response_body`, matching `capture_logs`). The legacy `exclude_callback` becomes the sampling callbacks `sample_on_request` / `sample_on_response`, which return a keep probability (`float` in `[0, 1]`, `bool`, or `None` to abstain) refining the static `sample_rate`; note that the meaning is reversed from exclude to keep.
- Build on the official OTel SDK and contrib instrumentations of each language; do not reimplement OTLP export.

## 12. Legacy → OTel mapping

| Legacy SDK feature (Hub) | OTel mechanism |
|---|---|
| `client_id` auth | `apt_…` write token (section 3) |
| Request counters + response time/size histograms (`app_sync`) | three `apitally`-scoped histograms (7.1) |
| Request logs (`app_request_log`) | SERVER spans (6) |
| Application logs (inside request log payload) | OTLP logs + `apitally.request.server_span_id` (8) |
| Startup payload: paths, versions, client, OpenAPI (`app_startup`) | startup log event (9.1) |
| Heartbeat / online status (`app_sync`) | 60 s metrics export + `Apitally-Env` header (7.3, 4) |
| CPU/memory (`app_sync` resources) | `process.cpu.utilization` + `process.memory.usage` gauges (7.2) |
| Consumer registration | `apitally.consumer.*` attributes (6.2) |
| Validation errors, server errors | standalone aggregated log events (9.2), independent of traces |
