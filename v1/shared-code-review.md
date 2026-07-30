# Framework adapter shared-code review

## Scope

Reviewed the current `v1` implementations in:

- `src/express/`
- `src/hono/`
- Existing shared request, capture, startup, activation, and logging modules
- The framework implementations on `origin/main`: AdonisJS, Elysia, Fastify, H3, Hapi, Koa, and NestJS

The current framework directories contain about 1,400 lines in total. Most of `src/express/routes.ts` is necessarily Express-specific, but substantial parts of both middleware modules implement transport behavior rather than framework behavior.

## Executive summary

The best boundary is not one generic `FrameworkAdapter` interface. That would hide important differences and accumulate callbacks. The useful shared layers are:

1. Fetch API lifecycle primitives for `Request` and `Response`.
2. Node HTTP lifecycle primitives for `IncomingMessage` and `ServerResponse`.
3. A transport-independent HTTP attribute builder and explicit shared observation types.
4. Shared peer package entry and version resolution, with adapter setup kept explicit.
5. Shared startup route normalization and deduplication.
6. A shared failed-dispatch finalizer, with small transport and prototype helpers kept at their narrowest justified scope.

With those layers, future adapters should mainly answer four framework-specific questions:

- Where is the request dispatch boundary?
- How is the matched route obtained?
- Where can an unhandled exception be observed?
- How can request bytes consumed by the framework be recovered without consuming the application stream?

Express should retain its router registration and dispatch patches. Hono should retain its route-entry inspection, body-cache access, error-handler wrapper, and `env.incoming` handling. The transport mechanics around those pieces should move out.

## Findings

### 1. Extract Fetch API lifecycle primitives from Hono

**Priority: P0**

#### Evidence

The following code in `src/hono/middleware.ts` depends primarily on standard Web APIs and Apitally internals, not Hono:

- Core fields in the request observation state: lines 28-36
- `Headers` propagation getter: lines 45-48
- Request body capture initialization, trace-context extraction, and `startRequestObservation()` call: lines 137-180, except for the Hono error-wrapper trigger and `env`-based client address
- Response teeing and asynchronous completion: lines 184-201
- Record finalization from a standard `Response`: lines 204-231, except for the Hono body-cache call and matched-route field
- Rejected dispatch cleanup: lines 235-252
- Most URL and header attribute extraction: lines 319-355, except for Hono's `env.incoming` client address

The Hono-specific pieces are much smaller:

- Wrapping `app.fetch`
- Registering `recordMatchedRouteAfterNext`
- Reading `c.req.bodyCache`
- Reading Hono matched route entries
- Wrapping Hono's `errorHandler`
- Resolving `env.incoming.socket.remoteAddress`

#### Decision

**Status: Accepted**

Place Fetch-specific primitives in `src/webRequestObservation.ts` and keep transport-neutral failure finalization in `src/requestObservation.ts`. Extract small Fetch lifecycle primitives rather than a full transport observer. Hono keeps orchestration of the request lifecycle visible in its adapter.

The shared primitives cover:

- The `TextMapGetter<Headers>` instance
- Starting an observation from a standard `Request`
- Creating the request `BodyCapture`
- Extracting URL, headers, and propagation context
- Teeing a standard `Response` with `captureResponse()`
- Completing a response observation after its body settles
- Releasing an observation when dispatch rejects

The shared start primitive accepts a standard `Request` plus optional transport metadata that is unavailable from the Web API, such as `clientAddress`. It reads the method, URL, headers, body metadata, and propagation context directly from the request.

The shared response primitive returns both the teed response and a completion promise for the captured response body. Hono attaches rejection handling and explicitly chains request-body recovery and finalization after that promise settles.

Hono catches synchronous throws and promise rejections at its dispatch boundary, calls a shared failure-finalization primitive, and rethrows the original error unchanged. Shared code owns telemetry cleanup but does not invoke framework dispatch.

Hono remains responsible for calling the shared operations in the correct order and for supplying its matched route and recovered request body before finalization. Shared observation state must not contain `honoContext` or `matchedRoute`; Hono composes that state locally.

#### Concrete future reuse

`origin/main:src/h3/plugin.ts` and `origin/main:src/elysia/plugin.ts` both receive standard `Request`/`Response` objects and independently call the shared response tee used by the old SDK. The H3 adapter could use these lifecycle primitives and supply H3's matched route, error hook, and request-body access. Elysia could do the same around its response-mapping boundary.

#### Expected result

`src/hono/middleware.ts` becomes mostly Hono registration, route correlation, error capture, and body-cache recovery. The tracing, propagation, response capture, completion, and rejection behavior is implemented once for all Fetch-based frameworks.

### 2. Extract Node HTTP lifecycle primitives from Express

**Priority: P0**

#### Evidence

Large sections of `src/express/middleware.ts` operate only on Node HTTP objects:

- Core request setup from `IncomingMessage` and `ServerResponse`: lines 93-129, apart from `beginRouteTracking()`
- Response `write`/`end` patching and finish/close handling: lines 149-202
- Response finalization: lines 205-247, apart from Express route resolution and its warning
- Non-invasive request stream capture through `emit`: lines 253-275
- Flush-on-server-close registration: lines 278-296
- Node request URL, host, socket, and header attributes: lines 298-345

None of request byte capture, wire response capture, aborted response handling, server-close flushing, or raw Node HTTP metadata is specific to Express.

The Express-specific code is:

- Wrapping `app.handle`
- Appending Express error middleware
- Calling `beginRouteTracking()` and `finishRouteTracking()`
- Emitting the Express registration-order warning

#### Decision

**Status: Accepted**

Extract composable Node transport primitives rather than a full transport observer. Express explicitly orchestrates request-stream capture, response-stream capture, settlement, and server-close flushing around its dispatch and route tracking.

The Node and Fetch transport modules must mirror each other wherever their platform APIs allow it. Use consistent names, file structure, observation state, start/completion mechanics, failure finalization, and adapter control flow. Platform-specific stream and body behavior remains isolated behind those parallel interfaces.

The Node start primitive accepts an `IncomingMessage` directly and reads its standard method, URL, headers, socket data, body metadata, and propagation context. The adapter supplies only metadata unavailable from the raw request. Starting the observation also creates `BodyCapture` and installs passive request-byte observation on `IncomingMessage.emit`; this is standard Node transport behavior rather than adapter policy.

The Node response-capture primitive patches the supplied `ServerResponse` immediately and returns a completion promise containing the captured body result and whether the response finished completely. Express explicitly attaches rejection handling, resolves its route, and finalizes the observation. This mirrors the Fetch primitive's response-plus-completion contract without forcing unlike platform APIs into identical signatures.

The Express adapter resolves its route and supplies framework data at completion; shared Node code must not depend on Express request fields or invoke framework callbacks.

Remove `REQUEST_OBSERVED_MARKER`. Calling `useApitally()` for multiple apps that process the same raw request is unsupported SDK misuse. Supported nested Express setups configure only the root app. The existing app-level wrap marker continues to make repeated `useApitally(app)` calls and mixed ESM/CJS package copies idempotent. The shared Node primitives do not coordinate observation ownership across separately configured apps or layered framework adapters.

Retain server-close flushing. Signal handling drains only telemetry completed when the signal arrives; it does not wait for the application server or in-flight requests. A close-triggered cycle captures telemetry completed during graceful request draining and also covers server shutdowns without a process signal. Expose the Node server-close mechanism as an opt-in shared primitive. Express calls it, and a future Koa adapter can do the same; frameworks with lifecycle shutdown hooks use those hooks instead.

#### Concrete future reuse

`origin/main:src/adonisjs/middleware.ts` directly patches `ctx.response.response.writeHead` and `.end`, and reads `ctx.request.raw()`. It can reuse the Node HTTP stream capture and completion layer instead. Koa exposes the same raw Node request/response pair, while Fastify exposes `request.raw` and `reply.raw`, so they can also share this implementation.

#### Expected result

Express retains only its dispatch and routing integration. Node stream correctness, compressed wire-byte capture, abort behavior, and server-close flushing are solved once for every Node-hosted framework.

### 3. Centralize HTTP start attributes and shared observation types

**Priority: P0**

#### Evidence

`src/express/middleware.ts:298-336` and `src/hono/middleware.ts:319-355` independently construct the same semantic convention attributes:

- `http.request.method`
- `url.path`
- `url.query`
- `url.scheme`
- `server.address`
- `url.full`
- `client.address`
- `user_agent.original`
- `http.request.body.size`

The input parsing differs by transport, but attribute policy does not. This duplication is especially risky because future adapters could silently omit an attribute or apply different empty-value behavior.

The adapters define parallel `RequestObservation` interfaces that repeat the completion-relevant fields returned by `startRequestObservation()` (`requestRecord`, `spanHandle`, `ownSpan`, and `rpcMetadata`) while adding transport state such as method, start time, and body capture. The returned `requestContext` is used to run dispatch and is not stored in the completion observation.

#### Decision

**Status: Accepted**

Use a transport-independent HTTP attribute builder. Node and Fetch transport modules normalize their native request data into one input; the builder owns semantic-convention attribute names and omission rules.

The builder accepts explicit optional normalized fields:

```ts
resolveHttpRequestStartAttributes({
  method,
  path,
  query,
  scheme,
  serverAddress,
  fullUrl,
  clientAddress,
  userAgent,
  requestBodySize,
})
```

This represents requests whose path is known but whose full URL is unavailable without synthetic data. Transport modules parse their native URL, header, and socket representations into this input. The builder owns attribute naming and omission rules.

Export a named `StartedRequestObservation` type for the object returned by `startRequestObservation()`. The Node and Web transport modules compose that type instead of restating its fields. Keep duration timing in the transport observation object so completion and rejection use one representation.

#### Concrete future reuse

`origin/main:src/fastify/plugin.ts` currently rebuilds request URL, protocol, host, sizes, method, and route from Fastify fields during completion. A future Fastify adapter can normalize those fields once and use the same attribute builder, guaranteeing parity with Express and Hono.

#### Expected result

All frameworks emit the same HTTP semantic convention attributes. Framework adapters only normalize native request data; they do not define telemetry policy.

### 4. Share peer package entry and version resolution

**Priority: P1**

#### Evidence

`src/express/index.ts:11-23` and `src/hono/index.ts:11-20` repeat:

- `configure(options)`
- `registerStartupEventInfo(...)`
- Framework name and version registration
- Deferred route resolution

They then contain separate package version implementations:

- Express directly requires `express/package.json`: `src/express/index.ts:28-39`
- Hono walks upward from its resolved entry because the exports map hides `package.json`: `src/hono/index.ts:25-51`

Package version discovery is not framework-specific. The robust Hono strategy works for packages with restrictive exports maps and can also handle Express.

#### Decision

**Status: Accepted**

Extract only package ownership and version discovery. Keep `configure()` and `registerStartupEventInfo()` visible in each framework entry point; a generic setup helper would hide initialization to save only a few lines.

Create `src/packageVersion.ts` and move `resolvePeerEntryPath()` out of `src/logCapture.ts` into it. The module resolves the package entry and walks upward through parent directories. It accepts the first `package.json` whose `name` matches the requested package, returns its version, and returns `undefined` on failure. This single algorithm works with restrictive exports maps without a direct-package-json fast path. Log capture and framework adapters import peer-resolution behavior from this module.

#### Concrete future reuse

Every framework on `origin/main` resolves its own package version. For example, `origin/main:src/adonisjs/provider.ts` resolves `@adonisjs/core`, and `origin/main:src/hapi/utils.ts` resolves `@hapi/hapi`. Both can use the same exports-map-safe resolver.

#### Expected result

Framework entry points resolve package versions consistently while keeping their short setup sequence explicit.

### 5. Normalize and deduplicate startup route paths in shared code

**Priority: P1**

#### Evidence

Both current route modules own generic collection policy:

- Express creates `seenPaths`, uppercases methods, builds a `METHOD path` key, and suppresses duplicates in `src/express/routes.ts:107-160`.
- Hono repeats the same key-based deduplication in `src/hono/routes.ts:39-53`.

The main-branch adapters show that this policy otherwise spreads quickly:

- Elysia filters `HEAD` and `OPTIONS` in `origin/main:src/elysia/utils.ts:27-38`.
- Fastify normalizes a method-or-method-array and filters `HEAD` and `OPTIONS` in `origin/main:src/fastify/plugin.ts:69-80`.
- H3 and Hapi repeat similar filtering in their utility modules.
- Koa has another independent route-list loop.

#### Decision

**Status: Accepted**

Normalize framework-discovered route candidates privately in `emitStartupEvent()` immediately after `resolvePaths()` returns. This affects only the endpoint list in the startup event; it does not change request tracing or metrics or add another adapter-facing API. Framework adapters remain responsible for discovering candidates and distinguishing route handlers from middleware. Startup emission owns the common output policy:

- Uppercase methods
- Exclude `ALL`, `HEAD`, and `OPTIONS`, including explicitly registered routes
- Deduplicate by normalized method and path
- Preserve first-seen order

Adapters interpret and validate their own framework route structures, then return typed `{ method: string; path: string }` candidates from `resolvePaths()`. The private emission-time normalizer trusts that typed boundary instead of repeating runtime validation. Express recursively emits candidates from its captured router tables. Hono emits candidates from `app.routes` only after applying `isRouteHandler()`.

#### Concrete future reuse

A future Fastify adapter receives `routeOptions.method` as either one method or an array. It can expand those candidates and return them from `resolvePaths()`; startup emission applies uppercase, filtering, order, and deduplication policy.

#### Expected result

Framework route discovery remains native and minimal, while startup-event path policy stays identical across all adapters.

### 6. Resolve small non-framework primitives in framework files

**Priority: P2**

**Status: Accepted**

These decisions follow the transport work rather than drive the design.

#### 6.1 Node header value normalization

**Decision:** Keep `firstStringValue()` as a private detail of `src/nodeRequestObservation.ts`. It adapts Node's outgoing header union to `BodyCapture` and moves naturally with the response-capture extraction. Do not widen generic `BodyCapture` input types or create a separate header utility module.

**Future reuse:** Future Fastify and AdonisJS adapters can use the shared Node response-capture primitive, which contains this normalization.

#### 6.2 Prototype owner lookup

**Decision:** Keep `findOwnerOfProperty()` in `src/express/routes.ts` and `findPrototypeOwning()` in `src/logCapture.ts`. Their shared loop is only a few lines, while their starting semantics express different invariants: Express includes the supplied object, and log capture deliberately skips each logger instance to find a shared prototype. A shared module would save negligible code and make the log-capture intent less direct. The previously proposed Elysia reuse was speculative and does not justify extraction.

#### 6.3 Shared dispatch-error completion

**Decision:** `http.server.request.duration` measures the full observed server-side request lifetime after successful SDK activation, from the start of request observation through response transport completion. One-time first-request SDK activation is excluded so the metric matches the owned SERVER span boundary. Express ends timing on `finish` or aborting `close`; Fetch adapters end it when the returned response body stream settles; dispatch failure ends it when dispatch throws or rejects. This includes middleware, route handling, serialization, compression, and streaming. Handler-only execution time would require a separately named metric or child span.

Transport adapters calculate `durationSeconds` immediately at successful response completion or dispatch failure, before asynchronous route or body enrichment, and pass it to core finalization. `src/hono/middleware.ts:235-252` manually records an exception, marks an owned span as failed, ends it, sets duration, and releases transport completion. Those operations are transport-independent and belong in `src/requestObservation.ts` as an explicit failed-dispatch finalizer that accepts the calculated duration.

**Reuse rule:** Use the shared failed-dispatch finalizer only when the outer transport dispatch throws or rejects without producing a response. Frameworks such as Koa that catch middleware rejection and convert it into an HTTP response remain on the normal Node response-completion path.

## Code that should remain framework-specific

### Express

Keep the following in `src/express/`:

- `app.handle` wrapping and its app-level idempotency marker
- Error middleware registration
- Router and Route prototype patching
- Registration-time capture tables
- Mount stack tracking and Express `baseUrl` handling
- Express 4/5 path syntax normalization and matching
- The side-effectful `express/register` entry point
- Express-specific registration-order warnings

Most of `src/express/routes.ts` is justified framework code. Its size reflects Express's lack of a stable public route enumeration API, not a missing generic route abstraction.

### Hono

Keep the following in `src/hono/`:

- `app.fetch` installation and wrap markers
- First-middleware registration and ordering warning
- Matched-route entry inspection and composed-handler detection
- `c.req.routeIndex` semantics
- Hono body-cache inspection
- Hono `errorHandler` wrapping
- `env.incoming` client address extraction

Do not move Hono body-cache field names or matched-route internals into a generic Web transport module.

## Recommended target structure

One simple target structure is:

```text
src/
  requestObservation.ts        # Core span/record lifecycle and HTTP attribute policy
  webRequestObservation.ts     # Fetch Request/Response lifecycle primitives
  nodeRequestObservation.ts    # IncomingMessage/ServerResponse lifecycle primitives
  packageVersion.ts            # Peer package ownership/version lookup
  startup.ts                   # Startup payload and route normalization
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

Names should be chosen to match the final APIs. The important design decision is the two parallel transport modules with explicit adapter orchestration, not the exact filenames.

## Recommended implementation order

1. Export the shared started-observation type and failed-dispatch finalizer from `requestObservation.ts`.
2. Extract the HTTP attribute builder and make Express/Hono parity tests pass unchanged.
3. Extract the Fetch API transport from Hono.
4. Extract the Node HTTP transport from Express, remove `REQUEST_OBSERVED_MARKER`, and retain opt-in server-close flushing.
5. Extract peer entry and package version resolution into `packageVersion.ts`; keep adapter setup explicit.
6. Add private startup route normalization in `emitStartupEvent()` with `ALL`, `HEAD`, and `OPTIONS` excluded.
7. Move Node header normalization with Node response capture and keep the two prototype walks local.

This order establishes contracts at the lowest layer before moving adapter code onto them.

## Testing recommendations

Follow the existing ownership rule while extracting:

- Move transport semantics into one shared test home per new module.
- Keep framework suites responsible for hook installation, route resolution, ordering warnings, error-handler integration, and framework body access.
- Retain the canonical cross-framework integration scenarios with identical names and order.
- Do not duplicate response tee, abort, propagation, or attribute-policy tests in every new framework once shared modules own those contracts.
- Preserve focused end-to-end coverage proving each adapter actually connects its route and error hooks to the shared transport.

Important shared contracts to pin are:

- Fetch responses finalize only after the returned body settles.
- Node responses finalize once on `finish` or `close`.
- Partial response bodies are never exported.
- Every SDK-created completion promise handles rejection.
- Equivalent normalized request inputs emit identical attributes across transports.

## Final recommendation

Implement the Fetch and Node transport extractions before adding the next framework. They provide the largest reduction in future duplication and define two clear families for upcoming adapters:

- Fetch-based: Hono, H3, Elysia
- Node HTTP-based: Express, Koa, Fastify, Hapi, AdonisJS, and NestJS through its platform adapter

Keep routing and framework lifecycle integration local. Share transport mechanics, telemetry policy, startup policy, and package discovery. This gives future adapters a small, stable foundation without forcing unlike frameworks through one oversized abstraction.
