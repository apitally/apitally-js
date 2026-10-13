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

# Apitally SDK for JavaScript

[![Tests](https://github.com/apitally/apitally-js/actions/workflows/tests.yaml/badge.svg?event=push)](https://github.com/apitally/apitally-js/actions)
[![Codecov](https://codecov.io/gh/apitally/apitally-js/graph/badge.svg?token=j5jqlrL7Pd)](https://codecov.io/gh/apitally/apitally-js)
[![npm](https://img.shields.io/npm/v/apitally?logo=npm&color=%23cb0000)](https://www.npmjs.com/package/apitally)

Apitally is a simple API monitoring and analytics tool that makes it easy to understand API usage, monitor performance, and troubleshoot issues.
Get started in minutes by just adding a few lines of code. No infrastructure changes required, no dashboards to build.

The SDK is an [OpenTelemetry](https://opentelemetry.io) distribution and works alongside an existing OpenTelemetry setup.

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out the 📚 [documentation](https://docs.apitally.io).

> [!IMPORTANT]
> **Upgrading from 0.x?** Version 1.0 is a full rewrite with a new setup API. See the [migration guide](MIGRATION.md) for how to upgrade.

## Key features

- **API analytics**: Traffic, error and performance metrics for your API, each endpoint, and per API consumer. Drill down from metrics to individual API requests.
- **Request logs and traces**: Every request as a searchable log entry, with optional capture of headers and request/response bodies. Requests are exported as OpenTelemetry spans, including spans from any other instrumentations you have.
- **Application logs**: Logs written via `console` and other supported loggers are captured automatically and correlated with the requests they belong to.
- **Error tracking**: Validation errors and exceptions with stack traces for server errors, automatically linked to Sentry events if you use Sentry.
- **Server metrics**: CPU and memory usage of your app's processes.
- **API monitoring & alerts**: Get notified if something isn't right using custom alerts, synthetic uptime checks and heartbeat monitoring. Alert notifications can be delivered via email, Slack and Microsoft Teams.

## Supported frameworks

The SDK supports **Node.js** `>= 20.6` and **Bun** `>= 1.2.0`.

| Framework | Supported versions | Setup guide |
| --- | --- | --- |
| [**AdonisJS**](https://github.com/adonisjs/core) | `>= 6.3`, `< 8` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/adonisjs) |
| [**Elysia**](https://github.com/elysiajs/elysia) | `>= 1.1`, `< 2` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/elysia) |
| [**Express**](https://github.com/expressjs/express) | `>= 4.18.2`, `< 6` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/express) |
| [**Fastify**](https://github.com/fastify/fastify) | `>= 4.10.2`, `< 6` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/fastify) |
| [**H3**](https://github.com/h3js/h3) | `>= 2.0.1-rc.26`, `< 3` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/h3) |
| [**Hapi**](https://github.com/hapijs/hapi) | `21.x` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/hapi) |
| [**Hono**](https://github.com/honojs/hono) \* | `>= 4.8.4`, `< 5` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/hono) |
| [**Koa**](https://github.com/koajs/koa) | `2.x`, `3.x` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/koa) |
| [**NestJS**](https://github.com/nestjs/nest) | `10.x`, `11.x`, `12.x` | [Link](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/nestjs) |

\* For Hono on Cloudflare Workers use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

Apitally also supports many other web frameworks in [Python](https://github.com/apitally/apitally-py), [Go](https://github.com/apitally/apitally-go) and [.NET](https://github.com/apitally/apitally-dotnet) via our other SDKs.

## Getting started

If you don't have an Apitally account yet, first [sign up here](https://app.apitally.io/?signup). Then create an app in the Apitally dashboard. You'll see detailed setup instructions with code snippets you can copy and paste. These also include your write token.

Install the SDK in your project:

```bash
npm install apitally
```

### AdonisJS

Run the Ace `add` command from your application directory:

```bash
node ace add apitally
```

The command installs Apitally, asks for your write token and environment, and sets up the provider, middleware, and exception handling. To change settings later, edit `config/apitally.ts`.

For further instructions, see our [setup guide for AdonisJS](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/adonisjs).

### Elysia

Register `apitallyPlugin()` immediately after creating the app, before registering plugins and routes:

```javascript
import { Elysia } from "elysia";
import { apitallyPlugin } from "apitally/elysia";

const app = new Elysia().use(
  apitallyPlugin({
    writeToken: "your-write-token",
    env: "dev",
  }),
);

// register plugins and routes below this point
```

For further instructions, see our [setup guide for Elysia](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/elysia).

### Express

Import `apitally/express/register` on the first line of your entry module, then call `useApitally(app)` anywhere after creating the app:

```javascript
import "apitally/express/register"; // must be the first import

import express from "express";
import { useApitally } from "apitally";

const app = express();

useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
});
```

For further instructions, see our [setup guide for Express](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/express).

### Fastify

Call `useApitally(app)` immediately after creating the app, before registering plugins and routes:

```javascript
import Fastify from "fastify";
import { useApitally } from "apitally";

const app = Fastify();

useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
});

// register plugins and routes below this point
```

For further instructions, see our [setup guide for Fastify](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/fastify).

### H3

Add `apitallyPlugin()` to the `plugins` of your root H3 app:

```javascript
import { H3 } from "h3";
import { apitallyPlugin } from "apitally/h3";

const app = new H3({
  plugins: [
    apitallyPlugin({
      writeToken: "your-write-token",
      env: "dev",
    }),
  ],
});
```

For further instructions, see our [setup guide for H3](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/h3).

### Hapi

Register `apitallyPlugin()` immediately after creating the server, before registering other plugins and routes:

```javascript
import Hapi from "@hapi/hapi";
import { apitallyPlugin } from "apitally/hapi";

const server = Hapi.server({ port: 3000 });

await server.register(
  apitallyPlugin({
    writeToken: "your-write-token",
    env: "dev",
  }),
);

// register other plugins and routes below this point
await server.start();
```

For further instructions, see our [setup guide for Hapi](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/hapi).

### Hono

Call `useApitally(app)` immediately after creating the app, before registering middleware and routes:

```javascript
import { Hono } from "hono";
import { useApitally } from "apitally";

const app = new Hono();

useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Hono](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/hono).

### Koa

Call `useApitally(app)` immediately after creating the app, before registering middleware and routes:

```javascript
import Koa from "koa";
import { useApitally } from "apitally";

const app = new Koa();

useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Koa](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/koa).

### NestJS

Call `useApitally(app)` immediately after creating the app, before calling `app.init()` or `app.listen()`:

```javascript
import { NestFactory } from "@nestjs/core";
import { useApitally } from "apitally/nestjs";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);

useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
});

await app.listen(3000);
```

For further instructions, see our [setup guide for NestJS](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/nestjs).

## Configuration

Pass configuration options to `useApitally()`, or to `apitallyPlugin()` for Elysia, H3, and Hapi. For AdonisJS, set them in `config/apitally.ts`. See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript/v1/configuration) for all available options.

### Environment variables

To keep configuration out of your code, set these environment variables instead of passing the matching options:

- `APITALLY_WRITE_TOKEN`: the write token (`writeToken`)
- `APITALLY_ENV`: the environment name (`env`), defaults to `dev`
- `APITALLY_DISABLED`: set to `true` to disable Apitally (`disabled`)

### Request and response data

Apitally captures response headers by default. To also capture request headers and request and response bodies, pass these options:

```javascript
useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
  captureRequestHeaders: true,
  captureRequestBody: true,
  captureResponseBody: true,
});
```

Apitally automatically masks common sensitive values, such as `password` fields and the `Authorization` header. To mask additional values, pass regular expressions to `maskQueryParams`, `maskHeaders`, and `maskBodyFields`. See our [documentation on masking](https://docs.apitally.io/sdk-reference/javascript/v1/masking) for details.

### Exclusions and sampling

Apitally automatically excludes common health checks and static assets, such as `/healthz` and `/robots.txt`, from logs and traces. To exclude additional paths, pass regular expressions to `excludePaths`.

To capture logs and traces for only a fraction of the remaining requests, set `sampleRate`, for example to `0.1` for 10%. To decide for each request individually, pass a callback to `sampleOnRequest` or `sampleOnResponse`.

Metrics always include all requests. See our [documentation on sampling](https://docs.apitally.io/sdk-reference/javascript/v1/sampling) for details.

### Application logs

Apitally captures logs written with these loggers and correlates them with the requests they belong to:

- `console`
- Pino
- Winston
- NestJS `Logger`
- Hapi `request.log()`

To mask or drop individual log records, pass a callback to `maskLogRecord`. To turn off log capture, set `captureLogs: false`.

See our [documentation on masking](https://docs.apitally.io/sdk-reference/javascript/v1/masking#log-record-masking-callback) for details.

## Adding context to requests

The following functions add context to the current request. Call them while handling a request, for example in a route handler, middleware, or authentication code.

### Consumers

To associate the request with the API consumer making it, call `setConsumer`. Only `identifier` is required. You can also pass it as a string, for example `setConsumer(user.identifier)`.

```javascript
import { setConsumer } from "apitally";

setConsumer({
  identifier: user.identifier,
  name: user.name,
  group: user.group,
  attributes: { plan: user.plan },
});
```

### Custom attributes

To attach custom data to the request's trace, call `setRequestAttribute`. The `sampleOnResponse`, `maskRequestBody`, and `maskResponseBody` callbacks can also read these attributes.

```javascript
import { setRequestAttribute } from "apitally";

setRequestAttribute("tenant.id", tenantId);
```

See our [documentation on attributes](https://docs.apitally.io/sdk-reference/javascript/v1/attributes#set-custom-attributes) for details.

### Handled exceptions

To capture an exception that your code handles itself, call `captureException`. Unhandled exceptions are captured automatically.

```javascript
import { captureException } from "apitally";

try {
  processOrder();
} catch (error) {
  captureException(error);
}
```

## Existing OpenTelemetry setup

If your app already registers its own tracer provider, for example with `NodeSDK`, add `ApitallySpanProcessor` to its span processors. Apitally then uses your tracer provider instead of registering its own, and keeps your existing exporters.

```javascript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ApitallySpanProcessor } from "apitally";

const sdk = new NodeSDK({
  spanProcessors: [new ApitallySpanProcessor()],
  // ...your existing configuration
});
```

If you use version 10.x of the Sentry SDK, which registers its own tracer provider, add `ApitallySpanProcessor` to the `openTelemetrySpanProcessors` option in `Sentry.init()` and enable Sentry tracing.

Your tracer provider's sampler also applies to Apitally. Requests it drops have no request logs or traces in Apitally, but still count in metrics.

## Graceful shutdown

If your code calls `process.exit()`, await `shutdown()` before it so Apitally can send any remaining telemetry:

```javascript
import { shutdown } from "apitally";

process.on("SIGTERM", () => {
  server.close(async () => {
    await shutdown();
    process.exit(0);
  });
});
```

## Trusted proxies

If your app runs behind a reverse proxy or load balancer, configure trusted proxies in your framework, for example with Express's `trust proxy` setting or Fastify's `trustProxy` option. Apitally records the client IP your framework reports and uses it for GeoIP.

## Getting help

If you need help please [create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a) on GitHub or email us at [support@apitally.io](mailto:support@apitally.io). We'll get back to you as soon as possible.

## License

This library is licensed under the terms of the [MIT license](LICENSE).
