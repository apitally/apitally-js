<p align="center">
  <a href="https://apitally.io" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://assets.apitally.io/logos/logo-horizontal-new-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="https://assets.apitally.io/logos/logo-horizontal-new-light.png">
      <img alt="Apitally logo" src="https://assets.apitally.io/logos/logo-horizontal-new-light.png" width="220">
    </picture>
  </a>
</p>
<p align="center"><b>API monitoring & analytics made simple</b></p>
<p align="center" style="color: #ccc;">Metrics, logs, traces, and alerts for your APIs — with just a few lines of code.</p>
<br>
<p>
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://assets.apitally.io/screenshots/overview-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://assets.apitally.io/screenshots/overview-light.png">
  <img alt="Apitally dashboard" src="https://assets.apitally.io/screenshots/overview-light.png">
</picture>
</p>
<br>

# Apitally SDK for Express and Hono

[![Tests](https://github.com/apitally/apitally-js/actions/workflows/tests.yaml/badge.svg?event=push)](https://github.com/apitally/apitally-js/actions)
[![Codecov](https://codecov.io/gh/apitally/apitally-js/graph/badge.svg?token=j5jqlrL7Pd)](https://codecov.io/gh/apitally/apitally-js)
[![npm](https://img.shields.io/npm/v/apitally?logo=npm&color=%23cb0000)](https://www.npmjs.com/package/apitally)

API monitoring, analytics and request logging for [Express](https://github.com/expressjs/express) and [Hono](https://github.com/honojs/hono), built on OpenTelemetry. One line of setup instruments your app and streams traces, logs and metrics to Apitally — no OpenTelemetry knowledge required, no infrastructure changes, no dashboards to build.

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out the 📚 [documentation](https://docs.apitally.io).

## Key features

- **API analytics**: Traffic, error and performance metrics for your API, each endpoint, and individual API consumers.
- **Request logging**: Every request as a searchable log entry, with optional capture of headers and request/response bodies.
- **Application logs**: Logs written via `console`, winston or pino are captured automatically and correlated with the request they belong to.
- **Distributed tracing**: Requests are exported as OpenTelemetry spans, including spans from any other instrumentations you run.
- **Error tracking**: Exceptions with stack traces for server errors, automatically linked to Sentry events if you use Sentry.
- **Server metrics**: CPU, memory and uptime of your app's processes.
- **Data privacy built in**: Sensitive headers and query parameters are masked by default, with configurable masking for anything else, plus sampling to control data volume.

## Supported frameworks

| Framework                                           | Supported versions | Setup guide                                           |
| --------------------------------------------------- | ------------------ | ----------------------------------------------------- |
| [**Express**](https://github.com/expressjs/express) | `4.x`, `5.x`       | [Link](https://docs.apitally.io/setup-guides/express) |
| [**Hono**](https://github.com/honojs/hono) \*       | `>= 4.8.4`         | [Link](https://docs.apitally.io/setup-guides/hono)    |

\* For Hono on Cloudflare Workers use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

Apitally also supports many other web frameworks in [Python](https://github.com/apitally/apitally-py), [Go](https://github.com/apitally/apitally-go), [.NET](https://github.com/apitally/apitally-dotnet) and [Java](https://github.com/apitally/apitally-java) via our other SDKs.

## Getting started

If you don't have an Apitally account yet, first [sign up here](https://app.apitally.io/?signup). Then create an app in the Apitally dashboard. You'll see detailed setup instructions with code snippets you can copy and paste, including your write token.

Install the SDK:

```bash
npm install apitally
```

Pass the write token via the `writeToken` option, or set the `APITALLY_WRITE_TOKEN` environment variable. See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript) for all available configuration options, including how to mask sensitive data, customize request logging, and more.

### Express

Import `apitally/express/register` on the first line of your entry module, then call `useApitally(app)` anywhere after creating the app:

```javascript
import "apitally/express/register"; // must be the first import

import express from "express";
import { useApitally } from "apitally";

const app = express();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "prod", // optional, defaults to "prod"
});
```

The register import ensures routes are captured no matter where they are registered — including routers assembled at module scope. It's one rule for every app shape: first line of your entry module.

For further instructions, see our [setup guide for Express](https://docs.apitally.io/setup-guides/express).

### Hono

Call `useApitally(app)` immediately after creating the app — before registering middleware and routes, and before `app.fetch` is handed to the server:

```javascript
import { Hono } from "hono";
import { useApitally } from "apitally";

const app = new Hono();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "prod", // optional, defaults to "prod"
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Hono](https://docs.apitally.io/setup-guides/hono).

The root `useApitally` function auto-detects your framework. If you prefer an explicit import, use the framework entries `apitally/express` or `apitally/hono` instead — they export the same function, typed for that framework.

## Works with your existing OpenTelemetry setup

If your app doesn't use OpenTelemetry, you don't need to know it's there — the SDK sets up a private, fully configured pipeline.

If your app already registers its own tracer provider (e.g. via `NodeSDK`), Apitally never replaces it. Instead, add the `ApitallySpanProcessor` to your provider's span processors:

```javascript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ApitallySpanProcessor } from "apitally";

const sdk = new NodeSDK({
  spanProcessors: [new ApitallySpanProcessor()],
  // ...your existing configuration
});
```

Your existing exporters keep seeing everything they already see: Apitally adopts the spans your instrumentation produces instead of creating duplicates, and its meter and logger providers stay private, so nothing leaks into your own pipelines.

## Graceful shutdown

Telemetry is exported in the background roughly every 15 seconds. After successful activation, Apitally installs `SIGTERM` and `SIGINT` listeners by default on supported POSIX main-thread processes. There is no opt-out, and the fixed five-second timeout is not configurable.

On either signal, Apitally makes a non-destructive best-effort final drain of completed telemetry for up to five seconds. It does not close the app server or wait for in-flight app requests. If another listener exists for that signal, that listener retains application lifecycle ownership. It must eventually terminate the process or allow it to drain naturally. If Apitally is the sole listener, it removes its listeners before draining and then restores the signal's original termination behavior. A repeated signal is therefore not delayed by another Apitally drain.

The public `shutdown()` function remains the coordinated full teardown path. Stop traffic and wait for in-flight work before awaiting it:

```javascript
import { shutdown } from "apitally";

process.on("SIGTERM", () => {
  server.close(async () => {
    await shutdown();
  });
});
```

No final drain is guaranteed for `SIGKILL`, a synchronous `process.exit()`, a native crash or out-of-memory failure, worker-thread signal delivery, or collector failure that lasts beyond the deadline.

## Runtime support

- **Node.js** `>= 20.6`
- **Bun** is supported for Hono apps

For edge and serverless runtimes like Cloudflare Workers, use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

## Getting help

If you need help please [create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a) on GitHub or email us at [support@apitally.io](mailto:support@apitally.io). We'll get back to you as soon as possible.

## License

This library is licensed under the terms of the [MIT license](LICENSE).
