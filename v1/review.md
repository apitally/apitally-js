# v1 code review

Reviewed commit `ba0073c` on the `v1` branch.

## Scope and validation

The review covered all source modules, framework integrations, tests, package exports, build configuration, CI workflows, and the v1 specification and design documents. Independent reviews were run for the public API and lifecycle, telemetry pipeline, export and capture path, Node framework integrations, Fetch-style framework integrations, and packaging. Every finding below was then checked against the implementation and a realistic usage scenario.

Validation completed:

- `npm test`: 421 passed, 1 skipped
- `npm run test:coverage`: 89.91% statement coverage
- `npm run check`: passed when run without concurrent tests
- `npm run build`: passed
- `npm run check:package`: passed for ESM, CommonJS, and bundler resolution
- `git diff --check`: passed before this report was added

The first `npm run check` overlapped the test suite and saw temporary Adonis fixture files. A clean rerun passed. This is a local command race, not a product finding.

## High severity

### 1. Body redaction does not cover all structured bodies that the SDK captures

**Evidence:** `src/spanExporter.ts:155-191`, `src/redaction.ts:70-84`, `src/bodyCapture.ts:7-14`

`Redaction.redactBody()` only redacts a body when the complete byte sequence is UTF-8 JSON accepted by `JSON.parse()`. Two normal supported cases bypass it:

- A client or response middleware can gzip a JSON request or response before the SDK observes the wire bytes. UTF-8 decoding fails, so the gzip bytes are exported unchanged. The server then decompresses and stores the sensitive JSON.
- `application/x-ndjson` is explicitly allowed for capture, but a valid multi-line NDJSON body is not one JSON document. Parsing fails and the clear text is exported unchanged.

This can export default-sensitive fields such as `password` and `token`, contrary to the redaction contract.

**Recommendation:** Carry content type and content encoding as body-capture metadata independent of header-capture options. For gzip, decompress with a strict output cap, redact the decoded structure, and export redacted content. For NDJSON, parse and redact each non-empty line only when every line is valid JSON. Fail closed to `[REDACTED]` when structured decoding fails instead of exporting the original structured bytes.

**Verdict:** Rejected.

### 2. Existing OpenTelemetry setups lose upstream-unsampled requests

**Evidence:** `src/spanProcessor.ts:50-64`, `src/requestObservation.ts:104-123`, `src/providers.ts:31-55`, `README.md:278-287`

The documented existing-provider setup asks users to add only `ApitallySpanProcessor`. A standard OpenTelemetry provider uses parent-based sampling. When an incoming remote `traceparent` has its sampled flag clear, the SERVER span is non-recording and span processors are never called. Apitally therefore cannot export that request, even if its own sampling configuration would keep it.

This is common in distributed systems where an upstream service samples at a low rate. It violates the requirement that upstream sampling must not suppress local requests. Metrics still count the request, leaving traces and logs inconsistent with metrics.

**Recommendation:** Export a small composable sampler that always records SERVER spans while delegating non-SERVER decisions to the user's sampler. Update the existing-provider setup to require both that sampler and `ApitallySpanProcessor`. A processor alone cannot recover a span rejected by the provider's sampler.

**Verdict:** Rejected.

### 3. Spans from a user-owned provider can omit the required process identity

**Evidence:** `src/spanExporter.ts:194-220`, `src/providers.ts:57-75`

Apitally creates `service.instance.id` for its private log and metric resources, but adopted spans keep the user's resource except for a possible environment rewrite. A normal OpenTelemetry provider does not create `service.instance.id` by default. As a result, traces commonly reach Apitally without it while logs and metrics carry a different, complete resource.

The ingest service then falls back to `service.name`, collapsing all replicas into one instance.

**Recommendation:** Give `ApitallySpanExporter` the Apitally process resource values and add missing `service.instance.id`, `telemetry.distro.name`, and `telemetry.distro.version` to export copies. Preserve explicit user values, and keep the current environment reconciliation.

**Verdict:** Accepted and fixed in both the JavaScript and Python SDKs. Apitally's export copy always uses the SDK-generated `service.instance.id`, while the user's span and other exporters remain unchanged.

### 4. The export worker does not protect the metrics liveness deadline

**Evidence:** `src/exportWorker.ts:145-199`, `src/exportWorker.ts:268-316`, `src/spool.ts:78-99`

The specification requires a metrics export at least every 60 seconds. The worker can exceed that in several ordinary ways:

- A server-selected 60-second interval receives up to 10% positive jitter, producing a 66-second delay before work starts.
- Up to ten sends run sequentially with 10-second timeouts and pauses. The next cycle is scheduled only after the current cycle finishes.
- A retryable traces failure returns from the whole send loop, so a trace rate limit or outage blocks healthy logs and metrics even though limits and endpoints are signal-specific.

Under a slow proxy, backlog, or traces-only 429 response, a healthy process can appear offline and trigger uptime alerts.

**Recommendation:** Treat metrics liveness as a hard worker constraint. Keep the start-to-start interval below 60 seconds with execution headroom, give normal cycles a bounded deadline, and make each cycle's freshly collected metrics eligible and prioritized for sending. On a retryable failure, stop sending that signal for the cycle but continue with other signals. Keep cycles serialized, but schedule from the intended cadence rather than adding a full interval after an overrunning cycle.

**Verdict:** Rejected.

### 5. WebSocket handling is incorrect across the Fetch-style integrations

**Evidence:** `src/h3/middleware.ts:43-70,149-184`, `src/hono/middleware.ts:122-159`, `src/elysia/middleware.ts:90-100`, `src/requestObservationWeb.ts:156-213`

H3 WebSocket responses carry runtime upgrade metadata such as `crossws`. `captureWebResponse()` replaces the response with a plain `Response`, removing that metadata and preventing the upgrade. This was reproduced against H3's WebSocket response shape.

Hono also observes WebSocket upgrades as ordinary requests. Reconstructing a status 101 response can throw, after which the original response is returned but request observation may never complete. Elysia skips upgrades correctly, but checks before activation, so a WebSocket-only service never starts startup events or liveness metrics.

**Recommendation:** In every Fetch-style integration, call `activate()` first and then bypass all request and response observation when `Upgrade: websocket` is present. Return the framework response object unchanged. Add one uniform WebSocket scenario to the H3, Hono, and Elysia suites.

**Verdict:** Accepted and fixed. H3, Hono, and Elysia now activate before bypassing WebSocket upgrades, return the framework response unchanged, and export no request telemetry for the upgrade.

## Medium severity

### 6. Express 4 optional route parameters lose route attribution

**Evidence:** `src/express/routes.ts:503-525`

`templateToRegExpSource()` turns `:id?` into a required path segment followed by a literal question mark. On supported Express 4, both `/users` and `/users/42` match `/users/:id?`, but the SDK rejects the assembled template for both forms.

The spans are exported without `http.route`, metrics are omitted, and the SDK emits a misleading warning about missing registration capture.

**Recommendation:** Support Express 4 parameter modifiers in the template matcher. The optional modifier must include the preceding separator. Handle `?`, `+`, and `*` in one parser change and add integration coverage for the matching forms.

**Verdict:** Accepted and fixed. The route matcher now handles Express 4 optional, repeated, and wildcard parameter modifiers, with coverage against Express 4.18.

### 7. Hapi drops request logs emitted during `onPostResponse`

**Evidence:** `src/hapi/middleware.ts:54-68,100-130`

Hapi calls `onPostResponse` after the response has been transmitted. The response-finish continuation deletes the request observation before that phase runs. `request.log()` calls from access-log, audit, and request-summary plugins can no longer recover the request context and are silently dropped.

**Recommendation:** Do not delete this `WeakMap` entry explicitly. The weak request key already allows collection after Hapi releases the request, and retained state lets normal `onPostResponse` logs use the kept span mapping. Add a focused Hapi integration test.

### 8. Framework-resolved client addresses are ignored behind trusted proxies

**Evidence:** `src/requestObservationNode.ts:58-68`, with call sites in the Express, Fastify, AdonisJS, Koa, and NestJS paths

Node request observation always writes `request.socket.remoteAddress`. This bypasses each framework's configured trusted-proxy resolution. In common deployments behind an ingress, load balancer, or reverse proxy, the SDK records a private intermediary address that ingestion discards, or a public proxy address that produces incorrect GeoIP attribution.

**Recommendation:** Let framework integrations provide a trusted client-address override after their request object exists. Use framework-resolved values such as Express `req.ip`, Fastify `request.ip`, AdonisJS `ctx.request.ip()`, and Koa `ctx.ip`. Do not parse forwarding headers in shared code.

**Verdict:** Need to investigate further. Why not parse forwarding headers in shared code?

### 9. Koa and Hono record routine 4xx control flow as exceptions

**Evidence:** `src/koa/middleware.ts:39-55`, `src/hono/middleware.ts:242-260`

Koa handlers commonly use `ctx.throw(401)`, and Hono handlers commonly throw `HTTPException(404)`. Both integrations record every thrown value as an exception. Fastify, NestJS, H3, and Elysia suppress expected 4xx errors and only record unhandled or 5xx failures.

This makes equivalent applications produce materially different and noisy error telemetry.

**Recommendation:** Apply the same status-aware rule across frameworks. Resolve a numeric `status` or `statusCode`, and suppress exception recording for 400-499. For Hono, use the final response status when a custom error handler can change it.

### 10. Late request-body capture inflates SERVER span duration

**Evidence:** `src/requestObservation.ts:171-224`, `src/h3/middleware.ts:149-179`, `src/elysia/middleware.ts:202-214`, `src/hono/middleware.ts:145-177`

H3 and Elysia can wait up to five seconds for cloned request-body capture after the response has completed. Hono can wait for a delayed body-cache promise. Metrics correctly use the earlier response completion time, but `ownSpan.end()` uses the later current time.

An application that rejects a slow upload from headers can therefore report a trace latency several seconds longer than the response duration and the request metric.

**Recommendation:** Capture an OpenTelemetry end timestamp at response completion and pass it to `ownSpan.end(endTime)` after late enrichment finishes. Keep body enrichment asynchronous, but make span timing reflect transport completion.

### 11. Hono body capture misses direct reads from the raw Request

**Evidence:** `src/hono/middleware.ts:162-210`, compared with `captureWebRequestBody()` in `src/requestObservationWeb.ts:82-143`

Hono capture only inspects Hono's body cache. Handlers that read `c.req.raw.text()`, `c.req.raw.arrayBuffer()`, or the raw stream leave no usable cache entry, so enabled request-body capture silently produces no body. Raw reads are common for webhook signature verification and byte-sensitive endpoints. H3 and Elysia capture the equivalent request independently.

**Recommendation:** Start the existing clone-based `captureWebRequestBody()` from Hono's outer fetch wrapper, as H3 and Elysia already do. Use that result as the authoritative capture rather than depending on parser-cache internals.

**Verdict:** Rejected. This is by design.

### 12. A transient spool read failure permanently deletes telemetry

**Evidence:** `src/exportWorker.ts:205-215`, `src/spool.ts:291-303`

Any `readFile()` failure causes the worker to delete the completed spool file. Transient `EMFILE`, `ENFILE`, or filesystem pressure therefore causes permanent loss exactly during a resource incident. The file is also marked as attempted before it is read.

**Recommendation:** Delete only when the file is already absent. Keep other read failures queued and end the cycle so they can retry. Move `markAttempt()` after a successful read and abort check.

**Verdict:** Rejected.

### 13. Long-lived requests have no process-wide telemetry buffer budget

**Evidence:** `src/spanProcessor.ts:159-166,201-214,243-255`, `src/logRecordProcessor.ts:18,60-66`, `src/logRecordExporter.ts:39-73`

The 1,000-span and 1,000-log limits apply independently to every request. Many SSE or slow requests can therefore retain hundreds of thousands of objects. Log strings are truncated only after release, so large messages remain at full size for the lifetime of the request.

This creates avoidable heap and GC pressure in a realistic long-lived connection workload.

**Recommendation:** Truncate captured log strings before buffering and add simple process-wide counters for buffered spans and logs. Drop new buffered telemetry after the global budget is reached while preserving each request's SERVER span and metrics.

**Verdict:** Need to investigate. How does the Python SDK handle this case?

### 14. Short malformed write tokens can be logged in full

**Evidence:** `src/config.ts:169-178`

The invalid-token error logs `writeToken.slice(0, 8)`. If an operator accidentally places a short credential for another service in `APITALLY_WRITE_TOKEN`, the entire value is printed followed by `...`.

**Recommendation:** Never interpolate an invalid token. Use a fixed `[REDACTED]` marker for malformed values. A prefix is only safe after the value has already matched the expected Apitally token shape, which is not useful in this error path.

**Verdict:** Rejected.

### 15. The consumer API differs from its design and can retain stale fields

**Evidence:** `src/consumer.ts:13-73`, `v1/design-js.md:154`

The JS design specifies `setConsumer(identifier, { name?, group? })`, but the implementation accepts only a string or one object. JavaScript callers following the design can pass the second argument without an exception, but it is ignored. TypeScript callers receive a type error.

Also, a later `setConsumer("account-b")` updates the identifier but leaves a previously written name and group on the span and request record. The exported consumer can combine fields from two identities.

**Recommendation:** Add the documented two-argument overload while retaining the object form if desired. Treat every valid call as a complete replacement and clear omitted optional fields from both the live span representation and the export copy. Add one test for replacement semantics.

**Verdict:** Rejected.

### 16. One shutdown failure prevents the remaining teardown steps

**Evidence:** `src/activation.ts:121-138,322-330`

`drainAndStop()` places span shutdown, logger shutdown, final spool drain, and worker stop in one `try` block. If an earlier processor shutdown rejects, later telemetry is not drained and the worker and proxy dispatcher are not stopped. The meter provider is not shut down at all.

**Recommendation:** Preserve the required order but handle each teardown stage independently so every stage is attempted. Always stop the worker in `finally`, shut down the meter provider, disable Undici instrumentation, uninstall log capture, and clear the active pipeline as part of terminal teardown.

### 17. Alpha releases publish under the wrong npm dist-tag

**Evidence:** `.github/workflows/publish.yaml:33-38`, `v1/design-js.md:9`

The release workflow derives the npm tag from the prerelease identifier, so `1.0.0-alpha.0` publishes under `alpha`. The release design requires every prerelease to use `next` until v1 is stable.

**Recommendation:** Publish all prerelease versions with `npm publish --tag next`; publish stable versions without an explicit tag.

### 18. Claimed Bun support is not exercised in CI

**Evidence:** `README.md:323-327`, `.github/workflows/tests.yaml:58-144`, `src/elysia/middleware.ts:189-193,249-256`

The README claims Bun support for Elysia, H3, and Hono, but every CI job runs on Node. The Elysia integration contains Bun-specific response behavior that the current suite cannot execute. Fetch streams, upgrade responses, package resolution, and lifecycle behavior differ enough that Node-only success is not evidence for this runtime claim.

**Recommendation:** Add Bun CI jobs that run the full Elysia, H3, and Hono integration suites. Until those pass continuously, narrow the public claim to the runtime and frameworks that are actually verified.

**Verdict:** Rejected.

## Findings considered and rejected

The following candidates were investigated but intentionally left out of the findings:

- Sentry initialized after Apitally activation is not detected. Normal setup initializes Sentry before serving requests, and supporting arbitrary late initialization would require invasive patching for a marginal scenario.
- Calling `shutdown()` and then continuing to serve traffic leaves wrappers installed. The documented contract requires stopping traffic first; post-shutdown traffic is application misuse. Finding 16 is limited to incomplete teardown during the valid shutdown path.
- Weak-reference registries for dynamically created loggers retain dead `WeakRef` wrappers. The growth is small and requires unusual process-lifetime logger churn.
- A single serialized record can exceed the 4 MB spool threshold. Normal SDK-produced records are bounded, current rotation checks `existing size + payload size`, and the remaining case requires unusually large user-defined OTel attributes.
- Elysia plugin startup paths can be empty in handle-only deployments. The supported production setup uses Elysia's normal startup lifecycle, and fixing every custom adapter would add complexity without a clear supported scenario.
- Disk spool files are not replayed after process restart. The design deliberately treats files from dead processes as orphans rather than a durable cross-process queue.

## Overall assessment

The codebase has strong structure, unusually thorough tests, clear lifecycle intent, and consistent shared observation primitives. The highest-risk issues are concentrated in privacy handling, existing-OpenTelemetry compatibility, metrics liveness, and WebSocket behavior. Those should be fixed before a public v1 prerelease. The medium findings are mostly contained corrections and consistency work rather than reasons to redesign the SDK.
