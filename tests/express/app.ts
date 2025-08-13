import { Joi, Segments, celebrate, errors } from "celebrate";
import type { Request } from "express";
import express from "express";
import { body, query, validationResult } from "express-validator";
import { pinoHttp } from "pino-http";
import winston from "winston";

import { setConsumer, useApitally } from "../../src/express/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

const winstonLogger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.simple(),
  ),
  transports: [new winston.transports.Console()],
});

const requestLoggingConfig = {
  enabled: true,
  logQueryParams: true,
  logRequestHeaders: true,
  logRequestBody: true,
  logResponseHeaders: true,
  logResponseBody: true,
  captureLogs: true,
};

export const getAppWithCelebrate = () => {
  const app = express();
  app.use(express.json());
  app.use(pinoHttp());

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    requestLogging: requestLoggingConfig,
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
      setConsumer(req, "test");
      console.warn("Console test");
      req.log.info("Pino test");
      winstonLogger.info("Winston test");
      res.type("txt");
      res.send(
        `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
      );
    },
  );
  app.get("/hello/:id", (req, res) => {
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
      res.type("txt");
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
  app.use(pinoHttp());

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLogging: requestLoggingConfig,
  });

  app.get(
    "/hello",
    query("name").isString().isLength({ min: 2 }),
    query("age").isInt({ min: 18 }),
    (req: Request, res) => {
      setConsumer(req, "test");
      console.warn("Console test");
      req.log.info("Pino test");
      winstonLogger.info("Winston test");
      const result = validationResult(req);
      if (result.isEmpty()) {
        res.type("txt");
        res.send(
          `Hello ${req.query?.name}! You are ${req.query?.age} years old!`,
        );
        return;
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get("/hello/:id", (req, res) => {
    res.send(`Hello ID ${req.params.id}!`);
  });
  app.post(
    "/hello",
    body("name").isString().isLength({ min: 2 }),
    body("age").isInt({ min: 18 }),
    (req, res) => {
      const result = validationResult(req);
      if (result.isEmpty()) {
        res.type("txt");
        res.send(
          `Hello ${req.body?.name}! You are ${req.body?.age} years old!`,
        );
        return;
      }
      res.status(400).send({ errors: result.array() });
    },
  );
  app.get("/error", () => {
    throw new Error("test");
  });

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
    requestLogging: requestLoggingConfig,
  });

  router.get("/hello", (req, res) => {
    res.send("Hello!");
  });

  app.use("/api", router);
  return app;
};

export const getAppWithNestedRouters = () => {
  const app = express();
  const router1 = express.Router();
  const router2 = express.Router({ mergeParams: true });
  const router3 = express.Router();
  const router4 = express.Router();

  useApitally(app, {
    clientId: CLIENT_ID,
    env: ENV,
    appVersion: "1.2.3",
    requestLogging: requestLoggingConfig,
  });

  router1.get("/health", (req, res) => {
    res.send("OK");
  });

  router2.get("/hello/:name", (req, res) => {
    res.send(`Hello ${req.params.name}!`);
  });

  router3.get("/world", (req, res) => {
    res.send("World!");
  });

  router4.get("/", (req, res) => {
    res.send("Success!");
  });

  router2.use("/goodbye", router3);
  app.use("/", router1);
  app.use("/api/:version", router2);
  app.use("/test", router4);
  return app;
};
