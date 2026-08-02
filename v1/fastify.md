# Fastify support implementation plan

## Goal

Add Fastify support to the v1 SDK with the same public setup and telemetry behavior as the Express and Hono integrations:

```ts
import Fastify from "fastify";
import { useApitally } from "apitally";

const app = Fastify();
useApitally(app, options);
```

Support Fastify `>=4.10.2 <6`. Keep the integration limited to Fastify lifecycle wiring, route discovery, and context propagation. Shared request observation, body capture, spans, metrics, logs, sampling, redaction, activation, and export remain framework-independent.

## Research conclusions

### Fastify v4 and v5

- Fastify 4.10.2 and 5 expose the hooks needed by the integration: `onRoute`, `onReady`, `onRequest`, `preValidation`, `onError`, `onResponse`, and `onClose`.
- `request.routeOptions.url` exists in Fastify 4.10.2 and is the supported route-template API in Fastify 5. Fastify 5 removed the deprecated `request.routerPath` API, so the v1 integration should use `routeOptions.url` without a legacy fallback.
- `routeOptions.url` includes plugin prefixes. This provides the complete parameterized route template without reconstructing router state.
- `onResponse` runs after the response has been sent. The existing raw Node response observer is still the better completion source because it also handles socket close and preserves exact wire body and size behavior.
- Fastify hooks are encapsulated. Installing them on the root instance before routes and child plugins makes them apply throughout the app.

### v0 integration

Carry forward the parts that remain relevant to v1:

- route discovery through `onRoute`;
- activation at `onReady` and graceful lifecycle handling at `onClose`;
- request setup in `onRequest` plus context restoration before validation and handlers;
- exception observation through `onError`;
- final route resolution from `request.routeOptions.url`;
- Fastify v4 and v5 matrix coverage.

Do not port v0 mechanisms now owned by the v1 shared core:

- request counters, validation aggregation, bespoke request logs, and server-error payloads;
- request and reply decorators used for v0 consumer and payload state;
- integration-specific console, Pino, Winston, or NestJS patches;
- the v0 `setConsumer(request, ...)` API;
- response-time and content-length fallbacks;
- `routerPath` compatibility for versions below the new floor.

NestJS support remains a separate integration phase. Fastify support should not add NestJS detection, interceptors, or logging patches.

## Public API and packaging decisions

### Use the existing `useApitally` API

Add `apitally/fastify`, exporting the framework-typed `useApitally` and `ApitallyOptions`, matching `apitally/express` and `apitally/hono`. Add Fastify detection to the root `useApitally` function.

Do not expose a separate `apitallyPlugin` API in v1. `useApitally(app)` can install hooks directly on the root Fastify instance, which is simpler, avoids a second setup style, and does not require `fastify-plugin`.

The documented ordering contract is:

1. Create the root Fastify instance.
2. Call `useApitally(app)`.
3. Register application plugins, hooks, and routes.
4. Start or ready the app.

This ordering gives the route collector complete startup data and makes the request hooks ancestors of all child plugin scopes.

### Dependencies

Update `package.json` as follows:

- add optional peer dependency `fastify: ">=4.10.2 <6"`;
- add matching `peerDependenciesMeta.fastify.optional`;
- add the current Fastify 5 release as a dev dependency;
- add the `./fastify` import and require export conditions;
- update the package description and keywords to include Fastify;
- do not add `fastify-plugin`;
- leave `sideEffects` unchanged because the Fastify entry has no import-time behavior.

`tsup.config.ts` already includes every `src/**/*.ts` module, so it needs no Fastify-specific entry.

## Implementation design

### Source layout

Add:

```text
src/fastify/
  index.ts
  middleware.ts
  routes.ts
```

This mirrors the existing integration layout while keeping each concern small.

### Shared Node request observation adjustments

Make two small shared changes before writing Fastify-specific code.

#### `src/requestObservationNode.ts`

Add `finalizeNodeRequestObservation(...)`. It should accept a `NodeRequestObservation`, its `NodeResponseCompletion`, and framework-resolved status, route, and headers. Move these currently Express-local operations into it:

- duration calculation from the raw response completion timestamp;
- request and response body-size selection;
- suppression of captured bodies for dropped requests;
- the call to `finalizeRecordAndReleaseRequest`.

Update `src/express/middleware.ts` to use this function after Express-specific route tracking. Fastify can then call the same finalizer with `request.raw.headers`, `reply.raw.getHeaders()`, `reply.statusCode`, and its resolved route.

Keep raw response completion in `captureNodeResponse`. It already provides the required Fastify behavior:

- patches `write` and `end` before handler dispatch;
- captures bytes after serializers and compression, at the wire boundary;
- completes on `finish` or `close`;
- suppresses partial response bodies after an aborted connection;
- combines request and response capture results without reading streams itself.

Before starting request observation, the Fastify hook should directly check for a case-insensitive `Upgrade: websocket` header and continue without instrumenting that request. Keep this check local to the integration; it does not justify a shared helper or WebSocket-specific dependency.

#### `src/activation.ts` and `src/requestObservationNode.ts`

Add an internal `flushTelemetry()` function that runs one export-worker cycle when activated, catches failures, and never rejects into framework lifecycle code.

Use it from both:

- `registerServerCloseFlush()` for Express;
- Fastify's `onClose` hook.

This gives Express and Fastify identical non-destructive server-close behavior. Full teardown remains the public `shutdown()` function.

### `src/fastify/index.ts`

Implement the same setup shape as the other integrations:

1. Call `configure(options)`.
2. Register startup event info with framework name `fastify`, `resolvePackageVersion("fastify")`, and the lazy route collector.
3. Install Fastify hooks once.

Export only `useApitally` and the `ApitallyOptions` type.

### `src/fastify/routes.ts`

Keep route handling deliberately small:

- maintain an integration-owned list populated by `onRoute`;
- expand string or array methods into `{ method, path }` entries;
- retain Fastify's complete `routeOptions.url`, including prefixes;
- let shared startup normalization uppercase methods, remove duplicates, and exclude `ALL`, `HEAD`, and `OPTIONS`;
- resolve a request route as `undefined` when `request.is404` is true, otherwise use `request.routeOptions.url`;
- never use the raw request URL as a route fallback.

No Fastify router internals or `printRoutes()` parsing should be used.

### `src/fastify/middleware.ts`

Install hooks directly on the root instance. Guard installation with a `Symbol.for` marker on the instance so repeated setup and mixed ESM/CJS loading cannot add duplicate hooks.

Use a `WeakMap<FastifyRequest, FastifyRequestObservation>` for private per-request integration state. Do not decorate Fastify request or reply objects and do not add declaration merging.

#### `onReady`

Call `activate()` synchronously. This uses Fastify readiness as the primary serving-lifecycle signal and emits the startup event after route registration has completed.

#### `onRequest`

For every request:

1. Call `activate()` as the idempotent first-request fallback.
2. If activation did not succeed, call `done()` and leave Fastify untouched.
3. If `request.raw.headers.upgrade` is `websocket` case-insensitively, call `done()` without instrumenting the request.
4. Call `startNodeRequestObservation` with `request.raw` and tracer name `apitally.fastify`.
5. Start `captureNodeResponse` immediately with `reply.raw`, before application hooks and handlers can write.
6. Store the observation and OTel request context in the request `WeakMap`.
7. Continue Fastify by calling `done()` inside `context.with(requestContext, ...)`.
8. Attach rejection handling to the response-completion promise. On completion, resolve the Fastify route and call the shared Node finalizer.

All failures should log through the SDK logger and continue the request without throwing into Fastify.

#### `preValidation`

Re-enter the stored OTel request context and invoke `done()` inside it. This carries the SERVER span, request record, consumer holder, and log linkage through Fastify validation, later hooks, and the route handler.

This is the v1 equivalent of the context restoration proven necessary by the v0 integration, but it uses the existing OTel context manager rather than a second integration-owned `AsyncLocalStorage` store.

#### `onError`

Record the error while running inside the stored request context, then call `done()` without replacing or rethrowing the error.

Avoid recording Fastify validation and other expected client errors as unhandled exceptions. Record when the error has no HTTP status or its status is `>=500`. The final response status still comes from `reply.statusCode` during response completion.

#### Raw response completion

Finalize from `captureNodeResponse`, not only from `onResponse`. At completion:

- route: `undefined` for `request.is404`, otherwise `request.routeOptions.url`;
- status: `reply.statusCode`;
- request headers: `request.raw.headers`;
- response headers: `reply.raw.getHeaders()`;
- duration and captured bodies: shared Node finalizer.

This covers normal responses, custom error handlers, streamed responses, hijacked/raw responses that still finish, and client disconnects through one completion path.

#### `onClose`

Await `flushTelemetry()`. Do not call full `shutdown()` from the hook. This matches Express server-close semantics, avoids integration ownership of global SDK teardown, and leaves `shutdown()` as the coordinated application-level API.

## Root entry changes

Update `src/index.ts`:

- import the Fastify integration;
- add `isFastifyApp` using stable public instance shape, such as `version`, `addHook`, `register`, `route`, `ready`, and `close`;
- keep Express and Hono predicates precise so the new branch cannot steal their apps;
- dispatch Fastify apps to the typed integration;
- include `apitally/fastify` in the unsupported-framework error.

Add one root-entry integration test that creates a real Fastify app and observes a route-templated SERVER span. Assert only enough to prove root dispatch; the Fastify integration suite owns detailed telemetry behavior.

## Test plan

### Layout

Add:

```text
tests/fastify/
  app.ts
  fastify.test.ts
  routes.test.ts
```

Use the same fixture route names, registration order, test names, and scenario order as Express and Hono wherever behavior is shared. Extend `tests/utils.ts` only when an existing helper cannot express a Fastify lifecycle operation.

Use real Fastify instances and a real listening server for transport behavior. Do not mock Fastify hooks or request/reply objects. Await response bodies and deterministic pipeline completion before assertions. Do not add sleeps or fake timers.

### Uniform app fixture

`tests/fastify/app.ts` should mirror the existing fixtures:

- `GET /items/:id`;
- `POST /items` with JSON parsing;
- `GET /healthz`;
- `GET /error`;
- `GET /consumer`;
- `GET /stream`;
- nested prefixed plugins under `/api` and `/api/v2`.

Call `useApitally` immediately after creating the root app and before registering these routes and plugins.

### Canonical integration scenarios

Copy the shared scenario names and order from Express and Hono, adapting only request-driving details:

1. exports one SERVER span with stable HTTP semantic-convention attributes and `{method} {route}` naming;
2. continues sampled and unsampled remote `traceparent` values;
3. includes nested plugin prefixes and clears the route for unmatched requests, with unmatched requests omitted from metrics;
4. excludes health checks from spans but counts them in metrics, while `OPTIONS` appears in neither;
5. records an unhandled error as an exception event and preserves the Fastify 5xx response;
6. adopts a user-produced SERVER span without creating a duplicate;
7. captures, masks, and redacts request and response bodies without exposing payloads on the live span;
8. records complete streamed response bodies and sizes;
9. propagates a handler-set consumer into metrics;
10. remains idempotent across repeated `useApitally` calls;
11. drops spans but keeps metrics at `sampleRate: 0`.

Do not duplicate shared-core tests for sampling, redaction, body limits, spool behavior, or exporters.

### Fastify-specific scenarios

Add focused coverage for behavior introduced by the integration:

- `onReady` activates before the first request and emits a startup event containing complete prefixed route templates;
- `onClose` allows pending telemetry to flush without tearing down the global SDK;
- context remains active through Fastify hooks and handlers, proven by one correctly parented child span;
- a Fastify validation response remains a normal 4xx request without an unhandled exception event;
- a request carrying a case-insensitive `Upgrade: websocket` header continues normally without producing an Apitally span or request metric.

Keep `tests/fastify/routes.test.ts` for consistency with the other integrations. Use real Fastify route registration and readiness, and keep it focused on startup enumeration and route resolution rather than repeating framework integration scenarios.

### Existing tests

Update:

- `tests/index.test.ts` for root Fastify detection and the unsupported-framework error text;
- any integration consistency comments or helper tables that currently name only Express and Hono.

Rely on `npm run build` and `npm run check:package` to validate the ESM/CJS `apitally/fastify` export instead of adding dedicated built-artifact smoke tests.

## Compatibility matrix

Extend `.github/workflows/tests.yaml` with:

- current Fastify 5;
- current Fastify 4;
- the exact floor, Fastify 4.10.2.

Run these scenarios across the existing Node 20, 22, and 24 lanes. Do not add `fastify-plugin` to the matrix.

The floor lane is important because it proves that `routeOptions.url` and the selected lifecycle hooks are sufficient without deprecated fallbacks. The Fastify 5 lane proves that no removed v4 properties are used.

Pino capture keeps the SDK's existing support policy. Do not add a Fastify-specific logger patch or restore Pino 8 support as part of this integration. Fastify 4 applications that want Pino application-log capture must use a Pino version supported by the v1 SDK; request spans, request metrics, exception events, and other supported logging surfaces remain unaffected.

## Documentation changes

Update `README.md`:

- title, summary, and supported-framework table where they explicitly list only Express and Hono;
- Fastify setup example with `useApitally(app)` immediately after `Fastify()`;
- explicit ordering requirement before plugins and routes;
- framework-specific entry list to include `apitally/fastify`;
- graceful-shutdown text to note that `app.close()` triggers a flush and coordinated full teardown still uses `shutdown()`.

Do not document `apitallyPlugin`, request decorators, or v0 Fastify APIs.

## Implementation order

1. Extract shared Node finalization and shared lifecycle flushing; migrate Express to both without changing its observable behavior.
2. Add Fastify route collection and request lifecycle hooks.
3. Add the typed Fastify entry, root detection, exports map, and optional peer dependency.
4. Add the uniform fixture, canonical integration scenarios, and the focused Fastify-specific tests listed above.
5. Add Fastify v4/v5/floor matrix lanes and README documentation.
6. Run the prepared Fastify app in the cross-SDK test harness.
7. Review all three integration suites together for identical shared test names, ordering, fixture routes, helper reuse, and coverage ownership.

## Verification

Run the complete project checks:

```bash
npm run check
npm test
npm run build
npm run check:package
```

Run the prepared Fastify application through the cross-SDK integration harness:

```bash
cd ../sdk-tests
uv run sdk-tests test fastify
```

Use the existing `../sdk-tests/javascript/fastify` fixture rather than creating another external test app. Confirm in CI that Fastify 4.10.2, current Fastify 4, and current Fastify 5 pass on every supported Node lane.

## Definition of done

- Root and `apitally/fastify` setup both instrument a Fastify app.
- One request produces at most one SERVER span and one metrics observation.
- Route templates always come from Fastify route metadata, include plugin prefixes, and are absent for 404s.
- Request context reaches validation, hooks, handlers, child spans, application logs, and runtime helper calls.
- Normal, error, streaming, and aborted raw response completion cannot leave request telemetry in flight.
- Requests carrying `Upgrade: websocket` bypass Apitally request telemetry.
- `onReady` activates with complete startup routes; `onClose` flushes without owning global teardown.
- No Fastify internals, `routerPath`, `getResponseTime`, request/reply decorators, integration-local telemetry pipeline, or `fastify-plugin` dependency is introduced.
- Express behavior remains unchanged after the shared-code extraction.
- All local checks, `uv run sdk-tests test fastify`, and the complete Fastify version matrix are green.
