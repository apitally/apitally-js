# v1 code review, round 2

Reviewed commit `c3f0863` on the `v1` branch. This is the second review round; the first round and its verdicts are documented in `v1/review.md`.

## Scope and validation

Six independent reviews covered the core lifecycle and configuration, the telemetry pipeline, the export worker and spool, the Node framework integrations (Express, Fastify, Koa, Hapi, NestJS, AdonisJS), the Fetch-style integrations (H3, Hono, Elysia), and packaging, tests, and documentation conformance. Every candidate finding was then verified against the implementation before inclusion; the verification process and its rejections are listed at the end.

Validation completed:

- `npm test`: 433 passed, 2 skipped
- `npm run check`: passed (run after the tests, per the round-1 note about the local command race)
- The Express 4xx exception finding was reproduced with a scratch integration test (malformed JSON body, 400 response, `exception` event present on the exported SERVER span)

All accepted round-1 fixes were re-verified in code and tests: #3 (exporter process identity), #5 (WebSocket bypass in H3, Hono, Elysia), #6 (Express 4 route modifiers, checked against path-to-regexp 0.1.7 semantics), #7 (Hapi `onPostResponse` log linkage), #8 (framework-resolved client addresses), #9 (Koa and Hono sub-500 suppression), #10 (span end at transport completion), #13 (log truncation before buffering), #17 (prereleases publish under `next`).

## Medium severity

### 1. Express records routine sub-500 errors as exceptions, diverging from every other integration

**Evidence:** `src/express/middleware.ts:42-48`, compared with `src/koa/middleware.ts:47-59`, `src/fastify/middleware.ts:87-97`, `src/hapi/middleware.ts:84-94`, `src/nestjs/index.ts:56-64`, and the spec rule in `v1/design.md:190` ("Framework error hooks record exceptions with an unknown status or a 5xx outcome and suppress expected HTTP control flow below 500").

The lazily appended Express error middleware calls `captureException(error)` unconditionally. Round-1 finding #9 was accepted with exactly this rationale and fixed for Koa and Hono (commit `c12f391`), but the Express integration was left out.

**Scenario:** Any Express app using `express.json()` without a custom error middleware - a very common setup. A client POSTs malformed JSON; the body parser's `SyntaxError` carries `status: 400` and propagates through the SDK's error middleware. Reproduced against the real integration: the exported SERVER span for the resulting 400 response contains an `exception` event. The equivalent request in Fastify (schema validation 400), Koa (`ctx.throw(401)`), Hapi (validation 400), and NestJS (`BadRequestException`) produces no exception event, and each of those suites pins that behavior. Malformed-JSON traffic is routine (scanners, bad clients), so Express apps get persistent noisy exception telemetry that other frameworks do not.

**Recommendation:** Apply Koa's rule in the Express error middleware: read a numeric `status` or `statusCode` off the error and skip `captureException` when it is below 500. Errors without a status still capture, since Express's default handler responds 500 for those. Add one integration test pinning that a body-parser 400 produces no exception event.

### 2. A non-recording SDK-created SERVER span is never placed in the request context, orphaning user child spans

**Evidence:** `src/requestObservation.ts:120-137` - `requestContext = trace.setSpan(requestContext, ownSpan)` runs only in the recording branch.

When the SDK creates the SERVER span on a user-owned provider and the user's sampler drops it, request dispatch runs under a context with no span at all. Standard instrumentations (e.g. `instrumentation-http`) always set even non-recording spans into the context, so children of unsampled requests are dropped consistently by parent-based sampling.

**Scenario:** The documented existing-OpenTelemetry setup (user provider plus `ApitallySpanProcessor`) with `ParentBased(TraceIdRatioBased(0.1))`, using a framework without contrib HTTP server instrumentation (Hono, H3, Elysia), so the SDK creates the SERVER span on the user's provider. For the 90% of requests whose SERVER span is dropped, the user's own DB/HTTP instrumentations create spans with no parent: they become new roots, are independently sampled at 10%, and fill the user's tracing backend with orphan child spans. Apitally-side behavior is unaffected either way.

**Recommendation:** Hoist `requestContext = trace.setSpan(requestContext, ownSpan)` out of the conditional so the own span is always placed in the request context. Keep `spanHandle.span` and `spanHandle.ownSpan` assignment recording-gated as today. One-line move; no Apitally behavior changes.

## Low severity

### 3. Elysia `useApitally` refuses to install when routes exist, diverging from Hono and from the plugin path

**Evidence:** `src/elysia/middleware.ts:68-74` (warns and returns without installing) vs `src/hono/middleware.ts:45-53` (warns and installs in degraded mode). The plugin path (`createElysiaPlugin`, `src/elysia/middleware.ts:48-61`) performs no check at all.

For routes registered before `.use(plugin)`, the dispatcher `wrap()` still applies to every request while global `onTransform` hooks do not fire, which produces exactly Hono's documented degraded mode (span exported with cleared route, metrics skipped) rather than broken telemetry.

**Scenario:** A user calls `useApitally(app)` after registering routes - the same ordering mistake the Hono and Elysia suites both exercise. On Hono they get one warning and full telemetry minus route attribution. On Elysia they get one stderr line and then nothing: no spans, no metrics, no startup event. Via the README-recommended `apitallyPlugin()` path, the same mistake silently degrades with no warning. Three different outcomes for one mistake.

**Recommendation:** Warn and install anyway (degraded), matching Hono, and add the same warning to the `apitallyPlugin()` path when the host app already has routes. If fail-closed is a deliberate product choice, apply it consistently; today the inconsistency cannot be intentional since the plugin path silently permits what `useApitally` forbids.

### 4. `configure()` mutates `OTEL_SEMCONV_STABILITY_OPT_IN` even when the SDK is disabled

**Evidence:** `src/activation.ts:81-90` - the process-global environment variable is set unconditionally; the disabled checks (the `APITALLY_DISABLED` kill switch, `OTEL_SDK_DISABLED`, the `disabled` option, a missing or invalid write token) only gate `activate()` at `src/activation.ts:214-225`.

**Scenario:** A user ships `useApitally(app)` and disables Apitally in one environment with `APITALLY_DISABLED=true` (the documented emergency kill switch). Despite being fully disabled, the SDK still sets `OTEL_SEMCONV_STABILITY_OPT_IN=http/dup`, so the user's own HTTP instrumentations dual-emit old and new semconv attribute names on every HTTP span to their own backend - a persistent, user-visible change to their telemetry caused by an SDK that is supposed to be inert.

**Recommendation:** Guard the assignment with the resolved config: set the variable only when `!config.disabled`. `setConfig` already folds the kill-switch environment variables into `config.disabled`, so this covers the common case where the variable is set before `useApitally()` runs.

### 5. Spool write-failure warnings never re-fire after writes recover

**Evidence:** `src/logger.ts:1-13` (permanent process-wide warning deduplication), used by `src/spool.ts:57-62` and `src/spool.ts:124-125`. `v1/design.md:235` specifies the warning as "deduplicated until writes recover"; the implementation never clears the deduplication on recovery.

**Scenario:** A deployment hits disk pressure; the SDK warns once and drops buffered telemetry. Ops clears the disk and writes recover. When the disk fills again months later during an incident, every warning is silently suppressed, so telemetry is dropped with zero diagnostics exactly when the operator needs the signal.

**Recommendation:** After a successful write or close for a signal, remove that warning's key from the deduplication set (a small `resetWarning(message)` export on `logger.js`, called from the success paths in `Spool.append` and `closeCurrentFile`). Alternatively, if permanent deduplication is the intended behavior, amend `v1/design.md` §10.

### 6. The README overclaims supported Express versions

**Evidence:** `README.md:48` (Express `4.x`, `5.x`) vs `package.json` (`"express": ">=4.18.2 <6"`). Every other framework row states exact peer bounds.

**Scenario:** A user on Express 4.0-4.18.1 reads the supported-versions table, installs `apitally`, and gets an npm peer-dependency mismatch (a warning by default, a hard ERESOLVE failure under strict peer modes). Those versions are also outside the validated floor - the CI matrix only exercises express@4.18.2.

**Recommendation:** Change the Express row to `>= 4.18.2`, `< 6` to match the peer range. The Hono row (`>= 4.8.4` without the `< 5` upper bound) has the same, smaller drift.

### 7. The root detection failure message omits the promised subpath guidance

**Evidence:** `src/index.ts:46` vs `v1/design-js.md:153`, which requires the detection failure to throw "an error naming the framework subpath entry points, including `apitally/nestjs` because Nest applications deliberately remain outside root auto-detection."

**Scenario:** A NestJS user passes the Nest application to the root `useApitally` - a natural mistake, since every other framework is auto-detected from the root - and gets `useApitally() could not detect a supported framework from the app argument`, with no hint that NestJS needs the separate `apitally/nestjs` entry. This is exactly the situation the design wanted the message to resolve.

**Recommendation:** Extend the `TypeError` message to list the per-framework subpath entry points and note that NestJS applications require `apitally/nestjs`.

### 8. The design-claimed built-artifact peer-discovery tests do not exist

**Evidence:** `v1/design-js.md:179` states that the tsup `shims: true` CJS `createRequire(import.meta.url)` anchor is validated because "built-artifact tests prove peer discovery through both the ESM and CJS entries." No such test exists: every test imports `src/` (ESM, pre-build), and `attw --pack` only statically analyzes the packed artifact's types and conditions - it never executes the built files.

**Scenario:** A future tsup or esbuild change degrades the CJS `import.meta.url` shim, so `createRequire(import.meta.url)` throws only in the CJS build. All call sites guard with try/catch and fall back to debug-level logging, so CJS consumers would silently lose the `apitally/express/register` route capture and winston/pino/Sentry peer attachment with no CI signal - exactly the failure the design says the tests guard against. Nothing is broken today; the finding is the missing guard the design claims exists.

**Recommendation:** Add a minimal built-artifact test that loads the built `dist/express/register.cjs` and `.js` entries and asserts peer resolution succeeds (run after `npm run build`, e.g. as a separate CI step), or correct `v1/design-js.md` §16 to drop the claim.

## Documentation drift (no consumer impact)

- `v1/design-js.md:166,207` specifies the Sentry hook as `beforeSendEvent`; the implementation deliberately subscribes `preprocessEvent` (`src/sentry.ts:15-28`) because it fires synchronously inside `captureException` while the request context is still active, and this is pinned by a test. The behavior is correct on every supported Sentry major; the design document should be updated to name `preprocessEvent` and record the rationale.
- `AGENTS.md` describes the shared test tier as `tests/shared/<module>.test.ts`, but the shared test modules live directly under `tests/`. The same file describes `npm run check` as Biome plus tsc; the script also runs knip. Update the document, or move the tests.
- `src/exportSerialization.ts` has no mirror test module (the conventions ask for one per source module); its behavior is currently exercised only through the exporter tests.

## Findings considered and rejected

The following candidates were investigated and intentionally left out of the findings:

- **Missing or invalid write token is reported silently on the processor-triggered activation path.** Not reachable: processor-triggered activation requires the server-span activation callback, which is registered only by `configure()`, and `configure()` always calls `setConfig()`, which logs the missing or invalid token at setup. A process that never calls `useApitally()` never activates at all, regardless of the token.
- **Hono's `observeResponse` catch path never finalizes the request, unlike H3 and Elysia.** The divergence is real, but no concrete realistic trigger for a synchronous `captureWebResponse` throw could be produced on Node (locked body streams reject asynchronously and are already handled), and Bun behavior is unverifiable without CI coverage (round-1 finding #18, rejected). Per the project rule against handling unreachable edge cases, this is rejected; the asymmetry is noted here should a Bun failure surface later.
- **Round-1 rejected findings** (#1, #2, #4, #11, #12, #14, #15, #16, #18) were not re-reported; no substantial new evidence emerged in this round.
- **Hono's client address duck-types `@hono/node-server`'s env shape without test coverage** (`src/hono/middleware.ts`). A silent-breakage risk if the adapter's shape changes, but the alternative (parsing forwarding headers in shared code) was explicitly rejected in round 1, and the omission is bounded to one attribute.

## Overall assessment

The codebase is in materially better shape than at round 1: all accepted fixes are correctly implemented, and the pipeline, export, and packaging layers held up under a second full pass. The one medium-severity product issue is the Express 4xx exception divergence, a direct continuation of round-1 finding #9 that was fixed for Koa and Hono but not Express. The remaining findings are contained consistency corrections, small conformance gaps against the design documents, and documentation drift - none require redesign, and most are one-line fixes.
