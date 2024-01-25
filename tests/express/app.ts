import { Joi, Segments, celebrate, errors } from "celebrate";
import express from "express";
import { body, query, validationResult } from "express-validator";

import { KeyCacheBase } from "../../src/common/keyRegistry.js";
import { requireApiKey, useApitally } from "../../src/express/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

class TestKeyCache extends KeyCacheBase {
  private data: string | null = JSON.stringify({ salt: "xxx", keys: {} });

  store(data: string) {
    this.cacheKey; // test getter
    this.data = data;
  }

  retrieve() {
    this.cacheKey; // test getter
    return this.data;
  }
}

export const getAppWithCelebrate = () => {
  const app = express();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    keyCacheClass: TestKeyCache,
  });

  app.get(
    "/hello",
    requireApiKey({ scopes: ["hello1"] }),
    celebrate(
      {
        [Segments.QUERY]: {
          name: Joi.string().required().min(2),
          age: Joi.number().required().min(18),
        },
      },
      { abortEarly: false },
    ),
    (req, res) => {
      res.send(
        `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
      );
    },
  );
  app.get(
    "/hello/:id(\\d+)",
    requireApiKey({ scopes: "hello2" }),
    (req, res) => {
      res.send(`Hello ID ${req.params.id}!`);
    },
  );
  app.post(
    "/hello",
    requireApiKey({ scopes: "hello1" }),
    celebrate(
      {
        [Segments.BODY]: {
          name: Joi.string().required().min(2),
          age: Joi.number().required().min(18),
        },
      },
      { abortEarly: false },
    ),
    (req, res) => {
      res.send(`Hello ${req.body?.name}! You are ${req.body?.age} years old!`);
    },
  );
  app.get("/error", requireApiKey(), () => {
    throw new Error("Error");
  });

  app.use(errors());
  return app;
};

export const getAppWithValidator = () => {
  const app = express();
  app.use(express.json());

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  app.get(
    "/hello",
    requireApiKey({ scopes: "hello1", customHeader: "ApiKey" }),
    query("name").isString().isLength({ min: 2 }),
    query("age").isInt({ min: 18 }),
    (req, res) => {
      const result = validationResult(req);
      if (result.isEmpty()) {
        return res.send(
          `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
        );
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get(
    "/hello/:id(\\d+)",
    requireApiKey({ scopes: "hello2", customHeader: "ApiKey" }),
    (req, res) => {
      res.send(`Hello ID ${req.params.id}!`);
    },
  );
  app.post(
    "/hello",
    requireApiKey({ scopes: "hello1", customHeader: "ApiKey" }),
    body("name").isString().isLength({ min: 2 }),
    body("age").isInt({ min: 18 }),
    (req, res) => {
      const result = validationResult(req);
      if (result.isEmpty()) {
        return res.send(
          `Hello ${req.body?.name}! You are ${req.body?.age} years old!`,
        );
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get("/error", requireApiKey({ customHeader: "ApiKey" }), () => {
    throw new Error("Error");
  });

  app.use(errors());
  return app;
};

export const getNestJsApp = () => {
  const app = express();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
    appVersion: "1.2.3",
  });

  app.get(
    "/hello",
    requireApiKey({ scopes: "hello1", customHeader: "ApiKey" }),
    query("name").isString().isLength({ min: 2 }),
    query("age").isInt({ min: 18 }),
    (req, res) => {
      const result = validationResult(req);
      if (result.isEmpty()) {
        return res.send(
          `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
        );
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get(
    "/hello/:id(\\d+)",
    requireApiKey({ scopes: "hello2", customHeader: "ApiKey" }),
    (req, res) => {
      res.send(`Hello ID ${req.params.id}!`);
    },
  );
  app.get("/error", requireApiKey({ customHeader: "ApiKey" }), () => {
    throw new Error("Error");
  });

  app.use(errors());
  return app;
};
