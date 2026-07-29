# Duplication audit

Reviewed commit: `8a3579ba178c3da6e180808d40b2f7b374d7c62a`

## Scope and method

This audit covers all TypeScript modules under `src/` and `tests/`. It looks for policies, lifecycle behavior, parsing, normalization, data transformations, test helpers, and behavior coverage implemented independently in more than one place.

Repeated syntax and small idiomatic checks were not treated as findings. Framework-specific code was considered duplicated only when the repeated behavior is owned by the SDK rather than required by the framework. The canonical Express and Hono integration scenarios were treated as intentional duplication under the repository testing guidance.

No high-severity duplication was identified.

## Production findings

### 1. Medium: OpenTelemetry resource environment parsing has two implementations

**Status:** Completed

**References:** `src/providers.ts:59-98`, `src/providers.ts:165-184`, `src/activation.ts:209-218`

`resolveEnv()` manually parses `OTEL_RESOURCE_ATTRIBUTES`, while `createResource()` delegates parsing of the same environment variable to OpenTelemetry's `envDetector`.

The implementations already differ. The custom parser does not percent-decode attribute names, accepts additional unencoded `=` characters in values, preserves malformed percent-encoded values, and does not apply the detector's validation or length limits. Environment resolution and the resulting OpenTelemetry resource can therefore interpret the same configuration differently.

**Recommendation:** detect the environment resource once, read `deployment.environment.name` from that result during environment resolution, and merge the same result when creating Apitally's resource. Remove `readDeploymentEnvironmentNameFromEnv()`.

### 2. Medium: Express and Hono repeat request observation bootstrap policy

**Status:** Completed

**References:** `src/express/middleware.ts:99-134`, `src/hono/middleware.ts:153-184`, `src/requestObservation.ts:26-99`

Both adapters independently create the request record and span handle, inherit or create the consumer holder, mirror start attributes into the request record, adopt or start the SERVER span, and stop request-body buffering when the request is dropped.

These operations are SDK request-observation invariants rather than framework-specific transport behavior. A later change can update one adapter while leaving the other with different attribute, consumer, span, or body-capture behavior.

**Recommendation:** move this bootstrap sequence into one operation in `requestObservation.ts`. Each adapter should continue to own activation, transport attribute extraction, propagation extraction, timing, route setup, and body interception.

### 3. Low: OPTIONS and WebSocket classification is repeated

**Status:** Completed

**References:** `src/spanProcessor.ts:470-480`, `src/metrics.ts:59-70`

The span and metrics pipelines both resolve stable and legacy HTTP method and scheme attributes and independently classify OPTIONS and WebSocket requests as telemetry that must not be recorded.

A transport-completion fallback is necessary for adopted SERVER spans whose request record did not exist at span start. The classification policy itself does not need two implementations. Drift could suppress traces while still recording request metrics, or the reverse.

**Recommendation:** use one shared operation that returns `"method"`, `"scheme"`, or `undefined` from request attributes at span start and transport completion. Metrics should consume the resulting drop reason. Keep exclusion paths, user-agent exclusions, and sampling decisions in the span pipeline.

### 4. Low: Expired spool-file disposal is repeated

**Status:** Completed

**References:** `src/spool.ts:151-157`, `src/exportWorker.ts:191-199`, `src/spool.ts:266-275`

Spool eviction and send-time processing both check whether a file is expired, emit the same warning, remove the file from the spool, and delete it.

Both expiry checkpoints are required. Eviction removes stale backlog, while the send-time check catches a file that expires after rotation or between sends. Only the disposal behavior is duplicated.

**Recommendation:** centralize the check, warning, removal, and deletion in a `Spool` operation such as `deleteFileIfExpired()`. Call it from both checkpoints.

## Test cleanup findings

### 5. Low: Export worker retry behavior is covered twice

**Status:** Completed

**References:** `tests/exportWorker.test.ts:177-196`, `tests/exportWorker.test.ts:198-223`

Both tests verify that a retryable failure retains the file, retries the same bytes in a later cycle, and removes the file after recovery. The broader outage and recovery test also covers probe pacing and payloads appended during the outage.

**Recommendation:** remove the narrower retry test at `tests/exportWorker.test.ts:177-196`.

### 6. Low: Held-fetch coordination is copied across tests

**Status:** Completed

**References:** `tests/exportWorker.test.ts:155-166`, `tests/exportWorker.test.ts:270-287`, `tests/express/express.test.ts:465-481`, `tests/utils.ts`

The tests repeat the same observer promise, held response, release callback, call counter, and successful fallback setup.

**Recommendation:** add one focused held-first-fetch fixture to `tests/utils.ts` that returns the fetch spy, observation promise, and release callback. Reuse it in the export worker and Express tests.

### 7. Low: The exporter test repeats redaction policy coverage

**References:** `tests/exporter.test.ts:56-103`, `tests/redaction.test.ts:7-52`

The exporter test repeats some Location and pass-through header policy already owned by the redaction module tests. The exporter still needs to prove query attribute-name detection, request and response header prefix detection, all-span processing, and copy-only mutation.

**Recommendation:** retain representative query and sensitive request and response header assertions in the exporter test. Leave exhaustive redirect and pass-through value policy in `tests/redaction.test.ts`.

## Intentional duplication

The following similarities should remain:

- Express and Hono transport observation use materially different Node stream and Fetch APIs. Shared policy already lives in `BodyCapture`, `adoptOrStartServerSpan()`, and `finalizeRecordAndReleaseRequest()`.
- Express and Hono route resolution depend on different framework contracts and internal data structures.
- Express and Hono startup route enumeration should remain framework-specific.
- Signal shutdown deadlines and export worker deadlines have different cancellation behavior.
- The aligned Express and Hono integration scenarios are the sanctioned canonical cross-framework test set.
- Console, Winston, and Pino capture tests exercise separate integrations.
