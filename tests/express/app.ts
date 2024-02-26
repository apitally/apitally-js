import { Joi, Segments, celebrate, errors } from "celebrate";
import type { Request } from "express";
import express from "express";
import { body, query, validationResult } from "express-validator";

import { useApitally } from "../../src/express/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

declare module "express" {
  interface Request {
    consumerIdentifier?: string;
  }
}

export const getAppWithCelebrate = () => {
  const app = express();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
  });

  app.get(
    "/hello",
    celebrate(
      {
        [Segments.QUERY]: {
          name: Joi.string().required().min(2),
          age: Joi.number().required().min(18),
        },
      },
      { abortEarly: false },
    ),
    (req: Request, res) => {
      req.consumerIdentifier = "test";
      res.send(
        `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
      );
    },
  );
  app.get("/hello/:id(\\d+)", (req, res) => {
    res.send(`Hello ID ${req.params.id}!`);
  });
  app.post(
    "/hello",
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
  app.get("/error", () => {
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
    appVersion: "1.2.3",
  });

  app.get(
    "/hello",
    query("name").isString().isLength({ min: 2 }),
    query("age").isInt({ min: 18 }),
    (req: Request, res) => {
      req.consumerIdentifier = "test";
      const result = validationResult(req);
      if (result.isEmpty()) {
        return res.send(
          `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
        );
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get("/hello/:id(\\d+)", (req, res) => {
    res.send(`Hello ID ${req.params.id}!`);
  });
  app.post(
    "/hello",
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
  app.get("/error", () => {
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
    appVersion: "1.2.3",
  });

  app.get(
    "/hello",
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
  app.get("/hello/:id(\\d+)", (req, res) => {
    res.send(`Hello ID ${req.params.id}!`);
  });
  app.get("/error", () => {
    throw new Error("Error");
  });

  app.use(errors());
  return app;
};
