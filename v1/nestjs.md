# NestJS support implementation plan

## Goal

Add NestJS 10 and 11 support through `apitally/nestjs` while keeping Nest-specific behavior thin. The integration will install the existing Express or Fastify observation implementation on Nest's native HTTP instance, then add only Nest's handler-chain exception integration. Default Nest logger capture joins the existing activation-time log integrations.

The public setup remains synchronous:

```ts
import { useApitally } from "apitally/nestjs";

const app = await NestFactory.create(AppModule);
useApitally(app, { writeToken: "..." });
await app.listen(3000);
```

`useApitally()` must run after `NestFactory.create()` and before `app.init()` or `app.listen()`. This lets the Express route-registration capture and Fastify `onRoute` hook see the routes that Nest registers during initialization.

## Settled design

### Public API

`src/nestjs/index.ts` exports:

- `useApitally(app: INestApplication, options?: ApitallyOptions): void`
- `ApitallyOptions`

Request helpers remain at the package root. Nest guards, interceptors, and controllers call the v1 context-based `setConsumer(consumer)` from `apitally`; the v0 `setConsumer(request, consumer)` compatibility API will not return.

The first implementation supports HTTP applications using Nest's Express and Fastify adapters. Other Nest application types receive a clear `TypeError` naming the detected adapter and the supported choices.

### Underlying integration reuse

Extract the setup body of each framework integration into an internal installer:

- `src/express/install.ts`: `installExpressIntegration(app, options, frameworkInfo)`
- `src/fastify/install.ts`: `installFastifyIntegration(app, options, frameworkInfo)`

Each installer owns the same behavior its current `useApitally()` owns now: configuration, startup route collection, and middleware or hook installation. `src/express/index.ts` and `src/fastify/index.ts` become small public wrappers that pass their native framework name and version.

The NestJS integration calls the same installers with:

- `framework: "nestjs"`
- the version resolved from `@nestjs/core`

The installers continue to supply their native route resolver. This preserves one implementation of route capture and request observation while making the startup event identify the application framework as NestJS.

Use the public `httpAdapter.getType()` API to select `express` or `fastify`, then pass `httpAdapter.getInstance()` to the matching installer. Nest 10 and 11 expose `getType()` on both platform adapters, so constructor-name detection from v0 is unnecessary.

### Lifecycle

Keep activation under the underlying integrations instead of wrapping `app.init()`:

- Express activates at the start of the first request, after Nest has initialized and registered its routes.
- Fastify activates in the existing `onReady` hook, after queued plugins and their routes have materialized.

These boundaries already ensure that failed Nest initialization cannot activate Apitally and that the startup event sees the complete native route list. They also avoid mutating the proxy returned by `NestFactory.create()`, whose property assignment trap does not support replacing `app.init()` or storing markers.

The existing Express server `close` listener and Fastify `onClose` hook continue to own non-destructive flushing, so the NestJS integration needs no separate shutdown implementation.

Repeated `useApitally()` calls still pass through the underlying integration installer so v1 configuration re-call semantics remain intact. After `app.useGlobalInterceptors()` succeeds, store one `Symbol.for` interceptor marker on the native HTTP instance returned by `getInstance()`. The native instance accepts ordinary property assignment, unlike the Nest application proxy.

### Exception capture

Register one plain global interceptor with `app.useGlobalInterceptors()`. It requires no decorators or dependency injection.

The interceptor will:

1. Pass non-HTTP execution contexts through unchanged.
2. Attach an RxJS `catchError` operator to the handler observable.
3. Resolve an exception status by duck-typing a callable `getStatus()` first, then numeric `status` or `statusCode` properties. A throwing or unrecognized status accessor yields an unknown status.
4. Capture unknown-status and 5xx exceptions with the existing `captureException()` helper.
5. Leave known status codes below 500 as ordinary HTTP responses.
6. Rethrow the original value with `throwError(() => exception)` so Nest's exception filters retain full response ownership.

Do not use `instanceof HttpException`; the user's exception may come from another installed copy of Nest.

Resolve RxJS synchronously from the installed `@nestjs/common` package using `createRequire`. This avoids a runtime static import of an optional framework dependency and resolves the same RxJS installation Nest uses. Use type-only Nest and RxJS imports for declarations.

The interceptor covers failures from controllers, pipes, and interceptors inside it. Guards run before the interceptor chain, response writing runs afterward, and an outer interceptor can fail without entering it. Keep this public, minimal hook and document it as handler-chain exception capture rather than comprehensive Nest exception capture. The native transport remains authoritative for final status and request telemetry.

Do not add exception deduplication state. Nest's HTTP exception layer converts captured controller exceptions into responses before they reach the native Express error middleware or Fastify `onError` hook. The real integration tests will assert exactly one exception event for the controller failure on both platforms.

### Nest logger capture

Add `installNestLoggerCapture()` to `src/logCapture.ts` and invoke it beside the console, Winston, and Pino installers during activation when `captureLogs` is enabled.

Nest officially supports replacing or extending its logger, but it exposes no listener or transport hook for transparent capture. The integration will therefore use a small compatibility patch for the default `ConsoleLogger`; it will not replace the application's logger or add an OpenTelemetry Nest instrumentation dependency.

Resolve `@nestjs/common` synchronously with `createRequire`, then wrap the shared `ConsoleLogger.prototype.printMessages` method once with a `Symbol.for` marker. This is preferable to the v0 `Logger.log()` wrappers because Nest has already applied its level filter and extracted the logger context before calling `printMessages`.

The wrapper will call Nest's original method first, then emit one record per element of its `messages` argument. It will:

- emit through one reused `nestjs` logger from the private OTel logger provider;
- map `log` to INFO, `error` to ERROR, `warn` to WARN, `debug` to DEBUG, `verbose` to TRACE, and `fatal` to FATAL;
- store a non-empty logger context in the `nestjs.context` attribute instead of creating dynamic instrumentation scopes;
- format each semantic message separately with `util.format(message)`, without trying to reproduce Nest's colored or JSON console rendering;
- capture the message only, without private error-stack parsing;
- catch capture failures so they never affect application logging.

Nest 11's `forceConsole` option sends the rendered output through `console.log()` or `console.error()`, which the existing console integration also wraps. Increment one module-local reentrancy counter while calling the original Nest method and decrement it in `finally`. Generic console capture skips calls while this counter is nonzero; the Nest wrapper then emits the single record with its context. The same counter is inert for normal Nest output and Nest 10.

Extend `uninstallLogCapture()` to restore the method and marker for deterministic test isolation. Absence of `@nestjs/common` is a silent no-op; an installed but unrecognized `ConsoleLogger` shape produces a debug diagnostic and remains unpatched.

This covers the default logger and `ConsoleLogger` subclasses that retain the inherited method. Arbitrary custom `LoggerService` implementations are outside this patch; custom loggers backed by Winston or Pino are covered by the existing integrations. Automatic capture begins at the native activation boundary. A record emitted earlier is not intercepted, while a buffered record replayed through the logger afterward can be captured.

## File changes

### Production and package surface

1. **Add `src/express/install.ts` and `src/fastify/install.ts`**
   - Move only the current setup bodies into internal installers.
   - Accept startup framework identity as an argument.
   - Keep all request observation, route capture, and lifecycle hooks unchanged.

2. **Update `src/express/index.ts` and `src/fastify/index.ts`**
   - Keep their current public signatures.
   - Resolve their native package versions and delegate to the new installers.

3. **Add `src/nestjs/index.ts`**
   - Detect the Nest HTTP adapter with `getType()`.
   - Delegate to the matching internal installer with NestJS startup identity.
   - Register the global exception interceptor once, marking the native HTTP instance rather than the Nest application proxy.
   - Leave activation and shutdown under the underlying integration installer.
   - Keep the module decorator-free and side-effect-free until `useApitally()` is called.

4. **Update `src/logCapture.ts` and `src/activation.ts`**
   - Add, install, and uninstall Nest `ConsoleLogger` capture.

5. **Update `package.json` and `package-lock.json`**
   - Add the `./nestjs` ESM/CJS/types export.
   - Add optional peer ranges `>=10 <12` and matching `peerDependenciesMeta` entries for `@nestjs/common` and `@nestjs/core`. The integration does not import either platform package; Express and Fastify platform compatibility is documented and tested instead.
   - Add the current Nest 11 common, core, Express platform, and Fastify platform packages, plus `reflect-metadata` and RxJS, as development dependencies for tests and type checking. `@nestjs/testing` is unnecessary.
   - Add NestJS to the description and keywords.
   - Leave `sideEffects` unchanged because the Nest entry has no import-time effect.

6. **Update `src/index.ts` error guidance**
   - Direct undetected Nest applications to `apitally/nestjs` without adding Nest runtime code to the package-root auto-detector.

### Tests

7. **Add `tests/nestjs/app.ts`**
   - Define one small controller and module.
   - Apply Nest's `Controller`, `Get`, and `Module` decorator functions manually after class definitions. This avoids enabling TypeScript decorator transforms globally.
   - Include a successful parameterized route, a 400 route, and an unhandled 500 route.
   - Call the root `setConsumer()` from the successful controller method to prove the underlying integration restores request context through Nest dispatch.

8. **Add `tests/nestjs/nestjs.test.ts`**
   - Run one shared integration scenario against `ExpressAdapter` and `FastifyAdapter` with a genuine platform table.
   - Call `app.listen()` without a prior `app.init()` so normal Nest initialization reaches each native activation boundary.
   - Assert the startup event identifies `nestjs`, includes the Nest version, and contains the exact controller route list.
   - Send successful, 400, and 500 requests through the listening app and read every response body before telemetry assertions.
   - Assert activation after the first completed request, one SERVER span per request with Nest route templates, the consumer on the successful request, no exception event for the 400 response, and exactly one exception event for the controller 500 response.
   - Close the Nest app in `finally`; the Express and Fastify integration suites continue to own detailed activation, route-completeness, and close-flush behavior.

9. **Extend `tests/logCapture.test.ts`**
   - In one test, install Nest capture twice around a real `ConsoleLogger`, configure a level threshold, and emit suppressed and accepted messages. Assert one record per accepted message with exact body, severity, the fixed `nestjs` scope, and `nestjs.context`.
   - In one focused test, enable `forceConsole` and assert that the coordinated Nest and console wrappers emit one Nest record rather than duplicates.

The Nest suite intentionally does not repeat body capture, streaming, compression, tracing adoption, route-prefix permutations, sampling, Sentry, or shutdown matrices. Those contracts remain owned by the existing Express, Fastify, and shared tests; the Nest suite proves only delegation and Nest-owned behavior.

### Compatibility matrix and documentation

10. **Update `.github/workflows/tests.yaml`**
    - Add Nest 10 and 11 scenarios to the existing Node 20, 22, and 24 matrix.
    - Install matching versions of all four Nest packages per scenario.
    - Run the normal complete test command for every scenario.

11. **Update `README.md`**
    - Add NestJS to the title, description, application-log wording, and supported-framework table.
    - Add the synchronous `apitally/nestjs` setup example in the required pre-init position.
    - State support for Nest 10 and 11 with Express or Fastify.
    - Note that the default Nest `ConsoleLogger` is captured from Apitally's native activation boundary onward and custom Winston/Pino loggers use their existing integrations.
    - Explain that buffered records replayed after activation can be captured, while arbitrary custom `LoggerService` implementations remain outside automatic capture.
    - Include Nest `app.close()` in graceful-shutdown wording.

12. **Update `v1/design-js.md`**
    - Record the underlying-integration delegation, Nest HTTP adapter detection, underlying activation boundaries, and handler-chain exception policy.
    - Describe the default `ConsoleLogger` compatibility patch, fixed `nestjs` instrumentation scope, context attribute, `forceConsole` deduplication, and activation and custom-logger boundaries.
    - Keep the existing lifecycle and logging decisions, replacing the remaining phase-only wording with the implemented Nest behavior.

## Validation

Run the repository's complete checks, in this order:

```bash
npm run check
npm test
npm run build
npm run check:package
git diff --check
```

Then inspect the packed export to confirm both module systems expose `apitally/nestjs` and that importing the package root still works without Nest installed.

## Acceptance criteria

- Nest 10 and 11 applications using either Express or Fastify are instrumented through one synchronous `useApitally()` call before Nest initialization.
- Nest delegates all transport observation and route collection to the existing underlying integrations.
- Native activation occurs only after successful Nest initialization and emits complete NestJS startup metadata, including Fastify plugin routes materialized at `onReady`.
- Handler-chain exceptions with an unknown or 5xx status produce an exception event; the tested controller failure produces exactly one, and expected 4xx responses produce none.
- The v1 context-based consumer API works inside Nest request handling.
- Default Nest logger records preserve severity, context, and message boundaries while respecting Nest's level filter; `forceConsole` does not duplicate records.
- Repeated setup does not duplicate wrappers, interceptors, spans, logs, or exceptions.
- The NestJS integration does not mutate the Nest application proxy or duplicate underlying activation and shutdown logic.
- No decorator compiler configuration, Nest dynamic module, integration-specific request state, or duplicate underlying-integration test suite is introduced.
