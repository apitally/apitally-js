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
> **Upgrading from 0.x?** Version 1.0 is a full rewrite with a new setup API. See the [migration guide](MIGRATION.md) for a full 0.x to 1.x mapping.

## Key features

- **API analytics**: Traffic, error and performance metrics for your API, each endpoint, and per API consumer. Drill down from metrics to individual API requests.
- **Request logs and traces**: Every request as a searchable log entry, with optional capture of headers and request/response bodies. Requests are exported as OpenTelemetry spans, including spans from any other instrumentations you have.
- **Application logs**: Logs written via `console` and other supported loggers are captured automatically and correlated with the requests they belong to.
- **Error tracking**: Validation errors and exceptions with stack traces for server errors, automatically linked to Sentry events if you use Sentry.
- **Server metrics**: CPU and memory usage of your app's processes.
- **API monitoring & alerts**: Get notified if something isn't right using custom alerts, synthetic uptime checks and heartbeat monitoring. Alert notifications can be delivered via email, Slack and Microsoft Teams.

## Supported frameworks

The SDK supports **Node.js** `>= 20.6` and **Bun** `>= 1.1.13`.

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

Apitally also supports many other web frameworks in [Python](https://github.com/apitally/apitally-py), [Go](https://github.com/apitally/apitally-go), [.NET](https://github.com/apitally/apitally-dotnet) and [Java](https://github.com/apitally/apitally-java) via our other SDKs.

## Getting started

If you don't have an Apitally account yet, first [sign up here](https://app.apitally.io/?signup). Then create an app in the Apitally dashboard. You'll see detailed setup instructions with code snippets you can copy and paste. These also include your write token.

To install the SDK as a dependency in your project run:

```bash
npm install apitally
```

See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript/v1/configuration) for all available configuration options, including how to mask sensitive data, capture request and response payloads, and more.

### AdonisJS

Run the Ace add command from your application directory:

```bash
node ace add apitally
```

The command installs and configures Apitally. It creates `config/apitally.ts`, adds the required environment declarations, registers the service provider and server middleware, and updates the conventional exception handler to capture validation and server errors.

If needed, you can change settings in `config/apitally.ts`.

For further instructions, see our [setup guide for AdonisJS](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/adonisjs).

### Elysia

Register `apitallyPlugin()` immediately after creating the app, before routes or plugins that add routes:

```javascript
import { Elysia } from "elysia";
import { apitallyPlugin } from "apitally/elysia";

const app = new Elysia()
  .use(
    apitallyPlugin({
      writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
      env: "dev", // optional, defaults to "dev"
    }),
  )
  // register plugins and routes below this point
  .get("/items/:id", ({ params }) => ({ id: params.id }));
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
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // or "prod" etc.
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
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // or "prod" etc.
});

// register plugins and routes below this point
```

For further instructions, see our [setup guide for Fastify](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/fastify).

### NestJS

Call `useApitally(app)` immediately after creating the Nest application, before `app.init()` or `app.listen()`:

```javascript
import { NestFactory } from "@nestjs/core";
import { useApitally } from "apitally/nestjs";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // or "prod" etc.
});

await app.listen(3000);
```

For further instructions, see our [setup guide for NestJS](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/nestjs).

### H3

Add `apitallyPlugin()` when constructing the root H3 app:

```javascript
import { H3 } from "h3";
import { apitallyPlugin } from "apitally/h3";

const app = new H3({
  plugins: [
    apitallyPlugin({
      writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
      env: "dev", // or "prod" etc.
    }),
  ],
});
```

For further instructions, see our [setup guide for H3](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/h3).

### Hapi

Register `apitallyPlugin()` before calling `server.initialize()` or `server.start()`:

```javascript
import Hapi from "@hapi/hapi";
import { apitallyPlugin } from "apitally/hapi";

const server = Hapi.server({ port: 3000 });

await server.register(
  apitallyPlugin({
    writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
    env: "dev", // or "prod" etc.
  }),
);

// register application plugins and routes below this point
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
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // or "prod" etc.
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Hono](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/hono).

### Koa

Call `useApitally(app)` immediately after creating the app, before registering middleware and routes:

```javascript
const Koa = require("koa");
const { useApitally } = require("apitally");

const app = new Koa();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // or "prod" etc.
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Koa](https://docs.apitally.io/sdk-reference/javascript/v1/setup-guides/koa).

## Configuration

The write token and environment can also be provided via the `APITALLY_WRITE_TOKEN` and `APITALLY_ENV` environment variables instead of the `writeToken` and `env` options. The environment defaults to `dev`.

By default, Apitally captures response headers but not request headers or request and response bodies. You can opt in with options:

```javascript
useApitally(app, {
  writeToken: "your-write-token",
  env: "dev",
  captureRequestHeaders: true,
  captureRequestBody: true,
  captureResponseBody: true,
});
```

Sensitive values in query parameters, headers, and body fields are masked automatically based on built-in patterns, and you can add your own via the `maskQueryParams`, `maskHeaders`, and `maskBodyFields` options.

On high-traffic applications you can capture logs and traces for only a fraction of requests by setting `sampleRate` (e.g. `0.1` for 10%), or decide per request with the `sampleOnRequest` and `sampleOnResponse` callbacks. Metrics always count every request, regardless of sampling.

Application logs written via `console` and other supported loggers are captured and correlated with requests by default. Use `maskLogRecord` to transform or drop Apitally's captured copy, or opt out with `captureLogs: false`.

See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript/v1/configuration) for all configuration options.

## Identifying consumers and more

The top-level `apitally` package provides functions you can call from anywhere in your request handling code:

```javascript
import { setConsumer, setRequestAttribute, captureException } from "apitally";

// Associate the current request with an API consumer
setConsumer({ identifier: user.identifier, name: user.name, group: user.group });

// Attach a custom attribute to the current request
setRequestAttribute("tenant", tenantId);

// Capture a handled exception for the current request
captureException(error);
```

`setConsumer()` also accepts an identifier string, for example `setConsumer(user.identifier)`.

For further details, check out our [documentation](https://docs.apitally.io).

## Existing OpenTelemetry setup

If your app doesn't already use OpenTelemetry, you don't need to know it's there. The Apitally SDK configures OpenTelemetry automatically.

If your app already registers its own tracer provider (e.g. via `NodeSDK`), Apitally does not replace it. Instead, you need to add the `ApitallySpanProcessor` to your provider's span processors:

```javascript
import { NodeSDK } from "@opentelemetry/sdk-node";
import { ApitallySpanProcessor } from "apitally";

const sdk = new NodeSDK({
  spanProcessors: [new ApitallySpanProcessor()],
  // ...your existing configuration
});
```

Your tracer provider's sampling settings also affect Apitally. Requests excluded by the sampler will not have request logs or traces in Apitally. Metrics still include all requests, regardless of sampling.

### Sentry

Sentry's Node.js SDK configures OpenTelemetry automatically. To use Apitally alongside Sentry, add `ApitallySpanProcessor` to Sentry's configuration and call `Sentry.init()` before `useApitally()`:

```javascript
import * as Sentry from "@sentry/node";
import { ApitallySpanProcessor } from "apitally";

Sentry.init({
  dsn: "your-sentry-dsn",
  // Enable tracing
  tracesSampleRate: 1.0,
  // Add Apitally's span processor
  openTelemetrySpanProcessors: [new ApitallySpanProcessor()],
  // Optional: send only errors to Sentry
  beforeSendTransaction: () => null,
});
```

Apitally uses the spans recorded by Sentry, so tracing must be enabled in Sentry. Requests excluded by Sentry's sampler will also be missing from Apitally's request logs and traces.

Returning `null` from `beforeSendTransaction` prevents traces from being sent to Sentry without affecting Apitally's request logs and traces.

### Elysia's OpenTelemetry plugin

When using Elysia's `@elysia/opentelemetry` plugin, register Apitally first so it adopts the OpenTelemetry SERVER span:

```javascript
import { opentelemetry } from "@elysia/opentelemetry";
import { Elysia } from "elysia";
import { apitallyPlugin } from "apitally/elysia";

const app = new Elysia()
  .use(apitallyPlugin(options))
  .use(opentelemetry());
```

## Trusted proxies

If your application runs behind a reverse proxy or load balancer, configure trusted proxies in your framework so Apitally can record the real client IP for GeoIP. Apitally uses the client IP reported by your framework. It does not read forwarding headers itself to determine the client IP.

## Graceful shutdown

Apitally sends telemetry in batches and automatically attempts a final export during normal process shutdown.

If your code calls `process.exit()`, await `shutdown()` first to give Apitally time to send buffered telemetry. Close your server and let any remaining requests finish before doing this:

```javascript
import { shutdown } from "apitally";

// After the server has closed and requests have finished:
await shutdown();
process.exit(0);
```

## Getting help

If you need help please [create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a) on GitHub or email us at [support@apitally.io](mailto:support@apitally.io). We'll get back to you as soon as possible.

## License

This library is licensed under the terms of the [MIT license](LICENSE).
