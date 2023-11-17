import { Joi, Segments, celebrate, errors } from "celebrate";
import express from "express";

import { requireApiKey, useApitally } from "../../src/express/middleware";

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
    requireApiKey(["hello1"]),
    celebrate(
      {
        [Segments.QUERY]: {
          name: Joi.string().required().min(2),
          age: Joi.number().required().min(18),
        },
      },
      { abortEarly: false }
    ),
    (req, res) => {
      return res.send(
        `Hello ${req.query?.name}! You are ${req.query?.age} years old!`
      );
    }
  );
  app.get("/hello/:id(\\d+)", requireApiKey("hello2"), (req, res) =>
    res.send(`Hello ID ${req.params.id}!`)
  );

  app.use(errors());
  return app;
};
