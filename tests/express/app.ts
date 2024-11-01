import { Joi, Segments, celebrate, errors } from "celebrate";
import type { Request } from "express";
import express from "express";
import { body, query, validationResult } from "express-validator";

import { useApitally } from "../../src/express/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

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
      req.apitallyConsumer = "test";
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
    throw new Error("test");
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
      req.apitallyConsumer = "test";
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
    throw new Error("test");
  });

  app.use(errors());
  return app;
};

export const getAppWithMiddlewareOnRouter = () => {
  const app = express();
  const router = express.Router();

  useApitally(router, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    basePath: "/api",
  });

  router.get("/hello", (req, res) => {
    res.send("Hello!");
  });

  app.use("/api", router);
  app.use(errors());
  return app;
};

export const getAppWithNestedRouters = () => {
  const app = express();
  const router1 = express.Router({ mergeParams: true });
  const router2 = express.Router();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
  });

  router1.get("/hello/:name", (req, res) => {
    res.send(`Hello ${req.params.name}!`);
  });

  router2.get("/world", (req, res) => {
    res.send("World!");
  });

  router1.use("/goodbye", router2);
  app.use("/api/:version", router1);
  app.use(errors());
  return app;
};
