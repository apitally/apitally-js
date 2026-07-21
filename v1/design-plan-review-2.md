# Design and Plan Review 2 - Apitally JS SDK v1

Critical second-round review of `v1/design-js.md` and `v1/plan.md`. This review also challenged assumptions inherited from `v1/design.md`, `v1/spec.md`, the Python reference, and the resolutions in `v1/design-plan-review.md`; none was treated as authoritative merely because it was written earlier.

The findings below survived two passes: independent coherence, feasibility, security, scope, product, and adversarial reviews, followed by direct validation against the documents, installed dependency source, built artifacts, and current package metadata. They are ordered by severity and then roughly by implementation impact. `P1` means the design can produce incorrect, missing, unsafe, or operationally misleading behavior. `P2` means an important contract, maintenance, or product decision remains weak or incomplete.

## Findings

## 1. [P1] The documented Hono ordering makes the planned inner middleware unreachable

`design-js.md` Hono integration says `useApitally` only has to run before `app.fetch` is handed to the server. The implementation plan also adds an inner `app.use("*", ...)` middleware during setup. In Hono 4.11.4, middleware and routes are appended in registration order, and a terminal route that returns a response without calling `next()` never reaches a later middleware. Therefore the common sequence "register routes, call `useApitally`, export `app`" runs the outer `app.fetch` wrapper but skips the inner middleware.

That loses the matched `c.req.routePath` and any data assigned through the inner context path, so metrics and route attribution can silently be wrong. Either require `useApitally` before every Hono middleware and route registration and detect an already-populated `app.routes`, or redesign the adapter so route and consumer capture do not depend on middleware appended after user routes. Add a negative-ordering integration test.

## 2. [P1] Adopted SERVER spans start before the activation model says they do

`design-js.md` Lifecycle says the outer request wrapper activates the SDK before the SERVER span starts. That is true only for SDK-owned spans. With `@opentelemetry/instrumentation-http` 0.208.0, the instrumentation creates the SERVER span and calls every processor's `onStart` before it invokes the HTTP request listener and before Express reaches `app.handle`. The first adopted span therefore reaches `ApitallySpanProcessor` before wrapper-driven activation.

The public processor contract does not explain how a processor constructed inside the user's `NodeSDK` later receives Apitally configuration and downstream processors, what it does with this pre-activation first span, how attachment is detected, or who owns its `forceFlush` and `shutdown` lifecycle. Define an explicit two-phase process-global controller: processor construction must be side-effect-free, `useApitally` supplies immutable configuration, and processor callbacks must safely trigger or tolerate activation before the adapter wrapper runs. Test the exact documented existing-OTel setup in a child process with HTTP instrumentation loaded before `useApitally`.

## 3. [P1] The Express setup contract still contradicts the claimed one-line, after-imports experience

`plan.md` R2 promises `useApitally(app)` after imports with no init-before-imports requirement. `design-js.md` Express integration requires the call before every route and router registration, including module-scope routers, because route arguments must be captured at registration time. In a normal ESM app, statically imported router modules have already constructed and populated their routers before the entry module can call `useApitally`.

This is not just reduced route detail: the documented empty-route fallback causes request metrics to be skipped. Keep the registration-time mechanism, which the first review correctly validated, but resolve the product contradiction. Either narrow the promise to "one call with strict registration ordering", provide a side-effectful preload/register entry that runs before router modules, or choose another supported setup model. The README acceptance test must use a realistic statically imported router, not only routes declared after setup in one file.

## 4. [P1] The Pino and Winston hooks capture data before application-native redaction and suppression

The planned Pino `writeSym` hook receives the raw log object before Pino applies serializers and redact paths during JSON construction. The planned Winston `Logger.prototype.write` hook runs before `_transform`, where Winston applies `silent`, format transforms, and format-based drops. Capturing at those hooks can therefore export a value that the application's configured logger redacts or never emits.

This is especially dangerous because `captureLogs` defaults on and the shared design explicitly provides no log-content redaction. The SDK cannot claim transparent capture while bypassing the application's privacy boundary. Capture post-policy output, integrate at a public post-format transport/destination seam, or require an explicit Apitally log integration. If no safe transparent seam exists, default capture off and document the limitation. Tests must include Pino `redact` and serializers, plus Winston `silent`, filtering formats, and redacting transforms.

## 5. [P1] Environment identity has no single authority and is implemented inconsistently

Three statements do not compose:

- `design-js.md` promises the standard OTel resource environment mechanism.
- Its concrete activation algorithm uses `defaultResource()` plus static attributes. In `@opentelemetry/resources` 2.4.0, `defaultResource()` does not run `envDetector`, so it does not consume arbitrary `OTEL_RESOURCE_ATTRIBUTES` or `OTEL_SERVICE_NAME`.
- On an adopted provider, a span resource may carry environment B while the `Apitally-Env` header and private metrics/log resources keep environment A; the design only warns.

Specify one precedence algorithm for config, `APITALLY_ENV`, `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME`, and a user provider's programmatic resource. Whichever value is authoritative must be applied consistently to the Apitally export copy, private resources, startup event, and HTTP header while leaving the user's original span untouched. Test conflicting sources. A warning is not enough when one export names two environments.

## 6. [P1] The serialized export worker cannot guarantee the metrics liveness contract

The worker collects all signals once per cycle, may send ten files with a 10-second timeout each, and schedules the next interval only after the cycle finishes. The design itself acknowledges that a cycle can take minutes. `spec.md` requires metrics exports unconditionally with no more than 60 seconds between them, and the server uses them as the online signal. Ten slow but successful trace or log uploads can therefore make a healthy environment appear offline.

The failure policy is also ambiguous: the generic design says one probe POST per outage cycle, while the healthy path allows ten sends. Define when a cycle stops after a retryable failure. More importantly, separate liveness from backlog draining or enforce metric-first delivery plus a hard cycle wall-clock budget and scheduled-start cadence. Add a deterministic ten-file, slow-response test proving the maximum metrics gap.

## 7. [P1] Record-count chunking does not enforce the claimed 4 MB spool limit

`design-js.md` and `plan.md` rely on bounded record-count chunks, following the reference's 32-record example, so rotation can be checked before each append. A count is not a byte bound. The owned provider permits 65,536-character attribute values and ordinary OTel spans may carry many attributes, events, and links; one span can exceed 4 MB before captured payloads are considered. A user-owned provider may be even more permissive.

An oversized append breaks the stated file bound and can make the server reject a file containing otherwise valid records, after which the permanent-4xx policy drops the whole file. Encode by byte size, recursively split oversized batches, and handle a single oversized record independently with an explicit drop/warning policy. Test one individually oversized span and a batch whose records are each valid but collectively exceed the limit.

## 8. [P1] Spool concurrency is hand-waved where asynchronous state transitions need a real protocol

Serializing worker cycles does not serialize producer appends against gzip writes, rotation, close, upload, deletion, stream errors, and shutdown. Node is single-threaded, but gzip and filesystem stream completion spans multiple event-loop turns. A close or upload can race an accepted-but-not-yet-flushed append; a delayed stream error can invalidate a generation already treated as complete; shutdown can finish while writes remain queued.

Define one serialized spool state machine or operation queue. A file must become uploadable only after both gzip and file streams close successfully, every append must resolve against a specific file generation, and final drain must await the queue. Tests should force delayed writes and errors across append/rotate/flush boundaries. "Port the v0 mechanics" is not sufficient specification for this load-bearing component.

## 9. [P1] The undeclared Undici major is incompatible with the declared Node floor

The SDK claims Node `>=20.6.0` and makes `undici` a regular dependency without naming the supported major. Current package metadata shows `undici` 7 requires Node `>=20.18.1` and Undici 8 requires Node `>=22.19.0`; Undici 6.21.3 supports Node `>=18.17.0`. Selecting the current major would make a nominally supported Node 20.6 installation invalid before any SDK code runs.

Pin a compatible Undici 6 range, or raise the Node engine floor. Renovate must not cross the major automatically, and the oldest Node lane must install the real package and exercise the proxy dispatcher. This dependency decision belongs in U1, not in an implicit installer choice.

## 10. [P2] Optional-peer resolution needs an explicit dual-build-safe implementation

The design requires synchronous `createRequire` lookup for Pino, Winston, and other optional peers while shipping unbundled ESM and CJS. The repository's current tsup 8.5.1 CJS output demonstrates the hazard: `import.meta` is rewritten to an empty object, leaving existing `createRequire(import_meta.url)` code with an undefined anchor. A module-load smoke test can pass while optional peer discovery silently behaves as if packages are absent.

Define the resolver strategy for both formats rather than leaving it as a coding detail. Use format-specific entry shims or another build-tested anchor, then run built-artifact CJS tests that actually discover and patch Pino/Winston under npm and pnpm layouts. The existing mixed-load smoke does not exercise this path.

## 11. [P2] The Sentry spike is allowed to select an implementation the plan forbids

`design-js.md` Sentry integration presents peer-resolved dynamic `import("@sentry/node")` plus `getClient()` as a tolerable public-API option. `plan.md` KTD8 says optional peers must resolve synchronously with `createRequire` and that dynamic imports never sit on activation because activation is synchronous. Spike 7 is allowed to choose between these paths without stating that one result would require changing the activation contract and KTD8.

Resolve the constraint before implementation: either keep activation synchronous and restrict Sentry support to a synchronous path, or make Sentry attachment an explicitly asynchronous best-effort phase with defined first-event loss and lifecycle behavior. The spike should evaluate only admissible designs or be empowered to revise the relevant design decision, not quietly create an exception.

## 12. [P2] The public framework subpath API promises undefined helpers

`design-js.md` Public API says `apitally/express` and `apitally/hono` export `useApitally` plus "framework-typed helpers". Neither document names those helpers, gives signatures, explains their purpose, or assigns them to a plan unit. R8 repeats the subpath requirement but only concretely requires the setup export.

An implementation-ready plan should enumerate the public API exactly. Name and specify the helpers, or delete the promise and export only the typed `useApitally`. Leaving an open-ended public surface invites accidental APIs that become semver obligations.

## Validation pass

Every finding above was re-checked after the initial synthesis and again after this file was drafted. Load-bearing factual claims were validated against Hono 4.11.4, Pino 10.2.0, Winston 3.19.0, `@opentelemetry/instrumentation-http` 0.208.0, `@opentelemetry/resources` 2.4.0, tsup 8.5.1 output, and current Undici package metadata. Cross-document claims were checked against the first review and its recorded resolutions so that an old finding was retained only when the resolution left the underlying risk intact or a new contradiction was introduced. The post-draft pass narrowed three findings to remove claims that exceeded their evidence.

The second pass removed or materially narrowed candidates that did not hold up: mandatory OTel 1.x support, wholesale replacement of the custom spool, an endpoint-override security finding, the claim that `beforeExit` cannot perform async drains, criticism of the number of spikes, the shared-test governance objection, the Express close-listener design, a blanket objection to Sentry scope, and minor test/build workflow preferences. No target design or plan document was changed.
