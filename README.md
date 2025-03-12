<p align="center">
  <a href="https://apitally.io" target="_blank">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://assets.apitally.io/logos/logo-vertical-dark.png">
      <source media="(prefers-color-scheme: light)" srcset="https://assets.apitally.io/logos/logo-vertical-light.png">
      <img alt="Apitally logo" src="https://assets.apitally.io/logos/logo-vertical-light.png" width="150">
    </picture>
  </a>
</p>

<p align="center"><b>Simple, privacy-focused API monitoring & analytics</b></p>

<p align="center"><i>Apitally helps you understand how your APIs are being used and alerts you when things go wrong.<br>Just add two lines of code to your project to get started.</i></p>
<br>

![Apitally screenshots](https://assets.apitally.io/screenshots/overview.png)

---

# Apitally SDK for Node.js

[![Tests](https://github.com/apitally/apitally-js/actions/workflows/tests.yaml/badge.svg?event=push)](https://github.com/apitally/apitally-js/actions)
[![Codecov](https://codecov.io/gh/apitally/apitally-js/graph/badge.svg?token=j5jqlrL7Pd)](https://codecov.io/gh/apitally/apitally-js)
[![npm](https://img.shields.io/npm/v/apitally?logo=npm&color=%23cb0000)](https://www.npmjs.com/package/apitally)

This SDK for Apitally currently supports the following Node.js web
frameworks:

- [Express](https://docs.apitally.io/frameworks/express)
- [NestJS](https://docs.apitally.io/frameworks/nestjs) (with Express)
- [Fastify](https://docs.apitally.io/frameworks/fastify)
- [Koa](https://docs.apitally.io/frameworks/koa)
- [Hono](https://docs.apitally.io/frameworks/hono)

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out
the 📚 [documentation](https://docs.apitally.io).

## Key features

### API analytics

Track traffic, error and performance metrics for your API, each endpoint and individual API consumers, allowing you to make informed, data-driven engineering and product decisions.

### Error tracking

Understand which validation rules in your endpoints cause client errors. Capture error details and stack traces for 500 error responses, and have them linked to Sentry issues automatically.

### Request logging

Drill down from insights to individual requests or use powerful filtering to understand how consumers have interacted with your API. Configure exactly what is included in the logs to meet your requirements.

### API monitoring & alerting

Get notified immediately if something isn't right using custom alerts, synthetic uptime checks and heartbeat monitoring. Notifications can be delivered via email, Slack or Microsoft Teams.

## Installation

You can install this library in your project using `npm` or `yarn`:

```bash
npm install apitally
```

or

```bash
yarn add apitally
```

## Usage

Our comprehensive [setup guides](https://docs.apitally.io/quickstart) include
all the details you need to get started.

### Express

This is an example of how to use the Apitally middleware with an Express
application. For further instructions, see our
[setup guide for Express](https://docs.apitally.io/frameworks/express).

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

### NestJS

This is an example of how to use the Apitally middleware with a NestJS
application. For further instructions, see our
[setup guide for NestJS](https://docs.apitally.io/frameworks/nestjs).

_Note_: Currently only NestJS applications that use Express as the underlying
HTTP server are supported (the default).

```javascript
const { NestFactory } = require("@nestjs/core");
const { useApitally } = require("apitally/nestjs");
const { AppModule } = require("./app.module");

const app = await NestFactory.create(AppModule);

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

### Fastify

This is an example of how to register the Apitally plugin with a Fastify
application. For further instructions, see our
[setup guide for Fastify](https://docs.apitally.io/frameworks/fastify).

The Apitally plugin requires the
[`fastify-plugin`](https://www.npmjs.com/package/fastify-plugin) package to be
installed.

```bash
npm install fastify-plugin
```

```javascript
const fastify = require("fastify")({ logger: true });
const { apitallyPlugin } = require("apitally/fastify");

fastify.register(apitallyPlugin, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});

// Wrap your routes in a plugin, so Apitally can detect them
fastify.register((instance, opts, done) => {
  instance.get("/", (request, reply) => {
    reply.send("hello");
  });
  done();
});
```

_Note:_ If your project uses ES modules you can use `await fastify.register(...)` and don't need to wrap your routes in a plugin. See the [Fastify V4 migration guide](https://fastify.dev/docs/latest/Guides/Migration-Guide-V4/#synchronous-route-definitions-2954) for more details.

### Koa

This is an example of how to use the Apitally middleware with a Koa application.
For further instructions, see our
[setup guide for Koa](https://docs.apitally.io/frameworks/koa).

```javascript
const Koa = require("koa");
const { useApitally } = require("apitally/koa");

const app = new Koa();

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

### Hono

This is an example of how to use the Apitally middleware with a Hono application.
For further instructions, see our
[setup guide for Hono](https://docs.apitally.io/frameworks/hono).

```javascript
import { Hono } from "hono";
import { useApitally } from "apitally/hono";

const app = new Hono();

useApitally(app, {
  clientId: "your-client-id",
  env: "dev", // or "prod" etc.
});
```

## Getting help

If you need help please [create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a) on GitHub
or [join our Slack workspace](https://join.slack.com/t/apitally-community/shared_invite/zt-2b3xxqhdu-9RMq2HyZbR79wtzNLoGHrg).

## License

This library is licensed under the terms of the MIT license.
