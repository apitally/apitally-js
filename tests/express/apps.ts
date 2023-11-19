import { Joi, Segments, celebrate, errors } from "celebrate";
import express from "express";
import { query, validationResult } from "express-validator";

import { requireApiKey, useApitally } from "../../src/express";

const CLIENT_ID = "fa4f144d-33be-4694-95e4-f5c18b0f151d";
const ENV = "default";

export const getAppWithCelebrate = () => {
  const app = express();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    syncApiKeys: true,
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
  app.get("/error", requireApiKey(), (req, res) => {
    throw new Error("Error");
  });

  app.use(errors());
  return app;
};

export const getAppWithValidator = () => {
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

  app.use(errors());
  return app;
};
