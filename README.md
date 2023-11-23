<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://assets.apitally.io/logos/logo-vertical-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="https://assets.apitally.io/logos/logo-vertical-light.png">
    <img alt="Apitally logo" src="https://assets.apitally.io/logos/logo-vertical-light.png">
  </picture>
</p>

<p align="center"><b>Your refreshingly simple REST API companion.</b></p>

<p align="center"><i>Apitally is a simple and affordable API monitoring and API key management solution with a focus on data privacy. It is easy to set up and use for new and existing API projects using Python or Node.js.</i></p>

<p align="center">🔗 <b><a href="https://apitally.io" target="_blank">apitally.io</a></b></p>

![Apitally screenshots](https://assets.apitally.io/screenshots/overview.png)

---

# Apitally client library for Node.js

[![Tests](https://github.com/apitally/nodejs-client/actions/workflows/tests.yaml/badge.svg?event=push)](https://github.com/apitally/nodejs-client/actions)
[![Codecov](https://codecov.io/gh/apitally/nodejs-client/graph/badge.svg?token=j5jqlrL7Pd)](https://codecov.io/gh/apitally/nodejs-client)
[![npm](https://img.shields.io/npm/v/apitally?logo=npm&color=%23cb0000)](https://www.npmjs.com/package/apitally)

This client library for Apitally currently supports the following Node.js web
frameworks:

- [Express](https://docs.apitally.io/frameworks/express)
- [NestJS](https://docs.apitally.io/frameworks/nestjs) (with Express)
- [Fastify](https://docs.apitally.io/frameworks/fastify)
- [Koa](https://docs.apitally.io/frameworks/koa)

Learn more about Apitally on our 🌎 [website](https://apitally.io) or check out
the 📚 [documentation](https://docs.apitally.io).

## Key features

- Middleware/plugins for different frameworks to capture metadata about API
  endpoints, requests and responses (no sensitive data is captured)
- Non-blocking client that aggregates and sends captured data to Apitally and
  optionally synchronizes API key hashes in 1 minute intervals
- Functions to easily secure endpoints with API key authentication and
  permission checks

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
  env: "default", // or "dev", "prod" etc. (optional)
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
const expressInstance = app.getHttpAdapter().getInstance();

useApitally(expressInstance, {
  clientId: "your-client-id",
  env: "default", // or "dev", "prod" etc. (optional)
});
```

### Fastify

This is an example of how to register the Apitally plugin with a Fastify
application. For further instructions, see our
[setup guide for Fastify](https://docs.apitally.io/frameworks/fastify).

_Note:_ The Apitally plugin requires the
[`fastify-plugin`](https://www.npmjs.com/package/fastify-plugin) package to be
installed.

```bash
npm install fastify-plugin
```

```javascript
const fastify = require("fastify")({ logger: true });
const { apitallyPlugin } = require("apitally/fastify");

await fastify.register(apitallyPlugin, {
  clientId: "your-client-id",
  env: "default", // or "dev", "prod" etc. (optional)
});
```

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
  env: "default", // or "dev", "prod" etc. (optional)
});
```

## Getting help

If you need help please
[create a new discussion](https://github.com/orgs/apitally/discussions/categories/q-a)
on GitHub.

## License

This library is licensed under the terms of the MIT license.
