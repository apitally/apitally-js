# Framework adapter foundation implementation plan

## Purpose

Prepare the v1 SDK for additional framework adapters by extracting the transport mechanics and telemetry policy currently embedded in the Express and Hono adapters.

This work establishes two reusable foundations:

- Fetch API request and response observation for frameworks built around standard `Request` and `Response` objects.
- Node HTTP request and response observation for frameworks exposing `IncomingMessage` and `ServerResponse`.

The extraction must leave framework routing, dispatch hooks, body-cache access, and error integration in each adapter. The result should make additional adapters small without forcing unlike frameworks through one generic adapter interface.

This is preparation only. Adding framework support is a subsequent step and is out of scope for this plan.

## Subsequent framework support

After this foundation is complete, add the v1 adapters that existed in v0 on `main`:

- AdonisJS
- Elysia
- Fastify
- H3
- Hapi
- Koa
- NestJS, through its Express and Fastify platform adapters

Express and Hono already exist in v1 and are the source adapters for this extraction.

Expected reuse by transport family:

- Fetch API: Hono, H3, and Elysia
- Node HTTP: Express, Koa, Fastify, Hapi, and AdonisJS
- Platform composition: NestJS reuses the applicable Express or Fastify transport foundation while retaining NestJS-specific setup

## Scope

### In scope

- Shared request-observation result types and HTTP start-attribute policy
- Shared completion for dispatches that fail before producing a response
- Fetch API request start and response body completion primitives
- Node HTTP request body, response body, response completion, and server-close primitives
- Migration of Express and Hono onto those primitives
- Shared peer package entry and version resolution
- Private startup-event route normalization
- Removal of the unsupported nested-Express request marker
- Test relocation and additions required to assign shared behavior to one test home

### Out of scope

- Implementing any of the subsequent framework adapters
- A generic `FrameworkAdapter` interface
- Generic route discovery or route matching
- Generic framework error hooks
- Generic request-body recovery from framework caches
- Changes to public SDK APIs
- Changes to telemetry payload formats or semantic-convention attribute names
- Changes to the five-second fallback for an unread Fetch response body
- Changes to signal handling or worker shutdown behavior

## Required behavior

The refactor must preserve these contracts.

### Lifecycle

- SDK activation remains synchronous at the adapter boundary and completes before request timing begins.
- Request timing starts after successful activation, at request observation.
- Successful requests end timing at transport completion:
  - Node HTTP: response `finish`, or `close` when the response aborts.
  - Fetch API: response body completion, stream failure, or the existing unread-body fallback.
- A dispatch that throws or rejects without producing a response ends timing at that failure boundary.
- Duration is captured before asynchronous route or request-body enrichment.
- Every request finalizes at most once.
- Every SDK-created promise chain handles rejection.

### Spans and request records

- Existing SERVER spans are adopted without `instanceof` checks across OpenTelemetry package boundaries.
- The SDK creates a SERVER span only when no suitable active SERVER span exists.
- Failed dispatch records the exception, marks an SDK-owned span as failed, ends it, and releases the request record.
- Successful response finalization continues through `finalizeRecordAndReleaseRequest()`.
- Dropped requests continue to contribute request metrics while suppressing unavailable trace and body data according to current behavior.

### Body capture

- Node request observation remains passive and does not change stream flow.
- Node response observation captures the final bytes passed through patched `write()` and `end()` methods.
- Fetch response observation tees the returned response and never consumes the application copy.
- Partial response bodies are never exported.
- Declared or observed body sizes keep their current semantics.
- Compression remains visible as wire-byte capture where the current adapter observes it.
- Hono request-body recovery continues to use only cache entries that preserve the original bytes.

### Framework boundaries

- Express owns dispatch wrapping, error middleware, route registration capture, route matching, and registration-order warnings.
- Hono owns Fetch dispatch wrapping, route middleware, matched-route inspection, body-cache access, error-handler wrapping, and `env.incoming` client-address lookup.
- Shared transport modules do not import Express, Hono, or future framework packages.
- `configure()` and `registerStartupEventInfo()` remain explicit in each framework entry point.

## Target structure

```text
src/
  context.ts                   # Request holders, including SERVER span access and ownership
  requestObservation.ts        # Core span and request-record lifecycle, HTTP attribute policy
  webRequestObservation.ts     # Fetch Request and Response observation
  nodeRequestObservation.ts    # IncomingMessage and ServerResponse observation
  packageVersion.ts            # Peer entry and package ownership lookup
  startup.ts                   # Startup payload and private route normalization
  express/
    index.ts
    middleware.ts              # Express dispatch, errors, and route correlation
    register.ts
    routes.ts                  # Express router internals
  hono/
    index.ts
    middleware.ts              # Hono dispatch, cache, errors, and route correlation
    routes.ts                  # Hono route internals
```

The two transport modules should use consistent concepts and control flow where the platform APIs permit it. Their signatures do not need to be identical.

## Internal contracts

These are internal SDK APIs. They are exported between source modules but are not added to package exports.

### Core request observation

Extend `SpanHandle` in `src/context.ts` so one holder carries both access to the request's current SERVER span and the exact span owned by Apitally:

```ts
export interface SpanHandle {
  span?: Span;
  ownSpan?: Span;
}
```

`span` is the mutable request SERVER-span reference used for attributes and exception recording. The span processor may populate or update it. `ownSpan` is assigned at most once and remains the exact span created by Apitally, even if `span` later changes. Only `ownSpan` may be renamed, assigned an SDK-owned lifecycle status, or ended by Apitally. An adopted user span sets `span` but leaves `ownSpan` undefined. Do not replace the owned-span reference with an ownership boolean, because `span` is mutable and could later refer to a different span.

Add a named result type to `src/requestObservation.ts` and annotate `startRequestObservation()` with it:

```ts
export interface StartedRequestObservation {
  requestRecord: RequestRecord;
  requestContext: Context;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
}
```

The transport observation types compose this result instead of repeating its fields. `requestContext` is returned for dispatch but does not need to remain in completion state. Finalization reads both the current request span and Apitally's owned span from `spanHandle`, so adapters cannot pass mismatched span and ownership state.

Add one transport-independent HTTP attribute builder:

```ts
export interface HttpRequestStartAttributeInput {
  method: string;
  path?: string;
  query?: string;
  scheme?: string;
  serverAddress?: string;
  fullUrl?: string;
  clientAddress?: string;
  userAgent?: string;
  requestBodySize?: number;
}

export function resolveHttpRequestStartAttributes(
  input: HttpRequestStartAttributeInput,
): Attributes;
```

The builder owns semantic-convention keys and omits only `undefined` inputs. Node and Web modules own parsing of their native request representations, including whether a native empty value represents unavailable metadata. This preserves the current handling of empty user-agent and client-address values while making equivalent normalized inputs deterministic.

Add failed-dispatch completion:

```ts
export interface FinalizeFailedRequestDispatchOptions {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  error: unknown;
  durationSeconds: number;
}

export function finalizeFailedRequestDispatch(
  options: FinalizeFailedRequestDispatchOptions,
): void;
```

It performs the transport-independent behavior currently in Hono:

1. Set `requestRecord.durationSeconds` from the supplied value.
2. Record the exception on the active request span when it is recording.
3. Mark an SDK-owned span as failed and end it.
4. Release the request record through `handleTransportCompletion()`.

It does not invent a response status, finalize headers or bodies, resolve a route, or swallow the original dispatch error.

Use this function only when outer transport dispatch fails without producing a response. A framework such as Koa that converts middleware rejection into an HTTP response remains on normal Node response completion.

### Fetch API observation

Create `src/webRequestObservation.ts` with these responsibilities:

- Standard `Headers` propagation getter
- Request body `BodyCapture` creation
- Standard URL and header parsing
- Propagation extraction
- Core request observation startup
- Standard response teeing
- Response body completion timestamp

Use a start contract equivalent to:

```ts
export interface StartWebRequestObservationOptions {
  request: Request;
  tracerName: string;
  clientAddress?: string;
}

export interface WebRequestObservation {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  requestHeaders: Headers;
  startTimeMillis: number;
  method: string;
}

export interface StartedWebRequestObservation {
  observation: WebRequestObservation;
  requestContext: Context;
}

export function startWebRequestObservation(
  options: StartWebRequestObservationOptions,
): StartedWebRequestObservation;
```

`startWebRequestObservation()` reads all metadata available from `Request`. `clientAddress` is explicit because it is not part of the Fetch API.

Move the standard response tee behavior behind this contract:

```ts
export interface WebResponseCompletion extends CapturedBody {
  completedAtMillis: number;
}

export interface CapturedWebResponse {
  response: Response;
  completion: Promise<WebResponseCompletion>;
}

export function captureWebResponse(
  response: Response,
  shouldCaptureBody: boolean,
  readTimeoutMillis?: number,
): CapturedWebResponse;
```

Production callers omit `readTimeoutMillis` and retain the five-second default. The optional internal parameter preserves the existing deterministic test seam for unread responses without sleeps or fake timers.

The completion timestamp is captured at the transport completion boundary. The adapter derives duration from that timestamp before starting framework-specific asynchronous enrichment.

Preserve the current response behavior exactly:

- Bodiless responses complete immediately.
- Stream completion marks the body complete.
- Stream failure suppresses a partial body.
- An unread body resolves through the existing five-second fallback.
- The returned application response is the wrapped response.
- The completion promise cannot become an unhandled rejection.

### Node HTTP observation

Create `src/nodeRequestObservation.ts` with these responsibilities:

- Node request URL, header, socket, and propagation parsing
- Request body `BodyCapture` creation
- Passive request-byte observation through `IncomingMessage.emit`
- Core request observation startup
- Response `write()` and `end()` patching
- `finish` and `close` settlement
- Response completion timestamp
- Opt-in server-close flushing

Use a start contract equivalent to:

```ts
export interface StartNodeRequestObservationOptions {
  request: IncomingMessage;
  tracerName: string;
}

export interface NodeRequestObservation {
  requestRecord: RequestRecord;
  spanHandle: SpanHandle;
  rpcMetadata?: RPCMetadata;
  requestBodyCapture: BodyCapture;
  startTimeMillis: number;
  method: string;
  requestUrl: string;
}

export interface StartedNodeRequestObservation {
  observation: NodeRequestObservation;
  requestContext: Context;
}

export function startNodeRequestObservation(
  options: StartNodeRequestObservationOptions,
): StartedNodeRequestObservation;
```

Starting the observation installs passive request-body observation before framework dispatch. It must not add `data` listeners or change the request stream's flow state.

Use a response contract equivalent to:

```ts
export interface NodeResponseCompletion extends CapturedBody {
  completedAtMillis: number;
  responseFinished: boolean;
}

export function captureNodeResponse(
  response: ServerResponse,
  shouldCaptureBody: boolean,
): Promise<NodeResponseCompletion>;
```

`captureNodeResponse()` patches the response immediately and resolves exactly once:

- `finish` resolves with `responseFinished: true` and a complete body.
- `close` before `finish` resolves with `responseFinished: false` and suppresses any partial body.
- `finish` followed by `close` does not finalize twice.
- Response headers are read lazily when capture starts so middleware can set or replace them before the first write.

Keep `firstStringValue()` private in this module. It adapts Node's outgoing-header union to `BodyCapture`; it is not a general header utility.

Expose server-close registration as an opt-in Node primitive:

```ts
export function registerServerCloseFlush(request: IncomingMessage): void;
```

Preserve the current `WeakSet` idempotency and fire-and-forget rejection handling. A server close runs one worker cycle but does not tear down activation or prevent another server from continuing to export.

### Peer package resolution

Create `src/packageVersion.ts`:

```ts
export function resolvePeerEntryPath(packageName: string): string;

export function resolvePeerPackageVersion(
  packageName: string,
): string | undefined;
```

`resolvePeerEntryPath()` retains the current `createRequire(import.meta.url).resolve()` behavior and throws when resolution fails. Existing logger installation paths continue to catch that failure.

`resolvePeerPackageVersion()`:

1. Resolves the package entry.
2. Creates a require function rooted at that entry.
3. Walks from the entry directory toward the filesystem root.
4. Reads each candidate `package.json` when possible.
5. Returns the first string `version` whose package `name` exactly matches `packageName`.
6. Returns `undefined` on resolution failure, malformed metadata, or no matching owner.

The exact-name check prevents a nested dependency's package metadata from being reported as the framework version.

### Startup route normalization

Keep route normalization private to `src/startup.ts`. Do not add an adapter-facing normalizer.

Immediately after `resolvePaths()` succeeds, normalize the returned typed candidates before serialization:

1. Uppercase the method.
2. Exclude `ALL`, `HEAD`, and `OPTIONS`.
3. Deduplicate by normalized method and path.
4. Preserve first-seen order.

The private helper trusts the existing `RoutePath` boundary. Framework route modules remain responsible for interpreting their own internal structures and returning `{ method, path }` candidates.

## Implementation phases

### Phase 1: Extend the core request-observation contract

#### Files

- Modify `src/context.ts`.
- Modify `src/requestObservation.ts`.
- Add `tests/shared/requestObservation.test.ts` for observable attribute and failed-dispatch behavior.

#### Steps

1. Add `ownSpan` to `SpanHandle` and document its set-once ownership invariant.
2. Update `startRequestObservation()` to store an SDK-created span in both `spanHandle.span` and `spanHandle.ownSpan`; adopted spans populate only `spanHandle.span`.
3. Update successful and failed finalization to read the owned span from `spanHandle.ownSpan`.
4. Remove separate `ownSpan` parameters and fields from request observation, adapter state, and finalization options.
5. Add and export `StartedRequestObservation`.
6. Annotate `startRequestObservation()` without otherwise changing its runtime behavior.
7. Add `HttpRequestStartAttributeInput` and `resolveHttpRequestStartAttributes()`.
8. Move semantic-convention key assignment and optional-value omission into the builder.
9. Add `FinalizeFailedRequestDispatchOptions` and `finalizeFailedRequestDispatch()`.
10. Move Hono's transport-independent rejection cleanup into that function.
11. Keep `finalizeRecordAndReleaseRequest()` behavior unchanged for response-producing requests.

#### Verification

- Equivalent normalized inputs produce identical attributes.
- `undefined` inputs are omitted, and normalized empty strings retain the explicitly chosen transport behavior.
- Failed dispatch records the exception and releases the request once.
- An adopted span receives shared request writes but is never renamed or ended by Apitally.
- An Apitally-created span remains available through `spanHandle.ownSpan` and is ended exactly once.
- The supplied duration is retained exactly.
- Existing span adoption, sampling, metrics, and body-stash tests remain green.

### Phase 2: Extract Fetch API observation and migrate Hono

#### Files

- Add `src/webRequestObservation.ts`.
- Modify `src/capture.ts` only as needed to relocate or reuse the existing response tee.
- Modify `src/hono/middleware.ts`.
- Keep `BodyCapture` coverage in `tests/shared/capture.test.ts`.
- Move Fetch response coverage into `tests/shared/webRequestObservation.test.ts`.
- Keep Hono-specific behavior in `tests/hono/hono.test.ts` and `tests/hono/routes.test.ts`.

#### Shared extraction

1. Move the `Headers` propagation getter out of Hono.
2. Move standard request body capture creation and Request metadata parsing into `startWebRequestObservation()`.
3. Parse `request.url` in the Web module and pass normalized values to `resolveHttpRequestStartAttributes()`.
4. Accept Hono's `env.incoming.socket.remoteAddress` result as `clientAddress` input rather than reading Hono environment data in shared code.
5. Move or wrap the existing `captureResponse()` behavior as `captureWebResponse()`.
6. Add `completedAtMillis` at body settlement or the existing unread-body fallback.

#### Hono migration

1. Keep `activate()` and the activation guard at the start of `observeRequest()`.
2. Keep first-request error-handler wrapping in Hono.
3. Resolve Hono's optional client address before calling the shared start function.
4. Compose `WebRequestObservation` with local `honoContext` and `route` state.
5. Continue associating local state with `RequestRecord` through the current `WeakMap`.
6. Run `app.fetch` inside the returned request context.
7. For a synchronous throw or promise rejection:
   - Calculate duration immediately from `performance.now()` and `startTimeMillis`.
   - Call `finalizeFailedRequestDispatch()`.
   - Rethrow the original value unchanged.
8. For a returned response:
   - Call `captureWebResponse()`.
   - Return the wrapped response immediately.
   - Attach rejection handling to its completion chain.
   - Calculate duration from `completedAtMillis` before awaiting Hono body-cache recovery.
   - Recover the request body from Hono's cache.
   - Call `finalizeRecordAndReleaseRequest()` with the captured duration and Hono route.
9. Keep Hono error-handler wrapping, route middleware, body-cache field handling, and `env.incoming` parsing local.

#### Verification

- Existing Hono integration scenarios retain their names and order.
- A streaming response finalizes after its body settles.
- An unread response retains the five-second fallback.
- A failed response stream suppresses the partial body.
- Synchronous and asynchronous dispatch failures are rethrown unchanged and release telemetry.
- Request-body cache recovery does not increase recorded duration.
- Hono route and error integration remain adapter-owned.

### Phase 3: Extract Node HTTP observation and migrate Express

#### Files

- Add `src/nodeRequestObservation.ts`.
- Modify `src/express/middleware.ts`.
- Add `tests/shared/nodeRequestObservation.test.ts`.
- Keep Express-specific behavior in `tests/express/express.test.ts` and `tests/express/routes.test.ts`.

#### Shared extraction

1. Move passive `IncomingMessage.emit` observation into the Node module.
2. Move Node URL, Host header, user-agent, socket, body-size, and propagation parsing into `startNodeRequestObservation()`.
3. Normalize native values through `resolveHttpRequestStartAttributes()`.
4. Move response `write()` and `end()` patching into `captureNodeResponse()`.
5. Keep response body capture lazy so response headers are settled before `BodyCapture` is configured.
6. Capture `completedAtMillis` synchronously in the `finish` or first aborting `close` listener.
7. Move server-close worker-cycle registration into `registerServerCloseFlush()`.
8. Move `firstStringValue()` with Node response capture and keep it private.

#### Express migration

1. Keep `app.handle` wrapping and the app-level `HANDLE_WRAP_MARKER`.
2. Remove `REQUEST_OBSERVED_MARKER` and its nested-app ownership branch.
3. Keep the documented requirement that only the root app calls `useApitally()` in supported nested Express setups.
4. Keep activation and its guard before request timing.
5. Keep one-time Express error middleware registration.
6. Call `registerServerCloseFlush()`.
7. Start Node observation and install response capture before calling Express dispatch.
8. Keep `beginRouteTracking()` and `finishRouteTracking()` in Express.
9. Attach rejection handling to the response completion chain.
10. At completion:
    - Derive duration from `completedAtMillis` before route resolution.
    - Resolve the Express route and registration-order warning.
    - Call `finalizeRecordAndReleaseRequest()` with raw request and response headers.
    - Pass the captured body result, which suppresses partial bytes while preserving existing `BodyCapture` sentinel behavior.
11. Continue dispatch inside the returned request context.
12. Do not add shared callbacks for Express route resolution or warnings.

#### Verification

- Request stream capture remains passive.
- Response bytes written through compression wrappers remain captured.
- `finish` finalizes once with a complete response body.
- An aborting `close` finalizes once and suppresses the partial response body.
- A later `close` after `finish` does not finalize again.
- Server close flushes buffered telemetry without tearing down another server.
- Repeated `useApitally(app)` calls remain idempotent through `HANDLE_WRAP_MARKER`.
- Express routing, unmatched-route behavior, and registration-order warnings remain unchanged.

### Phase 4: Consolidate peer package resolution

#### Files

- Add `src/packageVersion.ts`.
- Modify `src/logCapture.ts`.
- Modify `src/sentry.ts`.
- Modify `src/express/index.ts`.
- Modify `src/express/register.ts`.
- Modify `src/hono/index.ts`.
- Add `tests/shared/packageVersion.test.ts`.

#### Steps

1. Move `resolvePeerEntryPath()` from `src/logCapture.ts` to the new module.
2. Update every existing consumer to import it from `src/packageVersion.ts`: Winston and Pino capture, Sentry peer lookup, Express registration capture, and any adapter code that still needs entry resolution.
3. Implement exports-map-safe parent traversal in `resolvePeerPackageVersion()`.
4. Replace Express's direct `express/package.json` require.
5. Replace Hono's local parent-directory traversal.
6. Remove now-unused `node:module` and `node:path` imports from adapter entry points.
7. Keep `configure()` and `registerStartupEventInfo()` explicit in both adapters.
8. Keep package-resolution failure non-fatal and represented by an absent framework version.

#### Verification

- Express and Hono startup payloads contain their installed package versions.
- Restrictive package exports do not prevent version discovery.
- A candidate package file with a different name is ignored.
- Missing optional logger and Sentry packages retain their current non-fatal behavior.
- Winston, Pino, Sentry, and `express/register` continue resolving from the user's installed package tree.

### Phase 5: Centralize startup route output policy

#### Files

- Modify `src/startup.ts`.
- Modify `src/express/routes.ts`.
- Modify `src/hono/routes.ts`.
- Move shared startup coverage into `tests/shared/startup.test.ts`.
- Update `tests/express/routes.test.ts` and `tests/hono/routes.test.ts` for framework-only route discovery.

#### Steps

1. Add a private startup path normalizer in `src/startup.ts`.
2. Invoke it immediately after `resolvePaths()` returns successfully.
3. Preserve the current fallback that emits versions without paths if route resolution throws.
4. Preserve the current serialization fallback when paths cannot be serialized.
5. Remove generic uppercase and deduplication state from Express route discovery.
6. Keep Express traversal, mount handling, cycle protection, and interpretation of Express-only method metadata local.
7. Remove generic uppercase, `ALL` filtering, and deduplication from Hono route discovery.
8. Keep Hono's `isRouteHandler()` filtering local.
9. Return typed route candidates in framework discovery order and let startup emission normalize them.

#### Verification

- Methods are uppercase in the emitted startup event.
- `ALL`, `HEAD`, and `OPTIONS` are absent, including explicit registrations.
- Duplicate method and path pairs appear once.
- The first-discovered order is preserved.
- Express nested mount paths and Hono route-handler detection remain correct.
- Request tracing and request metrics route behavior do not change.

### Phase 6: Final cleanup and consistency pass

#### Files

- Review all modified source and test files.

#### Steps

1. Remove obsolete local types, imports, helpers, and comments from both adapters.
2. Confirm module order remains public entry points first and supporting helpers afterward.
3. Confirm all optional peer dependencies are still resolved synchronously with `createRequire()`.
4. Confirm no framework package is imported by a shared transport module.
5. Confirm no `instanceof` check crosses an OpenTelemetry package boundary.
6. Confirm all fire-and-forget work and completion chains have rejection handling.
7. Confirm comments describe current constraints rather than the extraction history.
8. Confirm no public package export or stable public API name changed.

## Code that remains framework-specific

### Express

Keep these concerns in `src/express/`:

- `app.handle` wrapping and app-level idempotency
- Error middleware registration
- Router and Route prototype patching
- Registration-time capture tables
- Mount stack tracking and `baseUrl` handling
- Express 4 and 5 path syntax normalization and matching
- `express/register` side effects
- Registration-order warnings

The size of `src/express/routes.ts` reflects Express's lack of a stable public route enumeration API and is not a reason to introduce generic route discovery.

### Hono

Keep these concerns in `src/hono/`:

- `app.fetch` installation and wrap markers
- First-middleware registration and ordering warning
- Matched-route entry inspection
- Composed-handler and `routeIndex` semantics
- Hono body-cache inspection
- Hono `errorHandler` wrapping
- `env.incoming` client-address extraction

Do not move Hono field names or matched-route internals into `webRequestObservation.ts`.

### Small helpers

- Keep `findOwnerOfProperty()` in `src/express/routes.ts`.
- Keep `findPrototypeOwning()` in `src/logCapture.ts`.
- Their traversal semantics differ, and extracting their short loops would obscure those invariants.

## Test ownership

Shared tests own transport and core contracts once extraction is complete:

- `tests/shared/capture.test.ts`: `BodyCapture` eligibility, size, completion, and sentinel behavior
- `tests/shared/requestObservation.test.ts`: emitted start attributes and failed-dispatch telemetry completion
- `tests/shared/webRequestObservation.test.ts`: Fetch propagation, response tee, settlement, timeout, and partial-body suppression
- `tests/shared/nodeRequestObservation.test.ts`: passive request capture, response patching, completion, abort, and server-close behavior
- `tests/shared/packageVersion.test.ts`: entry resolution and matching package ownership
- `tests/shared/startup.test.ts`: normalization, filtering, deduplication, ordering, and failure fallback

Move the affected tests from `tests/capture.test.ts` and `tests/startup.test.ts` into these shared homes. Do not migrate unrelated shared test modules as part of this work.

Framework tests continue to own:

- Hook and wrapper installation
- Dispatch context wiring
- Route discovery and matched-route correlation
- Ordering warnings
- Error-handler integration
- Framework request-body access
- End-to-end proof that each adapter connects framework hooks to shared transport behavior

Keep the canonical Express and Hono integration scenarios in the same order with identical names where the behavior is shared. Do not duplicate low-level response tee, abort, propagation, or attribute-policy cases in every framework suite after ownership moves to the shared module.

Tests must use deterministic completion seams. Do not add wall-clock sleeps or fake timers. Read integration responses to completion before asserting telemetry.

## Validation checkpoints

After each phase that changes code or tests, run both complete project checks:

```sh
npm run check
npm test
```

Do not substitute focused test commands for these checks.

Before declaring the entire implementation complete:

1. Run `npm run check`.
2. Run `npm test`.
3. Run `git diff --check`.
4. Review the complete diff for accidental public API changes.
5. Confirm the final diff contains no implementation of the subsequent framework adapters.

## Completion criteria

This preparation is complete when all of the following are true:

- Express and Hono use the new shared transport modules.
- Their user-observable telemetry behavior remains unchanged except for the accepted startup path filtering policy.
- Fetch and Node transport completion own duration boundary timestamps.
- Framework-specific asynchronous enrichment cannot inflate request duration.
- Failed Fetch dispatch uses the shared failed-dispatch finalizer and rethrows unchanged.
- Node request and response capture no longer live in the Express adapter.
- Standard Fetch request and response observation no longer live in the Hono adapter.
- HTTP start attributes are produced by one shared policy function.
- `SpanHandle` carries both the mutable request SERVER span and the exact Apitally-owned span, with no separate ownership field in adapter state.
- Peer package versions use one exports-map-safe resolver.
- Startup path normalization is private to startup emission.
- Express no longer uses `REQUEST_OBSERVED_MARKER`.
- Server-close flushing remains available as an opt-in Node primitive.
- Framework routing, body-cache access, dispatch hooks, and error integration remain local.
- All complete project checks pass.

The codebase is then ready for the subsequent AdonisJS, Elysia, Fastify, H3, Hapi, Koa, and NestJS adapter work.