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

API monitoring, analytics and request logging for [AdonisJS](https://github.com/adonisjs/core), [Elysia](https://github.com/elysiajs/elysia), [Express](https://github.com/expressjs/express), [Fastify](https://github.com/fastify/fastify), [H3](https://github.com/h3js/h3), [Hapi](https://github.com/hapijs/hapi), [Hono](https://github.com/honojs/hono), [Koa](https://github.com/koajs/koa) and [NestJS](https://github.com/nestjs/nest), built on OpenTelemetry. One line of setup instruments your app and streams traces, logs and metrics to Apitally. No OpenTelemetry knowledge, infrastructure changes or dashboards are required.

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out the 📚 [documentation](https://docs.apitally.io).

## Key features

- **API analytics**: Traffic, error and performance metrics for your API, each endpoint, and individual API consumers.
- **Request logging**: Every request as a searchable log entry, with optional capture of headers and request/response bodies.
- **Application logs**: Logs written via `console`, winston, pino, Hapi's `request.log()` or Nest's default `ConsoleLogger` are captured automatically and correlated with the request they belong to.
- **Distributed tracing**: Requests are exported as OpenTelemetry spans, including spans from any other instrumentations you run.
- **Error tracking**: Exceptions with stack traces for server errors, automatically linked to Sentry events if you use Sentry.
- **Server metrics**: CPU, memory and uptime of your app's processes.
- **Data privacy built in**: Sensitive headers and query parameters are masked by default, with configurable masking for anything else, plus sampling to control data volume.

## Supported frameworks

| Framework | Supported versions | Setup guide |
| --- | --- | --- |
| [**AdonisJS**](https://github.com/adonisjs/core) | `>= 6.3`, `< 8` | [Link](https://docs.apitally.io/setup-guides/adonisjs) |
| [**Elysia**](https://github.com/elysiajs/elysia) | `>= 1.1`, `< 2` | [Link](https://docs.apitally.io/setup-guides/elysia) |
| [**Express**](https://github.com/expressjs/express) | `>= 4.18.2`, `< 6` | [Link](https://docs.apitally.io/setup-guides/express) |
| [**Fastify**](https://github.com/fastify/fastify) | `>= 4.10.2`, `< 6` | [Link](https://docs.apitally.io/setup-guides/fastify) |
| [**H3**](https://github.com/h3js/h3) \* | `>= 2.0.1-rc.26`, `< 3` | [Link](https://docs.apitally.io/setup-guides/h3) |
| [**Hapi**](https://github.com/hapijs/hapi) | `21.x` | [Link](https://docs.apitally.io/setup-guides/hapi) |
| [**Hono**](https://github.com/honojs/hono) \* | `>= 4.8.4`, `< 5` | [Link](https://docs.apitally.io/setup-guides/hono) |
| [**Koa**](https://github.com/koajs/koa) | `2.x`, `3.x` | [Link](https://docs.apitally.io/setup-guides/koa) |
| [**NestJS**](https://github.com/nestjs/nest) | `10.x`, `11.x` | [Link](https://docs.apitally.io/setup-guides/nestjs) |

\* For Hono on Cloudflare Workers use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

Apitally also supports many other web frameworks in [Python](https://github.com/apitally/apitally-py), [Go](https://github.com/apitally/apitally-go), [.NET](https://github.com/apitally/apitally-dotnet) and [Java](https://github.com/apitally/apitally-java) via our other SDKs.

## Getting started

If you don't have an Apitally account yet, first [sign up here](https://app.apitally.io/?signup). Then create an app in the Apitally dashboard. You'll see detailed setup instructions with code snippets you can copy and paste, including your write token.

Install the SDK. AdonisJS applications should use the Ace command in the next section instead.

```bash
npm install apitally
```

Pass the write token via the `writeToken` option, or set the `APITALLY_WRITE_TOKEN` environment variable. See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript) for all available configuration options, including how to mask sensitive data, customize request logging, and more.

### AdonisJS

Run the Ace add command from your application directory:

```bash
node ace add apitally
```

The command installs and configures Apitally. It creates `config/apitally.ts`, adds the required environment declarations, registers the service provider and server middleware, and updates the conventional exception handler to report unhandled 5xx errors.

If Apitally is already installed, or to rerun setup, use:

```bash
node ace configure apitally
```

Request headers, request bodies, and response bodies are opt-in prompts during setup. Response headers are enabled by default. You can change these settings later in `config/apitally.ts`.

The SDK-wide environment default is `dev`. `APITALLY_ENV` is deployment-specific, so set it appropriately for staging and production.

For further instructions, see our [setup guide for AdonisJS](https://docs.apitally.io/setup-guides/adonisjs).

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

For further instructions, see our [setup guide for Elysia](https://docs.apitally.io/setup-guides/elysia).

### Express

Import `apitally/express/register` on the first line of your entry module, then call `useApitally(app)` anywhere after creating the app:

```javascript
import "apitally/express/register"; // must be the first import

import express from "express";
import { useApitally } from "apitally";

const app = express();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // optional, defaults to "dev"
});
```

The register import ensures routes are captured no matter where they are registered — including routers assembled at module scope. It's one rule for every app shape: first line of your entry module.

For further instructions, see our [setup guide for Express](https://docs.apitally.io/setup-guides/express).

### Fastify

Call `useApitally(app)` immediately after creating the app, before registering plugins and routes:

```javascript
import Fastify from "fastify";
import { useApitally } from "apitally";

const app = Fastify();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // optional, defaults to "dev"
});

// register plugins and routes below this point
```

For further instructions, see our [setup guide for Fastify](https://docs.apitally.io/setup-guides/fastify).

### NestJS

Call the synchronous `useApitally(app)` immediately after creating the Nest application, before `app.init()` or `app.listen()`:

```javascript
import { NestFactory } from "@nestjs/core";
import { useApitally } from "apitally/nestjs";
import { AppModule } from "./app.module.js";

const app = await NestFactory.create(AppModule);

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // optional, defaults to "dev"
});

await app.listen(3000);
```

For further instructions, see our [setup guide for NestJS](https://docs.apitally.io/setup-guides/nestjs).

### H3

Add `apitallyPlugin()` when constructing the root H3 app:

```javascript
import { H3 } from "h3";
import { apitallyPlugin } from "apitally/h3";

const app = new H3({
  plugins: [
    apitallyPlugin({
      writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
      env: "dev", // optional, defaults to "dev"
    }),
  ],
});
```

For further instructions, see our [setup guide for H3](https://docs.apitally.io/setup-guides/h3).

### Hapi

Register `apitallyPlugin()` before calling `server.initialize()` or `server.start()`:

```javascript
import Hapi from "@hapi/hapi";
import { apitallyPlugin } from "apitally/hapi";

const server = Hapi.server({ port: 3000 });

await server.register(
  apitallyPlugin({
    writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
    env: "dev", // optional, defaults to "dev"
  }),
);

// register application plugins and routes below this point
await server.start();
```

For further instructions, see our [setup guide for Hapi](https://docs.apitally.io/setup-guides/hapi).

### Hono

Call `useApitally(app)` immediately after creating the app — before registering middleware and routes, and before `app.fetch` is handed to the server:

```javascript
import { Hono } from "hono";
import { useApitally } from "apitally";

const app = new Hono();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // optional, defaults to "dev"
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Hono](https://docs.apitally.io/setup-guides/hono).

### Koa

Call `useApitally(app)` immediately after creating the app, before registering middleware and routes:

```javascript
const Koa = require("koa");
const { useApitally } = require("apitally");

const app = new Koa();

useApitally(app, {
  writeToken: "your-write-token", // or set APITALLY_WRITE_TOKEN
  env: "dev", // optional, defaults to "dev"
});

// register middleware and routes below this point
```

For further instructions, see our [setup guide for Koa](https://docs.apitally.io/setup-guides/koa).

## Trusted proxies

When your application runs behind a reverse proxy, configure the framework's trusted-proxy setting so Apitally can record the client IP for GeoIP. The SDK uses the client address resolved by Express, Fastify, Koa, AdonisJS, or the corresponding NestJS adapter. It does not trust forwarding headers directly.

## Using Sentry

Sentry's Node.js SDK registers an OpenTelemetry tracer provider by default. If you use Sentry for error monitoring without performance tracing, let Apitally configure OpenTelemetry by disabling Sentry's setup:

```javascript
Sentry.init({
  dsn: "your-sentry-dsn",
  skipOpenTelemetrySetup: true,
});
```

This keeps Sentry error reporting and Apitally's request logs and traces working together. If you use Sentry performance tracing, configure a shared OpenTelemetry provider and include `ApitallySpanProcessor` as described below.

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

When using Elysia's `@elysia/opentelemetry` plugin, register Apitally first so it adopts the OpenTelemetry SERVER span:

```javascript
import { opentelemetry } from "@elysia/opentelemetry";
import { Elysia } from "elysia";
import { apitallyPlugin } from "apitally/elysia";

const app = new Elysia()
  .use(apitallyPlugin(options))
  .use(opentelemetry());
```

## Graceful shutdown

Telemetry is exported in the background roughly every 15 seconds. After successful activation, Apitally installs `SIGTERM` and `SIGINT` listeners by default on supported POSIX main-thread processes. There is no opt-out, and the fixed five-second timeout is not configurable.

On either signal, Apitally makes a non-destructive best-effort final drain of completed telemetry for up to five seconds. If another listener exists for that signal, that listener retains application lifecycle ownership. It must eventually terminate the process or allow it to drain naturally. If Apitally is the sole listener, it removes its listeners before draining and then restores the signal's original termination behavior. A repeated signal is therefore not delayed by another Apitally drain.

Use the  `shutdown()` function for the coordinated full teardown path. Stop traffic and wait for in-flight work before awaiting it:

```javascript
import { shutdown } from "apitally";

process.on("SIGTERM", () => {
  server.close(async () => {
    await shutdown();
  });
});
```

## Runtime support

- **Node.js** `>= 20.6`
- **Bun** is supported for Elysia, H3 and Hono apps

For edge and serverless runtimes like Cloudflare Workers, use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

## Getting help

If you need help please [create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a) on GitHub or email us at [support@apitally.io](mailto:support@apitally.io). We'll get back to you as soon as possible.

## License

This library is licensed under the terms of the [MIT license](LICENSE).
