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
<img alt="Apitally screenshots" src="https://assets.apitally.io/screenshots/overview.png">
<br>

# Apitally SDK for Node.js

[![Tests](https://github.com/apitally/apitally-js/actions/workflows/tests.yaml/badge.svg?event=push)](https://github.com/apitally/apitally-js/actions)
[![Codecov](https://codecov.io/gh/apitally/apitally-js/graph/badge.svg?token=j5jqlrL7Pd)](https://codecov.io/gh/apitally/apitally-js)
[![npm](https://img.shields.io/npm/v/apitally?logo=npm&color=%23cb0000)](https://www.npmjs.com/package/apitally)

Apitally is a simple API monitoring and analytics tool that makes it easy to understand how your APIs are used
and helps you troubleshoot API issues faster. Setup is easy and takes less than 5 minutes.

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out
the 📚 [documentation](https://docs.apitally.io).

## Key features

### API analytics

Track traffic, error and performance metrics for your API, each endpoint and
individual API consumers, allowing you to make informed, data-driven engineering
and product decisions.

### Request logs

Drill down from insights to individual API requests or use powerful search and filters to
find specific requests. View correlated application logs and traces for a complete picture
of each request, making troubleshooting faster and easier.

### Error tracking

Understand which validation rules in your endpoints cause client errors. Capture
error details and stack traces for 500 error responses, and have them linked to
Sentry issues automatically.

### API monitoring & alerts

Get notified immediately if something isn't right using custom alerts, synthetic
uptime checks and heartbeat monitoring. Alert notifications can be delivered via
email, Slack and Microsoft Teams.

## Supported frameworks

| Framework                                           | Supported versions    | Setup guide                                            |
| --------------------------------------------------- | --------------------- | ------------------------------------------------------ |
| [**Express**](https://github.com/expressjs/express) | `4.x`, `5.x`          | [Link](https://docs.apitally.io/setup-guides/express)  |
| [**Fastify**](https://github.com/fastify/fastify)   | `4.x`, `5.x`          | [Link](https://docs.apitally.io/setup-guides/fastify)  |
| [**NestJS**](https://github.com/nestjs/nest)        | `9.x`, `10.x`, `11.x` | [Link](https://docs.apitally.io/setup-guides/nestjs)   |
| [**AdonisJS**](https://github.com/adonisjs/core)    | `6.x`                 | [Link](https://docs.apitally.io/setup-guides/adonisjs) |
| [**Hono**](https://github.com/honojs/hono) \*       | `4.x`                 | [Link](https://docs.apitally.io/setup-guides/hono)     |
| [**H3**](https://github.com/h3js/h3)                | `2.x`                 | [Link](https://docs.apitally.io/setup-guides/h3)       |
| [**Elysia**](https://github.com/elysiajs/elysia)    | `1.x`                 | [Link](https://docs.apitally.io/setup-guides/elysia)   |
| [**Koa**](https://github.com/koajs/koa)             | `2.x`, `3.x`          | [Link](https://docs.apitally.io/setup-guides/koa)      |
| [**Hapi**](https://github.com/hapijs/hapi)          | `21.x`                | [Link](https://docs.apitally.io/setup-guides/hapi)     |

\* For Hono on Cloudflare Workers use our [Serverless SDK](https://github.com/apitally/apitally-js-serverless) instead.

Apitally also supports many other web frameworks in [Python](https://github.com/apitally/apitally-py), [Go](https://github.com/apitally/apitally-go), [.NET](https://github.com/apitally/apitally-dotnet) and [Java](https://github.com/apitally/apitally-java) via our other SDKs.

## Getting started

If you don't have an Apitally account yet, first [sign up here](https://app.apitally.io/?signup). Then create an app in the Apitally dashboard. You'll see detailed setup instructions with code snippets you can copy and paste. These also include your client ID.

See the [SDK reference](https://docs.apitally.io/sdk-reference/javascript) for all available configuration options, including how to mask sensitive data, customize request logging, and more.

### Express

Install the SDK:

```bash
npm install apitally
```

Then add the Apitally middleware to your application:

```javascript
const express = require("express");
const { useApitally } = require("apitally/express");

const app = express();
app.use(express.json());

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

For further instructions, see our
[setup guide for Express](https://docs.apitally.io/setup-guides/express).

### Fastify

Install the SDK with the `fastify-plugin` peer dependency:

```bash
npm install apitally fastify-plugin
```

Then register the Apitally plugin with your application:

```javascript
import Fastify from "fastify";
import { apitallyPlugin } from "apitally/fastify";

const fastify = Fastify({ logger: true });

await fastify.register(apitallyPlugin, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

_Note:_ If your project uses CommonJS you need to wrap your routes in a plugin, so Apitally can detect them.

For further instructions, see our
[setup guide for Fastify](https://docs.apitally.io/setup-guides/fastify).

### NestJS

Install the SDK:

```bash
npm install apitally
```

Then add the Apitally middleware to your application:

```javascript
import { NestFactory } from "@nestjs/core";
import { useApitally } from "apitally/nestjs";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  await useApitally(app, {
    clientId: "your-client-id",
    env: "dev", // or "prod" etc.
  });

  // ...
}

bootstrap();
```

For further instructions, see our
[setup guide for NestJS](https://docs.apitally.io/setup-guides/nestjs).

### AdonisJS

Install the SDK:

```bash
npm install apitally
```

Then use the following Ace command to configure Apitally in your AdonisJS application:

```bash
node ace configure apitally/adonisjs
```

For further instructions, see our
[setup guide for AdonisJS](https://docs.apitally.io/setup-guides/adonisjs).

### Hono

Install the SDK:

```bash
npm install apitally
```

Then add the Apitally middleware to your application:

```javascript
import { Hono } from "hono";
import { useApitally } from "apitally/hono";

const app = new Hono();

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

For further instructions, see our
[setup guide for Hono](https://docs.apitally.io/setup-guides/hono).

### H3

Install the SDK:

```bash
npm install apitally
```

Then register the Apitally plugin with your application:

```javascript
import { H3 } from "h3";
import { apitallyPlugin } from "apitally/h3";

const app = new H3({
  plugins: [
    apitallyPlugin({
      clientId: "your-client-id",
      env: "dev", // or "prod" etc.
    }),
  ],
});
```

For further instructions, see our
[setup guide for H3](https://docs.apitally.io/setup-guides/h3).

### Elysia

Install the SDK:

```bash
npm install apitally
```

Then add the Apitally plugin to your application:

```javascript
import { Elysia } from "elysia";
import { apitallyPlugin } from "apitally/elysia";

const app = new Elysia()
  .use(
    apitallyPlugin({
      clientId: "your-client-id",
      env: "dev", // or "prod" etc.
    }),
  )
  .get("/", () => "hello");
```

For further instructions, see our
[setup guide for Elysia](https://docs.apitally.io/setup-guides/elysia).

### Koa

Install the SDK:

```bash
npm install apitally
```

Then add the Apitally middleware to your application:

```javascript
const Koa = require("koa");
const { useApitally } = require("apitally/koa");

const app = new Koa();

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

For further instructions, see our
[setup guide for Koa](https://docs.apitally.io/setup-guides/koa).

### Hapi

Install the SDK:

```bash
npm install apitally
```

Then register the Apitally plugin with your application:

```javascript
const Hapi = require("@hapi/hapi");
const { apitallyPlugin } = require("apitally/hapi");

const init = async () => {
  const server = Hapi.server({
    port: 3000,
    host: "localhost",
  });

  await server.register({
    plugin: apitallyPlugin({
      clientId: "your-client-id",
      env: "dev", // or "prod" etc.
    }),
  });
};

init();
```

For further instructions, see our
[setup guide for Hapi](https://docs.apitally.io/setup-guides/hapi).

## Getting help

If you need help please
[create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a)
on GitHub or email us at [support@apitally.io](mailto:support@apitally.io). We'll get back to you as soon as possible.

## License

This library is licensed under the terms of the [MIT license](LICENSE).
