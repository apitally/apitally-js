# Migrating from 0.x to 1.x

This guide is also available in the [Apitally documentation](https://docs.apitally.io/sdk-reference/javascript/v1/migration).

The JavaScript SDK now uses OpenTelemetry to collect and send metrics, logs, and traces.

> [!WARNING]
> Request logging, tracing, and application log capture are now enabled by default. If you previously used the SDK for metrics only, set `sampleRate: 0` to keep that behavior.

## Installation and setup

The updated [setup guides](https://docs.apitally.io/sdk-reference/javascript/v1/overview#supported-frameworks) provide the installation steps and initialization code for each framework. Follow these to replace your existing SDK integration.

### Write tokens replace client IDs

The SDK now authenticates with a **write token** instead of a client ID. Your existing app's token (`apt_...`) is available under _Setup instructions_ in the [Apitally dashboard](https://app.apitally.io/apps).

Use this token as the `writeToken` option in place of `clientId`, or set the `APITALLY_WRITE_TOKEN` environment variable.

## Configuration changes

The `requestLogging` object and its deprecated alias `requestLoggingConfig` have been removed. Their settings are now top-level configuration options, with the option changes listed below.

### Changed options

The following options have been changed:

| Option | Change |
| --- | --- |
| `clientId` | Replaced by `writeToken`, which requires a new credential. |
| `captureLogs` | Default changed from `false` to `true`. |
| `logRequestHeaders` | Renamed to `captureRequestHeaders`. |
| `logRequestBody` | Renamed to `captureRequestBody`. |
| `logResponseHeaders` | Renamed to `captureResponseHeaders`. |
| `logResponseBody` | Renamed to `captureResponseBody`. |
| `maskRequestBodyCallback` | Renamed to `maskRequestBody` with new arguments. |
| `maskResponseBodyCallback` | Renamed to `maskResponseBody` with new arguments. |
| `excludeCallback` | Replaced by `sampleOnRequest` or `sampleOnResponse` with new arguments and return values. |
| `excludePaths` | Matches actual request paths instead of matched route patterns. |

### Removed options

These options are no longer accepted when initializing the SDK:

| Removed option | Migration |
| --- | --- |
| `requestLogging` and `requestLoggingConfig` | Pass their settings directly as top-level configuration options, applying the changes above. Remove the `enabled` flag. |
| `requestLogging.enabled` and `captureTraces` | Previously defaulted to `false`. Request logging and tracing are now enabled by default. Use `sampleRate: 0` to disable request logs and traces. |
| `logQueryParams` | Query parameters are now always captured. To mask all values, use `maskQueryParams: [/.*/]`. |
| `logException` | Unhandled exceptions are now always captured in request traces. |
| `logger` | SDK diagnostics are now written directly to stderr. Use `APITALLY_DEBUG` to enable debug output. |
| `basePath` (Express) | Mounted router prefixes are captured automatically. |

The [configuration reference](https://docs.apitally.io/sdk-reference/javascript/v1/configuration) lists all available options.

## Consumer identification

The SDK now provides `setConsumer()` from `apitally` for all frameworks. The request or context argument has been removed.

Call it where the consumer is known, such as in your authentication code:

```javascript
import { setConsumer } from "apitally";

setConsumer({
  identifier: user.identifier,
  name: user.name, // optional
  group: user.group, // optional
});
```

This replaces consumer values assigned to request state, including Elysia's `apitally.consumer`. Existing `setConsumer(request, ...)` or `setConsumer(context, ...)` calls should use the new function without the first argument.

## Body masking callbacks

`maskRequestBodyCallback` and `maskResponseBodyCallback` are now named `maskRequestBody` and `maskResponseBody`. Both receive `(body, span)`, rather than request/response objects. The body is passed as a `Buffer`. Request metadata is available through [`span.attributes`](https://docs.apitally.io/sdk-reference/javascript/v1/attributes).

For example, a callback that masks bodies for admin routes becomes:

```typescript
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

// Before
function maskRequestBodyCallback(
  request: { path?: string; body?: Buffer },
): Buffer | null | undefined {
  if (request.path?.startsWith("/admin/")) {
    return null;
  }
  return request.body;
}

// After
function maskRequestBody(body: Buffer, span: ReadableSpan): Buffer | null {
  const route = span.attributes["http.route"];
  if (typeof route === "string" && route.startsWith("/admin/")) {
    return null;
  }
  return body;
}
```

## Request exclusion

Use sampling callbacks to exclude requests: `sampleOnRequest(span)` for early decisions based on the request, or `sampleOnResponse(span)` for decisions based on the response status or consumer.

The callbacks should return `true` to capture the request, and `false` to exclude it. Callbacks can also return a probability as a `number` between 0 and 1. Returning `undefined` preserves a previously made sampling decision.

For example, to capture only error responses:

```typescript
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";

// Before
function excludeRequest(request: unknown, response: { statusCode: number }): boolean {
  return response.statusCode < 400;
}

// After
function sampleOnResponse(span: ReadableSpan): boolean {
  const statusCode = span.attributes["http.response.status_code"];
  return typeof statusCode === "number" && statusCode >= 400;
}
```

Replace the `excludeCallback` option with the appropriate sampling callback. Note that captured headers and bodies are not available in sampling callbacks.

Sampling affects request logs and traces, but not metrics.

See [sampling](https://docs.apitally.io/sdk-reference/javascript/v1/sampling) for details.

### Path exclusions

`excludePaths` now matches request paths rather than matched route patterns. If a pattern contains route parameters, update it to match concrete values. For example, replace `/^\/users\/:id$/` with `/^\/users\/[^/]+$/` to match `/users/123`.

## Existing OpenTelemetry setups

If your application configures its own tracer provider, you must register `ApitallySpanProcessor` alongside your existing span processors. Its import has moved from `apitally/otel` to `apitally`.

For example, with `NodeSDK`:

```javascript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ApitallySpanProcessor } from "apitally";

const sdk = new NodeSDK({
  spanProcessors: [
    // Your existing span processors ...
    new ApitallySpanProcessor(),
  ],
  // Your existing configuration ...
});

sdk.start();
```

Review these settings when upgrading:

- **Sampling:** Previously, your provider's sampler affected traces but not Apitally's request logs. It now affects both, so review its sampling rate when upgrading. Metrics remain unsampled.
