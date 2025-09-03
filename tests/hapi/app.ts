import { Server } from "@hapi/hapi";
import Joi from "joi";

import { apitallyPlugin, setConsumer } from "../../src/hapi/index.js";
import { CLIENT_ID, ENV } from "../utils.js";

export const getApp = async () => {
  const server = new Server({
    port: 3000,
    host: "localhost",
  });

  await server.register({
    plugin: apitallyPlugin({
      clientId: CLIENT_ID,
      env: ENV,
      appVersion: "1.2.3",
      requestLogging: {
        enabled: true,
        logRequestHeaders: true,
        logRequestBody: true,
        logResponseBody: true,
        captureLogs: true,
      },
    }),
  });

  server.route({
    method: "GET",
    path: "/hello",
    handler: (request) => {
      const { name, age } = request.query;
      setConsumer(request, "test");
      console.warn("Console test");
      return `Hello ${name}! You are ${age} years old!`;
    },
    options: {
      validate: {
        query: Joi.object({
          name: Joi.string().min(2).required(),
          age: Joi.number().min(18).required(),
        }),
      },
    },
  });

  server.route({
    method: "GET",
    path: "/hello/{id}",
    handler: (request) => {
      const { id } = request.params;
      return `Hello ${id}!`;
    },
  });

  server.route({
    method: "POST",
    path: "/hello",
    handler: (request) => {
      const { name, age } = request.payload as any;
      return `Hello ${name}! You are ${age} years old!`;
    },
    options: {
      validate: {
        payload: Joi.object({
          name: Joi.string().min(2).required(),
          age: Joi.number().min(18).required(),
        }),
      },
    },
  });

  server.route({
    method: "GET",
    path: "/error",
    handler: () => {
      throw new Error("test");
    },
  });

  await server.initialize();
  return server;
};
